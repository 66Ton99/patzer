// WoodpeckerTrainer — solving interface for an active Woodpecker cycle.
// Handles Chessground board, dual clocks (per-puzzle and cumulative cycle timer),
// Strict Mode vs Practice Mode feedback, and accessible anti-cheating pause overlay.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Check, Clock, EyeOff, Pause, Play, RotateCcw, Trophy, X, Zap } from 'lucide-react';
import ChessBoard from './ChessBoard';
import { api } from '../api';
import { useAuth } from '../state/auth';
import { soundForMove, inferMoveFlagsFromSan } from '../lib/sounds';
import {
  formatDurationSec,
  wpIsPlayerTurnAtIndex,
  wpIsRightMove,
  wpPlayerOf,
  wpPositionAt,
  wpSanAt,
  type WoodpeckerPuzzle,
} from '../lib/woodpecker';

interface NextResponse {
  is_cycle_finished: boolean;
  puzzle: WoodpeckerPuzzle | null;
  progress: {
    current_index: number;
    total: number;
    cycle_number: number;
    cycle_time_spent_sec: number;
    target_duration_sec: number | null;
    mode: 'strict' | 'practice';
  };
}

interface AttemptResponse {
  recorded: boolean;
  cycle_completed: boolean;
  program_completed: boolean;
  next_cycle_number: number | null;
  rest_until: string | null;
  elapsed_ms: number;
}

