// Woodpecker Method tactical training — cyclical spaced-repetition drilling
// over a frozen set of puzzles with exponential duration halving and rest
// intervals for neural consolidation.
//
// See openspec/changes/add-woodpecker-training/ for the full specification.

import { db } from '../db.js';
import { THEME_FILTERS, allPuzzles } from './tactics.js';

export interface WoodpeckerPreset {
  id: string;
  title: string;
  description: string;
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  puzzle_count: number;
  rating_min: number;
  rating_max: number;
  themes: string[];
}

export const WOODPECKER_PRESETS: WoodpeckerPreset[] = [
  {
    id: 'starter-100',
    title: 'Woodpecker Foundations',
    description: '100 accessible tactical motifs to develop basic subconscious pattern instincts.',
    difficulty: 'beginner',
    puzzle_count: 100,
    rating_min: 1000,
    rating_max: 1400,
    themes: ['mate', 'fork', 'pin', 'hanging'],
  },
  {
    id: 'easy-222',
    title: 'Tactical Agility 222',
    description: '222 elementary tactical problems for rapid scanning and confidence building.',
    difficulty: 'beginner',
    puzzle_count: 222,
    rating_min: 1000,
    rating_max: 1400,
    themes: ['mate', 'fork', 'pin', 'hanging'],
  },
  {
    id: 'club-300',
    title: 'Club Competitor 300',
    description: '300 multi-move combinations and sacrifices designed for club players.',
    difficulty: 'intermediate',
    puzzle_count: 300,
    rating_min: 1401,
    rating_max: 1800,
    themes: ['discovered', 'sacrifice', 'pin', 'fork', 'endgame'],
  },
  {
    id: 'master-500',
    title: 'Master Challenge 500',
    description: '500 complex tactical operations for deep calculation and master-level intuition.',
    difficulty: 'advanced',
    puzzle_count: 500,
    rating_min: 1600,
    rating_max: 2200,
    themes: ['discovered', 'sacrifice', 'pin', 'defence', 'endgame'],
  },
];

export interface WoodpeckerPuzzlePayload {
  id: string;
  fen: string;
  moves: string[];
  has_setup_move: boolean;
  rating: number | null;
  themes: string[];
}

export interface CycleDetails {
  cycle_number: number;
  target_duration_sec: number | null;
  actual_duration_sec: number;
  elapsed_ms: number;
  paused_at: string | null;
  puzzle_started_at: string | null;
  solved_puzzles: number;
  total_puzzles: number;
  accuracy_pct: number;
  avg_time_per_puzzle_sec: number;
  status: 'in_progress' | 'paused' | 'completed';
  started_at: string;
  completed_at: string | null;
  rest_until: string | null;
}

