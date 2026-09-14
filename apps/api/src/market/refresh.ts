
import type { AppCtx } from '../context.js';
import { readPref, writePref } from '../read.js';
import { readBase, readCurrencies } from '../capabilities/currencies.js';
import { DEFAULT_SOURCE, findSource, forSubject, SUBJECTS, type Subject } from './sources.js';

/**
 * Fetching, and the settings that govern it.
 *
 * A price arriving from outside is still a tick: it is written with the source that produced
 * it and the moment it was taken, exactly as a hand-typed one is, so nothing downstream has
 * to care which it was and the history shows both. The only thing fetching changes is who
 * did the typing.
 *
 * Nothing here decides what a good source is. That is the owner's decision, and this file
 * only carries it out — including the decision to fetch nothing at all, which is what
 * choosing "you type it in" means.
 */
export interface SourceSettings {
  fx: string; gold: string; silver: string; stocks: string;
  /** try the other sources for a subject when the chosen one is silent */
  fallback: boolean;
  /** how often to go and look, in hours. Zero means only when asked. */
  refreshHours: number;
}

export interface SubjectOutcome {
  /** when this subject was last attempted */
  at: string;
  /** the source that actually answered, which is not the chosen one when it fell back */
  source: string;
  ok: boolean;
  /** what it said, or why it could not */
  note: string;
  /** how many figures it wrote */
  wrote: number;
}

const DEFAULTS: SourceSettings = {
  ...DEFAULT_SOURCE as Record<Subject, string> & { fx: string; gold: string; silver: string; stocks: string },
  fallback: true,
  refreshHours: 6,
};

export function readSourceSettings(ctx: AppCtx): SourceSettings {
  const stored = readPref<Partial<SourceSettings>>(ctx.db, 'priceSources') ?? {};
  const base = readBase(ctx.db);
  const settings = { ...DEFAULTS, ...stored };

  // A source that is only offered in one currency stops being an option when the ledger
  // changes what it reports in, so a stale choice falls back to whatever is still offered
  // rather than silently fetching nothing.
  for (const { id } of SUBJECTS) {
    const offered = forSubject(id, base);
    if (!offered.some((s) => s.id === settings[id])) {
      settings[id] = offered.find((s) => !s.manual)?.id ?? 'manual';
    }
  }
  return settings;
}

export function writeSourceSettings(ctx: AppCtx, patch: Partial<SourceSettings>): SourceSettings {
  const next = { ...readSourceSettings(ctx), ...patch };
  writePref(ctx.db, 'priceSources', next);
  return next;
}

export const readLog = (ctx: AppCtx): Partial<Record<Subject, SubjectOutcome>> =>
  readPref<Partial<Record<Subject, SubjectOutcome>>>(ctx.db, 'priceSourceLog') ?? {};

/**
 * What the ledger needs priced.
 *
 * Only what is actually held. Asking a source for forty currencies and two hundred tickers
 * that appear nowhere in this ledger is both slower and ruder than asking for the handful
 * that appear in it.
 */
function wanted(ctx: AppCtx) {
  const base = readBase(ctx.db);
  const currencies = readCurrencies(ctx.db)
    .filter((c) => !c.archived && c.code !== base).map((c) => c.code);
  const tickers = (ctx.db.$raw.prepare('SELECT DISTINCT ticker FROM orders').all() as Array<{ ticker: string }>)
    .map((r) => r.ticker).filter(Boolean);
  const known = (key: string) => (ctx.db.$raw.prepare(
    'SELECT value FROM market_ticks WHERE key = ? ORDER BY at DESC LIMIT 1',
  ).get(key) as { value: number } | undefined)?.value;

  return { base, currencies, tickers, known };
}

export interface RefreshResult {
  subject: Subject;
  /** the source asked for, which may not be the one that answered */
  chose: string;
  outcome: SubjectOutcome;
}

/**
 * Go and look.
 *
 * The chosen source is asked first. If it is silent and falling back is allowed, the others
 * for that subject are tried in the order they are declared — and the one that answered is
 * recorded, so a person can see that the number in front of them did not come from the
 * source they picked.
 */
