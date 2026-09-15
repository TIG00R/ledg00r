/**
 * The ledger's calendar.
 *
 * Everything this app knows the date of, in one list: installments due and installments
 * paid, the day the hawl closes, the warnings that run ahead of them, standing charges,
 * income expected. It is assembled here rather than on a screen because two things need it —
 * the calendar view and the feed a phone or a laptop subscribes to — and two assemblies of
 * the same events would drift apart.
 *
 * Each event carries the lunar date beside the ordinary one, because half of what is on this
 * calendar is reckoned in the lunar year and the other half is not.
 */

import type { DataSet, MarketState } from './types.js';
import { installmentDueDate, daysUntil } from './dates.js';
import { upcoming, describeLead, type Reminder } from './reminders.js';
import type { RecurringTemplate } from './recurring.js';
import { zakatDates, type ZakatSettings } from './zakat.js';
import { hijriTextOfIso, toHijri, fromHijri, addHijriYears } from './hijri.js';

export type CalendarKind =
  | 'installment' | 'paid' | 'zakat' | 'reminder'
  | 'sadaqah' | 'income' | 'recurring' | 'stock' | 'own'
  // what has already happened, which is half of what a calendar is for
  | 'expense' | 'giving' | 'metal' | 'order' | 'transfer' | 'debt';

/**
 * A colour per kind, so a month reads at a glance.
 *
 * These are the same hues the rest of the interface gives each subject, written as plain hex
 * because a calendar feed leaves the browser and a CSS variable would mean nothing there.
 */
export const CALENDAR_COLORS: Record<CalendarKind, string> = {
  installment: '#C2603E',
  paid: '#3F7D4F',
  zakat: '#B37E00',
  reminder: '#6B7BA8',
  sadaqah: '#B0578D',
  income: '#3F7D4F',
  recurring: '#7A7268',
  stock: '#4E7FA8',
  own: '#5E8B7E',
  expense: '#B3722E',
  giving: '#B0578D',
  metal: '#B8912F',
  order: '#4E7FA8',
  transfer: '#7C6FA8',
  debt: '#8A6552',
};

export const CALENDAR_LABELS: Record<CalendarKind, string> = {
  installment: 'Installment due',
  paid: 'Installment paid',
  zakat: 'Zakat',
  reminder: 'Warning',
  sadaqah: 'Giving',
  income: 'Income',
  recurring: 'Standing charge',
  stock: 'Intention',
  own: 'Your own entry',
  expense: 'Spent',
  giving: 'Given',
  metal: 'Gold and silver',
  order: 'Order',
  transfer: 'Moved between your own',
  debt: 'Debt',
};

/**
 * The mark each kind wears.
 *
 * A calendar of coloured bars is a calendar you have to hold a legend against. An event says
 * what it is by carrying the icon of the thing it happened to — and where the thing has a mark
 * of its own, that mark wins: an installment on the flat shows the flat, not a generic
 * building.
 */
export const CALENDAR_ICONS: Record<CalendarKind, string> = {
  installment: 'building',
  paid: 'check',
  zakat: 'zakat',
  reminder: 'bell',
  sadaqah: 'hands',
  income: 'income',
  recurring: 'refresh',
  stock: 'stocks',
  own: 'calendar',
  expense: 'expenses',
  giving: 'charity',
  metal: 'goldbar',
  order: 'chartline',
  transfer: 'flow',
  debt: 'handshake',
};

export interface CalendarEvent {
  id: string;
  /** yyyy-mm-dd, local calendar; every event on this calendar lasts the day */
  date: string;
  /** the same day in the lunar calendar */
  hijri: string | null;
  kind: CalendarKind;
  title: string;
  detail?: string;
  amount?: number;
  currency?: string;
  color: string;
  daysAway: number;
  /** already happened and still waiting on you */
  overdue?: boolean;
  /** the owner's own entry this came from, so a screen can offer to edit it */
  entryId?: string;
  done?: boolean;
  /** the mark to draw it with: the thing's own, or its kind's */
  icon: string;
  /** already happened, as opposed to still to come */
  past?: boolean;
}

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const shift = (isoDate: string, days: number): string => {
  const d = new Date(`${isoDate}T12:00:00`);
  d.setDate(d.getDate() - days);
  return iso(d);
};

function leadDays(r: Reminder): number {
  return r.offsetUnit === 'months' ? r.offsetValue * 30 : r.offsetValue;
}

