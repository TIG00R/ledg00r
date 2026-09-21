import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ledger, apiAvailable, LedgerError } from './api';

/**
 * The bridge to the back end.
 *
 * The interface was built against fixtures and must keep working that way — with no server
 * it is still a complete, explorable application, which is what makes it possible to design
 * a screen before there is anything behind it. When a back end is there, the same screens
 * write to it.
 *
 * `run` is the single path a control takes to change something. It reports what happened
 * rather than throwing, keeps the button disabled while it is in flight, and bumps a version
 * number afterwards so every screen reading derived data picks up the change.
 */
export interface Outcome {
  ok: boolean;
  summary?: string;
  message?: string;
  remedy?: string;
  changes?: Array<{ name: string; before: number; after: number; currency?: string }>;
  /**
   * What the capability actually returned.
   *
   * Most callers only need to know whether it worked. Some need the answer itself — the
   * reference to a picture that was just stored, the id of a thing that was just created —
   * and summarising that away meant the caller received a success with the useful part
   * missing.
   */
  result?: any;
}

interface LiveCtx {
  /** true once the API has answered; false means the fixtures are in charge */
  live: boolean;
  /** increments after every successful write, so reads can depend on it */
  version: number;
  running: string | null;
  last: (Outcome & { capability: string; screen: string }) | null;
  run: (capability: string, input: unknown, opts?: { idempotencyKey?: string }) => Promise<Outcome>;
  preview: (capability: string, input: unknown) => Promise<Outcome>;
  clear: () => void;
}

const Ctx = createContext<LiveCtx | null>(null);

