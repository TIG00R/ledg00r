import type { DataSet, MarketState } from './types.js';
import { installmentDueDate, daysUntil } from './dates.js';
import { nextInstallment } from './accrual.js';
import { nextOccurrence, isRunning, type RecurringTemplate } from './recurring.js';
import { zakatDates, type ZakatSettings } from './zakat.js';

export type ReminderSubject = 'installment' | 'zakat' | 'sadaqah' | 'stock' | 'income' | 'recurring' | 'budget';

export interface Reminder {
  id: string;
  subject: ReminderSubject;
  /** property id, ticker, source id — or undefined for the singletons */
  subjectId?: string;
  enabled: boolean;
  offsetValue: number;
  offsetUnit: 'days' | 'months';
  note?: string;
  /**
   * Stock reminders only.
   *
   * Not a price alert. This ledger does not watch a market — it is a notebook, and what a
   * notebook is for is remembering the intention: that you meant to buy this, or sell that,
   * and why. The note is the part worth reading back.
   */
  direction?: 'buy' | 'sell';
  triggerPrice?: number;
  /** the date you want to be reminded, when the intention has one */
  dueDate?: string;
  /** how often a standing reminder repeats; undefined follows the thing it watches */
  cadence?: 'weekly' | 'monthly' | 'quarterly' | 'annually';
  /** grace period for income: how late a payment may be before it is flagged */
  graceDays?: number;
}

export interface UpcomingEvent {
  id: string;
  date: Date;
  daysAway: number;
  kind: ReminderSubject;
  label: string;
  detail?: string;
  amount?: number;
  currency?: string;
  /** true once the reminder's lead time has been reached */
  due: boolean;
  reminderLead?: string;
  /** an event that has already happened and is waiting on you, rather than one ahead */
  overdue?: boolean;
  /** value moving between things you own — it leaves an account without being spent */
  internal?: boolean;
}

/**
 * Events the owner has already seen and told to be quiet.
 *
 * A price alert has no date to expire on — once ACME is above 92 it stays above 92, and
 * without this it would sit in the panel forever. Dismissing is per event id, and a
 * dismissal for a dated event is only honoured while that event keeps its date.
 */
export interface Dismissal { eventId: string; until?: string; on: string }

function dismissed(id: string, list: Dismissal[], now: Date): boolean {
  const d = list.find((x) => x.eventId === id);
  if (!d) return false;
  if (!d.until) return true;
  return new Date(`${d.until}T23:59:59`) >= now;
}

function leadInDays(r: Reminder): number {
  return r.offsetUnit === 'months' ? r.offsetValue * 30 : r.offsetValue;
}

export function describeLead(r: Reminder): string {
  const n = r.offsetValue;
  const unit = r.offsetUnit === 'months' ? (n === 1 ? 'month' : 'months') : (n === 1 ? 'day' : 'days');
  return `${n} ${unit} before`;
}

/**
 * What is coming up, soonest first. Reminders do not create events — they decide which
 * events are close enough to surface, so turning one off hides the warning, never the payment.
 */
