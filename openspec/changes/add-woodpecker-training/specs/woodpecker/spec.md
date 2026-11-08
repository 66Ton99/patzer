## Purpose
Define the functional and architectural requirements for the Woodpecker Method tactical training capability in Patzer, establishing cyclical spaced-repetition drilling with exponential time halving, server-authoritative timing, move contract normalization, blunder extraction, and neural consolidation rest intervals.

---

## ADDED Requirements

### Requirement: Position Slicing from Embedded Tactics Database
The system SHALL extract and curate training sets directly from Patzer's embedded 4,070-puzzle database ([`tacticsSet.json`](../../../../../server/src/chess/tacticsSet.json)), slicing them into standard difficulty blocks using rating ranges and canonical theme keys defined in `THEME_FILTERS` ([`server/src/chess/tactics.ts`](../../../../../server/src/chess/tactics.ts)).

#### Scenario: Slicing the Foundations block
- **GIVEN** the embedded tactics database containing 742 puzzles in the 1000–1400 Elo range and 539 puzzles matching foundational themes (`mate`, `fork`, `pin`, `hanging`)
- **WHEN** initializing the "Woodpecker Foundations" preset (`starter-100` or `easy-222`)
- **THEN** the system SHALL select puzzles filtered by rating (1000–1400 Elo) and foundational themes
- **AND** compile them into an ordered list of typed puzzle IDs prefixed with `"lichess:"`.

#### Scenario: Slicing the Intermediate & Advanced blocks
- **GIVEN** an intermediate player selecting the "Club Competitor 300" preset
- **WHEN** the program is instantiated
- **THEN** the system SHALL filter puzzles within the 1401–1800 Elo rating window
- **AND** prioritize combination themes (`discovered`, `sacrifice`, `pin`, `fork`, `endgame`) from `THEME_FILTERS`
- **AND** select 300 unique puzzles from the 585 available qualifying positions.

#### Scenario: Slicing the Master Challenge block
- **GIVEN** an advanced player selecting the "Master Challenge 500" preset
- **WHEN** the program is instantiated
- **THEN** the system SHALL select 500 unique puzzles from the 874 qualifying positions matching themes (`discovered`, `sacrifice`, `pin`, `defence`, `endgame`) within the 1600–2200 Elo range (out of 1,114 total puzzles in that rating range).

---

### Requirement: Thematic Slicing & Parameter Validation
The system SHALL support creating a training program from a single tactical theme with configurable rating bounds.

#### Scenario: Slicing by tactical theme
- **GIVEN** an authenticated user selecting source type `theme` with theme key `'fork'`, target count 50, and rating range 1200–1600
- **WHEN** the user creates the program
- **THEN** the system SHALL validate that `'fork'` exists in `THEME_FILTERS`
- **AND** filter `tacticsSet.json` for puzzles matching that theme within 1200–1600 Elo
- **AND** freeze up to 50 matching puzzle IDs into the program sequence.

#### Scenario: Invalid theme key rejection
- **GIVEN** a request to create a theme-based program with an invalid theme key (e.g. `'deflection'`)
- **WHEN** the request is processed by the server
- **THEN** the server SHALL reject the request with HTTP 400 (`invalid_theme`).

#### Scenario: Insufficient thematic puzzles rejection
- **GIVEN** a valid theme and rating range combination that yields fewer than 20 puzzles in `tacticsSet.json`
- **WHEN** the user attempts to create the program
- **THEN** the server SHALL reject the request with HTTP 400 (`insufficient_puzzles`).

---

### Requirement: Blunder Extraction & Move Contract Resolution
The system SHALL support generating a personalized Woodpecker drill set directly from the player's own mistakes recorded during previous game reviews in `puzzle_attempts`, normalizing the move contract with an explicit `has_setup_move` flag.

#### Scenario: Generating a set from player blunders
- **GIVEN** an authenticated user who has at least 20 recorded missed tactics in `puzzle_attempts` where `solved = 0`
- **WHEN** the user creates a new Woodpecker program with source type `blunders` and target count N (e.g. 100)
- **THEN** the system SHALL query the latest unsolved positions from `puzzle_attempts`
- **AND** format each identifier as `"blunder:<id>"` where `<id>` corresponds to `puzzle_attempts.id`
- **AND** freeze those exact positions into the program sequence.

#### Scenario: Serving blunder puzzle with move contract normalization
- **GIVEN** an active blunder puzzle identifier `"blunder:42"`
- **WHEN** the client requests the next puzzle via `GET /api/woodpecker/programs/:id/next`
- **THEN** the server SHALL return `has_setup_move = false`
- **AND** provide `fen` set to `move.fen_before` where it is the player's turn to move
- **AND** provide `moves` containing the player's winning move as `moves[0]`.