export default function WoodpeckerTrainer({
  programId,
  programTitle,
  initialPaused = false,
  onBack,
  onCycleFinished,
}: {
  programId: number;
  programTitle: string;
  initialPaused?: boolean;
  onBack: () => void;
  onCycleFinished: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [stepKey, setStepKey] = useState(0);
  const [paused, setPaused] = useState(initialPaused);
  const resumeBtnRef = useRef<HTMLButtonElement | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['woodpecker-next', programId, stepKey],
    queryFn: () => api.get<NextResponse>(`/api/woodpecker/programs/${programId}/next`),
    enabled: !paused,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });

  async function triggerPause() {
    if (paused) return;
    setPaused(true);
    try {
      await api.post(`/api/woodpecker/programs/${programId}/pause`, {});
      void qc.invalidateQueries({ queryKey: ['woodpecker-programs'] });
    } catch {
      /* ignore if already paused */
    }
  }

  async function triggerResume() {
    if (!paused) return;
    try {
      await api.post(`/api/woodpecker/programs/${programId}/resume`, {});
      setPaused(false);
      void qc.invalidateQueries({ queryKey: ['woodpecker-programs'] });
    } catch {
      setPaused(false);
    }
  }

  // Focus the Resume button when paused for keyboard accessibility
  useEffect(() => {
    if (paused) {
      resumeBtnRef.current?.focus();
    }
  }, [paused]);

  // Auto-pause on browser window blur or Escape key
  useEffect(() => {
    const onBlur = () => {
      if (!paused && data && !data.is_cycle_finished) {
        void triggerPause();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (paused) void triggerResume();
        else void triggerPause();
      }
    };
    window.addEventListener('blur', onBlur);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [paused, data]);

  useEffect(() => {
    if (data?.is_cycle_finished) {
      onCycleFinished();
    }
  }, [data?.is_cycle_finished, onCycleFinished]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <button onClick={onBack} className="btn-secondary px-2.5 py-1.5 text-xs">
            <ArrowLeft className="h-4 w-4" /> {t('common.back', { defaultValue: 'Back' })}
          </button>
          <div>
            <h2 className="text-base font-bold text-chesscom-900 dark:text-chesscom-100">{programTitle}</h2>
            {data?.progress && (
              <div className="text-xs text-chesscom-500">
                {t('woodpecker.cycleProgress', { current: data.progress.cycle_number, total: data.progress.total })}
                {' · '}
                {data.progress.mode === 'strict' ? t('woodpecker.strictMode') : t('woodpecker.practiceMode')}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!paused ? (
            <button onClick={() => void triggerPause()} className="btn-secondary text-xs">
              <Pause className="h-3.5 w-3.5" /> {t('woodpecker.pause')}
            </button>
          ) : (
            <button onClick={() => void triggerResume()} className="btn-primary text-xs">
              <Play className="h-3.5 w-3.5" /> {t('woodpecker.resume')}
            </button>
          )}
        </div>
      </div>

      {isLoading && !paused && (
        <div className="card p-10 text-center text-sm text-chesscom-500">{t('common.loading')}</div>
      )}
      {isError && !paused && (
        <div className="card p-10 text-center text-sm text-move-mistake">{t('train.puzzles.loadError')}</div>
      )}

      {data?.puzzle && (
        <ActivePuzzleBoard
          key={`${data.puzzle.id}-${stepKey}`}
          programId={programId}
          puzzle={data.puzzle}
          progress={data.progress}
          paused={paused}
          resumeBtnRef={resumeBtnRef}
          onResume={() => void triggerResume()}
          onAdvance={() => setStepKey((k) => k + 1)}
          onCycleCompleted={onCycleFinished}
        />
      )}
    </div>
  );
}

function ActivePuzzleBoard({
  programId,
  puzzle,
  progress,
  paused,
  resumeBtnRef,
  onResume,
  onAdvance,
  onCycleCompleted,
}: {
  programId: number;
  puzzle: WoodpeckerPuzzle;
  progress: NextResponse['progress'];
  paused: boolean;
  resumeBtnRef: React.RefObject<HTMLButtonElement>;
  onResume: () => void;
  onAdvance: () => void;
  onCycleCompleted: () => void;
}) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const qc = useQueryClient();
  const player = wpPlayerOf(puzzle);

  // If has_setup_move is true, n starts at 0 and auto-plays moves[0].
  // If has_setup_move is false (blunder puzzle), n starts at 0 and is already the player's turn.
  const [n, setN] = useState(0);
  const [status, setStatus] = useState<'play' | 'wrong' | 'solved' | 'failed'>('play');
  const [mistakes, setMistakes] = useState(0);
  const [playedMoves, setPlayedMoves] = useState<string[]>([]);
  const [boardKey, setBoardKey] = useState(0);
  const [puzzleElapsedMs, setPuzzleElapsedMs] = useState(0);

  // Live 100ms ticker for the per-puzzle and cumulative clocks
  useEffect(() => {
    if (paused || status === 'solved' || status === 'failed') return;
    const interval = window.setInterval(() => {
      setPuzzleElapsedMs((ms) => ms + 200);
    }, 200);
    return () => clearInterval(interval);
  }, [paused, status]);

  const pos = useMemo(() => wpPositionAt(puzzle, n), [puzzle, n]);
  const done = n >= puzzle.moves.length;
  const yourTurn = !paused && !done && wpIsPlayerTurnAtIndex(puzzle, n) && (status === 'play' || status === 'wrong');

  function playSound(san: string) {
    if (user?.profile.sound_enabled ?? true) {
      soundForMove(inferMoveFlagsFromSan(san));
    }
  }

  // Play opponent setup move or opponent replies automatically
  useEffect(() => {
    if (paused || done) return;
    const isPlayerMove = wpIsPlayerTurnAtIndex(puzzle, n);
    if (isPlayerMove) return;

    const timer = window.setTimeout(() => {
      playSound(wpSanAt(puzzle, n));
      setN((k) => k + 1);
    }, n === 0 ? 350 : 280);
    return () => clearTimeout(timer);
  }, [n, done, paused, puzzle]);

  async function submitAttempt(outcome: 'solved' | 'failed' | 'retry_mistake', movesList: string[]) {
    try {
      const res = await api.post<AttemptResponse>(`/api/woodpecker/programs/${programId}/attempt`, {
        puzzle_id: puzzle.id,
        outcome,
        time_spent_ms: puzzleElapsedMs,
        played_moves: movesList,
      });
      void qc.invalidateQueries({ queryKey: ['woodpecker-programs'] });
      if (res.cycle_completed) {
        onCycleCompleted();
      }
    } catch {
      /* ignore network hiccup */
    }
  }

  function onUserMove(uci: string) {
    if (!yourTurn) {
      setBoardKey((k) => k + 1);
      return;
    }
    const updatedMoves = [...playedMoves, uci];
    setPlayedMoves(updatedMoves);

    if (wpIsRightMove(puzzle, n, uci)) {
      playSound(wpSanAt(puzzle, n));
      const nextN = n + 1;
      setN(nextN);
      if (nextN >= puzzle.moves.length) {
        setStatus('solved');
        void submitAttempt('solved', updatedMoves);
      } else {
        setStatus('play');
      }
      return;
    }

    // Wrong move handling: Strict Mode vs Practice Mode
    if (progress.mode === 'strict') {
      setStatus('failed');
      setN(puzzle.moves.length); // Reveal full solution line
      void submitAttempt('failed', updatedMoves);
      return;
    }

    // Practice Mode: record mistake, shake/reset board, let user try again
    setMistakes((m) => m + 1);
    setStatus('wrong');
    setBoardKey((k) => k + 1);
    void submitAttempt('retry_mistake', updatedMoves);
    setPuzzleElapsedMs(0); // server re-stamps puzzle_started_at on retry_mistake
  }

  const totalCycleSec = progress.cycle_time_spent_sec + Math.round(puzzleElapsedMs / 1000);
  const puzzleSec = Math.floor(puzzleElapsedMs / 1000);

  const startSolutionIndex = puzzle.has_setup_move ? 1 : 0;
  const solutionSan = useMemo(() => {
    const out: string[] = [];
    for (let i = startSolutionIndex; i < puzzle.moves.length; i++) {
      out.push(wpSanAt(puzzle, i));
    }
    return out.join(' ');
  }, [puzzle, startSolutionIndex]);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,520px)_1fr]">
      <div className="relative mx-auto w-full max-w-[520px]" aria-hidden={paused}>
        <ChessBoard
          resetKey={boardKey}
          fen={pos.fen}
          orientation={player}
          turnColor={pos.turn}
          lastMove={pos.lastMove as never}
          movable={yourTurn}
          onMove={onUserMove}
        />

        {paused && (
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t('woodpecker.pauseOverlayTitle')}
            className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 rounded-xl bg-stone-900/95 p-6 text-center text-white backdrop-blur-md"
          >
            <EyeOff className="h-12 w-12 text-gold-400" />
            <div className="space-y-1">
              <h3 className="text-lg font-bold">{t('woodpecker.pauseOverlayTitle')}</h3>
              <p className="max-w-xs text-xs text-stone-300">{t('woodpecker.pauseOverlayDesc')}</p>
            </div>
            <button
              ref={resumeBtnRef}
              onClick={onResume}
              className="btn-primary mt-2 px-5 py-2 text-sm"
            >
              <Play className="h-4 w-4" /> {t('woodpecker.resume')}
            </button>
          </div>
        )}
      </div>

      <div className="space-y-3">
        {/* Progress & Dual Clocks Card */}
        <div className="card space-y-3 p-4">
          <div className="flex items-center justify-between text-xs text-chesscom-500">
            <span className="font-semibold text-chesscom-900 dark:text-chesscom-100">
              {t('woodpecker.puzzleProgress', { current: progress.current_index + 1, total: progress.total })}
            </span>
            <span>
              {puzzle.rating !== null ? `${t('train.puzzles.puzzleRating', { rating: puzzle.rating })}` : t('woodpecker.unratedBlunder')}
            </span>
          </div>

          <div className="h-2 w-full overflow-hidden rounded-full bg-chesscom-200 dark:bg-chesscom-700">
            <div
              className="h-full bg-board-dark transition-all"
              style={{ width: `${Math.min(100, Math.round(((progress.current_index + (status === 'solved' || status === 'failed' ? 1 : 0)) / progress.total) * 100))}%` }}
            />
          </div>

          <div className="grid grid-cols-2 gap-2 pt-1">
            <div className="rounded-lg bg-chesscom-100/70 p-2.5 dark:bg-chesscom-800/60">
              <div className="flex items-center gap-1 text-[11px] text-chesscom-500">
                <Clock className="h-3 w-3" /> {t('woodpecker.puzzleClock')}
              </div>
              <div className="mt-0.5 font-mono text-base font-bold text-chesscom-900 dark:text-chesscom-100">
                {formatDurationSec(puzzleSec)}
              </div>
            </div>
            <div className="rounded-lg bg-chesscom-100/70 p-2.5 dark:bg-chesscom-800/60">
              <div className="flex items-center gap-1 text-[11px] text-chesscom-500">
                <Zap className="h-3 w-3 text-gold-500" /> {t('woodpecker.cycleClock')}
              </div>
              <div className="mt-0.5 font-mono text-base font-bold text-chesscom-900 dark:text-chesscom-100">
                {formatDurationSec(totalCycleSec)}
                {progress.target_duration_sec && (
                  <span className="ml-1 text-xs font-normal text-chesscom-400">
                    / {formatDurationSec(progress.target_duration_sec)}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Status / Feedback Card */}
        <div className="card space-y-3 p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <span className={`inline-block h-3 w-3 rounded-full border ${player === 'white' ? 'border-chesscom-400 bg-white' : 'border-chesscom-600 bg-chesscom-900'}`} />
            {player === 'white' ? t('train.whiteToMove') : t('train.blackToMove')}
            {mistakes > 0 && (
              <span className="ml-auto rounded bg-move-mistake/15 px-2 py-0.5 text-xs text-move-mistake">
                {t('woodpecker.mistakesCount', { count: mistakes })}
              </span>
            )}
          </div>

          {status === 'wrong' && (
            <div className="flex items-center justify-between rounded-lg bg-move-mistake/10 px-3 py-2 text-sm text-move-mistake">
              <span className="flex items-center gap-1.5 font-medium">
                <X className="h-4 w-4" /> {t('train.wrong')}
              </span>
              <span className="text-xs">{t('woodpecker.keepTrying')}</span>
            </div>
          )}

          {status === 'failed' && (
            <div className="space-y-2 rounded-lg bg-move-blunder/10 p-3 text-sm text-move-blunder">
              <div className="flex items-center gap-1.5 font-semibold">
                <X className="h-4 w-4" /> {t('woodpecker.strictFailed')}
              </div>
              <div className="text-xs text-chesscom-700 dark:text-chesscom-200">
                {t('woodpecker.solutionWas', { line: solutionSan })}
              </div>
            </div>
          )}

          {status === 'solved' && (
            <div className="space-y-1 rounded-lg bg-board-dark/15 p-3 text-sm text-board-dark">
              <div className="flex items-center gap-1.5 font-semibold">
                <Check className="h-4 w-4" /> {t('train.correct')}
              </div>
              <div className="text-xs text-chesscom-600 dark:text-chesscom-300">
                {solutionSan}
              </div>
            </div>
          )}

          {(status === 'solved' || status === 'failed') && (
            <div className="flex flex-wrap gap-2 pt-1">
              <button onClick={onAdvance} className="btn-primary text-sm">
                {t('train.nextPuzzle')} <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
