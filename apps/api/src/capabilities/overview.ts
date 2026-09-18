import { z } from 'zod';
import { command, query, Outcome } from '@ledger/contracts';
import { schema as t } from '@ledger/db';
import { toEgp, fromEgp } from '@ledger/engine';
import type { AppCtx } from '../context.js';
import { noted } from './shared.js';
import { readMarket, readPref, writePref } from '../read.js';
import { ledgerHoldings } from '../valuation.js';
import { readBase, readCurrencies } from './currencies.js';
import { assetKindOf, isDebtNode } from '../zakat-assets.js';

/**
 * The whole picture, and the settings that shape it.
 *
 * `portfolio.overview` is the one call an agent should be able to make to know where things
 * stand, so it answers in the ledger's own currency and says which currency that is — a
 * number without its unit is the fastest way to be wrong with confidence.
 */
/**
 * The one reading of "where things stand", shared by `portfolio.overview` and by anything
 * that has to freeze the same figure — a monthly statement, chiefly.
 *
 * Kept separate from the capability so the two can never drift: a statement's netWorth is
 * this function's answer at the moment it was called, not a second arithmetic that happens to
 * agree with it today.
 */
export function wealthSnapshot(ctx: AppCtx, currency?: string) {
  const market = readMarket(ctx.db);
  const display = currency ?? (readPref<any>(ctx.db, 'settings')?.displayCurrency ?? 'EGP');
  const d = (egp: number) => fromEgp(egp, display, market);

  /**
   * What is held, not what was forecast.
   *
   * This used to walk forward from the opening snapshot, which is the right answer to a
   * different question and produced a net worth the zakat assessment — reading the same
   * ledger's balances — openly contradicted.
   */
  const h = ledgerHoldings(ctx.db, market);

  /**
   * The share book is the positions and the wallet behind them.
   *
   * Money sitting uninvested at the broker is cash — that is what the holdings say and
   * what the zakat base counts — but it is not cash at a bank, and every screen that
   * draws the book draws it as one thing. Reported here the same way, so an agent asking
   * where things stand and a person looking at the portfolio see the same split.
   *
   * Money lent out is its own line for the same reason. It counts towards what you are
   * worth — a debt owed to you is wealth you happen not to be holding — but it is not a
   * chattel, and inside "Other" it was reported as one.
   */
  const parts: Array<[string, number]> = [
    ['Cash', h.cash - h.brokerageCash], ['Real estate', h.realEstate],
    ['Gold and silver', h.metals], ['Vehicles', h.vehicles],
    ['Shares', h.shares + h.brokerageCash], ['Lent out', h.lent], ['Other', h.other],
  ];
  const owned = parts.reduce((s, [, v]) => s + v, 0);
  return {
    currency: display,
    netWorth: d(h.total),
    owedOnPlans: d(h.contracts),
    allocation: [
      ...parts.filter(([, v]) => v !== 0).map(([label, egp]) => ({
        label, amount: d(egp), share: owned ? egp / owned : 0,
      })),
      ...(h.liabilities > 0
        ? [{ label: 'Owed', amount: d(-h.liabilities), share: owned ? -h.liabilities / owned : 0 }]
        : []),
    ],
    rates: market.fxRates,
    asOf: ctx.now.toISOString().slice(0, 10),
  };
}

