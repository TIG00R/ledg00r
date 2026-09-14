import { z } from 'zod';
import { command, query, Outcome } from '@ledger/contracts';
import { eq } from 'drizzle-orm';
import { schema as t } from '@ledger/db';
import {
  calendarEvents, toIcs, installmentDueDate, nisabEgp, hijriTextOfIso,
  CALENDAR_COLORS, CALENDAR_LABELS, CALENDAR_ICONS,
  type Reminder, type RecurringTemplate, type ZakatSettings, type CalendarEvent,
  type CalendarEntry,
} from '@ledger/engine';
import { noted, refusal, newId } from './shared.js';
import type { AppCtx } from '../context.js';
import { buildDataset, readMarket, readPref } from '../read.js';
import { assetsForZakat, assetKindOf } from '../zakat-assets.js';

const DEFAULT_ZAKAT: ZakatSettings = {
  anniversaryMonth: 9, anniversaryDay: 1, basis: 'gold', silverPerG: 52, deductDebts: false,
};

/**
 * Everything this ledger knows the date of.
 *
 * Assembled here so the calendar screen and the feed a phone subscribes to are the same
 * events rather than two lists that agree until one of them changes.
 */
export function buildCalendar(ctx: AppCtx, opts: { horizonDays?: number; backDays?: number } = {}): CalendarEvent[] {
  const { data } = buildDataset(ctx.db, ctx.now);
  const market = readMarket(ctx.db);
  const zakat = readPref<ZakatSettings>(ctx.db, 'zakat') ?? DEFAULT_ZAKAT;
  const nisab = nisabEgp(market, zakat);

  const reminders: Reminder[] = ctx.db.select().from(t.reminders).all().map((r) => ({
    id: r.id, subject: r.subject as Reminder['subject'], subjectId: r.subjectId ?? undefined,
    enabled: r.enabled, offsetValue: r.offsetValue, offsetUnit: r.offsetUnit,
    note: r.note ?? undefined, direction: r.direction ?? undefined,
    triggerPrice: r.triggerPrice ?? undefined, dueDate: r.dueDate ?? undefined,
    cadence: (r.cadence as Reminder['cadence']) ?? undefined,
    graceDays: r.graceDays ?? undefined,
  }));

  const recurring: RecurringTemplate[] = ctx.db.select().from(t.recurringTemplates).all()
    .map((r) => ({
      id: r.id, name: r.name, fromNodeId: r.fromNodeId ?? undefined,
      toNodeId: r.toNodeId ?? undefined, amount: r.amount, currency: r.currency,
      cadence: r.cadence as RecurringTemplate['cadence'],
      dayOfMonth: r.dayOfMonth === 'last' ? 'last' : r.dayOfMonth ? Number(r.dayOfMonth) : undefined,
      startDate: r.startDate ?? undefined, endDate: r.endDate ?? undefined,
      categoryId: r.categoryId ?? undefined, enabled: r.enabled,
      internal: r.internal, note: r.note ?? undefined,
    }));

  const nodeRows = ctx.db.select().from(t.nodes).all();
  const names = new Map(nodeRows.map((n) => [n.id, n.name]));
  const nodeById = new Map(nodeRows.map((n) => [n.id, n]));
  const plans = new Set(ctx.db.select().from(t.installments).all().map((i) => i.propertyId));

  /**
   * The mark a payment on a thing should wear.
   *
   * Its own, if it has been given one — a payment on the flat is drawn as that
   * flat's mark, not as a generic building. Failing that, the mark of what kind of thing it
   * is, which is the same derivation the assets list and the zakat assessment use.
   */
  const markOf = (id: string): string | null => {
    const n = nodeById.get(id);
    if (!n) return null;
    if (n.icon) return n.icon;
    const kind = assetKindOf(n as { id: string; name: string; assetKind?: string | null }, plans.has(id));
    return kind === 'vehicle' ? 'car' : kind === 'property' ? 'building' : 'assets';
  };

  const installments = ctx.db.select().from(t.installments).all().map((i) => ({
    id: i.id, propertyId: i.propertyId, property: names.get(i.propertyId) ?? i.propertyId,
    dueOn: i.dueDate
      ?? installmentDueDate(i.monthLabel, i.dueDayKind, i.dueDayNum ?? undefined)?.toISOString().slice(0, 10)
      ?? '',
    amountEgp: i.amountEgp, note: i.note, paidAt: i.paidAt, icon: markOf(i.propertyId),
  }));

  const owned = assetsForZakat(ctx.db, ctx.now, market, nisab);

  const entries: CalendarEntry[] = ctx.db.select().from(t.calendarEntries).all()
    .map((e) => ({
      id: e.id, date: e.date, title: e.title, note: e.note, color: e.color,
      repeat: e.repeat, remindDays: e.remindDays, amount: e.amount,
      currency: e.currency, doneAt: e.doneAt,
    }));

  return calendarEvents(data, market, reminders, ctx.now, {
    zakat, recurring, installments, entries, activity: ledgerActivity(ctx, markOf),
    assetLines: [...owned.lines, ...owned.metal.lines],
    horizonDays: opts.horizonDays ?? 400,
    backDays: opts.backDays ?? 400,
  });
}