function event(
  e: Omit<CalendarEvent, 'hijri' | 'color' | 'daysAway' | 'icon'>
    & { now: Date; color?: string; icon?: string },
): CalendarEvent {
  const { now, color, icon, ...rest } = e;
  const away = daysUntil(new Date(`${rest.date}T12:00:00`), now);
  return {
    ...rest,
    hijri: hijriTextOfIso(rest.date),
    // an entry of the owner's own may carry a colour; everything derived takes its kind's
    color: color || CALENDAR_COLORS[rest.kind],
    icon: icon || CALENDAR_ICONS[rest.kind],
    daysAway: away,
    past: rest.past ?? away < 0,
  };
}

/**
 * An entry the owner put on the calendar themselves.
 *
 * Everything else here is derived from something the ledger already knew. These are not: a
 * viewing, a signing, a meeting about one of these flats. They repeat on their own terms —
 * including in the lunar year, because an anniversary reckoned that way drifts against this
 * calendar by eleven days each time round, and no monthly or yearly repeat can say that.
 */
export interface CalendarEntry {
  id: string;
  date: string;
  title: string;
  note?: string | null;
  color?: string | null;
  repeat?: 'none' | 'monthly' | 'annually' | 'lunar_annually' | null;
  remindDays?: number | null;
  amount?: number | null;
  currency?: string | null;
  doneAt?: string | null;
}

/**
 * The days one entry falls on, inside the window being drawn.
 *
 * A repeat is expanded rather than stored, so changing the entry changes every occurrence and
 * nothing has to be swept up afterwards. Monthly repeats clamp to the end of a short month —
 * the 31st in February is the 28th, not the 3rd of March, which is what adding a month
 * naively produces.
 */
export function occurrencesOf(entry: CalendarEntry, from: Date, to: Date): string[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) return [];
  const first = new Date(`${entry.date}T12:00:00`);
  const repeat = entry.repeat ?? 'none';
  if (repeat === 'none') {
    return first >= from && first <= to ? [entry.date] : [];
  }

  const out: string[] = [];
  const limit = 600; // a window is at most a few years; this only guards a bad date
  if (repeat === 'lunar_annually') {
    const h = toHijri(first);
    for (let i = 0; i < limit; i++) {
      const when = i === 0 ? first : fromHijri(addHijriYears(h, i));
      if (when > to) break;
      if (when >= from) out.push(iso(when));
    }
    return out;
  }

  const day = first.getDate();
  for (let i = 0; i < limit; i++) {
    const when = repeat === 'monthly'
      ? new Date(first.getFullYear(), first.getMonth() + i, 1, 12, 0, 0)
      : new Date(first.getFullYear() + i, first.getMonth(), 1, 12, 0, 0);
    const last = new Date(when.getFullYear(), when.getMonth() + 1, 0).getDate();
    when.setDate(Math.min(day, last));
    if (when > to) break;
    if (when >= from) out.push(iso(when));
  }
  return out;
}

export interface CalendarOptions {
  zakat?: ZakatSettings;
  recurring?: RecurringTemplate[];
  /** how far ahead to look; a year by default, so a calendar can be paged through */
  horizonDays?: number;
  /** how far back to carry what has already happened */
  backDays?: number;
  /** what the owner put on the calendar themselves */
  entries?: CalendarEntry[];
  /** installments as the ledger holds them, so paid ones can be shown as paid */
  installments?: Array<{
    id: string; propertyId: string; property: string; dueOn: string;
    amountEgp: number; note?: string; paidAt?: string | null;
    /** the asset's own mark, so a payment on the flat is drawn as the flat */
    icon?: string | null;
  }>;
  /**
   * What has already happened, with its date.
   *
   * A calendar that only looks forward answers half the question anybody opens one to ask.
   * Every recorded thing carries a date — money spent, given, lent, moved, metal bought,
   * shares ordered — and each of them belongs on the day it happened. They are read from the
   * tables by whoever calls this, because those tables are not the engine's business.
   */
  activity?: Array<{
    id: string; date: string; kind: CalendarKind; title: string;
    detail?: string; amount?: number; currency?: string;
    icon?: string; color?: string;
  }>;
}

/**
 * Every dated thing, ordered.
 *
 * Forward-looking events come from the reminder engine, so the calendar and the Coming up
 * panel can never disagree about what is due. What the reminder engine does not carry — an
 * installment already paid, a lunar year closing on an asset, the warning that runs ahead of
 * a payment — is added here.
 */
