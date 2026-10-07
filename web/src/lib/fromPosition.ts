// "Play from here": Game Review hands a position to the Play page, which
// starts a bot game there (server/src/chess/startFen.ts). Such a game always
// starts with white to move — every ply-parity reading of a game (odd =
// white) stays true — so a black move starts one move earlier, with the
// opponent's move from the game replayed first.

import { Chess } from 'chess.js';

/** Where "play from here" starts for the move at `ply`: the position before
 *  it if white is to move there, otherwise one move earlier with the
 *  opponent's move from the game replayed first. A game from a position
 *  always starts with white to move (server/src/chess/startFen.ts). */
export function playFromPosition(positions: { fen: string; uci?: string }[], ply: number): { fen: string; moves: string[] } | undefined {
  const before = positions[ply - 1];
  if (!before) return undefined;
  if (before.fen.split(' ')[1] === 'w') return { fen: before.fen, moves: [] };
  const earlier = positions[ply - 2];
  if (!earlier || !before.uci || earlier.fen.split(' ')[1] !== 'w') return undefined;
  return { fen: earlier.fen, moves: [before.uci] };
}

export function playFromUrl(p: { fen: string; moves: string[] }): string {
  const q = new URLSearchParams({ fen: p.fen });
  if (p.moves.length) q.set('moves', p.moves.join(','));
  return `/play?${q.toString()}`;
}

/** Game Review's "play from here" (?fen=&moves=), checked the way the server
 *  checks it: a white-to-move position, then up to two moves already played,
 *  and a game that isn't over. `at` is where you take over. */
export function parseFromPosition(fen: string | null, moves: string | null): { fen: string; moves: string[]; at: string; color: 'white' | 'black' } | null {
  if (!fen) return null;
  try {
    const chess = new Chess(fen);
    if (chess.turn() !== 'w') return null;
    const list = moves ? moves.split(',').filter(Boolean) : [];
    if (list.length > 2) return null;
    for (const uci of list) chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4) || undefined });
    if (chess.isGameOver()) return null;
    return { fen, moves: list, at: chess.fen(), color: chess.turn() === 'w' ? 'white' : 'black' };
  } catch {
    return null;
  }
}
