import { chatStream } from "./llm.js";
import { systemPrompt } from "./locales.js";
import { correctionNote, explainMovePrompt, hintPrompt } from "./facts.js";
import { contradiction, explainCoaching, fallbackText, hintCoaching, type CoachAction } from "./coaching.js";
import type { Audience, Classification, Language } from "../types.js";

// The coach's two jobs end to end, shared by the /api/coach routes and the
// in-game auto-coach on the play socket, so both give the same answer.
//
// The explanation is generated in full and checked against the engine's
// verdict before anyone sees it: a model that praises a blunder (#37) gets
// one retry with a correction, and if it does it again the player gets a
// plain answer built from the facts instead. A coach that contradicts the
// engine is worse than no coach.

export interface ExplainParams {
  fen: string;
  player: "White" | "Black";
  played_san: string;
  best_san: string | null;
  classification: Classification;
  cp_loss: number;
  eval_before_cp?: number | null;
  eval_after_cp?: number | null;
  pv_san?: string[];
  history?: string[];
  user_perspective?: boolean;
}

export interface CoachAnswer {
  text: string;
  actions: CoachAction[];
  /** How the text came about — for logs and tests. */
  source: "llm" | "llm_retry" | "fallback";
}

interface RunOpts { signal?: AbortSignal; numPredict?: number; temperature?: number }

async function generate(sys: string, usr: string, opts: RunOpts): Promise<string> {
  let acc = "";
  await chatStream(
    [{ role: "system", content: sys }, { role: "user", content: usr }],
    (t) => { acc += t; },
    { temperature: opts.temperature ?? 0.15, numPredict: opts.numPredict ?? 360, signal: opts.signal },
  );
  return acc.trim();
}

/** Strip a reasoning model's <think> block, which isn't part of the answer. */
const clean = (t: string) => t.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

export async function coachExplain(
  params: ExplainParams,
  userId: number,
  lang: Language,
  aud: Audience,
  opts: RunOpts = {},
): Promise<CoachAnswer> {
  // The move is the user's own when they're the one asking about their game
  // (Play), or in Game Review when the move belongs to their colour.
  const coaching = await explainCoaching({
    fen: params.fen,
    played_san: params.played_san,
    best_san: params.best_san,
    classification: params.classification,
    userId,
    ownMove: params.user_perspective ?? false,
  }, lang, aud);

  const input = {
    ...params,
    // Play doesn't send evaluations; the coach's own engine run fills them in.
    eval_before_cp: params.eval_before_cp ?? coaching.eval_before_cp,
    eval_after_cp: params.eval_after_cp ?? coaching.eval_after_cp,
  };
  const sys = systemPrompt(aud, lang);
  const usr = explainMovePrompt(input, lang, aud, coaching.facts);

  let first = "";
  try {
    first = clean(await generate(sys, usr, opts));
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    console.warn(`[coach] generate failed, falling back to facts: ${(err as Error).message}`);
    return { text: fallbackText(coaching.facts, lang), actions: coaching.actions, source: "fallback" };
  }
  if (first && !contradiction(first, params.classification, lang)) {
    return { text: first, actions: coaching.actions, source: "llm" };
  }
  const verdict = String(coaching.facts.verdict ?? "");
  console.warn(`[coach] answer contradicted the verdict (${params.classification}); retrying`);
  const retryPrompt = explainMovePrompt(input, lang, aud, coaching.facts, correctionNote(lang, verdict));
  let second = "";
  try {
    second = clean(await generate(sys, retryPrompt, { ...opts, temperature: 0.05 }));
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    console.warn(`[coach] retry failed: ${(err as Error).message}`);
  }
  if (second && !contradiction(second, params.classification, lang)) {
    return { text: second, actions: coaching.actions, source: "llm_retry" };
  }
  console.warn(`[coach] retry contradicted the verdict too; using the facts-only answer`);
  return { text: fallbackText(coaching.facts, lang), actions: coaching.actions, source: "fallback" };
}

/** A hint streams straight through: it names no move and passes no verdict,
 *  so there is nothing for it to contradict. */
export async function coachHint(
  fen: string,
  history: string[],
  userId: number,
  lang: Language,
  aud: Audience,
  onChunk: (t: string) => void | Promise<void>,
  opts: RunOpts = {},
): Promise<{ actions: CoachAction[] }> {
  const coaching = await hintCoaching(fen, userId, lang, aud);
  const sys = systemPrompt(aud, lang);
  const usr = hintPrompt(fen, aud, lang, history, coaching.facts);
  await chatStream(
    [{ role: "system", content: sys }, { role: "user", content: usr }],
    onChunk,
    { temperature: opts.temperature ?? 0.3, numPredict: opts.numPredict ?? 220, signal: opts.signal },
  );
  return { actions: coaching.actions };
}
