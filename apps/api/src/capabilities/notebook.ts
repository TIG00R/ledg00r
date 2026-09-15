import { z } from 'zod';
import { command, query, DateOnly, Outcome } from '@ledger/contracts';
import { schema as t } from '@ledger/db';
import { indexRow, dropRow } from '@ledger/db';
import { eq } from 'drizzle-orm';
import type { AppCtx } from '../context.js';
import { noted, refusal, today, newId } from './shared.js';

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

/** The company as the notebook knows it, created on first mention. */
function remember(ctx: AppCtx, ticker: string, name: string | undefined, now: string) {
  const row = ctx.db.select().from(t.stocks).where(eq(t.stocks.ticker, ticker)).get();
  if (!row) {
    ctx.db.insert(t.stocks).values({ ticker, name: name ?? null, createdAt: now }).run();
    return;
  }
  // A name given later fills one that was never given; a name given again replaces it. What is
  // never done is blanking a known name because this particular call did not mention one.
  if (name !== undefined && name !== row.name) {
    ctx.db.update(t.stocks).set({ name }).where(eq(t.stocks.ticker, ticker)).run();
  }
}

const noteOut = z.object({
  id: z.string(), ticker: z.string(), name: z.string().nullable(),
  date: z.string(), note: z.string(),
  createdAt: z.string(), updatedAt: z.string().nullable(),
});

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
      limit: z.number().int().positive().max(500).default(200),
    }),
    output: z.array(noteOut),
    handler: async ({ ticker, from, to, limit }) => {
      const { db } = ctxOf();
      const names = new Map(db.select().from(t.stocks).all().map((s) => [s.ticker, s.name]));
      return db.select().from(t.stockNotes).all()
        .filter((n) => (!ticker || n.ticker === norm(ticker))
                    && (!from || n.date >= from)
                    && (!to || n.date <= to))
        .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit)
        .map((n) => ({
          id: n.id, ticker: n.ticker, name: names.get(n.ticker) ?? null,
          date: n.date, note: n.note,
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
      ticker: z.string(), name: z.string().nullable(),
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
            ticker: s.ticker, name: s.name ?? null, notes: mine.length,
            latestNote: mine[0]?.note ?? null, latestOn: mine[0]?.date ?? null,
          };
        })
        .sort((a, b) => a.ticker.localeCompare(b.ticker));
    },
  }),

  command({
    name: 'stock.note.add',
    context: 'holdings',
    summary: 'Write a note about a share — what you decided, and why.',
    detail: 'Nothing is moved and nothing is held by writing one. A ticker the notebook has not seen before is added to its index, so a share can be followed long before it is ever bought.',
    input: z.object({
      ticker: TickerIn,
      /** the company, when you are naming it for the first time or renaming it */
      name: z.string().max(120).optional(),
      /** the day the note is about; today when left out */
      date: DateOnly.optional(),
      note: z.string().min(1).max(8000),
    }),
    output: z.union([z.object({ id: z.string(), summary: z.string() }), Outcome]),
    handler: async (input) => {
      const ctx = ctxOf();
      const ticker = norm(input.ticker);
      const date = input.date ?? today(ctx);
      const now = new Date().toISOString();

      remember(ctx, ticker, input.name?.trim() || undefined, now);
      const id = newId('note');
      ctx.db.insert(t.stockNotes)
        .values({ id, ticker, date, note: input.note.trim(), createdAt: now, updatedAt: null }).run();
      indexRow(ctx.db, { kind: 'note', recordId: id, occurredOn: date,
                         title: `${ticker} note`, body: input.note });

      return { id, summary: `${ticker} · note written for ${date}` };
    },
  }),

  command({
    name: 'stock.note.edit',
    context: 'holdings',
    summary: 'Change a note: its wording, the day it is about, or the share it belongs to.',
    detail: 'A note filed under the wrong ticker is moved rather than rewritten, so what was thought is kept and only where it belongs changes. What is not named keeps what it had.',
    input: z.object({
      noteId: z.string(),
      ticker: TickerIn.optional(),
      name: z.string().max(120).optional(),
      date: DateOnly.optional(),
      note: z.string().min(1).max(8000).optional(),
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
      if (input.name !== undefined || ticker !== row.ticker) {
        remember(ctx, ticker, input.name?.trim() || undefined, now);
      }

      ctx.db.update(t.stockNotes).set({ ticker, date, note, updatedAt: now })
        .where(eq(t.stockNotes.id, row.id)).run();
      indexRow(ctx.db, { kind: 'note', recordId: row.id, occurredOn: date,
                         title: `${ticker} note`, body: note });

      const moved = ticker !== row.ticker ? `, moved from ${row.ticker}` : '';
      return noted(`${ticker} · note for ${date} updated${moved}`);
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
    summary: 'Name a share, or rename one — the company behind the ticker.',
    detail: 'The name belongs to the ticker rather than to any one note, so every note about it reads back under the same company. A ticker named here needs no note to exist.',
    input: z.object({ ticker: TickerIn, name: z.string().max(120) }),
    output: Outcome,
    handler: async ({ ticker: raw, name }) => {
      const ctx = ctxOf();
      const ticker = norm(raw);
      const clean = name.trim();
      remember(ctx, ticker, clean || undefined, new Date().toISOString());
      if (!clean) {
        ctx.db.update(t.stocks).set({ name: null }).where(eq(t.stocks.ticker, ticker)).run();
        return noted(`${ticker} · name cleared`);
      }
      return noted(`${ticker} · ${clean}`);
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
      const known = ctx.db.select().from(t.stocks).where(eq(t.stocks.ticker, ticker)).get();
      if (!known && rows.length === 0) return refusal('not_found', `${ticker} is not in the notebook.`);

      for (const n of rows) dropRow(ctx.db, 'note', n.id);
      ctx.db.delete(t.stockNotes).where(eq(t.stockNotes.ticker, ticker)).run();
      ctx.db.delete(t.stocks).where(eq(t.stocks.ticker, ticker)).run();
      return noted(`${ticker} forgotten, with ${rows.length} note${rows.length === 1 ? '' : 's'}`);
    },
  }),
];
