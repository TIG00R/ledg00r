
import type { AppCtx } from '../context.js';
import { readPref, writePref } from '../read.js';
import { readBase, readCurrencies } from '../capabilities/currencies.js';
import { DEFAULT_SOURCE, findSource, forSubject, SUBJECTS, type Source, type Subject } from './sources.js';

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

/**
 * How old the figure a subject is currently serving actually is.
 *
 * `readLog` says when a subject was last *attempted*, which on a closed market is today and
 * says nothing about the price itself — the attempt found nobody home and wrote nothing. What
 * a screen needs instead is when the tick behind today's number was actually taken, so it can
 * say "as at Friday's close" rather than pretend the figure in front of someone is live.
 *
 * Ticks are the history, so this is read straight out of them rather than kept anywhere new:
 * the oldest tick among the keys this ledger currently relies on for the subject — the
 * weakest link, since that is the one that would mislead someone if shown as current. A
 * subject nothing has ever been recorded for reads as never priced, not as an error.
 */
export function pricedAt(ctx: AppCtx, subject: Subject): string | null {
  const need = wanted(ctx);
  const keys = subject === 'fx' ? need.currencies.map((c) => `${c}_${need.base}`)
    : subject === 'gold' ? ['gold_24k_g']
    : subject === 'silver' ? ['silver_g']
    : need.tickers.map((t) => `price_${t}`);
  if (!keys.length) return null;

  // Newest first, then oldest of those. Ticks are appended and never replaced, so the
  // plain minimum over the whole table is the first figure ever recorded rather than the
  // one being shown — an age that grows with every refresh instead of shrinking. What is
  // wanted is each key's current tick, and then the oldest among them.
  const row = ctx.db.$raw.prepare(
    `SELECT MIN(latest) AS at FROM (
       SELECT MAX(at) AS latest FROM market_ticks
        WHERE key IN (${keys.map(() => '?').join(',')})
        GROUP BY key
     )`,
  ).get(...keys) as { at: string | null } | undefined;
  return row?.at ?? null;
}

export interface RefreshResult {
  subject: Subject;
  /** the source asked for, which may not be the one that answered */
  chose: string;
  outcome: SubjectOutcome;
}

const insertTick = (ctx: AppCtx) => ctx.db.$raw.prepare(
  'INSERT INTO market_ticks (at, key, value, source, live) VALUES (?, ?, ?, ?, 1)');

/**
 * A batch of tickers, asked of the whole queue rather than of one source.
 *
 * A currency table or a dealer's board either answers or it plainly does not — there is one
 * thing to ask for, so trying the next source when the first is silent is the whole of
 * falling back. A share book is not like that: it is forty small fetches bundled into one
 * call, and a source can genuinely price some of them and leave the rest, for two entirely
 * different reasons. It may have answered and simply not carry that name — Mubasher only
 * ever speaks for the EGX, and a ticker it does not carry is not a fault, just a fact worth
 * saying plainly in the note. Or it may not have answered at all for that name — refused,
 * rate-limited, timed out — which is exactly the same as if the whole source had errored, and
 * must be treated that way: the ticker is owed a try from whoever is next in the queue, not
 * quietly written off because someone else in the same batch happened to price.
 *
 * So the tickers still unpriced are what gets handed to the next source, not the whole list
 * again — a source already told plainly it does not carry a name is not asked to reconsider.
 */
async function fillStocks(
  ctx: AppCtx, at: string, chose: string, queue: Source[], need: ReturnType<typeof wanted>,
): Promise<SubjectOutcome> {
  const stmt = insertTick(ctx);
  let left = [...need.tickers];
  let wrote = 0;
  let answeredBy: string | undefined;
  const said: string[] = [];
  let trouble = 'Nothing was tried.';

  for (const source of queue) {
    if (!left.length) break;
    try {
      const got = await source.fetch!({ ...need, tickers: left });
      const rows = Object.entries(got.ticks).filter(([, v]) => Number.isFinite(v) && v > 0);
      for (const [key, value] of rows) stmt.run(at, key, value, source.id);

      if (rows.length) {
        wrote += rows.length;
        answeredBy ??= source.id;
        said.push(source.id === chose ? got.note : `${source.label} answered instead. ${got.note}`);
        const priced = new Set(rows.map(([k]) => k));
        left = left.filter((t) => !priced.has(`price_${t}`));
      } else {
        // Answered, but with nothing usable for what is still left — no different from an
        // error for what happens next: whatever it did not price stands unchanged for the
        // next source in the queue to try.
        trouble = got.note;
      }
    } catch (e) {
      // Refused, rate-limited, timed out — it would not answer at all, which is not the same
      // as answering and genuinely finding nothing. Either way the tickers it could not
      // reach are untouched, ready for whoever is asked next.
      trouble = (e as Error).message;
    }
  }

  return {
    at, wrote, ok: wrote > 0,
    source: answeredBy ?? chose,
    note: said.length ? said.join(' ') + (left.length ? ` Still nothing for: ${left.join(', ')}.` : '')
                      : trouble,
  };
}

/**
 * Go and look.
 *
 * The chosen source is asked first. If it is silent and falling back is allowed, the others
 * for that subject are tried in the order they are declared — and the one that answered is
 * recorded, so a person can see that the number in front of them did not come from the
 * source they picked.
 *
 * "Silent" covers everything that is not an answer: a thrown error, a refusal, a timeout, a
 * rate limit, and — for shares — a source that came back with nothing left to give after
 * pricing what it could. None of these stand in for a source that genuinely looked and found
 * nothing; all of them mean the next source in the queue gets a turn.
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

    if (subject === 'stocks' && !need.tickers.length) {
      const outcome: SubjectOutcome = { at, source: chose, ok: true, wrote: 0,
                                        note: 'No holdings to price yet.' };
      log[subject] = outcome;
      results.push({ subject, chose, outcome });
      continue;
    }

    // The chosen one first, then the rest in the order they are offered.
    const queue = [chosen, ...(settings.fallback
      ? forSubject(subject, need.base).filter((s) => !s.manual && s.id !== chosen.id) : [])];

    let outcome: SubjectOutcome;

    if (subject === 'stocks') {
      // A batch of tickers where one source can price some and leave the rest — see
      // fillStocks for why that is not the same as the source having answered.
      outcome = await fillStocks(ctx, at, chose, queue, need);
    } else {
      // One figure, or one small table, asked of a source at a time. There is nothing partial
      // to hand on here, so the first source that comes back with something usable wins —
      // but resolving with nothing to write is still silence, not an answer, and moves on to
      // the next source exactly as a thrown error would.
      outcome = { at, source: chose, ok: false, wrote: 0, note: 'Nothing was tried.' };
      const stmt = insertTick(ctx);
      for (const source of queue) {
        try {
          const got = await source.fetch!(need);
          const rows = Object.entries(got.ticks).filter(([, v]) => Number.isFinite(v) && v > 0);
          if (rows.length) {
            for (const [key, value] of rows) stmt.run(at, key, value, source.id);
            outcome = { at, source: source.id, ok: true, wrote: rows.length,
                        note: source.id === chose ? got.note : `${source.label} answered instead. ${got.note}` };
            break;
          }
          outcome = { at, source: source.id, ok: false, wrote: 0, note: got.note };
        } catch (e) {
          outcome = { at, source: source.id, ok: false, wrote: 0, note: (e as Error).message };
        }
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
