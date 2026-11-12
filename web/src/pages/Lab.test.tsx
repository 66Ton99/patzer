// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cgApi = {
  set: vi.fn(),
  setShapes: vi.fn(),
  redrawAll: vi.fn(),
  destroy: vi.fn(),
};
vi.mock('chessground', () => ({ Chessground: vi.fn(() => cgApi) }));

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../api', () => ({ api: { get, post } }));

vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, className, style }: { children?: React.ReactNode; className?: string; style?: React.CSSProperties }) => (
      <div className={className} style={style}>{children}</div>
    ),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string; [key: string]: unknown }) => {
      let value = options?.defaultValue ?? _key;
      for (const [k, replacement] of Object.entries(options ?? {})) {
        if (k !== 'defaultValue') value = value.replace(`{{${k}}}`, String(replacement));
      }
      return value;
    },
  }),
}));

import Lab from './Lab';

function renderLab(initialEntry: string | { pathname?: string; search?: string; hash?: string; state?: unknown } = '/lab') {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialEntry as never]}>
        <Lab />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  post.mockReset();
  get.mockReset();
});

afterEach(cleanup);

describe('Lab position analysis bar (EvalBar)', () => {
  it('renders Lab with an eval bar showing 0.0 initially', async () => {
    renderLab();
    expect(screen.getByText('Lab')).toBeTruthy();
    // Neutral eval bar chip
    expect(screen.getByText('0.0')).toBeTruthy();
    // Flip and Reset controls
    expect(screen.getByRole('button', { name: 'Flip board' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reset' })).toBeTruthy();
  });

  it('updates eval bar with centipawn evaluation when White is ahead', async () => {
    const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    post.mockResolvedValueOnce({
      fen: startFen,
      depth: 12,
      lines: [
        { uci: 'e2e4', san: 'e4', pv_san: ['e4', 'e5'], cp: 150, mate: null, multipv: 1 },
      ],
    });

    renderLab();
    const analyzeBtn = screen.getByRole('button', { name: 'Analyze' });
    await act(async () => {
      fireEvent.click(analyzeBtn);
    });

    expect(post).toHaveBeenCalledWith('/api/analyze/position', expect.objectContaining({
      fen: startFen,
      depth: 12,
      lines: 5,
    }));

    // +1.5 for White
    expect(await screen.findByText('+1.5')).toBeTruthy();
    expect(screen.getByText('e4')).toBeTruthy();
  });

  it('inverts centipawn evaluation for Black to move to preserve White perspective', async () => {
    // Black to move: 1. e4 e5. Black's best move has cp: 80 (meaning Black is +0.80)
    const fenBlackToMove = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    post.mockResolvedValueOnce({
      fen: fenBlackToMove,
      depth: 12,
      lines: [
        { uci: 'g8f6', san: 'Nf6', pv_san: ['Nf6', 'b1c3'], cp: 80, mate: null, multipv: 1 },
      ],
    });

    renderLab();
    const fenInput = screen.getByPlaceholderText('Paste a FEN…');
    fireEvent.change(fenInput, { target: { value: fenBlackToMove } });
    fireEvent.click(screen.getByRole('button', { name: 'Set' }));

    const analyzeBtn = screen.getByRole('button', { name: 'Analyze' });
    await act(async () => {
      fireEvent.click(analyzeBtn);
    });

    // White perspective is -0.8
    expect(await screen.findByText('−0.8')).toBeTruthy();
  });

  it('displays mate on eval bar when engine finds mate', async () => {
    const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    post.mockResolvedValueOnce({
      fen: startFen,
      depth: 12,
      lines: [
        { uci: 'd1h5', san: 'Qh5#', pv_san: ['Qh5#'], cp: null, mate: 1, multipv: 1 },
      ],
    });

    renderLab();
    const analyzeBtn = screen.getByRole('button', { name: 'Analyze' });
    await act(async () => {
      fireEvent.click(analyzeBtn);
    });

    expect(await screen.findByText('M1')).toBeTruthy();
  });

  it('immediately shows mate for checkmate positions without engine call', async () => {
    // Fool's mate: 1. f3 e5 2. g4 Qh4# (White is checkmated)
    const foolsMate = 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3';
    renderLab();

    const fenInput = screen.getByPlaceholderText('Paste a FEN…');
    fireEvent.change(fenInput, { target: { value: foolsMate } });
    fireEvent.click(screen.getByRole('button', { name: 'Set' }));

    // White is checkmated -> Black has mate (M1)
    expect(screen.getByText('M1')).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });

  it('flips the board and eval bar orientation', async () => {
    renderLab();
    const flipBtn = screen.getByRole('button', { name: 'Flip board' });
    fireEvent.click(flipBtn);
    expect(screen.getByText('0.0')).toBeTruthy();
  });

  it('shows 0.0 eval on stalemate positions', async () => {
    // Stalemate: Black king at a8 has no legal moves and is not in check
    const stalemateFen = 'k7/8/1Q6/8/8/8/8/7K b - - 0 1';
    renderLab();

    const fenInput = screen.getByPlaceholderText('Paste a FEN…');
    fireEvent.change(fenInput, { target: { value: stalemateFen } });
    fireEvent.click(screen.getByRole('button', { name: 'Set' }));

    expect(screen.getByText('0.0')).toBeTruthy();
  });

  it('restores cached evaluation when navigating back through moves', async () => {
    const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    post.mockResolvedValueOnce({
      fen: startFen,
      depth: 12,
      lines: [
        { uci: 'e2e4', san: 'e4', pv_san: ['e4', 'e5'], cp: 40, mate: null, multipv: 1 },
      ],
    });

    renderLab();
    // 1. Analyze initial position
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Analyze' }));
    });
    expect(await screen.findByText('+0.4')).toBeTruthy();

    // 2. Play e4 from line button
    fireEvent.click(screen.getByRole('button', { name: 'e4' }));

    // Board moved to e4, new position is unanalyzed
    expect(screen.getByText('0.0')).toBeTruthy();

    // 3. Step back to Start in moves history
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    // Cached evaluation for start position should be immediately restored (+0.4)
    expect(screen.getByText('+0.4')).toBeTruthy();
  });

  it('renders Analyze button in Engine analysis panel and Play from here under the board', async () => {
    renderLab();
    const analyzeBtn = screen.getByRole('button', { name: 'Analyze' });
    expect(analyzeBtn).toBeTruthy();
    // There is also the play from here link
    expect(screen.getByRole('link', { name: /Play from here/i })).toBeTruthy();
  });

  it('loads initial position from URL hash', async () => {
    const customFen = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3';
    renderLab(`/lab#${encodeURI(customFen)}`);
    expect(screen.getByText(customFen)).toBeTruthy();
  });

  it('loads full game from state, positions at target ply, and triggers auto-analysis', async () => {
    post.mockResolvedValue({
      fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3',
      depth: 12,
      lines: [
        { uci: 'f1b5', san: 'Bb5', pv_san: ['Bb5', 'a6'], cp: 25, mate: null, multipv: 1 },
      ],
    });

    renderLab({
      pathname: '/lab',
      search: '?game=42&ply=3',
      state: {
        gameId: 42,
        pgn: '1. e4 e5 2. Nf3 Nc6',
        ply: 3,
        userColor: 'black',
        gameTitle: 'PlayerA vs PlayerB',
      },
    });

    // Subtitle shows gameTitle
    expect(screen.getByText('PlayerA vs PlayerB')).toBeTruthy();
    // Navigation shows ply 3 / 4
    expect(screen.getByText('3 / 4')).toBeTruthy();
    // Auto-analysis was called on the position after move 3 (Nf3)
    await waitFor(() => {
      expect(post).toHaveBeenCalledWith('/api/analyze/position', expect.objectContaining({
        depth: 12,
        lines: 5,
      }));
    });
  });

  it('analyzes whole game starting from the specific position', async () => {
    const fensCalled: string[] = [];
    post.mockImplementation((url, body: { fen: string }) => {
      if (url === '/api/analyze/position') {
        fensCalled.push(body.fen);
        return Promise.resolve({
          fen: body.fen,
          depth: 12,
          lines: [{ uci: 'e2e4', san: 'e4', pv_san: ['e4'], cp: 20, mate: null, multipv: 1 }],
        });
      }
      return Promise.reject(new Error('not handled'));
    });

    renderLab({
      pathname: '/lab',
      state: {
        pgn: '1. e4 e5 2. Nf3', // 3 plies: 1. e4 (ply 1), 1... e5 (ply 2), 2. Nf3 (ply 3)
        ply: 2, // starting from move 2 (1... e5)
      },
    });

    // Wait for initial auto-analyze to fire and finish
    await waitFor(() => expect(fensCalled.length).toBe(1));
    fensCalled.length = 0; // Clear auto-analyze call

    const analyzeGameBtn = screen.getAllByRole('button', { name: /Analyze whole game/i })[0];
    await act(async () => {
      fireEvent.click(analyzeGameBtn);
    });

    // The order must start from ply 2, then ply 3, then ply 1, then start position (ply 0)!
    expect(fensCalled.length).toBe(4);
    // Move 2 FEN: 1. e4 e5
    expect(fensCalled[0]).toContain('rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq');
    // Move 3 FEN: 1. e4 e5 2. Nf3
    expect(fensCalled[1]).toContain('rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq');
    // Move 1 FEN: 1. e4
    expect(fensCalled[2]).toContain('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq');
    // Start FEN:
    expect(fensCalled[3]).toContain('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq');
  });

  it('fetches game fallback from query param when state is absent', async () => {
    get.mockResolvedValueOnce({
      game: {
        id: 99,
        pgn: '1. d4 d5',
        white: 'WhitePlayer',
        black: 'BlackPlayer',
        user_color: 'white',
      },
      analysis: null,
    });
    post.mockResolvedValue({
      fen: 'rnbqkbnr/ppp1pppp/8/3p4/3P4/8/PPP1PPPP/RNBQKBNR w KQkq - 0 2',
      depth: 12,
      lines: [],
    });

    renderLab({
      pathname: '/lab',
      search: '?game=99&ply=2',
    });

    expect(get).toHaveBeenCalledWith('/api/games/99');
    expect(await screen.findByText('WhitePlayer vs BlackPlayer')).toBeTruthy();
    expect(await screen.findByText('2 / 2')).toBeTruthy();
  });

  it('navigates through moves using next/prev buttons and arrow keys', async () => {
    post.mockResolvedValue({
      fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
      depth: 12,
      lines: [],
    });

    renderLab({
      pathname: '/lab',
      state: {
        pgn: '1. e4 e5 2. Nf3',
        ply: 2,
      },
    });

    expect(screen.getByText('2 / 3')).toBeTruthy();

    // Click Previous
    const prevBtn = screen.getByRole('button', { name: 'Previous' });
    fireEvent.click(prevBtn);
    expect(screen.getByText('1 / 3')).toBeTruthy();

    // Click Next
    const nextBtn = screen.getByRole('button', { name: 'Next' });
    fireEvent.click(nextBtn);
    expect(screen.getByText('2 / 3')).toBeTruthy();

    // Keyboard ArrowRight
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.getByText('3 / 3')).toBeTruthy();

    // Keyboard ArrowLeft
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(screen.getByText('2 / 3')).toBeTruthy();
  });
});