#### Scenario: Insufficient blunders rejection
- **GIVEN** an authenticated user with fewer than 20 recorded blunders in `puzzle_attempts`
- **WHEN** the user attempts to generate a blunder-based Woodpecker program
- **THEN** the system SHALL reject the request with HTTP 400 (`insufficient_blunders`)
- **AND** return a message advising the player to analyze more games or select a curated preset.

#### Scenario: Fewer blunders available than requested
- **GIVEN** an authenticated user with 35 recorded blunders in `puzzle_attempts`
- **WHEN** the user requests a blunder program with target count 100
- **THEN** the system SHALL initialize the program with all 35 available blunders
- **AND** set `total_puzzles = 35`.

---

### Requirement: Decoupling from Daily Blunder Review Queue
Woodpecker practice attempts SHALL be completely decoupled from the player's standard game review blunder queue in `puzzle_attempts`.

#### Scenario: Preserving blunder review state
- **GIVEN** a blunder position referenced by `"blunder:42"` with `solved = 0` and `due_on` set in `puzzle_attempts`
- **WHEN** the player successfully solves `"blunder:42"` across one or more Woodpecker cycles
- **THEN** the system SHALL NOT modify `puzzle_attempts.solved`
- **AND** SHALL NOT modify `puzzle_attempts.due_on` or remove the blunder from the daily Tactic Trainer queue.

---

### Requirement: Deterministic Puzzle Sequence Freezing
The system MUST freeze the exact sequence of puzzle IDs at program creation into `woodpecker_programs.puzzle_ids` to guarantee that the player trains the identical set in identical order across all cycles.

#### Scenario: Preserving identical puzzle order across all cycles
- **GIVEN** an active Woodpecker program with frozen sequence `["lichess:1ISXF", "lichess:EtIHJ", ..., "blunder:42"]`
- **WHEN** the user advances from Cycle 1 to Cycle 2 or any subsequent cycle
- **THEN** the puzzle sequence for the new cycle SHALL be identical to Cycle 1 in order and composition
- **AND** no external or newly imported puzzles SHALL be injected into the active program.

---

### Requirement: Multi-Cycle Halving Progression Protocol
The system SHALL enforce a multi-cycle progression model where each subsequent cycle targets approximately half the duration of the preceding cycle, with a standard default of 6 cycles.

#### Scenario: Calculating target duration for subsequent cycle
- **GIVEN** an active program in Cycle 1 that the user completes in actual duration A1 = 7,200 seconds (2 hours)
- **WHEN** the final puzzle of Cycle 1 is submitted
- **THEN** the system SHALL mark Cycle 1 as `completed`
- **AND** calculate the target duration for Cycle 2 as `T_2 = max(300, ceil(A_1 / 2)) = 3,600` seconds (1 hour)
- **AND** for any subsequent Cycle K (K >= 3), calculate `T_K = max(300, ceil(T_{K-1} / 2))`.

#### Scenario: Completing the final program cycle
- **GIVEN** an active program in its final target cycle (e.g., Cycle 6)
- **WHEN** the user solves the final puzzle
- **THEN** the system SHALL mark the cycle and program as `completed`
- **AND** compute the overall speedup factor `S = round(A_1 / A_final, 2)`
- **AND** award the `woodpecker_finisher` achievement
- **AND** award the `pattern_machine` achievement if the final cycle accuracy is at least 95%.

---

### Requirement: Server-Authoritative Timing & Pause Persistence
The system SHALL maintain server-authoritative timestamps to prevent client-side time falsification, and MUST persist accumulated elapsed time and pause state across server restarts.

#### Scenario: Server-authoritative clock start
- **GIVEN** an active cycle
- **WHEN** the client invokes `GET /api/woodpecker/programs/:id/next`
- **THEN** the server SHALL record `puzzle_started_at = datetime('now')` on the active cycle row
- **AND** deliver the puzzle payload to the client.

#### Scenario: Server-authoritative attempt duration calculation
- **GIVEN** a puzzle served with server timestamp `puzzle_started_at`
- **WHEN** the client posts a solution attempt at server time `now`
- **THEN** the server SHALL compute `server_duration_ms = now - puzzle_started_at`
- **AND** record active duration as `min(600000, max(500, server_duration_ms))` (capped at 10 minutes)
- **AND** accumulate that duration into `woodpecker_cycles.elapsed_ms` regardless of any client-reported duration
- **AND** if `outcome == 'retry_mistake'`, reset `puzzle_started_at = datetime('now')` to measure the next retry independently
- **AND** if `outcome` is `'solved'` or `'failed'`, clear `puzzle_started_at` to `NULL`.

