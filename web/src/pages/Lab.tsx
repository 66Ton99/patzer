// Lab — a position sandbox with on-demand Stockfish analysis. Drop a FEN,
// shuffle pieces, click Analyze, browse top-N candidate lines. Designed for
// the "what does the engine think about this?" moment after a game.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { Chess } from 'chess.js';
import {
  Microscope, RotateCcw, FlipVertical2, Wand2, Loader2, Swords,
  ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Sparkles,
} from 'lucide-react';
import ChessBoard from '../components/ChessBoard';
import EvalBar from '../components/EvalBar';
import ThreatPanel from '../components/ThreatPanel';
import ExplorerPanel from '../components/ExplorerPanel';
import { api } from '../api';
import { useAuth } from '../state/auth';
import { parseFromPosition, playFromPosition, playFromUrl } from '../lib/fromPosition';
import type { AnalyzedMove } from '../types';

function safeDecodeFen(raw: string): string {
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    try {
      return decodeURI(raw);
    } catch {
      return raw;
    }
  }
}

interface AnalyzeLine {
  uci: string;
  san: string;
  pv_san: string[];
  cp: number | null;
  mate: number | null;
  multipv: number;
}

interface AnalyzeResponse {
  fen: string;
  depth: number;
  lines: AnalyzeLine[];
}

interface HistoryEntry {
  fen: string;       // FEN AFTER this move
  san: string;       // the move played to reach this fen
  uci: string;       // the same move as UCI
}

interface LocationState {
  pgn?: string;
  gameId?: number;
  ply?: number;
  userColor?: 'white' | 'black' | null;
  gameTitle?: string;
  analysisMoves?: AnalyzedMove[];
}

function parseGamePgn(pgn: string): { startFen: string; history: HistoryEntry[] } {
  try {
    const chess = new Chess();
    chess.loadPgn(pgn, { strict: false });
    const hist = chess.history({ verbose: true });
    const headers = chess.getHeaders();
    const startFen = headers.SetUp === '1' && headers.FEN ? headers.FEN : new Chess().fen();
    const replay = new Chess(startFen, { skipValidation: true });
    const historyEntries: HistoryEntry[] = [];
    for (const m of hist) {
      replay.move({ from: m.from, to: m.to, promotion: m.promotion });
      historyEntries.push({
        fen: replay.fen(),
        san: m.san,
        uci: m.from + m.to + (m.promotion ?? ''),
      });
    }
    return { startFen, history: historyEntries };
  } catch {
    return { startFen: new Chess().fen(), history: [] };
  }
}

