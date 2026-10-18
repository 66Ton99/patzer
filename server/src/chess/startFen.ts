import { Chess } from 'chess.js';

// Games can start from a position instead of the opening (Game Review →
// "Play from here"). Their PGN carries [SetUp "1"] [FEN "…"], which
// `loadPgn` understands — but every replay that walks the moves again from a
// fresh `new Chess()` has to start from that FEN too, or the first move is
// illegal.

/** The position a loaded game started from, or undefined for the normal start.
 *  Pass the raw `pgn` it was loaded from when it matters whether it is a game
 *  from a position at all: chess.js drops SetUp/FEN when the FEN is the
 *  normal start position (the Lab's untouched board), the raw text keeps them. */
export function startFenOf(chess: Chess, pgn?: string): string | undefined {
  const h = chess.getHeaders();
  if (h.SetUp === '1' && h.FEN) return h.FEN;
  if (pgn && /^\[SetUp\s+"1"\]/m.test(pgn)) return /^\[FEN\s+"([^"]+)"\]/m.exec(pgn)?.[1];
  return undefined;
}

/**
 * A game to start from a position: `fen` with white to move, then `moves`
 * (UCI) already played. Null unless all of it is legal and the game isn't
 * over.
 *
 * Why white to move: Game Review, Insights and the analyzer all read a move's
 * side from its ply number (odd = white). A game from a black-to-move
 * position would flip every one of them. So "play from here" on a black move
 * starts one move earlier and replays the opponent's move from the game
 * first — the PGN then starts with white, like every other game.
 */
export function startFromPosition(fen: unknown, moves: unknown = []): Chess | null {
  if (typeof fen !== 'string' || fen.length > 100) return null;
  if (!Array.isArray(moves) || moves.length > 2) return null;
  try {
    const chess = new Chess(fen);
    if (chess.turn() !== 'w') return null;
    for (const uci of moves) {
      if (typeof uci !== 'string' || !/^[a-h][1-8][a-h][1-8][nbrq]?$/.test(uci)) return null;
      chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4) || undefined });
    }
    return chess.isGameOver() ? null : chess;
  } catch {
    return null;
  }
}
