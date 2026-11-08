# Design: Woodpecker Tactical Training

## 1. System Architecture Overview

The Woodpecker Method training system is integrated cleanly into Patzer's architecture:

```
┌───────────────────────────────────────────────────────────┐
│                      Web Client (React)                   │
│  - Train.tsx (Woodpecker tab)                             │
│  - WoodpeckerDashboard.tsx (cycle history & timers)       │
│  - WoodpeckerTrainer.tsx (Chessground board, dual clocks) │
│  - Accessible Opaque Pause / Anti-Cheating Overlay        │
└─────────────────────────────┬─────────────────────────────┘
                              │ HTTP / JSON
                              ▼
┌───────────────────────────────────────────────────────────┐
│                   Hono API Routing Layer                  │
│  - routes/woodpecker.ts (CRUD, attempts, pause, resume)   │
│  - auth/middleware.ts (requireAuth, profile ownership)    │
└─────────────────────────────┬─────────────────────────────┘
                              │
          ┌───────────────────┴───────────────────┐
          ▼                                       ▼
┌───────────────────────────┐   ┌───────────────────────────┐
│  Tactics & Slicing Core   │   │     Database (SQLite)     │
│  - chess/woodpecker.ts    │   │  - woodpecker_programs    │
│  - chess/tactics.ts       │   │  - woodpecker_cycles      │
│  - tacticsSet.json (CC0)  │   │  - woodpecker_attempts    │
│  - blunder resolver       │   │  - puzzle_attempts        │
└─────────────┬─────────────┘   └───────────────────────────┘
              │
              ▼
┌───────────────────────────┐
│   Local AI Coach (LLM)    │
│  - coach/explain.ts       │
│  - Stubborn blunder motif │
└───────────────────────────┘
```

---

## 2. Data Model (SQLite)

In accordance with Patzer conventions, configuration presets are stored as **in-code TypeScript constants** rather than a database table, while user-specific programs, cycles, and attempts are stored in SQLite via `server/src/db.ts`.

### Migration Schema (`server/src/db.ts`)

```sql
-- User Woodpecker training programs
CREATE TABLE IF NOT EXISTS woodpecker_programs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source_type TEXT NOT NULL CHECK(source_type IN ('preset', 'theme', 'blunders')),
  source_params TEXT, -- JSON configuration (preset ID, rating range, selected themes)
  puzzle_ids TEXT NOT NULL, -- JSON array of frozen typed puzzle identifiers, e.g. ["lichess:1ISXF", "blunder:42"]
  total_puzzles INTEGER NOT NULL,
  target_cycles INTEGER NOT NULL DEFAULT 6 CHECK(target_cycles BETWEEN 3 AND 7),
  current_cycle INTEGER NOT NULL DEFAULT 1,
  mode TEXT NOT NULL DEFAULT 'strict' CHECK(mode IN ('strict', 'practice')),
  rest_duration_hours INTEGER NOT NULL DEFAULT 24,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'resting', 'completed', 'archived')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_woodpecker_programs_user ON woodpecker_programs(user_id, status);

-- Cycles within a program
CREATE TABLE IF NOT EXISTS woodpecker_cycles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id INTEGER NOT NULL REFERENCES woodpecker_programs(id) ON DELETE CASCADE,
  cycle_number INTEGER NOT NULL,
  target_duration_sec INTEGER, -- computed target duration (null for cycle 1)
  actual_duration_sec INTEGER NOT NULL DEFAULT 0, -- completed active duration in seconds
  elapsed_ms INTEGER NOT NULL DEFAULT 0, -- accumulated active milliseconds across pauses
  paused_at TEXT, -- ISO timestamp if paused, NULL if running
  puzzle_started_at TEXT, -- ISO timestamp recorded when active puzzle was served
  total_puzzles INTEGER NOT NULL,
  solved_puzzles INTEGER NOT NULL DEFAULT 0, -- count of puzzles with first_try_solved = 1
  accuracy_pct REAL NOT NULL DEFAULT 0.0,
  avg_time_per_puzzle_sec REAL NOT NULL DEFAULT 0.0,
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress', 'paused', 'completed')),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  rest_until TEXT, -- ISO timestamp when neural consolidation rest period ends
  UNIQUE(program_id, cycle_number)
);
CREATE INDEX IF NOT EXISTS idx_woodpecker_cycles_program ON woodpecker_cycles(program_id, cycle_number);

-- Puzzle attempts per cycle
CREATE TABLE IF NOT EXISTS woodpecker_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_id INTEGER NOT NULL REFERENCES woodpecker_cycles(id) ON DELETE CASCADE,
  puzzle_id TEXT NOT NULL, -- typed identifier: "lichess:<id>" or "blunder:<id>"
  first_try_solved INTEGER NOT NULL CHECK(first_try_solved IN (0, 1)),
  solved INTEGER NOT NULL CHECK(solved IN (0, 1)),
  mistakes_count INTEGER NOT NULL DEFAULT 0,
  time_spent_ms INTEGER NOT NULL,
  played_moves_uci TEXT, -- JSON array of moves submitted by the user
  blunder_repeated INTEGER NOT NULL DEFAULT 0 CHECK(blunder_repeated IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(cycle_id, puzzle_id)
);
CREATE INDEX IF NOT EXISTS idx_woodpecker_attempts_cycle ON woodpecker_attempts(cycle_id);
CREATE INDEX IF NOT EXISTS idx_woodpecker_attempts_puzzle ON woodpecker_attempts(puzzle_id);
```