#### Scenario: Pausing and resuming a training session
- **GIVEN** an active solving session with a puzzle currently open
- **WHEN** the user invokes `POST /api/woodpecker/programs/:id/pause`
- **THEN** the server SHALL calculate active time spent so far (`now - puzzle_started_at`) and add it to `elapsed_ms`
- **AND** set `paused_at = datetime('now')` and `puzzle_started_at = NULL`
- **AND** set program status to `'paused'` and cycle status to `'paused'`.
- **WHEN** the user subsequently invokes `POST /api/woodpecker/programs/:id/resume`
- **THEN** the server SHALL set `paused_at = NULL` and `puzzle_started_at = datetime('now')`
- **AND** set program status to `'active'` and cycle status to `'in_progress'`.

---

### Requirement: Strict Mode and Practice Mode Semantics
The system SHALL support both Strict Mode and Practice Mode while preserving a single attempt record per `(cycle_id, puzzle_id)` in `woodpecker_attempts`.

#### Scenario: Strict Mode failure
- **GIVEN** an active puzzle in Strict Mode
- **WHEN** the user plays an incorrect candidate move and client submits `outcome = 'failed'`
- **THEN** the system SHALL record `first_try_solved = 0`, `solved = 0`, and `mistakes_count = 1`
- **AND** play the error buzz sound
- **AND** reveal the complete solution line
- **AND** prohibit further move attempts on this puzzle for the current cycle.

#### Scenario: Practice Mode mistake and eventual correction
- **GIVEN** an active puzzle in Practice Mode
- **WHEN** the user plays an incorrect candidate move and client submits `outcome = 'retry_mistake'`
- **THEN** the system SHALL record a mistake (`mistakes_count += 1`, `first_try_solved = 0`, `solved = 0`)
- **AND** keep the puzzle active on the current index while shaking the board.
- **WHEN** the user subsequently finds and plays the correct move line and client submits `outcome = 'solved'`
- **THEN** the system SHALL update the existing row to `solved = 1` with total accumulated `time_spent_ms`
- **AND** calculate cycle accuracy as `(sum(first_try_solved) / total_puzzles) * 100`.

---

### Requirement: Anti-Cheating Chessboard Overlay & Accessibility
The client interface MUST obscure the chessboard with an accessible opaque overlay whenever solving is interrupted, preventing out-of-band tactical calculation.

#### Scenario: Obscuring board upon session pause or tab blur
- **GIVEN** a user engaged in an active solving session
- **WHEN** the session is paused or the browser window loses focus (`window.onblur`)
- **THEN** the web client SHALL invoke `POST /api/woodpecker/programs/:id/pause` to freeze the server clock
- **AND** display a full opaque backdrop with `role="dialog"`, `aria-modal="true"`, and `aria-label="Training session paused"`
- **AND** set `aria-hidden="true"` on the chessboard container
- **AND** trap keyboard focus within the dialog with the Resume button focused
- **AND** hide all chess pieces and square labels until the session is explicitly resumed.

---

### Requirement: Neural Consolidation Rest Periods & Bypass
The system SHALL enforce a neural consolidation rest period between cycles to facilitate memory encoding, while providing an explicit bypass mechanism.

#### Scenario: Entering the rest period
- **GIVEN** a user completing Cycle K of a program with baseline `rest_duration_hours` (default 24)
- **WHEN** the final puzzle attempt is recorded
- **THEN** the system SHALL mark Cycle K as `completed`
- **AND** calculate rest hours as `2 * rest_duration_hours` (48 hours) if K == 1, or `1 * rest_duration_hours` (24 hours) if K >= 2
- **AND** record `rest_until = datetime('now', '+' || hours || ' hours')` on Cycle K
- **AND** set program status to `'resting'`.

#### Scenario: Bypassing the rest period
- **GIVEN** a program in `'resting'` status with unexpired rest time
- **WHEN** the user clicks "Skip Rest Period" and confirms
- **THEN** the client SHALL invoke `POST /api/woodpecker/programs/:id/skip-rest`
- **AND** the server SHALL immediately advance the program to `'active'` and initialize Cycle K+1 as `'in_progress'`.

---

### Requirement: Program Lifecycle, Archiving & Concurrency Limits
The system SHALL manage program lifecycle transitions, support soft-archiving, and enforce profile concurrency limits.

