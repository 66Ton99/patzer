// Train → "From your games": the puzzles in your own analyzed games, how long
// their solution is, and when a puzzle you got wrong comes back.
//
// A puzzle is the position before one of your blunders, misses or mistakes.
// The solution starts with the engine's best move there. When the engine's
// line goes on with forcing moves (a check, a capture, a promotion, a mate),
// the puzzle goes on too — the opponent's reply is played for you, and you
// find your next move — up to MAX_OWN_MOVES of yours. A quiet follow-up ends
// it: quiet moves are where the engine's line stops being the only good one.
//
// The review queue is as simple as the opening trainer's: a puzzle you don't
// solve at the first try comes back the next day; solved at the first try on
// a later day, it's done. Trying again the same day is practice and changes
// nothing.

import { Chess } from 'chess.js';
import type { AnalyzedMove } from '../types.js';

/** At most this many of your own moves in one puzzle. */
export const MAX_OWN_MOVES = 3;

/** Is this move of the user's a puzzle? Their blunders, misses and mistakes
 *  with a different best move to find. */
export function isPuzzleMove(m: AnalyzedMove, userColor: 'white' | 'black'): boolean {
  const side = m.ply % 2 === 1 ? 'white' : 'black';
  if (side !== userColor) return false;
  if (m.classification !== 'blunder' && m.classification !== 'miss' && m.classification !== 'mistake') return false;
  return !!m.best_move_uci && !!m.best_move_san && m.best_move_uci !== m.uci;
}

const isForcing = (san: string) => /[x+#=]/.test(san);

function playUci(chess: Chess, uci: string) {
  try {
    return chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4, 5) || undefined });
  } catch {
    return null;
  }
}

function playSan(chess: Chess, san: string) {
  try {
    return chess.move(san);
  } catch {
    return null;
  }
}

/** The solution line in UCI and SAN: your move first, then the opponent's
 *  reply and your next move in turn — it always ends with yours. `pvSan` is
 *  the engine's line from the analysis (SAN, starting with the best move). */
export function puzzleLine(fen: string, bestUci: string, pvSan: string[]): { uci: string[]; san: string[] } {
  const chess = new Chess(fen);
  const first = playUci(chess, bestUci);
  if (!first) return { uci: [], san: [] };
  const uci = [bestUci];
  const san = [first.san];
  // The analysis line has to start with the same move, or it belongs to
  // something else.
  if (pvSan[0] !== first.san) return { uci, san };

  let own = 1;
  for (let i = 1; own < MAX_OWN_MOVES && !chess.isGameOver(); i += 2) {
    const replySan = pvSan[i];
    const nextSan = pvSan[i + 1];
    if (!replySan || !nextSan || !isForcing(nextSan)) break;
    const reply = playSan(chess, replySan);
    if (!reply) break;
    const next = playSan(chess, nextSan);
    if (!next) break;
    uci.push(reply.lan, next.lan);
    san.push(reply.san, next.san);
    own++;
  }
  return { uci, san };
}

/** The board after the first `n` moves of a line. */
export function positionAfter(fen: string, line: string[], n: number): string | null {
  const chess = new Chess(fen);
  for (const uci of line.slice(0, n)) if (!playUci(chess, uci)) return null;
  return chess.fen();
}

/** The calendar day after `day` (YYYY-MM-DD). */
export function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

export interface QueueState {
  solved: 0 | 1;
  due_on: string | null;
  last_day: string | null;
}

/** What one first try does to a puzzle's place in the queue. `before` is null
 *  for a puzzle never tried. `counts` is false for a second go the same day
 *  (or at a puzzle that's already done) — that's practice, nothing changes. */
export function afterTry(before: QueueState | null, solved: boolean, today: string): QueueState & { counts: boolean } {
  if (before && (before.solved === 1 || before.last_day === today)) return { ...before, counts: false };
  return solved
    ? { solved: 1, due_on: null, last_day: today, counts: true }
    : { solved: 0, due_on: nextDay(today), last_day: today, counts: true };
}

/** Is a puzzle that was tried before up for review today? */
export function isDue(state: QueueState, today: string): boolean {
  if (state.solved === 1) return false;
  if (state.last_day !== null && state.last_day >= today) return false;
  return state.due_on === null || state.due_on <= today;
}