export interface WoodpeckerProgramSummary {
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

export interface WoodpeckerProgramDetails extends WoodpeckerProgramSummary {
  cycles: CycleDetails[];
  rest_until: string | null;
}

export interface ProgramSummaryAnalytics {
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

export interface CreateProgramInput {
  title: string;
  description?: string;
  source_type: 'preset' | 'theme' | 'blunders';
  preset_id?: string | null;
  theme?: string | null;
  puzzle_count?: number;
  rating_min?: number | null;
  rating_max?: number | null;
  target_cycles?: number;
  mode?: 'strict' | 'practice';
  rest_duration_hours?: number;
}

export type CreateProgramResult =
  | { ok: true; program: WoodpeckerProgramDetails }
  | { ok: false; code: 'program_limit_reached' | 'invalid_preset' | 'invalid_theme' | 'insufficient_puzzles' | 'insufficient_blunders'; error: string };

interface ProgramRow {
  id: number;
  user_id: number;
  title: string;
  description: string;
  source_type: 'preset' | 'theme' | 'blunders';
  source_params: string | null;
  puzzle_ids: string;
  total_puzzles: number;
  target_cycles: number;
  current_cycle: number;
  mode: 'strict' | 'practice';
  rest_duration_hours: number;
  status: 'active' | 'paused' | 'resting' | 'completed' | 'archived';
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface CycleRow {
  id: number;
  program_id: number;
  cycle_number: number;
  target_duration_sec: number | null;
  actual_duration_sec: number;
  elapsed_ms: number;
  paused_at: string | null;
  puzzle_started_at: string | null;
  total_puzzles: number;
  solved_puzzles: number;
  accuracy_pct: number;
  avg_time_per_puzzle_sec: number;
  status: 'in_progress' | 'paused' | 'completed';
  started_at: string;
  completed_at: string | null;
  rest_until: string | null;
}

interface AttemptRow {
  id: number;
  cycle_id: number;
  puzzle_id: string;
  first_try_solved: number;
  solved: number;
  mistakes_count: number;
  time_spent_ms: number;
  played_moves_uci: string | null;
  blunder_repeated: number;
  created_at: string;
  updated_at: string;
}

const MAX_ACTIVE_PROGRAMS = 3;
const MIN_DURATION_TARGET_SEC = 300; // 5 minutes minimum floor
const MIN_ATTEMPT_MS = 500;
const MAX_ATTEMPT_MS = 600_000; // 10 minutes maximum cap per attempt

/** Collect all Lichess raw tags for a list of canonical THEME_FILTERS keys. */
function expandThemeTags(themeKeys: string[]): Set<string> {
  const tags = new Set<string>();
  for (const key of themeKeys) {
    const list = THEME_FILTERS[key];
    if (list) for (const t of list) tags.add(t);
  }
  return tags;
}

/** Map raw Lichess puzzle tags to canonical THEME_FILTERS keys. */
function canonicalThemesOf(rawThemes: string[]): string[] {
  const out: string[] = [];
  for (const [key, tags] of Object.entries(THEME_FILTERS)) {
    if (rawThemes.some((t) => tags.includes(t))) out.push(key);
  }
  return out;
}

/** Deterministic evenly-spaced sampling across a rating-sorted array so the
 *  sliced block covers the full rating window smoothly. */
function sliceEvenly<T>(items: T[], count: number): T[] {
  if (items.length <= count) return [...items];
  const result: T[] = [];
  const step = items.length / count;
  for (let i = 0; i < count; i++) {
    const idx = Math.min(items.length - 1, Math.floor(i * step));
    result.push(items[idx]!);
  }
  return result;
}

/** Resolve a typed puzzle ID ("lichess:<id>" or "blunder:<id>") to its payload. */
export function resolveWoodpeckerPuzzle(typedId: string, userId: number): WoodpeckerPuzzlePayload | null {
  if (typedId.startsWith('lichess:')) {
    const rawId = typedId.slice(8);
    const puzzle = allPuzzles().find((p) => p.id === rawId);
    if (!puzzle) return null;
    return {
      id: typedId,
      fen: puzzle.fen,
      moves: puzzle.moves,
      has_setup_move: true,
      rating: puzzle.rating,
      themes: canonicalThemesOf(puzzle.themes),
    };
  }

  if (typedId.startsWith('blunder:')) {
    const attemptId = Number.parseInt(typedId.slice(8), 10);
    if (!Number.isFinite(attemptId)) return null;
    const row = db.prepare(`
      SELECT id, fen, solution_uci, user_id FROM puzzle_attempts
      WHERE id = ? AND user_id = ?
    `).get(attemptId, userId) as { id: number; fen: string; solution_uci: string; user_id: number } | undefined;
    if (!row) return null;
    return {
      id: typedId,
      fen: row.fen,
      moves: [row.solution_uci],
      has_setup_move: false,
      rating: null,
      themes: [],
    };
  }

  return null;
}

/** Calculate target duration for the next cycle (halving with a 300s floor). */
export function nextCycleTargetDuration(prevCycleNumber: number, prevActualSec: number, prevTargetSec: number | null): number {
  const base = prevCycleNumber === 1 || prevTargetSec === null ? prevActualSec : prevTargetSec;
  return Math.max(MIN_DURATION_TARGET_SEC, Math.ceil(base / 2));
}

function toCycleDetails(row: CycleRow): CycleDetails {
  return {
    cycle_number: row.cycle_number,
    target_duration_sec: row.target_duration_sec,
    actual_duration_sec: row.actual_duration_sec,
    elapsed_ms: row.elapsed_ms,
    paused_at: row.paused_at,
    puzzle_started_at: row.puzzle_started_at,
    solved_puzzles: row.solved_puzzles,
    total_puzzles: row.total_puzzles,
    accuracy_pct: Math.round(row.accuracy_pct * 10) / 10,
    avg_time_per_puzzle_sec: Math.round(row.avg_time_per_puzzle_sec * 10) / 10,
    status: row.status,
    started_at: row.started_at,
    completed_at: row.completed_at,
    rest_until: row.rest_until,
  };
}

/** Automatically transition a resting program to active if its rest period has elapsed. */
function checkAutoWakeFromRest(prog: ProgramRow, nowMs: number = Date.now()): ProgramRow {
  if (prog.status !== 'resting') return prog;
  const lastCycle = db.prepare(`
    SELECT * FROM woodpecker_cycles
    WHERE program_id = ? AND cycle_number = ?
  `).get(prog.id, prog.current_cycle) as CycleRow | undefined;

  if (!lastCycle || !lastCycle.rest_until) return prog;
  const restUntilMs = Date.parse(lastCycle.rest_until.endsWith('Z') ? lastCycle.rest_until : `${lastCycle.rest_until}Z`);
  if (Number.isFinite(restUntilMs) && nowMs >= restUntilMs) {
    return advanceToNextCycle(prog, lastCycle);
  }
  return prog;
}

function advanceToNextCycle(prog: ProgramRow, prevCycle: CycleRow): ProgramRow {
  const nextCycleNum = prog.current_cycle + 1;
  const targetSec = nextCycleTargetDuration(prevCycle.cycle_number, prevCycle.actual_duration_sec, prevCycle.target_duration_sec);
  const nowIso = new Date().toISOString();

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT OR IGNORE INTO woodpecker_cycles (
        program_id, cycle_number, target_duration_sec, total_puzzles, status, started_at
      ) VALUES (?, ?, ?, ?, 'in_progress', ?)
    `).run(prog.id, nextCycleNum, targetSec, prog.total_puzzles, nowIso);

    db.prepare(`
      UPDATE woodpecker_programs
      SET current_cycle = ?, status = 'active', updated_at = ?
      WHERE id = ?
    `).run(nextCycleNum, nowIso, prog.id);
  });
  tx();

  return db.prepare(`SELECT * FROM woodpecker_programs WHERE id = ?`).get(prog.id) as ProgramRow;
}

export function listPrograms(userId: number): WoodpeckerProgramSummary[] {
  const rows = db.prepare(`
    SELECT * FROM woodpecker_programs
    WHERE user_id = ?
    ORDER BY created_at DESC, id DESC
  `).all(userId) as ProgramRow[];

  return rows.map((raw) => {
    const p = checkAutoWakeFromRest(raw);
    const cycles = db.prepare(`
      SELECT * FROM woodpecker_cycles WHERE program_id = ? ORDER BY cycle_number DESC
    `).all(p.id) as CycleRow[];
    const latestCompleted = cycles.find((c) => c.status === 'completed') ?? cycles[0];
    return {
      id: p.id,
      title: p.title,
      description: p.description,
      source_type: p.source_type,
      total_puzzles: p.total_puzzles,
      current_cycle: p.current_cycle,
      target_cycles: p.target_cycles,
      mode: p.mode,
      status: p.status,
      accuracy_last_cycle: latestCompleted ? Math.round(latestCompleted.accuracy_pct * 10) / 10 : 0,
      time_last_cycle_sec: latestCompleted ? latestCompleted.actual_duration_sec : 0,
      created_at: p.created_at,
    };
  });
}

export function getProgramDetails(userId: number, programId: number): WoodpeckerProgramDetails | null {
  const raw = db.prepare(`
    SELECT * FROM woodpecker_programs WHERE id = ? AND user_id = ?
  `).get(programId, userId) as ProgramRow | undefined;
  if (!raw) return null;

  const p = checkAutoWakeFromRest(raw);
  const cycles = db.prepare(`
    SELECT * FROM woodpecker_cycles WHERE program_id = ? ORDER BY cycle_number ASC
  `).all(p.id) as CycleRow[];

  const latestCompleted = [...cycles].reverse().find((c) => c.status === 'completed') ?? cycles.at(-1);
  const currentCycleRow = cycles.find((c) => c.cycle_number === p.current_cycle);

  return {
    id: p.id,
    title: p.title,
    description: p.description,
    source_type: p.source_type,
    total_puzzles: p.total_puzzles,
    current_cycle: p.current_cycle,
    target_cycles: p.target_cycles,
    mode: p.mode,
    status: p.status,
    accuracy_last_cycle: latestCompleted ? Math.round(latestCompleted.accuracy_pct * 10) / 10 : 0,
    time_last_cycle_sec: latestCompleted ? latestCompleted.actual_duration_sec : 0,
    created_at: p.created_at,
    cycles: cycles.map(toCycleDetails),
    rest_until: p.status === 'resting' ? (currentCycleRow?.rest_until ?? null) : null,
  };
}

export function createProgram(userId: number, input: CreateProgramInput): CreateProgramResult {
  const activeCount = (db.prepare(`
    SELECT COUNT(*) AS n FROM woodpecker_programs
    WHERE user_id = ? AND status IN ('active', 'paused', 'resting')
  `).get(userId) as { n: number }).n;

  if (activeCount >= MAX_ACTIVE_PROGRAMS) {
    return {
      ok: false,
      code: 'program_limit_reached',
      error: `You can have at most ${MAX_ACTIVE_PROGRAMS} active Woodpecker programs at a time.`,
    };
  }

  let puzzleIds: string[] = [];
  let description = input.description ?? '';

  if (input.source_type === 'preset') {
    const preset = WOODPECKER_PRESETS.find((pr) => pr.id === input.preset_id);
    if (!preset) {
      return { ok: false, code: 'invalid_preset', error: 'Invalid preset selected.' };
    }
    const tags = expandThemeTags(preset.themes);
    const matching = allPuzzles().filter(
      (p) => p.rating >= preset.rating_min && p.rating <= preset.rating_max && p.themes.some((t) => tags.has(t)),
    );
    const sliced = sliceEvenly(matching, preset.puzzle_count);
    puzzleIds = sliced.map((p) => `lichess:${p.id}`);
    if (!description) description = preset.description;
  } else if (input.source_type === 'theme') {
    const themeKey = input.theme ?? '';
    if (!(themeKey in THEME_FILTERS)) {
      return { ok: false, code: 'invalid_theme', error: 'Invalid tactical theme key.' };
    }
    const rMin = input.rating_min ?? 1000;
    const rMax = input.rating_max ?? 1800;
    const count = Math.min(500, Math.max(20, input.puzzle_count ?? 100));
    const tags = expandThemeTags([themeKey]);
    const matching = allPuzzles().filter(
      (p) => p.rating >= rMin && p.rating <= rMax && p.themes.some((t) => tags.has(t)),
    );
    if (matching.length < 20) {
      return {
        ok: false,
        code: 'insufficient_puzzles',
        error: 'Fewer than 20 puzzles match the selected theme and rating bounds.',
      };
    }
    const sliced = sliceEvenly(matching, count);
    puzzleIds = sliced.map((p) => `lichess:${p.id}`);
  } else if (input.source_type === 'blunders') {
    const requestedCount = Math.min(500, Math.max(20, input.puzzle_count ?? 100));
    const blunders = db.prepare(`
      SELECT id FROM puzzle_attempts
      WHERE user_id = ? AND solved = 0
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(userId, requestedCount) as { id: number }[];

    if (blunders.length < 20) {
      return {
        ok: false,
        code: 'insufficient_blunders',
        error: 'At least 20 recorded blunders are required to generate a Woodpecker training set. Play and analyze more games first.',
      };
    }
    puzzleIds = blunders.map((b) => `blunder:${b.id}`);
  }

