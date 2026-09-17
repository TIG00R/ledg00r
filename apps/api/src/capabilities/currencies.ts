import { z } from 'zod';
import { command, query, Outcome } from '@ledger/contracts';
import type { AppCtx } from '../context.js';
import { noted, refusal } from './shared.js';
import { readPref, writePref } from '../read.js';
import { schema as t } from '@ledger/db';

/**
 * The currencies this ledger knows.
 *
 * A currency has to exist before anything can be denominated in it, so this is the one list
 * that is configured first and then offered everywhere else — an account, an income source,
 * an expense all pick from here rather than each screen carrying its own guess at what is
 * reasonable. Adding one is how a new currency reaches every dropdown at once.
 *
 * `minorUnits` decides rounding, and `mark` may be an icon name or an uploaded picture.
 */
export interface CurrencyDef {
  code: string;
  name: string;
  symbol: string;
  minorUnits: number;
  color: string;
  mark?: string;
  archived?: boolean;
}

export const DEFAULT_CURRENCIES: CurrencyDef[] = [
  { code: 'EGP', name: 'Egyptian pound', symbol: 'E£', minorUnits: 2, color: '#B37E00' },
  { code: 'USD', name: 'US dollar', symbol: '$', minorUnits: 2, color: '#3F7D4F' },
  { code: 'GBP', name: 'Pound sterling', symbol: '£', minorUnits: 2, color: '#6B4E9E' },
  { code: 'EUR', name: 'Euro', symbol: '€', minorUnits: 2, color: '#0086A8' },
];

export function readCurrencies(db: AppCtx['db']): CurrencyDef[] {
  return readPref<CurrencyDef[]>(db, 'currencies') ?? DEFAULT_CURRENCIES;
}

/** The currency every total is reported in. Everything else is quoted against it. */
export function readBase(db: AppCtx['db']): string {
  return (readPref<{ base?: string }>(db, 'settings')?.base) ?? 'EGP';
}

