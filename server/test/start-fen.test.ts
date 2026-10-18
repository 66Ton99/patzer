import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import { startFenOf, startFromPosition } from '../src/chess/startFen.js';
import { lookupOpeningFromPgn } from '../src/chess/openings.js';

const AFTER_E4_E5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';

describe('games from a position', () => {
  it('starts with white to move, after the moves already played', () => {
    const c = startFromPosition(AFTER_E4_E5, ['g1f3'])!;
    expect(c.turn()).toBe('b');
    expect(c.history()).toEqual(['Nf3']);
  });

  it('refuses a black-to-move start, illegal moves, and finished games', () => {
    expect(startFromPosition('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1')).toBeNull();
    expect(startFromPosition(AFTER_E4_E5, ['e1e8'])).toBeNull();
    expect(startFromPosition(AFTER_E4_E5, ['g1f3', 'b8c6', 'f1c4'])).toBeNull();
    expect(startFromPosition('nonsense')).toBeNull();
    // Fool's mate, already over.
    expect(startFromPosition('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3')).toBeNull();
  });

  it('round-trips through PGN, so a resumed game and the analyzer find the start', () => {
    const c = startFromPosition(AFTER_E4_E5, ['g1f3'])!;
    c.header('SetUp', '1'); c.header('FEN', AFTER_E4_E5);
    c.move('Nc6');
    const back = new Chess();
    back.loadPgn(c.pgn());
    expect(startFenOf(back)).toBe(AFTER_E4_E5);
    const replay = new Chess(startFenOf(back));
    for (const m of back.history({ verbose: true })) replay.move(m.san);
    expect(replay.fen()).toBe(back.fen());
  });

  it('has no opening', () => {
    const c = startFromPosition(AFTER_E4_E5, ['g1f3'])!;
    c.header('SetUp', '1'); c.header('FEN', AFTER_E4_E5);
    expect(lookupOpeningFromPgn(c.pgn())).toBeNull();
    expect(lookupOpeningFromPgn('1. e4 e5 2. Nf3 Nc6 3. Bb5 *')).not.toBeNull();
  });

  it('still finds the start in the raw PGN when chess.js dropped the headers', () => {
    const start = new Chess().fen();
    const pgn = `[SetUp "1"]\n[FEN "${start}"]\n\n1. e4 c6 *`;
    const loaded = new Chess();
    loaded.loadPgn(pgn);
    expect(startFenOf(loaded, pgn)).toBe(start);
    expect(startFenOf(loaded, '1. e4 c6 *')).toBeUndefined();
  });

  it('has no opening even when it starts from the normal start position', () => {
    // chess.js drops SetUp/FEN for the default FEN, so this is the PGN the
    // Lab's untouched board saves.
    const pgn = '[Event "Local game vs bot, from a position"]\n[SetUp "1"]\n[FEN "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"]\n\n1. e4 c6 0-1';
    expect(lookupOpeningFromPgn(pgn)).toBeNull();
    expect(lookupOpeningFromPgn(pgn.replace('[SetUp "1"]\n', ''))).not.toBeNull();
  });
});