export default function Lab() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const location = useLocation();
  const state = (location.state as LocationState | undefined) ?? undefined;
  const searchParams = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const gameIdParam = searchParams.get('game');
  const plyParam = searchParams.get('ply');

  // If a game is passed via state, initialize immediately on mount
  const initialGame = useMemo(() => {
    if (!state?.pgn) return null;
    const { startFen, history: entries } = parseGamePgn(state.pgn);
    const targetPly = state.ply != null ? Math.max(0, Math.min(entries.length, state.ply)) : entries.length;
    const targetFen = targetPly === 0 ? startFen : entries[targetPly - 1].fen;
    return {
      startFen,
      history: entries,
      targetPly,
      targetFen,
      userColor: state.userColor,
      gameTitle: state.gameTitle,
    };
  }, []);

  // Get the FEN from initial game, hash (#fen) or query (?fen=)
  const hash = location.hash ? location.hash.slice(1) : (typeof window !== 'undefined' ? window.location.hash.slice(1) : '');
  const searchFen = searchParams.get('fen');
  const initialFen = initialGame ? initialGame.targetFen : safeDecodeFen(hash || searchFen || '');

  // instantiate a proper chess object to be referenced later, we skip validation for preloaded FENs
  // as this often used to just manipulate a position, anarchy-chess style.
  const chess = initialFen ? new Chess(initialFen, { skipValidation: true }) : new Chess();

  // Authoritative game state lives in a ref to avoid stale closures.
  const chessRef = useRef<Chess>(chess);
  // Where the move list starts: the FEN you set, or the normal start.
  const startFenRef = useRef(initialGame ? initialGame.startFen : chess.fen());

  // Counter forces re-renders / ChessBoard re-sync since chess.js mutates.
  const [tick, setTick] = useState(0);
  const [history, setHistory] = useState<HistoryEntry[]>(initialGame ? initialGame.history : []);
  const [historyIndex, setHistoryIndex] = useState(initialGame ? initialGame.targetPly : 0); // 0 = start; N = after Nth move

  const [orientation, setOrientation] = useState<'white' | 'black'>(
    initialGame?.userColor === 'black' ? 'black' : 'white'
  );
  const [gameTitle, setGameTitle] = useState<string | null>(initialGame?.gameTitle ?? null);
  const [fenInput, setFenInput] = useState(initialFen);
  const [fenError, setFenError] = useState<string | null>(null);

  const [depth, setDepth] = useState(12);
  const [lines, setLines] = useState(5);

  const [isAnalyzingGame, setIsAnalyzingGame] = useState(false);
  const [gameAnalysisProgress, setGameAnalysisProgress] = useState<{ current: number; total: number; ply: number } | null>(null);
  const abortAnalysisRef = useRef(false);

  const fen = chessRef.current.fen();
  const turn = chessRef.current.turn() === 'w' ? 'white' : 'black';

  // "Play from here": you play the side at the bottom of the board (the Play
  // page lets you switch). A game from a position starts with white to move
  // (server/src/chess/startFen.ts), so with black to move it starts one move
  // earlier and replays the move you made here — when there is one.
  const playFrom = useMemo(() => {
    const positions = [{ fen: startFenRef.current }, ...history.slice(0, historyIndex)];
    const from = playFromPosition(positions, historyIndex + 1);
    // The Lab also takes made-up positions; only a legal, unfinished one plays.
    return from && parseFromPosition(from.fen, from.moves.join(',')) ? from : undefined;
  }, [history, historyIndex, tick]);

  const analyze = useMutation({
    mutationFn: () => api.post<AnalyzeResponse>('/api/analyze/position', { fen, depth, lines }),
  });

  function bump() { setTick((k) => k + 1); }

  // Initial cache from pre-computed analysis if available
  const initialCache = useMemo(() => {
    const cache: Record<string, AnalyzeResponse> = {};
    if (state?.analysisMoves) {
      for (const m of state.analysisMoves) {
        if (m.fen_after && (m.eval_after_cp != null || m.mate_after != null)) {
          cache[m.fen_after] = {
            fen: m.fen_after,
            depth: 16,
            lines: m.best_move_san ? [{
              uci: m.best_move_uci ?? '',
              san: m.best_move_san,
              pv_san: m.best_pv ?? [m.best_move_san],
              cp: m.eval_after_cp,
              mate: m.mate_after ?? null,
              multipv: 1,
            }] : [],
          };
        }
      }
    }
    return cache;
  }, []);

  const [analysisCache, setAnalysisCache] = useState<Record<string, AnalyzeResponse>>(initialCache);

  // Auto-analyze starting from the target position when game is transferred
  const autoAnalyzedRef = useRef(false);
  useEffect(() => {
    if (state?.pgn && !autoAnalyzedRef.current) {
      autoAnalyzedRef.current = true;
      analyze.mutate();
    }
  }, [state?.pgn]);

  // Direct URL deep-link fallback: fetch game by id if not provided via location.state
  const gameLoadedRef = useRef(false);
  useEffect(() => {
    if (state?.pgn || !gameIdParam || gameLoadedRef.current) return;
    gameLoadedRef.current = true;
    api.get<{
      game: { id: number; pgn: string; white: string; black: string; user_color: 'white' | 'black' | null };
      analysis?: { depth: number; moves_json: string } | null;
    }>(`/api/games/${gameIdParam}`)
      .then((data) => {
        if (!data?.game?.pgn) return;
        const { startFen, history: entries } = parseGamePgn(data.game.pgn);
        const target = plyParam ? Number(plyParam) : entries.length;
        const clamped = Math.max(0, Math.min(entries.length, Number.isFinite(target) ? target : entries.length));
        const targetFen = clamped === 0 ? startFen : entries[clamped - 1].fen;

        startFenRef.current = startFen;
        chessRef.current = new Chess(targetFen, { skipValidation: true });
        setHistory(entries);
        setHistoryIndex(clamped);
        setFenInput(targetFen);
        setGameTitle(`${data.game.white} vs ${data.game.black}`);
        if (data.game.user_color) setOrientation(data.game.user_color);

        if (data.analysis?.moves_json) {
          try {
            const moves: AnalyzedMove[] = JSON.parse(data.analysis.moves_json);
            const cacheEntries: Record<string, AnalyzeResponse> = {};
            for (const m of moves) {
              if (m.fen_after && (m.eval_after_cp != null || m.mate_after != null)) {
                cacheEntries[m.fen_after] = {
                  fen: m.fen_after,
                  depth: data.analysis.depth || 16,
                  lines: m.best_move_san ? [{
                    uci: m.best_move_uci ?? '',
                    san: m.best_move_san,
                    pv_san: m.best_pv ?? [m.best_move_san],
                    cp: m.eval_after_cp,
                    mate: m.mate_after ?? null,
                    multipv: 1,
                  }] : [],
                };
              }
            }
            setAnalysisCache((prev) => ({ ...cacheEntries, ...prev }));
          } catch {
            // ignore JSON error
          }
        }
        bump();
        analyze.mutate();
      })
      .catch(() => {
        // ignore fetch error
      });
  }, [gameIdParam, plyParam, state?.pgn]);

  useEffect(() => {
    const raw = location.hash ? location.hash.slice(1) : (typeof window !== 'undefined' ? window.location.hash.slice(1) : '');
    const decoded = safeDecodeFen(raw || new URLSearchParams(location.search).get('fen') || '');
    if (decoded && decoded !== startFenRef.current && !state?.pgn && !gameIdParam) {
      try {
        const next = new Chess(decoded, { skipValidation: true });
        chessRef.current = next;
        startFenRef.current = next.fen();
        setHistory([]);
        setHistoryIndex(0);
        setFenInput(decoded);
        setFenError(null);
        bump();
      } catch {
        // ignore invalid
      }
    }
  }, [location.hash, location.search, state?.pgn, gameIdParam]);

  function onMove(uci: string) {
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length === 5 ? uci[4] : undefined;
    try {
      const move = chessRef.current.move({ from, to, promotion } as never);
      if (!move) return;
      // If we're not at the tip, truncate forward history first.
      setHistory((prev) => {
        const trimmed = prev.slice(0, historyIndex);
        return [...trimmed, { fen: chessRef.current.fen(), san: move.san, uci: move.from + move.to + (move.promotion ?? '') }];
      });
      setHistoryIndex((i) => i + 1);
      setFenInput(chessRef.current.fen());
      bump();
    } catch {
      // illegal — chessground will reject via legalDests; ignore
      bump();
    }
  }

  function resetBoard() {
    chessRef.current = new Chess();
    startFenRef.current = chessRef.current.fen();
    setHistory([]);
    setHistoryIndex(0);
    setGameTitle(null);
    analyze.reset();
    bump();
  }

  function flip() {
    setOrientation((o) => (o === 'white' ? 'black' : 'white'));
  }

  function setFromFen() {
    const trimmed = fenInput.trim();
    if (!trimmed) return;
    try {
      const test = new Chess(trimmed);
      chessRef.current = test;
      startFenRef.current = test.fen();
      setHistory([]);
      setHistoryIndex(0);
      setGameTitle(null);
      analyze.reset();
      setFenError(null);
      bump();
    } catch (e) {
      setFenError(e instanceof Error ? e.message : t('lab.invalidFen', { defaultValue: 'Invalid FEN' }));
    }
  }

  function gotoPly(index: number) {
    const clamped = Math.max(0, Math.min(history.length, index));
    const targetFen = clamped === 0 ? startFenRef.current : history[clamped - 1].fen;
    const replay = new Chess(targetFen, { skipValidation: true });
    chessRef.current = replay;
    setHistoryIndex(clamped);
    setFenInput(targetFen);
    analyze.reset();
    bump();
  }

  function playLineMove(uci: string) {
    onMove(uci);
  }

  async function startAnalyzeGame() {
    if (history.length === 0 || isAnalyzingGame) return;
    setIsAnalyzingGame(true);
    abortAnalysisRef.current = false;

    // Collect all positions in game: 0 = start, 1..N = after each move
    const positionsList: { index: number; fen: string }[] = [
      { index: 0, fen: startFenRef.current },
      ...history.map((h, i) => ({ index: i + 1, fen: h.fen })),
    ];

    // Begin from current position (historyIndex), then forward to end, then backward:
    const startIdx = historyIndex;
    const orderIndices: number[] = [startIdx];
    for (let i = startIdx + 1; i < positionsList.length; i++) {
      orderIndices.push(i);
    }
    for (let i = startIdx - 1; i >= 0; i--) {
      orderIndices.push(i);
    }

    const totalCount = orderIndices.length;
    let processedCount = 0;
    setGameAnalysisProgress({ current: 0, total: totalCount, ply: startIdx });

    try {
      for (const idx of orderIndices) {
        if (abortAnalysisRef.current) break;

        const target = positionsList[idx];
        if (!target) continue;

        setGameAnalysisProgress({ current: processedCount + 1, total: totalCount, ply: idx });

        // Skip if already in cache with >= depth and lines
        const existing = analysisCache[target.fen];
        if (existing && existing.depth >= depth && existing.lines.length >= lines) {
          processedCount++;
          continue;
        }

        let attempts = 0;
        let success = false;
        while (attempts < 3 && !success && !abortAnalysisRef.current) {
          try {
            attempts++;
            const res = await api.post<AnalyzeResponse>('/api/analyze/position', {
              fen: target.fen,
              depth,
              lines,
            });
            setAnalysisCache((prev) => ({ ...prev, [res.fen]: res }));
            success = true;
          } catch (err: unknown) {
            const maybeStatus = (err as { status?: number })?.status;
            const maybeMsg = (err as { message?: string })?.message;
            if (maybeStatus === 429 || (maybeMsg && maybeMsg.includes('already_analyzing'))) {
              await new Promise((r) => setTimeout(r, 250));
            } else {
              break;
            }
          }
        }
        processedCount++;
      }
    } finally {
      setIsAnalyzingGame(false);
      setGameAnalysisProgress(null);
    }
  }

  function stopAnalyzeGame() {
    abortAnalysisRef.current = true;
    setIsAnalyzingGame(false);
    setGameAnalysisProgress(null);
  }

  useEffect(() => {
    return () => {
      abortAnalysisRef.current = true;
    };
  }, []);

  // Keyboard navigation through moves
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (history.length === 0) return;

      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        gotoPly(historyIndex - 1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        gotoPly(historyIndex + 1);
      } else if (e.key === 'Home') {
        e.preventDefault();
        gotoPly(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        gotoPly(history.length);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [history.length, historyIndex, history]);

  const result = analyze.data;

  useEffect(() => {
    if (result && result.fen) {
      setAnalysisCache((prev) => ({ ...prev, [result.fen]: result }));
    }
  }, [result]);

  const currentAnalysis = (result && result.fen === fen) ? result : (analysisCache[fen] ?? null);
  const isCheckmate = chessRef.current.isCheckmate();
  const isDraw = chessRef.current.isDraw();
  const topCandidate = currentAnalysis?.lines?.[0] ?? null;

  const { evalCp, evalMate } = useMemo(() => {
    if (isCheckmate) {
      return {
        evalCp: turn === 'white' ? -10000 : 10000,
        evalMate: turn === 'white' ? -1 : 1,
      };
    }
    if (isDraw) {
      return { evalCp: 0, evalMate: null };
    }
    if (!topCandidate) {
      return { evalCp: null, evalMate: null };
    }
    const mate = topCandidate.mate;
    const cp = topCandidate.cp;
    return {
      evalCp: cp != null
        ? (turn === 'white' ? cp : -cp)
        : (mate != null ? (mate > 0 ? (turn === 'white' ? 10000 : -10000) : (turn === 'white' ? -10000 : 10000)) : null),
      evalMate: mate != null ? (turn === 'white' ? mate : -mate) : null,
    };
  }, [isCheckmate, isDraw, topCandidate, turn]);

  const arrows = useMemo(() => {
    if (!currentAnalysis || currentAnalysis.lines.length === 0) return [];
    const best = currentAnalysis.lines[0];
    if (!best) return [];
    return [{ orig: best.uci.slice(0, 2), dest: best.uci.slice(2, 4), brush: 'paleBlue' as const }];
  }, [currentAnalysis]);

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="page-h1 flex items-center gap-2">
            <Microscope className="h-6 w-6 text-board-dark" />
            {t('lab.title', { defaultValue: 'Lab' })}
          </h1>
          <p className="page-sub">
            {gameTitle ? gameTitle : t('lab.subtitle', { defaultValue: 'A sandbox board with Stockfish on tap.' })}
          </p>
        </div>
        <div className="text-xs text-chesscom-500">
          {turn === 'white'
            ? t('lab.whiteToMove', { defaultValue: 'White to move' })
            : t('lab.blackToMove', { defaultValue: 'Black to move' })}
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        {/* Board pane */}
        <section className="space-y-3">
          <div className="mx-auto flex w-full max-w-[calc(640px+26px)] items-stretch justify-center gap-2">
            <EvalBar
              cp={evalCp}
              mate={evalMate}
              orientation={orientation}
            />
            <div
              className={`relative aspect-square w-full max-w-[640px] min-w-0 board-theme-${user?.profile.board_theme ?? 'green'}`}
            >
              <ChessBoard
                key={tick === 0 ? 'init' : 'live'}
                fen={fen}
                orientation={orientation}
                turnColor={turn}
                movable
                onMove={onMove}
                arrows={arrows as never}
                resetKey={tick}
              />
            </div>
          </div>

          <div className="card space-y-2 p-3">
            {/* Game Navigation Controls */}
            {history.length > 0 && (
              <div className="flex items-center justify-between gap-1 rounded-lg border border-chesscom-200 bg-chesscom-50/50 p-1.5 dark:border-chesscom-700 dark:bg-chesscom-900/40">
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => gotoPly(0)}
                    disabled={historyIndex === 0}
                    className="btn-ghost h-8 w-8 p-0"
                    title={t('review.first', { defaultValue: 'First' })}
                  >
                    <ChevronsLeft className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => gotoPly(historyIndex - 1)}
                    disabled={historyIndex === 0}
                    className="btn-ghost h-8 w-8 p-0"
                    title={t('review.prev', { defaultValue: 'Previous' })}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                </div>
                <div className="text-center font-mono text-xs font-semibold tabular-nums text-chesscom-800 dark:text-chesscom-100">
                  {historyIndex === 0
                    ? t('lab.startPos', { defaultValue: 'Start' })
                    : `${historyIndex} / ${history.length}`}
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => gotoPly(historyIndex + 1)}
                    disabled={historyIndex >= history.length}
                    className="btn-ghost h-8 w-8 p-0"
                    title={t('review.next', { defaultValue: 'Next' })}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => gotoPly(history.length)}
                    disabled={historyIndex >= history.length}
                    className="btn-ghost h-8 w-8 p-0"
                    title={t('review.last', { defaultValue: 'Last' })}
                  >
                    <ChevronsRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
            )}

            <div className="flex items-center gap-2">
              <input
                value={fenInput}
                onChange={(e) => setFenInput(e.target.value)}
                placeholder={t('lab.fenPlaceholder', { defaultValue: 'Paste a FEN…' })}
                className="input flex-1 font-mono text-xs"
                spellCheck={false}
              />
              <button onClick={setFromFen} className="btn-secondary text-sm">
                {t('lab.setFen', { defaultValue: 'Set' })}
              </button>
            </div>
            {fenError && <div className="text-xs text-mistake">{fenError}</div>}
            <div className="flex flex-wrap items-center gap-2">
              <button onClick={resetBoard} className="btn-ghost text-sm">
                <RotateCcw className="h-4 w-4" />
                {t('lab.reset', { defaultValue: 'Reset' })}
              </button>
              <button onClick={flip} className="btn-ghost text-sm">
                <FlipVertical2 className="h-4 w-4" />
                {t('lab.flip', { defaultValue: 'Flip board' })}
              </button>
              <div className="ml-auto font-mono text-[11px] tabular-nums text-chesscom-400">
                {fen}
              </div>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <button
                onClick={() => analyze.mutate()}
                disabled={analyze.isPending || isAnalyzingGame}
                className="btn-primary flex-1 text-sm"
              >
                {analyze.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
                {analyze.isPending
                  ? t('lab.analyzing', { defaultValue: 'Analyzing…' })
                  : t('lab.analyze', { defaultValue: 'Analyze' })}
              </button>
              {history.length > 0 && (
                isAnalyzingGame ? (
                  <div className="flex flex-1 items-center justify-between gap-2 rounded-md bg-chesscom-100 px-3 py-1.5 dark:bg-chesscom-800">
                    <span className="flex items-center gap-1.5 text-xs font-medium text-chesscom-700 dark:text-chesscom-200">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      {t('lab.analyzingGame', { defaultValue: 'Analyzing game…' })}
                      {gameAnalysisProgress && (
                        <span className="font-mono tabular-nums">
                          ({gameAnalysisProgress.current}/{gameAnalysisProgress.total})
                        </span>
                      )}
                    </span>
                    <button
                      onClick={stopAnalyzeGame}
                      className="text-xs font-semibold text-mistake hover:underline"
                    >
                      {t('lab.stopAnalysis', { defaultValue: 'Stop' })}
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={startAnalyzeGame}
                    disabled={analyze.isPending}
                    className="btn-secondary flex-1 text-sm"
                  >
                    <Sparkles className="h-4 w-4" />
                    {t('lab.analyzeGame', { defaultValue: 'Analyze whole game' })}
                  </button>
                )
              )}
              {playFrom ? (
                <Link to={playFromUrl(playFrom, orientation)} className="btn-secondary flex-1 text-sm">
                  <Swords className="h-4 w-4" /> {t('lab.playFromHere', { defaultValue: 'Play from here against Patzer' })}
                </Link>
              ) : turn === 'black' ? (
                <div className="flex flex-1 items-center text-xs text-chesscom-500">{t('lab.playFromHint')}</div>
              ) : null}
            </div>
          </div>
        </section>

        {/* Analysis pane */}
        <aside className="space-y-3">
          <div className="card p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-chesscom-500">
                {t('lab.engine', { defaultValue: 'Engine analysis' })}
              </h2>
              <div className="flex items-center gap-2">
                {history.length > 0 && !isAnalyzingGame && (
                  <button
                    onClick={startAnalyzeGame}
                    disabled={analyze.isPending}
                    className="btn-ghost text-xs"
                    title={t('lab.analyzeGame', { defaultValue: 'Analyze whole game' })}
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">{t('lab.analyzeGame', { defaultValue: 'Analyze whole game' })}</span>
                  </button>
                )}
                <button
                  onClick={() => analyze.mutate()}
                  disabled={analyze.isPending || isAnalyzingGame}
                  className="btn-primary text-sm"
                >
                  {analyze.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
                  {analyze.isPending
                    ? t('lab.analyzing', { defaultValue: 'Analyzing…' })
                    : t('lab.analyze', { defaultValue: 'Analyze' })}
                </button>
              </div>
            </div>

            <div className="space-y-3">
              <Slider
                label={t('lab.depth', { defaultValue: 'Depth' })}
                value={depth}
                min={8}
                max={22}
                onChange={setDepth}
              />
              <Slider
                label={t('lab.lines', { defaultValue: 'Lines' })}
                value={lines}
                min={1}
                max={5}
                onChange={setLines}
              />
            </div>
          </div>

          {analyze.isPending ? (
            <div className="card flex items-center gap-2 p-4 text-sm text-chesscom-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('lab.crunching', { defaultValue: 'Crunching positions…' })}
            </div>
          ) : currentAnalysis && currentAnalysis.lines.length > 0 ? (
            <div className="card divide-y divide-chesscom-100 dark:divide-chesscom-700">
              {currentAnalysis.lines.map((line, i) => (
                <LineRow key={i} line={line} rank={i + 1} onPlay={playLineMove} />
              ))}
              <div className="px-3 py-1.5 text-right text-[11px] text-chesscom-400">
                {t('lab.depthLabel', { defaultValue: 'depth' })} {currentAnalysis.depth}
              </div>
            </div>
          ) : analyze.isError ? (
            <div className="card p-4 text-sm text-mistake">
              {t('lab.analyzeError', { defaultValue: 'Analysis failed. Is Stockfish configured?' })}
            </div>
          ) : (
            <div className="card p-4 text-center text-sm text-chesscom-500">
              {t('lab.idlePrompt', { defaultValue: 'Click Analyze to see what Stockfish thinks.' })}
            </div>
          )}

          <ThreatPanel
            fen={fen}
            currentCpWhite={evalCp ?? 0}
          />

          <ExplorerPanel fen={fen} />

          {history.length > 0 && (
            <div className="card overflow-hidden">
              <div className="flex items-center justify-between border-b border-chesscom-200 px-3 py-2 dark:border-chesscom-700">
                <div className="flex items-center gap-2">
                  <h2 className="text-xs font-semibold uppercase tracking-wider text-chesscom-500">
                    {t('lab.moves', { defaultValue: 'Moves' })}
                  </h2>
                  <span className="text-[11px] text-chesscom-400">{history.length}</span>
                </div>
                {isAnalyzingGame ? (
                  <button
                    onClick={stopAnalyzeGame}
                    className="text-xs font-medium text-mistake hover:underline"
                  >
                    {t('lab.stopAnalysis', { defaultValue: 'Stop' })}
                  </button>
                ) : (
                  <button
                    onClick={startAnalyzeGame}
                    disabled={analyze.isPending}
                    className="flex items-center gap-1 text-[11px] text-board-dark hover:underline"
                  >
                    <Sparkles className="h-3 w-3" />
                    {t('lab.analyzeGame', { defaultValue: 'Analyze whole game' })}
                  </button>
                )}
              </div>
              <div className="max-h-60 overflow-y-auto p-2">
                <button
                  onClick={() => gotoPly(0)}
                  aria-label={t('lab.startPos', { defaultValue: 'Start' })}
                  className={`flex items-center justify-between w-full rounded px-2 py-1 text-left text-xs font-mono tabular-nums ${
                    historyIndex === 0
                      ? 'bg-gold-500/15 text-chesscom-900 dark:text-chesscom-100 font-semibold'
                      : 'text-chesscom-500 hover:bg-chesscom-100/60 dark:hover:bg-chesscom-700/40'
                  }`}
                >
                  <span>{t('lab.startPos', { defaultValue: 'Start' })}</span>
                  {analysisCache[startFenRef.current]?.lines?.[0] && (
                    <span className="text-[11px] text-chesscom-400 font-normal">
                      {formatEval(analysisCache[startFenRef.current].lines[0].cp, analysisCache[startFenRef.current].lines[0].mate)}
                    </span>
                  )}
                </button>
                {history.map((h, i) => {
                  const ply = i + 1;
                  const moveNum = Math.ceil(ply / 2);
                  const label = ply % 2 === 1 ? `${moveNum}. ${h.san}` : `${moveNum}… ${h.san}`;
                  const isActive = historyIndex === ply;
                  const cachedEval = analysisCache[h.fen];
                  const line = cachedEval?.lines?.[0];
                  const evalStr = line ? formatEval(line.cp, line.mate) : null;
                  return (
                    <button
                      key={i}
                      onClick={() => gotoPly(ply)}
                      aria-label={label}
                      className={`flex items-center justify-between w-full rounded px-2 py-1 text-left text-xs font-mono tabular-nums ${
                        isActive
                          ? 'bg-gold-500/15 text-chesscom-900 dark:text-chesscom-100 font-semibold'
                          : 'text-chesscom-600 hover:bg-chesscom-100/60 dark:text-chesscom-200 dark:hover:bg-chesscom-700/40'
                      }`}
                    >
                      <span>{label}</span>
                      {evalStr && (
                        <span className="text-[11px] text-chesscom-400 font-normal">{evalStr}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function LineRow({ line, rank, onPlay }: { line: AnalyzeLine; rank: number; onPlay: (uci: string) => void }) {
  const evalLabel = formatEval(line.cp, line.mate);
  const evalTone =
    line.mate != null
      ? line.mate > 0
        ? 'text-board-dark'
        : 'text-mistake'
      : (line.cp ?? 0) >= 30
      ? 'text-board-dark'
      : (line.cp ?? 0) <= -30
      ? 'text-mistake'
      : 'text-chesscom-700 dark:text-chesscom-200';

  const tail = line.pv_san.slice(1);

  return (
    <div className="flex items-start gap-2 px-3 py-2 text-xs">
      <span className="mt-0.5 font-mono text-[11px] tabular-nums text-chesscom-400">{rank}.</span>
      <span className={`mt-0.5 w-12 shrink-0 font-mono text-xs tabular-nums ${evalTone}`}>
        {evalLabel}
      </span>
      <div className="min-w-0 flex-1">
        <button
          onClick={() => onPlay(line.uci)}
          className="rounded bg-chesscom-100 px-1.5 py-0.5 font-mono text-xs font-semibold text-chesscom-900 hover:bg-gold-500/20 dark:bg-chesscom-700 dark:text-chesscom-100"
          title={line.uci}
        >
          {line.san}
        </button>
        {tail.length > 0 && (
          <span className="ml-2 font-mono text-xs tabular-nums text-chesscom-500">
            {tail.join(' ')}
          </span>
        )}
      </div>
    </div>
  );
}

function Slider({ label, value, min, max, onChange }: {
  label: string; value: number; min: number; max: number; onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-xs">
        <span className="text-chesscom-500">{label}</span>
        <span className="font-mono tabular-nums text-chesscom-700 dark:text-chesscom-200">{value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-board-dark"
      />
    </div>
  );
}

function formatEval(cp: number | null, mate: number | null): string {
  if (mate != null) return mate > 0 ? `#${mate}` : `#${mate}`;
  if (cp == null) return '—';
  const pawns = cp / 100;
  const sign = pawns > 0 ? '+' : pawns < 0 ? '' : '';
  return `${sign}${pawns.toFixed(2)}`;
}