---

## 3. Typed Puzzle Reference & Move Contract Resolution

Patzer has two distinct sources of tactical positions:
1. **Lichess embedded tactics** (`server/src/chess/tacticsSet.json`): `fen` is the position *before* the opponent's setup move, and `moves` starts with the opponent's setup move (`moves[0]`), followed by alternating player and opponent replies.
2. **Personal game review blunders** (`puzzle_attempts` in `server/src/db.ts`): `fen` is `move.fen_before` — the position *where it is the user's turn*, and `solution_uci` is the user's winning move.

To prevent move sequence desynchronization where a blunder's winning move would mistakenly be played as an opponent setup move, the payload includes an explicit `has_setup_move` flag.

### Payload Schema (`WoodpeckerPuzzle`)

```typescript
export interface WoodpeckerPuzzlePayload {
  id: string; // e.g. "lichess:EtIHJ" or "blunder:89"
  fen: string;
  moves: string[]; // UCI sequence
  has_setup_move: boolean; // true for Lichess puzzles, false for player blunders
  rating: number | null; // null for blunders (unrated position)
  themes: string[]; // canonical keys from THEME_FILTERS, empty for blunders
}
```

### Resolver Interface (`server/src/chess/woodpecker.ts`)

```typescript
export function resolveWoodpeckerPuzzle(typedId: string, userId: number): WoodpeckerPuzzlePayload | null {
  if (typedId.startsWith('lichess:')) {
    const rawId = typedId.slice(8);
    const puzzle = allPuzzles().find(p => p.id === rawId);
    if (!puzzle) return null;
    return {
      id: typedId,
      fen: puzzle.fen,
      moves: puzzle.moves,
      has_setup_move: true,
      rating: puzzle.rating,
      themes: puzzle.themes,
    };
  }

  if (typedId.startsWith('blunder:')) {
    const attemptId = parseInt(typedId.slice(8), 10);
    const row = db.prepare(`
      SELECT id, fen, solution_uci, user_id FROM puzzle_attempts
      WHERE id = ? AND user_id = ?
    `).get(attemptId, userId) as { id: number; fen: string; solution_uci: string; user_id: number } | undefined;

    if (!row) return null;
    return {
      id: typedId,
      fen: row.fen,
      moves: [row.solution_uci],
      has_setup_move: false, // board is ready for the player's move immediately
      rating: null, // unrated position, prevents skewing rating metrics
      themes: [],
    };
  }

  return null;
}
```

---

## 4. Built-in Presets Definition (TypeScript Constant)

Presets are defined in `server/src/chess/woodpecker.ts` rather than a mutable database table, following the pattern of `THEME_FILTERS` in `chess/tactics.ts` and `CATALOG` in `routes/achievements.ts`:

```typescript
export interface WoodpeckerPreset {
  id: string;
  title: string;
  description: string;
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  puzzleCount: number;
  ratingMin: number;
  ratingMax: number;
  themes: string[]; // canonical keys from THEME_FILTERS
}

export const WOODPECKER_PRESETS: WoodpeckerPreset[] = [
  {
    id: 'starter-100',
    title: 'Woodpecker Foundations',
    description: '100 accessible tactical motifs to develop basic subconscious pattern instincts.',
    difficulty: 'beginner',
    puzzleCount: 100,
    ratingMin: 1000,
    ratingMax: 1400,
    themes: ['mate', 'fork', 'pin', 'hanging'],
  },
  {
    id: 'easy-222',
    title: 'Tactical Agility 222',
    description: '222 elementary tactical problems for rapid scanning and confidence building.',
    difficulty: 'beginner',
    puzzleCount: 222,
    ratingMin: 1000,
    ratingMax: 1400,
    themes: ['mate', 'fork', 'pin', 'hanging'],
  },
  {
    id: 'club-300',
    title: 'Club Competitor 300',
    description: '300 multi-move combinations and sacrifices designed for club players.',
    difficulty: 'intermediate',
    puzzleCount: 300,
    ratingMin: 1401,
    ratingMax: 1800,
    themes: ['discovered', 'sacrifice', 'pin', 'fork', 'endgame'],
  },
  {
    id: 'master-500',
    title: 'Master Challenge 500',
    description: '500 complex tactical operations for deep calculation and master-level intuition.',
    difficulty: 'advanced',
    puzzleCount: 500,
    ratingMin: 1600,
    ratingMax: 2200,
    themes: ['discovered', 'sacrifice', 'pin', 'defence', 'endgame'],
  },
];
```

### Verified Dataset Slicing Validation
The embedded `tacticsSet.json` contains 4,070 puzzles. Verified counts after applying rating and `THEME_FILTERS`:
- **Rating 1000–1400**: 742 total puzzles in range; **539 puzzles** match foundational themes (`mate`, `fork`, `pin`, `hanging`). Presets `starter-100` and `easy-222` fit cleanly.
- **Rating 1401–1800**: 740 total puzzles in range; **585 puzzles** match combination themes (`discovered`, `sacrifice`, `pin`, `fork`, `endgame`). Preset `club-300` fits comfortably.
- **Rating 1600–2200**: **874 puzzles** match advanced themes (`discovered`, `sacrifice`, `pin`, `defence`, `endgame`) out of 1,114 total puzzles in range. Preset `master-500` fits with substantial headroom.

### Blunder Queue Slicing Rules
When creating a program with `source_type = 'blunders'`:
1. Query `puzzle_attempts WHERE user_id = ? AND solved = 0 ORDER BY created_at DESC`.
2. If total blunders are fewer than 20: reject with HTTP 400 `insufficient_blunders` ("At least 20 recorded blunders are required to generate a Woodpecker training set. Play and analyze more games first.").
3. If between 20 and N blunders are available: freeze all available blunders and initialize the program, returning the actual count in the response.
4. **Queue Decoupling**: Woodpecker training does not modify `puzzle_attempts.solved` or `puzzle_attempts.due_on`. Daily Game Review spaced repetition continues independently.

### Thematic Slicing Rules (`source_type = 'theme'`)
When creating a program with `source_type = 'theme'`:
1. Require `theme` to be a valid key from `THEME_FILTERS`. If invalid, reject with HTTP 400 `invalid_theme`.
2. Filter `allPuzzles()` matching the requested theme and optional rating range (default: 1200–1600).
3. If matching puzzles are fewer than 20: reject with HTTP 400 `insufficient_puzzles`.
4. If matching puzzles are fewer than requested `puzzle_count`: take all available matching puzzles.
5. Freeze the resulting typed puzzle IDs into `woodpecker_programs.puzzle_ids`.

---

## 5. Server-Authoritative Timing & Pause Persistence

### Server-Authoritative Timing Protocol
To protect metric integrity against browser manipulation and uncounted idle abandonment:
1. When client requests `GET /programs/:id/next`, the server writes `puzzle_started_at = datetime('now')` to the active `woodpecker_cycles` row.
2. When client submits `POST /programs/:id/attempt`, the server computes:
   `server_duration_ms = now - puzzle_started_at`
   `recorded_time_ms = min(600000, max(500, server_duration_ms))`
   Single-attempt active time is capped at 600,000 ms (10 minutes) to prevent unpaused breaks from skewing baseline duration and halving targets.
3. The server uses `recorded_time_ms` as the authoritative duration for this attempt and accumulates it into `woodpecker_cycles.elapsed_ms`.
4. Client-reported `time_spent_ms` is used only for UI sync sanity check. If `abs(server_duration_ms - client_reported_ms) > 3000ms`, the server logs a clock drift warning, but strictly records `recorded_time_ms` in the database.
5. **Timestamp Re-stamping Semantics**:
   - If `outcome == 'retry_mistake'` (Practice Mode incorrect attempt): the puzzle remains open on the current index. The server immediately sets `puzzle_started_at = datetime('now')` to measure only the subsequent attempt interval, preventing earlier time from being multiplied.
   - If `outcome == 'solved'` or `outcome == 'failed'`: the puzzle is completed. The server sets `puzzle_started_at = NULL`. The next puzzle start time is stamped when the client invokes `GET /programs/:id/next`.
