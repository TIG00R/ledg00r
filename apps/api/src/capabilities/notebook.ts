import { z } from 'zod';
import { command, query, DateOnly, Outcome, type Refusal } from '@ledger/contracts';
import { schema as t } from '@ledger/db';
import { indexRow, dropRow } from '@ledger/db';
import { eq } from 'drizzle-orm';
import type { AppCtx } from '../context.js';
import { noted, refusal, today, newId } from './shared.js';
import { readBase } from './currencies.js';

/**
 * The share notebook.
 *
 * The order log says what was done. This says what was thought — the reason a share was
 * passed over, the dividend that makes a date matter, a thesis that has since aged badly.
 * None of it moves money, which is exactly why it has nowhere else to live and why it is
 * worth keeping: a decision read back without the day it was made, and without the reasoning,
 * is only a number.
 *
 * A ticker is a code. The notebook keeps its own index of what each code is, because six
 * months later "ABUK" is not a company. Nothing here is fetched from an exchange: the shares
 * this ledger knows are the ones the owner has written down.
 */
const TickerIn = z.string().min(1).max(12).regex(/^[A-Za-z][A-Za-z0-9.]*$/, 'not a ticker');

/** One spelling, whatever was typed — a notebook that holds both `abuk` and `ABUK` holds neither. */
const norm = (ticker: string) => ticker.toUpperCase();

/**
 * The months a payout came in, one spelling.
 *
 * Stored comma-joined so a year reads back in order however it was typed, and de-duplicated
 * because a company does not distribute twice in the same March.
 */
const packMonths = (months: number[]) =>
  [...new Set(months)].sort((a, b) => a - b).join(',');

const unpackMonths = (packed: string): number[] =>
  packed.split(',').map((m) => Number(m.trim())).filter((m) => m >= 1 && m <= 12);

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
                     'July', 'August', 'September', 'October', 'November', 'December'];

/** What a payout is worth, said the way it would be said out loud. */
const worth = (kind: 'cash' | 'shares', amount: number, currency: string | null) =>
  (kind === 'shares' ? `${amount} share${amount === 1 ? '' : 's'}` : `${amount} ${currency ?? 'EGP'}`);

/**
 * The company as the notebook knows it, created on first mention.
 *
 * `logo` follows the same rule as `name`: given later it fills a mark the ticker never had,
 * given again it replaces the one it did, and left out it is never blanked because this
 * particular call happened not to mention it.
 */
function remember(ctx: AppCtx, ticker: string, name: string | undefined, now: string, logo?: string) {
  const row = ctx.db.select().from(t.stocks).where(eq(t.stocks.ticker, ticker)).get();
  if (!row) {
    ctx.db.insert(t.stocks).values({ ticker, name: name ?? null, logo: logo ?? null, createdAt: now }).run();
    return;
  }
  const patch: Record<string, string> = {};
  if (name !== undefined && name !== row.name) patch.name = name;
  if (logo !== undefined && logo !== row.logo) patch.logo = logo;
  if (Object.keys(patch).length) {
    ctx.db.update(t.stocks).set(patch).where(eq(t.stocks.ticker, ticker)).run();
  }
}

/** A year a payout belongs to. Wide enough for a ledger that goes back, narrow enough to catch a typo. */
const Year = z.number().int().min(1900).max(2200);
const Month = z.number().int().min(1).max(12);

const dividendOut = z.object({
  id: z.string(), ticker: z.string(), name: z.string().nullable(),
  year: z.number(), months: z.array(z.number()),
  kind: z.enum(['cash', 'shares']), amount: z.number(), currency: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.string(), updatedAt: z.string().nullable(),
});

const noteOut = z.object({
  id: z.string(), ticker: z.string(), name: z.string().nullable(),
  date: z.string(), note: z.string(),
  /** the day this note asks to be read again, null until one is set */
  remindOn: z.string().nullable(),
  /** whether that day is still being watched — a date kept with the reminder switched off */
  remindEnabled: z.boolean(),
  createdAt: z.string(), updatedAt: z.string().nullable(),
});

