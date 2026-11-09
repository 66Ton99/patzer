import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point DB_PATH at a temporary SQLite file before importing db or woodpecker modules.
const dir = mkdtempSync(join(tmpdir(), 'patzer-woodpecker-'));
process.env.DB_PATH = join(dir, 'woodpecker.db');

type WoodpeckerModule = typeof import('../src/chess/woodpecker.js');
type TacticsModule = typeof import('../src/chess/tactics.js');
let wp: WoodpeckerModule;
let tactics: TacticsModule;
let db: typeof import('../src/db.js')['db'];

beforeAll(async () => {
  ({ db } = await import('../src/db.js'));
  wp = await import('../src/chess/woodpecker.js');
  tactics = await import('../src/chess/tactics.js');
  db.prepare(`
    INSERT INTO users (id, username, password_hash, role)
    VALUES (1, 'alice', 'x', 'user'), (2, 'bob', 'x', 'user')
  `).run();
  db.prepare(`
    INSERT INTO games (id, user_id, source, pgn)
    VALUES (1, 1, 'played', '1. e4 e5 *')
  `).run();
});

beforeEach(() => {
  db.prepare(`DELETE FROM woodpecker_programs`).run();
  db.prepare(`DELETE FROM puzzle_attempts`).run();
  db.prepare(`DELETE FROM tactics_attempts`).run();
});

afterAll(() => {
  try { db.close(); } catch { /* ignore */ }
  rmSync(dir, { recursive: true, force: true });
});