  const targetCycles = Math.min(7, Math.max(3, input.target_cycles ?? 6));
  const mode = input.mode === 'practice' ? 'practice' : 'strict';
  const restHours = Math.max(1, Math.min(168, input.rest_duration_hours ?? 24));
  const nowIso = new Date().toISOString();
  const sourceParams = JSON.stringify({
    preset_id: input.preset_id ?? null,
    theme: input.theme ?? null,
    rating_min: input.rating_min ?? null,
    rating_max: input.rating_max ?? null,
    requested_count: input.puzzle_count ?? null,
  });

  let createdId = 0;
  const tx = db.transaction(() => {
    const res = db.prepare(`
      INSERT INTO woodpecker_programs (
        user_id, title, description, source_type, source_params,
        puzzle_ids, total_puzzles, target_cycles, current_cycle,
        mode, rest_duration_hours, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'active', ?, ?)
    `).run(
      userId,
      input.title.trim(),
      description,
      input.source_type,
      sourceParams,
      JSON.stringify(puzzleIds),
      puzzleIds.length,
      targetCycles,
      mode,
      restHours,
      nowIso,
      nowIso,
    );
    createdId = Number(res.lastInsertRowid);

    db.prepare(`
      INSERT INTO woodpecker_cycles (
        program_id, cycle_number, target_duration_sec, total_puzzles, status, started_at
      ) VALUES (?, 1, NULL, ?, 'in_progress', ?)
    `).run(createdId, puzzleIds.length, nowIso);
  });
  tx();