export async function refreshMarket(
  ctx: AppCtx, opts: { subject?: Subject } = {},
): Promise<RefreshResult[]> {
  const settings = readSourceSettings(ctx);
  const ask = opts.subject ? [opts.subject] : SUBJECTS.map((s) => s.id);
  const need = wanted(ctx);
  const log = { ...readLog(ctx) };
  const results: RefreshResult[] = [];

  for (const subject of ask) {
    const chose = settings[subject];
    const chosen = findSource(subject, chose);
    const at = ctx.now.toISOString();

    if (!chosen || chosen.manual) {
      // Recorded like any other attempt. Left out of the log, the subject read as never
      // looked at — so the interface had nothing to show under "last attempt" and the
      // scheduler went on treating it as overdue every half hour, for ever.
      const outcome: SubjectOutcome = { at, source: 'manual', ok: true, wrote: 0,
        note: 'Nothing was fetched — this one is yours to type in.' };
      log[subject] = outcome;
      results.push({ subject, chose, outcome });
      continue;
    }

    // The chosen one first, then the rest in the order they are offered.
    const queue = [chosen, ...(settings.fallback
      ? forSubject(subject, need.base).filter((s) => !s.manual && s.id !== chosen.id) : [])];

    let outcome: SubjectOutcome = { at, source: chose, ok: false, wrote: 0,
                                    note: 'Nothing was tried.' };
    for (const source of queue) {
      if (subject === 'stocks' && !need.tickers.length) {
        outcome = { at, source: source.id, ok: true, wrote: 0,
                    note: 'No holdings to price yet.' };
        break;
      }
      try {
        const got = await source.fetch!(need);
        const rows = Object.entries(got.ticks).filter(([, v]) => Number.isFinite(v) && v > 0);
        const stmt = ctx.db.$raw.prepare(
          'INSERT INTO market_ticks (at, key, value, source, live) VALUES (?, ?, ?, ?, 1)');
        for (const [key, value] of rows) stmt.run(at, key, value, source.id);

        outcome = { at, source: source.id, ok: true, wrote: rows.length,
                    note: source.id === chose ? got.note : `${source.label} answered instead. ${got.note}` };
        break;
      } catch (e) {
        outcome = { at, source: source.id, ok: false, wrote: 0, note: (e as Error).message };
      }
    }

    log[subject] = outcome;
    results.push({ subject, chose, outcome });
  }

  writePref(ctx.db, 'priceSourceLog', log);
  return results;
}

/**
 * Going to look on its own.
 *
 * Every half hour the clock is checked against how old each subject's last attempt is, which
 * is not the same as fetching every half hour: a person who set six hours gets six hours,
 * and a person who set zero is never fetched for at all.
 */
export function startMarketRefresh(ctxOf: () => AppCtx): () => void {
  const run = async () => {
    try {
      const ctx = ctxOf();
      const settings = readSourceSettings(ctx);
      if (!(settings.refreshHours > 0)) return;

      const log = readLog(ctx);
      const stale = SUBJECTS.map((s) => s.id).filter((subject) => {
        const last = log[subject]?.at;
        if (!last) return true;
        return Date.now() - new Date(last).getTime() >= settings.refreshHours * 3_600_000;
      });
      for (const subject of stale) {
        const done = await refreshMarket(ctx, { subject });
        for (const r of done) {
          if (r.outcome.wrote) console.log(`[market] ${r.subject}: ${r.outcome.wrote} from ${r.outcome.source}`);
          else if (!r.outcome.ok) console.warn(`[market] ${r.subject} — ${r.outcome.note}`);
        }
      }
    } catch (e) {
      console.error('[market]', e);
    }
  };

  // Not on the instant of boot: a container that restarts often should not be a source of
  // traffic, and nothing here is due to the minute.
  const first = setTimeout(run, 20_000);
  const handle = setInterval(run, 30 * 60 * 1000);
  return () => { clearTimeout(first); clearInterval(handle); };
}

export { SUBJECTS, forSubject, type Subject };
