import { z } from 'zod';
import { command, query, DateOnly, NodeId, InstitutionId, Outcome } from '@ledger/contracts';
import { allBalances, schema as t, search as ftsSearch } from '@ledger/db';
import { readMarket } from '../read.js';
import { eq } from 'drizzle-orm';
import type { AppCtx } from '../context.js';
import { post, noted, refusal, today, newId, DryRun } from './shared.js';

/**
 * Accounts, movements, and the search that covers every log.
 *
 * The summaries are written for a caller who cannot see the screen, because that is exactly
 * the situation an agent is in: what the capability does, and what it needs to be told.
 */
export const ledgerCaps = (ctxOf: () => AppCtx) => [
  query({
    name: 'accounts.list',
    context: 'ledger',
    summary: 'Every account and what it holds right now, in its own currency.',
    detail: 'Start here when a movement needs an account id. Balances come from a projection, so this is a lookup rather than a walk of the log.',
    input: z.object({ includeArchived: z.boolean().default(false) }),
    output: z.array(z.object({
      id: z.string(), name: z.string(), institution: z.string().nullable(), kind: z.string(),
      currency: z.string().nullable(), unit: z.string().nullable(),
      balance: z.number(), archived: z.boolean(),
    })),
    handler: async ({ includeArchived }) => {
      const { db } = ctxOf();
      const balances = allBalances(db);
      const insts = new Map(db.select().from(t.institutions).all().map((i) => [i.id, i.name]));
      return db.select().from(t.nodes).all()
        .filter((n) => includeArchived || !n.archived)
        .map((n) => ({
          id: n.id, name: n.name, institution: n.parentId ? insts.get(n.parentId) ?? null : null,
          kind: n.kind, currency: n.currency, unit: n.unit,
          balance: balances[n.id] ?? n.openingQty, archived: n.archived,
        }));
    },
  }),

  command({
    name: 'movement.transfer',
    context: 'ledger',
    summary: 'Move money between two of your own accounts, exchanging if the currencies differ.',
    detail: "Give the rate the bank actually applied rather than today's mid-market rate, so the record still reads correctly years later. A cash account cannot be driven below zero; the refusal says by how much it is short.",
    input: z.object({
      fromAccountId: NodeId, toAccountId: NodeId,
      amount: z.number().positive(),
      rateApplied: z.number().positive().optional(),
      fee: z.number().min(0).default(0),
      date: DateOnly.optional(), note: z.string().max(500).optional(),
    }).merge(DryRun),
    output: Outcome,
    handler: async (input) => {
      const ctx = ctxOf();
      const ledger = ctx.ledger();
      const from = ledger.node(input.fromAccountId);
      const to = ledger.node(input.toAccountId);
      const crosses = !!(from?.currency && to?.currency && from.currency !== to.currency);

      // A cross-currency movement must carry the rate that applied — a record without it
      // cannot be read back. When none was given, the mid-market rate is filled in and the
      // receipt says so, rather than the movement being refused or the rate being implied.
      const market = readMarket(ctx.db);
      const mid = crosses
        ? (market.fxRates[from!.currency!] ?? 1) / (market.fxRates[to!.currency!] ?? 1)
        : undefined;
      const rate = input.rateApplied ?? (crosses ? mid : undefined);
      const arrives = rate ? (input.amount - input.fee) * rate : input.amount - input.fee;

      return post(ctx, {
        date: input.date ?? today(ctx),
        kind: crosses ? 'exchange' : 'transfer',
        note: input.note,
        legs: [{
          fromNodeId: input.fromAccountId, toNodeId: input.toAccountId,
          qtyFrom: input.amount - input.fee,
          rateApplied: rate,
          feeQty: input.fee || undefined,
          feeNodeId: input.fee ? input.fromAccountId : undefined,
        }],
      }, `${input.amount} ${from?.currency ?? ''} out of ${from?.name ?? '?'}, ${Math.round(arrives)} ${to?.currency ?? ''} into ${to?.name ?? '?'}`.trim(),
      { dryRun: input.dryRun,
        warnings: crosses && !input.rateApplied
          ? [`No rate was given, so the mid-market rate of ${mid?.toFixed(4)} was recorded. The bank almost certainly gave you a different one.`]
          : [] });
    },
  }),

  command({
    name: 'account.correctBalance',
    context: 'ledger',
    summary: 'Restate an account balance the bank disagrees with. It moves no money and explains nothing.',
    detail: 'The account\'s opening figure absorbs the difference, so the balance reads what you typed and every movement against it keeps the effect it had. This is not a movement: nothing was earned, spent or transferred, and the ledger has nothing to say about where the difference came from. It used to be written as a movement from an adjustment account — which the money flow then drew as a source of income called "Corrections", reporting money you had never earned. The act itself is kept in the log of what was done.',
    input: z.object({
      accountId: NodeId, actual: z.number(), note: z.string().max(500).optional(),
    }).merge(DryRun),
    output: Outcome,
    handler: async (input) => {
      const ctx = ctxOf();
      const ledger = ctx.ledger();
      const node = ledger.node(input.accountId);
      if (!node) return refusal('unknown_node', `${input.accountId} is not an account in this ledger.`, 'Call accounts.list for the ids.');

      const have = ledger.balance(input.accountId);
      const drift = input.actual - have;
      if (Math.abs(drift) < 0.005) {
        return refusal('duplicate', `${node.name} already reads ${have}.`, 'Nothing needs correcting.');
      }

      const row = ctx.db.select().from(t.nodes).where(eq(t.nodes.id, input.accountId)).get();
      const opening = (row?.openingQty ?? 0) + drift;
      const summary = `${node.name} restated from ${have} to ${input.actual}`;
      if (input.dryRun) {
        return { ok: true as const, dryRun: true, kind: 'edit' as const, date: today(ctx), summary,
                 changes: [{ nodeId: input.accountId, name: node.name,
                             currency: node.currency ?? undefined, before: have, after: input.actual }],
                 warnings: [RESTATEMENT_WARNING] };
      }
      ctx.db.update(t.nodes).set({ openingQty: opening }).where(eq(t.nodes.id, input.accountId)).run();

      return { ok: true as const, dryRun: false, kind: 'edit' as const, date: today(ctx), summary,
               changes: [{ nodeId: input.accountId, name: node.name,
                           currency: node.currency ?? undefined, before: have, after: input.actual }],
               warnings: [RESTATEMENT_WARNING] };
    },
  }),

  command({
    name: 'institution.add',
    context: 'ledger',
    summary: 'Add a bank or a wallet. Accounts hang off it.',
    input: z.object({
      name: z.string().min(1).max(80), shortCode: z.string().min(1).max(8),
      country: z.string().min(2).max(60), color: z.string().regex(/^#[0-9a-f]{6}$/i),
    }),
    output: z.object({ id: z.string(), summary: z.string() }),
    handler: async (input) => {
      const { db } = ctxOf();
      const id = newId('inst');
      db.insert(t.institutions).values({ ...input, id, archived: false }).run();
      return { id, summary: `${input.name} added` };
    },
  }),

  command({
    name: 'account.add',
    context: 'ledger',
    summary: 'Add an account under an institution, in one currency.',
    detail: 'An opening balance is where the account starts, not a movement. If money arrived, record a movement instead so the log explains the balance.',
    input: z.object({
      institutionId: InstitutionId, name: z.string().min(1).max(80),
      currency: z.string().regex(/^[A-Z]{3}$/),
      kind: z.enum(['cash', 'liability']).default('cash'),
      openingBalance: z.number().default(0),
    }),
    output: z.object({ id: z.string(), summary: z.string() }),
    handler: async (input) => {
      const { db } = ctxOf();
      const id = newId('acct');
      db.insert(t.nodes).values({
        id, kind: input.kind, name: input.name, parentId: input.institutionId,
        currency: input.currency, valuation: input.currency === 'EGP' ? 'face' : 'fx',
        openingQty: input.openingBalance, archived: false,
      }).run();
      return { id, summary: `${input.name} added, opening at ${input.openingBalance} ${input.currency}` };
    },
  }),

  command({
    name: 'institution.update',
    context: 'ledger',
    summary: 'Rename a bank, change its colour, or give it its actual logo.',
    detail: 'The mark may be an icon name or a picture reference from mark.upload — a bank has a logo, and no icon set contains it.',
    input: z.object({
      institutionId: InstitutionId,
      name: z.string().min(1).max(80).optional(),
      shortCode: z.string().min(1).max(8).optional(),
      country: z.string().min(2).max(60).optional(),
      color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
      logo: z.string().max(80).nullable().optional(),
      archived: z.boolean().optional(),
    }),
    output: Outcome,
    handler: async ({ institutionId, ...patch }) => {
      const { db } = ctxOf();
      const row = db.select().from(t.institutions).where(eq(t.institutions.id, institutionId)).get();
      if (!row) return refusal('not_found', `${institutionId} is not an institution.`);
      const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      if (Object.keys(clean).length) {
        db.update(t.institutions).set(clean).where(eq(t.institutions.id, institutionId)).run();
      }
      return noted(`${patch.name ?? row.name} updated`);
    },
  }),

  command({
    name: 'institution.remove',
    context: 'ledger',
    summary: 'Delete a bank that holds nothing. One that still holds an account is archived instead.',
    detail: 'An institution with accounts under it cannot be deleted — the accounts would be left pointing at a bank that no longer exists. Archive it and every balance and every movement stays readable.',
    effect: 'irreversible',
    input: z.object({ institutionId: InstitutionId }),
    output: Outcome,
    handler: async ({ institutionId }) => {
      const { db } = ctxOf();
      const row = db.select().from(t.institutions).where(eq(t.institutions.id, institutionId)).get();
      if (!row) return refusal('not_found', `${institutionId} is not an institution.`);
      const held = db.select().from(t.nodes).all().filter((n) => n.parentId === institutionId).length;
      if (held > 0) {
        return refusal('immutable',
          `${row.name} still holds ${held} account${held === 1 ? '' : 's'}.`,
          'Archive it instead — it leaves the pickers and every movement that names it stays readable.');
      }
      db.delete(t.institutions).where(eq(t.institutions.id, institutionId)).run();
      return noted(`${row.name} deleted`);
    },
  }),

  command({
    name: 'account.remove',
    context: 'ledger',
    summary: 'Delete an account nothing has moved through. One with movements against it is archived instead.',
    detail: 'Deleting an account that movements name would rewrite what already happened, so it is refused. Archiving is the honest answer there: the balance freezes and every row in the log stays exactly as it was.',
    effect: 'irreversible',
    input: z.object({ accountId: NodeId }),
    output: Outcome,
    handler: async ({ accountId }) => {
      const { db } = ctxOf();
      const node = db.select().from(t.nodes).where(eq(t.nodes.id, accountId)).get();
      if (!node) return refusal('unknown_node', `${accountId} is not an account in this ledger.`);

      const used = db.select().from(t.legs).all()
        .filter((l) => l.fromNodeId === accountId || l.toNodeId === accountId
                    || l.feeNodeId === accountId).length;
      if (used > 0) {
        return refusal('immutable',
          used === 1 ? `1 movement names ${node.name}.` : `${used} movements name ${node.name}.`,
          'Archive it instead — archiving freezes the balance and keeps every row in the log.');
      }
      // The three holdings the ledger is built on are structure rather than records: without
      // them there is nowhere for metal or shares to live at all.
      if (['gold', 'silver', 'brokerage-cash'].includes(accountId)) {
        return refusal('immutable', `${node.name} is part of how this ledger is put together.`,
                       'It holds nothing and costs nothing to keep. Turn its module off in Settings if it is in the way.');
      }
      db.delete(t.nodes).where(eq(t.nodes.id, accountId)).run();
      return noted(`${node.name} deleted`);
    },
  }),

  command({
    name: 'account.update',
    context: 'ledger',
    summary: 'Rename an account, or change which currency it is held in.',
    detail: 'Changing what it holds is a different act — account.correctBalance writes a correction movement, so the log explains the difference rather than a number quietly changing.',
    input: z.object({
      accountId: NodeId,
      name: z.string().min(1).max(80).optional(),
      currency: z.string().regex(/^[A-Z]{3}$/).optional(),
      color: z.string().max(80).optional(),
    }),
    output: Outcome,
    handler: async ({ accountId, ...patch }) => {
      const { db } = ctxOf();
      const row = db.select().from(t.nodes).where(eq(t.nodes.id, accountId)).get();
      if (!row) return refusal('unknown_node', `${accountId} is not an account in this ledger.`);

      if (patch.currency && patch.currency !== row.currency) {
        // Restating the currency does not convert the balance — the number stays and its
        // unit changes, which is only ever right when the account was recorded in the wrong
        // currency to begin with. Saying so is better than silently reinterpreting money.
        const moved = db.select().from(t.legs).all()
          .filter((l) => l.fromNodeId === accountId || l.toNodeId === accountId).length;
        if (moved > 0) {
          return refusal('immutable',
            `${row.name} has ${moved} movement${moved === 1 ? '' : 's'} recorded in ${row.currency}.`,
            'Changing the currency now would reinterpret every one of them. Archive this account and add one in the currency you want.');
        }
      }

      const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      if (Object.keys(clean).length) {
        db.update(t.nodes).set(clean).where(eq(t.nodes.id, accountId)).run();
      }
      return noted([
        patch.name && patch.name !== row.name ? `renamed to ${patch.name}` : null,
        patch.currency && patch.currency !== row.currency ? `now held in ${patch.currency}` : null,
      ].filter(Boolean).join(', ') || `${row.name} unchanged`);
    },
  }),

  command({
    name: 'account.archive',
    context: 'ledger',
    summary: 'Archive an account: it leaves the pickers and keeps every movement that names it.',
    detail: 'Archiving rather than deleting is deliberate. An account with movements cannot be deleted, because that would rewrite what already happened.',
    input: z.object({ accountId: NodeId, restore: z.boolean().default(false) }),
    output: Outcome,
    handler: async ({ accountId, restore }) => {
      const { db } = ctxOf();
      const node = db.select().from(t.nodes).where(eq(t.nodes.id, accountId)).get();
      if (!node) return refusal('unknown_node', `${accountId} is not an account in this ledger.`);
      db.update(t.nodes).set({ archived: !restore }).where(eq(t.nodes.id, accountId)).run();
      return noted(`${node.name} ${restore ? 'restored' : 'archived'}`);
    },
  }),

  query({
    name: 'ledger.search',
    context: 'ledger',
    summary: 'Search every log at once — expenses, giving, income, orders and movement notes.',
    detail: 'One full-text index covers all of them. Partial words match, and diacritics are folded, so an Arabic note is findable typed either way.',
    input: z.object({
      q: z.string().min(1).max(200),
      kinds: z.array(z.enum(['expense', 'giving', 'income', 'order', 'movement', 'lot', 'note'])).optional(),
      limit: z.number().int().min(1).max(200).default(50),
    }),
    output: z.array(z.object({
      kind: z.string(), recordId: z.string(), occurredOn: z.string(),
      title: z.string(), body: z.string(),
    })),
    handler: async (input) => {
      const { db } = ctxOf();
      return ftsSearch(db, input.q, { kinds: input.kinds, limit: input.limit })
        .map(({ rank, ...rest }) => rest);
    },
  }),

];

/**
 * What a restatement is, said once, wherever one is reported.
 *
 * A balance that changes with nothing behind it is exactly that, and saying so is the whole
 * of the ledger's honesty about it. The earlier answer — inventing a movement from an
 * adjustment account so the log could "account for" the difference — accounted for nothing:
 * it named a source that does not exist, and the money flow read that source as income.
 */
const RESTATEMENT_WARNING =
  'This restates the balance. No movement was recorded, so nothing here says where the '
  + 'difference came from; the act is in the log of what was done.';
