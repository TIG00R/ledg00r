import { Fragment, useEffect, useState } from 'react';
import { Amount } from '../components/Amount';
import { AccountLine } from '../components/AccountLine';
import { RecordAmount } from '../components/RecordAmount';
import { DateField } from '../components/DateField';
import { RecordTable } from '../components/RecordTable';
import { GivingRecords } from '../components/GivingRecords';
import { Select } from '../components/Select';
import { accountOption } from '../accounts';
import { useApp, market } from '../AppState';
import { describeLead, zakatDebts, zakatDates, nisabEgp, formatHijri, groupOf,
         ZAKAT_RATE, HIJRI_MONTHS, NISAB_GOLD_G, NISAB_SILVER_G,
         type ZakatEntry, type EntryGroup } from '@ledger/engine';
import { Page, Panel, Stat, Stats, Chip, Toggle, Row, Field } from '../components/UI';
import { Segmented } from '../components/Segmented';
import { Icon } from '../components/Icon';
import { Mark } from '../components/Mark';
import { useAppearance, type AssetKey } from '../Appearance';
import { useLive, ActionButton } from '../Live';
import { ledger } from '../api';

/** the icon and colour behind one line of the list — an asset's own mark where it has one,
    the pile's own where it does not, and nothing at all for what you owe */
interface EntryMark {
  icon: string; color: string;
  fallback: 'gold' | 'stocks' | 'car' | 'building' | 'banknote' | 'debts';
}

/**
 * Which mark a line wears, if it wears one at all.
 *
 * A property or a car is its own record, so it wears exactly the mark chosen for it under
 * Assets — the same lookup that screen uses, keyed by the same id the entry already carries.
 * Gold, shares and cash are not single records but a whole pile counted together, so they wear
 * the pile's own mark instead: the same one Portfolio draws, and the one the owner can
 * recolour from Appearance. Money lent out reads the same way, off the pile Portfolio calls
 * "Debt" — wealth you happen not to be holding, not wealth you owe — because it is exactly the
 * loan that pile draws.
 *
 * What you owe is the one thing left bare on purpose. A debt is an obligation, not a holding,
 * and every line under "Debts that come off" is unmarked alike — a missing tile there reads as
 * the section's own shape rather than as one line the app forgot.
 */
function markFor(
  id: string,
  assets: Record<string, { icon: string | null; color: string | null; kind: string }>,
  pile: (k: AssetKey) => { icon: string; color: string },
): EntryMark | null {
  const baseId = id.replace(/^excluded-/, '');
  if (/^silver-(investment|personal)$/.test(baseId)) {
    return { icon: 'coins', color: 'var(--muted)', fallback: 'gold' };
  }
  if (baseId === 'gold' || /^gold-(investment|personal)$/.test(baseId)) {
    return { icon: pile('gold').icon, color: pile('gold').color, fallback: 'gold' };
  }
  // `shares` is the estate's own book; `stocks` is the same figure typed by hand when there
  // is no ledger to read it off — the same holding either way, so it wears the same mark.
  if (baseId === 'shares' || baseId === 'stocks') {
    return { icon: pile('stocks').icon, color: pile('stocks').color, fallback: 'stocks' };
  }
  if (baseId === 'cash') {
    return { icon: pile('cash').icon, color: pile('cash').color, fallback: 'banknote' };
  }
  // A receivable — money lent out and expected back — is the same wealth Portfolio's "Debt"
  // pile draws, and wears its mark for the same reason: it is owned, just not held.
  if (/^owed-/.test(baseId)) {
    return { icon: pile('debt').icon, color: pile('debt').color, fallback: 'debts' };
  }
  const asset = assets[baseId];
  if (asset) {
    const fallback = asset.kind === 'vehicle' ? 'car' : 'building';
    // The same default AssetsView reaches for when nothing was ever chosen — a mark and its
    // colour are the same thing wherever this asset is drawn.
    return { icon: asset.icon ?? fallback, color: asset.color ?? 'var(--negative)', fallback };
  }
  return null;
}

/** one line of the arithmetic, with the sign that says which way it goes */
type Entry = ZakatEntry;

interface BucketHawl {
  startOn: string; startHijriText: string; dueOn: string; dueHijriText: string;
  yearsComplete: number; complete: boolean; daysRemaining: number; elapsedPct: number;
}

interface ConfirmedYear {
  id: string; dueOn: string; dueHijri: string; confirmedAt: string;
  base: number; due: number; note: string | null;
  paid: number; remaining: number; entries: Entry[];
}

/** a year as the log keeps it: the frozen arithmetic, and what was paid against it */
interface LoggedYear {
  id: string; bucket: string; label: string;
  /** whether it was typed in for the record rather than closed by the ledger itself */
  manual: boolean;
  startOn: string; dueOn: string; dueHijri: string; anchorOn: string | null;
  base: number; due: number; paid: number; remaining: number;
  nisab: number; basis: string; confirmedAt: string; note: string | null;
  goldPerG: number | null; silverPerG: number | null;
  entries: Entry[];
  payments: ZakatPayment[];
}

/** one payment made against a confirmed year, as the ledger recorded it */
interface ZakatPayment {
  id: string; date: string; egp: number; causeId: string; note: string | null;
  /** what was handed over and out of what, so a correction shows what was recorded */
  amount: number; currency: string; accountId: string | null;
}

/**
 * The estate: everything owned, under one lunar year.
 *
 * An array of one comes back from the ledger, because years confirmed under the older
 * per-kind reading are still filed under the pot they closed as.
 */
interface Bucket {
  id: string; label: string; kind: string;
  anchorOn: string | null; closedOn: string | null;
  state: 'running' | 'draft' | 'confirmed';
  base: number; due: number; aboveNisab: boolean;
  entries: Entry[];
  hawl: BucketHawl | null;
  confirmed: ConfirmedYear | null;
}

/** the three sections the list is read in, in the order they are read */
const SECTIONS: Array<{ group: EntryGroup; title: string; hint: string }> = [
  { group: 'counted', title: 'Counted toward zakat',
    hint: 'money, and everything held in a way that makes it zakatable' },
  { group: 'excluded', title: 'Owned, and counted for nothing',
    hint: 'shown at what it is worth, so its absence from the total is something you can see' },
  { group: 'debt', title: 'Debts that come off',
    hint: 'what is still to be paid inside this year — subtracting them is your choice' },
];