  const details = getProgramDetails(userId, createdId)!;
  return { ok: true, program: details };
}

export function deleteProgram(userId: number, programId: number): boolean {
  const res = db.prepare(`
    DELETE FROM woodpecker_programs WHERE id = ? AND user_id = ?
  `).run(programId, userId);
  return res.changes > 0;
}

export function archiveProgram(userId: number, programId: number): boolean {
  const nowIso = new Date().toISOString();
  const res = db.prepare(`
    UPDATE woodpecker_programs
    SET status = 'archived', updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(nowIso, programId, userId);
  return res.changes > 0;
}

export type NextPuzzleResponse =
  | { ok: true; is_cycle_finished: boolean; puzzle: WoodpeckerPuzzlePayload | null; progress: { current_index: number; total: number; cycle_number: number; cycle_time_spent_sec: number; target_duration_sec: number | null; mode: 'strict' | 'practice' } }
  | { ok: false; status: 404 | 409; code: string; error: string };

export function getNextPuzzle(userId: number, programId: number, nowMs: number = Date.now()): NextPuzzleResponse {
  const rawProg = db.prepare(`
    SELECT * FROM woodpecker_programs WHERE id = ? AND user_id = ?
  `).get(programId, userId) as ProgramRow | undefined;
  if (!rawProg) {
    return { ok: false, status: 404, code: 'not_found', error: 'Program not found' };
  }

  const prog = checkAutoWakeFromRest(rawProg, nowMs);
  if (prog.status !== 'active') {
    return {
      ok: false,
      status: 409,
      code: 'cycle_not_active',
      error: `Program is currently ${prog.status}`,
    };
  }

  const cycle = db.prepare(`
    SELECT * FROM woodpecker_cycles WHERE program_id = ? AND cycle_number = ?
  `).get(prog.id, prog.current_cycle) as CycleRow | undefined;
  if (!cycle || cycle.status !== 'in_progress') {
    return {
      ok: false,
      status: 409,
      code: 'cycle_not_in_progress',
      error: 'Active cycle is not in progress',
    };
  }

  const puzzleIds = JSON.parse(prog.puzzle_ids) as string[];
  const attempts = db.prepare(`
    SELECT * FROM woodpecker_attempts WHERE cycle_id = ?
  `).all(cycle.id) as AttemptRow[];
  const attemptByPuzzle = new Map<string, AttemptRow>();
  for (const a of attempts) attemptByPuzzle.set(a.puzzle_id, a);

  // Find the first puzzle in the frozen sequence that is not completed yet:
  // In strict mode: any existing attempt row means the puzzle was completed (solved or failed).
  // In practice mode: a row with solved = 0 is still open (retry_mistake) and stays at the current index.
  let nextIdx = -1;
  for (let i = 0; i < puzzleIds.length; i++) {
    const pid = puzzleIds[i]!;
    const att = attemptByPuzzle.get(pid);
    if (!att) {
      nextIdx = i;
      break;
    }
    if (prog.mode === 'practice' && att.solved === 0) {
      nextIdx = i;
      break;
    }
  }

  if (nextIdx === -1) {
    return {
      ok: true,
      is_cycle_finished: true,
      puzzle: null,
      progress: {
        current_index: puzzleIds.length,
        total: puzzleIds.length,
        cycle_number: cycle.cycle_number,
        cycle_time_spent_sec: cycle.actual_duration_sec,
        target_duration_sec: cycle.target_duration_sec,
        mode: prog.mode,
      },
    };
  }

  const targetId = puzzleIds[nextIdx]!;
  const payload = resolveWoodpeckerPuzzle(targetId, userId);
  if (!payload) {
    return { ok: false, status: 404, code: 'puzzle_not_found', error: 'Referenced puzzle could not be resolved' };
  }

  // Stamp server clock start time if not already stamped for this active puzzle
  const nowIso = new Date(nowMs).toISOString();
  db.prepare(`
    UPDATE woodpecker_cycles SET puzzle_started_at = ? WHERE id = ?
  `).run(nowIso, cycle.id);

  return {
    ok: true,
    is_cycle_finished: false,
    puzzle: payload,
    progress: {
      current_index: nextIdx,
      total: puzzleIds.length,
      cycle_number: cycle.cycle_number,
      cycle_time_spent_sec: Math.round(cycle.elapsed_ms / 1000),
      target_duration_sec: cycle.target_duration_sec,
      mode: prog.mode,
    },
  };
}

export interface AttemptInput {
  puzzle_id: string;
  outcome: 'solved' | 'failed' | 'retry_mistake';
  time_spent_ms: number;
  played_moves?: string[];
}

export type RecordAttemptResponse =
  | {
      ok: true;
      recorded: boolean;
      cycle_completed: boolean;
      program_completed: boolean;
      next_cycle_number: number | null;
      rest_until: string | null;
      elapsed_ms: number;
    }
  | { ok: false; status: 400 | 404 | 409; code: string; error: string };

export function recordWoodpeckerAttempt(
  userId: number,
  programId: number,
  input: AttemptInput,
  nowMs: number = Date.now(),
): RecordAttemptResponse {
  const prog = db.prepare(`
    SELECT * FROM woodpecker_programs WHERE id = ? AND user_id = ?
  `).get(programId, userId) as ProgramRow | undefined;
  if (!prog) {
    return { ok: false, status: 404, code: 'not_found', error: 'Program not found' };
  }

  if (prog.status !== 'active') {
    return { ok: false, status: 409, code: 'program_not_active', error: `Program is currently ${prog.status}` };
  }

  const cycle = db.prepare(`
    SELECT * FROM woodpecker_cycles WHERE program_id = ? AND cycle_number = ?
  `).get(prog.id, prog.current_cycle) as CycleRow | undefined;
  if (!cycle || cycle.status !== 'in_progress') {
    return { ok: false, status: 409, code: 'cycle_not_in_progress', error: 'Active cycle is not in progress' };
  }

  const puzzleIds = JSON.parse(prog.puzzle_ids) as string[];
  if (!puzzleIds.includes(input.puzzle_id)) {
    return { ok: false, status: 400, code: 'invalid_puzzle', error: 'Puzzle does not belong to this program' };
  }

  // Server-authoritative duration calculation
  let serverDurationMs = input.time_spent_ms;
  if (cycle.puzzle_started_at) {
    const startMs = Date.parse(cycle.puzzle_started_at.endsWith('Z') ? cycle.puzzle_started_at : `${cycle.puzzle_started_at}Z`);
    if (Number.isFinite(startMs)) {
      serverDurationMs = Math.max(0, nowMs - startMs);
    }
  }
  const recordedTimeMs = Math.min(MAX_ATTEMPT_MS, Math.max(MIN_ATTEMPT_MS, serverDurationMs));

  if (Math.abs(serverDurationMs - input.time_spent_ms) > 3000) {
    console.warn(`[woodpecker] clock drift detected on program ${prog.id}: server=${serverDurationMs}ms, client=${input.time_spent_ms}ms`);
  }

  // Check if this puzzle was missed in any earlier cycle of this program
  const previousMiss = db.prepare(`
    SELECT 1 FROM woodpecker_attempts wa
    JOIN woodpecker_cycles wc ON wc.id = wa.cycle_id
    WHERE wc.program_id = ? AND wc.cycle_number < ? AND wa.puzzle_id = ? AND wa.first_try_solved = 0
    LIMIT 1
  `).get(prog.id, cycle.cycle_number, input.puzzle_id);

  const nowIso = new Date(nowMs).toISOString();
  const existing = db.prepare(`
    SELECT * FROM woodpecker_attempts WHERE cycle_id = ? AND puzzle_id = ?
  `).get(cycle.id, input.puzzle_id) as AttemptRow | undefined;

  let cycleCompleted = false;
  let programCompleted = false;
  let nextCycleNumber: number | null = null;
  let restUntil: string | null = null;
  let newElapsedMs = cycle.elapsed_ms + recordedTimeMs;

  const tx = db.transaction(() => {
    const movesJson = input.played_moves ? JSON.stringify(input.played_moves) : null;

    if (!existing) {
      const firstTrySolved = input.outcome === 'solved' ? 1 : 0;
      const solved = input.outcome === 'solved' ? 1 : 0;
      const mistakesCount = input.outcome === 'solved' ? 0 : 1;
      const blunderRepeated = firstTrySolved === 0 && previousMiss ? 1 : 0;

      db.prepare(`
        INSERT INTO woodpecker_attempts (
          cycle_id, puzzle_id, first_try_solved, solved, mistakes_count,
          time_spent_ms, played_moves_uci, blunder_repeated, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        cycle.id,
        input.puzzle_id,
        firstTrySolved,
        solved,
        mistakesCount,
        recordedTimeMs,
        movesJson,
        blunderRepeated,
        nowIso,
        nowIso,
      );
    } else {
      // Updating an existing Practice Mode attempt row
      const solved = input.outcome === 'solved' ? 1 : 0;
      const mistakesCount = input.outcome === 'retry_mistake' || input.outcome === 'failed'
        ? existing.mistakes_count + 1
        : existing.mistakes_count;
      const totalPuzzleTime = existing.time_spent_ms + recordedTimeMs;

      db.prepare(`
        UPDATE woodpecker_attempts
        SET solved = ?, mistakes_count = ?, time_spent_ms = ?, played_moves_uci = COALESCE(?, played_moves_uci), updated_at = ?
        WHERE id = ?
      `).run(solved, mistakesCount, totalPuzzleTime, movesJson, nowIso, existing.id);
    }

    // Recompute cycle statistics
    const stats = db.prepare(`
      SELECT
        COUNT(*) AS attempted,
        SUM(CASE WHEN first_try_solved = 1 THEN 1 ELSE 0 END) AS first_try_wins,
        SUM(CASE WHEN solved = 1 THEN 1 ELSE 0 END) AS solved_cnt
      FROM woodpecker_attempts
      WHERE cycle_id = ?
    `).get(cycle.id) as { attempted: number; first_try_wins: number | null; solved_cnt: number | null };

    const firstTryWins = stats.first_try_wins ?? 0;
    const solvedCnt = stats.solved_cnt ?? 0;
    const actualDurationSec = Math.round(newElapsedMs / 1000);
    const accuracyPct = (firstTryWins / prog.total_puzzles) * 100;
    const avgTimeSec = stats.attempted > 0 ? actualDurationSec / stats.attempted : 0;

    // Determine whether all puzzles in the cycle are finished
    const openPracticeCount = prog.mode === 'practice'
      ? (db.prepare(`SELECT COUNT(*) AS n FROM woodpecker_attempts WHERE cycle_id = ? AND solved = 0`).get(cycle.id) as { n: number }).n
      : 0;
    const isFinished = prog.mode === 'strict'
      ? stats.attempted >= prog.total_puzzles
      : solvedCnt >= prog.total_puzzles || (input.outcome !== 'retry_mistake' && stats.attempted >= prog.total_puzzles && openPracticeCount === 0);

    // Re-stamp puzzle_started_at on retry_mistake, clear to NULL when puzzle is finished
    const nextStartedAt = input.outcome === 'retry_mistake' ? nowIso : null;

    if (!isFinished || input.outcome === 'retry_mistake') {
      db.prepare(`
        UPDATE woodpecker_cycles
        SET elapsed_ms = ?, actual_duration_sec = ?, solved_puzzles = ?,
            accuracy_pct = ?, avg_time_per_puzzle_sec = ?, puzzle_started_at = ?
        WHERE id = ?
      `).run(newElapsedMs, actualDurationSec, firstTryWins, accuracyPct, avgTimeSec, nextStartedAt, cycle.id);

      db.prepare(`UPDATE woodpecker_programs SET updated_at = ? WHERE id = ?`).run(nowIso, prog.id);
    } else {
      cycleCompleted = true;
      if (cycle.cycle_number >= prog.target_cycles) {
        programCompleted = true;
        db.prepare(`
          UPDATE woodpecker_cycles
          SET elapsed_ms = ?, actual_duration_sec = ?, solved_puzzles = ?,
              accuracy_pct = ?, avg_time_per_puzzle_sec = ?, status = 'completed',
              completed_at = ?, puzzle_started_at = NULL
          WHERE id = ?
        `).run(newElapsedMs, actualDurationSec, firstTryWins, accuracyPct, avgTimeSec, nowIso, cycle.id);

        db.prepare(`
          UPDATE woodpecker_programs
          SET status = 'completed', completed_at = ?, updated_at = ?
          WHERE id = ?
        `).run(nowIso, nowIso, prog.id);
      } else {
        nextCycleNumber = cycle.cycle_number + 1;
        const restHours = cycle.cycle_number === 1 ? 2 * prog.rest_duration_hours : prog.rest_duration_hours;
        restUntil = new Date(nowMs + restHours * 3600 * 1000).toISOString();

        db.prepare(`
          UPDATE woodpecker_cycles
          SET elapsed_ms = ?, actual_duration_sec = ?, solved_puzzles = ?,
              accuracy_pct = ?, avg_time_per_puzzle_sec = ?, status = 'completed',
              completed_at = ?, rest_until = ?, puzzle_started_at = NULL
          WHERE id = ?
        `).run(newElapsedMs, actualDurationSec, firstTryWins, accuracyPct, avgTimeSec, nowIso, restUntil, cycle.id);

        db.prepare(`
          UPDATE woodpecker_programs
          SET status = 'resting', updated_at = ?
          WHERE id = ?
        `).run(nowIso, prog.id);
      }
    }
  });
  tx();

