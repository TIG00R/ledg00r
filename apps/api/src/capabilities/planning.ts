import { z } from 'zod';
import { command, query, DateOnly, NodeId, SourceId, TemplateId, Outcome } from '@ledger/contracts';
import { schema as t } from '@ledger/db';
import { eq } from 'drizzle-orm';
import { upcoming, nextOccurrence, type Reminder, type RecurringTemplate,
         type Dismissal, type ZakatSettings } from '@ledger/engine';
import type { AppCtx } from '../context.js';
import { post, noted, refusal, today, newId, undoMovement, atomically, DryRun } from './shared.js';
import { nextSeq, rateFor } from './spending.js';
import { buildDataset, readMarket, readPref } from '../read.js';

/**
 * Everything forward-looking.
 *
 * Sources of income, standing charges, the reminders that decide which of them is worth
 * surfacing, and the events that come out of all three. A reminder never creates an event —
 * it decides whether an event that already exists is close enough to warrant saying so, so
 * turning one off hides the warning and never the payment.
 */
export const planningCaps = (ctxOf: () => AppCtx) => [
  query({
    name: 'upcoming.list',
    context: 'planning',
    summary: 'What is coming: installments, standing charges, income due, zakat, price alerts.',
    detail: 'Soonest first. An item marked due has passed its reminder\'s lead time; one marked overdue has already happened and is waiting on you.',
    input: z.object({ withinDays: z.number().int().min(1).max(730).default(120) }),
    output: z.array(z.object({
      id: z.string(), kind: z.string(), label: z.string(), detail: z.string().optional(),
      date: z.string(), daysAway: z.number(), amount: z.number().optional(),
      currency: z.string().optional(), due: z.boolean(), overdue: z.boolean().optional(),
    })),
    handler: async ({ withinDays }) => {
      const ctx = ctxOf();
      const { data } = buildDataset(ctx.db, ctx.now);
      return upcoming(data, readMarket(ctx.db), readReminders(ctx), ctx.now, {
        horizonDays: withinDays,
        recurring: readTemplates(ctx),
        zakat: readPref<ZakatSettings>(ctx.db, 'zakat'),
        dismissals: ctx.db.select().from(t.dismissals).all()
          .map((d) => ({ eventId: d.eventId, until: d.until ?? undefined, on: d.on })) as Dismissal[],
      }).map((e) => ({
        id: e.id, kind: e.kind, label: e.label, detail: e.detail,
        date: e.date.toISOString().slice(0, 10), daysAway: e.daysAway,
        amount: e.amount, currency: e.currency, due: e.due, overdue: e.overdue,
      }));
    },
  }),

  command({
    name: 'income.record',
    context: 'planning',
    summary: 'Record irregular income that has arrived, into a named account.',
    detail: 'Scheduled income accrues on its own and needs nothing from you. Anything irregular counts only once recorded, which is what stops it flattering the forecast.',
    input: z.object({
      sourceId: SourceId.optional(),
      sourceName: z.string().max(80).optional(),
      accountId: NodeId,
      amount: z.number().positive(),
      currency: z.string().regex(/^[A-Z]{3}$/).optional(),
      date: DateOnly.optional(),
      note: z.string().max(500).optional(),
    }).merge(DryRun),
    output: Outcome,
    handler: async (input) => {
      const ctx = ctxOf();
      const acct = ctx.ledger().node(input.accountId);
      if (!acct) return refusal('unknown_node', `${input.accountId} is not an account in this ledger.`);

      const source = input.sourceId
        ? ctx.db.select().from(t.incomeSources).where(eq(t.incomeSources.id, input.sourceId)).get()
        : undefined;
      if (input.sourceId && !source) return refusal('not_found', `${input.sourceId} is not an income source.`);
      const label = source?.name ?? input.sourceName ?? 'Income';
      const currency = input.currency ?? source?.currency ?? acct.currency ?? 'EGP';
      /**
       * The node the money came from, made if it is missing.
       *
       * A payment that names its source and then arrives from nowhere cannot be attributed
       * afterwards, and rent has to be attributable — it is what zakat on a let thing is owed
       * on. Sources created before external nodes were written for them are repaired here, on
       * the first payment recorded against them, rather than left unattributable for good.
       */
      let external = source
        ? ctx.db.select().from(t.nodes).where(eq(t.nodes.id, `ext-${source.id.replace(/^src-/, '')}`)).get()
        : undefined;
      if (source && !external) {
        const extId = `ext-${source.id.replace(/^src-/, '')}`;
        ctx.db.insert(t.nodes).values({
          id: extId, kind: 'external', name: source.name, currency: source.currency,
          valuation: 'face', openingQty: 0, archived: false,
        }).onConflictDoNothing().run();
        external = ctx.db.select().from(t.nodes).where(eq(t.nodes.id, extId)).get();
      }

      return post(ctx, {
        date: input.date ?? today(ctx), kind: 'income', note: input.note,
        legs: [{ fromNodeId: external?.id, toNodeId: input.accountId, qtyFrom: input.amount }],
      }, `${input.amount} ${currency} from ${label} into ${acct.name}`,
      {
        dryRun: input.dryRun,
        index: [{ kind: 'income', title: label, body: input.note ?? '' }],
      });
    },
  }),

  command({
    name: 'income.correct',
    context: 'planning',
    summary: 'Correct income already recorded — the amount, the account it landed in, the date, the note.',
    detail: 'The movement behind it is reversed and written again, so the balances follow and the log keeps both. What it cannot change is that the money arrived.',
    input: z.object({
      movementId: z.string(),
      accountId: NodeId.optional(),
      sourceId: SourceId.optional(),
      amount: z.number().positive().optional(),
      date: DateOnly.optional(),
      note: z.string().max(500).optional(),
    }),
    output: Outcome,
    handler: async (input) => {
      const ctx = ctxOf();
      const tx = ctx.db.select().from(t.transactions).where(eq(t.transactions.id, input.movementId)).get();
      if (!tx || tx.kind !== 'income') return refusal('not_found', 'There is no recorded income with that id.');
      const leg = ctx.db.select().from(t.legs).where(eq(t.legs.transactionId, input.movementId)).all()[0];

      const into = input.accountId ?? leg?.toNodeId ?? null;
      if (!into) return refusal('unknown_node', 'That record names no account the money landed in.');
      const acct = ctx.ledger().node(into);
      if (!acct) return refusal('unknown_node', `${into} is not an account in this ledger.`);

      const amount = input.amount ?? leg?.qtyTo ?? leg?.qtyFrom ?? 0;
      if (!(amount > 0)) return refusal('invalid_period', 'An amount is needed.');
      const date = input.date ?? tx.date;
      const note = input.note ?? tx.note ?? undefined;

      // Which source it came from is an external node, the same one income.record used.
      const source = input.sourceId
        ? ctx.db.select().from(t.nodes).where(eq(t.nodes.id, `ext-${input.sourceId.replace(/^src-/, '')}`)).get()
        : (leg?.fromNodeId
            ? ctx.db.select().from(t.nodes).where(eq(t.nodes.id, leg.fromNodeId)).get()
            : undefined);

      return atomically(ctx, () => {
        undoMovement(ctx, input.movementId);
        return post(ctx, {
          date, kind: 'income', note,
          legs: [{ fromNodeId: source?.id, toNodeId: into, qtyFrom: amount }],
        }, `corrected to ${amount} into ${acct.name}`);
      });
    },
  }),

  command({
    name: 'income.source.add',
    context: 'planning',
    summary: 'Add a source of income — scheduled, or the kind that simply turns up.',
    detail: 'Scheduled sources feed the forecast month by month. Unscheduled ones never do; they count from the day they land and not before.',
    input: z.object({
      name: z.string().min(1).max(80),
      amount: z.number().positive().nullable().default(null),
      currency: z.string().regex(/^[A-Z]{3}$/),
      cadence: z.enum(['weekly', 'monthly', 'quarterly', 'annually', 'one_off', 'irregular']),
      dayOfMonth: z.union([z.number().int().min(1).max(31), z.literal('last')]).optional(),
      toAccountId: NodeId,
      startDate: DateOnly.optional(), endDate: DateOnly.optional(),
      icon: z.string().max(32).optional(), color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
      /**
       * The asset this income comes out of, when it is rent.
       *
       * Zakat on a let flat is owed on what the flat earns, not on the flat — so the earnings
       * have to be attributable to it. Naming the asset here is what makes each payment
       * countable against that asset's own lunar year.
       */
      assetId: NodeId.optional(),
    }),
    output: z.object({ id: z.string(), summary: z.string() }),
    handler: async (input) => {
      const { db } = ctxOf();
      const id = newId('src');
      const scheduled = input.cadence !== 'irregular' && input.cadence !== 'one_off';
      /**
       * Where the money comes from, as a node.
       *
       * Income is a movement, and a movement comes from somewhere. Seeded sources have had an
       * external node each since the beginning; one added here had none, so its payments came
       * from nowhere — which left them unattributable, and rent in particular indistinguishable
       * from a wage once it had landed in the account.
       */
      db.insert(t.nodes).values({
        id: `ext-${id.replace(/^src-/, '')}`, kind: 'external', name: input.name,
        currency: input.currency, valuation: 'face', openingQty: 0, archived: false,
      }).onConflictDoNothing().run();

      db.insert(t.incomeSources).values({
        id, name: input.name, amount: input.amount, currency: input.currency,
        cadence: input.cadence, dayOfMonth: input.dayOfMonth == null ? null : String(input.dayOfMonth),
        startDate: input.startDate ?? null, endDate: input.endDate ?? null,
        toNodeId: input.toAccountId, scheduled, icon: input.icon ?? null,
        color: input.color ?? null, assetId: input.assetId ?? null, archived: false,
      }).run();
      return { id, summary: `${input.name} added, ${scheduled ? 'feeding the forecast' : 'recorded when it lands'}` };
    },
  }),

  query({
    name: 'income.list',
    context: 'planning',
    summary: 'Income that has actually landed, newest first.',
    detail: 'Movements of kind income, with the source they came from and the account they reached. Scheduled income that has merely accrued is not here — only what was recorded.',
    input: z.object({ limit: z.number().int().min(1).max(500).default(100) }),
    output: z.array(z.object({
      id: z.string(), date: z.string(), source: z.string(),
      amount: z.number(), currency: z.string(), intoId: z.string().nullable(),
      into: z.string(), note: z.string().nullable(),
    })),
    handler: async ({ limit }) => {
      const ctx = ctxOf();
      const names = new Map(ctx.db.select().from(t.nodes).all().map((n) => [n.id, n.name]));
      const insts = new Map(ctx.db.select().from(t.institutions).all().map((i) => [i.id, i.name]));
      const parents = new Map(ctx.db.select().from(t.nodes).all().map((n) => [n.id, n.parentId]));
      const legs = ctx.db.select().from(t.legs).all();

      return ctx.db.select().from(t.transactions).all()
        .filter((tx) => tx.kind === 'income')
        .sort((a, b) => (a.date === b.date ? b.seq - a.seq : b.date.localeCompare(a.date)))
        .slice(0, limit)
        .map((tx) => {
          const leg = legs.find((l) => l.transactionId === tx.id);
          const to = leg?.toNodeId ?? null;
          const bank = to ? insts.get(parents.get(to) ?? '') : undefined;
          const fromNode = leg?.fromNodeId;
          return {
            id: tx.id, date: tx.date,
            source: fromNode ? names.get(fromNode) ?? fromNode : (tx.note ?? 'Income'),
            amount: leg?.qtyTo ?? leg?.qtyFrom ?? 0,
            currency: (to ? ctx.db.select().from(t.nodes).where(eq(t.nodes.id, to)).get()?.currency : null) ?? 'EGP',
            intoId: to,
            into: to ? `${bank ? `${bank} · ` : ''}${names.get(to) ?? to}` : '—',
            note: tx.note ?? null,
          };
        });
    },
  }),

  command({
    name: 'income.source.update',
    context: 'planning',
    summary: 'Rename a source of income, change what it pays, its mark, or where it lands.',
    detail: 'Changing a source does not touch what it has already paid — those are movements, and they stay as recorded.',
    input: z.object({
      sourceId: SourceId,
      name: z.string().min(1).max(80).optional(),
      amount: z.number().positive().nullable().optional(),
      currency: z.string().regex(/^[A-Z]{3}$/).optional(),
      cadence: z.enum(['weekly', 'monthly', 'quarterly', 'annually', 'one_off', 'irregular']).optional(),
      dayOfMonth: z.union([z.number().int().min(1).max(31), z.literal('last')]).optional(),
      toAccountId: NodeId.optional(),
      startDate: DateOnly.optional(), endDate: DateOnly.nullable().optional(),
      icon: z.string().max(80).optional(),
      color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
      /** the asset this income comes out of, when it is rent; null unlinks it */
      assetId: NodeId.nullable().optional(),
      archived: z.boolean().optional(),
    }),
    output: Outcome,
    handler: async ({ sourceId, toAccountId, dayOfMonth, ...patch }) => {
      const { db } = ctxOf();
      const row = db.select().from(t.incomeSources).where(eq(t.incomeSources.id, sourceId)).get();
      if (!row) return refusal('not_found', `${sourceId} is not an income source.`);

      const clean: Record<string, unknown> = Object.fromEntries(
        Object.entries(patch).filter(([, v]) => v !== undefined));
      if (toAccountId) clean.toNodeId = toAccountId;
      if (dayOfMonth != null) clean.dayOfMonth = String(dayOfMonth);
      // whether it feeds the forecast follows from its cadence, so it is never set by hand
      if (patch.cadence) clean.scheduled = patch.cadence !== 'irregular' && patch.cadence !== 'one_off';
      if (Object.keys(clean).length) {
        db.update(t.incomeSources).set(clean).where(eq(t.incomeSources.id, sourceId)).run();
      }
      return noted(`${patch.name ?? row.name} updated`);
    },
  }),

  command({
    name: 'income.source.retire',
    context: 'planning',
    summary: 'Retire a source of income. It leaves the pickers and the forecast; what it paid stays recorded.',
    detail: 'Retiring rather than deleting, because payments already recorded name it and would otherwise point at nothing.',
    input: z.object({ sourceId: SourceId, restore: z.boolean().default(false) }),
    output: Outcome,
    handler: async ({ sourceId, restore }) => {
      const { db } = ctxOf();
      const row = db.select().from(t.incomeSources).where(eq(t.incomeSources.id, sourceId)).get();
      if (!row) return refusal('not_found', `${sourceId} is not an income source.`);
      db.update(t.incomeSources).set({ archived: !restore }).where(eq(t.incomeSources.id, sourceId)).run();
      return noted(`${row.name} ${restore ? 'restored' : 'retired'}`);
    },
  }),

  command({
    name: 'recurring.add',
    context: 'planning',
    summary: 'Add a movement that repeats — a fee, a subscription, a sweep into savings.',
    detail: 'One shape covers both directions. No source means it arrives from outside your accounts; no destination means it leaves them; both means it is a transfer between your own.',
    input: z.object({
      name: z.string().min(1).max(80),
      fromAccountId: NodeId.optional(), toAccountId: NodeId.optional(),
      amount: z.number().positive().nullable().default(null),
      currency: z.string().regex(/^[A-Z]{3}$/),
      cadence: z.enum(['weekly', 'monthly', 'quarterly', 'annually']),
      dayOfMonth: z.union([z.number().int().min(1).max(31), z.literal('last')]).default(1),
      categoryId: z.string().optional(), note: z.string().max(300).optional(),
      internal: z.boolean().default(false),
    }),
    output: z.union([z.object({ id: z.string(), summary: z.string() }), Outcome]),
    handler: async (input) => {
      const { db } = ctxOf();
      if (!input.fromAccountId && !input.toAccountId) {
        return refusal('unbalanced', 'A template with neither a source nor a destination moves nothing.',
                       'Give it an account on at least one side.');
      }
      const id = newId('rec');
      db.insert(t.recurringTemplates).values({
        id, name: input.name, fromNodeId: input.fromAccountId ?? null,
        toNodeId: input.toAccountId ?? null, amount: input.amount, currency: input.currency,
        cadence: input.cadence, dayOfMonth: String(input.dayOfMonth),
        categoryId: input.categoryId ?? null, enabled: true,
        internal: input.internal, note: input.note ?? null,
      }).run();
      return { id, summary: `${input.name} added, ${input.cadence}` };
    },
  }),

  command({
    name: 'recurring.update',
    context: 'planning',
    summary: 'Change a standing charge, or switch it off without losing what it has already posted.',
    input: z.object({
      templateId: TemplateId,
      amount: z.number().positive().nullable().optional(),
      cadence: z.enum(['weekly', 'monthly', 'quarterly', 'annually']).optional(),
      dayOfMonth: z.union([z.number().int().min(1).max(31), z.literal('last')]).optional(),
      enabled: z.boolean().optional(),
    }),
    output: Outcome,
    handler: async ({ templateId, ...patch }) => {
      const { db } = ctxOf();
      const row = db.select().from(t.recurringTemplates).where(eq(t.recurringTemplates.id, templateId)).get();
      if (!row) return refusal('not_found', `${templateId} is not a template.`);
      const clean: any = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      if (clean.dayOfMonth != null) clean.dayOfMonth = String(clean.dayOfMonth);
      if (Object.keys(clean).length) {
        db.update(t.recurringTemplates).set(clean).where(eq(t.recurringTemplates.id, templateId)).run();
      }
      return noted(`${row.name} updated`);
    },
  }),

  query({
    name: 'reminders.list',
    context: 'planning',
    summary: 'Every reminder this ledger holds, and what each one watches.',
    detail: 'A reminder decides how far ahead something is surfaced. It never creates or moves the thing it watches, so removing one hides a warning and never an obligation.',
    input: z.object({}),
    output: z.array(z.object({
      id: z.string(), subject: z.string(), subjectId: z.string().nullable(),
      enabled: z.boolean(), offsetValue: z.number(), offsetUnit: z.string(),
      direction: z.string().nullable(), triggerPrice: z.number().nullable(),
      note: z.string().nullable(), dueDate: z.string().nullable(),
      graceDays: z.number().nullable(), cadence: z.string().nullable(),
    })),
    handler: async () => {
      const { db } = ctxOf();
      return db.select().from(t.reminders).all().map((r) => ({
        id: r.id, subject: r.subject, subjectId: r.subjectId ?? null,
        enabled: r.enabled, offsetValue: r.offsetValue, offsetUnit: r.offsetUnit,
        direction: r.direction ?? null, triggerPrice: r.triggerPrice ?? null,
        note: r.note ?? null, dueDate: r.dueDate ?? null,
        graceDays: r.graceDays ?? null, cadence: r.cadence ?? null,
      }));
    },
  }),

  command({
    name: 'reminder.set',
    context: 'planning',
    summary: 'Decide how far ahead something warns you, or stop it warning you at all.',
    detail: 'A reminder only decides whether an event is surfaced. Switching one off never removes the payment behind it.',
    input: z.object({
      subject: z.enum(['installment', 'zakat', 'sadaqah', 'stock', 'income', 'recurring']),
      subjectId: z.string().optional(),
      enabled: z.boolean().default(true),
      offsetValue: z.number().int().min(0).max(365).optional(),
      offsetUnit: z.enum(['days', 'months']).optional(),
      direction: z.enum(['buy', 'sell']).optional(),
      /** the price you have in mind, when you have one — nothing watches for it */
      triggerPrice: z.number().positive().optional(),
      /** why, so the intention still makes sense when it surfaces */
      note: z.string().max(500).optional(),
      dueDate: DateOnly.optional(),
      graceDays: z.number().int().min(0).max(60).optional(),
      /** set to add another rather than replace the one already there */
      asNew: z.boolean().default(false),
      /**
       * Which one to change, when it is one in particular.
       *
       * Without it a reminder is found by what it watches, which is right for the ledger's
       * single zakat date and wrong for a holding: two intentions about the same share are
       * two reminders, and editing one by subject alone would silently rewrite the other.
       */
      reminderId: z.string().optional(),
    }),
    output: Outcome,
    handler: async (input) => {
      const { db } = ctxOf();
      // A ledger has one zakat date and one salary, so those replace. Intentions about a
      // holding accumulate: buying twice for two different reasons is two notes, not one.
      const existing = input.reminderId
        ? db.select().from(t.reminders).where(eq(t.reminders.id, input.reminderId)).get()
        : input.asNew ? undefined : db.select().from(t.reminders).all()
          .find((r) => r.subject === input.subject && (r.subjectId ?? null) === (input.subjectId ?? null));
      if (input.reminderId && !existing) {
        return refusal('not_found', 'There is no reminder with that id.');
      }
      const values = {
        subject: input.subject, subjectId: input.subjectId ?? null, enabled: input.enabled,
        offsetValue: input.offsetValue ?? existing?.offsetValue ?? 3,
        offsetUnit: input.offsetUnit ?? existing?.offsetUnit ?? 'days',
        direction: input.direction ?? existing?.direction ?? null,
        triggerPrice: input.triggerPrice ?? existing?.triggerPrice ?? null,
        graceDays: input.graceDays ?? existing?.graceDays ?? null,
        note: input.note ?? existing?.note ?? null,
        dueDate: input.dueDate ?? existing?.dueDate ?? null,
      };
      if (existing) db.update(t.reminders).set(values).where(eq(t.reminders.id, existing.id)).run();
      else db.insert(t.reminders).values({ id: newId('rem'), ...values, cadence: null }).run();
      return noted(`${input.subject}${input.subjectId ? ` · ${input.subjectId}` : ''} ${input.enabled ? `warns ${values.offsetValue} ${values.offsetUnit} before` : 'no longer warns'}`);
    },
  }),

  command({
    name: 'reminder.remove',
    context: 'planning',
    summary: 'Delete a reminder outright.',
    effect: 'irreversible',
    input: z.object({ reminderId: z.string() }),
    output: Outcome,
    handler: async ({ reminderId }) => {
      const { db } = ctxOf();
      const row = db.select().from(t.reminders).where(eq(t.reminders.id, reminderId)).get();
      if (!row) return refusal('not_found', 'There is no reminder with that id.');
      db.delete(t.reminders).where(eq(t.reminders.id, reminderId)).run();
      return noted('Reminder removed');
    },
  }),

  command({
    name: 'upcoming.dismiss',
    context: 'planning',
    summary: 'Silence one upcoming item, either until a date or for good.',
    detail: 'A price alert has no date to expire on — once a share is above its trigger it stays above it — so without this it would sit there forever.',
    input: z.object({ eventId: z.string(), until: DateOnly.optional(), undo: z.boolean().default(false) }),
    output: Outcome,
    handler: async ({ eventId, until, undo }) => {
      const ctx = ctxOf();
      if (undo) {
        ctx.db.delete(t.dismissals).where(eq(t.dismissals.eventId, eventId)).run();
        return noted(`${eventId} will be shown again`);
      }
      ctx.db.insert(t.dismissals)
        .values({ eventId, until: until ?? null, on: today(ctx) })
        .onConflictDoUpdate({ target: t.dismissals.eventId, set: { until: until ?? null, on: today(ctx) } })
        .run();
      return noted(until ? `${eventId} hidden until ${until}` : `${eventId} hidden`);
    },
  }),
];