export function calendarEvents(
  d: DataSet, m: MarketState, reminders: Reminder[], now: Date, opts: CalendarOptions = {},
): CalendarEvent[] {
  const horizon = opts.horizonDays ?? 400;
  const back = opts.backDays ?? 400;
  const out: CalendarEvent[] = [];

  for (const e of upcoming(d, m, reminders, now, {
    horizonDays: horizon, recurring: opts.recurring, zakat: opts.zakat,
  })) {
    const kind: CalendarKind =
      e.kind === 'installment' ? 'installment'
      : e.kind === 'zakat' ? 'zakat'
      : e.kind === 'sadaqah' ? 'sadaqah'
      : e.kind === 'income' ? 'income'
      : e.kind === 'stock' ? 'stock' : 'recurring';
    out.push(event({
      now, id: `cal-${e.id}`, date: iso(e.date), kind, title: e.label,
      detail: e.detail, amount: e.amount, currency: e.currency, overdue: e.overdue,
    }));
  }

  // Installments the ledger holds, including the ones already paid — a calendar that only
  // shows what is ahead cannot answer "did I pay September".
  const rows = opts.installments ?? d.installments.map((i) => {
    const due = installmentDueDate(i.monthLabel, i.dueDayKind, i.dueDayNum);
    return {
      id: i.id, propertyId: i.propertyId,
      property: d.nodes.find((n) => n.id === i.propertyId)?.name ?? i.propertyId,
      dueOn: due ? iso(due) : '', amountEgp: i.amountEgp, note: i.note,
      paidAt: null as string | null, icon: null as string | null,
    };
  });

  for (const r of rows) {
    if (!r.dueOn) continue;
    const away = daysUntil(new Date(`${r.dueOn}T12:00:00`), now);
    if (away > horizon || away < -back) continue;
    if (r.paidAt) {
      out.push(event({
        now, id: `cal-paid-${r.id}`, date: r.paidAt.slice(0, 10), kind: 'paid',
        title: `${r.property} — paid`, detail: r.note || 'installment paid',
        amount: r.amountEgp, currency: 'EGP', icon: r.icon ?? undefined, past: true,
      }));
      continue;
    }
    if (away < 0) {
      out.push(event({
        now, id: `cal-inst-${r.id}`, date: r.dueOn, kind: 'installment',
        title: r.property, detail: r.note || 'installment due', amount: r.amountEgp,
        currency: 'EGP', overdue: true, icon: r.icon ?? undefined,
      }));
      continue;
    }
    // a future one may already be in the reminder engine's list; the ledger's own schedule
    // knows the asset's mark, which that list does not, so this one replaces it
    const already = out.findIndex((x) => x.id === `cal-inst-${r.id}`);
    if (already >= 0) out.splice(already, 1);
    out.push(event({
      now, id: `cal-inst-${r.id}`, date: r.dueOn, kind: 'installment',
      title: r.property, detail: r.note || 'installment due',
      amount: r.amountEgp, currency: 'EGP', icon: r.icon ?? undefined,
    }));
  }

  // The warning, as its own day. A reminder that only shades the payment red on the day it
  // arrives is no use in a calendar — the point of a lead time is that it has a date.
  for (const e of out.slice()) {
    if (e.kind !== 'installment' && e.kind !== 'zakat') continue;
    const r = e.kind === 'zakat'
      ? reminders.find((x) => x.subject === 'zakat' && x.enabled)
      : reminders.find((x) => x.subject === 'installment' && x.enabled
          && rows.some((row) => `cal-inst-${row.id}` === e.id && row.propertyId === x.subjectId));
    if (!r || leadDays(r) <= 0) continue;
    const when = shift(e.date, leadDays(r));
    out.push(event({
      now, id: `${e.id}-warn`, date: when, kind: 'reminder',
      title: `${e.title} — ${describeLead(r)}`,
      detail: `falls due ${e.date}`, amount: e.amount, currency: e.currency,
    }));
  }

  // The zakat date itself, whether or not a reminder is switched on for it — an obligation
  // does not stop having a date because nobody asked to be warned about it.
  if (opts.zakat && !out.some((e) => e.kind === 'zakat')) {
    const z = zakatDates(now, opts.zakat);
    out.push(event({
      now, id: 'cal-zakat', date: iso(z.due), kind: 'zakat',
      title: 'Zakat falls due', detail: z.dueHijri ? `${z.dueHijri.day}/${z.dueHijri.month}/${z.dueHijri.year} AH` : undefined,
    }));
  }

  // Everything already recorded, on the day it was recorded.
  for (const a of opts.activity ?? []) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(a.date)) continue;
    const away = daysUntil(new Date(`${a.date}T12:00:00`), now);
    if (away > horizon || away < -back) continue;
    out.push(event({
      now, id: `cal-act-${a.id}`, date: a.date, kind: a.kind, title: a.title,
      detail: a.detail, amount: a.amount, currency: a.currency,
      icon: a.icon, color: a.color, past: away <= 0,
    }));
  }

  // The owner's own entries, expanded across the window.
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back, 12, 0, 0);
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + horizon, 12, 0, 0);
  for (const entry of opts.entries ?? []) {
    for (const when of occurrencesOf(entry, from, to)) {
      out.push(event({
        now, id: `cal-own-${entry.id}-${when}`, date: when, kind: 'own',
        title: entry.title,
        detail: [entry.note, entry.doneAt ? 'done' : null,
                 entry.repeat && entry.repeat !== 'none'
                   ? entry.repeat === 'lunar_annually' ? 'every lunar year'
                     : entry.repeat === 'monthly' ? 'every month' : 'every year'
                   : null].filter(Boolean).join(' · ') || undefined,
        amount: entry.amount ?? undefined, currency: entry.currency ?? undefined,
        color: entry.color ?? undefined,
        done: !!entry.doneAt,
        entryId: entry.id,
      }));
      if (entry.remindDays && entry.remindDays > 0) {
        const warn = shift(when, entry.remindDays);
        if (warn >= iso(from)) {
          out.push(event({
            now, id: `cal-own-${entry.id}-${when}-warn`, date: warn, kind: 'reminder',
            title: `${entry.title} — ${entry.remindDays} day${entry.remindDays === 1 ? '' : 's'} before`,
            detail: `falls on ${when}`,
            entryId: entry.id,
          }));
        }
      }
    }
  }

  const seen = new Set<string>();
  return out
    .filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ── the feed a calendar application subscribes to ────────────────────────────────────

