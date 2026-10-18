import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_OWN_MOVES, afterTry, isDue, nextDay, positionAfter, puzzleLine } from '../src/chess/gamePuzzles.js';

// The routes open the real database on import, so point it at a throwaway
// file first.
const dir = mkdtempSync(join(tmpdir(), 'patzer-train-'));
process.env.DB_PATH = join(dir, 'train.db');

// White to move: Qxd8+ Qxd8 Rxd8# — two moves of yours, both forcing.
const BACK_RANK = '3r2k1/5ppp/5q2/8/8/8/3Q1PPP/3R2K1 w - - 0 1';
// White checks for ever: Qe4+ Kg8 Qe8+ Kh7 …
const CHECKS = '8/7k/8/4Q3/8/8/8/6K1 w - - 0 1';

describe('the solution line', () => {
  it('goes on while the engine line goes on with forcing moves', () => {
    const line = puzzleLine(BACK_RANK, 'd2d8', ['Qxd8+', 'Qxd8', 'Rxd8#', 'h6']);
    expect(line.uci).toEqual(['d2d8', 'f6d8', 'd1d8']);
    expect(line.san).toEqual(['Qxd8+', 'Qxd8', 'Rxd8#']);
  });

  it('stops before a quiet move', () => {
    expect(puzzleLine(BACK_RANK, 'd2d5', ['Qd5', 'h6', 'Qd7']).uci).toEqual(['d2d5']);
  });

  it(`has at most ${MAX_OWN_MOVES} of your moves`, () => {
    const line = puzzleLine(CHECKS, 'e5e4', ['Qe4+', 'Kg8', 'Qe8+', 'Kh7', 'Qe4+', 'Kg8', 'Qe8+', 'Kh7']);
    expect(line.uci.length).toBe(MAX_OWN_MOVES * 2 - 1);
    expect(line.san.at(-1)).toBe('Qe4+');
  });

  it('is just the best move when the engine line belongs to another move', () => {
    expect(puzzleLine(BACK_RANK, 'd2d8', ['Qd3', 'h6', 'Qxd8+']).san).toEqual(['Qxd8+']);
    expect(puzzleLine(BACK_RANK, 'd2d8', []).san).toEqual(['Qxd8+']);
  });

  it('is empty when the best move is not legal there', () => {
    expect(puzzleLine(BACK_RANK, 'e2e4', ['e4']).uci).toEqual([]);
  });

  it('replays to any point', () => {
    expect(positionAfter(BACK_RANK, ['d2d8', 'f6d8'], 2)).toBe('3q2k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 2');
    expect(positionAfter(BACK_RANK, ['a1a8'], 1)).toBeNull();
  });
});

describe('the review queue', () => {
  const today = '2026-09-30';

  it('counts days across the end of a month', () => {
    expect(nextDay(today)).toBe('2026-10-01');
  });

  it('a first try solved is done; missed comes back tomorrow', () => {
    expect(afterTry(null, true, today)).toEqual({ solved: 1, due_on: null, last_day: today, counts: true });
    expect(afterTry(null, false, today)).toEqual({ solved: 0, due_on: '2026-10-01', last_day: today, counts: true });
  });

  it('a second go the same day is practice and changes nothing', () => {
    const missed = afterTry(null, false, today);
    expect(afterTry(missed, true, today)).toMatchObject({ solved: 0, due_on: '2026-10-01', counts: false });
  });

  it('solved at the first try on a later day is done; missed again, tomorrow again', () => {
    const missed = afterTry(null, false, today);
    expect(isDue(missed, today)).toBe(false);
    expect(isDue(missed, '2026-10-01')).toBe(true);
    expect(afterTry(missed, true, '2026-10-01')).toMatchObject({ solved: 1, due_on: null, counts: true });
    expect(afterTry(missed, false, '2026-10-01')).toMatchObject({ solved: 0, due_on: '2026-10-02', counts: true });
  });

  it('an old failed attempt (before the queue existed) is due', () => {
    expect(isDue({ solved: 0, due_on: null, last_day: null }, today)).toBe(true);
    expect(isDue({ solved: 1, due_on: null, last_day: null }, today)).toBe(false);
  });
});

