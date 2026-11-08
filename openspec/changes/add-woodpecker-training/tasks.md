# Implementation Tasks: Woodpecker Tactical Training

## 1. Database & Schema Migrations
- [ ] 1.1 Add `woodpecker_programs` table in `server/src/db.ts` with columns for ownership, mode, status, rest duration, and frozen JSON `puzzle_ids`.
- [ ] 1.2 Add `woodpecker_cycles` table in `server/src/db.ts` with fields for `elapsed_ms`, `paused_at`, `puzzle_started_at`, and `rest_until`.
- [ ] 1.3 Add `woodpecker_attempts` table in `server/src/db.ts` with unique constraint on `(cycle_id, puzzle_id)` and dual tracking of `first_try_solved` and `solved`.
- [ ] 1.4 Add indexes on `(user_id, status)` for programs, `(program_id, cycle_number)` for cycles, and `(cycle_id)` for attempts.

## 2. Presets & Puzzle Slicing Engine
- [ ] 2.1 Define `WOODPECKER_PRESETS` in-code TypeScript array in `server/src/chess/woodpecker.ts` with `starter-100`, `easy-222`, `club-300`, and `master-500`.
- [ ] 2.2 Implement deterministic slicing from `allPuzzles()` in `server/src/chess/tactics.ts` using rating bounds and `THEME_FILTERS` keys.
- [ ] 2.3 Implement thematic slicing for `source_type = 'theme'` with theme key validation and rating bounds.
- [ ] 2.4 Implement blunder extraction query from `puzzle_attempts` for `user_id` where `solved = 0`.
- [ ] 2.5 Implement blunder validation logic: reject with HTTP 400 `insufficient_blunders` if fewer than 20 blunders are available; clamp to total available if between 20 and N.
- [ ] 2.6 Implement typed identifier schema (`lichess:<id>` and `blunder:<id>`) with `has_setup_move` flag in `resolveWoodpeckerPuzzle()`.
- [ ] 2.7 Verify blunder solving decoupling: ensure Woodpecker attempts never alter `puzzle_attempts.solved` or `puzzle_attempts.due_on`.

## 3. Server-Authoritative Timing & Cycle Transition
- [ ] 3.1 Implement clock start timestamp logging (`puzzle_started_at`) upon serving puzzle in `GET /programs/:id/next`.
- [ ] 3.2 Implement server-authoritative duration calculation in `POST /programs/:id/attempt` (`server_duration_ms = now - puzzle_started_at`), capped at `min(600000, max(500, server_duration_ms))`, with `puzzle_started_at` re-stamped on `retry_mistake` and cleared to `NULL` on completion.
- [ ] 3.3 Implement Practice Mode outcome handling in `POST /programs/:id/attempt` supporting `outcome: 'solved' | 'failed' | 'retry_mistake'`.
- [ ] 3.4 Implement session pause handler (`POST /programs/:id/pause`): accumulate active time into `elapsed_ms`, set `paused_at`, nullify `puzzle_started_at`, and mark status `paused`.
- [ ] 3.5 Implement session resume handler (`POST /programs/:id/resume`): clear `paused_at`, stamp new `puzzle_started_at`, and mark status `active`.
- [ ] 3.6 Implement cycle completion calculator: compute target duration (`T_2 = max(300, ceil(A_1 / 2))`, `T_K = max(300, ceil(T_{K-1} / 2))`), calculate rest period (2x `rest_duration_hours` after Cycle 1, 1x after subsequent cycles), and set `rest_until`.
- [ ] 3.7 Implement rest bypass handler (`POST /programs/:id/skip-rest`): immediately transition program to `active` and launch next cycle.

## 4. REST API Routes & Profile Ownership
- [ ] 4.1 Create `server/src/routes/woodpecker.ts` with Hono router wrapped in `requireAuth`.
- [ ] 4.2 Implement `GET /presets` to serve `WOODPECKER_PRESETS`.
- [ ] 4.3 Implement `GET /programs` returning user's active, resting, and completed programs.
- [ ] 4.4 Implement `POST /programs` creating and freezing a new training program, enforcing maximum 3 active programs limit.
- [ ] 4.5 Implement `GET /programs/:id` returning program details, cycle history, and rest timer.
- [ ] 4.6 Implement `DELETE /programs/:id` for hard deletion and `POST /programs/:id/archive` for soft archiving.
- [ ] 4.7 Enforce profile ownership on all `/programs/:id/*` endpoints: return HTTP 404 if program belongs to another profile or does not exist.
- [ ] 4.8 Register router in `server/src/index.ts` under `/api/woodpecker`.

