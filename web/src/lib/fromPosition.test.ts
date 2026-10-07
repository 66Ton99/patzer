import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import { parseFromPosition, playFromPosition, playFromUrl } from './fromPosition';

// Positions of 1. e4 e5 2. Nf3, as Game Review builds them.
function positionsOf(sans: string[]) {
  const c = new Chess();
  const list: { fen: string; uci?: string }[] = [{ fen: c.fen() }];
  for (const san of sans) {
    const m = c.move(san);
    list.push({ fen: c.fen(), uci: m.from + m.to + (m.promotion ?? '') });
  }
  return list;
}

describe('play from here', () => {
  const positions = positionsOf(['e4', 'e5', 'Nf3', 'Nc6']);

  it('starts right before a white move', () => {
    expect(playFromPosition(positions, 3)).toEqual({ fen: positions[2]!.fen, moves: [] });
  });

  it('starts a black move one move earlier, replaying the opponent first', () => {
    // So the saved game begins with white, like every other game.
    expect(playFromPosition(positions, 4)).toEqual({ fen: positions[2]!.fen, moves: ['g1f3'] });
    expect(playFromPosition(positions, 2)).toEqual({ fen: positions[0]!.fen, moves: ['e2e4'] });
  });

  it('round-trips through the URL and lands where you take over', () => {
    const p = playFromPosition(positions, 4)!;
    const q = new URLSearchParams(playFromUrl(p).split('?')[1]);
    const parsed = parseFromPosition(q.get('fen'), q.get('moves'))!;
    expect(parsed.color).toBe('black');
    expect(parsed.at).toBe(positions[3]!.fen);
  });

  it('refuses what the server would refuse', () => {
    expect(parseFromPosition(positions[1]!.fen, null)).toBeNull();           // black to move
    expect(parseFromPosition('not a fen', null)).toBeNull();
    expect(parseFromPosition(positions[0]!.fen, 'e2e5')).toBeNull();         // illegal move
    expect(parseFromPosition(positions[0]!.fen, 'e2e4,e7e5,g1f3')).toBeNull(); // too many
    expect(parseFromPosition(null, null)).toBeNull();
  });
});
