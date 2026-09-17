import { z } from 'zod';
import { command, query, Outcome } from '@ledger/contracts';
import {
  schema as t, LOGS, LOG_NAMES, clearAllRecords, clearLog, countLogs, destroyEverything,
  type LogName,
} from '@ledger/db';
import { eq, inArray } from 'drizzle-orm';
import type { AppCtx } from '../context.js';
import { noted, refusal } from './shared.js';

/**
 * Emptying things.
 *
 * Removing one record reverses the movement behind it and keeps both rows, because a ledger
 * whose past can be edited is a ledger nobody can check. That is the right answer for a
 * correction and the wrong answer for "there should be nothing here": clearing a log of two
 * hundred expenses by reversing each one leaves four hundred movements and an empty table,
 * which is not what anybody meant.
 *
 * So these three erase. They are separated from every other capability by that fact, they are
 * declared irreversible so an agent is told before it calls one, and each requires the caller
 * to say plainly that it means it — a confirmation an agent has to compose deliberately
 * rather than one it can pass through by accident.
 */
const LogName = z.enum(LOG_NAMES as [LogName, ...LogName[]]);

/** The phrase that has to be typed before the whole ledger goes. */
const DESTROY = 'DESTROY EVERYTHING';

export const dataCaps = (ctxOf: () => AppCtx) => [
  query({
    name: 'records.counts',
    context: 'data',
    summary: 'Every record log this ledger keeps, and how much is in each.',
    detail: 'What a clear would remove, before it is asked for. A log reading zero is already empty.',
    input: z.object({}),
    output: z.array(z.object({
      log: z.string(), label: z.string(), what: z.string(), count: z.number(),
    })),
    handler: async () => countLogs(ctxOf().db),
  }),

  command({
    name: 'records.clear',
    context: 'data',
    summary: 'Empty one record log completely. Everything in it goes, and does not come back.',
    detail: 'Not a correction: the records are erased along with the movements they stood on, so the balances fall back to what their accounts opened with. Removing a single record reverses it instead and keeps both rows — use that where the ledger should still say what happened.',
    effect: 'irreversible',
    input: z.object({
      log: LogName,
      /** saying so deliberately; a call without it is refused rather than obeyed */
      confirm: z.literal(true),
    }),
    output: Outcome,
    handler: async ({ log }) => {
      const ctx = ctxOf();
      const before = countLogs(ctx.db).find((l) => l.log === log)!;
      if (before.count === 0) return refusal('duplicate', `${LOGS[log].label} is already empty.`);

      // An asset bought on a plan that no longer has one is paid for, not part-paid. Which
      // assets those are has to be read before the rows go, or there is nothing left to name.
      const onPlans = log === 'plans' || log === 'movements'
        ? [...new Set(ctx.db.select().from(t.installments).all().map((i) => i.propertyId))]
        : [];

      const removed = clearLog(ctx.db, log);
      if (onPlans.length) {
        ctx.db.update(t.nodes).set({ ownership: 'owned' })
          .where(inArray(t.nodes.id, onPlans)).run();
      }

      return noted(`${LOGS[log].label} cleared — ${removed} row${removed === 1 ? '' : 's'} gone`);
    },
  }),

  command({
    name: 'records.clearAll',
    context: 'data',
    summary: 'Empty every record log at once, keeping the ledger itself — accounts, destinations, currencies and settings.',
    detail: 'What is left is the shape you set up rather than anything that happened in it: the banks, the accounts and their opening balances, the destinations you spend against, the currencies and every setting. Every expense, every movement, every plan and every log entry is erased.',
    effect: 'irreversible',
    input: z.object({ confirm: z.literal(true) }),
    output: Outcome,
    handler: async () => {
      const ctx = ctxOf();
      const onPlans = [...new Set(ctx.db.select().from(t.installments).all().map((i) => i.propertyId))];
      const removed = clearAllRecords(ctx.db);
      if (onPlans.length) {
        ctx.db.update(t.nodes).set({ ownership: 'owned' })
          .where(inArray(t.nodes.id, onPlans)).run();
      }
      return noted(`Every record log cleared — ${removed} row${removed === 1 ? '' : 's'} gone. The accounts and the settings are as they were.`);
    },
  }),

  command({
    name: 'data.destroy',
    context: 'data',
    summary: 'Empty every table in the ledger. Records, accounts, settings, keys and uploaded pictures — all of it.',
    detail: `The database keeps its shape and loses everything in it, so what comes up afterwards is a ledger nobody has used yet. Nothing here can be undone and there is no copy kept: take one first if the figures matter. Confirm with the exact words "${DESTROY}".`,
    effect: 'irreversible',
    input: z.object({
      confirm: z.string().describe(`the words "${DESTROY}", exactly`),
    }),
    output: Outcome,
    handler: async ({ confirm }) => {
      const ctx = ctxOf();
      if (confirm !== DESTROY) {
        return refusal('immutable', 'That is not the confirmation this needs.',
                       `Send confirm: "${DESTROY}" — the words exactly, if destroying everything is what you mean.`);
      }
      const { tables, rows } = destroyEverything(ctx.db);
      return noted(`${rows} rows removed from ${tables} tables. This ledger is empty.`);
    },
  }),
];

export { eq };