  return {
    ok: true,
    recorded: true,
    cycle_completed: cycleCompleted,
    program_completed: programCompleted,
    next_cycle_number: nextCycleNumber,
    rest_until: restUntil,
    elapsed_ms: newElapsedMs,
  };
}

export function pauseSession(
  userId: number,
  programId: number,
  nowMs: number = Date.now(),
): { ok: true; status: 'paused'; elapsed_ms: number } | { ok: false; status: 404 | 409; code: string; error: string } {
  const prog = db.prepare(`
    SELECT * FROM woodpecker_programs WHERE id = ? AND user_id = ?
  `).get(programId, userId) as ProgramRow | undefined;
  if (!prog) return { ok: false, status: 404, code: 'not_found', error: 'Program not found' };
  if (prog.status !== 'active') {
    return { ok: false, status: 409, code: 'not_active', error: `Cannot pause program in ${prog.status} state` };
  }

  const cycle = db.prepare(`
    SELECT * FROM woodpecker_cycles WHERE program_id = ? AND cycle_number = ?
  `).get(prog.id, prog.current_cycle) as CycleRow | undefined;
  if (!cycle || cycle.status !== 'in_progress') {
    return { ok: false, status: 409, code: 'cycle_not_in_progress', error: 'Cycle is already paused or completed' };
  }

  let newElapsedMs = cycle.elapsed_ms;
  if (cycle.puzzle_started_at) {
    const startMs = Date.parse(cycle.puzzle_started_at.endsWith('Z') ? cycle.puzzle_started_at : `${cycle.puzzle_started_at}Z`);
    if (Number.isFinite(startMs)) {
      const delta = Math.min(MAX_ATTEMPT_MS, Math.max(0, nowMs - startMs));
      newElapsedMs += delta;
    }
  }

  const nowIso = new Date(nowMs).toISOString();
  const actualSec = Math.round(newElapsedMs / 1000);

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE woodpecker_cycles
      SET status = 'paused', elapsed_ms = ?, actual_duration_sec = ?, paused_at = ?, puzzle_started_at = NULL
      WHERE id = ?
    `).run(newElapsedMs, actualSec, nowIso, cycle.id);

    db.prepare(`
      UPDATE woodpecker_programs SET status = 'paused', updated_at = ? WHERE id = ?
    `).run(nowIso, prog.id);
  });
  tx();

  return { ok: true, status: 'paused', elapsed_ms: newElapsedMs };
}

export function resumeSession(
  userId: number,
  programId: number,
  nowMs: number = Date.now(),
): { ok: true; status: 'in_progress' } | { ok: false; status: 404 | 409; code: string; error: string } {
  const prog = db.prepare(`
    SELECT * FROM woodpecker_programs WHERE id = ? AND user_id = ?
  `).get(programId, userId) as ProgramRow | undefined;
  if (!prog) return { ok: false, status: 404, code: 'not_found', error: 'Program not found' };
  if (prog.status !== 'paused') {
    return { ok: false, status: 409, code: 'not_paused', error: 'Program is not in a paused state' };
  }

  const cycle = db.prepare(`
    SELECT * FROM woodpecker_cycles WHERE program_id = ? AND cycle_number = ?
  `).get(prog.id, prog.current_cycle) as CycleRow | undefined;
  if (!cycle || cycle.status !== 'paused') {
    return { ok: false, status: 409, code: 'cycle_not_paused', error: 'Cycle is not in a paused state' };
  }

  const nowIso = new Date(nowMs).toISOString();
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE woodpecker_cycles
      SET status = 'in_progress', paused_at = NULL, puzzle_started_at = ?
      WHERE id = ?
    `).run(nowIso, cycle.id);

    db.prepare(`
      UPDATE woodpecker_programs SET status = 'active', updated_at = ? WHERE id = ?
    `).run(nowIso, prog.id);
  });
  tx();

  return { ok: true, status: 'in_progress' };
}

