// Lab — a position sandbox with on-demand Stockfish analysis. Drop a FEN,
// shuffle pieces, click Analyze, browse top-N candidate lines. Designed for
// the "what does the engine think about this?" moment after a game.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { Chess } from 'chess.js';
import type { Key } from 'chessground/types';
import {
  Microscope, RotateCcw, FlipVertical2, Wand2, Loader2, Swords,
  ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Sparkles,
} from 'lucide-react';
import ChessBoard from '../components/ChessBoard';
import EvalBar from '../components/EvalBar';
import MoveList from '../components/MoveList';
import EvalGraph from '../components/EvalGraph';
import ClassificationBadge from '../components/ClassificationBadge';
import ThreatPanel from '../components/ThreatPanel';
import ExplorerPanel from '../components/ExplorerPanel';
import { api } from '../api';
import { useAuth } from '../state/auth';
import { parseFromPosition, playFromPosition, playFromUrl } from '../lib/fromPosition';
import type { AnalysisResult, AnalyzedMove, KeyMomentSummary, PhaseSplit } from '../types';

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
  analysis?: AnalysisResult | null;
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
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(state?.analysis ?? null);
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
  // page lets you switch).
  const playFrom = useMemo(() => {
    const positions = [{ fen: startFenRef.current }, ...history.slice(0, historyIndex)];
    const from = playFromPosition(positions, historyIndex + 1);
    return from && parseFromPosition(from.fen, from.moves.join(',')) ? from : undefined;
  }, [history, historyIndex, tick]);

  const analyze = useMutation({
    mutationFn: () => api.post<AnalyzeResponse>('/api/analyze/position', { fen, depth, lines }),
  });

  function bump() { setTick((k) => k + 1); }

  // Initial cache from pre-computed analysis if available
  const initialCache = useMemo(() => {
    const cache: Record<string, AnalyzeResponse> = {};
    const moves = state?.analysis?.moves ?? state?.analysisMoves;
    if (moves) {
      for (const m of moves) {
        if (m.fen_after && (m.eval_after_cp != null || m.mate_after != null)) {
          const stm = m.fen_after.split(' ')[1];
          const lineCp = m.eval_after_cp != null ? (stm === 'w' ? m.eval_after_cp : -m.eval_after_cp) : null;
          const lineMate = m.mate_after != null ? (stm === 'w' ? m.mate_after : -m.mate_after) : null;
          cache[m.fen_after] = {
            fen: m.fen_after,
            depth: state?.analysis?.depth || 16,
            lines: m.best_move_san ? [{
              uci: m.best_move_uci ?? '',
              san: m.best_move_san,
              pv_san: m.best_pv ?? [m.best_move_san],
              cp: lineCp,
              mate: lineMate,
              multipv: 1,
            }] : [],
          };
        }
      }
    }
    return cache;
  }, []);

  const [analysisCache, setAnalysisCache] = useState<Record<string, AnalyzeResponse>>(initialCache);

  // Auto-analyze starting from the target position when game is transferred (only if not already analyzed)
  const autoAnalyzedRef = useRef(false);
  useEffect(() => {
    if (state?.pgn && !state?.analysis && !autoAnalyzedRef.current) {
      autoAnalyzedRef.current = true;
      analyze.mutate();
    }
  }, [state?.pgn, state?.analysis]);

  // Direct URL deep-link fallback: fetch game by id if not provided via location.state
  const gameLoadedRef = useRef(false);
  useEffect(() => {
    if (state?.pgn || !gameIdParam || gameLoadedRef.current) return;
    gameLoadedRef.current = true;
    api.get<{
      game: { id: number; pgn: string; white: string; black: string; user_color: 'white' | 'black' | null };
      analysis?: {
        depth: number;
        accuracy_white: number;
        accuracy_black: number;
        estimated_elo_white: number | null;
        estimated_elo_black: number | null;
        performance_white: number | null;
        performance_black: number | null;
        opening_eco: string | null;
        opening_name: string | null;
        key_moments_json: string | null;
        phase_split_json: string | null;
        moves_json: string;
      } | null;
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
            const a = data.analysis;
            const moves: AnalyzedMove[] = JSON.parse(a.moves_json);
            const fullAnalysis: AnalysisResult = {
              depth: a.depth,
              accuracy_white: a.accuracy_white,
              accuracy_black: a.accuracy_black,
              estimated_elo_white: a.estimated_elo_white,
              estimated_elo_black: a.estimated_elo_black,
              performance_white: a.performance_white ?? null,
              performance_black: a.performance_black ?? null,
              opening_eco: a.opening_eco,
              opening_name: a.opening_name,
              key_moments: a.key_moments_json ? (JSON.parse(a.key_moments_json) as KeyMomentSummary[]) : [],
              phase_split: a.phase_split_json ? (JSON.parse(a.phase_split_json) as PhaseSplit) : null,
              moves,
            };
            setAnalysis(fullAnalysis);

            const cacheEntries: Record<string, AnalyzeResponse> = {};
            for (const m of moves) {
              if (m.fen_after && (m.eval_after_cp != null || m.mate_after != null)) {
                const stm = m.fen_after.split(' ')[1];
                const lineCp = m.eval_after_cp != null ? (stm === 'w' ? m.eval_after_cp : -m.eval_after_cp) : null;
                const lineMate = m.mate_after != null ? (stm === 'w' ? m.mate_after : -m.mate_after) : null;
                cacheEntries[m.fen_after] = {
                  fen: m.fen_after,
                  depth: a.depth || 16,
                  lines: m.best_move_san ? [{
                    uci: m.best_move_uci ?? '',
                    san: m.best_move_san,
                    pv_san: m.best_pv ?? [m.best_move_san],
                    cp: lineCp,
                    mate: lineMate,
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
        if (!data.analysis?.moves_json) {
          analyze.mutate();
        }
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
        setAnalysis(null);
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
    setAnalysis(null);
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
      setAnalysis(null);
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

  // Active move & board indicators matching /review
  const currentHistoryEntry = historyIndex > 0 ? history[historyIndex - 1] : null;
  const lastMove: [Key, Key] | undefined = currentHistoryEntry
    ? [currentHistoryEntry.uci.slice(0, 2) as Key, currentHistoryEntry.uci.slice(2, 4) as Key]
    : undefined;
  const currentAnalyzedMove = historyIndex > 0
    ? analysis?.moves.find((m) => m.ply === historyIndex)
    : undefined;
  const currentDestSquare = currentHistoryEntry ? currentHistoryEntry.uci.slice(2, 4) : undefined;

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
    // If we're stepping through an analyzed game, use the authoritative review eval:
    if (historyIndex > 0 && currentAnalyzedMove) {
      return {
        evalCp: currentAnalyzedMove.eval_after_cp,
        evalMate: currentAnalyzedMove.mate_after ?? null,
      };
    }
    if (historyIndex === 0 && analysis?.moves?.[0]?.eval_before_cp != null) {
      return {
        evalCp: analysis.moves[0].eval_before_cp,
        evalMate: analysis.moves[0].mate_before ?? null,
      };
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
  }, [isCheckmate, isDraw, historyIndex, currentAnalyzedMove, analysis, topCandidate, turn]);

  const arrows = useMemo(() => {
    if (!currentAnalysis || currentAnalysis.lines.length === 0) return [];
    const best = currentAnalysis.lines[0];
    if (!best) return [];
    return [{ orig: best.uci.slice(0, 2), dest: best.uci.slice(2, 4), brush: 'paleBlue' as const }];
  }, [currentAnalysis]);

  // MoveList items
  const movesForList = useMemo(() => {
    return history.map((h, i) => {
      const ply = i + 1;
      const analyzed = analysis?.moves.find((m) => m.ply === ply);
      return {
        ply,
        san: h.san,
        classification: analyzed?.classification,
      };
    });
  }, [history, analysis]);

  // Eval graph data
  const evalsForGraph = useMemo(() => {
    if (analysis?.moves && analysis.moves.length > 0) {
      return analysis.moves.map((m) => ({ ply: m.ply, cp: m.eval_after_cp }));
    }
    if (history.length > 0) {
      const entries: { ply: number; cp: number | null }[] = [];
      let hasAny = false;
      for (let i = 0; i < history.length; i++) {
        const ply = i + 1;
        const cached = analysisCache[history[i].fen];
        const cp = cached?.lines?.[0]?.cp ?? null;
        if (cp != null) hasAny = true;
        entries.push({ ply, cp });
      }
      return hasAny ? entries : [];
    }
    return [];
  }, [analysis, history, analysisCache]);

  const markersForGraph = useMemo(() => {
    if (!analysis?.moves) return [];
    return analysis.moves
      .filter((m) => ['blunder', 'mistake', 'inaccuracy', 'miss', 'brilliant', 'great'].includes(m.classification))
      .map((m) => ({ ply: m.ply, classification: m.classification }));
  }, [analysis]);

  const boardAreaRef = useRef<HTMLElement | null>(null);
  const [boardSize, setBoardSize] = useState<number | null>(null);

  useEffect(() => {
    const el = boardAreaRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const update = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w <= 0 || h <= 0) return;
      // 18px EvalBar + 8px gap = 26px horizontal overhead
      const availW = Math.max(200, w - 26);
      const availH = Math.max(200, h);
      const s = Math.floor(Math.min(availW, availH));
      if (s > 0) setBoardSize(s);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener('resize', update);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
    };
  }, []);

  return (
    <div className="flex flex-1 flex-col gap-3 min-h-0 lg:flex-row lg:gap-4 lg:h-full lg:overflow-hidden">
      {/* BOARD PANE — Nothing above, nothing below, takes all available free space */}
      <section
        ref={boardAreaRef}
        className="flex flex-1 min-w-0 min-h-0 h-full w-full items-center justify-center overflow-hidden"
      >
        <div
          className="flex items-stretch justify-center gap-2"
          style={
            boardSize
              ? { width: boardSize + 26, height: boardSize }
              : { width: '100%', maxWidth: 'calc(100vh - 4rem)' }
          }
        >
          <EvalBar
            cp={evalCp}
            mate={evalMate}
            orientation={orientation}
            height={boardSize ?? undefined}
          />
          <div
            className={`relative aspect-square min-w-0 board-theme-${user?.profile.board_theme ?? 'green'}`}
            style={
              boardSize
                ? { width: boardSize, height: boardSize }
                : { width: '100%', flex: 1 }
            }
          >
            <ChessBoard
              key={tick === 0 ? 'init' : 'live'}
              fen={fen}
              orientation={orientation}
              turnColor={turn}
              movable
              onMove={onMove}
              lastMove={lastMove}
              arrows={arrows as never}
              size={boardSize ?? undefined}
              resetKey={tick}
            />
            {currentAnalyzedMove && currentDestSquare && (
              <ClassificationBadge
                classification={currentAnalyzedMove.classification}
                square={currentDestSquare}
                orientation={orientation}
              />
            )}
          </div>
        </div>
      </section>

      {/* CONTROLS COLUMN — All controls reside exclusively in this right column */}
      <aside className="w-full space-y-3 lg:w-[400px] xl:w-[420px] lg:shrink-0 lg:h-full lg:min-h-0 lg:overflow-y-auto lg:pr-1">
        {/* Header / Info card */}
        <div className="card p-3 sm:p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Microscope className="h-5 w-5 text-board-dark" />
              <h1 className="text-base font-bold text-chesscom-900 dark:text-chesscom-100">
                {t('lab.title', { defaultValue: 'Lab' })}
              </h1>
            </div>
            <div className="rounded-full bg-chesscom-100 px-2 py-0.5 text-xs font-medium text-chesscom-700 dark:bg-chesscom-800 dark:text-chesscom-300">
              {turn === 'white'
                ? t('lab.whiteToMove', { defaultValue: 'White to move' })
                : t('lab.blackToMove', { defaultValue: 'Black to move' })}
            </div>
          </div>
          <p className="mt-1 text-xs text-chesscom-500 truncate" title={gameTitle ?? t('lab.subtitle', { defaultValue: 'A sandbox board with Stockfish on tap.' })}>
            {gameTitle ? gameTitle : t('lab.subtitle', { defaultValue: 'A sandbox board with Stockfish on tap.' })}
          </p>
        </div>

        {/* Moves & Review Navigation card */}
        {history.length > 0 && (
          <div className="card space-y-3 p-3">
            {/* Stepper buttons matching /review */}
            <div className="flex items-center justify-between gap-1 sm:gap-2">
              <button
                onClick={() => gotoPly(0)}
                disabled={historyIndex === 0}
                aria-label={t('review.first', { defaultValue: 'First' })}
                className="btn-secondary h-9 w-9 p-0"
                title={t('review.first', { defaultValue: 'First' })}
              >
                <ChevronsLeft className="h-4 w-4" />
              </button>
              <button
                onClick={() => gotoPly(historyIndex - 1)}
                disabled={historyIndex === 0}
                aria-label={t('review.prev', { defaultValue: 'Previous' })}
                className="btn-secondary h-9 w-9 p-0"
                title={t('review.prev', { defaultValue: 'Previous' })}
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                onClick={() => gotoPly(0)}
                aria-label={t('lab.startPos', { defaultValue: 'Start' })}
                className="flex h-9 flex-1 items-center justify-center rounded-xl bg-chesscom-100 px-3 text-xs font-mono font-semibold tabular-nums hover:bg-chesscom-200 dark:bg-chesscom-800 dark:hover:bg-chesscom-700"
                title={t('lab.startPos', { defaultValue: 'Start' })}
              >
                {historyIndex === 0
                  ? t('lab.startPos', { defaultValue: 'Start' })
                  : `${historyIndex} / ${history.length}`}
              </button>
              <button
                onClick={() => gotoPly(historyIndex + 1)}
                disabled={historyIndex >= history.length}
                aria-label={t('review.next', { defaultValue: 'Next' })}
                className="btn-secondary h-9 w-9 p-0"
                title={t('review.next', { defaultValue: 'Next' })}
              >
                <ChevronRight className="h-4 w-4" />
              </button>
              <button
                onClick={() => gotoPly(history.length)}
                disabled={historyIndex >= history.length}
                aria-label={t('review.last', { defaultValue: 'Last' })}
                className="btn-secondary h-9 w-9 p-0"
                title={t('review.last', { defaultValue: 'Last' })}
              >
                <ChevronsRight className="h-4 w-4" />
              </button>
            </div>

            {/* Current move summary & eval */}
            <div className="flex items-center justify-between rounded-lg bg-chesscom-50 px-3 py-2 text-xs dark:bg-chesscom-900/60">
              <div className="min-w-0 truncate text-chesscom-500">
                {currentHistoryEntry ? (
                  <>
                    <span className="font-medium text-chesscom-900 dark:text-chesscom-100">
                      {historyIndex % 2 === 1 ? t('review.sideShort.white', { defaultValue: 'W' }) : t('review.sideShort.black', { defaultValue: 'B' })}: {currentHistoryEntry.san}
                    </span>
                    {currentAnalyzedMove?.best_move_san && currentAnalyzedMove.best_move_san !== currentHistoryEntry.san && (
                      <span className="ml-2 text-[11px] text-chesscom-400">
                        {t('review.best', { san: currentAnalyzedMove.best_move_san, defaultValue: `Best: ${currentAnalyzedMove.best_move_san}` })}
                      </span>
                    )}
                  </>
                ) : (
                  <span className="italic">{t('review.startingPosition', { defaultValue: 'Starting position' })}</span>
                )}
              </div>
              <div className="font-mono text-sm font-semibold tabular-nums">
                {formatEval(evalCp, evalMate)}
              </div>
            </div>

            {/* Eval graph if evals exist */}
            {evalsForGraph.length > 0 && (
              <div className="rounded-lg border border-chesscom-200 p-2 dark:border-chesscom-700">
                <EvalGraph
                  evals={evalsForGraph}
                  current={historyIndex}
                  onClick={(p) => gotoPly(p)}
                  markers={markersForGraph}
                  height={80}
                />
              </div>
            )}

            {/* MoveList from /review */}
            <MoveList
              moves={movesForList}
              current={historyIndex}
              onSelect={gotoPly}
              phaseSplit={analysis?.phase_split}
              maxHeight={260}
            />
          </div>
        )}

        {/* Engine Analysis card */}
        <div className="card space-y-3 p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-chesscom-500">
              {t('lab.engine', { defaultValue: 'Engine analysis' })}
            </h2>
            <div className="flex items-center gap-2">
              {history.length > 0 && (
                isAnalyzingGame ? (
                  <div className="flex items-center gap-2">
                    <span className="flex items-center gap-1.5 text-xs text-chesscom-700 dark:text-chesscom-200">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      {t('lab.analyzingGame', { defaultValue: 'Analyzing…' })}
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
                    className="btn-secondary text-xs"
                    title={t('lab.analyzeGame', { defaultValue: 'Analyze whole game' })}
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    <span>{t('lab.analyzeGame', { defaultValue: 'Analyze whole game' })}</span>
                  </button>
                )
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

          {analyze.isPending ? (
            <div className="flex items-center gap-2 py-2 text-sm text-chesscom-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('lab.crunching', { defaultValue: 'Crunching positions…' })}
            </div>
          ) : currentAnalysis && currentAnalysis.lines.length > 0 ? (
            <div className="divide-y divide-chesscom-100 rounded-lg border border-chesscom-200 dark:divide-chesscom-700 dark:border-chesscom-700">
              {currentAnalysis.lines.map((line, i) => (
                <LineRow key={i} line={line} rank={i + 1} onPlay={playLineMove} />
              ))}
              <div className="px-3 py-1.5 text-right text-[11px] text-chesscom-400">
                {t('lab.depthLabel', { defaultValue: 'depth' })} {currentAnalysis.depth}
              </div>
            </div>
          ) : analyze.isError ? (
            <div className="py-2 text-sm text-mistake">
              {t('lab.analyzeError', { defaultValue: 'Analysis failed. Is Stockfish configured?' })}
            </div>
          ) : (
            <div className="py-2 text-center text-xs text-chesscom-500">
              {t('lab.idlePrompt', { defaultValue: 'Click Analyze to see what Stockfish thinks.' })}
            </div>
          )}
        </div>

        {/* Board Tools & FEN card */}
        <div className="card space-y-3 p-3 sm:p-4">
          <div className="flex items-center gap-2">
            <input
              value={fenInput}
              onChange={(e) => setFenInput(e.target.value)}
              placeholder={t('lab.fenPlaceholder', { defaultValue: 'Paste a FEN…' })}
              className="input flex-1 font-mono text-xs"
              spellCheck={false}
            />
            <button onClick={setFromFen} className="btn-secondary text-xs">
              {t('lab.setFen', { defaultValue: 'Set' })}
            </button>
          </div>
          {fenError && <div className="text-xs text-mistake">{fenError}</div>}
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={resetBoard} className="btn-ghost text-xs">
              <RotateCcw className="h-3.5 w-3.5" />
              {t('lab.reset', { defaultValue: 'Reset' })}
            </button>
            <button onClick={flip} className="btn-ghost text-xs">
              <FlipVertical2 className="h-3.5 w-3.5" />
              {t('lab.flip', { defaultValue: 'Flip board' })}
            </button>
            <div className="ml-auto max-w-[180px] truncate font-mono text-[10px] tabular-nums text-chesscom-400" title={fen}>
              {fen}
            </div>
          </div>
          {playFrom ? (
            <Link to={playFromUrl(playFrom, orientation)} className="btn-secondary w-full text-xs">
              <Swords className="h-3.5 w-3.5" /> {t('lab.playFromHere', { defaultValue: 'Play from here against Patzer' })}
            </Link>
          ) : turn === 'black' ? (
            <div className="flex items-center text-xs text-chesscom-500">{t('lab.playFromHint')}</div>
          ) : null}
        </div>

        {/* Side Panels */}
        <ThreatPanel
          fen={fen}
          currentCpWhite={evalCp ?? 0}
        />

        <ExplorerPanel fen={fen} />
      </aside>
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