export function upcoming(
  d: DataSet, m: MarketState, reminders: Reminder[], now: Date,
  opts: {
    horizonDays?: number;
    recurring?: RecurringTemplate[];
    zakat?: ZakatSettings;
    dismissals?: Dismissal[];
  } = {},
): UpcomingEvent[] {
  const horizonDays = opts.horizonDays ?? 120;
  const dismissals = opts.dismissals ?? [];
  const out: UpcomingEvent[] = [];

  for (const inst of d.installments) {
    const due = installmentDueDate(inst.monthLabel, inst.dueDayKind, inst.dueDayNum);
    if (!due || due < now) continue;
    const away = daysUntil(due, now);
    if (away > horizonDays) continue;
    const property = d.nodes.find((n) => n.id === inst.propertyId);
    const r = reminders.find((x) => x.subject === 'installment' && x.subjectId === inst.propertyId && x.enabled);
    out.push({
      id: `inst-${inst.id}`, date: due, daysAway: away, kind: 'installment',
      label: property?.name ?? 'Installment',
      detail: inst.note || (r ? describeLead(r) : undefined),
      amount: inst.amountEgp, currency: 'EGP',
      due: r ? away <= leadInDays(r) : false,
      reminderLead: r ? describeLead(r) : undefined,
    });
  }

  const zakat = reminders.find((r) => r.subject === 'zakat' && r.enabled);
  if (zakat && opts.zakat) {
    // The anniversary is a setting; the date it lands on this year is arithmetic.
    const z = zakatDates(now, opts.zakat);
    out.push({
      id: 'zakat', date: z.due, daysAway: z.daysAway, kind: 'zakat',
      label: 'Zakat falls due',
      detail: `${z.dueHijri.day} ${['Muharram', 'Safar', 'Rabiʿ al-Awwal', 'Rabiʿ al-Thani', 'Jumada al-Ula', 'Jumada al-Akhira', 'Rajab', 'Shaʿban', 'Ramadan', 'Shawwal', 'Dhul-Qaʿda', 'Dhul-Hijja'][z.dueHijri.month - 1]} ${z.dueHijri.year}`,
      due: z.daysAway <= leadInDays(zakat), reminderLead: describeLead(zakat),
    });
  }

  const sadaqah = reminders.find((r) => r.subject === 'sadaqah' && r.enabled);
  if (sadaqah) {
    const cadence = sadaqah.cadence ?? 'monthly';
    const step = cadence === 'weekly' ? 0 : cadence === 'quarterly' ? 3 : cadence === 'annually' ? 12 : 1;
    const next = step === 0
      ? new Date(now.getFullYear(), now.getMonth(), now.getDate() + (7 - ((now.getDay() + 6) % 7)), 12, 0, 0)
      : new Date(now.getFullYear(), now.getMonth() + step, 1, 12, 0, 0);
    const away = daysUntil(next, now);
    out.push({
      id: 'sadaqah', date: next, daysAway: away, kind: 'sadaqah',
      label: cadence === 'weekly' ? 'Weekly giving'
           : cadence === 'quarterly' ? 'Quarterly giving'
           : cadence === 'annually' ? 'Annual giving' : 'Monthly giving',
      detail: 'recurring sadaqah',
      due: away <= leadInDays(sadaqah), reminderLead: describeLead(sadaqah),
    });
  }

  // A standing intention about a holding: buy this, sell that, and the reason. It surfaces
  // on the date it was given, or straight away when it was given none.
  for (const r of reminders) {
    if (r.subject !== 'stock' || !r.enabled || !r.subjectId) continue;
    if (dismissed(`stk-${r.id}`, dismissals, now)) continue;

    const when = r.dueDate ? new Date(`${r.dueDate}T12:00:00`) : now;
    const away = daysUntil(when, now);
    if (away > horizonDays) continue;

    const price = m.prices[r.subjectId];
    out.push({
      id: `stk-${r.id}`, date: when, daysAway: away, kind: 'stock',
      label: `${r.direction === 'sell' ? 'Sell' : 'Buy'} ${r.subjectId}`,
      detail: [r.note, r.triggerPrice ? `around ${r.triggerPrice}` : null,
               price != null ? `last recorded ${price}` : 'no price recorded']
        .filter(Boolean).join(' · '),
      due: away <= leadInDays(r),
      overdue: away < 0,
    });
  }

  // Scheduled income that should have landed. A salary is the one thing whose absence is
  // worth as much attention as its arrival, and nothing else in the app would notice.
  for (const r of reminders) {
    if (r.subject !== 'income' || !r.enabled || !r.subjectId) continue;
    const src = d.incomeSources.find((s2) => s2.id === r.subjectId);
    if (!src || !src.scheduled) continue;
    const day = src.dayOfMonth === 'last'
      ? new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
      : (src.dayOfMonth ?? 1);
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), day, 12, 0, 0);
    const grace = r.graceDays ?? 2;
    // a payment counts as landed when an income movement reached the account it lands in,
    // on or after the day it was due
    const landed = d.transactions.some((t) => t.kind === 'income'
      && t.date >= isoOf(thisMonth)
      && t.legs.some((l) => l.toNodeId === src.toNodeId));
    const late = daysUntil(thisMonth, now) < -grace;
    if (late && !landed) {
      if (dismissed(`inc-${src.id}`, dismissals, now)) continue;
      out.push({
        id: `inc-${src.id}`, date: thisMonth, daysAway: daysUntil(thisMonth, now), kind: 'income',
        label: `${src.name} has not landed`,
        detail: `expected ${day === 1 ? '1st' : `${day}`} · ${-daysUntil(thisMonth, now)} days ago`,
        amount: src.amount ?? undefined, currency: src.currency,
        due: true, overdue: true, reminderLead: describeLead(r),
      });
    } else if (!late) {
      const away = daysUntil(thisMonth, now) >= 0
        ? daysUntil(thisMonth, now)
        : daysUntil(new Date(now.getFullYear(), now.getMonth() + 1, day, 12, 0, 0), now);
      const when = daysUntil(thisMonth, now) >= 0
        ? thisMonth : new Date(now.getFullYear(), now.getMonth() + 1, day, 12, 0, 0);
      if (away <= horizonDays) {
        out.push({
          id: `inc-${src.id}`, date: when, daysAway: away, kind: 'income',
          label: src.name, detail: 'scheduled income',
          amount: src.amount ?? undefined, currency: src.currency,
          due: away <= leadInDays(r), reminderLead: describeLead(r),
        });
      }
    }
  }

  // Standing charges. A card fee or a subscription is small, dated and easy to miss, which
  // is exactly the profile of the thing a ledger should be surfacing.
  for (const t of opts.recurring ?? []) {
    if (!isRunning(t, now)) continue;
    const when = nextOccurrence(t, now);
    if (!when) continue;
    const away = daysUntil(when, now);
    if (away > horizonDays) continue;
    if (dismissed(`rec-${t.id}`, dismissals, now)) continue;
    const r = reminders.find((x) => x.subject === 'recurring' && x.subjectId === t.id && x.enabled);
    out.push({
      id: `rec-${t.id}`, date: when, daysAway: away, kind: 'recurring',
      label: t.name,
      detail: t.internal ? 'moves between your accounts' : (t.note ?? 'standing charge'),
      amount: t.amount ?? undefined, currency: t.currency, internal: t.internal,
      due: r ? away <= leadInDays(r) : away <= 3,
      reminderLead: r ? describeLead(r) : undefined,
    });
  }

  return out.sort((a, b) => a.date.getTime() - b.date.getTime());
}

function isoOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export { nextInstallment };
