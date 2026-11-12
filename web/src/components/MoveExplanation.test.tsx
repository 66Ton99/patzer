// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MoveExplanation from './MoveExplanation';
import type { AnalyzedMove } from '../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'review.why.playFromHere': 'Play from here against Patzer',
        'review.why.analyze': 'Analyze',
        'review.why.yourMove': 'Your move',
        'review.why.opponentMove': "Opponent's move",
        'review.why.best': 'Best move',
        'classification.best': 'Best',
      };
      return translations[key] ?? key;
    },
  }),
}));

vi.mock('./CoachPanel', () => ({
  default: () => <div data-testid="coach-panel" />,
}));

afterEach(cleanup);

describe('MoveExplanation', () => {
  const dummyMove: AnalyzedMove = {
    ply: 3,
    san: 'Nf3',
    uci: 'g1f3',
    fen_before: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
    fen_after: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2',
    eval_before_cp: 30,
    eval_after_cp: 35,
    best_move_uci: 'g1f3',
    best_move_san: 'Nf3',
    best_pv: ['g1f3', 'b8c6'],
    centipawn_loss: 0,
    classification: 'best',
  };

  it('renders both Play from here and Analyze in Lab links when playFrom is provided', () => {
    const playFromUrl = '/play?fen=test&moves=g1f3';
    render(
      <MemoryRouter>
        <MoveExplanation
          move={dummyMove}
          userColor="white"
          coachConfigured={false}
          coachRequest={null}
          playFrom={playFromUrl}
        />
      </MemoryRouter>
    );

    const playLink = screen.getByRole('link', { name: /Play from here against Patzer/i });
    expect(playLink).toBeTruthy();
    expect(playLink.getAttribute('href')).toBe(playFromUrl);

    const analyzeLink = screen.getByRole('link', { name: /Analyze/i });
    expect(analyzeLink).toBeTruthy();
    expect(analyzeLink.getAttribute('href')).toBe(`/lab#${encodeURI(dummyMove.fen_after)}`);
  });

  it('renders Analyze link with full game query when gameId is provided', () => {
    const playFromUrl = '/play?fen=test&moves=g1f3';
    render(
      <MemoryRouter>
        <MoveExplanation
          move={dummyMove}
          userColor="white"
          coachConfigured={false}
          coachRequest={null}
          playFrom={playFromUrl}
          gameId={42}
          pgn="1. e4 e5 2. Nf3"
          gameTitle="Alice vs Bob"
        />
      </MemoryRouter>
    );

    const analyzeLink = screen.getByRole('link', { name: /Analyze/i });
    expect(analyzeLink).toBeTruthy();
    expect(analyzeLink.getAttribute('href')).toBe('/lab?game=42&ply=3');
  });

  it('does not render playFrom or analyze links when playFrom is not set', () => {
    render(
      <MemoryRouter>
        <MoveExplanation
          move={dummyMove}
          userColor="white"
          coachConfigured={false}
          coachRequest={null}
        />
      </MemoryRouter>
    );

    expect(screen.queryByRole('link', { name: /Play from here against Patzer/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /Analyze/i })).toBeNull();
  });
});