export function skipRestPeriod(
  userId: number,
  programId: number,
): { ok: true; current_cycle: number; status: 'active' } | { ok: false; status: 404 | 409; code: string; error: string } {
  const prog = db.prepare(`
    SELECT * FROM woodpecker_programs WHERE id = ? AND user_id = ?
  `).get(programId, userId) as ProgramRow | undefined;
  if (!prog) return { ok: false, status: 404, code: 'not_found', error: 'Program not found' };
  if (prog.status !== 'resting') {
    return { ok: false, status: 409, code: 'not_resting', error: 'Program is not in resting status' };
  }

  const prevCycle = db.prepare(`
    SELECT * FROM woodpecker_cycles WHERE program_id = ? AND cycle_number = ?
  `).get(prog.id, prog.current_cycle) as CycleRow | undefined;
  if (!prevCycle) {
    return { ok: false, status: 409, code: 'missing_cycle', error: 'Previous cycle record not found' };
  }

  const updated = advanceToNextCycle(prog, prevCycle);
  return { ok: true, current_cycle: updated.current_cycle, status: 'active' };
}

export function getProgramSummaryAnalytics(userId: number, programId: number): ProgramSummaryAnalytics | null {
  const prog = db.prepare(`
    SELECT * FROM woodpecker_programs WHERE id = ? AND user_id = ?
  `).get(programId, userId) as ProgramRow | undefined;
  if (!prog) return null;

  const cycles = db.prepare(`
    SELECT * FROM woodpecker_cycles WHERE program_id = ? ORDER BY cycle_number ASC
  `).all(prog.id) as CycleRow[];

  const completedCycles = cycles.filter((c) => c.status === 'completed');
  const firstCycle = completedCycles[0] ?? cycles[0];
  const latestCycle = completedCycles.at(-1) ?? cycles.at(-1);

  let speedupFactor = 1.0;
  let accuracyDeltaPct = 0.0;

  if (firstCycle && latestCycle && firstCycle.cycle_number !== latestCycle.cycle_number) {
    if (latestCycle.actual_duration_sec > 0) {
      speedupFactor = Math.round((firstCycle.actual_duration_sec / latestCycle.actual_duration_sec) * 100) / 100;
    }
    accuracyDeltaPct = Math.round((latestCycle.accuracy_pct - firstCycle.accuracy_pct) * 10) / 10;
  }

  // Find stubborn puzzles: puzzles missed (first_try_solved = 0) across 2 or more cycles
  const failedRows = db.prepare(`
    SELECT wa.puzzle_id, wc.cycle_number
    FROM woodpecker_attempts wa
    JOIN woodpecker_cycles wc ON wc.id = wa.cycle_id
    WHERE wc.program_id = ? AND wa.first_try_solved = 0
    ORDER BY wc.cycle_number ASC
  `).all(prog.id) as { puzzle_id: string; cycle_number: number }[];

  const failsByPuzzle = new Map<string, number[]>();
  for (const r of failedRows) {
    const list = failsByPuzzle.get(r.puzzle_id) ?? [];
    if (!list.includes(r.cycle_number)) list.push(r.cycle_number);
    failsByPuzzle.set(r.puzzle_id, list);
  }

  const stubbornPuzzles: ProgramSummaryAnalytics['stubborn_puzzles'] = [];
  for (const [puzzleId, failedInCycles] of failsByPuzzle.entries()) {
    if (failedInCycles.length >= 2) {
      const resolved = resolveWoodpeckerPuzzle(puzzleId, userId);
      if (resolved) {
        stubbornPuzzles.push({
          puzzle_id: puzzleId,
          fen: resolved.fen,
          moves: resolved.moves,
          has_setup_move: resolved.has_setup_move,
          failed_in_cycles: failedInCycles,
          themes: resolved.themes,
        });
      }
    }
  }

  return {
    program_id: prog.id,
    speedup_factor: speedupFactor,
    accuracy_delta_pct: accuracyDeltaPct,
    cycle_metrics: cycles.map(toCycleDetails),
    stubborn_puzzles: stubbornPuzzles,
  };
}