function fold(line: string): string {
  // RFC 5545 wants lines under 75 octets, continued with a leading space.
  const out: string[] = [];
  let rest = line;
  while (rest.length > 73) { out.push(rest.slice(0, 73)); rest = ` ${rest.slice(73)}`; }
  out.push(rest);
  return out.join('\r\n');
}

function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

const stamp = (d: Date) => `${d.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;

/**
 * The same events as an iCalendar feed.
 *
 * Written by hand rather than with a library: the format is a dozen lines, and a dependency
 * that pulls in a timezone database to emit all-day events would be the larger cost. Every
 * event is a whole day, which is what these are — a payment is due on a day, not at 14:30.
 */
export function toIcs(events: CalendarEvent[], opts: { name?: string; now?: Date; url?: string } = {}): string {
  const now = opts.now ?? new Date();
  const name = opts.name ?? 'Ledg00r';
  const lines: string[] = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Ledg00r//Ledger//EN',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(name)}`,
    'X-WR-TIMEZONE:UTC',
    `X-WR-CALDESC:${esc('Installments, zakat, lunar years and reminders from your ledger.')}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
    'X-PUBLISHED-TTL:PT6H',
  ];

  for (const e of events) {
    const day = e.date.replace(/-/g, '');
    const next = new Date(`${e.date}T12:00:00`);
    next.setDate(next.getDate() + 1);
    const detail = [e.detail, e.hijri ? `${e.hijri} AH` : null,
                    e.amount != null ? `${Math.round(e.amount)} ${e.currency ?? 'EGP'}` : null]
      .filter(Boolean).join(' · ');
    lines.push(
      'BEGIN:VEVENT',
      fold(`UID:${e.id}@ledg00r`),
      `DTSTAMP:${stamp(now)}`,
      `DTSTART;VALUE=DATE:${day}`,
      `DTEND;VALUE=DATE:${iso(next).replace(/-/g, '')}`,
      fold(`SUMMARY:${esc(`${e.title}${e.amount != null ? ` · ${Math.round(e.amount)} ${e.currency ?? 'EGP'}` : ''}`)}`),
      fold(`DESCRIPTION:${esc(detail)}`),
      fold(`CATEGORIES:${esc(CALENDAR_LABELS[e.kind])}`),
      `X-APPLE-CALENDAR-COLOR:${e.color}`,
      `COLOR:${e.color}`,
      'TRANSP:TRANSPARENT',
      'END:VEVENT',
    );
  }

  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}