describe('Woodpecker presets and slicing', () => {
  it('defines all four official presets and slices the exact puzzle count with lichess: typed IDs', () => {
    expect(wp.WOODPECKER_PRESETS.map((p) => p.id)).toEqual([
      'starter-100',
      'easy-222',
      'club-300',
      'master-500',
    ]);

    for (const preset of wp.WOODPECKER_PRESETS) {
      db.prepare(`DELETE FROM woodpecker_programs`).run();
      const res = wp.createProgram(1, {
        title: preset.title,
        source_type: 'preset',
        preset_id: preset.id,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) continue;
      expect(res.program.total_puzzles).toBe(preset.puzzle_count);
      expect(res.program.current_cycle).toBe(1);
      expect(res.program.status).toBe('active');
      expect(res.program.cycles[0]?.target_duration_sec).toBeNull();

      // Verify typed puzzle IDs and resolution
      const next = wp.getNextPuzzle(1, res.program.id);
      expect(next.ok).toBe(true);
      if (next.ok && next.puzzle) {
        expect(next.puzzle.id.startsWith('lichess:')).toBe(true);
        expect(next.puzzle.has_setup_move).toBe(true);
        expect(next.puzzle.rating).toBeGreaterThanOrEqual(preset.rating_min);
        expect(next.puzzle.rating).toBeLessThanOrEqual(preset.rating_max);
      }
    }
  });

  it('supports thematic slicing (source_type = theme) and validates theme keys and minimum pool size', () => {
    const badTheme = wp.createProgram(1, {
      title: 'Bad Theme',
      source_type: 'theme',
      theme: 'non_existent_theme',
      puzzle_count: 50,
    });
    expect(badTheme).toEqual({
      ok: false,
      code: 'invalid_theme',
      error: expect.any(String),
    });

    const tooNarrow = wp.createProgram(1, {
      title: 'Too Narrow',
      source_type: 'theme',
      theme: 'fork',
      rating_min: 2900,
      rating_max: 3000,
      puzzle_count: 50,
    });
    expect(tooNarrow).toEqual({
      ok: false,
      code: 'insufficient_puzzles',
      error: expect.any(String),
    });

    const validTheme = wp.createProgram(1, {
      title: 'Fork Mastery',
      source_type: 'theme',
      theme: 'fork',
      rating_min: 1000,
      rating_max: 1800,
      puzzle_count: 40,
    });
    expect(validTheme.ok).toBe(true);
    if (validTheme.ok) {
      expect(validTheme.program.total_puzzles).toBe(40);
      expect(validTheme.program.source_type).toBe('theme');
    }
  });

  it('supports personal blunders (source_type = blunders), rejects < 20 blunders, and clamps when 20 <= count < requested', () => {
    // Seed 15 blunders -> should reject with insufficient_blunders
    const insertBlunder = db.prepare(`
      INSERT INTO puzzle_attempts (user_id, game_id, ply, fen, solution_uci, solved)
      VALUES (?, 1, ?, 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', 'e7e5', 0)
    `);
    for (let i = 1; i <= 15; i++) insertBlunder.run(1, i);

    const tooFew = wp.createProgram(1, {
      title: 'My Blunders',
      source_type: 'blunders',
      puzzle_count: 50,
    });
    expect(tooFew).toEqual({
      ok: false,
      code: 'insufficient_blunders',
      error: expect.any(String),
    });

    // Seed 10 more blunders (total 25) and request 50 -> clamps total_puzzles to 25
    for (let i = 16; i <= 25; i++) insertBlunder.run(1, i);

    const clamped = wp.createProgram(1, {
      title: 'My Blunders 25',
      source_type: 'blunders',
      puzzle_count: 50,
    });
    expect(clamped.ok).toBe(true);
    if (!clamped.ok) return;
    expect(clamped.program.total_puzzles).toBe(25);

    const next = wp.getNextPuzzle(1, clamped.program.id);
    expect(next.ok).toBe(true);
    if (next.ok && next.puzzle) {
      expect(next.puzzle.id.startsWith('blunder:')).toBe(true);
      expect(next.puzzle.has_setup_move).toBe(false);
      expect(next.puzzle.rating).toBeNull();
      expect(next.puzzle.moves).toEqual(['e7e5']);
    }
  });
});

describe('Deterministic puzzle freezing, cycle halving, rest intervals, and timing', () => {
  it('freezes the exact ordered puzzle sequence across all cycles and halves target durations with a 300s floor', () => {
    expect(wp.nextCycleTargetDuration(1, 2000, null)).toBe(1000);
    expect(wp.nextCycleTargetDuration(2, 950, 1000)).toBe(500);
    expect(wp.nextCycleTargetDuration(3, 480, 500)).toBe(300);
    expect(wp.nextCycleTargetDuration(4, 290, 300)).toBe(300);

    const created = wp.createProgram(1, {
      title: 'Freeze & Cycle Test',
      source_type: 'theme',
      theme: 'pin',
      rating_min: 1000,
      rating_max: 1800,
      puzzle_count: 20,
      target_cycles: 3,
      mode: 'strict',
      rest_duration_hours: 24,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const progId = created.program.id;
    const cycle1Order: string[] = [];
    let fakeNow = Date.parse('2026-05-01T10:00:00.000Z');

    // Solve all 20 puzzles in Cycle 1, taking 100s each (total 2000s)
    for (let i = 0; i < 20; i++) {
      const next = wp.getNextPuzzle(1, progId, fakeNow);
      expect(next.ok).toBe(true);
      if (!next.ok || !next.puzzle) throw new Error('Expected puzzle');
      cycle1Order.push(next.puzzle.id);

      fakeNow += 100_000; // +100 seconds
      const att = wp.recordWoodpeckerAttempt(
        1,
        progId,
        {
          puzzle_id: next.puzzle.id,
          outcome: i === 0 ? 'failed' : 'solved', // Miss the very first puzzle in Cycle 1
          time_spent_ms: 100_000,
          played_moves: next.puzzle.moves,
        },
        fakeNow,
      );
      expect(att.ok).toBe(true);
      if (att.ok && i === 19) {
        expect(att.cycle_completed).toBe(true);
        expect(att.program_completed).toBe(false);
        expect(att.next_cycle_number).toBe(2);
        // Cycle 1 -> Cycle 2 rest interval MUST be 2 * R = 48 hours
        const expectedRestIso = new Date(fakeNow + 48 * 3600 * 1000).toISOString();
        expect(att.rest_until).toBe(expectedRestIso);
      }
    }

    // Program is now resting; getNextPuzzle returns 409
    const whileResting = wp.getNextPuzzle(1, progId, fakeNow);
    expect(whileResting).toEqual({
      ok: false,
      status: 409,
      code: 'cycle_not_active',
      error: expect.any(String),
    });

    // Skip rest period to start Cycle 2
    const skipped = wp.skipRestPeriod(1, progId);
    expect(skipped).toEqual({ ok: true, current_cycle: 2, status: 'active' });

    const detailsAfterC1 = wp.getProgramDetails(1, progId)!;
    const c2 = detailsAfterC1.cycles.find((c) => c.cycle_number === 2)!;
    // Cycle 1 took 2000s, so Cycle 2 target is ceil(2000 / 2) = 1000s
    expect(c2.target_duration_sec).toBe(1000);

    // Play Cycle 2 in identical frozen order, taking 25s per puzzle (total 500s -> 4.0x speedup over 2000s)
    const cycle2Order: string[] = [];
    for (let i = 0; i < 20; i++) {
      const next = wp.getNextPuzzle(1, progId, fakeNow);
      if (!next.ok || !next.puzzle) throw new Error('Expected puzzle in C2');
      cycle2Order.push(next.puzzle.id);

      fakeNow += 25_000;
      const att = wp.recordWoodpeckerAttempt(
        1,
        progId,
        {
          puzzle_id: next.puzzle.id,
          outcome: i === 0 ? 'failed' : 'solved', // Miss puzzle 0 again so it becomes a stubborn puzzle!
          time_spent_ms: 25_000,
        },
        fakeNow,
      );
      expect(att.ok).toBe(true);
      if (att.ok && i === 19) {
        expect(att.cycle_completed).toBe(true);
        // Cycle 2 -> Cycle 3 rest interval MUST be 1 * R = 24 hours
        const expectedRest2Iso = new Date(fakeNow + 24 * 3600 * 1000).toISOString();
        expect(att.rest_until).toBe(expectedRest2Iso);
      }
    }

    expect(cycle2Order).toEqual(cycle1Order);

    // Skip rest and finish Cycle 3 with 100% accuracy and 20s per puzzle (total 400s -> 5.0x speedup)
    wp.skipRestPeriod(1, progId);
    const cycle3Order: string[] = [];
    for (let i = 0; i < 20; i++) {
      const next = wp.getNextPuzzle(1, progId, fakeNow);
      if (!next.ok || !next.puzzle) throw new Error('Expected puzzle in C3');
      cycle3Order.push(next.puzzle.id);
      fakeNow += 20_000;
      const att = wp.recordWoodpeckerAttempt(
        1,
        progId,
        {
          puzzle_id: next.puzzle.id,
          outcome: 'solved',
          time_spent_ms: 20_000,
        },
        fakeNow,
      );
      if (att.ok && i === 19) {
        expect(att.cycle_completed).toBe(true);
        expect(att.program_completed).toBe(true);
      }
    }

    expect(cycle3Order).toEqual(cycle1Order);

    // Verify summary analytics and stubborn puzzle detection
    const summary = wp.getProgramSummaryAnalytics(1, progId)!;
    expect(summary.speedup_factor).toBe(5); // 2000s / 400s = 5.0x
    expect(summary.accuracy_delta_pct).toBe(5); // 95% -> 100% = +5%
    expect(summary.stubborn_puzzles).toHaveLength(1);
    expect(summary.stubborn_puzzles[0]?.puzzle_id).toBe(cycle1Order[0]);
    expect(summary.stubborn_puzzles[0]?.failed_in_cycles).toEqual([1, 2]);

    // Verify achievements unlocked
    const ach = wp.woodpeckerAchievementStats(1);
    expect(ach).toEqual({
      finishedProgram: true,
      patternMachine: true,
      subconsciousInstinct: true,
    });
  });

  it('enforces server-authoritative clock, 10-minute cap, and re-stamps puzzle_started_at on retry_mistake in Practice Mode', () => {
    const created = wp.createProgram(1, {
      title: 'Practice Clock Test',
      source_type: 'theme',
      theme: 'mate',
      rating_min: 1000,
      rating_max: 1600,
      puzzle_count: 20,
      mode: 'practice',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const progId = created.program.id;

    let t = Date.parse('2026-05-02T12:00:00.000Z');
    const first = wp.getNextPuzzle(1, progId, t);
    if (!first.ok || !first.puzzle) throw new Error('Expected puzzle');
    const pid = first.puzzle.id;

    // 1. After 10 seconds, user makes a mistake in Practice Mode (retry_mistake)
    // Client lies and sends 50ms, server must record 10,000ms AND re-stamp puzzle_started_at = t + 10_000
    t += 10_000;
    const retry1 = wp.recordWoodpeckerAttempt(
      1,
      progId,
      { puzzle_id: pid, outcome: 'retry_mistake', time_spent_ms: 50 },
      t,
    );
    expect(retry1.ok).toBe(true);
    if (retry1.ok) {
      expect(retry1.elapsed_ms).toBe(10_000);
    }

    // 2. Without calling getNextPuzzle, 5 seconds later user makes another mistake
    // Because puzzle_started_at was re-stamped at t, server adds ONLY 5,000ms (total 15,000ms), NOT 15,000ms again!
    t += 5_000;
    const retry2 = wp.recordWoodpeckerAttempt(
      1,
      progId,
      { puzzle_id: pid, outcome: 'retry_mistake', time_spent_ms: 5000 },
      t,
    );
    expect(retry2.ok).toBe(true);
    if (retry2.ok) {
      expect(retry2.elapsed_ms).toBe(15_000);
    }

    // 3. User goes to lunch for 2 hours without pausing, then solves the puzzle.
    // Server must cap the single attempt delta at MAX_ATTEMPT_MS (600,000ms = 10 minutes).
    t += 2 * 3600 * 1000;
    const solvedAfterRetry = wp.recordWoodpeckerAttempt(
      1,
      progId,
      { puzzle_id: pid, outcome: 'solved', time_spent_ms: 1000 },
      t,
    );
    expect(solvedAfterRetry.ok).toBe(true);
    if (solvedAfterRetry.ok) {
      expect(solvedAfterRetry.elapsed_ms).toBe(15_000 + 600_000);
    }

    // 4. Verify Practice Mode accuracy: even though puzzle was eventually solved (solved = 1),
    // first_try_solved MUST remain 0 and mistakes_count MUST be 2.
    const details = wp.getProgramDetails(1, progId)!;
    expect(details.cycles[0]?.solved_puzzles).toBe(0);
    expect(details.cycles[0]?.accuracy_pct).toBe(0);
    expect(details.cycles[0]?.puzzle_started_at).toBeNull();
  });

  it('persists pause and resume across session breaks without counting paused time', () => {
    const created = wp.createProgram(1, {
      title: 'Pause Test',
      source_type: 'preset',
      preset_id: 'starter-100',
    });
    if (!created.ok) throw new Error('Expected program');
    const progId = created.program.id;

    let t = Date.parse('2026-05-03T08:00:00.000Z');
    const p1 = wp.getNextPuzzle(1, progId, t);
    expect(p1.ok).toBe(true);

    // Think for 12 seconds, then pause
    t += 12_000;
    const paused = wp.pauseSession(1, progId, t);
    expect(paused).toEqual({ ok: true, status: 'paused', elapsed_ms: 12_000 });

    const detailsPaused = wp.getProgramDetails(1, progId)!;
    expect(detailsPaused.status).toBe('paused');
    expect(detailsPaused.cycles[0]?.status).toBe('paused');

    // Stay paused for 1 hour -> should NOT add to elapsed_ms
    t += 3600_000;
    const resumed = wp.resumeSession(1, progId, t);
    expect(resumed).toEqual({ ok: true, status: 'in_progress' });

    // Think for 8 more seconds and solve -> total elapsed_ms should be 12_000 + 8_000 = 20_000
    t += 8_000;
    if (!p1.ok || !p1.puzzle) throw new Error('Expected puzzle');
    const att = wp.recordWoodpeckerAttempt(
      1,
      progId,
      { puzzle_id: p1.puzzle.id, outcome: 'solved', time_spent_ms: 8000 },
      t,
    );
    expect(att.ok).toBe(true);
    if (att.ok) {
      expect(att.elapsed_ms).toBe(20_000);
    }
  });
});

describe('Isolation, limits, and rating/queue decoupling', () => {
  it('enforces max 3 active programs per user, supports archive/delete, and isolates profiles', () => {
    for (let i = 1; i <= 3; i++) {
      const r = wp.createProgram(1, {
        title: `Prog ${i}`,
        source_type: 'preset',
        preset_id: 'starter-100',
      });
      expect(r.ok).toBe(true);
    }

    const fourth = wp.createProgram(1, {
      title: 'Prog 4',
      source_type: 'preset',
      preset_id: 'starter-100',
    });
    expect(fourth).toEqual({
      ok: false,
      code: 'program_limit_reached',
      error: expect.any(String),
    });

    const list1 = wp.listPrograms(1);
    const firstId = list1[0]!.id;

    // User 2 cannot access, pause, archive, or delete User 1's program
    expect(wp.getProgramDetails(2, firstId)).toBeNull();
    expect(wp.pauseSession(2, firstId)).toEqual({
      ok: false,
      status: 404,
      code: 'not_found',
      error: expect.any(String),
    });
    expect(wp.archiveProgram(2, firstId)).toBe(false);
    expect(wp.deleteProgram(2, firstId)).toBe(false);

    // Archiving frees up a slot for User 1
    expect(wp.archiveProgram(1, firstId)).toBe(true);
    const fourthRetry = wp.createProgram(1, {
      title: 'Prog 4 After Archive',
      source_type: 'preset',
      preset_id: 'starter-100',
    });
    expect(fourthRetry.ok).toBe(true);
  });

  it('never modifies tactics_attempts (Glicko rating) or puzzle_attempts (blunder queue) when drilling', () => {
    // Seed 20 blunders for User 1
    const insertBlunder = db.prepare(`
      INSERT INTO puzzle_attempts (user_id, game_id, ply, fen, solution_uci, solved, due_on)
      VALUES (1, 1, ?, 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', 'e7e5', 0, '2026-05-01')
    `);
    for (let i = 1; i <= 20; i++) insertBlunder.run(i);

    const ratingBefore = tactics.statsOf(1);
    const prog = wp.createProgram(1, {
      title: 'Blunder Decoupling Check',
      source_type: 'blunders',
      puzzle_count: 20,
    });
    if (!prog.ok) throw new Error('Expected blunder program');

    const next = wp.getNextPuzzle(1, prog.program.id);
    if (!next.ok || !next.puzzle) throw new Error('Expected blunder puzzle');

    wp.recordWoodpeckerAttempt(1, prog.program.id, {
      puzzle_id: next.puzzle.id,
      outcome: 'solved',
      time_spent_ms: 4000,
    });

    // Global tactics rating and tactics_attempts table must remain untouched
    expect(tactics.statsOf(1)).toEqual(ratingBefore);
    const tacticsCount = (db.prepare(`SELECT COUNT(*) AS n FROM tactics_attempts WHERE user_id = 1`).get() as { n: number }).n;
    expect(tacticsCount).toBe(0);

    // Original puzzle_attempts rows must still have solved = 0 and due_on = '2026-05-01'
    const blunderRows = db.prepare(`SELECT solved, due_on FROM puzzle_attempts WHERE user_id = 1`).all() as { solved: number; due_on: string }[];
    expect(blunderRows).toHaveLength(20);
    for (const r of blunderRows) {
      expect(r.solved).toBe(0);
      expect(r.due_on).toBe('2026-05-01');
    }
  });
});
