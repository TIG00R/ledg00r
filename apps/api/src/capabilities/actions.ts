import { z } from 'zod';
import { query } from '@ledger/contracts';
import { schema as t } from '@ledger/db';
import { and, desc, eq, gte, like, lte, or } from 'drizzle-orm';
import { refusal } from './shared.js';
import type { AppCtx } from '../context.js';

/**
 * The log of what was done.
 *
 * The movements answer "what happened to the money". They cannot answer "what did I change
 * last Tuesday" — a rename, an archive, a reminder switched off, a destination recoloured, a
 * refusal, a balance restated. Those leave no movement by construction, and a restated
 * balance leaves none deliberately, so without this the act would exist nowhere at all.
 *
 * It is written by the dispatcher rather than by each handler, which is what makes it
 * complete: a capability added later is recorded without anybody remembering to record it.
 */
export const actionCaps = (ctxOf: () => AppCtx) => [
  query({
    name: 'actions.list',
    context: 'actions',
    summary: 'Everything the ledger was asked to do, newest first — including what it refused.',
    detail: 'One row per command: when, which capability, what it was called with, what came of it, and the movement it wrote where it wrote one. Reads are not in here; looking at a ledger changes nothing.',
    input: z.object({
      capability: z.string().max(80).optional(),
      context: z.string().max(40).optional(),
      outcome: z.enum(['ok', 'refused', 'failed']).optional(),
      /** everything that touched one account, asset, destination or record */
      subjectId: z.string().max(80).optional(),
      /** ISO dates or timestamps; compared against when the act was recorded */
      from: z.string().max(40).optional(),
      to: z.string().max(40).optional(),
      search: z.string().max(120).optional(),
      limit: z.number().int().min(1).max(500).default(200),
    }),
    output: z.array(z.object({
      id: z.string(), at: z.string(), capability: z.string(), context: z.string(),
      summary: z.string(), outcome: z.string(), input: z.unknown().nullable(),
      movementId: z.string().nullable(), subjectId: z.string().nullable(),
      source: z.string(),
    })),
    handler: async (input) => {
      const { db } = ctxOf();
      const where = [
        input.capability ? eq(t.actions.capability, input.capability) : undefined,
        input.context ? eq(t.actions.context, input.context) : undefined,
        input.outcome ? eq(t.actions.outcome, input.outcome) : undefined,
        input.subjectId ? eq(t.actions.subjectId, input.subjectId) : undefined,
        input.from ? gte(t.actions.at, input.from) : undefined,
        // a bare date as the upper bound means the whole of that day, not its first instant
        input.to ? lte(t.actions.at, /^\d{4}-\d{2}-\d{2}$/.test(input.to) ? `${input.to}T23:59:59.999Z` : input.to) : undefined,
        input.search
          ? or(like(t.actions.summary, `%${input.search}%`), like(t.actions.capability, `%${input.search}%`))
          : undefined,
      ].filter(Boolean);
      return db.select().from(t.actions)
        .where(where.length ? and(...(where as any)) : undefined)
        .orderBy(desc(t.actions.at)).limit(input.limit).all()
        .map((a) => ({
          id: a.id, at: a.at, capability: a.capability, context: a.context,
          summary: a.summary, outcome: a.outcome, input: a.input ?? null,
          movementId: a.movementId, subjectId: a.subjectId, source: a.source,
        }));
    },
  }),

  query({
    name: 'action.read',
    context: 'actions',
    summary: 'One act in full, by its id — what it was called with, and what came of it.',
    detail: 'The list carries the arguments an act was given, but a long one is easier to read on its own. Where the act wrote a movement, that movement is resolved here too, so a correction can be read without a second call.',
    input: z.object({ actionId: z.string().max(80) }),
    output: z.union([
      z.object({
        id: z.string(), at: z.string(), capability: z.string(), context: z.string(),
        summary: z.string(), outcome: z.string(), input: z.unknown().nullable(),
        subjectId: z.string().nullable(), source: z.string(),
        movement: z.object({
          id: z.string(), date: z.string(), kind: z.string(), note: z.string().nullable(),
          automatic: z.boolean(),
          reversedBy: z.string().nullable(), reverses: z.string().nullable(),
        }).nullable(),
      }),
      z.object({ ok: z.literal(false), code: z.string(), message: z.string() }),
    ]),
    handler: async ({ actionId }) => {
      const { db } = ctxOf();
      const a = db.select().from(t.actions).where(eq(t.actions.id, actionId)).get();
      if (!a) return refusal('not_found', `${actionId} is not an act this ledger recorded.`);
      const mv = a.movementId
        ? db.select().from(t.transactions).where(eq(t.transactions.id, a.movementId)).get()
        : undefined;
      // a movement says it corrects an earlier one; being corrected is the same fact read
      // from the other end, so it is looked up rather than stored twice
      const reversedBy = mv
        ? db.select().from(t.transactions).where(eq(t.transactions.correctsId, mv.id)).get()?.id ?? null
        : null;
      return {
        id: a.id, at: a.at, capability: a.capability, context: a.context,
        summary: a.summary, outcome: a.outcome, input: a.input ?? null,
        subjectId: a.subjectId, source: a.source,
        movement: mv
          ? { id: mv.id, date: mv.date, kind: mv.kind, note: mv.note ?? null,
              automatic: mv.automatic, reversedBy, reverses: mv.correctsId ?? null }
          : null,
      };
    },
  }),

  query({
    name: 'actions.summary',
    context: 'actions',
    summary: 'What was done over a window, counted: by outcome, by area, by capability and by who asked.',
    detail: 'The shape of the log rather than its rows — how much of it moved money, how much moved nothing, and what was refused. Ask for the rows themselves with actions.list once this says where to look.',
    input: z.object({
      from: z.string().max(40).optional(),
      to: z.string().max(40).optional(),
      /** how many of the busiest capabilities to name; the rest are counted in `otherCapabilities` */
      top: z.number().int().min(1).max(50).default(10),
    }),
    output: z.object({
      from: z.string().nullable(), to: z.string().nullable(),
      total: z.number(),
      /** an act that wrote a movement, against one that changed something else */
      movedMoney: z.number(), movedNothing: z.number(),
      byOutcome: z.object({ ok: z.number(), refused: z.number(), failed: z.number() }),
      byContext: z.array(z.object({ context: z.string(), count: z.number() })),
      byCapability: z.array(z.object({ capability: z.string(), count: z.number() })),
      otherCapabilities: z.number(),
      bySource: z.array(z.object({ source: z.string(), count: z.number() })),
      first: z.string().nullable(), last: z.string().nullable(),
    }),
    handler: async (input) => {
      const { db } = ctxOf();
      const where = [
        input.from ? gte(t.actions.at, input.from) : undefined,
        input.to ? lte(t.actions.at, /^\d{4}-\d{2}-\d{2}$/.test(input.to) ? `${input.to}T23:59:59.999Z` : input.to) : undefined,
      ].filter(Boolean);
      const rows = db.select().from(t.actions)
        .where(where.length ? and(...(where as any)) : undefined)
        .orderBy(desc(t.actions.at)).all();

      const tally = (pick: (a: typeof rows[number]) => string) => {
        const m = new Map<string, number>();
        for (const a of rows) m.set(pick(a), (m.get(pick(a)) ?? 0) + 1);
        return [...m.entries()].map(([k, count]) => ({ k, count })).sort((x, y) => y.count - x.count);
      };

      const caps = tally((a) => a.capability);
      const named = caps.slice(0, input.top);

      return {
        from: input.from ?? null, to: input.to ?? null,
        total: rows.length,
        movedMoney: rows.filter((a) => a.movementId).length,
        movedNothing: rows.filter((a) => !a.movementId && a.outcome === 'ok').length,
        byOutcome: {
          ok: rows.filter((a) => a.outcome === 'ok').length,
          refused: rows.filter((a) => a.outcome === 'refused').length,
          failed: rows.filter((a) => a.outcome === 'failed').length,
        },
        byContext: tally((a) => a.context).map(({ k, count }) => ({ context: k, count })),
        byCapability: named.map(({ k, count }) => ({ capability: k, count })),
        otherCapabilities: caps.slice(input.top).reduce((s, c) => s + c.count, 0),
        bySource: tally((a) => a.source).map(({ k, count }) => ({ source: k, count })),
        // the rows come back newest first, so the ends of the window are the ends of the list
        first: rows.at(-1)?.at ?? null, last: rows[0]?.at ?? null,
      };
    },
  }),
];
