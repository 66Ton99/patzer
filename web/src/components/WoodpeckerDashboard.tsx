// WoodpeckerDashboard — manage Woodpecker tactical training programs, launch cycles,
// track neural consolidation rest timers, and inspect multi-cycle analytics and
// stubborn blunder patterns with the local AI Coach.

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  BarChart3,
  Clock,
  FastForward,
  Flame,
  Play,
  Plus,
  Repeat,
  Sparkles,
  Target,
  Trash2,
  Trophy,
  X,
  Zap,
} from 'lucide-react';
import WoodpeckerTrainer from './WoodpeckerTrainer';
import CoachPanel from './CoachPanel';
import { api } from '../api';
import { formatDurationSec, wpPlayerOf, wpPositionAt, wpSanAt } from '../lib/woodpecker';
import { normalizeLanguage } from '../lib/languages';

interface Preset {
  id: string;
  title: string;
  description: string;
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  puzzle_count: number;
  rating_min: number;
  rating_max: number;
  themes: string[];
}

interface ProgramSummary {
  id: number;
  title: string;
  description: string;
  source_type: 'preset' | 'theme' | 'blunders';
  total_puzzles: number;
  current_cycle: number;
  target_cycles: number;
  mode: 'strict' | 'practice';
  status: 'active' | 'paused' | 'resting' | 'completed' | 'archived';
  accuracy_last_cycle: number;
  time_last_cycle_sec: number;
  created_at: string;
}

interface CycleDetails {
  cycle_number: number;
  target_duration_sec: number | null;
  actual_duration_sec: number;
  elapsed_ms: number;
  solved_puzzles: number;
  total_puzzles: number;
  accuracy_pct: number;
  avg_time_per_puzzle_sec: number;
  status: 'in_progress' | 'paused' | 'completed';
  rest_until: string | null;
}

interface ProgramSummaryAnalytics {
  program_id: number;
  speedup_factor: number;
  accuracy_delta_pct: number;
  cycle_metrics: CycleDetails[];
  stubborn_puzzles: {
    puzzle_id: string;
    fen: string;
    moves: string[];
    has_setup_move: boolean;
    failed_in_cycles: number[];
    themes: string[];
  }[];
}

const THEMES = ['mate', 'fork', 'pin', 'discovered', 'sacrifice', 'hanging', 'defence', 'endgame'] as const;