#### Scenario: Archiving a program
- **GIVEN** an active or completed program belonging to the authenticated profile
- **WHEN** the user invokes `POST /api/woodpecker/programs/:id/archive`
- **THEN** the server SHALL update `woodpecker_programs.status = 'archived'`
- **AND** hide the program from the active training tab while retaining all cycle data for historical analytics.

#### Scenario: Hard deleting a program
- **GIVEN** a program belonging to the authenticated profile
- **WHEN** the user invokes `DELETE /api/woodpecker/programs/:id`
- **THEN** the server SHALL delete the program and cascade deletion to all associated cycles and attempts.

#### Scenario: Enforcing active program limit
- **GIVEN** a user profile that already has 3 active (non-completed, non-archived) Woodpecker programs
- **WHEN** the user attempts to create a 4th program via `POST /api/woodpecker/programs`
- **THEN** the server SHALL reject the request with HTTP 400 (`program_limit_reached`).

---

### Requirement: Multi-Profile Security & Ownership Isolation
The system SHALL strictly isolate Woodpecker programs between profiles, preventing cross-profile visibility and tampering.

#### Scenario: Accessing program of another profile
- **GIVEN** a program created by user profile A (`user_id = 1`)
- **WHEN** authenticated user profile B (`user_id = 2`) requests `GET /api/woodpecker/programs/:id`
- **THEN** the server SHALL return HTTP 404 (`Not Found`)
- **AND** reveal no information about whether the program exists.

#### Scenario: Unauthenticated request rejection
- **GIVEN** a request to any `/api/woodpecker/*` endpoint without a valid session cookie
- **WHEN** the request is received by the server
- **THEN** the server SHALL reject the request with HTTP 401 (`Unauthorized`).

---

### Requirement: Independent Rating Isolation
Woodpecker practice attempts SHALL be strictly isolated from competitive Glicko ratings and the standard tactics queue.

#### Scenario: Isolating attempts from Glicko calculations
- **GIVEN** a user solving Woodpecker puzzles repeatedly across multiple cycles
- **WHEN** attempts are recorded in `woodpecker_attempts`
- **THEN** the system SHALL NOT write rows to `tactics_attempts`
- **AND** SHALL NOT invoke `updateGlicko()` or modify the profile's tactical rating.

---

### Requirement: AI Coach Pattern Explanation for Stubborn Blunders
The system SHALL identify stubborn tactical blunders and offer concise pattern recognition explanations via the local AI Coach, adapting tone for kid profiles.

#### Scenario: Requesting coach explanation for recurring failure
- **GIVEN** a puzzle failed across 2 or more cycles (`blunder_repeated = 1`)
- **WHEN** the user clicks "Explain Pattern with Coach" in the Cycle Summary modal
- **THEN** the client SHALL query `POST /api/coach/explain` with the position and failed cycle history
- **AND** the AI Coach SHALL return a 2-sentence explanation of the tactical motif and visual recognition trigger.

#### Scenario: Kid mode coach adaptation
- **GIVEN** an active profile configured in kid mode
- **WHEN** an AI Coach explanation is generated
- **THEN** the prompt SHALL enforce encouraging, kid-friendly vocabulary and simplified tactical metaphors.

---

### Requirement: Woodpecker Achievements in Central Catalog
Woodpecker milestones SHALL be registered in Patzer's central achievements catalog and evaluated live from the database.

#### Scenario: Unlocking Woodpecker achievements
- **GIVEN** an authenticated user who has completed all target cycles of a program with 96% final cycle accuracy and a 3.4x speedup
- **WHEN** the user visits the Achievements page (`GET /api/achievements`)
- **THEN** the response SHALL mark `woodpecker_finisher`, `pattern_machine`, and `subconscious_instinct` as unlocked.

---

### Requirement: Full UI Internationalization & Key Parity
All Woodpecker user interface elements MUST be fully localized across all supported languages in `web/src/locales/` using double-bracket interpolation placeholders (`{{key}}`).

#### Scenario: Displaying localized Woodpecker interface
- **GIVEN** a user with browser language set to German (`de`), Spanish (`es`), Ukrainian (`uk`), Russian (`ru`), or Bulgarian (`bg`)
- **WHEN** navigating to the Woodpecker training tab
- **THEN** all titles, buttons, timer displays, mode badges, and notifications SHALL be displayed in the selected language.

#### Scenario: Verifying locale key parity
- **GIVEN** the locale files in `web/src/locales/`
- **WHEN** running `npm test` with `web/src/locales/locales.test.ts`
- **THEN** all Woodpecker localization keys SHALL be present across all 6 language dictionaries without missing keys.