/**
 * Everything the ledger has recorded, as days.
 *
 * Every table in here has a date column, and every row in them is something that happened on
 * a day: money spent, money given, metal bought, an order filled, a debt made and settled,
 * value moved between two of your own things. A calendar that showed only what is still to
 * come could not answer the question people actually open one to ask, which is "what happened
 * on the fourteenth".
 *
 * Each row carries the mark of the thing it happened to rather than a generic one for its
 * table: a destination's own icon, a cause's own icon, gold's or silver's.
 */
function ledgerActivity(
  ctx: AppCtx, markOf: (id: string) => string | null,
): NonNullable<Parameters<typeof calendarEvents>[4]>['activity'] {
  const out: NonNullable<Parameters<typeof calendarEvents>[4]>['activity'] = [];
  const categories = new Map(ctx.db.select().from(t.categories).all().map((c) => [c.id, c]));
  const names = new Map(ctx.db.select().from(t.nodes).all().map((n) => [n.id, n.name]));

  for (const e of ctx.db.select().from(t.expenses).all()) {
    const cat = categories.get(e.categoryId);
    out.push({
      id: `exp-${e.id}`, date: e.date, kind: 'expense',
      title: e.place || cat?.name || 'Spent',
      detail: [cat?.name, e.note].filter(Boolean).join(' · ') || undefined,
      amount: e.amount, currency: e.currency,
      icon: cat?.icon ?? undefined, color: cat?.color ?? undefined,
    });
  }

  for (const g of ctx.db.select().from(t.charity).all()) {
    const cause = categories.get(g.categoryId);
    out.push({
      id: `give-${g.id}`, date: g.date, kind: g.isZakat ? 'sadaqah' : 'giving',
      title: `${g.isZakat ? 'Zakat' : 'Sadaqat'} — ${cause?.name ?? 'given'}`,
      detail: g.note ?? undefined,
      amount: g.usd ?? g.egp, currency: g.currency,
      icon: cause?.icon ?? undefined, color: cause?.color ?? undefined,
    });
  }

  for (const l of ctx.db.select().from(t.goldLots).all()) {
    const date = l.date ?? (/^\d{4}-\d{2}-\d{2}$/.test(l.dateText) ? l.dateText : null);
    if (!date) continue;
    const metal = l.metal ?? 'gold';
    out.push({
      id: `lot-${l.id}`, date, kind: 'metal',
      title: `${l.direction === 'sell' ? 'Sold' : 'Bought'} ${l.grams} g of ${metal}`,
      detail: [l.note, `${Math.round(l.pricePerGram)} a gram`,
               (l as { intention?: string | null }).intention === 'personal' ? 'worn' : null]
        .filter(Boolean).join(' · '),
      amount: l.totalEgp, currency: 'EGP',
      icon: metal === 'silver' ? 'coins' : 'goldbar',
    });
  }

  for (const o of ctx.db.select().from(t.orders).all()) {
    out.push({
      id: `ord-${o.id}`, date: o.date, kind: 'order',
      title: `${o.side} ${o.shares} ${o.ticker}`,
      detail: [o.status === 'executed' ? `at ${o.price}` : o.status, o.note].filter(Boolean).join(' · '),
      amount: o.total, currency: 'EGP',
    });
  }

  for (const d of ctx.db.select().from(t.debts).all()) {
    const lent = d.direction === 'lent';
    out.push({
      id: `debt-${d.id}`, date: d.startedOn, kind: 'debt',
      title: `${lent ? 'Lent to' : 'Borrowed from'} ${d.counterparty}`,
      detail: d.note ?? undefined, amount: d.principal, currency: d.currency,
    });
    if (d.dueOn) {
      out.push({
        id: `debt-due-${d.id}`, date: d.dueOn, kind: 'debt',
        title: `${d.counterparty} — ${lent ? 'due back' : 'due to be repaid'}`,
        detail: d.settledAt ? 'settled' : undefined,
        amount: d.principal, currency: d.currency,
      });
    }
    if (d.settledAt) {
      out.push({
        id: `debt-settled-${d.id}`, date: d.settledAt.slice(0, 10), kind: 'debt',
        title: `${d.counterparty} — settled`, amount: d.principal, currency: d.currency,
      });
    }
    if (d.writtenOffAt) {
      out.push({
        id: `debt-off-${d.id}`, date: d.writtenOffAt.slice(0, 10), kind: 'debt',
        title: `${d.counterparty} — written off`, amount: d.principal, currency: d.currency,
      });
    }
  }

  // Movements between two of your own things, and income that actually landed. Both are
  // movements in the log; what separates them is where the value came from.
  const legs = ctx.db.select().from(t.legs).all();
  for (const tx of ctx.db.select().from(t.transactions).all()) {
    if (tx.kind !== 'transfer' && tx.kind !== 'income') continue;
    const leg = legs.find((l) => l.transactionId === tx.id);
    if (!leg) continue;
    const from = leg.fromNodeId ? names.get(leg.fromNodeId) ?? leg.fromNodeId : null;
    const into = leg.toNodeId ? names.get(leg.toNodeId) ?? leg.toNodeId : null;
    out.push({
      id: `mov-${tx.id}`, date: tx.date,
      kind: tx.kind === 'income' ? 'income' : 'transfer',
      title: tx.kind === 'income'
        ? `${from ?? 'Income'} into ${into ?? 'an account'}`
        : `${from ?? '—'} → ${into ?? '—'}`,
      detail: tx.note ?? (tx.automatic ? 'posted automatically' : undefined),
      amount: leg.qtyTo ?? leg.qtyFrom ?? undefined,
      currency: undefined,
      icon: tx.kind === 'income' ? 'income' : 'flow',
    });
  }

  // A purchase or sale against an asset shows that asset's own mark.
  for (const tx of ctx.db.select().from(t.transactions).all()) {
    if (tx.kind !== 'purchase' && tx.kind !== 'sale') continue;
    const leg = legs.find((l) => l.transactionId === tx.id);
    const assetId = tx.kind === 'purchase' ? leg?.toNodeId : leg?.fromNodeId;
    if (!assetId || assetId === 'gold' || assetId === 'silver') continue; // metal has its lots
    out.push({
      id: `buy-${tx.id}`, date: tx.date, kind: 'transfer',
      title: `${tx.kind === 'purchase' ? 'Bought' : 'Sold'} ${names.get(assetId) ?? assetId}`,
      detail: tx.note ?? undefined,
      amount: leg?.qtyFrom ?? undefined,
      icon: markOf(assetId) ?? undefined,
    });
  }

  return out;
}