/** Achievement stats helper for server/src/routes/achievements.ts. */
export function woodpeckerAchievementStats(userId: number): {
  finishedProgram: boolean;
  patternMachine: boolean;
  subconsciousInstinct: boolean;
} {
  const completedProgs = db.prepare(`
    SELECT id, target_cycles FROM woodpecker_programs
    WHERE user_id = ? AND status = 'completed'
  `).all(userId) as { id: number; target_cycles: number }[];

  let finishedProgram = completedProgs.length > 0;
  let patternMachine = false;
  let subconsciousInstinct = false;

  // Also check archived programs that had completed their target cycles
  const allUserProgs = db.prepare(`
    SELECT id, target_cycles, completed_at FROM woodpecker_programs
    WHERE user_id = ? AND completed_at IS NOT NULL
  `).all(userId) as { id: number; target_cycles: number; completed_at: string | null }[];

  if (allUserProgs.length > 0) finishedProgram = true;

  for (const p of allUserProgs) {
    const cycles = db.prepare(`
      SELECT cycle_number, actual_duration_sec, accuracy_pct, status
      FROM woodpecker_cycles
      WHERE program_id = ? AND status = 'completed'
      ORDER BY cycle_number ASC
    `).all(p.id) as { cycle_number: number; actual_duration_sec: number; accuracy_pct: number; status: string }[];

    const first = cycles[0];
    const final = cycles.find((c) => c.cycle_number === p.target_cycles) ?? cycles.at(-1);
    if (final && final.accuracy_pct >= 95) {
      patternMachine = true;
    }
    if (first && final && first.cycle_number !== final.cycle_number && final.actual_duration_sec > 0) {
      const speedup = first.actual_duration_sec / final.actual_duration_sec;
      if (speedup >= 3.0) {
        subconsciousInstinct = true;
      }
    }
  }

  return { finishedProgram, patternMachine, subconsciousInstinct };
}