export const overviewCaps = (ctxOf: () => AppCtx) => [
  query({
    name: 'portfolio.overview',
    context: 'overview',
    summary: 'Net worth and how it is split, in the ledger\'s own currency.',
    detail: 'The single call to make when you need to know where things stand. Every figure is stated with the currency it is in.',
    input: z.object({ currency: z.string().regex(/^[A-Z]{3}$/).optional() }),
    output: z.object({
      currency: z.string(),
      netWorth: z.number(),
      /** still to be paid under a purchase plan; owned less owed does not include it */
      owedOnPlans: z.number(),
      allocation: z.array(z.object({ label: z.string(), amount: z.number(), share: z.number() })),
      rates: z.record(z.string(), z.number()),
      asOf: z.string(),
    }),
    handler: async ({ currency }) => wealthSnapshot(ctxOf(), currency),
  }),

  query({
    name: 'flow.month',
    context: 'overview',
    summary: 'Where money came from and where it went, for one month.',
    detail: 'Each entry is a pair of endpoints and a total in the ledger\'s base currency, which is what makes flows in different currencies comparable — and what lets the chart draw a band whose width means something.',
    input: z.object({
      month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
      /**
       * How far back from that month to read.
       *
       * A quarterly installment is invisible in eleven months out of twelve, and a chart
       * that can only ever answer for one of them says the property does not exist.
       */
      span: z.enum(['month', 'quarter', 'year', 'all']).optional(),
    }),
    output: z.object({
      month: z.string(),
      /** the first month included, which is the month itself for a span of one */
      from: z.string(),
      flows: z.array(z.object({
        from: z.string(), fromName: z.string(), to: z.string(), toName: z.string(),
        /** in the ledger's base currency, so flows in different currencies can be compared */
        amount: z.number(),
        /** what actually moved, in the unit the source holds */
        native: z.number(), nativeUnit: z.string().nullable(),
        count: z.number(), kind: z.string(),
      })),
    }),
    handler: async ({ month, span }) => {
      const ctx = ctxOf();
      const bucket = month ?? ctx.now.toISOString().slice(0, 7);
      const back = span === 'year' ? 11 : span === 'quarter' ? 2 : 0;
      const [by, bm] = bucket.split('-').map(Number);
      const first = new Date(by!, (bm ?? 1) - 1 - back, 1);
      // everything the ledger holds, which sorts before any real month as a string
      const from = span === 'all' ? '0000-00'
        : `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, '0')}`;
      const names = new Map(ctx.db.select().from(t.nodes).all().map((n) => [n.id, n.name]));
      for (const c of ctx.db.select().from(t.categories).all()) names.set(c.id, c.name);

      // A leg's quantity is in the unit its source holds, so summing across accounts would
      // add dollars to pounds. Each leg is converted first, at the rate the ledger is using.
      const market = readMarket(ctx.db);
      const nodes = new Map(ctx.db.select().from(t.nodes).all().map((n) => [n.id, n]));
      /*
       * A correction and the movement it corrects cancel each other out, and the chart is
       * what stands rather than what was typed. Drawn, the pair became a band in and an
       * identical band back out — a month's income counted once as arriving and once as
       * leaving, which is how the chart came to report spending that never happened. The
       * log still holds both: this is the picture, not the record.
       */
      const rows = ctx.db.$raw.prepare(`
        SELECT COALESCE(l.from_node_id, 'outside') AS f,
               COALESCE(l.to_node_id, l.category_id, 'outside') AS tt,
               tx.kind AS kind,
               COALESCE(l.qty_from, 0) AS qty,
               COALESCE(l.qty_to, l.qty_from, 0) AS qtyTo
        FROM legs l JOIN transactions tx ON tx.id = l.transaction_id
        WHERE substr(l.date, 1, 7) BETWEEN ? AND ?
          AND tx.corrects_id IS NULL
          AND tx.id NOT IN (SELECT corrects_id FROM transactions WHERE corrects_id IS NOT NULL)
      `).all(from, bucket) as Array<{ f: string; tt: string; kind: string; qty: number; qtyTo: number }>;

      const merged = new Map<string, {
        f: string; tt: string; kind: string; amount: number; native: number;
        nativeUnit: string | null; count: number;
      }>();

      for (const r of rows) {
        const src = nodes.get(r.f);
        const dst = nodes.get(r.tt);
        // value it from whichever side actually carries a currency; a category has none
        const egp = src?.currency ? toEgp(r.qty, src.currency, market)
                  : dst?.currency ? toEgp(r.qtyTo, dst.currency, market)
                  : r.qty;
        const key = `${r.f}|${r.tt}|${r.kind}`;
        const at = merged.get(key);
        if (at) { at.amount += egp; at.native += r.qty; at.count += 1; }
        else merged.set(key, {
          f: r.f, tt: r.tt, kind: r.kind, amount: egp, native: r.qty,
          nativeUnit: src?.currency ?? src?.unit ?? null, count: 1,
        });
      }

      return {
        month: bucket,
        from,
        flows: [...merged.values()]
          .sort((a, b) => b.amount - a.amount)
          .map((r) => ({
            from: r.f, fromName: names.get(r.f) ?? r.f,
            to: r.tt, toName: names.get(r.tt) ?? r.tt,
            amount: r.amount, native: r.native, nativeUnit: r.nativeUnit,
            count: r.count, kind: r.kind,
          })),
      };
    },
  }),

  query({
    name: 'catalogue.read',
    context: 'overview',
    summary: 'The structure of the ledger: institutions, accounts, destinations and income sources.',
    detail: 'What the screens draw before any figure is filled in. Read this after any edit — it is what makes a rename or a new destination appear everywhere at once.',
    input: z.object({}),
    output: z.object({
      institutions: z.array(z.object({
        id: z.string(), name: z.string(), shortCode: z.string(), country: z.string(),
        color: z.string(), logo: z.string().nullable(), archived: z.boolean(),
      })),
      nodes: z.array(z.object({
        id: z.string(), kind: z.string(), name: z.string(), parentId: z.string().nullable(),
        currency: z.string().nullable(), unit: z.string().nullable(),
        openingQty: z.number(), color: z.string().nullable(), archived: z.boolean(),
        /**
         * How the thing is valued, and the tick to value it against.
         *
         * These are columns on the node and belong with the rest of it. The screens used to
         * take them from the demonstration fixture instead, which meant a real account the
         * fixture had never heard of came back valued at face and a holding lost its price.
         */
        valuation: z.enum(['face', 'fx', 'live_price', 'fixed']),
        priceKey: z.string().nullable(),
        /**
         * What kind of thing an asset is, and how it was paid for.
         *
         * Derived here the same way `assets.list` derives it, so the screens never have to
         * guess. Guessing is what they did — a name matched against /car|vehicle/ — which
         * put a car called "BMW" and a flat with no plan against it into neither pile, so
         * the portfolio counted them in the total and showed nothing for them.
         */
        assetKind: z.string().nullable(),
        ownership: z.string().nullable(),
      })),
      categories: z.array(z.object({
        id: z.string(), domain: z.string(), name: z.string(), color: z.string(),
        icon: z.string().nullable(), note: z.string().nullable(),
        /** the account this kind of spending usually comes out of, where one is set */
        accountId: z.string().nullable(), archived: z.boolean(),
      })),
      currencies: z.array(z.object({
        code: z.string(), name: z.string(), symbol: z.string(), minorUnits: z.number(),
        color: z.string(), mark: z.string().optional(), archived: z.boolean().optional(),
      })),
      incomeSources: z.array(z.object({
        id: z.string(), name: z.string(), amount: z.number().nullable(), currency: z.string(),
        cadence: z.string(), dayOfMonth: z.string().nullable(), toNodeId: z.string(),
        scheduled: z.boolean(), icon: z.string().nullable(), color: z.string().nullable(),
        startDate: z.string().nullable(), endDate: z.string().nullable(),
        /** the asset this income comes out of, when it is rent rather than a wage */
        assetId: z.string().nullable(), archived: z.boolean(),
      })),
    }),
    handler: async () => {
      const { db } = ctxOf();
      // something with a payment plan against it is a property bought on one, whatever its
      // column says — the same reading the assets list and the assessment take
      const planned = new Set(db.select().from(t.installments).all().map((i) => i.propertyId));
      return {
        currencies: readCurrencies(db).filter((c) => !c.archived),
        institutions: db.select().from(t.institutions).all(),
        nodes: db.select().from(t.nodes).all().map((n) => ({
          id: n.id, kind: n.kind, name: n.name, parentId: n.parentId,
          currency: n.currency, unit: n.unit, openingQty: n.openingQty,
          color: n.color, archived: n.archived,
          valuation: n.valuation, priceKey: n.priceKey,
          // Money lent out says so, so the portfolio can draw it as the debt it is rather
          // than reading it as a chattel and putting a loan in the pile with the machines.
          assetKind: n.kind === 'asset' && !n.unit
            ? isDebtNode(n)
              ? 'debt'
              : assetKindOf(n as { id: string; name: string; assetKind?: string | null },
                            planned.has(n.id))
            : null,
          ownership: (n as { ownership?: string | null }).ownership ?? null,
        })),
        categories: db.select().from(t.categories).all(),
        incomeSources: db.select().from(t.incomeSources).all()
          .map((x) => ({ ...x, assetId: (x as { assetId?: string | null }).assetId ?? null })),
      };
    },
  }),

  query({
    name: 'settings.read',
    context: 'overview',
    summary: 'The constants the calculations follow — budget, contract end, karat, which accounts are which.',
    input: z.object({}),
    output: z.record(z.string(), z.any()),
    handler: async () => {
      const ctx = ctxOf();
      return {
        settings: readPref(ctx.db, 'settings') ?? {},
        zakat: readPref(ctx.db, 'zakat') ?? {},
        appearance: readPref(ctx.db, 'appearance') ?? {},
        modules: readPref(ctx.db, 'modules') ?? {},
      };
    },
  }),

  command({
    name: 'settings.update',
    context: 'overview',
    summary: 'Change one of the ledger\'s constants.',
    detail: 'These feed the accrual and the forecast, so changing one changes what every screen reports. Nothing here writes a movement.',
    input: z.object({
      key: z.enum(['settings', 'appearance', 'modules']),
      patch: z.record(z.string(), z.any()),
    }),
    output: Outcome,
    handler: async ({ key, patch }) => {
      const ctx = ctxOf();
      const current = (readPref<Record<string, unknown>>(ctx.db, key) ?? {});
      writePref(ctx.db, key, { ...current, ...patch });
      return noted(`${Object.keys(patch).join(', ')} updated`);
    },
  }),

  command({
    name: 'market.record',
    context: 'overview',
    summary: 'Record a rate or a price as at now — the dollar, gold per gram, a share price.',
    detail: 'Rates are ticks rather than settings, so any figure can be traced to when it was taken. Keys look like USD_EGP, gold_24k_g, gold_oz_usd, or price_ACME.',
    input: z.object({
      key: z.string().min(2).max(40),
      value: z.number().positive(),
      source: z.string().max(40).optional(),
      live: z.boolean().default(true),
    }),
    output: Outcome,
    handler: async ({ key, value, source, live }) => {
      const ctx = ctxOf();
      ctx.db.insert(t.marketTicks).values({
        at: ctx.now.toISOString(), key, value, source: source ?? null, live,
      }).run();
      return noted(`${key} recorded at ${value}`);
    },
  }),

  query({
    name: 'market.read',
    context: 'overview',
    summary: 'The rates and prices the ledger is currently using, and when each was taken.',
    detail: 'Rates are quoted against the ledger\'s own currency, which is what "base" names. These are the figures last recorded, whether that was by hand or by market.refresh — reading never fetches.',
    input: z.object({}),
    output: z.object({
      base: z.string(),
      usdEgp: z.number(), goldPerG: z.number(), goldPerOz: z.number().nullable(),
      fxRates: z.record(z.string(), z.number()), prices: z.record(z.string(), z.number()),
      updatedAt: z.string().optional(),
      /** when each key was last recorded, so a stale one can be shown as stale */
      recordedAt: z.record(z.string(), z.string()),
    }),
    handler: async () => {
      const ctx = ctxOf();
      const m = readMarket(ctx.db);
      const recordedAt = Object.fromEntries(
        (ctx.db.$raw.prepare(`
          SELECT key, at FROM market_ticks WHERE id IN (SELECT MAX(id) FROM market_ticks GROUP BY key)
        `).all() as Array<{ key: string; at: string }>).map((r) => [r.key, r.at]));
      return { base: readBase(ctx.db), usdEgp: m.usdEgp, goldPerG: m.goldPerG,
               goldPerOz: m.goldPerOz, fxRates: m.fxRates, prices: m.prices,
               updatedAt: m.pricesUpdatedAt, recordedAt };
    },
  }),
];

export { toEgp };
