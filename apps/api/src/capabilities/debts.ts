import { z } from 'zod';
import { command, query, DateOnly, NodeId, Outcome } from '@ledger/contracts';
import { schema as t } from '@ledger/db';
import { eq } from 'drizzle-orm';
import type { AppCtx } from '../context.js';
import { post, noted, refusal, today, newId, undoMovement, DryRun } from './shared.js';
import { readMarket } from '../read.js';

/**
 * Money lent out, and money owed.
 *
 * Both are debts; the difference is which way they point, so one shape describes them. Each
 * is held as a node — an asset when the money is coming back, a liability when it is not —
 * which means lending and borrowing move net worth correctly without anything downstream
 * needing to know that debts exist at all.
 *
 * Lending is not spending. The money leaves an account and becomes something you are owed,
 * so what you are worth does not change; only where it sits does. Borrowing is the same in
 * reverse: cash arrives and an obligation arrives with it.
 */
/**
 * The movement that opened a debt, and the account on the other side of it.
 *
 * A debt is a node, and the first movement touching it is the one that created it: cash out
 * of an account into what you are owed, or the other way for something borrowed. Read from
 * the legs rather than stored, so it stays true if that movement is later corrected.
 */
function openingLeg(ctx: AppCtx, nodeId: string):
  { movementId: string; accountId: string; name: string } | null {
  const legs = ctx.db.select().from(t.legs).all()
    .filter((l) => l.fromNodeId === nodeId || l.toNodeId === nodeId);
  if (legs.length === 0) return null;
  const dated = legs
    .map((l) => ({ leg: l, tx: ctx.db.select().from(t.transactions)
      .where(eq(t.transactions.id, l.transactionId)).get() }))
    .filter((x) => x.tx)
    .sort((a, b) => a.tx!.date.localeCompare(b.tx!.date) || a.leg.seq - b.leg.seq);
  const first = dated[0];
  if (!first) return null;
  const accountId = first.leg.fromNodeId === nodeId ? first.leg.toNodeId : first.leg.fromNodeId;
  if (!accountId) return null;
  const node = ctx.db.select().from(t.nodes).where(eq(t.nodes.id, accountId)).get();
  return { movementId: first.tx!.id, accountId, name: node?.name ?? accountId };
}

/**
 * What has come back on a debt, payment by payment.
 *
 * A repayment is a movement against the debt's own node in the direction that shrinks it —
 * out of what you are owed and into an account, or out of an account and into what you owe.
 * Reading them from the legs means the history is the ledger's, not a second list kept
 * beside it that could disagree: correct or undo a repayment and it leaves here too.
 *
 * Writing a loan off moves the same way and is not a payment, so it is marked as what it is.
 */