describe('/api/train', () => {
  type Router = typeof import('../src/routes/train.js')['default'];
  let router: Router;
  let db: typeof import('../src/db.js')['db'];
  let cookie: string;
  const today = new Date().toISOString().slice(0, 10);

  /** Pretend a day went by. */
  function aDayLater() {
    db.prepare(`UPDATE puzzle_attempts SET last_day = date(last_day, '-1 day'), due_on = date(due_on, '-1 day')`).run();
  }

  async function call<T>(path: string, body?: unknown): Promise<T> {
    const res = await router.request(path, body === undefined
      ? { headers: { Cookie: cookie } }
      : { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return res.json() as Promise<T>;
  }

  interface Next { puzzle: { game_id: number; ply: number; line: string[]; line_san: string[]; review: boolean } | null; due: number }

  beforeAll(async () => {
    ({ db } = await import('../src/db.js'));
    const { SCORING_VERSION } = await import('../src/chess/classifier.js');
    router = (await import('../src/routes/train.js')).default;
    const { createSession, SESSION_COOKIE_NAME } = await import('../src/auth/sessions.js');
    db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (1, 'me', 'x', 'user')`).run();
    db.prepare(`INSERT INTO profiles (user_id, display_name) VALUES (1, 'Me')`).run();
    cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(createSession(1))}`;

    db.prepare(`INSERT INTO games (id, user_id, source, pgn, white, black, result, end_time, user_color) VALUES (1, 1, 'played', '', 'me', 'Bot', 'loss', '2026-09-01 10:00:00', 'white')`).run();
    // Ply 1 is yours: you played Qd3 and missed the back-rank mate.
    const blunder = {
      ply: 1, san: 'Qd3', uci: 'd2d3', fen_before: BACK_RANK, fen_after: BACK_RANK,
      eval_before_cp: 2000, eval_after_cp: 0, mate_before: 2, mate_after: null,
      best_move_uci: 'd2d8', best_move_san: 'Qxd8+', best_pv: ['Qxd8+', 'Qxd8', 'Rxd8#'],
      centipawn_loss: 900, classification: 'miss',
    };
    db.prepare(`INSERT INTO analyses (game_id, depth, moves_json, scoring_version) VALUES (1, 14, ?, ?)`).run(JSON.stringify([blunder]), SCORING_VERSION);
  });

  afterAll(() => {
    try { db.close(); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves the whole line', async () => {
    const next = await call<Next>(`/next?today=${today}`);
    expect(next.puzzle).toMatchObject({ game_id: 1, ply: 1, line: ['d2d8', 'f6d8', 'd1d8'], line_san: ['Qxd8+', 'Qxd8', 'Rxd8#'], review: false });
    expect(next.due).toBe(0);
  });

  it('accepts the line, never your own game move', async () => {
    expect(await call('/check', { game_id: 1, ply: 1, step: 0, uci: 'd2d8' })).toEqual({ ok: true });
    expect(await call('/check', { game_id: 1, ply: 1, step: 2, uci: 'd1d8' })).toEqual({ ok: true });
    expect(await call('/check', { game_id: 1, ply: 1, step: 0, uci: 'd2d3' })).toEqual({ ok: false });
    expect(await call('/check', { game_id: 1, ply: 1, step: 0, uci: 'a1a8' })).toEqual({ ok: false });
    expect((await call<{ error: string }>('/check', { game_id: 1, ply: 1, step: 1, uci: 'f6d8' })).error).toBe('invalid_input');
  });

  it('brings a missed puzzle back the next day, and lets it go once solved', async () => {
    expect(await call('/attempt', { game_id: 1, ply: 1, solved: false, attempted_uci: 'd2d3', today })).toMatchObject({ counted: true, done: false });
    // Not again today — and "try again" the same day doesn't count.
    expect((await call<Next>(`/next?today=${today}`)).puzzle).toBeNull();
    expect(await call('/attempt', { game_id: 1, ply: 1, solved: true, today })).toMatchObject({ counted: false, done: false });

    aDayLater();
    const back = await call<Next>(`/next?today=${today}`);
    expect(back.puzzle).toMatchObject({ game_id: 1, ply: 1, review: true });
    expect(back.due).toBe(1);
    expect(await call('/attempt', { game_id: 1, ply: 1, solved: true, today })).toMatchObject({ counted: true, done: true });

    aDayLater();
    expect((await call<Next>(`/next?today=${today}`)).puzzle).toBeNull();
    expect(await call<{ solved: number; due: number }>(`/stats?today=${today}`)).toMatchObject({ solved: 1, due: 0 });
  });

  it('says not_found for a move that is no puzzle', async () => {
    const res = await router.request('/attempt', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ game_id: 1, ply: 2, solved: true }),
    });
    expect(res.status).toBe(404);
  });
});
