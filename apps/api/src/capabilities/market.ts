import { z } from 'zod';
import { command, query, Outcome } from '@ledger/contracts';
import type { AppCtx } from '../context.js';
import { noted, refusal } from './shared.js';
import { readBase } from './currencies.js';
import { forSubject, SUBJECTS, type Subject } from '../market/sources.js';
import { readLog, readSourceSettings, refreshMarket, writeSourceSettings } from '../market/refresh.js';

/**
 * Where the outside numbers come from.
 *
 * The ledger holds four kinds of figure it cannot know by itself — what a currency is worth,
 * what a gram of gold or silver is worth, and what a share last traded at. For each one there
 * is a short list of sources that were tried and found to answer, and the owner picks which.
 *
 * The choice offered is deliberately not technical. A source states who publishes it, what
 * its number actually is, and how far behind it runs; nothing asks for a URL, a key or a
 * parsing rule, because those are decisions with consequences a settings form cannot explain
 * and a person should not have to make in order to get today's dollar.
 */
const SubjectId = z.enum(['fx', 'gold', 'silver', 'stocks']);

export const marketCaps = (ctxOf: () => AppCtx) => [
  query({
    name: 'market.sources',
    context: 'overview',
    summary: 'Which source each kind of price is taken from, what else is on offer, and how the last attempt went.',
    detail: 'Four subjects — currencies, gold, silver, shares. Each has a chosen source, and a source may be "you type it in", which fetches nothing.',
    input: z.object({}),
    output: z.object({
      base: z.string(),
      fallback: z.boolean(),
      refreshHours: z.number(),
      subjects: z.array(z.object({
        id: SubjectId,
        label: z.string(),
        hint: z.string(),
        chosen: z.string(),
        options: z.array(z.object({
          id: z.string(), label: z.string(), what: z.string(),
          cadence: z.string(), manual: z.boolean(),
        })),
        last: z.object({
          at: z.string(), source: z.string(), ok: z.boolean(), note: z.string(), wrote: z.number(),
        }).nullable(),
      })),
    }),
    handler: async () => {
      const ctx = ctxOf();
      const base = readBase(ctx.db);
      const settings = readSourceSettings(ctx);
      const log = readLog(ctx);

      return {
        base,
        fallback: settings.fallback,
        refreshHours: settings.refreshHours,
        subjects: SUBJECTS.map((s) => ({
          id: s.id, label: s.label, hint: s.hint,
          chosen: settings[s.id],
          options: forSubject(s.id, base).map((o) => ({
            id: o.id, label: o.label, what: o.what, cadence: o.cadence, manual: !!o.manual,
          })),
          last: log[s.id] ?? null,
        })),
      };
    },
  }),

  command({
    name: 'market.chooseSource',
    context: 'overview',
    summary: 'Choose where one kind of price is taken from.',
    detail: 'The source has to be one of those on offer for that subject in this ledger\'s currency — a dealer quoting Egyptian pounds is no use to a ledger reporting in dollars, so it is not offered.',
    input: z.object({ subject: SubjectId, source: z.string().min(2).max(30) }),
    output: Outcome,
    handler: async ({ subject, source }) => {
      const ctx = ctxOf();
      const base = readBase(ctx.db);
      const offered = forSubject(subject as Subject, base);
      const picked = offered.find((s) => s.id === source);
      if (!picked) {
        return refusal('not_found', `${source} is not a source for ${subject} in a ledger reporting in ${base}.`,
                       `On offer: ${offered.map((s) => s.id).join(', ')}.`);
      }
      writeSourceSettings(ctx, { [subject]: source } as any);
      return noted(`${subject} now comes from ${picked.label}`,
                   picked.manual ? ['Nothing will be fetched for this one. Record it by hand.'] : []);
    },
  }),

  command({
    name: 'market.autoRefresh',
    context: 'overview',
    summary: 'How often the chosen sources are looked at on their own, and whether a silent one may be stood in for.',
    detail: 'Hours of zero means nothing is fetched unless asked. Standing in means that when the chosen source is silent the others for that subject are tried in turn — and the one that answered is recorded, so you can see the figure did not come from where you picked.',
    input: z.object({
      every: z.number().min(0).max(168).optional(),
      standIn: z.boolean().optional(),
    }),
    output: Outcome,
    handler: async ({ every, standIn }) => {
      const ctx = ctxOf();
      const next = writeSourceSettings(ctx, {
        ...(every != null ? { refreshHours: every } : {}),
        ...(standIn != null ? { fallback: standIn } : {}),
      });
      return noted(next.refreshHours > 0
        ? `Looked at every ${next.refreshHours} hour${next.refreshHours === 1 ? '' : 's'}${next.fallback ? ', standing in when one is silent' : ''}`
        : 'Nothing is fetched unless you ask');
    },
  }),

  command({
    name: 'market.refresh',
    context: 'overview',
    summary: 'Go and fetch now, from whichever sources are chosen.',
    detail: 'Each figure that comes back is written as an ordinary tick carrying the source that produced it, so fetched and hand-typed figures sit in the same history and neither is disguised as the other. Naming a subject fetches only that one.',
    input: z.object({ subject: SubjectId.optional() }),
    output: Outcome,
    handler: async ({ subject }) => {
      const ctx = ctxOf();
      const results = await refreshMarket(ctx, { subject: subject as Subject | undefined });
      const wrote = results.reduce((n, r) => n + r.outcome.wrote, 0);
      const trouble = results.filter((r) => !r.outcome.ok)
        .map((r) => `${r.subject}: ${r.outcome.note}`);

      return noted(wrote ? `${wrote} figure${wrote === 1 ? '' : 's'} recorded`
                         : 'Nothing new was recorded', trouble);
    },
  }),
];