## 5. Achievements & Statistics Integration
- [ ] 5.1 Register Woodpecker achievements in `CATALOG` (`server/src/routes/achievements.ts`): `woodpecker_finisher`, `pattern_machine`, `subconscious_instinct`.
- [ ] 5.2 Implement live achievement query in `computeStats()` for Woodpecker milestones.
- [ ] 5.3 Implement `GET /programs/:id/summary` endpoint returning speedup factor (S), accuracy trajectory curve, and stubborn blunder list.

## 6. AI Coach Integration
- [ ] 6.1 Identify multi-cycle blunders (`blunder_repeated = 1`) on cycle completion.
- [ ] 6.2 Implement coach explanation prompt in `server/src/coach/explain.ts` for Woodpecker stubborn patterns focusing on visual motif recognition, with kid-friendly voice when profile is in kid mode.
- [ ] 6.3 Expose pattern explanation trigger in cycle review modal.

## 7. Frontend User Interface & Accessibility
- [ ] 7.1 Add Woodpecker tab to `web/src/pages/Train.tsx`.
- [ ] 7.2 Implement `WoodpeckerDashboard.tsx` with active program cards, rest countdown widget, and preset/theme picker modal.
- [ ] 7.3 Implement `WoodpeckerTrainer.tsx` integrating Chessground board, dual clocks, and move verification with `has_setup_move` handling.
- [ ] 7.4 Implement accessible anti-cheating overlay with `role="dialog"`, `aria-modal="true"`, focus trapping, and `aria-hidden` on chessboard during pause and tab blur auto-pause.
- [ ] 7.5 Implement Strict Mode feedback (buzzer, line reveal, advance) and Practice Mode feedback (shake board, mistake counter, retry).
- [ ] 7.6 Implement Cycle Summary modal with accuracy diff, speedup factor, and AI Coach explanation button.

## 8. Internationalization (i18n)
- [ ] 8.1 Add English (`en.json`) locale keys under `woodpecker.*` with double-brace placeholders (`{{current}}`, `{{total}}`, etc.) and pluralized keys (`stubbornBlunders_one`, `stubbornBlunders_other`).
- [ ] 8.2 Add German (`de.json`) translations for Woodpecker keys.
- [ ] 8.3 Add Spanish (`es.json`) translations for Woodpecker keys.
- [ ] 8.4 Add Ukrainian (`uk.json`) translations for Woodpecker keys with plural forms (`_one`, `_few`, `_many`).
- [ ] 8.5 Add Russian (`ru.json`) translations for Woodpecker keys with plural forms (`_one`, `_few`, `_many`).
- [ ] 8.6 Add Bulgarian (`bg.json`) translations for Woodpecker keys.
- [ ] 8.7 Verify key parity across all 6 locales via `web/src/locales/locales.test.ts`.

## 9. Tooling, CI & Documentation
- [x] 9.1 Add `@fission-ai/openspec` to `package.json` devDependencies and script `npm run openspec:validate`.
- [x] 9.2 Add OpenSpec validation step to `.github/workflows/ci.yml`.
- [x] 9.3 Add OpenSpec contribution guidelines to `CONTRIBUTING.md`.

## 10. Automated Testing
- [ ] 10.1 Unit tests for cycle duration halving and minimum floor in `server/test/woodpecker.test.ts`.
- [ ] 10.2 Unit tests for deterministic order preservation across all 6 cycles.
- [ ] 10.3 Unit tests for typed puzzle ID resolution (`lichess:` and `blunder:`) and `has_setup_move` flag.
- [ ] 10.4 Unit tests for profile ownership isolation (prevent cross-profile access).
- [ ] 10.5 Unit tests for server-authoritative clock, pause accumulation, and timing sanity checks.
- [ ] 10.6 Unit tests for Practice Mode vs Strict Mode accuracy calculations and blunder queue decoupling.