/** which screen is in front of the person right now */
const screenNow = () => window.location.hash.replace(/^#\/?/, '').split('/')[0] || 'portfolio';

/**
 * How long to wait before asking again. A failed check backs off — one second, two, four,
 * doubling — rather than hammering a service that is mid-restart, but it stops doubling at a
 * ceiling short enough that coming back is still noticed promptly. A check that succeeds asks
 * again too, on a calmer, steady pace, because a live ledger can stop answering as easily as a
 * missing one can start.
 */
const WATCH_MS = { retryStart: 1000, retryMax: 15_000, steady: 5_000 } as const;

export function LiveProvider({ children }: { children: React.ReactNode }) {
  const [live, setLive] = useState(false);
  const [version, setVersion] = useState(0);
  const [running, setRunning] = useState<string | null>(null);
  const [last, setLast] = useState<(Outcome & { capability: string; screen: string }) | null>(null);
  const inflight = useRef(new Set<string>());

  /**
   * Whether there is a ledger behind this screen, kept current rather than settled once.
   *
   * The first check can land at exactly the moment the service is restarting under it —
   * that is what happened here — and believing that single failure forever is how a screen
   * goes on reading fixtures beside a ledger that has been up and answering for an hour,
   * with nothing on screen to say the two have drifted apart. So a failure is retried on a
   * backoff instead of accepted as the last word, and going live does not stop the watching:
   * the same check keeps running, more calmly, so a ledger that stops answering later is
   * noticed instead of leaving stale numbers standing in as if they were current.
   */
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let backoff: number = WATCH_MS.retryStart;

    const tick = async () => {
      const ok = await apiAvailable();
      if (cancelled) return;
      setLive(ok);
      if (ok) {
        backoff = WATCH_MS.retryStart; // a later drop starts backing off from the beginning again
        timer = setTimeout(tick, WATCH_MS.steady);
      } else {
        timer = setTimeout(tick, backoff);
        backoff = Math.min(backoff * 2, WATCH_MS.retryMax);
      }
    };
    tick();

    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, []);

  /**
   * A receipt belongs to the screen that earned it.
   *
   * The outcome is held once for the whole application, and every screen draws it — so
   * recording income and then opening Accounts showed the income's receipt sitting on the
   * accounts page, as if something had just happened there. It is cleared on the way out.
   */
  useEffect(() => {
    const leave = () => setLast(null);
    window.addEventListener('hashchange', leave);
    return () => window.removeEventListener('hashchange', leave);
  }, []);

  const call = useCallback(async (capability: string, input: unknown, dryRun: boolean, key?: string) => {
    if (!live) {
      // Say so where the action was taken. Returning this quietly to the caller is how a
      // button ends up looking broken rather than looking unavailable.
      const none: Outcome = {
        ok: false,
        message: 'There is no ledger service behind this screen, so nothing was recorded.',
        remedy: 'Start the API and reload the page.',
      };
      if (!dryRun) setLast({ ...none, capability, screen: screenNow() });
      return none;
    }
    // A double-click must not post twice even before the server's idempotency key is reached.
    const guard = `${capability}:${JSON.stringify(input)}`;
    if (!dryRun && inflight.current.has(guard)) {
      return { ok: false, message: 'That is already being recorded.' } satisfies Outcome;
    }

    if (!dryRun) { inflight.current.add(guard); setRunning(capability); }
    try {
      const res = await (ledger as any)[capability](input, { dryRun, idempotencyKey: key });
      const outcome: Outcome = res?.ok === false
        ? { ok: false, message: res.message, remedy: res.remedy, result: res }
        : { ok: true, summary: res?.summary, changes: res?.changes, result: res };
      if (!dryRun) {
        setLast({ ...outcome, capability, screen: screenNow() });
        if (outcome.ok) setVersion((v) => v + 1);
      }
      return outcome;
    } catch (e) {
      const err = e as LedgerError;
      const outcome: Outcome = { ok: false, message: err.message, remedy: err.remedy };
      if (!dryRun) setLast({ ...outcome, capability, screen: screenNow() });
      return outcome;
    } finally {
      if (!dryRun) { inflight.current.delete(guard); setRunning(null); }
    }
  }, [live]);

  const value = useMemo<LiveCtx>(() => ({
    live, version, running, last,
    run: (c, i, o) => call(c, i, false, o?.idempotencyKey),
    preview: (c, i) => call(c, i, true),
    clear: () => setLast(null),
  }), [live, version, running, last, call]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLive(): LiveCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useLive outside LiveProvider');
  return ctx;
}

/**
 * A button that runs a capability.
 *
 * Wrapping it means the disabled state, the in-flight state and the outcome are handled the
 * same way everywhere, rather than each screen inventing its own and getting one of them
 * wrong.
 */
export function ActionButton({ capability, input, children, className = 'btn', style, disabled, onDone }: {
  capability: string;
  input: unknown | (() => unknown);
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  disabled?: boolean;
  onDone?: (o: Outcome) => void;
}) {
  const { run, running, live } = useLive();
  const busy = running === capability;
  return (
    // a disabled button looks disabled the same way everywhere, which the stylesheet says once
    <button className={className} disabled={disabled || busy}
      title={live ? undefined : 'No ledger service is running behind this screen'}
      style={style}
      onClick={async () => {
        const payload = typeof input === 'function' ? (input as () => unknown)() : input;
        // Awaiting first, deliberately. `onDone?.(await run(...))` short-circuits the whole
        // call expression when onDone is absent, so the run never happens — which is a
        // button that looks fine and does nothing.
        const outcome = await run(capability, payload);
        onDone?.(outcome);
      }}>
      {busy ? 'Recording…' : children}
    </button>
  );
}

/**
 * How long a receipt is on screen, from the first frame of it appearing to the last of it
 * going: four seconds, fading at both ends.
 *
 * Two seconds that arrived and vanished at full strength read as a flicker — by the time the
 * eye had found the corner the sentence was half gone, and what a write actually did is the
 * one thing worth reading. The fades are part of the four, not added to them.
 */
const TOAST_MS = { ok: 4000, fail: 5000 } as const;
/** in and out, of that total */
const FADE_IN_MS = 420;
const FADE_OUT_MS = 900;

/**
 * What the last write did, or why it was refused. A toast, floating over whichever screen
 * earned it, that shows itself and then goes away on its own.
 *
 * Only on the screen that earned it: the receipt carries that screen, so one that happens to
 * mount this never inherits another screen's news.
 *
 * It clears the stored outcome when its own timer runs out, rather than merely unmounting —
 * an outcome left standing in `last` would draw itself again the moment this remounts (a
 * screen switch and back, a hot reload), which is a toast that looks like it never left.
 */
export function LastOutcome() {
  const { last, clear } = useLive();
  const onScreen = !!last && last.screen === screenNow();

  /**
   * Which part of its life this receipt is in.
   *
   * It mounts faded out, is brought up on the next frame, and is taken back down for the
   * last of its time on screen — so the sentence arrives and leaves at a speed that can be
   * read, rather than appearing and disappearing between two blinks. The stored outcome is
   * cleared when the fade out has finished, not when it starts, or the toast would vanish
   * mid-fade.
   */
  const [phase, setPhase] = useState<'in' | 'up' | 'out'>('in');

  // A fresh receipt — even for the same capability — is a new object, so this effect tears
  // down the previous timers and starts new ones: that is the reset a new arrival needs.
  useEffect(() => {
    if (!onScreen) return;
    const total = last!.ok ? TOAST_MS.ok : TOAST_MS.fail;
    setPhase('in');
    const up = window.setTimeout(() => setPhase('up'), 20);
    const out = window.setTimeout(() => setPhase('out'), Math.max(0, total - FADE_OUT_MS));
    const gone = window.setTimeout(clear, total);
    return () => { window.clearTimeout(up); window.clearTimeout(out); window.clearTimeout(gone); };
  }, [last, onScreen, clear]);

  if (!onScreen) return null;
  const good = last!.ok;
  return (
    <div role={good ? 'status' : 'alert'} style={{
      position: 'fixed', bottom: 24, right: 24, zIndex: 300,
      width: 360, maxWidth: 'calc(100vw - 32px)',
      display: 'flex', gap: 10, alignItems: 'flex-start', padding: '11px 13px',
      borderRadius: 'var(--r-card)', fontSize: 12, lineHeight: 1.45,
      boxShadow: 'var(--shadow-lg)',
      background: `color-mix(in srgb, var(--${good ? 'positive' : 'negative'}) 9%, var(--surface))`,
      border: `1px solid color-mix(in srgb, var(--${good ? 'positive' : 'negative'}) 26%, transparent)`,
      opacity: phase === 'up' ? 1 : 0,
      transform: phase === 'up' ? 'translateY(0)' : 'translateY(6px)',
      transition: `opacity ${phase === 'out' ? FADE_OUT_MS : FADE_IN_MS}ms var(--ease),`
        + ` transform ${phase === 'out' ? FADE_OUT_MS : FADE_IN_MS}ms var(--ease)`,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: `var(--${good ? 'positive' : 'negative'})`, fontWeight: 500 }}>
          {good ? (last!.summary ?? 'Recorded') : last!.message}
        </div>
        {!good && last!.remedy && <div style={{ color: 'var(--muted)', marginTop: 3 }}>{last!.remedy}</div>}
        {good && last!.changes?.length ? (
          <div style={{ color: 'var(--muted)', marginTop: 4 }}>
            {last!.changes.map((c) => `${c.name}: ${Math.round(c.before).toLocaleString()} → ${Math.round(c.after).toLocaleString()}`).join(' · ')}
          </div>
        ) : null}
      </div>
      <button onClick={clear} aria-label="Dismiss" style={{ padding: 2, background: 'transparent',
              border: 'none', cursor: 'pointer', color: 'var(--faint)', fontSize: 14 }}>×</button>
    </div>
  );
}