export function Zakat() {
  const { data, values: v, dm, now, balances, reminders, setReminders,
          zakatSettings: z, setZakatSettings: setLocal } = useApp();
  const { run, live, version, running } = useLive();
  // Kept in step both ways: the screen answers immediately, the ledger records the choice.
  const setZakatSettings = (next: typeof z) => {
    setLocal(next);
    void run('zakat.configure', {
      anniversaryMonth: next.anniversaryMonth, anniversaryDay: next.anniversaryDay,
      basis: next.basis, silverPerG: next.silverPerG, deductDebts: next.deductDebts,
    });
  };
  const [manual, setManual] = useState(false);

  const [manualValues, setManualValues] = useState<Record<string, number>>({});

  const [assessment, setAssessment] = useState<any>(null);
  /**
   * Working it out yourself has to reach the ledger too.
   *
   * The figure at the top comes from the assessment, because only the ledger knows what the
   * accounts hold. So when the figures are yours they are sent with the question — otherwise
   * the headline answers a base nobody typed, which is the one thing this mode exists to
   * avoid.
   */
  useEffect(() => {
    if (!live) { setAssessment(null); return; }
    let off = false;
    const input = manual
      ? { manual: { cash: manualValues.cash ?? 0, gold: manualValues.gold ?? 0,
                    stocks: manualValues.stocks ?? 0 } }
      : {};
    (ledger as any)['zakat.assessment'](input)
      .then((a: unknown) => { if (!off) setAssessment(a); })
      .catch(() => { if (!off) setAssessment(null); });
    return () => { off = true; };
  }, [live, version, manual, manualValues.cash, manualValues.gold, manualValues.stocks]);


  /**
   * The ledger's settings win over the screen's copy.
   *
   * The copy exists so a change answers at once rather than after a round trip, but it starts
   * from a default the ledger may never have agreed with — and every date on this screen is
   * reckoned from the anniversary, so a screen holding one anniversary while the figures were
   * worked out under another shows two different zakat dates and no way to tell which is real.
   */
  useEffect(() => {
    const server = assessment?.settings;
    if (!server) return;
    const same = server.anniversaryMonth === z.anniversaryMonth
      && server.anniversaryDay === z.anniversaryDay
      && server.basis === z.basis
      && server.silverPerG === z.silverPerG
      && server.deductDebts === z.deductDebts;
    if (!same) setLocal({ ...z, ...server });
  }, [assessment?.settings]);

  /**
   * Every year ever confirmed, from the ledger rather than from the estate.
   *
   * The estate only knows the year that closed most recently, so reading the log off it would
   * lose everything older the moment a new year came round — which is the opposite of what a
   * log is for.
   */
  const [years, setYears] = useState<LoggedYear[]>([]);
  useEffect(() => {
    if (!live) { setYears([]); return; }
    let off = false;
    (ledger as any)['zakat.years']({})
      .then((rows: LoggedYear[]) => { if (!off) setYears(rows ?? []); })
      .catch(() => { if (!off) setYears([]); });
    return () => { off = true; };
  }, [live, version]);

  /**
   * The mark and colour behind every property, car and other asset — the same record Assets
   * itself reads, kept beside the list rather than folded into it, since the estate's own
   * entries know nothing of icons and were not about to be taught for this alone.
   */
  const [assetMarks, setAssetMarks] = useState<Record<string, { icon: string | null; color: string | null; kind: string }>>({});
  useEffect(() => {
    if (!live) { setAssetMarks({}); return; }
    let off = false;
    (ledger as any)['assets.list']({})
      .then((rows: Array<{ id: string; icon: string | null; color: string | null; kind: string }>) => {
        if (off) return;
        const map: Record<string, { icon: string | null; color: string | null; kind: string }> = {};
        for (const a of rows ?? []) map[a.id] = { icon: a.icon, color: a.color, kind: a.kind };
        setAssetMarks(map);
      })
      .catch(() => { if (!off) setAssetMarks({}); });
    return () => { off = true; };
  }, [live, version]);
  const { appearance } = useAppearance();
  const pile = (k: AssetKey) => appearance.assets[k];

  // The ledger holds this setting; the local copy is only what the screen last sent it.
  const deductDebts = assessment?.deductDebts ?? z.deductDebts;
  const setDeductDebts = (on: boolean) => setZakatSettings({ ...z, deductDebts: on });
  const nisab = nisabEgp(market, z);
  const nisabGrams = z.basis === 'silver' ? NISAB_SILVER_G : NISAB_GOLD_G;

  const estate: Bucket | null = manual ? null : (assessment?.buckets?.[0] ?? null);

  const debtRows: Array<{ id: string; label: string; amountEgp: number; date: string; kind?: string }> =
    assessment?.debts ?? zakatDebts(data, now, z);

  /**
   * The list, when there is no ledger to sort it.
   *
   * The fixtures know what money is worth and what is owed, and nothing about what anything is
   * held for — so the list they make is short. It is still the same list, read the same way,
   * which is why the screen has one table rather than one for each case.
   */
  const fallback: Entry[] = [
    ...(manual
      ? [
          { id: 'cash', label: 'Cash', sign: 1 as const, group: 'counted' as const,
            amount: manualValues.cash ?? 0, detail: 'whatever you hold, in one figure' },
          { id: 'gold', label: 'Gold and silver', sign: 1 as const, group: 'counted' as const,
            amount: manualValues.gold ?? 0, detail: 'valued at whatever you judge it worth' },
          { id: 'stocks', label: 'Shares and funds', sign: 1 as const, group: 'counted' as const,
            amount: manualValues.stocks ?? 0, detail: 'market value on the day' },
        ]
      : [
          { id: 'cash', label: 'Cash', sign: 1 as const, group: 'counted' as const,
            amount: assessment?.cash ?? v.cash, detail: 'every account, converted at today\'s rates' },
          { id: 'stocks', label: 'Shares and funds', sign: 1 as const, group: 'counted' as const,
            amount: assessment?.stocks ?? v.stocks, detail: 'the book, at the prices last recorded' },
        ]),
    ...debtRows.map((d) => ({
      id: `debt-${d.id}`, label: d.label,
      sign: (deductDebts ? -1 : 0) as 1 | -1 | 0,
      amount: d.amountEgp, group: 'debt' as const,
      note: deductDebts ? undefined : 'Not subtracted — the deduction is switched off.',
      facts: [{ label: 'Due', value: d.date || 'owed now' }],
    })),
  ];

  const entries: Entry[] = estate?.entries ?? fallback;
  const editable = manual && !estate;
  const sectionOf = (g: EntryGroup) => entries.filter((e) => groupOf(e) === g);

  const counted = sectionOf('counted').reduce((s, e) => s + e.sign * e.amount, 0);
  const excluded = sectionOf('excluded').reduce((s, e) => s + e.sign * e.amount, 0);
  const debts = sectionOf('debt').reduce((s, e) => s + e.amount, 0);
  const assets = counted + excluded;

  /**
   * The ledger's answer wins.
   *
   * It knows what the accounts actually hold and what is owed to you; the local figure is
   * worked from the fixture and cannot. Keeping the screen on its own arithmetic would mean
   * showing a number the API disagrees with, which is worse than showing nothing.
   */
  const finalBase = assessment ? assessment.base
    : Math.max(0, deductDebts ? assets - debts : assets);
  const baseBefore = assessment?.baseBeforeDebts ?? assets;
  const due = assessment ? assessment.due : finalBase * ZAKAT_RATE;

  const [correction, setCorrection] = useState<number | null>(null);

  /**
   * Accounts to pay out of, the fullest first.
   *
   * The first account in the ledger is as likely as not to be an empty brokerage wallet, and
   * a form that opens on one turns a payment into a refusal for no reason the owner caused.
   */
  const payFrom = data.nodes
    .filter((n) => n.kind === 'cash' && !n.archived)
    .sort((a, b) => (balances[b.id] ?? 0) - (balances[a.id] ?? 0));

  const [openYear, setOpenYear] = useState<string | null>(null);
  const causeName = (id: string) =>
    data.categories.find((c) => c.id === id)?.name ?? id;

  /** the line of your own being written, and whether the form for it is open */
  const [adding, setAdding] = useState(false);
  const [ownLine, setOwnLine] = useState<Record<string, string | number>>({ group: 'counted' });

  const [paying, setPaying] = useState<string | null>(null);
  const [payment, setPayment] = useState({
    accountId: '',
    amount: 0,
    causeId: data.categories.find((c) => c.domain === 'charity')?.id ?? '',
  });
  const payAccount = payment.accountId || payFrom[0]?.id || '';

  const rem = reminders.find((r) => r.subject === 'zakat');
  /**
   * The screen answers at once; the ledger keeps the answer.
   *
   * Setting the local copy alone meant the switch moved and nothing was written, so the next
   * read put it back where it was — and a ledger with no zakat reminder at all had nothing
   * for `map` to touch, so switching it on did nothing whatsoever. Both are the same fix:
   * the row is created when it is missing, and the choice goes to the ledger either way.
   */
  const update = (patch: Partial<(typeof reminders)[number]>) => {
    const fresh: (typeof reminders)[number] = {
      id: 'rem-zakat', subject: 'zakat', enabled: false,
      offsetValue: 1, offsetUnit: 'months',
    };
    const next = { ...(rem ?? fresh), ...patch };
    setReminders(rem
      ? reminders.map((r) => (r.subject === 'zakat' ? next : r))
      : [...reminders, next]);
    void run('reminder.set', {
      subject: 'zakat',
      enabled: next.enabled,
      offsetValue: next.offsetValue,
      offsetUnit: next.offsetUnit,
    });
  };

  const dates = zakatDates(now, z);
  const away = dates.daysAway;
  const hawlDays = Math.max(1, Math.round((dates.due.getTime() - dates.start.getTime()) / 86_400_000));
  const elapsed = Math.min(100, Math.max(0, ((hawlDays - away) / hawlDays) * 100));

  const confirmed = estate?.confirmed ?? null;

  return (
    <Page>
      <Panel>
        <div style={{ display: 'flex', gap: 14, marginBottom: 22, flexWrap: 'wrap', alignItems: 'center' }}>
          <Segmented<'assets' | 'manual'>
            value={manual ? 'manual' : 'assets'} ariaLabel="How to work zakat out"
            onChange={(val) => {
              if (val === 'manual') { setManual(true); setManualValues({ cash: 0, gold: 0, stocks: 0 }); }
              else { setManual(false); setManualValues({}); }
            }}
            options={[
              { id: 'assets', label: 'From my assets', icon: 'assets', tone: 'var(--zakat)' },
              { id: 'manual', label: 'Work it out myself', icon: 'edit', tone: 'var(--zakat)' },
            ]} />
          <span className="chip" style={{
            background: 'color-mix(in srgb, var(--zakat) var(--tint), transparent)', color: 'var(--zakat)',
          }}>{manual ? 'Nothing carried over — every figure is yours' : `Estimate · ${away} days to your zakat date`}</span>
        </div>
        <div style={{ display: 'flex', gap: 40, alignItems: 'center', flexWrap: 'wrap' }}>
          <div>
            <div className="ov">Zakat due</div>
            <div className="mono" style={{ fontSize: 40, fontWeight: 500, letterSpacing: '-0.02em', margin: '8px 0 2px' }}>
              {dm(due)}
            </div>
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>2.5% of {dm(finalBase)}</div>
          </div>
          <div style={{ height: 64, width: 1, background: 'var(--hairline)' }} />
          <div style={{ flex: 1, minWidth: 300 }}>
            <Stats>
              <Stat label="Zakatable wealth" value={dm(finalBase)}
                  sub={deductDebts && baseBefore > finalBase
                    ? `${dm(baseBefore)} less ${dm(baseBefore - finalBase)} owed`
                    : `of ${dm(v.total)} net worth`} />
              <Stat label="Nisab threshold" value={dm(nisab)} sub={`${nisabGrams} g ${z.basis}`} />
              <Stat label="Above nisab by" value={finalBase >= nisab ? `${(finalBase / nisab).toFixed(1)}×` : '—'}
                    sub={finalBase >= nisab ? 'zakat is due' : 'below nisab · nothing is due'}
                    color={finalBase >= nisab ? 'var(--positive)' : 'var(--muted)'} />
            </Stats>
          </div>
        </div>
      </Panel>

      <Panel title="Your zakat date" hint="Zakat is the only part of this app that runs on the Hijri calendar. The hawl is a lunar year, about 354 days, so the date drifts roughly eleven days earlier each Gregorian year.">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 18 }}>
          <div style={{ padding: 16, borderRadius: 'var(--r-card)', background: 'var(--raised)', border: '1px solid var(--hairline)' }}>
            <div className="ov" style={{ marginBottom: 10 }}>Anniversary</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <Select ariaLabel="Hijri day" value={String(z.anniversaryDay)} style={{ width: 84 }}
                      onChange={(val) => setZakatSettings({ ...z, anniversaryDay: Number(val) })}
                      options={Array.from({ length: 30 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))} />
              <Select ariaLabel="Hijri month" value={String(z.anniversaryMonth)} style={{ flex: 1 }}
                      onChange={(val) => setZakatSettings({ ...z, anniversaryMonth: Number(val) })}
                      options={HIJRI_MONTHS.map((m, i) => ({ value: String(i + 1), label: m }))} />
            </div>
            <p style={{ margin: '12px 0 0', fontSize: 11, color: 'var(--faint)', lineHeight: 1.5 }}>
              The day your wealth first passed nisab and has stayed above it since. The app cannot
              work this out — it only knows what you own now.
            </p>
          </div>
          <div style={{ padding: 16, borderRadius: 'var(--r-card)', background: 'var(--surface)', border: '1px solid var(--hairline)' }}>
            <div className="ov" style={{ marginBottom: 10 }}>This hawl</div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>Began</div>
            <div className="mono" style={{ fontSize: 14 }}>{formatHijri(dates.startHijri)}</div>
            <div style={{ fontSize: 11, color: 'var(--faint)' }}>
              ≈ {dates.start.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
            </div>
            <div style={{ fontSize: 13, fontWeight: 500, marginTop: 12 }}>Falls due</div>
            <div className="mono" style={{ fontSize: 14, color: 'var(--zakat)' }}>{formatHijri(dates.dueHijri)}</div>
            <div style={{ fontSize: 11, color: 'var(--faint)' }}>
              ≈ {dates.due.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
            </div>
          </div>
          <div style={{ padding: 16, borderRadius: 'var(--r-card)',
                        background: 'color-mix(in srgb, var(--zakat) var(--tint), transparent)',
                        border: '1px solid color-mix(in srgb, var(--accent) 26%, transparent)' }}>
            <div className="ov" style={{ marginBottom: 10, color: 'var(--zakat)' }}>Countdown</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span className="mono" style={{ fontSize: 32, fontWeight: 500 }}>{away}</span>
              <span style={{ fontSize: 13, color: 'var(--muted)' }}>days</span>
            </div>
            <div style={{ height: 8, borderRadius: 999, background: 'var(--switch-off)', margin: '12px 0 8px' }}>
              <span style={{ display: 'block', width: `${elapsed}%`, height: '100%', borderRadius: 999, background: 'var(--zakat)' }} />
            </div>
            <div style={{ fontSize: 11, color: 'var(--faint)' }}>{elapsed.toFixed(1)}% of the hawl elapsed</div>
          </div>
        </div>

        <Row cols="34px minmax(0,1fr) 210px 66px" style={{
          marginTop: 16, padding: '14px 16px', borderRadius: 'var(--r-card)',
          background: 'var(--raised)', border: '1px solid var(--hairline)',
        }}>
          <Icon name="bell" size={17} color={rem?.enabled ? 'var(--zakat)' : 'var(--faint)'} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 500 }}>Remind me before the hawl ends</div>
            <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 2 }}>
              {rem?.enabled ? `warns ${describeLead(rem)} ${formatHijri(dates.dueHijri)}` : 'no reminder set'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input type="number" min={0} value={rem?.offsetValue ?? 1} aria-label="Zakat lead time"
                   onChange={(e) => update({ offsetValue: Number(e.target.value) })} style={{ width: 70 }} />
            <Select ariaLabel="Zakat lead unit" value={rem?.offsetUnit ?? 'months'} onChange={(val) => update({ offsetUnit: val as 'days' | 'months' })}
                    options={[{ value: 'days', label: 'days before' }, { value: 'months', label: 'months before' }]} />
          </div>
          <span style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Toggle on={rem?.enabled ?? false} onChange={(val) => update({ enabled: val })} label="Zakat reminder" />
          </span>
        </Row>

        <p style={{ margin: '14px 0 0', fontSize: 11, color: 'var(--faint)', lineHeight: 1.5 }}>
          Everything you own is counted together on this one date — cash, gold, shares, goods held to
          sell, money lent out. Scholars who give each kind of wealth its own lunar year, counted from
          the day that kind passed nisab, would read some of these dates differently.
        </p>
        <p style={{ margin: '8px 0 0', fontSize: 11, color: 'var(--faint)', lineHeight: 1.5 }}>
          Hijri dates here are tabular — arithmetic, not moon sighting — so they can differ by a day
          from what your local authority announces.
        </p>
      </Panel>

      <Panel title="Everything you own, and what is owed on it"
             hint="One list, read straight down: what counts, what is shown and counts for nothing, and what comes off. Every line carries its sign, so nothing has to be inferred from where it sits."
             action={<Toggle on={deductDebts} onChange={setDeductDebts} label="Subtract debts" />}>

        {confirmed && (
          <div style={{
            display: 'flex', gap: 30, flexWrap: 'wrap', marginBottom: 18,
            padding: '14px 16px', borderRadius: 'var(--r-card)',
            background: 'color-mix(in srgb, var(--positive) 6%, transparent)',
            border: '1px solid color-mix(in srgb, var(--positive) 26%, transparent)',
          }}>
            <div>
              <div className="ov">Owed for the year to {confirmed.dueOn}</div>
              <div className="mono" style={{ fontSize: 20, fontWeight: 600, marginTop: 3 }}>{dm(confirmed.due)}</div>
              <div style={{ fontSize: 11, color: 'var(--faint)' }}>2.5% of {dm(confirmed.base)}, fixed that day</div>
            </div>
            <div>
              <div className="ov">Paid</div>
              <div className="mono" style={{ fontSize: 16, marginTop: 3 }}>{dm(confirmed.paid)}</div>
            </div>
            <div>
              <div className="ov">Still to pay</div>
              <div className="mono" style={{ fontSize: 16, marginTop: 3,
                                             color: confirmed.remaining > 0 ? 'var(--negative)' : 'var(--positive)' }}>
                {dm(confirmed.remaining)}
              </div>
            </div>
            <div style={{ marginLeft: 'auto', alignSelf: 'center' }}>
              <Chip tone="good">Confirmed {confirmed.dueOn}</Chip>
            </div>
          </div>
        )}

        <table>
          <thead>
            <tr>
              <th style={{ width: 30 }}><span className="sr-only">Sign</span></th>
              <th>{estate?.state === 'confirmed' ? 'The year now running' : 'What it is'}</th>
              <th>Amount</th>
            </tr>
          </thead>
          <tbody>
            {SECTIONS.map((s) => {
              const rows = sectionOf(s.group);
              if (rows.length === 0) return null;
              // A line counted for nothing still has a value, and that value is the whole
              // point of showing it. Only the counted section sums what it contributes;
              // the other two sum what they are worth.
              const sum = s.group === 'counted'
                ? rows.reduce((t, e) => t + e.sign * e.amount, 0)
                : rows.reduce((t, e) => t + e.amount, 0);
              return (
                <Fragment key={s.group}>
                  <tr>
                    <td colSpan={3} style={{
                      padding: '14px 10px 8px',
                      borderBottom: '1px solid var(--hairline)',
                      background: 'var(--raised)',
                    }}>
                      <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
                        <span className="ov" style={{ color: s.group === 'debt' ? 'var(--negative)' : undefined }}>
                          {s.title}
                        </span>
                        <span style={{ fontSize: 11, color: 'var(--faint)' }}>{s.hint}</span>
                        <span className="mono" style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--faint)' }}>
                          {rows.length === 1 ? '1 line' : `${rows.length} lines`} · {dm(sum)}
                        </span>
                      </div>
                    </td>
                  </tr>
                  {rows.map((e) => (
                    <EntryRow key={e.id} entry={e} dm={dm} mark={markFor(e.id, assetMarks, pile)}
                      edit={editable && e.group === 'counted'
                        ? (n) => setManualValues({ ...manualValues, [e.id]: n })
                        : undefined}
                      /* Every line is the owner's to state: a figure of their own over the
                         one the ledger worked out, the line left out of the reckoning
                         altogether, or — on a line they wrote — taken off the list. */
                      say={live && !manual ? {
                        onAmount: (n) => void run('zakat.entry.set',
                          e.typed ? { entryId: e.id, amount: n } : { entryId: e.id, amount: n }),
                        onRemove: () => void run('zakat.entry.set', { entryId: e.id, removed: true }),
                        onRestore: () => void run('zakat.entry.clear', { entryId: e.id }),
                        typed: !!e.typed,
                        overridden: !!e.overridden,
                      } : undefined} />
                  ))}
                </Fragment>
              );
            })}

            <tr>
              <td />
              <td style={{ fontWeight: 600, paddingTop: 16 }}>
                Everything counted
                <div style={{ fontSize: 11, color: 'var(--faint)', fontWeight: 400 }}>
                  before anything owed comes off it
                </div>
              </td>
              <td className="mono" style={{ fontWeight: 600, paddingTop: 16 }}>{dm(assets)}</td>
            </tr>
            {debts > 0 && (
              <tr>
                <td className="mono" style={{ textAlign: 'center', fontSize: 15, fontWeight: 600,
                                              color: deductDebts ? 'var(--negative)' : 'var(--faint)' }}>
                  {deductDebts ? '−' : '·'}
                </td>
                <td style={{ fontWeight: 600 }}>
                  Debts
                  <div style={{ fontSize: 11, color: 'var(--faint)', fontWeight: 400 }}>
                    {deductDebts ? 'subtracted, as you have asked' : 'listed above, and not subtracted'}
                  </div>
                </td>
                <td className="mono" style={{ fontWeight: 600,
                                              color: deductDebts ? 'var(--negative)' : 'var(--faint)' }}>
                  {deductDebts ? `−${dm(debts)}` : `(${dm(debts)})`}
                </td>
              </tr>
            )}
            <tr>
              <td />
              <td style={{ fontWeight: 600 }}>
                Zakatable
                {estate && !estate.aboveNisab && (
                  <div style={{ fontSize: 11, color: 'var(--faint)', fontWeight: 400 }}>
                    under nisab, so nothing is owed on it
                  </div>
                )}
              </td>
              <td className="mono" style={{ fontWeight: 600 }}>{dm(finalBase)}</td>
            </tr>
            <tr>
              <td />
              <td style={{ fontWeight: 600 }}>Zakat owed
                <span style={{ fontSize: 11, color: 'var(--faint)', fontWeight: 400 }}> · 2.5%</span></td>
              <td className="mono" style={{ fontWeight: 600, fontSize: 18,
                                            color: due > 0 ? 'var(--positive)' : 'var(--faint)' }}>{dm(due)}</td>
            </tr>
          </tbody>
        </table>

        {/*
          * A line of your own.
          *
          * Everything above is worked out from what the ledger holds, and the ledger does not
          * hold everything: gold at a relative's house, a loan nobody wrote down. Adding one
          * here counts it, and it reads on the list beside the computed lines with its own
          * mark saying whose figure it is.
          */}
        {live && !manual && (
          adding ? (
            <div style={{
              display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap',
              marginTop: 16, padding: '14px 16px', borderRadius: 'var(--r-card)',
              background: 'var(--raised)', border: '1px solid var(--hairline)',
            }}>
              <Field label="What it is">
                <input aria-label="What this line is" placeholder="gold at my mother's"
                       value={String(ownLine.label ?? '')}
                       onChange={(e) => setOwnLine({ ...ownLine, label: e.target.value })} />
              </Field>
              <Field label="How it counts">
                <Select ariaLabel="How this line counts" value={String(ownLine.group ?? 'counted')}
                        onChange={(v) => setOwnLine({ ...ownLine, group: v })}
                        options={[
                          { value: 'counted', label: 'Counted', hint: 'wealth zakat is owed on' },
                          { value: 'excluded', label: 'Shown, counts nothing', hint: 'listed so it can be seen to have been considered' },
                          { value: 'debt', label: 'Comes off', hint: 'something owed' },
                        ]} />
              </Field>
              <Field label="Amount">
                <Amount value={Number(ownLine.amount ?? 0)} ariaLabel="Amount of this line"
                        onChange={(n) => setOwnLine({ ...ownLine, amount: n })} style={{ width: 160 }} />
              </Field>
              <span className="btn-pair">
                <button className="btn go sm" disabled={!ownLine.label || !(Number(ownLine.amount) > 0) || !!running}
                        onClick={() => {
                          void run('zakat.entry.set', {
                            label: String(ownLine.label),
                            group: String(ownLine.group ?? 'counted'),
                            sign: ownLine.group === 'debt' ? -1 : ownLine.group === 'excluded' ? 0 : 1,
                            amount: Number(ownLine.amount),
                          }).then((out) => { if (out.ok) { setAdding(false); setOwnLine({ group: 'counted' }); } });
                        }}>
                  <Icon name="check" size={13} motion="none" /> Count it
                </button>
                <button className="btn ghost sm" onClick={() => { setAdding(false); setOwnLine({ group: 'counted' }); }}>
                  <Icon name="close" size={13} motion="none" /> Cancel
                </button>
              </span>
            </div>
          ) : (
            <button className="btn quiet sm" style={{ marginTop: 16 }} onClick={() => setAdding(true)}>
              <Icon name="plus" size={12} motion="none" /> Add a line of your own
            </button>
          )
        )}
      </Panel>

      {!manual && (
      <Panel title="Every year on the record"
             hint="A lunar year writes itself down the day it closes — what was owed, the lines it was worked out from and the prices it was struck at, so a figure from three years ago can be read back rather than merely remembered. Years from before this ledger are typed in at the top: what was owed, and what was paid against it.">
        {/* The same table every log in the application is drawn with: headings that sort and
            filter, a row at the top that adds, and a row that opens into fields. The years
            used to be a table of this screen's own, with its own borders and its own idea of
            where a button goes. */}
        <RecordTable<LoggedYear>
          rows={years}
          rowKey={(y) => y.id}
          sort={{ key: 'dueOn', dir: 'desc' }}
          empty={{ icon: 'zakat', title: 'No year has closed yet',
                   body: 'A lunar year writes itself down when it closes. One from before this ledger can be typed in above.' }}
          columns={[
            { key: 'dueOn', label: 'Year to', kind: 'date',
              value: (y) => y.dueOn,
              cell: (y) => (
                <span className="mono" style={{ fontSize: 13 }}>
                  {y.dueOn}
                  <span style={{ display: 'block', fontSize: 11, color: 'var(--faint)' }}>{y.dueHijri}</span>
                </span>
              ),
              field: (d, set) => <DateField value={String(d.dueOn ?? '')} ariaLabel="Year closed on" hijri
                                            onChange={(v) => set({ dueOn: v })} /> },
            { key: 'label', label: 'Pot', kind: 'text',
              value: (y) => y.label,
              cell: (y) => (
                <span style={{ fontSize: 13 }}>
                  {y.label}
                  {y.manual && <span className="at-bank">typed in</span>}
                </span>
              ),
              field: (d, set) => <input aria-label="What this year covers" placeholder="Everything you own"
                                        value={String(d.label ?? '')}
                                        onChange={(e) => set({ label: e.target.value })} /> },
            { key: 'base', label: 'Reckoned on', kind: 'amount',
              value: (y) => y.base,
              cell: (y) => <span className="mono" style={{ fontSize: 13, color: 'var(--muted)' }}>{dm(y.base)}</span>,
              field: (d, set) => <Amount value={Number(d.base ?? 0)} ariaLabel="Wealth it was reckoned on"
                                         onChange={(n) => set({ base: n })} /> },
            { key: 'due', label: 'Owed', kind: 'amount',
              value: (y) => y.due,
              cell: (y) => <span className="mono">{dm(y.due)}</span>,
              field: (d, set) => <Amount value={Number(d.due ?? 0)} ariaLabel="What was owed"
                                         onChange={(n) => set({ due: n })} /> },
            { key: 'paid', label: 'Paid', kind: 'amount',
              value: (y) => y.paid,
              cell: (y) => <span className="mono">{dm(y.paid)}</span>,
              /* Only a year typed in states what was paid outright. On the others it is the
                 giving recorded against the year, and those are corrected where they live. */
              field: (d, set, row) => (row?.manual ?? !row)
                ? <Amount value={Number(d.paid ?? 0)} ariaLabel="What was paid against it"
                          onChange={(n) => set({ paid: n })} />
                : <span style={{ fontSize: 11, color: 'var(--faint)' }}>what was given against it</span> },
            { key: 'remaining', label: 'Still to pay', kind: 'amount',
              value: (y) => y.remaining,
              cell: (y) => (
                <span className="mono" style={{ fontWeight: 600,
                                                color: y.remaining > 0 ? 'var(--negative)' : 'var(--positive)' }}>
                  {y.remaining > 0 ? dm(y.remaining) : 'discharged'}
                </span>
              ) },
            { key: 'note', label: 'Note', kind: 'text',
              value: (y) => y.note ?? '',
              cell: (y) => <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                {y.note || <span style={{ color: 'var(--faint)' }}>—</span>}</span>,
              field: (d, set) => <input aria-label="Note" placeholder="what is worth remembering about it"
                                        value={String(d.note ?? '')}
                                        onChange={(e) => set({ note: e.target.value })} /> },
          ]}
          add={{
            label: 'Add a year from before this ledger',
            capability: 'zakat.year.add',
            blank: { dueOn: '', label: 'Everything you own', base: 0, due: 0, paid: 0, note: '' },
            valid: (d) => !!d.dueOn && Number(d.due) >= 0,
            build: (d) => ({
              dueOn: d.dueOn, label: d.label || 'Everything you own',
              due: Number(d.due), paid: Number(d.paid ?? 0),
              ...(Number(d.base) > 0 ? { base: Number(d.base) } : {}),
              ...(d.note ? { note: d.note } : {}),
            }),
          }}
          edit={{
            capability: 'zakat.year.update',
            draftOf: (y) => ({ dueOn: y.dueOn, label: y.label, base: y.base, due: y.due,
                               paid: y.paid, note: y.note ?? '' }),
            build: (d, y) => ({
              yearId: y.id, label: d.label, base: Number(d.base), due: Number(d.due),
              note: d.note ?? '',
              // a computed year's payments are its giving records, and the ledger refuses
              // to have them typed over — so the figure only travels on a year typed in
              ...(y.manual ? { paid: Number(d.paid) } : {}),
            }),
          }}
          remove={{
            capability: 'zakat.year.remove',
            build: (y) => ({ yearId: y.id }),
            what: (y) => `the year to ${y.dueOn}`,
            blocked: (y) => (y.manual ? undefined
              : 'The lunar year behind this one has passed, so the ledger writes it down again as soon as the screen is read. Correct the figure instead.'),
          }}
          /* The arithmetic a year was struck on is a table of its own, so it waits to be
             asked for: shown under the row that was opened, and nowhere else. */
          detail={(y) => (openYear === y.id
            ? (
              <YearDetail year={y} dm={dm} causeName={causeName}
                          markOf={(id) => markFor(id, assetMarks, pile)} />
            )
            : null)}
          trailing={(y) => (
            <span style={{ display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'flex-end' }}>
              {y.remaining > 0
                ? (
                  <button className={`btn ${paying === y.id ? 'go' : 'quiet'} sm`}
                          aria-expanded={paying === y.id}
                          onClick={() => setPaying(paying === y.id ? null : y.id)}>
                    <Icon name="handout" size={12} motion="none" />
                    Record a payment
                  </button>
                )
                : <Chip tone="good">Discharged</Chip>}
              <button className="btn quiet sm" aria-expanded={openYear === y.id}
                      aria-label={`${y.label}, year to ${y.dueOn}`}
                      style={{ padding: '4px 6px', minWidth: 0 }}
                      onClick={() => setOpenYear(openYear === y.id ? null : y.id)}>
                <Icon name="chevron" size={12} motion="none"
                      style={{ transform: openYear === y.id ? 'rotate(-90deg)' : 'rotate(90deg)' }} />
              </button>
            </span>
          )}
          trailingWidth="210px"
        />

        {paying && (
          <div style={{
            marginTop: 16, padding: '16px 18px', borderRadius: 'var(--r-card)',
            background: 'var(--raised)', border: '1px solid var(--hairline)',
            display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end',
          }}>
            <Field label="Paid from">
              <Select ariaLabel="Source account" value={payAccount}
                      onChange={(val) => setPayment({ ...payment, accountId: val })}
                      /* the same option every other account picker draws — the bank over
                         the account, its mark beside them — with what it holds on the end,
                         since which account can cover the payment is the question here */
                      options={payFrom.map((n) => accountOption(data, n,
                        { currency: true, note: dm(balances[n.id] ?? 0) }))} />
            </Field>
            <Field label="Amount">
              <Amount value={payment.amount} ariaLabel="Zakat payment amount"
                      onChange={(n) => setPayment({ ...payment, amount: n })} style={{ width: 150 }} />
            </Field>
            <Field label="Went to">
              <Select ariaLabel="Cause" value={payment.causeId}
                      onChange={(val) => setPayment({ ...payment, causeId: val })}
                      options={data.categories.filter((c) => c.domain === 'charity')
                        .map((c) => ({ value: c.id, label: c.name,
                                       icon: c.icon, iconColor: c.color }))} />
            </Field>
            <ActionButton capability="giving.record" disabled={!(payment.amount > 0)}
              onDone={(o) => { if (o.ok) { setPaying(null); setPayment({ ...payment, amount: 0 }); } }}
              input={() => ({
                accountId: payAccount, amount: payment.amount, causeId: payment.causeId,
                isZakat: true, zakatYearId: paying,
              })}>
              Record it against this year
            </ActionButton>
            <button className="btn quiet" onClick={() => setPaying(null)}>Cancel</button>
          </div>
        )}

        <p style={{ margin: '14px 0 0', fontSize: 11, color: 'var(--faint)', lineHeight: 1.5 }}>
          A year closes itself the day the lunar year runs out, at the prices in force then, and
          the figure stops moving from that moment. Correct it here if something was missed —
          what it was worked out from is kept underneath either way.
        </p>
      </Panel>
      )}

      {/*
        * Every zakat payment, as its own log.
        *
        * They were reachable only by opening the year they discharged, which left a payment
        * booked against the wrong year — or against none — with nowhere to be seen at all.
        * This is the same table the giving screen draws, narrowed to zakat.
        */}
      {!manual && (
        <Panel title="Zakat records"
               hint="Everything paid as zakat, whichever year it discharges. Double-click a row to correct it, or to move it onto another year.">
          <GivingRecords only="zakat" fallback={[]} />
        </Panel>
      )}

      <Panel title="Which nisab to use"
             hint="The threshold below which no zakat is owed. Silver's is usually the lower of the two, and many scholars prefer it for that reason.">
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Segmented<'gold' | 'silver'>
            value={z.basis} ariaLabel="Nisab basis"
            onChange={(b) => setZakatSettings({ ...z, basis: b })}
            options={[
              { id: 'gold', label: `Gold · ${NISAB_GOLD_G} g`, icon: 'gold', tone: 'var(--gold)' },
              { id: 'silver', label: `Silver · ${NISAB_SILVER_G} g`, icon: 'coins', tone: 'var(--muted)' },
            ]} />
          {z.basis === 'silver' && (
            <Field label="Silver, per gram" hint="no feed carries this — enter what your dealer quotes">
              <Amount value={z.silverPerG} ariaLabel="Silver price per gram" onChange={(n) => setZakatSettings({ ...z, silverPerG: n })} style={{ width: 130 }} />
            </Field>
          )}
          <div style={{ marginLeft: 'auto' }}>
            <div className="ov">Threshold in force</div>
            <div className="mono" style={{ fontSize: 18, fontWeight: 500, marginTop: 4 }}>{dm(nisab)}</div>
          </div>
        </div>
      </Panel>

      <Panel title="Before you rely on this" style={{ borderColor: 'color-mix(in srgb, var(--gold) 30%, transparent)' }}>
        <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6, display: 'flex', flexDirection: 'column', gap: 9 }}>
          <div>This is a calculator, not a ruling. The treatments follow common positions, but scholars
            differ on several — how shares are valued, whether debts are deducted, which nisab applies.</div>
          <div>Counting everything under one date is itself a position. Scholars who run a separate lunar
            year for each kind of wealth would date some of this differently, and a holding bought
            recently would wait for its own year rather than joining this one.</div>
          <div>Which nisab applies is a choice, and it changes whether zakat is due at all. The silver
            measure is the lower of the two, so it catches wealth the gold measure would not.</div>
        </div>
      </Panel>
    </Page>
  );
}

