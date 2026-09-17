import { z } from 'zod';
import { query } from '@ledger/contracts';
import { schema as t } from '@ledger/db';
import { and, desc, eq, gte, like, lte, or } from 'drizzle-orm';
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
];