export const currencyCaps = (ctxOf: () => AppCtx) => [
  query({
    name: 'currency.base',
    context: 'overview',
    summary: 'Which currency this ledger reports in.',
    input: z.object({}),
    output: z.object({ base: z.string(), rateCount: z.number() }),
    handler: async () => {
      const { db } = ctxOf();
      const base = readBase(db);
      const n = db.$raw.prepare(
        "SELECT COUNT(DISTINCT key) AS n FROM market_ticks WHERE key LIKE '%\\_' || ? ESCAPE '\\'",
      ).get(base) as { n: number };
      return { base, rateCount: n.n };
    },
  }),

  command({
    name: 'currency.setBase',
    context: 'overview',
    summary: 'Change the currency this ledger reports in. Every recorded rate is discarded.',
    detail: 'A rate says what one currency is worth in another, so rates quoted against the old base mean nothing against the new one. Rather than silently reinterpreting them — which would make every total wrong in a way nobody could see — they are cleared and you are asked to record them again. Pass confirm to go ahead.',
    effect: 'irreversible',
    input: z.object({
      base: z.string().regex(/^[A-Za-z]{3}$/),
      confirm: z.boolean().default(false),
    }),
    output: Outcome,
    handler: async ({ base, confirm }) => {
      const ctx = ctxOf();
      const up = base.toUpperCase();
      const current = readBase(ctx.db);
      if (up === current) return refusal('duplicate', `${up} is already this ledger's currency.`);
      if (!readCurrencies(ctx.db).some((c) => c.code === up)) {
        return refusal('not_found', `${up} is not one of this ledger's currencies.`,
                       'Add it in the Currency Zone first.');
      }

      const rates = ctx.db.$raw.prepare(
        'SELECT COUNT(*) AS n FROM market_ticks',
      ).get() as { n: number };

      if (!confirm) {
        return refusal('immutable',
          `Changing to ${up} discards all ${rates.n} recorded rates and prices.`,
          `Every rate says what something is worth in ${current}, and none of them mean anything in ${up}. Confirm to go ahead, then record them again against ${up}.`);
      }

      ctx.db.$raw.exec('DELETE FROM market_ticks');
      writePref(ctx.db, 'settings', { ...(readPref<object>(ctx.db, 'settings') ?? {}), base: up });
      return noted(
        `This ledger now reports in ${up}. All ${rates.n} rates and prices were discarded — record them again against ${up} in the Currency Zone.`,
      );
    },
  }),
  query({
    name: 'currencies.list',
    context: 'overview',
    summary: 'The currencies this ledger knows, in the order they are offered.',
    detail: 'Everything that asks for a currency offers exactly this list, so adding one here is how it reaches every dropdown.',
    input: z.object({ includeArchived: z.boolean().default(false) }),
    output: z.array(z.object({
      code: z.string(), name: z.string(), symbol: z.string(),
      minorUnits: z.number(), color: z.string(),
      mark: z.string().optional(), archived: z.boolean().optional(),
    })),
    handler: async ({ includeArchived }) =>
      readCurrencies(ctxOf().db).filter((c) => includeArchived || !c.archived),
  }),

  command({
    name: 'currency.add',
    context: 'overview',
    summary: 'Teach this ledger a currency, so accounts and records can be denominated in it.',
    detail: 'The code is the three-letter ISO one. Minor units decides rounding — 2 for most, 3 for the dinars, 0 for the yen.',
    input: z.object({
      code: z.string().regex(/^[A-Za-z]{3}$/),
      name: z.string().min(1).max(60),
      symbol: z.string().min(1).max(6),
      minorUnits: z.number().int().min(0).max(4).default(2),
      color: z.string().regex(/^#[0-9a-f]{6}$/i).default('#8A8578'),
      mark: z.string().max(80).optional(),
    }),
    output: Outcome,
    handler: async (input) => {
      const ctx = ctxOf();
      const code = input.code.toUpperCase();
      const all = readCurrencies(ctx.db);
      if (all.some((c) => c.code === code)) {
        return refusal('duplicate', `${code} is already one of this ledger's currencies.`,
                       'Edit it instead, or restore it if it was archived.');
      }
      writePref(ctx.db, 'currencies', [...all, { ...input, code }]);
      return noted(`${code} — ${input.name} — added`);
    },
  }),

  command({
    name: 'currency.update',
    context: 'overview',
    summary: 'Change how a currency is named, marked, coloured or rounded.',
    detail: 'The code itself never changes: records already name it, and renaming it would leave them pointing at nothing.',
    input: z.object({
      code: z.string().regex(/^[A-Za-z]{3}$/),
      name: z.string().min(1).max(60).optional(),
      symbol: z.string().min(1).max(6).optional(),
      minorUnits: z.number().int().min(0).max(4).optional(),
      color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
      mark: z.string().max(80).optional(),
      archived: z.boolean().optional(),
    }),
    output: Outcome,
    handler: async ({ code, ...patch }) => {
      const ctx = ctxOf();
      const up = code.toUpperCase();
      const all = readCurrencies(ctx.db);
      const cur = all.find((c) => c.code === up);
      if (!cur) return refusal('not_found', `${up} is not one of this ledger's currencies.`);

      if (patch.archived) {
        // A currency an account is denominated in cannot be retired: every balance it holds
        // would lose the unit that gives it meaning.
        const used = ctx.db.select().from(t.nodes).all().filter((n) => n.currency === up && !n.archived);
        if (used.length) {
          return refusal('immutable',
                         `${used.length} account${used.length === 1 ? ' is' : 's are'} still held in ${up}.`,
                         'Archive those accounts first, or leave the currency in place.');
        }
      }
      const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      writePref(ctx.db, 'currencies', all.map((c) => (c.code === up ? { ...c, ...clean } : c)));
      return noted(`${up} updated`);
    },
  }),

  command({
    name: 'currency.remove',
    context: 'overview',
    summary: 'Forget a currency nothing is denominated in. One that is still in use is archived instead.',
    detail: 'A currency an account or a record names cannot be forgotten: every figure held in it would lose the unit that gives it meaning. The ledger\'s own reporting currency cannot go either.',
    effect: 'irreversible',
    input: z.object({ code: z.string().regex(/^[A-Za-z]{3}$/) }),
    output: Outcome,
    handler: async ({ code }) => {
      const ctx = ctxOf();
      const up = code.toUpperCase();
      const all = readCurrencies(ctx.db);
      const cur = all.find((c) => c.code === up);
      if (!cur) return refusal('not_found', `${up} is not one of this ledger's currencies.`);
      if (up === readBase(ctx.db)) {
        return refusal('immutable', `${up} is the currency this ledger reports in.`,
                       'Choose another reporting currency first.');
      }

      const accounts = ctx.db.select().from(t.nodes).all().filter((n) => n.currency === up).length;
      const records = ctx.db.select().from(t.expenses).all().filter((e) => e.currency === up).length
        + ctx.db.select().from(t.charity).all().filter((c) => c.currency === up).length
        + ctx.db.select().from(t.debts).all().filter((d) => d.currency === up).length
        + ctx.db.select().from(t.incomeSources).all().filter((s) => s.currency === up).length;
      if (accounts + records > 0) {
        return refusal('immutable',
          `${accounts + records} account${accounts + records === 1 ? ' or record is' : 's or records are'} held in ${up}.`,
          'Archive it instead — it leaves the pickers and every figure keeps its unit.');
      }

      writePref(ctx.db, 'currencies', all.filter((c) => c.code !== up));
      return noted(`${up} forgotten`);
    },
  }),
];
