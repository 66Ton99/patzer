# Proposal: Woodpecker Tactical Training

## Summary
Introduce the **Woodpecker Method** to Patzer: a structured, cyclical tactical training system built on high-repetition spaced intervals. The feature trains subconscious pattern recognition by requiring a player to solve a **frozen, deterministic set of puzzles repeatedly over 6 cycles**, targeting approximately half the completion time in each successive cycle, interspersed with neural consolidation rest intervals.

The system sources positions from Patzer's embedded CC0 Lichess tactics database ([`server/src/chess/tacticsSet.json`](../../../server/src/chess/tacticsSet.json)) and the player's personal game blunder history ([`puzzle_attempts`](../../../server/src/db.ts)).

---

## Motivation & Methodology

### The Woodpecker Concept
The Woodpecker Method was devised by Grandmasters **Axel Smith** and **Hans Tikkanen** and published in their landmark work (*The Woodpecker Method*, Quality Chess, 2018). Tikkanen used this rigorous training routine to achieve three Grandmaster norms in seven weeks.

Traditional tactics training on chess platforms presents an endless stream of novel, randomized puzzles. While this tests calculation, it does not reliably build rapid, reflexive pattern recognition. The Woodpecker Method solves this by borrowing principles of subconscious conditioning and motor memory encoding:
1. **Curate a fixed set** of tactical puzzles (e.g. 100, 222, 300, or 500 positions).
2. **Cycle 1 (Foundational Scan)**: Solve the entire set carefully, noting time and mistakes.
3. **Rest & Neural Consolidation**: Rest for 24 to 48 hours to allow the subconscious to process and consolidate the neural pathways.
4. **Cycle 2 through Cycle 6 (Exponential Acceleration)**: Solve the **exact same puzzles in the exact same order**, aiming to complete the set in approximately half the duration of the preceding cycle.
5. **Final Mastery**: By the 6th cycle, pattern recognition transitions from slow conscious calculation to instant subconscious instinct, with a target accuracy exceeding 95% and a speedup factor of 3x to 6x.

### Content Origin & Licensing Disclaimer
Patzer is an open-source, self-hosted chess platform. To respect copyright:
- **No proprietary book content is reproduced.** The training methodology and progression schedule are inspired by Smith and Tikkanen's framework, but all puzzle positions are sourced exclusively from:
  1. Patzer's embedded 4,070-puzzle collection ([`tacticsSet.json`](../../../server/src/chess/tacticsSet.json)), derived from the public domain **Lichess CC0 tactical database**.
  2. The player's personal game review blunders stored locally in SQLite ([`puzzle_attempts`](../../../server/src/db.ts)).
- Preset sizes (`starter-100`, `easy-222`, `club-300`, `master-500`) are calibrated to real database distribution slices rather than duplicating proprietary book chapters.

---

## Key Architectural Principles

### 1. Deterministic Order Freezing
The hallmark of the Woodpecker Method is repetition of the exact same sequence. When a user creates a training program, the system slices and freezes an immutable array of typed puzzle identifiers (`["lichess:1ISXF", "blunder:42", ...]`) in `woodpecker_programs.puzzle_ids`. No random reshuffling or puzzle insertion occurs between cycles.

### 2. Multi-Cycle Progression Protocol
- **Default Target Cycles**: 6 cycles (configurable by the user between 3 and 7 cycles).
- **Target Duration Halving**:
  - Cycle 1 duration is open-ended, measuring baseline duration (A_1).
  - Cycle 2 target duration halves the Cycle 1 baseline: `T_2 = max(300, ceil(A_1 / 2))`.
  - For Cycle K (K >= 3), target duration continues halving: `T_K = max(300, ceil(T_{K-1} / 2))`, bounded by a practical minimum floor of 300 seconds (5 minutes).
  - Program speedup metric: `S = round(A_1 / A_final, 2)`.

### 3. Server-Authoritative Timing & Integrity
Elapsed time is critical to Woodpecker metrics. To prevent manipulation and uncounted idle time:
- Clocks start on the server when `GET /programs/:id/next` is invoked, logging `puzzle_started_at`.
- On `POST /programs/:id/attempt`, the server measures real elapsed duration (`server_duration_ms = now - puzzle_started_at`) and bounds it as `min(600000, max(500, server_duration_ms))` (10-minute maximum cap per attempt).
- In Practice Mode (`outcome = 'retry_mistake'`), the server resets `puzzle_started_at = datetime('now')` so subsequent tries do not multiply elapsed time. On puzzle completion (`'solved'` or `'failed'`), `puzzle_started_at` is cleared to NULL.
- When paused (`POST /programs/:id/pause`) or when the browser loses focus (`window.onblur`), the client auto-pauses the server clock, saves active time to `woodpecker_cycles.elapsed_ms`, and obscures the board with an accessible opaque overlay.

### 4. Practice Mode & Strict Mode
- **Strict Mode**: The classical book method. A single wrong candidate move registers `first_try_solved = 0, solved = 0, outcome = 'failed'`, reveals the correct solution line, and immediately advances to the next puzzle.
- **Practice Mode**: Educational variant. A wrong move records a mistake (`mistakes_count += 1, first_try_solved = 0, outcome = 'retry_mistake'`), but leaves the position open for the player to discover the winning continuation before moving on (`outcome = 'solved'` once completed).
- **Accuracy Metric**: Cycle accuracy is calculated strictly as `(sum(first_try_solved) / total_puzzles) * 100`, ensuring practice retries do not artificially inflate mastery statistics.

### 5. Multi-User Ownership & Isolation
Patzer supports multiple profiles per instance (including kid mode). Every Woodpecker endpoint strictly enforces ownership:
- `user_id` on the program must match the authenticated profile.
- Unauthenticated requests yield `401 Unauthorized`.
- Accessing or modifying another user's program yields `404 Not Found` (preventing ID enumeration).
- Attempts in Woodpecker programs are stored in `woodpecker_attempts`, completely isolated from regular `tactics_attempts` and Glicko rating calculations.
- Woodpecker solving does not modify `puzzle_attempts.solved` or `puzzle_attempts.due_on`, keeping the daily Game Review blunder queue unaffected.
- Concurrent active program limit: Each profile may have at most 3 active programs simultaneously to encourage focus and completion.

### 6. Local AI Coach Explanations
When stubborn blunders are detected (positions failed across two or more cycles), the user can request pattern explanations from the embedded local LLM (`/api/coach/explain`). The coach analyzes the positional motif (e.g. pinned piece, deflection, weak back rank) to assist neural encoding without leaking unrelated moves. For kid profiles, the coach adapts to kid-friendly explanations.