6. The server updates `actual_duration_sec = round(elapsed_ms / 1000)`.

### Pause / Resume Handling
When the user pauses (`POST /programs/:id/pause`):
1. Program status transitions to `'paused'`.
2. Cycle status transitions to `'paused'`.
3. If a puzzle was active (`puzzle_started_at` is not null), the active time up to pause is accumulated into `elapsed_ms`:
   `elapsed_ms = elapsed_ms + min(600000, max(500, now - puzzle_started_at))`
4. `paused_at` is set to `datetime('now')`.
5. `puzzle_started_at` is set to `NULL`.

When the user resumes (`POST /programs/:id/resume`):
1. Program status transitions back to `'active'`.
2. Cycle status transitions back to `'in_progress'`.
3. `paused_at` is set to `NULL`.
4. `puzzle_started_at` is set to `datetime('now')`.

### Anti-Cheating Chessboard Overlay & Accessibility
On the frontend:
- When a pause is active, when the browser tab loses focus (`window.onblur`), or during rest countdowns, an opaque overlay (`backdrop-blur-md bg-stone-900/90`) conceals the board.
- The `window.onblur` event handler immediately calls `POST /programs/:id/pause` to freeze the server clock and accumulate time up to the moment of blur.
- **Accessibility**:
  - The overlay container is marked with `role="dialog"`, `aria-modal="true"`, and `aria-label="Training session paused"`.
  - The chessboard container is marked `aria-hidden="true"` while obscured.
  - Keyboard focus is trapped on the Resume button.
  - Pressing `Escape` or clicking Resume calls `POST /programs/:id/resume` and resumes the stopwatch.

---

## 6. Practice Mode vs. Strict Mode Semantics

The endpoint `POST /programs/:id/attempt` receives an explicit `outcome` field:
- `'solved'`: Puzzle solved correctly.
- `'failed'`: Strict Mode failure (or user gave up).
- `'retry_mistake'`: Practice Mode incorrect move.

### Strict Mode (Classical Woodpecker)
- The player gets one chance per puzzle.
- A single wrong move submits `outcome: "failed"`.
- Server records `first_try_solved = 0`, `solved = 0`, `mistakes_count = 1`.
- Client sounds error buzz, reveals complete solution line, and advances to the next puzzle.

### Practice Mode (Pedagogical Variant)
- When the player makes an incorrect candidate move:
  - Client submits `outcome: "retry_mistake"`.
  - Server updates attempt row: `first_try_solved = 0`, `mistakes_count = mistakes_count + 1`, `solved = 0`.
  - Puzzle remains on the current index; client shakes the board and resets pieces to the starting position.
- When the player eventually plays the correct move sequence:
  - Client submits `outcome: "solved"`.
  - Server updates attempt row with `solved = 1` and cumulative `time_spent_ms`.
- **Accuracy Metric**: Cycle accuracy is calculated strictly using `first_try_solved`:
  `accuracy_pct = (sum(first_try_solved) / total_puzzles) * 100`
  Practice Mode retries never inflate accuracy metrics.

---

## 7. Multi-Cycle Halving Schedule & Rest Periods

### Duration Target Calculation
- **Cycle 1**: Free exploration. No pre-set duration deadline. Baseline duration `A_1` is recorded upon completion.
- **Cycle 2 Target**:
  `T_2 = max(300, ceil(A_1 / 2))`
- **Cycle K Target (K >= 3)**:
  `T_K = max(300, ceil(T_{K-1} / 2))`
- **Minimum Floor**: 300 seconds (5 minutes).
- **Speedup Factor**:
  `S = round(A_1 / A_final, 2)`

### Neural Consolidation Rest Logic
- When Cycle K is completed (K < target_cycles):
  - Cycle K status transitions to `'completed'`.
  - Program status transitions to `'resting'`.
  - The server calculates rest duration in code based on program `rest_duration_hours`:
    - After Cycle 1: `hours = 2 * program.rest_duration_hours` (default: 48 hours).
    - After Cycle K (K >= 2): `hours = 1 * program.rest_duration_hours` (default: 24 hours).
  - The server records `rest_until = datetime('now', '+' || hours || ' hours')` on Cycle K.
- While `now() < rest_until`:
  - Dashboard displays a countdown timer.
  - "Start Next Cycle" is locked behind an explicit confirmation dialog: *"Skip Rest Period"*.
- When rest expires or user invokes `POST /programs/:id/skip-rest`:
  - Cycle K+1 is created with status `'in_progress'`.
  - Program status transitions to `'active'`.

