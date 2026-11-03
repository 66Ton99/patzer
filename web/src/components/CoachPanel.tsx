import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Sparkles, Volume2, VolumeX, Pause, Play, Info, GraduationCap, Puzzle } from 'lucide-react';
import { useAuth } from '../state/auth';
import { speak, cancel as cancelSpeak } from '../lib/tts';
import { renderMarkdown, stripReasoning } from '../lib/markdown';
import { normalizeLanguage } from '../lib/languages';
import { ThinkingDots } from './Spinner';

const MUTE_STORAGE_KEY = 'coach.mute';

/** A next step the server suggests with an answer — rendered as a link, never
 *  written by the model, so it can't point anywhere that doesn't exist. */
export type CoachAction = { kind: 'learn'; lesson: string } | { kind: 'train' };

/** Parse one SSE block into its event name and data (data lines joined with
 *  newlines, as the SSE spec says). */
export function parseSseBlock(block: string): { event: string; data: string } {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    // Strip exactly ONE leading space after `data:`. trimStart() would eat
    // token-leading spaces sent by the LLM and glue words together.
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  return { event, data: data.join('\n') };
}

interface Props {
  systemConfigured: boolean;
  request: (() => { url: string; body: Record<string, unknown> }) | null;
  /** When true, auto-fetches whenever `triggerKey` changes (debounced). */
  autoPlay?: boolean;
  /** Changes to this value re-trigger the request in autoPlay mode. */
  triggerKey?: string | number;
  /** Debounce in ms before firing in autoPlay mode (default 600). */
  debounceMs?: number;
  /** Compact rendering for tight spaces. */
  compact?: boolean;
}