function repayments(ctx: AppCtx, nodeId: string, direction: string, openingId: string | null) {
  const lent = direction === 'lent';
  return ctx.db.select().from(t.legs).all()
    .filter((l) => (lent ? l.fromNodeId === nodeId : l.toNodeId === nodeId))
    .map((l) => ({ leg: l, tx: ctx.db.select().from(t.transactions)
      .where(eq(t.transactions.id, l.transactionId)).get() }))
    .filter((x) => !!x.tx && x.tx.id !== openingId)
    .map(({ leg, tx }) => ({
      movementId: tx!.id,
      date: tx!.date,
      amount: Math.abs((lent ? leg.qtyFrom : leg.qtyTo ?? leg.qtyFrom) ?? 0),
      note: tx!.note ?? null,
      writtenOff: tx!.kind === 'expense',
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export const debtCaps = (ctxOf: () => AppCtx) => [
  query({
    name: 'debts.list',
    context: 'debts',
    summary: 'Money lent out and money owed, with what is left on each.',
    detail: 'The outstanding figure is the node\'s own balance, so a repayment recorded anywhere is reflected here.',
    input: z.object({
      direction: z.enum(['lent', 'borrowed', 'both']).default('both'),
      includeSettled: z.boolean().default(false),
    }),
    output: z.array(z.object({
      id: z.string(), direction: z.string(), counterparty: z.string(),
      principal: z.number(), outstanding: z.number(), repaid: z.number(),
      currency: z.string(), startedOn: z.string(), dueOn: z.string().nullable(),
      /** the day it closed, whether by the last repayment or by being written off */
      settledOn: z.string().nullable(),
      /** the account the money left, or arrived in, when the debt was recorded */
      accountId: z.string().nullable(), accountName: z.string().nullable(),
      /** every repayment against it, in the order they happened */
      payments: z.array(z.object({
        movementId: z.string(), date: z.string(), amount: z.number(),
        note: z.string().nullable(), writtenOff: z.boolean(),
      })),
      note: z.string().nullable(), nodeId: z.string(),
      settled: z.boolean(), writtenOff: z.boolean(),
      daysUntilDue: z.number().nullable(), overdue: z.boolean(),
    })),
    handler: async (input) => {
      const ctx = ctxOf();
      const ledger = ctx.ledger();
      const now = ctx.now.toISOString().slice(0, 10);

      return ctx.db.select().from(t.debts).all()
        .filter((d) => input.direction === 'both' || d.direction === input.direction)
        .filter((d) => input.includeSettled || !d.settledAt)
        .map((d) => {
          const outstanding = Math.abs(ledger.balance(d.nodeId));
          const days = d.dueOn
            ? Math.round((new Date(`${d.dueOn}T12:00:00`).getTime() - ctx.now.getTime()) / 86_400_000)
            : null;
          const opened = openingLeg(ctx, d.nodeId);
          return {
            id: d.id, direction: d.direction, counterparty: d.counterparty,
            principal: d.principal, outstanding, repaid: d.principal - outstanding,
            currency: d.currency, startedOn: d.startedOn, dueOn: d.dueOn,
            settledOn: d.settledAt ?? null,
            accountId: opened?.accountId ?? null, accountName: opened?.name ?? null,
            payments: repayments(ctx, d.nodeId, d.direction, opened?.movementId ?? null),
            note: d.note, nodeId: d.nodeId,
            settled: !!d.settledAt, writtenOff: !!d.writtenOffAt,
            daysUntilDue: days,
            overdue: !d.settledAt && !!d.dueOn && d.dueOn < now,
          };
        })
        .sort((a, b) => (a.dueOn ?? '9999').localeCompare(b.dueOn ?? '9999'));
    },
  }),

  command({
    name: 'debt.record',
    context: 'debts',
    summary: 'Record money lent to someone, or money borrowed from them.',
    detail: 'Lending moves cash out of a named account and into something you are owed — net worth does not change, only where it sits. Borrowing brings cash in and an obligation with it.',
    input: z.object({
      direction: z.enum(['lent', 'borrowed']),
      counterparty: z.string().min(1).max(80),
      accountId: NodeId,
      amount: z.number().positive(),
      currency: z.string().regex(/^[A-Z]{3}$/).optional(),
      startedOn: DateOnly.optional(),
      dueOn: DateOnly.optional(),
      note: z.string().max(400).optional(),
    }).merge(DryRun),
    output: Outcome,
    handler: async (input) => {
      const ctx = ctxOf();
      const acct = ctx.ledger().node(input.accountId);
      if (!acct) return refusal('unknown_node', `${input.accountId} is not an account in this ledger.`);

      const currency = input.currency ?? acct.currency ?? 'EGP';
      const lent = input.direction === 'lent';
      const startedOn = input.startedOn ?? today(ctx);
      const id = newId('debt');
      const nodeId = `debt-${id}`;

      /*
       * The debt is a node, so everything that walks nodes sees it without being told — and
       * the movement that opens it has to have somewhere to point. A dry run therefore makes
       * the node too and takes it away again afterwards: without it the preview named a node
       * that did not exist and was refused, which made the whole dryRun flag unanswerable.
       */
      ctx.db.insert(t.nodes).values({
        id: nodeId,
        kind: lent ? 'asset' : 'liability',
        name: lent ? `Owed by ${input.counterparty}` : `Owed to ${input.counterparty}`,
        currency, valuation: currency === 'EGP' ? 'face' : 'fx',
        openingQty: 0, archived: false,
      }).run();

      const outcome = post(ctx, {
        date: startedOn,
        kind: 'transfer',
        note: input.note ?? (lent ? `Lent to ${input.counterparty}` : `Borrowed from ${input.counterparty}`),
        legs: [lent
          ? { fromNodeId: input.accountId, toNodeId: nodeId, qtyFrom: input.amount }
          : { fromNodeId: nodeId, toNodeId: input.accountId, qtyFrom: input.amount }],
      }, lent
        ? `${input.amount} ${currency} lent to ${input.counterparty}, out of ${acct.name}`
        : `${input.amount} ${currency} borrowed from ${input.counterparty}, into ${acct.name}`,
      {
        dryRun: input.dryRun,
        index: [{ kind: 'movement', recordId: id, title: input.counterparty, body: input.note ?? '' }],
        after: (db, movementId) => {
          db.insert(t.debts).values({
            id, direction: input.direction, counterparty: input.counterparty,
            principal: input.amount, currency, startedOn, dueOn: input.dueOn ?? null,
            note: input.note ?? null, nodeId, createdAt: ctx.now.toISOString(),
          }).run();
          void movementId;
        },
      });

      // Nothing was written, so the node it was written against goes too.
      if (input.dryRun || ctx.dryRun || !outcome.ok) {
        ctx.db.delete(t.nodes).where(eq(t.nodes.id, nodeId)).run();
      }
      return outcome;
    },
  }),

  command({
    name: 'debt.settle',
    context: 'debts',
    summary: 'Record a repayment — money coming back to you, or money you are paying back.',
    detail: 'Repaying part of a debt reduces what is outstanding; repaying all of it closes the debt. Leave the amount out to settle whatever is left.',
    input: z.object({
      debtId: z.string(),
      accountId: NodeId,
      amount: z.number().positive().optional(),
      date: DateOnly.optional(),
      note: z.string().max(300).optional(),
    }).merge(DryRun),
    output: Outcome,
    handler: async (input) => {
      const ctx = ctxOf();
      const debt = ctx.db.select().from(t.debts).where(eq(t.debts.id, input.debtId)).get();
      if (!debt) return refusal('not_found', 'There is no such debt.');
      if (debt.settledAt) return refusal('duplicate', 'That debt is already settled.');

      const acct = ctx.ledger().node(input.accountId);
      if (!acct) return refusal('unknown_node', `${input.accountId} is not an account in this ledger.`);

      const outstanding = Math.abs(ctx.ledger().balance(debt.nodeId));
      const amount = input.amount ?? outstanding;
      if (amount > outstanding + 0.005) {
        return refusal('unbalanced',
          `Only ${outstanding} ${debt.currency} is outstanding, and that is ${amount - outstanding} more.`,
          'Repay what is left, or leave the amount out to settle it exactly.');
      }

      const lent = debt.direction === 'lent';
      const date = input.date ?? today(ctx);
      const closes = amount >= outstanding - 0.005;

      return post(ctx, {
        date, kind: 'transfer',
        note: input.note ?? (lent
          ? `${debt.counterparty} repaid ${amount}`
          : `Repaid ${amount} to ${debt.counterparty}`),
        legs: [lent
          ? { fromNodeId: debt.nodeId, toNodeId: input.accountId, qtyFrom: amount }
          : { fromNodeId: input.accountId, toNodeId: debt.nodeId, qtyFrom: amount }],
      }, lent
        ? `${amount} ${debt.currency} back from ${debt.counterparty}${closes ? ' — settled' : ''}`
        : `${amount} ${debt.currency} repaid to ${debt.counterparty}${closes ? ' — settled' : ''}`,
      {
        dryRun: input.dryRun,
        after: (db) => {
          if (closes) {
            db.update(t.debts).set({ settledAt: date }).where(eq(t.debts.id, debt.id)).run();
            db.update(t.nodes).set({ archived: true }).where(eq(t.nodes.id, debt.nodeId)).run();
          }
        },
      });
    },
  }),

  command({
    name: 'debt.update',
    context: 'debts',
    summary: 'Change who a debt is with, when it is due, or the note on it.',
    detail: 'Not the amount — that is what was lent or borrowed, and changing it would mean the movement behind it no longer says what happened. Record a further loan, or a repayment, instead.',
    input: z.object({
      debtId: z.string(),
      counterparty: z.string().min(1).max(80).optional(),
      /** the day it was lent or borrowed; the movement that recorded it moves with it */
      startedOn: DateOnly.optional(),
      dueOn: DateOnly.nullable().optional(),
      note: z.string().max(400).optional(),
    }),
    output: Outcome,
    handler: async ({ debtId, ...patch }) => {
      const ctx = ctxOf();
      const debt = ctx.db.select().from(t.debts).where(eq(t.debts.id, debtId)).get();
      if (!debt) return refusal('not_found', 'There is no such debt.');

      const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      if (Object.keys(clean).length) {
        ctx.db.update(t.debts).set(clean).where(eq(t.debts.id, debtId)).run();
      }
      if (patch.counterparty) {
        ctx.db.update(t.nodes).set({
          name: debt.direction === 'lent'
            ? `Owed by ${patch.counterparty}` : `Owed to ${patch.counterparty}`,
        }).where(eq(t.nodes.id, debt.nodeId)).run();
      }
      /*
       * The day it happened is on the debt and on the movement that recorded it, and they
       * have to agree — a loan dated March in one place and April in the other is two
       * different loans as far as anything reading the log is concerned.
       */
      if (patch.startedOn) {
        const opened = openingLeg(ctx, debt.nodeId);
        if (opened) {
          ctx.db.update(t.transactions).set({ date: patch.startedOn })
            .where(eq(t.transactions.id, opened.movementId)).run();
        }
      }
      return noted(`${patch.counterparty ?? debt.counterparty} updated`);
    },
  }),

  command({
    name: 'debt.writeOff',
    context: 'debts',
    summary: 'Give up on a debt owed to you. It stops counting toward what you are worth.',
    detail: 'A loan you no longer expect back is not an asset, and it is not zakatable either — zakat is owed on wealth, and a debt you have written off is not wealth. Recorded as a movement so the log says when you gave up on it.',
    effect: 'irreversible',
    input: z.object({
      debtId: z.string(), note: z.string().max(300).optional(),
    }).merge(DryRun),
    output: Outcome,
    handler: async (input) => {
      const ctx = ctxOf();
      const debt = ctx.db.select().from(t.debts).where(eq(t.debts.id, input.debtId)).get();
      if (!debt) return refusal('not_found', 'There is no such debt.');
      if (debt.direction !== 'lent') {
        return refusal('immutable', 'Only a debt owed to you can be written off.',
                       'A debt you owe is settled by paying it, or forgiven by whoever holds it.');
      }
      if (debt.settledAt) return refusal('duplicate', 'That debt is already closed.');

      const outstanding = Math.abs(ctx.ledger().balance(debt.nodeId));
      if (outstanding <= 0.005) return refusal('duplicate', 'Nothing is outstanding on that debt.');

      return post(ctx, {
        date: today(ctx), kind: 'expense',
        note: input.note ?? `Written off — ${debt.counterparty}`,
        legs: [{ fromNodeId: debt.nodeId, qtyFrom: outstanding }],
      }, `${outstanding} ${debt.currency} written off — ${debt.counterparty}`,
      {
        dryRun: input.dryRun,
        after: (db) => {
          db.update(t.debts).set({
            writtenOffAt: today(ctx), settledAt: today(ctx),
          }).where(eq(t.debts.id, debt.id)).run();
          db.update(t.nodes).set({ archived: true }).where(eq(t.nodes.id, debt.nodeId)).run();
        },
      });
    },
  }),

  command({
    name: 'debt.remove',
    context: 'debts',
    summary: 'Remove a debt from the record entirely, reversing everything it moved.',
    detail: 'For a loan that should never have been written down. The money returns to the account it left, every repayment against it is reversed too, and the debt and the node holding it are gone. This is not the same as writing a loan off: writing off says you gave up on money you were genuinely owed, and the log keeps the day you did.',
    effect: 'irreversible',
    input: z.object({ debtId: z.string() }),
    output: Outcome,
    handler: async ({ debtId }) => {
      const ctx = ctxOf();
      const debt = ctx.db.select().from(t.debts).where(eq(t.debts.id, debtId)).get();
      if (!debt) return refusal('not_found', 'There is no such debt.');

      /*
       * Every movement that ever touched the debt's own node: the one that opened it, each
       * repayment, and the write-off where there was one. Reversed rather than deleted, the
       * way removing any record that moved money is — so the accounts come back to where they
       * would have been and the log still says what was recorded and what took it back.
       */
      const touching = [...new Set(ctx.db.select().from(t.legs).all()
        .filter((l) => l.fromNodeId === debt.nodeId || l.toNodeId === debt.nodeId)
        .map((l) => l.transactionId))];

      /*
       * Settling a debt or writing it off archives its node, and an archived node takes no
       * new movements — which is right for anything being recorded and wrong for a reversal,
       * since a reversal is precisely how a closed debt is taken back. So it is woken up for
       * the length of this call and deleted at the end of it either way.
       */
      ctx.db.update(t.nodes).set({ archived: false }).where(eq(t.nodes.id, debt.nodeId)).run();
      for (const movementId of touching) undoMovement(ctx, movementId);

      ctx.db.delete(t.debts).where(eq(t.debts.id, debtId)).run();
      // the node exists only to hold this debt, so it goes with it rather than lingering
      // archived in every list that walks nodes
      ctx.db.delete(t.nodes).where(eq(t.nodes.id, debt.nodeId)).run();

      return noted(debt.direction === 'lent'
        ? `The loan to ${debt.counterparty} is off the record, and the money is back in the account it left`
        : `What you owed ${debt.counterparty} is off the record, and the money it brought in is back out`);
    },
  }),

  query({
    name: 'debts.summary',
    context: 'debts',
    summary: 'What is owed to you and what you owe, in the ledger\'s currency.',
    input: z.object({}),
    output: z.object({
      owedToYou: z.number(), owedByYou: z.number(), net: z.number(),
      lentCount: z.number(), borrowedCount: z.number(), overdue: z.number(),
    }),
    handler: async () => {
      const ctx = ctxOf();
      const market = readMarket(ctx.db);
      const ledger = ctx.ledger();
      const now = ctx.now.toISOString().slice(0, 10);
      const rows = ctx.db.select().from(t.debts).all().filter((d) => !d.settledAt);

      const inBase = (d: typeof rows[number]) => {
        const q = Math.abs(ledger.balance(d.nodeId));
        return d.currency === 'EGP' ? q : q * (market.fxRates[d.currency] ?? 1);
      };
      const lent = rows.filter((d) => d.direction === 'lent');
      const borrowed = rows.filter((d) => d.direction === 'borrowed');
      const owedToYou = lent.reduce((s, d) => s + inBase(d), 0);
      const owedByYou = borrowed.reduce((s, d) => s + inBase(d), 0);

      return {
        owedToYou, owedByYou, net: owedToYou - owedByYou,
        lentCount: lent.length, borrowedCount: borrowed.length,
        overdue: rows.filter((d) => d.dueOn && d.dueOn < now).length,
      };
    },
  }),
];