/**
 * The reminder half of a note, as it is given and as it is stored.
 *
 * Three states, and they are not the same: a date with the switch on is a reminder; a date
 * with the switch off is a reminder kept for later; no date at all is not a reminder, and
 * it cannot be switched on into one, so asking for that is refused rather than quietly
 * saving a switch that watches nothing.
 */
function remindPatch(
  remindOn: string | null | undefined,
  remindEnabled: boolean | undefined,
  had: { remindOn: string | null; remindEnabled: boolean },
): { remindOn: string | null; remindEnabled: boolean } | Refusal {
  const date = remindOn === undefined ? had.remindOn : remindOn;
  const on = remindEnabled === undefined ? had.remindEnabled : remindEnabled;
  if (on && !date) {
    return refusal('invalid_period', 'A reminder with no date watches nothing.',
                   'Give remindOn a day, or leave remindEnabled off.');
  }
  // A date taken off takes its switch with it: there is nothing left to watch.
  return { remindOn: date, remindEnabled: date ? on : false };
}

export const notebookCaps = (ctxOf: () => AppCtx) => [
  query({
    name: 'stock.notes.list',
    context: 'holdings',
    summary: 'The share notebook: every note written about a share, newest first.',
    detail: 'Each note carries the ticker it is about, the company as you named it, and the day the note is about — which is the day it was formed, not the day it was typed, so a view can be recorded after the fact.',
    input: z.object({
      ticker: TickerIn.optional(),
      from: DateOnly.optional(),
      to: DateOnly.optional(),
      /** only the notes that are asking to be read again, and still are */
      remindingOnly: z.boolean().default(false),
      limit: z.number().int().positive().max(500).default(200),
    }),
    output: z.array(noteOut),
    handler: async ({ ticker, from, to, remindingOnly, limit }) => {
      const { db } = ctxOf();
      const names = new Map(db.select().from(t.stocks).all().map((s) => [s.ticker, s.name]));
      return db.select().from(t.stockNotes).all()
        .filter((n) => (!ticker || n.ticker === norm(ticker))
                    && (!from || n.date >= from)
                    && (!to || n.date <= to)
                    && (!remindingOnly || (n.remindEnabled && !!n.remindOn)))
        .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit)
        .map((n) => ({
          id: n.id, ticker: n.ticker, name: names.get(n.ticker) ?? null,
          date: n.date, note: n.note,
          remindOn: n.remindOn ?? null, remindEnabled: !!n.remindEnabled,
          createdAt: n.createdAt, updatedAt: n.updatedAt ?? null,
        }));
    },
  }),

  query({
    name: 'stocks.list',
    context: 'holdings',
    summary: 'Every share the notebook knows, with how much has been written about it.',
    detail: 'The index of the notebook rather than the holdings — a share is here because something was written about it, whether or not it was ever bought. positions.list answers what is held.',
    input: z.object({}),
    output: z.array(z.object({
      ticker: z.string(), name: z.string().nullable(), logo: z.string().nullable(),
      /** why the share is held, for zakat — null until the owner states one */
      intention: z.enum(['personal', 'investment']).nullable(),
      notes: z.number(), latestNote: z.string().nullable(), latestOn: z.string().nullable(),
    })),
    handler: async () => {
      const { db } = ctxOf();
      const all = db.select().from(t.stockNotes).all();
      return db.select().from(t.stocks).all()
        .map((s) => {
          const mine = all.filter((n) => n.ticker === s.ticker)
            .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
          return {
            ticker: s.ticker, name: s.name ?? null, logo: s.logo ?? null,
            intention: (s as { intention?: string | null }).intention as 'personal' | 'investment' | null ?? null,
            notes: mine.length,
            latestNote: mine[0]?.note ?? null, latestOn: mine[0]?.date ?? null,
          };
        })
        .sort((a, b) => a.ticker.localeCompare(b.ticker));
    },
  }),

  command({
    name: 'stock.intention.set',
    context: 'holdings',
    summary: 'State why a share is held — personal, or held as a holding — which decides whether zakat reaches it.',
    detail: 'The answer belongs to the ticker, the same way its name and logo do: every order and every position for it reads the one answer back, rather than each lot arguing about its own. A ticker the notebook has not seen before is added to its index by stating one, the same as writing a note about it would.',
    input: z.object({
      ticker: TickerIn,
      intention: z.enum(['personal', 'investment']),
    }),
    output: Outcome,
    handler: async ({ ticker: raw, intention }) => {
      const ctx = ctxOf();
      const ticker = norm(raw);
      const row = ctx.db.select().from(t.stocks).where(eq(t.stocks.ticker, ticker)).get();
      if (!row) {
        ctx.db.insert(t.stocks).values({ ticker, name: null, logo: null, intention, createdAt: new Date().toISOString() }).run();
      } else {
        ctx.db.update(t.stocks).set({ intention }).where(eq(t.stocks.ticker, ticker)).run();
      }
      return noted(`${ticker} · held ${intention === 'investment' ? 'as a holding' : 'for personal use'}`);
    },
  }),

  command({
    name: 'stock.note.add',
    context: 'holdings',
    summary: 'Write a note about a share — what you decided, and why. It may also ask to be read again on a day of its own.',
    detail: 'Nothing is moved and nothing is held by writing one. A ticker the notebook has not seen before is added to its index, so a share can be followed long before it is ever bought. A note given remindOn is raised in upcoming.list on that day, and remindEnabled is how it is silenced without the date being forgotten. The logo may be given here too, so the first note about a company can name it and mark it in one act.',
    input: z.object({
      ticker: TickerIn,
      /** the company, when you are naming it for the first time or renaming it */
      name: z.string().max(120).optional(),
      /** the company's mark — a picture from mark.upload, or an icon name */
      logo: z.string().max(120).optional(),
      /** the day the note is about; today when left out */
      date: DateOnly.optional(),
      note: z.string().min(1).max(8000),
      /** the day this note should be raised again; nothing is raised without one */
      remindOn: DateOnly.optional(),
      /** whether that day is watched — a date with this off is kept and not raised */
      remindEnabled: z.boolean().default(true),
    }),
    output: z.union([z.object({ id: z.string(), summary: z.string() }), Outcome]),
    handler: async (input) => {
      const ctx = ctxOf();
      const ticker = norm(input.ticker);
      const date = input.date ?? today(ctx);
      const now = new Date().toISOString();

      const remind = remindPatch(input.remindOn ?? null,
                                 input.remindOn ? input.remindEnabled : false,
                                 { remindOn: null, remindEnabled: false });
      if ('ok' in remind) return remind;

      remember(ctx, ticker, input.name?.trim() || undefined, now, input.logo?.trim() || undefined);
      const id = newId('note');
      ctx.db.insert(t.stockNotes)
        .values({ id, ticker, date, note: input.note.trim(), ...remind,
                  createdAt: now, updatedAt: null }).run();
      indexRow(ctx.db, { kind: 'note', recordId: id, occurredOn: date,
                         title: `${ticker} note`, body: input.note });

      const asks = remind.remindEnabled ? `, asking again on ${remind.remindOn}` : '';
      return { id, summary: `${ticker} · note written for ${date}${asks}` };
    },
  }),

  command({
    name: 'stock.note.edit',
    context: 'holdings',
    summary: 'Change a note: its wording, the day it is about, the share it belongs to, or the day it asks to be read again.',
    detail: 'A note filed under the wrong ticker is moved rather than rewritten, so what was thought is kept and only where it belongs changes. What is not named keeps what it had — including its reminder, which is switched off with remindEnabled and taken off altogether by passing remindOn null.',
    input: z.object({
      noteId: z.string(),
      ticker: TickerIn.optional(),
      name: z.string().max(120).optional(),
      logo: z.string().max(120).optional(),
      date: DateOnly.optional(),
      note: z.string().min(1).max(8000).optional(),
      /** a new day to be reminded on; null takes the reminder off entirely */
      remindOn: DateOnly.nullable().optional(),
      /** switch the reminder on or off without losing the day it holds */
      remindEnabled: z.boolean().optional(),
    }),
    output: Outcome,
    handler: async (input) => {
      const ctx = ctxOf();
      const row = ctx.db.select().from(t.stockNotes).where(eq(t.stockNotes.id, input.noteId)).get();
      if (!row) return refusal('not_found', 'There is no note with that id.');

      const ticker = input.ticker ? norm(input.ticker) : row.ticker;
      const date = input.date ?? row.date;
      const note = input.note?.trim() ?? row.note;
      const now = new Date().toISOString();
      const remind = remindPatch(input.remindOn, input.remindEnabled,
                                 { remindOn: row.remindOn ?? null, remindEnabled: !!row.remindEnabled });
      if ('ok' in remind) return remind;
      if (input.name !== undefined || input.logo !== undefined || ticker !== row.ticker) {
        remember(ctx, ticker, input.name?.trim() || undefined, now, input.logo?.trim() || undefined);
      }

      ctx.db.update(t.stockNotes).set({ ticker, date, note, ...remind, updatedAt: now })
        .where(eq(t.stockNotes.id, row.id)).run();
      indexRow(ctx.db, { kind: 'note', recordId: row.id, occurredOn: date,
                         title: `${ticker} note`, body: note });

      const moved = ticker !== row.ticker ? `, moved from ${row.ticker}` : '';
      const asks = remind.remindEnabled ? `, asking again on ${remind.remindOn}`
                 : remind.remindOn ? ', its reminder switched off'
                 : row.remindOn ? ', its reminder taken off' : '';
      return noted(`${ticker} · note for ${date} updated${moved}${asks}`);
    },
  }),

  command({
    name: 'stock.note.remove',
    context: 'holdings',
    summary: 'Delete a note from the notebook.',
    effect: 'irreversible',
    detail: 'The note is gone. The share stays in the notebook\'s index, because what it is called is not what one note said.',
    input: z.object({ noteId: z.string() }),
    output: Outcome,
    handler: async ({ noteId }) => {
      const ctx = ctxOf();
      const row = ctx.db.select().from(t.stockNotes).where(eq(t.stockNotes.id, noteId)).get();
      if (!row) return refusal('not_found', 'There is no note with that id.');
      ctx.db.delete(t.stockNotes).where(eq(t.stockNotes.id, noteId)).run();
      dropRow(ctx.db, 'note', noteId);
      return noted(`${row.ticker} · note for ${row.date} removed`);
    },
  }),

  command({
    name: 'stock.name.set',
    context: 'holdings',
    summary: 'Name a share, or rename one, and give it its own logo — the company behind the ticker.',
    detail: 'The name and the logo belong to the ticker rather than to any one note, so every note and every order about it reads back under the same company. A ticker named here needs no note to exist. The logo is a picture reference from mark.upload, or an icon name; leaving it out keeps whatever the ticker already had, and an empty string clears it.',
    input: z.object({
      ticker: TickerIn,
      name: z.string().max(120).optional(),
      logo: z.string().max(120).optional(),
    }),
    output: Outcome,
    handler: async ({ ticker: raw, name, logo }) => {
      const ctx = ctxOf();
      const ticker = norm(raw);
      const clean = name?.trim();
      remember(ctx, ticker, clean === undefined ? undefined : (clean || undefined), new Date().toISOString(),
                logo === undefined ? undefined : logo.trim());
      if (name !== undefined && !clean) {
        ctx.db.update(t.stocks).set({ name: null }).where(eq(t.stocks.ticker, ticker)).run();
      }
      if (logo !== undefined && !logo.trim()) {
        ctx.db.update(t.stocks).set({ logo: null }).where(eq(t.stocks.ticker, ticker)).run();
      }
      return noted(clean ? `${ticker} · ${clean}` : `${ticker} updated`);
    },
  }),

  query({
    name: 'stock.dividends.list',
    context: 'holdings',
    summary: 'What each share paid out, by year — the months it came in and what it came to.',
    detail: 'A record and nothing more. It moves no money and changes no position; money that actually reached the brokerage is funded by book.transfer, which is a separate act. This is here so a year can be read back and the next decision made against what arrived rather than what was hoped for.',
    input: z.object({
      ticker: TickerIn.optional(),
      year: z.number().int().optional(),
      limit: z.number().int().positive().max(500).default(200),
    }),
    output: z.array(dividendOut),
    handler: async ({ ticker, year, limit }) => {
      const { db } = ctxOf();
      const names = new Map(db.select().from(t.stocks).all().map((s) => [s.ticker, s.name]));
      return db.select().from(t.stockDividends).all()
        .filter((d) => (!ticker || d.ticker === norm(ticker)) && (year == null || d.year === year))
        .sort((a, b) => b.year - a.year || a.ticker.localeCompare(b.ticker))
        .slice(0, limit)
        .map((d) => ({
          id: d.id, ticker: d.ticker, name: names.get(d.ticker) ?? null,
          year: d.year, months: unpackMonths(d.months),
          kind: d.kind, amount: d.amount, currency: d.currency ?? null,
          note: d.note ?? null, createdAt: d.createdAt, updatedAt: d.updatedAt ?? null,
        }));
    },
  }),

  command({
    name: 'stock.dividend.add',
    context: 'holdings',
    summary: 'Record what a share paid out in a year, and in which months.',
    detail: 'Money or shares — `kind` says which the value counts. Nothing is moved and nothing is held by recording one: it is a note about the year, kept where the rest of the reasoning about that share is kept. A ticker the notebook has not seen is added to its index, so a payer can be followed before it is ever bought.',
    input: z.object({
      ticker: TickerIn,
      /** the company, when you are naming it for the first time or renaming it */
      name: z.string().max(120).optional(),
      year: Year,
      /** the months it came in, 1-12; a payer that distributes twice names both */
      months: z.array(Month).max(12).default([]),
      kind: z.enum(['cash', 'shares']).default('cash'),
      /** the total for that year: money, or a number of shares */
      amount: z.number().positive(),
      /** what the money was in; ignored when the payout was shares */
      currency: z.string().regex(/^[A-Z]{3}$/).optional(),
      note: z.string().max(2000).optional(),
    }),
    output: z.union([z.object({ id: z.string(), summary: z.string() }), Outcome]),
    handler: async (input) => {
      const ctx = ctxOf();
      const ticker = norm(input.ticker);
      const kind = input.kind;
      const already = ctx.db.select().from(t.stockDividends).all()
        .find((d) => d.ticker === ticker && d.year === input.year && d.kind === kind);
      if (already) {
        return refusal('duplicate',
          `${ticker} already has a ${kind === 'shares' ? 'share' : 'cash'} payout recorded for ${input.year}.`,
          'Edit that record rather than writing a second one for the same year.');
      }

      const now = new Date().toISOString();
      remember(ctx, ticker, input.name?.trim() || undefined, now);
      const id = newId('div');
      const currency = kind === 'shares' ? null : input.currency ?? readBase(ctx.db);
      const months = packMonths(input.months);

      ctx.db.insert(t.stockDividends).values({
        id, ticker, year: input.year, months, kind, amount: input.amount,
        currency, note: input.note?.trim() || null, createdAt: now, updatedAt: null,
      }).run();
      indexRow(ctx.db, { kind: 'note', recordId: id, occurredOn: `${input.year}-12-31`,
                         title: `${ticker} dividend ${input.year}`,
                         body: [worth(kind, input.amount, currency),
                                unpackMonths(months).map((m) => MONTH_NAMES[m - 1]).join(', '),
                                input.note ?? ''].filter(Boolean).join(' · ') });

      return { id, summary: `${ticker} · ${input.year} paid ${worth(kind, input.amount, currency)}` };
    },
  }),

  command({
    name: 'stock.dividend.edit',
    context: 'holdings',
    summary: 'Correct a recorded payout: the year, the months, what it came to.',
    detail: 'What is not named keeps what it had. Moving one to another ticker moves the record rather than rewriting it, the same as a note.',
    input: z.object({
      dividendId: z.string(),
      ticker: TickerIn.optional(),
      name: z.string().max(120).optional(),
      year: Year.optional(),
      months: z.array(Month).max(12).optional(),
      kind: z.enum(['cash', 'shares']).optional(),
      amount: z.number().positive().optional(),
      currency: z.string().regex(/^[A-Z]{3}$/).optional(),
      note: z.string().max(2000).optional(),
    }),
    output: Outcome,
    handler: async (input) => {
      const ctx = ctxOf();
      const row = ctx.db.select().from(t.stockDividends)
        .where(eq(t.stockDividends.id, input.dividendId)).get();
      if (!row) return refusal('not_found', 'There is no recorded payout with that id.');

      const ticker = input.ticker ? norm(input.ticker) : row.ticker;
      const year = input.year ?? row.year;
      const kind = input.kind ?? row.kind;
      const amount = input.amount ?? row.amount;
      const months = input.months ? packMonths(input.months) : row.months;
      const currency = kind === 'shares' ? null : input.currency ?? row.currency ?? readBase(ctx.db);
      const note = input.note === undefined ? row.note : (input.note.trim() || null);
      const now = new Date().toISOString();

      const clash = ctx.db.select().from(t.stockDividends).all()
        .find((d) => d.id !== row.id && d.ticker === ticker && d.year === year && d.kind === kind);
      if (clash) {
        return refusal('duplicate',
          `${ticker} already has a ${kind === 'shares' ? 'share' : 'cash'} payout recorded for ${year}.`);
      }

      if (input.name !== undefined || ticker !== row.ticker) {
        remember(ctx, ticker, input.name?.trim() || undefined, now);
      }

      ctx.db.update(t.stockDividends)
        .set({ ticker, year, months, kind, amount, currency, note, updatedAt: now })
        .where(eq(t.stockDividends.id, row.id)).run();
      indexRow(ctx.db, { kind: 'note', recordId: row.id, occurredOn: `${year}-12-31`,
                         title: `${ticker} dividend ${year}`,
                         body: [worth(kind, amount, currency),
                                unpackMonths(months).map((m) => MONTH_NAMES[m - 1]).join(', '),
                                note ?? ''].filter(Boolean).join(' · ') });

      const moved = ticker !== row.ticker ? `, moved from ${row.ticker}` : '';
      return noted(`${ticker} · ${year} payout updated${moved}`);
    },
  }),

  command({
    name: 'stock.dividend.remove',
    context: 'holdings',
    summary: 'Delete a recorded payout.',
    effect: 'irreversible',
    detail: 'The record is gone. Nothing else is: no balance moved when it was written, so nothing moves back.',
    input: z.object({ dividendId: z.string() }),
    output: Outcome,
    handler: async ({ dividendId }) => {
      const ctx = ctxOf();
      const row = ctx.db.select().from(t.stockDividends)
        .where(eq(t.stockDividends.id, dividendId)).get();
      if (!row) return refusal('not_found', 'There is no recorded payout with that id.');
      ctx.db.delete(t.stockDividends).where(eq(t.stockDividends.id, dividendId)).run();
      dropRow(ctx.db, 'note', dividendId);
      return noted(`${row.ticker} · ${row.year} payout removed`);
    },
  }),

  command({
    name: 'stock.forget',
    context: 'holdings',
    summary: 'Take a share out of the notebook, with everything written about it.',
    effect: 'irreversible',
    detail: 'For a ticker written down by mistake. A share that has been traded keeps its orders and its position either way — the notebook is not where holdings live.',
    input: z.object({ ticker: TickerIn }),
    output: Outcome,
    handler: async ({ ticker: raw }) => {
      const ctx = ctxOf();
      const ticker = norm(raw);
      const rows = ctx.db.select().from(t.stockNotes).where(eq(t.stockNotes.ticker, ticker)).all();
      const paid = ctx.db.select().from(t.stockDividends)
        .where(eq(t.stockDividends.ticker, ticker)).all();
      const known = ctx.db.select().from(t.stocks).where(eq(t.stocks.ticker, ticker)).get();
      if (!known && rows.length === 0 && paid.length === 0) {
        return refusal('not_found', `${ticker} is not in the notebook.`);
      }

      for (const n of rows) dropRow(ctx.db, 'note', n.id);
      for (const d of paid) dropRow(ctx.db, 'note', d.id);
      ctx.db.delete(t.stockNotes).where(eq(t.stockNotes.ticker, ticker)).run();
      ctx.db.delete(t.stockDividends).where(eq(t.stockDividends.ticker, ticker)).run();
      ctx.db.delete(t.stocks).where(eq(t.stocks.ticker, ticker)).run();

      const said = [`${rows.length} note${rows.length === 1 ? '' : 's'}`];
      if (paid.length) said.push(`${paid.length} payout${paid.length === 1 ? '' : 's'}`);
      return noted(`${ticker} forgotten, with ${said.join(' and ')}`);
    },
  }),
];
