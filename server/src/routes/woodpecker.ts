// Woodpecker Method tactical training routes — mounted at /api/woodpecker.
//
//   GET    /api/woodpecker/presets              built-in puzzle presets
//   GET    /api/woodpecker/programs             user's training programs
//   POST   /api/woodpecker/programs             create and freeze a new program
//   GET    /api/woodpecker/programs/:id         program details & cycle history
//   DELETE /api/woodpecker/programs/:id         hard-delete a program
//   POST   /api/woodpecker/programs/:id/archive soft-archive a program
//   GET    /api/woodpecker/programs/:id/next    next puzzle & server clock stamp
//   POST   /api/woodpecker/programs/:id/attempt record attempt & cycle transition
//   POST   /api/woodpecker/programs/:id/pause   pause cycle stopwatch
//   POST   /api/woodpecker/programs/:id/resume  resume cycle stopwatch
//   POST   /api/woodpecker/programs/:id/skip-rest bypass rest countdown
//   GET    /api/woodpecker/programs/:id/summary analytics & stubborn blunders

import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import {
  WOODPECKER_PRESETS,
  archiveProgram,
  createProgram,
  deleteProgram,
  getNextPuzzle,
  getProgramDetails,
  getProgramSummaryAnalytics,
  listPrograms,
  pauseSession,
  recordWoodpeckerAttempt,
  resumeSession,
  skipRestPeriod,
} from '../chess/woodpecker.js';

const router = new Hono();
router.use('*', requireAuth);

router.get('/presets', (c) => {
  return c.json({ presets: WOODPECKER_PRESETS });
});

router.get('/programs', (c) => {
  const me = c.get('user');
  return c.json({ programs: listPrograms(me.id) });
});

const createProgramSchema = z.object({
  title: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  source_type: z.enum(['preset', 'theme', 'blunders']),
  preset_id: z.string().nullable().optional(),
  theme: z.string().nullable().optional(),
  puzzle_count: z.number().int().min(20).max(500).optional(),
  rating_min: z.number().int().min(300).max(3000).nullable().optional(),
  rating_max: z.number().int().min(300).max(3000).nullable().optional(),
  target_cycles: z.number().int().min(3).max(7).optional(),
  mode: z.enum(['strict', 'practice']).optional(),
  rest_duration_hours: z.number().int().min(1).max(168).optional(),
});

router.post('/programs', async (c) => {
  const me = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const parsed = createProgramSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid input parameters', code: 'invalid_input' }, 400);
  }
  const result = createProgram(me.id, parsed.data);
  if (!result.ok) {
    return c.json({ error: result.error, code: result.code }, 400);
  }
  return c.json({ program: result.program }, 201);
});

function parseId(raw: string): number | null {
  const id = Number.parseInt(raw, 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

router.get('/programs/:id', (c) => {
  const me = c.get('user');
  const id = parseId(c.req.param('id'));
  if (!id) return c.json({ error: 'Program not found', code: 'not_found' }, 404);
  const details = getProgramDetails(me.id, id);
  if (!details) return c.json({ error: 'Program not found', code: 'not_found' }, 404);
  return c.json(details);
});

router.delete('/programs/:id', (c) => {
  const me = c.get('user');
  const id = parseId(c.req.param('id'));
  if (!id) return c.json({ error: 'Program not found', code: 'not_found' }, 404);
  const deleted = deleteProgram(me.id, id);
  if (!deleted) return c.json({ error: 'Program not found', code: 'not_found' }, 404);
  return c.json({ success: true });
});

router.post('/programs/:id/archive', (c) => {
  const me = c.get('user');
  const id = parseId(c.req.param('id'));
  if (!id) return c.json({ error: 'Program not found', code: 'not_found' }, 404);
  const archived = archiveProgram(me.id, id);
  if (!archived) return c.json({ error: 'Program not found', code: 'not_found' }, 404);
  return c.json({ status: 'archived' });
});

router.get('/programs/:id/next', (c) => {
  const me = c.get('user');
  const id = parseId(c.req.param('id'));
  if (!id) return c.json({ error: 'Program not found', code: 'not_found' }, 404);
  const res = getNextPuzzle(me.id, id);
  if (!res.ok) return c.json({ error: res.error, code: res.code }, res.status);
  return c.json({
    puzzle: res.puzzle,
    progress: res.progress,
    is_cycle_finished: res.is_cycle_finished,
  });
});

const attemptSchema = z.object({
  puzzle_id: z.string().min(1).max(64),
  outcome: z.enum(['solved', 'failed', 'retry_mistake']),
  time_spent_ms: z.number().int().min(0),
  played_moves: z.array(z.string()).optional(),
});

router.post('/programs/:id/attempt', async (c) => {
  const me = c.get('user');
  const id = parseId(c.req.param('id'));
  if (!id) return c.json({ error: 'Program not found', code: 'not_found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const parsed = attemptSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid attempt parameters', code: 'invalid_input' }, 400);
  }
  const res = recordWoodpeckerAttempt(me.id, id, parsed.data);
  if (!res.ok) return c.json({ error: res.error, code: res.code }, res.status);
  return c.json({
    recorded: res.recorded,
    cycle_completed: res.cycle_completed,
    program_completed: res.program_completed,
    next_cycle_number: res.next_cycle_number,
    rest_until: res.rest_until,
    elapsed_ms: res.elapsed_ms,
  });
});

router.post('/programs/:id/pause', (c) => {
  const me = c.get('user');
  const id = parseId(c.req.param('id'));
  if (!id) return c.json({ error: 'Program not found', code: 'not_found' }, 404);
  const res = pauseSession(me.id, id);
  if (!res.ok) return c.json({ error: res.error, code: res.code }, res.status);
  return c.json({ status: res.status, elapsed_ms: res.elapsed_ms });
});

router.post('/programs/:id/resume', (c) => {
  const me = c.get('user');
  const id = parseId(c.req.param('id'));
  if (!id) return c.json({ error: 'Program not found', code: 'not_found' }, 404);
  const res = resumeSession(me.id, id);
  if (!res.ok) return c.json({ error: res.error, code: res.code }, res.status);
  return c.json({ status: res.status });
});

router.post('/programs/:id/skip-rest', (c) => {
  const me = c.get('user');
  const id = parseId(c.req.param('id'));
  if (!id) return c.json({ error: 'Program not found', code: 'not_found' }, 404);
  const res = skipRestPeriod(me.id, id);
  if (!res.ok) return c.json({ error: res.error, code: res.code }, res.status);
  return c.json({ current_cycle: res.current_cycle, status: res.status });
});

router.get('/programs/:id/summary', (c) => {
  const me = c.get('user');
  const id = parseId(c.req.param('id'));
  if (!id) return c.json({ error: 'Program not found', code: 'not_found' }, 404);
  const summary = getProgramSummaryAnalytics(me.id, id);
  if (!summary) return c.json({ error: 'Program not found', code: 'not_found' }, 404);
  return c.json(summary);
});

export default router;