---

## 8. Program Lifecycle, Archiving & Concurrency Limits

1. **Deletion vs Archiving**:
   - `DELETE /programs/:id`: Hard-deletes the program and cascades deletions to its cycles and attempts.
   - `POST /programs/:id/archive`: Soft-archives a completed or active program (`status = 'archived'`). Archived programs are removed from the active training tab but retained for historical records and achievement statistics.
2. **Concurrency Limit**:
   - Each profile may have at most 3 active (non-completed, non-archived) programs simultaneously. Creating a 4th returns HTTP 400 `program_limit_reached`.
3. **Multi-Profile Ownership & Security**:
   - All operations enforce `woodpecker_programs.user_id == currentProfile.id`.
   - Unauthenticated requests return `401 Unauthorized`.
   - Accessing another profile's program returns `404 Not Found`.
4. **Rating Isolation**:
   - Woodpecker attempts are written exclusively to `woodpecker_attempts`.
   - Never written to `tactics_attempts` or passed to `updateGlicko()`.

---

## 9. AI Coach Prompt Contract (`/api/coach/explain`)

When a puzzle has `blunder_repeated = 1` (failed in 2 or more cycles), the user can request an explanation.

### Request Payload
```json
{
  "puzzle_id": "lichess:EtIHJ",
  "fen": "3r3k/p4p2/2pr1qpp/4pB2/4P2P/P5QK/PBPn1PR1/8 b - - 1 39",
  "solution_uci": "b2e5",
  "played_uci": "g3e5",
  "failed_cycles": [1, 2]
}
```

### Prompt Construction Contract
```text
System: You are Patzer's tactical chess coach. The student is training with the Woodpecker Method (repetition-based pattern recognition) and has missed this exact tactical motif in multiple consecutive cycles.
Explain the core motif in 2 concise sentences. Focus on:
1. The geometry or relationship (e.g. pinned piece, overloaded defender, discovered check).
2. The mnemonic visual trigger to recognize it instantly in future games.
Do not provide long move trees or algebraic fluff.
```
For kid profiles, the system prompt instructs the model to use encouraging, kid-friendly vocabulary and simplified tactical metaphors.

---

## 10. Achievements Integration (`server/src/routes/achievements.ts`)

Registered directly into the `CATALOG` array:

```typescript
{
  id: 'woodpecker_finisher',
  title: 'Woodpecker Graduate',
  description: 'Completed all target cycles of a Woodpecker training program.',
  icon: 'Repeat',
  target: 1,
  category: 'tactics',
},
{
  id: 'pattern_machine',
  title: 'Pattern Machine',
  description: 'Achieved 95% or higher accuracy in the final Woodpecker cycle.',
  icon: 'Zap',
  target: 1,
  category: 'tactics',
},
{
  id: 'subconscious_instinct',
  title: 'Subconscious Instinct',
  description: 'Achieved a 3x or greater speedup between the first and final cycle.',
  icon: 'Flame',
  target: 1,
  category: 'tactics',
}
```
Evaluation is computed live during `GET /api/achievements` by querying `woodpecker_programs` and `woodpecker_cycles`.

---

## 11. Internationalization (i18n)

UI strings are placed in `web/src/locales/*.json` using i18next double-brace placeholders (`{{key}}`):
- `woodpecker.title`: "Woodpecker Method"
- `woodpecker.tagline`: "Repetitive tactical pattern training with exponential acceleration"
- `woodpecker.cycleProgress`: "Cycle {{current}} of {{total}}"
- `woodpecker.restTimer`: "Neural Consolidation Rest: {{hours}}h {{mins}}m remaining"
- `woodpecker.skipRest`: "Skip Rest Period"
- `woodpecker.strictMode`: "Strict Mode (One Try)"
- `woodpecker.practiceMode`: "Practice Mode (Find the Solution)"
- `woodpecker.speedup`: "Speedup: {{factor}}x faster"
- `woodpecker.stubbornBlunders_one`: "{{count}} stubborn pattern"
- `woodpecker.stubbornBlunders_other`: "{{count}} stubborn patterns"
- `woodpecker.coachExplain`: "Explain Pattern with Coach"

Note: In accordance with i18next pluralization rules, keys with `{{count}}` must provide language-specific plural forms (e.g. `stubbornBlunders_one`, `stubbornBlunders_few`, `stubbornBlunders_many` for Slavic languages `uk` and `ru`). All translations must maintain key parity verified via `web/src/locales/locales.test.ts`.