/**
 * One confirmed year, opened up.
 *
 * The arithmetic is shown exactly as it was when the year was confirmed — not reworked from
 * what is held today, which would defeat the point of having written it down. The prices it
 * was struck at are shown beside it, because a figure nobody can check is a figure nobody
 * should be asked to trust three years later.
 */
function YearDetail({ year, dm, causeName, markOf }: {
  year: LoggedYear;
  dm: (n: number) => string;
  causeName: (id: string) => string;
  markOf: (id: string) => EntryMark | null;
}) {
  const { data, currencies } = useApp();
  const causes = data.categories.filter((c) => c.domain === 'charity');
  const payable = data.nodes.filter((n) => n.kind === 'cash' && !n.archived);
  const accountOnly = (id?: string | null) => data.nodes.find((n) => n.id === id)?.name ?? '—';
  /**
   * What a payment was, in its own currency.
   *
   * A ledger that predates these three fields answers with the converted figure and nothing
   * else, so the pounds it discharged the year by stand in for the amount and the currency.
   * A screen that read `undefined` there printed nothing at all where the payment should be.
   */
  const nativeAmount = (p: ZakatPayment) => p.amount ?? p.egp;
  const nativeCurrency = (p: ZakatPayment) => p.currency ?? 'EGP';

  return (
    <div style={{ padding: '16px 18px', background: 'var(--raised)' }}>
      <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', marginBottom: 14 }}>
        <div>
          <div className="ov">The lunar year</div>
          <div className="mono" style={{ fontSize: 13, marginTop: 3 }}>{year.startOn} → {year.dueOn}</div>
          <div style={{ fontSize: 11, color: 'var(--faint)' }}>closed {year.dueHijri}</div>
        </div>
        <div>
          <div className="ov">Threshold then in force</div>
          <div className="mono" style={{ fontSize: 13, marginTop: 3 }}>{dm(year.nisab)}</div>
          <div style={{ fontSize: 11, color: 'var(--faint)' }}>on the {year.basis} measure</div>
        </div>
        <div>
          <div className="ov">Prices it was struck at</div>
          <div className="mono" style={{ fontSize: 13, marginTop: 3 }}>
            {year.goldPerG ? `${dm(year.goldPerG)} / g gold` : 'gold not recorded'}
          </div>
          {year.silverPerG != null && year.silverPerG > 0 && (
            <div style={{ fontSize: 11, color: 'var(--faint)' }}>{dm(year.silverPerG)} / g silver</div>
          )}
        </div>
        <div>
          <div className="ov">Confirmed</div>
          <div className="mono" style={{ fontSize: 13, marginTop: 3 }}>{year.confirmedAt.slice(0, 10)}</div>
          {year.note && <div style={{ fontSize: 11, color: 'var(--faint)', maxWidth: 260 }}>{year.note}</div>}
        </div>
      </div>

      <table>
        <thead>
          <tr>
            <th style={{ width: 30 }}><span className="sr-only">Sign</span></th>
            <th>How it was worked out</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          {year.entries.length === 0
            ? <tr><td /><td colSpan={2} style={{ fontSize: 12, color: 'var(--faint)' }}>
                No lines were kept for this year.</td></tr>
            : year.entries.map((e) => <EntryRow key={e.id} entry={e} dm={dm} mark={markOf(e.id)} />)}
          <tr>
            <td />
            <td style={{ fontWeight: 600 }}>Zakatable, as confirmed</td>
            <td className="mono" style={{ fontWeight: 600 }}>{dm(year.base)}</td>
          </tr>
          <tr>
            <td />
            <td style={{ fontWeight: 600 }}>Zakat owed
              <span style={{ fontSize: 11, color: 'var(--faint)', fontWeight: 400 }}> · 2.5%</span></td>
            <td className="mono" style={{ fontWeight: 600, fontSize: 16,
                                          color: 'var(--positive)' }}>{dm(year.due)}</td>
          </tr>
        </tbody>
      </table>

      <div style={{ marginTop: 16 }}>
        <div className="ov" style={{ marginBottom: 8 }}>What was paid against it</div>
        {year.payments.length === 0 ? (
          <p style={{ margin: 0, fontSize: 12, color: 'var(--faint)' }}>
            Nothing yet. {dm(year.due)} is still owed for this year.
          </p>
        ) : (
          <>
            {/*
              * A payment against a year is a record like any other, so it is corrected and
              * removed like any other: the same table, the same gesture, the same two
              * capabilities the giving log uses. It used to be flat text, which made a
              * payment entered against the wrong year or for the wrong amount the one record
              * in the ledger that could only be fixed by finding it again somewhere else.
              *
              * The year it discharges is not offered as a field — this table *is* that year,
              * and `giving.correct` keeps whatever year a record already paid unless it is
              * told otherwise.
              */}
            <RecordTable<ZakatPayment>
              rows={year.payments}
              rowKey={(p) => p.id}
              sort={{ key: 'date', dir: 'desc' }}
              columns={[
                { key: 'date', label: 'Date', kind: 'date',
                  value: (p) => p.date,
                  cell: (p) => <span className="mono" style={{ fontSize: 13 }}>{p.date}</span>,
                  field: (d, set) => <DateField value={String(d.date ?? '')} ariaLabel="Date" hijri
                                                onChange={(v) => set({ date: v })} /> },
                { key: 'amount', label: 'Amount', kind: 'money',
                  value: (p) => p.egp,
                  cell: (p) => (
                    <RecordAmount amount={nativeAmount(p)} currency={nativeCurrency(p)}
                                  accountId={p.accountId} />
                  ),
                  field: (d, set) => (
                    <span className="field-money">
                      <Amount value={Number(d.amount ?? 0)} ariaLabel="Amount"
                              onChange={(n) => set({ amount: n })} />
                      <Select ariaLabel="Currency" value={String(d.currency ?? 'EGP')} style={{ width: 88 }}
                              onChange={(v) => set({ currency: v })}
                              options={currencies.map((c) => ({ value: c.code, label: c.code }))} />
                    </span>
                  ) },
                { key: 'from', label: 'Paid from', kind: 'pick',
                  value: (p) => accountOnly(p.accountId),
                  cell: (p) => (
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                      <AccountLine id={p.accountId} />
                    </span>
                  ),
                  field: (d, set) => (
                    <Select ariaLabel="Paid from" value={String(d.accountId ?? '')}
                            onChange={(v) => set({ accountId: v })}
                            options={payable.map((n) => accountOption(data, n, { currency: true }))} />
                  ) },
                { key: 'to', label: 'Went to', kind: 'pick',
                  value: (p) => causeName(p.causeId),
                  cell: (p) => <span style={{ fontSize: 13 }}>{causeName(p.causeId)}</span>,
                  field: (d, set) => (
                    <Select ariaLabel="Went to" value={String(d.causeId ?? '')}
                            onChange={(v) => set({ causeId: v })}
                            options={causes.map((c) => ({ value: c.id, label: c.name,
                                                         icon: c.icon, iconColor: c.color }))} />
                  ) },
                { key: 'note', label: 'Note', kind: 'text',
                  value: (p) => p.note ?? '',
                  cell: (p) => <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                    {p.note || <span style={{ color: 'var(--faint)' }}>—</span>}</span>,
                  field: (d, set) => <input aria-label="Note" placeholder="what it was for"
                                            value={String(d.note ?? '')}
                                            onChange={(e) => set({ note: e.target.value })} /> },
              ]}
              edit={{
                capability: 'giving.correct',
                draftOf: (p) => ({ date: p.date, amount: nativeAmount(p), currency: nativeCurrency(p),
                                   accountId: p.accountId ?? '', causeId: p.causeId, note: p.note ?? '' }),
                build: (d, p) => ({ givingId: p.id, accountId: d.accountId || undefined,
                                    amount: Number(d.amount), currency: d.currency,
                                    causeId: d.causeId, isZakat: true,
                                    date: d.date, note: d.note ?? '' }),
              }}
              remove={{
                capability: 'giving.remove',
                build: (p) => ({ givingId: p.id }),
                keep: { label: 'Just remove the record',
                        build: (p) => ({ givingId: p.id, reverse: false }) },
                what: (p) => `the payment of ${dm(p.egp)} on ${p.date}`,
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12,
                          marginTop: 10, fontWeight: 600, fontSize: 13 }}>
              <span>{year.remaining > 0 ? 'Still to pay' : 'Discharged in full'}</span>
              <span className="mono" style={{ color: year.remaining > 0 ? 'var(--negative)' : 'var(--positive)' }}>
                {dm(year.remaining)}
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * One line of the list, with everything behind it underneath.
 *
 * A year being worked out now and a year confirmed three years ago are the same list, and have
 * to look it — an owner comparing this year against the last should be reading one format, not
 * two. So the row is written once and the tables around it differ.
 *
 * The detail sits under the label rather than in columns of its own because there is no fixed
 * set of it: a flat has three dates behind it, a card balance has one, and cash has none.
 */
function EntryRow({ entry: e, dm, edit, mark, say }: {
  entry: Entry;
  dm: (n: number) => string;
  /** typed figures are the owner's own, so the amount is theirs to change */
  edit?: (n: number) => void;
  /** the icon behind a line that stands for a thing owned — absent for cash, debt and the like */
  mark?: EntryMark | null;
  /**
   * What the owner can say about this line, where the ledger is running.
   *
   * A figure of their own instead of the one worked out, the line taken out of the reckoning,
   * or — on a line they wrote themselves — taken off the list. The controls appear when the
   * row is pointed at, the way a record's pencil does, so a list of forty lines is not a list
   * of forty buttons.
   */
  say?: {
    onAmount: (n: number) => void;
    onRemove: () => void;
    onRestore: () => void;
    typed: boolean;
    overridden: boolean;
  };
}) {
  const [saying, setSaying] = useState(false);
  const [hover, setHover] = useState(false);
  const [figure, setFigure] = useState(e.amount);
  return (
    <tr onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <td className="mono" style={{
        fontSize: 15, fontWeight: 600, textAlign: 'center', verticalAlign: 'top',
        color: e.sign === -1 ? 'var(--negative)' : e.sign === 1 ? 'var(--positive)' : 'var(--faint)',
      }}>{e.sign === 1 ? '+' : e.sign === -1 ? '−' : '·'}</td>
      <td>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {mark && (
            <span aria-hidden="true" style={{
              width: 24, height: 24, borderRadius: 7, flex: '0 0 24px',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: `color-mix(in srgb, ${mark.color} 15%, transparent)`,
            }}>
              <Mark mark={mark.icon} size={13} color={mark.color} fallback={mark.fallback} />
            </span>
          )}
          <div style={{ fontWeight: 500, color: e.sign === 0 ? 'var(--muted)' : undefined }}>{e.label}</div>
        </div>
        {e.detail && <div style={{ fontSize: 11, color: 'var(--faint)' }}>{e.detail}</div>}
        {e.facts && e.facts.length > 0 && (
          <div className="mono" style={{ fontSize: 11, color: 'var(--faint)', marginTop: 3 }}>
            {e.facts.map((f) => `${f.label} ${f.value}`).join(' · ')}
          </div>
        )}
        {e.note && (
          <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 3, maxWidth: 520, lineHeight: 1.5 }}>
            {e.note}
          </div>
        )}
        {/* What the ledger says, under a figure that is not the ledger's. It is kept rather
            than replaced, so the correction can always be read against what it corrected. */}
        {e.overridden && e.computed != null && (
          <div style={{ fontSize: 11, color: 'var(--gold)', marginTop: 3 }}>
            yours · the ledger works it out as {dm(e.computed)}
          </div>
        )}
        {say && (hover || saying) && (
          <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
            {saying ? (
              <>
                <Amount value={figure} ariaLabel={`${e.label} as you state it`}
                        onChange={setFigure} style={{ width: 150 }} />
                <button className="btn go sm" onClick={() => { say.onAmount(figure); setSaying(false); }}>
                  <Icon name="check" size={12} motion="none" /> Save
                </button>
                <button className="btn ghost sm" onClick={() => { setFigure(e.amount); setSaying(false); }}>
                  <Icon name="close" size={12} motion="none" /> Cancel
                </button>
              </>
            ) : (
              <>
                <button className="btn quiet sm" onClick={() => { setFigure(e.amount); setSaying(true); }}>
                  <Icon name="edit" size={12} motion="none" /> State it yourself
                </button>
                {(say.overridden || say.typed) && (
                  <button className="btn quiet sm" onClick={say.onRestore}>
                    <Icon name="undo" size={12} motion="none" />
                    {say.typed ? 'Remove' : 'Back to the ledger\'s'}
                  </button>
                )}
                {!say.typed && (
                  <button className="btn quiet sm" onClick={say.onRemove}>
                    <Icon name="close" size={12} motion="none" /> Leave it out
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </td>
      {/* A line counting nothing is bracketed rather than hidden: its value is worth seeing,
          and the brackets say it was left out on purpose. */}
      <td className="mono" style={{
        verticalAlign: 'top',
        color: e.sign === -1 ? 'var(--negative)' : e.sign === 0 ? 'var(--faint)' : undefined,
      }}>
        {edit
          ? <Amount value={e.amount} ariaLabel={`${e.label} value`} onChange={edit}
                    style={{ width: 150 }} />
          : e.sign === 0 ? `(${dm(e.amount)})` : `${e.sign === -1 ? '−' : ''}${dm(e.amount)}`}
      </td>
    </tr>
  );
}
