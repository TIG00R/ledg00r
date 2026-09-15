import { Fragment, useEffect, useState } from 'react';
import { Amount } from '../components/Amount';
import { Select } from '../components/Select';
import { useApp, market } from '../AppState';
import { describeLead, zakatDebts, zakatDates, nisabEgp, formatHijri, groupOf,
         ZAKAT_RATE, HIJRI_MONTHS, NISAB_GOLD_G, NISAB_SILVER_G,
         type ZakatEntry, type EntryGroup } from '@ledger/engine';
import { Page, Panel, Stat, Stats, Chip, Toggle, Row, Field } from '../components/UI';
import { Segmented } from '../components/Segmented';
import { Icon } from '../components/Icon';
import { useLive, ActionButton } from '../Live';
import { ledger } from '../api';

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
  startOn: string; dueOn: string; dueHijri: string; anchorOn: string | null;
  base: number; due: number; paid: number; remaining: number;
  nisab: number; basis: string; confirmedAt: string; note: string | null;
  goldPerG: number | null; silverPerG: number | null;
  entries: Entry[];
  payments: Array<{ id: string; date: string; egp: number; causeId: string; note: string | null }>;
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
  const { run, live, version } = useLive();
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

  const [paying, setPaying] = useState<string | null>(null);
  const [payment, setPayment] = useState({
    accountId: '',
    amount: 0,
    causeId: data.categories.find((c) => c.domain === 'charity')?.id ?? '',
  });
  const payAccount = payment.accountId || payFrom[0]?.id || '';

  const rem = reminders.find((r) => r.subject === 'zakat');
  const update = (patch: Partial<(typeof reminders)[number]>) =>
    setReminders(reminders.map((r) => (r.subject === 'zakat' ? { ...r, ...patch } : r)));

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
              <th style={{ textAlign: 'right' }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {SECTIONS.map((s) => {
              const rows = sectionOf(s.group);
              if (rows.length === 0) return null;
              const sum = s.group === 'debt'
                ? rows.reduce((t, e) => t + e.amount, 0)
                : rows.reduce((t, e) => t + e.sign * e.amount, 0);
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
                    <EntryRow key={e.id} entry={e} dm={dm}
                      edit={editable && e.group === 'counted'
                        ? (n) => setManualValues({ ...manualValues, [e.id]: n })
                        : undefined} />
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
              <td className="mono" style={{ fontWeight: 600, textAlign: 'right', paddingTop: 16 }}>{dm(assets)}</td>
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
                <td className="mono" style={{ textAlign: 'right', fontWeight: 600,
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
              <td className="mono" style={{ fontWeight: 600, textAlign: 'right' }}>{dm(finalBase)}</td>
            </tr>
            <tr>
              <td />
              <td style={{ fontWeight: 600 }}>Zakat owed
                <span style={{ fontSize: 11, color: 'var(--faint)', fontWeight: 400 }}> · 2.5%</span></td>
              <td className="mono" style={{ fontWeight: 600, textAlign: 'right', fontSize: 18,
                                            color: due > 0 ? 'var(--positive)' : 'var(--faint)' }}>{dm(due)}</td>
            </tr>
          </tbody>
        </table>

        {estate?.state === 'draft' && (
          <div style={{
            display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap',
            marginTop: 16, padding: '14px 16px', borderRadius: 'var(--r-card)',
            background: 'color-mix(in srgb, var(--zakat) 6%, transparent)',
            border: '1px solid color-mix(in srgb, var(--zakat) 30%, transparent)',
          }}>
            <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, flex: 1, minWidth: 220 }}>
              The year to <strong>{estate.closedOn}</strong> has closed. Confirming writes this figure down
              so it stops moving with the market. Change it first if something was missed — the difference
              is recorded as a line of its own rather than replacing the arithmetic.
            </div>
            <Field label="Base to confirm">
              <Amount value={correction ?? Math.round(estate.base)} ariaLabel="Base to confirm"
                      onChange={setCorrection} style={{ width: 170, textAlign: 'right' }} />
            </Field>
            <ActionButton capability="zakat.confirm"
              input={() => ({ bucketId: estate.id, base: correction ?? Math.round(estate.base) })}>
              Confirm this year
            </ActionButton>
          </div>
        )}
      </Panel>

      {!manual && years.length > 0 && (
      <Panel title="Every year you have confirmed"
             hint="The record of past years. Each one keeps the lines it was worked out from and the prices in force the day it closed, so a figure from three years ago can be read back rather than merely remembered.">
        <table>
          <thead>
            <tr><th style={{ width: 28 }}><span className="sr-only">Open</span></th>
                <th>Pot</th><th>Year to</th><th style={{ textAlign: 'right' }}>Owed</th>
                <th style={{ textAlign: 'right' }}>Paid</th>
                <th style={{ textAlign: 'right' }}>Still to pay</th><th /></tr>
          </thead>
          <tbody>
            {years.map((year) => {
              const open = openYear === year.id;
              return (
                <Fragment key={year.id}>
                  <tr>
                    <td>
                      <button className="btn-quiet" aria-expanded={open}
                              aria-label={`${year.label}, year to ${year.dueOn}`}
                              style={{ padding: '2px 7px', minWidth: 0 }}
                              onClick={() => setOpenYear(open ? null : year.id)}>
                        {open ? '−' : '+'}
                      </button>
                    </td>
                    <td style={{ fontWeight: 500 }}>{year.label}</td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {year.dueOn}
                      <div style={{ fontSize: 11, color: 'var(--faint)' }}>{year.dueHijri}</div>
                    </td>
                    <td className="mono" style={{ textAlign: 'right' }}>{dm(year.due)}</td>
                    <td className="mono" style={{ textAlign: 'right' }}>{dm(year.paid)}</td>
                    <td className="mono" style={{ textAlign: 'right', fontWeight: 600,
                                                  color: year.remaining > 0 ? 'var(--negative)' : 'var(--positive)' }}>
                      {dm(year.remaining)}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {year.remaining > 0
                        ? <button className="btn-quiet" onClick={() => setPaying(year.id)}>Record a payment</button>
                        : <Chip tone="good">Discharged</Chip>}
                    </td>
                  </tr>
                  {open && (
                    <tr>
                      <td colSpan={7} style={{ padding: 0 }}>
                        <YearDetail year={year} dm={dm} causeName={causeName} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            <tr>
              <td />
              <td colSpan={2} style={{ fontWeight: 600 }}>Across every year</td>
              <td className="mono" style={{ textAlign: 'right', fontWeight: 600 }}>
                {dm(years.reduce((t2, y) => t2 + y.due, 0))}
              </td>
              <td className="mono" style={{ textAlign: 'right', fontWeight: 600 }}>
                {dm(years.reduce((t2, y) => t2 + y.paid, 0))}
              </td>
              <td className="mono" style={{ textAlign: 'right', fontWeight: 600,
                                            color: years.some((y) => y.remaining > 0) ? 'var(--negative)' : 'var(--positive)' }}>
                {dm(years.reduce((t2, y) => t2 + y.remaining, 0))}
              </td>
              <td />
            </tr>
          </tbody>
        </table>

        {paying && (
          <div style={{
            marginTop: 16, padding: '16px 18px', borderRadius: 'var(--r-card)',
            background: 'var(--raised)', border: '1px solid var(--hairline)',
            display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end',
          }}>
            <Field label="Paid from">
              <Select ariaLabel="Source account" value={payAccount}
                      onChange={(val) => setPayment({ ...payment, accountId: val })}
                      options={payFrom.map((n) => ({
                        value: n.id, label: n.name, hint: dm(balances[n.id] ?? 0),
                      }))} />
            </Field>
            <Field label="Amount">
              <Amount value={payment.amount} ariaLabel="Zakat payment amount"
                      onChange={(n) => setPayment({ ...payment, amount: n })} style={{ width: 150 }} />
            </Field>
            <Field label="Went to">
              <Select ariaLabel="Cause" value={payment.causeId}
                      onChange={(val) => setPayment({ ...payment, causeId: val })}
                      options={data.categories.filter((c) => c.domain === 'charity')
                        .map((c) => ({ value: c.id, label: c.name }))} />
            </Field>
            <ActionButton capability="giving.record" disabled={!(payment.amount > 0)}
              onDone={(o) => { if (o.ok) { setPaying(null); setPayment({ ...payment, amount: 0 }); } }}
              input={() => ({
                accountId: payAccount, amount: payment.amount, causeId: payment.causeId,
                isZakat: true, zakatYearId: paying,
              })}>
              Record it against this year
            </ActionButton>
            <button className="btn-quiet" onClick={() => setPaying(null)}>Cancel</button>
          </div>
        )}

        <p style={{ margin: '14px 0 0', fontSize: 11, color: 'var(--faint)', lineHeight: 1.5 }}>
          A confirmed figure does not move. If something was wrong with it, reopen the year — the payments
          stay on the record but stop discharging it, and the figure is worked out again.
        </p>
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
function YearDetail({ year, dm, causeName }: {
  year: LoggedYear;
  dm: (n: number) => string;
  causeName: (id: string) => string;
}) {
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
            <th style={{ textAlign: 'right' }}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {year.entries.length === 0
            ? <tr><td /><td colSpan={2} style={{ fontSize: 12, color: 'var(--faint)' }}>
                No lines were kept for this year.</td></tr>
            : year.entries.map((e) => <EntryRow key={e.id} entry={e} dm={dm} />)}
          <tr>
            <td />
            <td style={{ fontWeight: 600 }}>Zakatable, as confirmed</td>
            <td className="mono" style={{ fontWeight: 600, textAlign: 'right' }}>{dm(year.base)}</td>
          </tr>
          <tr>
            <td />
            <td style={{ fontWeight: 600 }}>Zakat owed
              <span style={{ fontSize: 11, color: 'var(--faint)', fontWeight: 400 }}> · 2.5%</span></td>
            <td className="mono" style={{ fontWeight: 600, textAlign: 'right', fontSize: 16,
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
          <table>
            <thead><tr><th>Date</th><th>Went to</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
            <tbody>
              {year.payments.map((p) => (
                <tr key={p.id}>
                  <td className="mono" style={{ fontSize: 12 }}>{p.date}</td>
                  <td>
                    <div style={{ fontSize: 13 }}>{causeName(p.causeId)}</div>
                    {p.note && <div style={{ fontSize: 11, color: 'var(--faint)' }}>{p.note}</div>}
                  </td>
                  <td className="mono" style={{ textAlign: 'right' }}>{dm(p.egp)}</td>
                </tr>
              ))}
              <tr>
                <td colSpan={2} style={{ fontWeight: 600 }}>
                  {year.remaining > 0 ? 'Still to pay' : 'Discharged in full'}
                </td>
                <td className="mono" style={{ fontWeight: 600, textAlign: 'right',
                                              color: year.remaining > 0 ? 'var(--negative)' : 'var(--positive)' }}>
                  {dm(year.remaining)}
                </td>
              </tr>
            </tbody>
          </table>
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
function EntryRow({ entry: e, dm, edit }: {
  entry: Entry;
  dm: (n: number) => string;
  /** typed figures are the owner's own, so the amount is theirs to change */
  edit?: (n: number) => void;
}) {
  return (
    <tr>
      <td className="mono" style={{
        fontSize: 15, fontWeight: 600, textAlign: 'center', verticalAlign: 'top',
        color: e.sign === -1 ? 'var(--negative)' : e.sign === 1 ? 'var(--positive)' : 'var(--faint)',
      }}>{e.sign === 1 ? '+' : e.sign === -1 ? '−' : '·'}</td>
      <td>
        <div style={{ fontWeight: 500, color: e.sign === 0 ? 'var(--muted)' : undefined }}>{e.label}</div>
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
      </td>
      {/* A line counting nothing is bracketed rather than hidden: its value is worth seeing,
          and the brackets say it was left out on purpose. */}
      <td className="mono" style={{
        textAlign: 'right', verticalAlign: 'top',
        color: e.sign === -1 ? 'var(--negative)' : e.sign === 0 ? 'var(--faint)' : undefined,
      }}>
        {edit
          ? <Amount value={e.amount} ariaLabel={`${e.label} value`} onChange={edit}
                    style={{ width: 150, textAlign: 'right' }} />
          : e.sign === 0 ? `(${dm(e.amount)})` : `${e.sign === -1 ? '−' : ''}${dm(e.amount)}`}
      </td>
    </tr>
  );
}