export const calendarCaps = (ctxOf: () => AppCtx) => [
  query({
    name: 'calendar.events',
    context: 'planning',
    summary: 'Every dated thing: installments due and paid, zakat, each asset\'s lunar year, warnings, standing charges.',
    detail: 'One list, coloured by kind, with the lunar date beside the ordinary one. The same events are served as an iCalendar feed at /calendar.ics, which a phone or a laptop can subscribe to.',
    input: z.object({
      withinDays: z.number().int().min(1).max(1200).default(400),
      backDays: z.number().int().min(0).max(1200).default(120),
      kinds: z.array(z.string()).optional(),
    }),
    output: z.object({
      events: z.array(z.object({
        id: z.string(), date: z.string(), hijri: z.string().nullable(),
        kind: z.string(), title: z.string(), detail: z.string().optional(),
        amount: z.number().optional(), currency: z.string().optional(),
        color: z.string(), daysAway: z.number(), overdue: z.boolean().optional(),
        /** the mark to draw it with: the thing's own, or its kind's */
        icon: z.string(), past: z.boolean().optional(),
        /** set when the event is one of the owner's own, so a screen can offer to edit it */
        entryId: z.string().optional(), done: z.boolean().optional(),
      })),
      /** the colour and the words each kind is drawn with, so a legend needs no second list */
      legend: z.array(z.object({
        kind: z.string(), label: z.string(), color: z.string(), icon: z.string(),
        /** how many of this kind are in the window, so a legend can say what is there */
        count: z.number(),
      })),
      feedUrl: z.string(),
    }),
    handler: async ({ withinDays, backDays, kinds }) => {
      const ctx = ctxOf();
      const all = buildCalendar(ctx, { horizonDays: withinDays, backDays });
      const events = all.filter((e) => !kinds?.length || kinds.includes(e.kind));
      // The legend counts what is actually in the window, so a kind with nothing to show says
      // so instead of offering a switch that appears to do nothing.
      const counts = all.reduce<Record<string, number>>((acc, e) => {
        acc[e.kind] = (acc[e.kind] ?? 0) + 1; return acc;
      }, {});
      return {
        events,
        legend: Object.entries(CALENDAR_COLORS).map(([kind, color]) => ({
          kind, color,
          label: CALENDAR_LABELS[kind as keyof typeof CALENDAR_LABELS],
          icon: CALENDAR_ICONS[kind as keyof typeof CALENDAR_ICONS],
          count: counts[kind] ?? 0,
        })),
        feedUrl: '/calendar.ics',
      };
    },
  }),
];