export default function WoodpeckerDashboard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [activeProgram, setActiveProgram] = useState<ProgramSummary | null>(null);
  const [summaryProgram, setSummaryProgram] = useState<ProgramSummary | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [skipRestConfirmId, setSkipRestConfirmId] = useState<number | null>(null);

  const { data: programsData, isLoading } = useQuery({
    queryKey: ['woodpecker-programs'],
    queryFn: () => api.get<{ programs: ProgramSummary[] }>('/api/woodpecker/programs'),
  });

  const { data: presetsData } = useQuery({
    queryKey: ['woodpecker-presets'],
    queryFn: () => api.get<{ presets: Preset[] }>('/api/woodpecker/presets'),
  });

  const programs = (programsData?.programs ?? []).filter((p) => p.status !== 'archived');
  const presets = presetsData?.presets ?? [];

  async function handleSkipRest(programId: number) {
    try {
      await api.post(`/api/woodpecker/programs/${programId}/skip-rest`, {});
      setSkipRestConfirmId(null);
      await qc.invalidateQueries({ queryKey: ['woodpecker-programs'] });
    } catch {
      setSkipRestConfirmId(null);
    }
  }

  async function handleArchive(programId: number) {
    try {
      await api.post(`/api/woodpecker/programs/${programId}/archive`, {});
      await qc.invalidateQueries({ queryKey: ['woodpecker-programs'] });
    } catch {
      /* ignore */
    }
  }

  async function handleDelete(programId: number) {
    try {
      await api.del(`/api/woodpecker/programs/${programId}`);
      await qc.invalidateQueries({ queryKey: ['woodpecker-programs'] });
    } catch {
      /* ignore */
    }
  }

  if (activeProgram) {
    return (
      <WoodpeckerTrainer
        programId={activeProgram.id}
        programTitle={activeProgram.title}
        initialPaused={activeProgram.status === 'paused'}
        onBack={() => {
          setActiveProgram(null);
          void qc.invalidateQueries({ queryKey: ['woodpecker-programs'] });
        }}
        onCycleFinished={() => {
          const finishedProg = activeProgram;
          setActiveProgram(null);
          setSummaryProgram(finishedProg);
          void qc.invalidateQueries({ queryKey: ['woodpecker-programs'] });
        }}
      />
    );
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="page-h1 flex items-center gap-2">
            <Repeat className="h-6 w-6 text-board-dark" />
            {t('woodpecker.title')}
          </h1>
          <p className="page-sub">{t('woodpecker.tagline')}</p>
        </div>
        <button onClick={() => setShowCreateModal(true)} className="btn-primary text-sm">
          <Plus className="h-4 w-4" /> {t('woodpecker.newProgram')}
        </button>
      </header>

      {isLoading && (
        <div className="card p-10 text-center text-sm text-chesscom-500">{t('common.loading')}</div>
      )}

      {!isLoading && programs.length === 0 && (
        <div className="card flex flex-col items-center gap-3 p-10 text-center">
          <Repeat className="h-10 w-10 text-board-dark" />
          <div className="text-base font-semibold">{t('woodpecker.emptyTitle')}</div>
          <p className="max-w-lg text-sm text-chesscom-500">{t('woodpecker.emptyDesc')}</p>
          <button onClick={() => setShowCreateModal(true)} className="btn-primary mt-2 text-sm">
            <Plus className="h-4 w-4" /> {t('woodpecker.newProgram')}
          </button>
        </div>
      )}

      {programs.length > 0 && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {programs.map((prog) => (
            <ProgramCard
              key={prog.id}
              program={prog}
              onTrain={() => setActiveProgram(prog)}
              onSummary={() => setSummaryProgram(prog)}
              onRequestSkipRest={() => setSkipRestConfirmId(prog.id)}
              onArchive={() => void handleArchive(prog.id)}
              onDelete={() => void handleDelete(prog.id)}
            />
          ))}
        </div>
      )}

      {showCreateModal && (
        <CreateProgramModal
          presets={presets}
          onClose={() => setShowCreateModal(false)}
          onCreated={(prog) => {
            setShowCreateModal(false);
            void qc.invalidateQueries({ queryKey: ['woodpecker-programs'] });
            setActiveProgram(prog);
          }}
        />
      )}

      {skipRestConfirmId !== null && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="card max-w-md space-y-4 p-6">
            <h3 className="text-base font-bold text-chesscom-900 dark:text-chesscom-100">
              {t('woodpecker.skipRest')}
            </h3>
            <p className="text-sm text-chesscom-500">{t('woodpecker.skipRestConfirm')}</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setSkipRestConfirmId(null)} className="btn-secondary text-xs">
                {t('common.cancel', { defaultValue: 'Cancel' })}
              </button>
              <button onClick={() => void handleSkipRest(skipRestConfirmId)} className="btn-primary text-xs">
                <FastForward className="h-3.5 w-3.5" /> {t('woodpecker.skipRest')}
              </button>
            </div>
          </div>
        </div>
      )}

      {summaryProgram && (
        <ProgramSummaryModal
          program={summaryProgram}
          onClose={() => setSummaryProgram(null)}
        />
      )}
    </div>
  );
}

