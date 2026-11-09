// Pure helpers for Woodpecker tactical training puzzles.
// Supports both Lichess puzzles (has_setup_move: true, opponent plays moves[0])
// and personal game blunder puzzles (has_setup_move: false, player plays moves[0]).

import { Chess } from 'chess.js';

export interface WoodpeckerPuzzle {
  id: string;
  fen: string;
  moves: string[];
  has_setup_move: boolean;
  rating: number | null;
  themes: string[];
}

function play(chess: Chess, uci: string) {
  return chess.move({
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci.slice(4, 5) || undefined,
  });
}

/** The board after the first `n` moves of the line, with the last move's squares. */
export function wpPositionAt(p: WoodpeckerPuzzle, n: number): { fen: string; lastMove?: [string, string]; turn: 'white' | 'black' } {
  const chess = new Chess(p.fen);
  let lastMove: [string, string] | undefined;
  for (const uci of p.moves.slice(0, n)) {
    const m = play(chess, uci);
    lastMove = [m.from, m.to];
  }
  return { fen: chess.fen(), lastMove, turn: chess.turn() === 'w' ? 'white' : 'black' };
}

/** The side you play. If has_setup_move is true, the opponent moves first at p.fen,
 *  so you play the opposite side. If has_setup_move is false, you play the side to move at p.fen. */
export function wpPlayerOf(p: WoodpeckerPuzzle): 'white' | 'black' {
  const turnAtStart = new Chess(p.fen).turn() === 'w' ? 'white' : 'black';
  if (p.has_setup_move) {
    return turnAtStart === 'white' ? 'black' : 'white';
  }
  return turnAtStart;
}

/** Whether move index `n` is the player's turn. */
export function wpIsPlayerTurnAtIndex(p: WoodpeckerPuzzle, n: number): boolean {
  if (n >= p.moves.length) return false;
  return p.has_setup_move ? n % 2 === 1 : n % 2 === 0;
}

/** Check if `uci` is the right move at index `n` of the line (or delivers checkmate on the final move). */
export function wpIsRightMove(p: WoodpeckerPuzzle, n: number, uci: string): boolean {
  const want = p.moves[n];
  if (!want) return false;
  if (uci === want) return true;
  if (want.length === 5 && uci.length === 4 && want.endsWith('q') && uci === want.slice(0, 4)) return true;
  if (n !== p.moves.length - 1) return false;
  const chess = new Chess(wpPositionAt(p, n).fen);
  try {
    play(chess, uci);
  } catch {
    return false;
  }
  return chess.isCheckmate();
}

/** SAN of move `n` of the line. */
export function wpSanAt(p: WoodpeckerPuzzle, n: number): string {
  const chess = new Chess(wpPositionAt(p, n).fen);
  return play(chess, p.moves[n]!).san;
}

/** Format duration in seconds into `Xh Ym` or `Mm Ss`. */
export function formatDurationSec(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (hrs > 0) {
    return `${hrs}h ${String(mins).padStart(2, '0')}m`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}