const Repeat = z.enum(['none', 'monthly', 'annually', 'lunar_annually']);

/**
 * The calendar's own entries.
 *
 * Three commands, because an entry is a small thing with a short life: it is written, it is
 * corrected, and eventually it is done with. Nothing here writes a movement — a note on a day
 * is not money changing hands, and pretending otherwise would put a line in the ledger that
 * never happened.
 */
export const calendarEntryCaps = (ctxOf: () => AppCtx) => [
  query({
    name: 'calendar.entries',
    context: 'planning',
    summary: 'The entries you put on the calendar yourself, newest day first.',
    input: z.object({ includeDone: z.boolean().default(true) }),
    output: z.array(z.object({
      id: z.string(), date: z.string(), hijri: z.string().nullable(),
      title: z.string(), note: z.string().nullable(), color: z.string().nullable(),
      repeat: z.string(), remindDays: z.number(),
      amount: z.number().nullable(), currency: z.string().nullable(),
      doneAt: z.string().nullable(),
    })),
    handler: async ({ includeDone }) => {
      const { db } = ctxOf();
      return db.select().from(t.calendarEntries).all()
        .filter((e) => includeDone || !e.doneAt)
        .sort((a, b) => b.date.localeCompare(a.date))
        .map((e) => ({ ...e, hijri: hijriTextOfIso(e.date), createdAt: undefined as never }))
        .map(({ createdAt, ...rest }) => rest);
    },
  }),

  command({
    name: 'calendar.add',
    context: 'planning',
    summary: 'Put something of your own on the calendar — a viewing, a signing, anything to remember.',
    detail: 'It repeats on its own terms if you want, including once a lunar year, which is the only repeat that keeps step with the way zakat is reckoned. A lead time puts a warning on the calendar as well as the day itself.',
    input: z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      title: z.string().min(1).max(120),
      note: z.string().max(500).optional(),
      color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
      repeat: Repeat.default('none'),
      remindDays: z.number().int().min(0).max(365).default(0),
      amount: z.number().optional(),
      currency: z.string().regex(/^[A-Z]{3}$/).optional(),
    }),
    output: z.object({ id: z.string(), summary: z.string() }),
    handler: async (input) => {
      const ctx = ctxOf();
      const id = newId('cal');
      ctx.db.insert(t.calendarEntries).values({
        id, date: input.date, title: input.title, note: input.note ?? null,
        color: input.color ?? null, repeat: input.repeat, remindDays: input.remindDays,
        amount: input.amount ?? null, currency: input.currency ?? null,
        doneAt: null, createdAt: ctx.now.toISOString(),
      }).run();
      return {
        id,
        summary: `${input.title} on ${input.date}${hijriTextOfIso(input.date) ? ` — ${hijriTextOfIso(input.date)} AH` : ''}`,
      };
    },
  }),

  command({
    name: 'calendar.update',
    context: 'planning',
    summary: 'Change one of your own calendar entries, or mark it done.',
    input: z.object({
      entryId: z.string(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      title: z.string().min(1).max(120).optional(),
      note: z.string().max(500).nullable().optional(),
      color: z.string().regex(/^#[0-9a-f]{6}$/i).nullable().optional(),
      repeat: Repeat.optional(),
      remindDays: z.number().int().min(0).max(365).optional(),
      amount: z.number().nullable().optional(),
      currency: z.string().regex(/^[A-Z]{3}$/).nullable().optional(),
      done: z.boolean().optional(),
    }),
    output: Outcome,
    handler: async ({ entryId, done, ...patch }) => {
      const ctx = ctxOf();
      const row = ctx.db.select().from(t.calendarEntries)
        .where(eq(t.calendarEntries.id, entryId)).get();
      if (!row) return refusal('not_found', 'There is no calendar entry with that id.');
      const clean: Record<string, unknown> = Object.fromEntries(
        Object.entries(patch).filter(([, v]) => v !== undefined));
      if (done !== undefined) clean.doneAt = done ? ctx.now.toISOString() : null;
      if (Object.keys(clean).length) {
        ctx.db.update(t.calendarEntries).set(clean).where(eq(t.calendarEntries.id, entryId)).run();
      }
      return noted(done === true ? `${patch.title ?? row.title} marked done`
        : `${patch.title ?? row.title} updated`);
    },
  }),

  command({
    name: 'calendar.remove',
    context: 'planning',
    summary: 'Take one of your own entries off the calendar.',
    detail: 'Only entries you put there. A payment or a lunar year is on the calendar because something in the ledger says so, and the way to move one of those is to change the thing that says it.',
    input: z.object({ entryId: z.string() }),
    output: Outcome,
    effect: 'irreversible' as const,
    handler: async ({ entryId }) => {
      const ctx = ctxOf();
      const row = ctx.db.select().from(t.calendarEntries)
        .where(eq(t.calendarEntries.id, entryId)).get();
      if (!row) return refusal('not_found', 'There is no calendar entry with that id.');
      ctx.db.delete(t.calendarEntries).where(eq(t.calendarEntries.id, entryId)).run();
      return noted(`${row.title} taken off the calendar`);
    },
  }),
];

export { toIcs };