export default function CoachPanel({ systemConfigured, request, autoPlay, triggerKey, debounceMs = 600, compact }: Props) {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actions, setActions] = useState<CoachAction[]>([]);
  const [speaking, setSpeaking] = useState(false);
  // The exact request body sent on the most-recent ask, surfaced via the
  // "Show context" toggle so the user can see what FACTS the LLM had to work
  // with — answers "what is actually being injected into the prompt?"
  const [lastBody, setLastBody] = useState<Record<string, unknown> | null>(null);
  const [showContext, setShowContext] = useState(false);
  // Mute state persists across mount/unmount (jumping to ply 0 unmounts the
  // panel; without persistence, the user's mute would silently reset).
  const [muted, setMutedState] = useState<boolean>(() => {
    try { return localStorage.getItem(MUTE_STORAGE_KEY) === '1'; } catch { return false; }
  });
  const setMuted = (v: boolean) => {
    setMutedState(v);
    try { localStorage.setItem(MUTE_STORAGE_KEY, v ? '1' : '0'); } catch { /* ignore */ }
  };
  // `ask()` closes over `muted` at the render that created it, so muting
  // mid-request left the finally-block below reading a stale `false` and the
  // coach spoke anyway — the mute button looked broken. Read it from a ref.
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<number | null>(null);

  async function ask() {
    if (!request) return;
    cancelSpeak(); setSpeaking(false);
    abortRef.current?.abort();
    const ac = new AbortController(); abortRef.current = ac;

    setText(''); setBusy(true); setError(null); setActions([]);
    const { url, body } = request();
    const uiLang = normalizeLanguage(i18n.language);
    const bodyWithLang = { language: uiLang, ...body };
    setLastBody(bodyWithLang);
    let acc = '';
    try {
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'patzer' },
        body: JSON.stringify(bodyWithLang),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        setError(`HTTP ${res.status}`); setBusy(false); return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          const { event, data } = parseSseBlock(block);
          if (event === 'message') {
            acc += data;
            setText(acc);
          } else if (event === 'actions') {
            try { setActions(JSON.parse(data) as CoachAction[]); } catch { /* ignore */ }
          } else if (event === 'error') {
            setError(t('coach.error'));
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message);
    } finally {
      setBusy(false);
      if (autoPlay && acc.trim() && user?.profile.tts_enabled && !mutedRef.current) {
        playTts(acc);
      }
    }
  }

  function playTts(s?: string) {
    const content = s ?? text;
    if (!content.trim() || !user || mutedRef.current) return;
    setSpeaking(true);
    const uiLang = normalizeLanguage(i18n.language);
    const u = speak(content, {
      voice: user.profile.tts_voice,
      rate: user.profile.tts_rate,
      pitch: user.profile.tts_pitch,
      lang: uiLang || user.profile.language,
    });
    if (u) u.onend = () => setSpeaking(false);
  }

  function toggleMute() {
    if (muted) { setMuted(false); return; }
    setMuted(true);
    abortRef.current?.abort();
    cancelSpeak(); setSpeaking(false); setBusy(false);
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
  }

  // Always-on mode: re-fetch (debounced) when triggerKey changes
  useEffect(() => {
    if (!autoPlay || !request || muted) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => { void ask(); }, debounceMs);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggerKey, autoPlay, muted]);

  useEffect(() => () => { abortRef.current?.abort(); cancelSpeak(); }, []);

  if (!systemConfigured) {
    return (
      <div className="card p-4 text-sm text-ink-500">
        {t('coach.notConfigured')}
      </div>
    );
  }

  return (
    <div className={`card overflow-hidden ${compact ? 'p-3' : 'p-4'}`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 font-semibold">
          <Sparkles className="h-4 w-4 shrink-0 text-accent-500" />
          <span className="truncate">{t('coach.title')}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!autoPlay && request && (
            <button onClick={ask} disabled={busy} className="btn-secondary text-xs">
              {t('coach.askExplain', { cls: '?' })}
            </button>
          )}
          {autoPlay && (
            <button
              onClick={toggleMute}
              className="btn-ghost p-1.5"
              title={muted ? t('coach.resume') : t('coach.mute')}
            >
              {muted ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
            </button>
          )}
          {lastBody && (
            <button
              onClick={() => setShowContext((s) => !s)}
              className={`btn-ghost p-1.5 ${showContext ? 'text-accent-600' : ''}`}
              title={t('coach.showFacts')}
            >
              <Info className="h-4 w-4" />
            </button>
          )}
          {text && !muted && (
            speaking
              ? <button onClick={() => { cancelSpeak(); setSpeaking(false); }} className="btn-ghost p-1.5"><VolumeX className="h-4 w-4" /></button>
              : <button onClick={() => playTts()} className="btn-ghost p-1.5"><Volume2 className="h-4 w-4" /></button>
          )}
        </div>
      </div>
      {muted && <div className="text-sm italic text-ink-400">{t('coach.muted')}</div>}
      {!muted && busy && !text && <ThinkingDots label={t('coach.thinking')} />}
      {!muted && text && (
        <div
          className="coach-md min-w-0 break-words text-sm text-ink-800 dark:text-ink-100"
          style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(stripReasoning(text)) }}
        />
      )}
      {!muted && !busy && actions.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {actions.map((a) => a.kind === 'learn' ? (
            <Link key={`learn-${a.lesson}`} to={`/learn?lesson=${encodeURIComponent(a.lesson)}`} className="btn-secondary text-xs">
              <GraduationCap className="h-3.5 w-3.5" /> {t('coach.next.learn')}
            </Link>
          ) : (
            <Link key="train" to="/train" className="btn-secondary text-xs">
              <Puzzle className="h-3.5 w-3.5" /> {t('coach.next.train')}
            </Link>
          ))}
        </div>
      )}
      {!muted && busy && text && (
        <div className="mt-2 text-xs text-ink-400"><ThinkingDots /></div>
      )}
      {!muted && error && <div className="rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-sm text-bad">{error}</div>}
      {showContext && lastBody && (
        <details open className="mt-3 rounded-lg border border-ink-200 bg-ink-50 p-2 text-xs dark:border-ink-700 dark:bg-ink-900/40">
          <summary className="cursor-pointer text-ink-500">{t('coach.contextSent')}</summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-snug text-ink-600 dark:text-ink-300">
            {JSON.stringify(lastBody, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}