function ProgramCard({
  program,
  onTrain,
  onSummary,
  onRequestSkipRest,
  onArchive,
  onDelete,
}: {
  program: ProgramSummary;
  onTrain: () => void;
  onSummary: () => void;
  onRequestSkipRest: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();

  const { data: details } = useQuery({
    queryKey: ['woodpecker-program-details', program.id],
    queryFn: () => api.get<{ rest_until: string | null }>(`/api/woodpecker/programs/${program.id}`),
    enabled: program.status === 'resting',
  });

  const restRemaining = (() => {
    if (program.status !== 'resting' || !details?.rest_until) return null;
    const ms = Date.parse(details.rest_until.endsWith('Z') ? details.rest_until : `${details.rest_until}Z`) - Date.now();
    if (ms <= 0) return null;
    const hours = Math.floor(ms / 3_600_000);
    const mins = Math.floor((ms % 3_600_000) / 60_000);
    return { hours, mins };
  })();

  return (
    <div className="card flex flex-col justify-between gap-4 p-4">
      <div className="space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="text-base font-bold text-chesscom-900 dark:text-chesscom-100">{program.title}</h3>
            {program.description && (
              <p className="line-clamp-2 text-xs text-chesscom-500">{program.description}</p>
            )}
          </div>
          <span
            className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
              program.status === 'completed'
                ? 'bg-gold-500/20 text-gold-600'
                : program.status === 'resting'
                ? 'bg-blue-500/15 text-blue-500'
                : 'bg-board-dark/15 text-board-dark'
            }`}
          >
            {t(`woodpecker.status.${program.status}`)}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-3 pt-1 text-xs text-chesscom-500">
          <span className="flex items-center gap-1 font-medium text-chesscom-800 dark:text-chesscom-200">
            <Repeat className="h-3.5 w-3.5 text-board-dark" />
            {t('woodpecker.cycleProgress', { current: program.current_cycle, total: program.target_cycles })}
          </span>
          <span>•</span>
          <span>{t('woodpecker.puzzlesCount', { count: program.total_puzzles })}</span>
          <span>•</span>
          <span>{program.mode === 'strict' ? t('woodpecker.strictMode') : t('woodpecker.practiceMode')}</span>
        </div>

        {program.time_last_cycle_sec > 0 && (
          <div className="flex items-center gap-4 rounded-lg bg-chesscom-100/70 px-3 py-2 text-xs dark:bg-chesscom-800/50">
            <span>
              {t('train.accuracy', { defaultValue: 'Accuracy' })}:{' '}
              <strong className="text-chesscom-900 dark:text-chesscom-100">{program.accuracy_last_cycle}%</strong>
            </span>
            <span>
              {t('woodpecker.lastCycleTime')}:{' '}
              <strong className="text-chesscom-900 dark:text-chesscom-100">
                {formatDurationSec(program.time_last_cycle_sec)}
              </strong>
            </span>
          </div>
        )}

        {program.status === 'resting' && restRemaining && (
          <div className="flex items-center gap-2 rounded-lg border border-blue-500/20 bg-blue-500/10 px-3 py-2 text-xs text-blue-600 dark:text-blue-400">
            <Clock className="h-4 w-4 shrink-0" />
            <span>{t('woodpecker.restTimer', { hours: restRemaining.hours, mins: restRemaining.mins })}</span>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-chesscom-200 pt-3 dark:border-chesscom-700">
        <div className="flex items-center gap-1.5">
          {(program.status === 'active' || program.status === 'paused') && (
            <button onClick={onTrain} className="btn-primary text-xs">
              <Play className="h-3.5 w-3.5" />
              {program.status === 'paused' ? t('woodpecker.resume') : t('woodpecker.continueCycle')}
            </button>
          )}
          {program.status === 'resting' && (
            <button onClick={onRequestSkipRest} className="btn-secondary text-xs">
              <FastForward className="h-3.5 w-3.5" /> {t('woodpecker.skipRest')}
            </button>
          )}
          <button onClick={onSummary} className="btn-secondary text-xs">
            <BarChart3 className="h-3.5 w-3.5" /> {t('woodpecker.analytics')}
          </button>
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={onArchive}
            title={t('woodpecker.archive')}
            className="rounded p-1.5 text-chesscom-400 hover:bg-chesscom-200/50 hover:text-chesscom-700 dark:hover:bg-chesscom-700"
          >
            <Archive className="h-4 w-4" />
          </button>
          <button
            onClick={onDelete}
            title={t('common.delete', { defaultValue: 'Delete' })}
            className="rounded p-1.5 text-chesscom-400 hover:bg-move-blunder/10 hover:text-move-blunder"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

function CreateProgramModal({
  presets,
  onClose,
  onCreated,
}: {
  presets: Preset[];
  onClose: () => void;
  onCreated: (prog: ProgramSummary) => void;
}) {
  const { t } = useTranslation();
  const [sourceType, setSourceType] = useState<'preset' | 'theme' | 'blunders'>('preset');
  const [presetId, setPresetId] = useState(presets[0]?.id ?? 'starter-100');
  const [theme, setTheme] = useState<string>('fork');
  const [title, setTitle] = useState('');
  const [puzzleCount, setPuzzleCount] = useState(100);
  const [targetCycles, setTargetCycles] = useState(6);
  const [mode, setMode] = useState<'strict' | 'practice'>('strict');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);

    const selectedPreset = presets.find((p) => p.id === presetId);
    const defaultTitle =
      sourceType === 'preset'
        ? selectedPreset?.title ?? 'Woodpecker Foundations'
        : sourceType === 'theme'
        ? `${t(`train.puzzles.themes.${theme}`)} Woodpecker`
        : t('woodpecker.sourceBlunders');

    try {
      const res = await api.post<{ program: ProgramSummary }>('/api/woodpecker/programs', {
        title: title.trim() || defaultTitle,
        source_type: sourceType,
        preset_id: sourceType === 'preset' ? presetId : null,
        theme: sourceType === 'theme' ? theme : null,
        puzzle_count: sourceType === 'preset' ? selectedPreset?.puzzle_count ?? 100 : puzzleCount,
        target_cycles: targetCycles,
        mode,
      });
      onCreated(res.program);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <form onSubmit={(e) => void handleSubmit(e)} className="card max-h-[90vh] w-full max-w-lg space-y-4 overflow-y-auto p-6">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-bold text-chesscom-900 dark:text-chesscom-100">
            {t('woodpecker.newProgram')}
          </h3>
          <button type="button" onClick={onClose} className="text-chesscom-400 hover:text-chesscom-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-1">
          <label className="text-xs font-semibold text-chesscom-600 dark:text-chesscom-300">
            {t('woodpecker.programTitleLabel')}
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('woodpecker.programTitlePlaceholder')}
            className="input w-full text-sm"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-chesscom-600 dark:text-chesscom-300">
            {t('woodpecker.sourceLabel')}
          </label>
          <div className="grid grid-cols-3 gap-2">
            {(['preset', 'theme', 'blunders'] as const).map((st) => (
              <button
                key={st}
                type="button"
                onClick={() => setSourceType(st)}
                className={`rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                  sourceType === st
                    ? 'border-board-dark bg-board-dark/15 text-chesscom-900 dark:text-chesscom-100'
                    : 'border-chesscom-200 text-chesscom-600 dark:border-chesscom-700 dark:text-chesscom-400'
                }`}
              >
                {st === 'preset'
                  ? t('woodpecker.sourcePreset')
                  : st === 'theme'
                  ? t('woodpecker.sourceTheme')
                  : t('woodpecker.sourceBlunders')}
              </button>
            ))}
          </div>
        </div>

        {sourceType === 'preset' && (
          <div className="space-y-2">
            {presets.map((pr) => (
              <label
                key={pr.id}
                className={`flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 text-xs ${
                  presetId === pr.id
                    ? 'border-board-dark bg-board-dark/10'
                    : 'border-chesscom-200 dark:border-chesscom-700'
                }`}
              >
                <input
                  type="radio"
                  name="preset"
                  checked={presetId === pr.id}
                  onChange={() => setPresetId(pr.id)}
                  className="mt-0.5"
                />
                <div>
                  <div className="font-semibold text-chesscom-900 dark:text-chesscom-100">
                    {pr.title} ({pr.puzzle_count})
                  </div>
                  <div className="text-chesscom-500">{pr.description}</div>
                </div>
              </label>
            ))}
          </div>
        )}

        {sourceType === 'theme' && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-1.5">
              {THEMES.map((th) => (
                <button
                  key={th}
                  type="button"
                  onClick={() => setTheme(th)}
                  className={`rounded-full border px-3 py-1 text-xs ${
                    theme === th
                      ? 'border-board-dark bg-board-dark/15 font-semibold'
                      : 'border-chesscom-200 dark:border-chesscom-700'
                  }`}
                >
                  {t(`train.puzzles.themes.${th}`)}
                </button>
              ))}
            </div>
            <div>
              <label className="text-xs font-semibold text-chesscom-600 dark:text-chesscom-300">
                {t('woodpecker.puzzleCountLabel')}: {puzzleCount}
              </label>
              <input
                type="range"
                min={20}
                max={300}
                step={10}
                value={puzzleCount}
                onChange={(e) => setPuzzleCount(Number(e.target.value))}
                className="w-full"
              />
            </div>
          </div>
        )}

        {sourceType === 'blunders' && (
          <div className="space-y-2">
            <p className="text-xs text-chesscom-500">{t('woodpecker.blundersHint')}</p>
            <div>
              <label className="text-xs font-semibold text-chesscom-600 dark:text-chesscom-300">
                {t('woodpecker.puzzleCountLabel')}: {puzzleCount}
              </label>
              <input
                type="range"
                min={20}
                max={200}
                step={10}
                value={puzzleCount}
                onChange={(e) => setPuzzleCount(Number(e.target.value))}
                className="w-full"
              />
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-semibold text-chesscom-600 dark:text-chesscom-300">
              {t('woodpecker.targetCyclesLabel')}: {targetCycles}
            </label>
            <input
              type="range"
              min={3}
              max={7}
              value={targetCycles}
              onChange={(e) => setTargetCycles(Number(e.target.value))}
              className="mt-1 w-full"
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-chesscom-600 dark:text-chesscom-300">
              {t('woodpecker.modeLabel')}
            </label>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as 'strict' | 'practice')}
              className="input mt-1 w-full text-xs"
            >
              <option value="strict">{t('woodpecker.strictMode')}</option>
              <option value="practice">{t('woodpecker.practiceMode')}</option>
            </select>
          </div>
        </div>

        {error && <div className="rounded bg-move-blunder/10 p-2.5 text-xs text-move-blunder">{error}</div>}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary text-xs">
            {t('common.cancel', { defaultValue: 'Cancel' })}
          </button>
          <button type="submit" disabled={busy} className="btn-primary text-xs">
            {t('woodpecker.startProgram')}
          </button>
        </div>
      </form>
    </div>
  );
}

function ProgramSummaryModal({
  program,
  onClose,
}: {
  program: ProgramSummary;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [selectedStubbornIdx, setSelectedStubbornIdx] = useState<number | null>(null);

  const { data: summary, isLoading } = useQuery({
    queryKey: ['woodpecker-summary', program.id],
    queryFn: () => api.get<ProgramSummaryAnalytics>(`/api/woodpecker/programs/${program.id}/summary`),
  });

  const { data: coachStatus } = useQuery({
    queryKey: ['coach-status'],
    queryFn: () => api.get<{ configured: boolean }>('/api/coach/status'),
  });

  const selectedStubborn =
    summary && selectedStubbornIdx !== null ? summary.stubborn_puzzles[selectedStubbornIdx] ?? null : null;

  const coachReq = () => {
    if (!selectedStubborn) return { url: '/api/coach/hint', body: {} };
    const startIdx = selectedStubborn.has_setup_move ? 1 : 0;
    const posBeforeUserMove = wpPositionAt(
      {
        id: selectedStubborn.puzzle_id,
        fen: selectedStubborn.fen,
        moves: selectedStubborn.moves,
        has_setup_move: selectedStubborn.has_setup_move,
        rating: null,
        themes: selectedStubborn.themes,
      },
      startIdx,
    );
    const bestSan = wpSanAt(
      {
        id: selectedStubborn.puzzle_id,
        fen: selectedStubborn.fen,
        moves: selectedStubborn.moves,
        has_setup_move: selectedStubborn.has_setup_move,
        rating: null,
        themes: selectedStubborn.themes,
      },
      startIdx,
    );
    const playerSide = wpPlayerOf({
      id: selectedStubborn.puzzle_id,
      fen: selectedStubborn.fen,
      moves: selectedStubborn.moves,
      has_setup_move: selectedStubborn.has_setup_move,
      rating: null,
      themes: selectedStubborn.themes,
    });
    return {
      url: '/api/coach/explain',
      body: {
        fen: posBeforeUserMove.fen,
        player: playerSide === 'white' ? 'White' : 'Black',
        played_san: bestSan,
        best_san: bestSan,
        classification: 'best',
        cp_loss: 0,
        user_perspective: true,
        language: normalizeLanguage(i18n.language),
      },
    };
  };

  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="card max-h-[90vh] w-full max-w-2xl space-y-4 overflow-y-auto p-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-bold text-chesscom-900 dark:text-chesscom-100">{program.title}</h3>
            <p className="text-xs text-chesscom-500">{t('woodpecker.analytics')}</p>
          </div>
          <button onClick={onClose} className="text-chesscom-400 hover:text-chesscom-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        {isLoading && <div className="p-6 text-center text-sm text-chesscom-500">{t('common.loading')}</div>}

        {summary && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl bg-gold-500/10 p-3">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-gold-600">
                  <Flame className="h-4 w-4" /> {t('woodpecker.speedup', { factor: summary.speedup_factor })}
                </div>
              </div>
              <div className="rounded-xl bg-board-dark/10 p-3">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-board-dark">
                  <Target className="h-4 w-4" />
                  {t('woodpecker.accuracyGain', {
                    delta: summary.accuracy_delta_pct >= 0 ? `+${summary.accuracy_delta_pct}` : summary.accuracy_delta_pct,
                  })}
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-chesscom-400">
                {t('woodpecker.cycleHistory')}
              </h4>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-chesscom-200 text-chesscom-400 dark:border-chesscom-700">
                      <th className="py-2">{t('woodpecker.cycleCol')}</th>
                      <th className="py-2">{t('train.accuracy', { defaultValue: 'Accuracy' })}</th>
                      <th className="py-2">{t('woodpecker.durationCol')}</th>
                      <th className="py-2">{t('woodpecker.targetCol')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.cycle_metrics.map((cm) => (
                      <tr key={cm.cycle_number} className="border-b border-chesscom-100 dark:border-chesscom-800">
                        <td className="py-2 font-semibold">#{cm.cycle_number}</td>
                        <td className="py-2">
                          {cm.accuracy_pct}% ({cm.solved_puzzles}/{cm.total_puzzles})
                        </td>
                        <td className="py-2 font-mono">{formatDurationSec(cm.actual_duration_sec)}</td>
                        <td className="py-2 font-mono text-chesscom-400">
                          {cm.target_duration_sec ? formatDurationSec(cm.target_duration_sec) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {summary.stubborn_puzzles.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-move-mistake">
                  {t('woodpecker.stubbornBlunders', { count: summary.stubborn_puzzles.length })}
                </h4>
                <div className="space-y-2">
                  {summary.stubborn_puzzles.map((sp, idx) => (
                    <div
                      key={sp.puzzle_id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-chesscom-200 p-2.5 text-xs dark:border-chesscom-700"
                    >
                      <div>
                        <span className="font-mono font-semibold">{sp.puzzle_id}</span>
                        <span className="ml-2 text-chesscom-500">
                          ({t('woodpecker.missedInCycles', { cycles: sp.failed_in_cycles.join(', ') })})
                        </span>
                      </div>
                      <button
                        onClick={() => setSelectedStubbornIdx(selectedStubbornIdx === idx ? null : idx)}
                        className="btn-secondary px-2.5 py-1 text-xs"
                      >
                        <Sparkles className="h-3.5 w-3.5 text-gold-500" /> {t('woodpecker.coachExplain')}
                      </button>
                    </div>
                  ))}
                </div>

                {selectedStubborn && (
                  <div className="pt-2">
                    <CoachPanel
                      systemConfigured={coachStatus?.configured ?? false}
                      request={coachReq}
                      autoPlay={true}
                      triggerKey={selectedStubborn.puzzle_id}
                      compact={true}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