export function readReminders(ctx: AppCtx): Reminder[] {
  return ctx.db.select().from(t.reminders).all().map((r) => ({
    id: r.id, subject: r.subject as Reminder['subject'], subjectId: r.subjectId ?? undefined,
    enabled: r.enabled, offsetValue: r.offsetValue, offsetUnit: r.offsetUnit,
    note: r.note ?? undefined, direction: r.direction ?? undefined,
    triggerPrice: r.triggerPrice ?? undefined,
    cadence: (r.cadence as Reminder['cadence']) ?? undefined,
    graceDays: r.graceDays ?? undefined,
  }));
}

export function readTemplates(ctx: AppCtx): RecurringTemplate[] {
  return ctx.db.select().from(t.recurringTemplates).all().map((r) => ({
    id: r.id, name: r.name, fromNodeId: r.fromNodeId ?? undefined, toNodeId: r.toNodeId ?? undefined,
    amount: r.amount, currency: r.currency, cadence: r.cadence as RecurringTemplate['cadence'],
    dayOfMonth: r.dayOfMonth === 'last' ? 'last' : r.dayOfMonth ? Number(r.dayOfMonth) : undefined,
    startDate: r.startDate ?? undefined, endDate: r.endDate ?? undefined,
    categoryId: r.categoryId ?? undefined, enabled: r.enabled, note: r.note ?? undefined,
    internal: r.internal,
  }));
}

export { nextOccurrence };
