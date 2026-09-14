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

export function LiveProvider({ children }: { children: React.ReactNode }) {
  const [live, setLive] = useState(false);
  const [version, setVersion] = useState(0);
  const [running, setRunning] = useState<string | null>(null);
  const [last, setLast] = useState<(Outcome & { capability: string; screen: string }) | null>(null);
  const inflight = useRef(new Set<string>());

  useEffect(() => { apiAvailable().then(setLive); }, []);

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
 * What the last write did, or why it was refused. Shown where the action was taken.
 *
 * Only there: the receipt carries the screen it was earned on, so a screen that happens to
 * draw one of these never inherits another screen's news.
 */
export function LastOutcome() {
  const { last, clear } = useLive();
  if (!last || last.screen !== screenNow()) return null;
  const good = last.ok;
  return (
    <div role="status" style={{
      display: 'flex', gap: 10, alignItems: 'flex-start', padding: '11px 13px',
      borderRadius: 'var(--r-card)', fontSize: 12, lineHeight: 1.45,
      background: `color-mix(in srgb, var(--${good ? 'positive' : 'negative'}) 9%, transparent)`,
      border: `1px solid color-mix(in srgb, var(--${good ? 'positive' : 'negative'}) 26%, transparent)`,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: `var(--${good ? 'positive' : 'negative'})`, fontWeight: 500 }}>
          {good ? (last.summary ?? 'Recorded') : last.message}
        </div>
        {!good && last.remedy && <div style={{ color: 'var(--muted)', marginTop: 3 }}>{last.remedy}</div>}
        {good && last.changes?.length ? (
          <div style={{ color: 'var(--muted)', marginTop: 4 }}>
            {last.changes.map((c) => `${c.name}: ${Math.round(c.before).toLocaleString()} → ${Math.round(c.after).toLocaleString()}`).join(' · ')}
          </div>
        ) : null}
      </div>
      <button onClick={clear} aria-label="Dismiss" style={{ padding: 2, background: 'transparent',
              border: 'none', cursor: 'pointer', color: 'var(--faint)', fontSize: 14 }}>×</button>
    </div>
  );
}
