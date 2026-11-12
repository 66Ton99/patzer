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
    const fenInput = screen.getByPlaceholderText(/Paste a FEN/i);
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

    const fenInput = screen.getByPlaceholderText(/Paste a FEN/i);
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

    const fenInput = screen.getByPlaceholderText(/Paste a FEN/i);
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

  it('renders full AnalysisResult from router state with MoveList, classification glyphs, and phase split', async () => {
    post.mockResolvedValue({
      fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3',
      depth: 16,
      lines: [],
    });

    const mockAnalysis = {
      depth: 16,
      accuracy_white: 85.5,
      accuracy_black: 78.2,
      estimated_elo_white: 1600,
      estimated_elo_black: 1550,
      performance_white: 1620,
      performance_black: 1530,
      opening_eco: 'C44',
      opening_name: "King's Knight Opening",
      key_moments: [],
      phase_split: {
        opening: { from_ply: 1, to_ply: 4 },
        middlegame: { from_ply: 5, to_ply: 10 },
      },
      moves: [
        {
          ply: 1,
          san: 'e4',
          uci: 'e2e4',
          classification: 'book',
          eval_after_cp: 20,
          fen_after: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
        },
        {
          ply: 2,
          san: 'e5',
          uci: 'e7e5',
          classification: 'best',
          eval_after_cp: 15,
          fen_after: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
        },
        {
          ply: 3,
          san: 'Nf3',
          uci: 'g1f3',
          classification: 'great',
          eval_after_cp: 30,
          best_move_san: 'Nf3',
          fen_after: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2',
        },
        {
          ply: 4,
          san: 'Nc6',
          uci: 'b8c6',
          classification: 'inaccuracy',
          eval_after_cp: 45,
          fen_after: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3',
        },
      ],
    };

    renderLab({
      pathname: '/lab',
      state: {
        pgn: '1. e4 e5 2. Nf3 Nc6',
        ply: 3,
        analysis: mockAnalysis,
      },
    });

    // MoveList has White and Black headers
    expect(screen.getByText('review.white')).toBeTruthy();
    expect(screen.getByText('review.black')).toBeTruthy();

    // Check phase split rendered in MoveList
    expect(screen.getByText('review.opening')).toBeTruthy();

    // Moves e4, e5, Nf3, Nc6 are displayed in MoveList
    expect(screen.getByRole('button', { name: 'e4' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'e5' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Nf3' })[0]).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Nc6' })).toBeTruthy();

    // Clicking move in MoveList navigates to that ply
    fireEvent.click(screen.getByRole('button', { name: 'e4' }));
    expect(screen.getByText('1 / 4')).toBeTruthy();
  });

  it('preserves stable White-perspective evaluation and mate on EvalBar when stepping through moves', async () => {
    const mockAnalysis = {
      depth: 16,
      accuracy_white: 75,
      accuracy_black: 80,
      estimated_elo_white: null,
      estimated_elo_black: null,
      performance_white: null,
      performance_black: null,
      opening_eco: null,
      opening_name: null,
      key_moments: [],
      moves: [
        {
          ply: 1,
          san: 'e4',
          uci: 'e2e4',
          eval_after_cp: 20,
          fen_after: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
          classification: 'book' as const,
          centipawn_loss: 0,
        },
        {
          ply: 2,
          san: 'e5',
          uci: 'e7e5',
          eval_after_cp: 15,
          fen_after: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
          classification: 'book' as const,
          centipawn_loss: 0,
        },
        {
          ply: 3,
          san: 'Qh5',
          uci: 'd1h5',
          eval_after_cp: -9910,
          mate_after: -9, // Black mates White in 9
          fen_after: 'rnbqkbnr/pppp1ppp/8/4p2Q/4P3/8/PPPP1PPP/RNB1KBNR b KQkq - 1 2',
          classification: 'blunder' as const,
          centipawn_loss: 800,
        },
        {
          ply: 4,
          san: 'Nc6',
          uci: 'b8c6',
          eval_after_cp: -9910,
          mate_after: -9, // Black still mates White in 9
          fen_after: 'r1bqkbnr/pppp1ppp/2n5/4p2Q/4P3/8/PPPP1PPP/RNB1KBNR w KQkq - 2 3',
          classification: 'best' as const,
          centipawn_loss: 0,
        },
      ],
    };

    renderLab({
      pathname: '/lab',
      state: {
        pgn: '1. e4 e5 2. Qh5 Nc6',
        ply: 3,
        analysis: mockAnalysis,
        userColor: 'black',
      },
    });

    // At ply 3 (White played Qh5, Black is winning with mate in 9):
    // EvalBar should show M9 for Black (and chip in dark styling)
    expect(screen.getByText('M9')).toBeTruthy();

    // Step forward to ply 4 (Black played Nc6):
    const nextBtn = screen.getByRole('button', { name: 'Next' });
    fireEvent.click(nextBtn);
    expect(screen.getByText('4 / 4')).toBeTruthy();

    // EvalBar should still show M9 for Black, NOT flip to White advantage!
    expect(screen.getByText('M9')).toBeTruthy();

    // Step back to ply 2:
    const prevBtn = screen.getByRole('button', { name: 'Previous' });
    fireEvent.click(prevBtn); // to ply 3
    fireEvent.click(prevBtn); // to ply 2
    expect(screen.getByText('2 / 4')).toBeTruthy();
    expect(screen.getByText('+0.1')).toBeTruthy();

    // Step back to ply 1:
    fireEvent.click(prevBtn);
    expect(screen.getByText('1 / 4')).toBeTruthy();
    expect(screen.getByText('+0.2')).toBeTruthy();
  });

  it('renders "Analyze to the end" button when FEN is loaded and plays out best moves', async () => {
    post.mockResolvedValueOnce({
      fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3',
      depth: 12,
      lines: [{ uci: 'f1b5', san: 'Bb5', pv_san: ['Bb5', 'a6'], cp: 25, mate: null, multipv: 1 }],
    });

    renderLab('/lab');

    // Button "Analyze to the end" is present and enabled
    const analyzeToEndBtn = screen.getByRole('button', { name: /Analyze to the end/i }) as HTMLButtonElement;
    expect(analyzeToEndBtn).toBeTruthy();
    expect(analyzeToEndBtn.disabled).toBe(false);

    // Setting a FEN
    const input = screen.getByPlaceholderText(/Paste a FEN or PGN/i);
    const setBtn = screen.getByRole('button', { name: 'Set' });
    fireEvent.change(input, {
      target: { value: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3' },
    });
    fireEvent.click(setBtn);

    // Still enabled
    expect(analyzeToEndBtn.disabled).toBe(false);

    // Click "Analyze to the end"
    await act(async () => {
      fireEvent.click(analyzeToEndBtn);
    });

    // Should call engine and play Bb5
    expect(post).toHaveBeenCalledWith('/api/analyze/position', expect.objectContaining({
      fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3',
    }));

    // History now contains the move Bb5
    expect(screen.getByRole('button', { name: 'Bb5' })).toBeTruthy();
  });

  it('supports pasting PGN into the input to load game moves and enables both whole game and to the end analysis', async () => {
    renderLab('/lab');

    const input = screen.getByPlaceholderText(/Paste a FEN or PGN/i);
    const setBtn = screen.getByRole('button', { name: 'Set' });

    // Paste a PGN string
    fireEvent.change(input, {
      target: { value: '[White "Magnus"]\n[Black "Hikaru"]\n1. e4 e5 2. Nf3 Nc6' },
    });
    fireEvent.click(setBtn);

    // Moves and title should now be loaded
    expect(screen.getByText('Magnus vs Hikaru')).toBeTruthy();
    expect(screen.getByText('4 / 4')).toBeTruthy();

    const analyzeGameBtn = screen.getByRole('button', { name: /Analyze whole game/i }) as HTMLButtonElement;
    expect(analyzeGameBtn.disabled).toBe(false);

    const toEndBtn = screen.getByRole('button', { name: /To the end/i }) as HTMLButtonElement;
    expect(toEndBtn.disabled).toBe(false);
  });
});

