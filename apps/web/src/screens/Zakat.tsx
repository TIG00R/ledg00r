import { Fragment, useEffect, useState } from 'react';
import { Amount } from '../components/Amount';
import { Select } from '../components/Select';
import { useApp, market } from '../AppState';
import { money, describeLead, zakatDebts, zakatDates, nisabEgp, formatHijri,
         HIJRI_MONTHS, NISAB_GOLD_G, NISAB_SILVER_G } from '@ledger/engine';
import { Page, Panel, Stat, Stats, Chip, Toggle, Row, Field, Empty } from '../components/UI';
import { HawlBar } from '../components/Intention';
import { DateText } from '../components/DateText';
import { Segmented } from '../components/Segmented';
import { Icon } from '../components/Icon';
import { useLive, ActionButton } from '../Live';
import { ledger } from '../api';

/** one line of the arithmetic, with the sign that says which way it goes */
interface Entry {
  id: string; label: string; detail?: string;
  sign: 1 | -1 | 0; amount: number; note?: string;
}

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

/** one pot of wealth, with its own lunar year */
interface Bucket {
  id: string; label: string; kind: 'cash' | 'metal' | 'trade' | 'rent';
  anchorOn: string | null; closedOn: string | null;
  state: 'running' | 'draft' | 'confirmed';
  base: number; due: number; aboveNisab: boolean;
  entries: Entry[];
  hawl: BucketHawl | null;
  confirmed: ConfirmedYear | null;
}

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
   * Every year ever confirmed, from the ledger rather than from the pots.
   *
   * The pots only know the year that closed most recently, so reading the log off them would
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

  /**
   * One line per thing owned, from the ledger.
   *
   * Which of them counts is not a property of the screen: it turns on what each thing is held
   * for and on the dates that follow from that, both of which live with the asset. So the
   * screen shows the answer and the reason for it rather than working either out.
   */
  const assetLines: Array<{
    id: string; name: string; kind: string; intention: string | null; intentionLabel: string;
    basis: 'value' | 'rent' | 'none'; value: number; counted: number; included: boolean;
    heldBack: number; aboveNisab: boolean; anchorOn: string | null; reason: string;
    dates: { acquiredOn: string | null; intentionSince: string | null; nisabMetOn: string | null };
    hawl: null | { startOn: string; startHijriText: string; dueOn: string; dueHijriText: string;
                   yearsComplete: number; complete: boolean; daysRemaining: number; elapsedPct: number };
  }> = manual ? [] : (assessment?.assets ?? []);

  /**
   * The pots of wealth, each with its own lunar year.
   *
   * Empty when the figures are the owner's own — money somebody typed belongs to no pot — and
   * empty behind the fixtures, where there is no ledger to sort. Both cases fall back to the
   * running-total ladder below, which needs nothing but the totals.
   */
  const buckets: Bucket[] = manual ? [] : (assessment?.buckets ?? []);
  const totals: {
    base: number; due: number; paid: number; remaining: number;
    estimatedBase: number; estimatedDue: number; drafts: number;
  } | null = manual ? null : (assessment?.totals ?? null);
  const [correction, setCorrection] = useState<Record<string, number>>({});

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

  const heldBack: number = manual ? 0 : (assessment?.heldBack ?? 0);
  /**
   * Only what is charged on its own value is added.
   *
   * Rent is not, and must not be: it landed in an account, so the cash figure has counted it
   * once already. What the rent rule changes is the other direction — rent still inside its
   * lunar year is taken back out.
   */
  const countedFromAssets = assetLines
    .filter((l) => l.basis === 'value').reduce((s, l) => s + l.counted, 0);
  const countedRent: number = manual ? 0 : (assessment?.countedRent ?? 0);

  /** money, which is zakatable for being money — no intention and no waiting */
  const moneyLines = manual
    ? [
        { id: 'cash', label: 'Cash', detail: 'whatever you hold, in one figure',
          value: manualValues.cash ?? 0, treatment: 'Fully zakatable' },
        { id: 'gold', label: 'Gold and silver', detail: 'valued at whatever you judge it worth',
          value: manualValues.gold ?? 0, treatment: 'A holding — fully zakatable' },
        { id: 'stocks', label: 'Shares and funds', detail: 'market value on the day',
          value: manualValues.stocks ?? 0, treatment: 'Actively traded — full value' },
      ]
    : [
        { id: 'cash', label: 'Cash', detail: 'every account, converted at today\'s rates',
          value: assessment?.cash ?? v.cash, treatment: 'Fully zakatable' },
        { id: 'stocks', label: 'Shares and funds', detail: 'the book, at the prices last recorded',
          value: assessment?.stocks ?? v.stocks, treatment: 'Actively traded — full value' },
      ];

  const included = moneyLines;
  const base = moneyLines.reduce((s, x) => s + x.value, 0) - heldBack + countedFromAssets;

  // What is owed inside this hawl, taken from the plans themselves rather than a figure
  // typed once and left to rot.
  /**
   * The assessment, from the ledger.
   *
   * It has to be worked out there rather than here: the base now depends on what accounts
   * actually hold and on money lent out, neither of which the fixture knows about.
   */
  const debtRows: Array<{ id: string; label: string; amountEgp: number; date: string; kind?: string }> =
    assessment?.debts ?? zakatDebts(data, now, z);
  const debts = debtRows.reduce((s, x) => s + x.amountEgp, 0);
  const receivables: Array<{ id: string; label: string; amountEgp: number; due: string | null }> =
    assessment?.receivables ?? [];
  const owedToYou = assessment?.owedToYou ?? 0;
  /**
   * The ledger's answer wins.
   *
   * It knows what the accounts actually hold and what is owed to you; the local figure is
   * worked from the fixture and cannot. Keeping the screen on its own arithmetic would mean
   * showing a number the API disagrees with, which is worse than showing nothing.
   */
  const baseBefore = assessment?.baseBeforeDebts ?? base;
  const finalBase = assessment ? assessment.base : Math.max(0, deductDebts ? base - debts : base);
  const due = assessment ? assessment.due : finalBase * 0.025;

  const rem = reminders.find((r) => r.subject === 'zakat');
  const update = (patch: Partial<(typeof reminders)[number]>) =>
    setReminders(reminders.map((r) => (r.subject === 'zakat' ? { ...r, ...patch } : r)));

  const dates = zakatDates(now, z);
  const away = dates.daysAway;
  const hawlDays = Math.max(1, Math.round((dates.due.getTime() - dates.start.getTime()) / 86_400_000));
  const elapsed = Math.min(100, Math.max(0, ((hawlDays - away) / hawlDays) * 100));

  return (
    <Page>
      <Panel>
        <div style={{ display: 'flex', gap: 14, marginBottom: 22, flexWrap: 'wrap', alignItems: 'center' }}>
          <Segmented<'assets' | 'manual'>
            value={manual ? 'manual' : 'assets'} ariaLabel="How to work zakat out"
            onChange={(v) => {
              if (v === 'manual') { setManual(true); setManualValues({ cash: 0, gold: 0, stocks: 0 }); }
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
            <Select ariaLabel="Zakat lead unit" value={rem?.offsetUnit ?? 'months'} onChange={(v) => update({ offsetUnit: v as 'days' | 'months' })}
                    options={[{ value: 'days', label: 'days before' }, { value: 'months', label: 'months before' }]} />
          </div>
          <span style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Toggle on={rem?.enabled ?? false} onChange={(val) => update({ enabled: val })} label="Zakat reminder" />
          </span>
        </Row>

        {buckets.length > 0 && (
          <div style={{ marginTop: 18 }}>
            <div className="ov" style={{ marginBottom: 10 }}>A date for each kind of wealth</div>
            <table>
              <thead>
                <tr><th>Pot</th><th>Passed nisab</th><th>Year closes</th>
                    <th style={{ textAlign: 'right' }}>Where it stands</th></tr>
              </thead>
              <tbody>
                {buckets.map((b) => (
                  <tr key={b.id}>
                    <td style={{ fontWeight: 500 }}>{b.label}</td>
                    <td className="mono" style={{ fontSize: 12, color: 'var(--faint)' }}>
                      {b.id === 'cash' ? 'the anniversary above' : b.anchorOn ?? 'not reached'}
                    </td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {b.hawl
                        ? <>{b.hawl.dueHijriText}
                            <span style={{ color: 'var(--faint)' }}> · {b.hawl.daysRemaining} days</span></>
                        : <span style={{ color: 'var(--faint)' }}>no year running</span>}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {b.state === 'confirmed' ? <Chip tone="good">Confirmed</Chip>
                        : b.state === 'draft' ? <Chip tone="warn">Waiting on you</Chip>
                          : <Chip>Running</Chip>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p style={{ margin: '14px 0 0', fontSize: 11, color: 'var(--faint)', lineHeight: 1.5 }}>
          Wealth of the same kind shares one lunar year. Cash you earn during the year joins the cash
          hawl rather than starting its own, and gold added to gold you already hold joins the gold hawl.
          So each kind of wealth carries one date, not one per purchase. Scholars who count each holding
          separately would read some of these dates differently.
        </p>
        <p style={{ margin: '8px 0 0', fontSize: 11, color: 'var(--faint)', lineHeight: 1.5 }}>
          Hijri dates here are tabular — arithmetic, not moon sighting — so they can differ by a day
          from what your local authority announces.
        </p>
      </Panel>

      {!manual && buckets.length > 0 && (
      <Panel title="How the base is built"
             hint="One list per pot of wealth, read straight down: what adds, what comes off, and what is shown for nothing. Each pot carries its own lunar year, so each has its own total and its own date.">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
          {buckets.map((b) => (
            <BucketTable key={b.id} bucket={b} dm={dm}
              correction={correction[b.id]}
              onCorrection={(n) => setCorrection({ ...correction, [b.id]: n })} />
          ))}
        </div>
        {totals && (
          <div style={{
            marginTop: 20, padding: '16px 18px', borderRadius: 'var(--r-card)',
            background: 'color-mix(in srgb, var(--zakat) var(--tint), transparent)',
            border: '1px solid color-mix(in srgb, var(--zakat) 30%, transparent)',
            display: 'flex', gap: 34, flexWrap: 'wrap', alignItems: 'baseline',
          }}>
            <div>
              <div className="ov">Owed, across every confirmed year</div>
              <div className="mono" style={{ fontSize: 24, fontWeight: 600, marginTop: 4 }}>{dm(totals.due)}</div>
            </div>
            <div>
              <div className="ov">Still to pay</div>
              <div className="mono" style={{ fontSize: 18, fontWeight: 500, marginTop: 4,
                                             color: totals.remaining > 0 ? 'var(--negative)' : 'var(--positive)' }}>
                {dm(totals.remaining)}
              </div>
            </div>
            <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
              <div className="ov">If every year closed today</div>
              <div className="mono" style={{ fontSize: 18, fontWeight: 500, marginTop: 4, color: 'var(--muted)' }}>
                {dm(totals.estimatedDue)}
              </div>
              <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 2 }}>an estimate, and it moves daily</div>
            </div>
          </div>
        )}
      </Panel>
      )}

      {!manual && buckets.length === 0 && (
      <Panel title="How the base is built"
             hint="Money first, because money needs no reason. Then each thing owned, which counts only if what it is held for, the threshold and the lunar year all say so.">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Step label="Money you hold" detail="cash in every account, plus the share book"
                running={dm(moneyLines.reduce((s2, x) => s2 + x.value, 0))} strong />
          {heldBack > 0 && (
            <Step label="Rent not yet through a lunar year" minus amount={`−${dm(heldBack)}`}
                  detail="it landed in an account, so cash counted it — and it is not owed on yet"
                  running={dm(moneyLines.reduce((s2, x) => s2 + x.value, 0) - heldBack)} />
          )}
          {assetLines.filter((l) => l.counted > 0 && l.basis === 'value').map((l, i, all) => (
            <Step key={l.id} label={l.name} detail={`${l.intentionLabel} · ${l.basis === 'rent' ? 'the rent it earned' : 'its whole value'}`}
                  amount={`+${dm(l.counted)}`}
                  running={dm(moneyLines.reduce((s2, x) => s2 + x.value, 0) - heldBack
                    + all.slice(0, i + 1).reduce((s2, y) => s2 + y.counted, 0))} />
          ))}
          {countedRent > 0 && (
            <Step label="Rent that has carried a lunar year" detail="already inside cash — counted once, not twice"
                  amount={`${dm(countedRent)} of it`}
                  running={dm(moneyLines.reduce((s2, x) => s2 + x.value, 0) - heldBack + countedFromAssets)} />
          )}
          {owedToYou > 0 && (
            <Step label="Owed to you" detail="wealth you happen not to be holding"
                  amount={`+${dm(owedToYou)}`} running={dm(baseBefore)} />
          )}
          <Step label="Zakatable base" detail={`charged at 2.5% · ${dm(finalBase)} after debts`}
                running={dm(finalBase)} accent />
        </div>
        {assetLines.some((l) => !l.included) && (
          <p style={{ margin: '16px 0 0', fontSize: 12, color: 'var(--faint)', lineHeight: 1.55 }}>
            {assetLines.filter((l) => !l.included).length === 1
              ? '1 thing owned counts nothing'
              : `${assetLines.filter((l) => !l.included).length} things owned count nothing`} —
            a home, something driven, jewellery worn, or a lunar year that has not closed yet.
            The table below says which, for each.
          </p>
        )}
      </Panel>
      )}

      <Panel title="What counts"
             hint="Money counts for being money. Everything else counts only when four things agree: what it is, what it is held for, that the amount passed nisab, and that a full lunar year has run since it did.">
        <table>
          <thead><tr><th>Asset</th><th>Treatment</th>
                     <th>From the system</th></tr></thead>
          <tbody>
            {included.map((x) => (
              <tr key={x.id}>
                <td>
                  <div style={{ fontWeight: 500 }}>{x.label}</div>
                  <div style={{ fontSize: 11, color: 'var(--faint)' }}>{x.detail}</div>
                </td>
                <td><Chip tone="good">{x.treatment}</Chip></td>
                <td>
                  {manual ? (
                    <Amount value={manualValues[x.id] ?? 0} ariaLabel={`${x.label} value`}
                           onChange={(n) => setManualValues({ ...manualValues, [x.id]: n })}
                           style={{ width: 150, textAlign: 'right' }} />
                  ) : (
                    <span className="mono" style={{ fontWeight: 500 }}>{dm(x.value)}</span>
                  )}
                </td>
              </tr>
            ))}
            {heldBack > 0 && (
              <tr>
                <td>
                  <div style={{ fontWeight: 500 }}>Rent still inside its lunar year</div>
                  <div style={{ fontSize: 11, color: 'var(--faint)' }}>
                    taken back out of cash, so it is not charged a year early
                  </div>
                </td>
                <td><Chip>Held back</Chip></td>
                <td className="mono" style={{ color: 'var(--negative)' }}>−{dm(heldBack)}</td>
              </tr>
            )}
          </tbody>
        </table>
      </Panel>

      {!manual && (
      <Panel title="Everything you own, one at a time"
             hint="Each line says what it is held for, the dates the lunar year is measured from, and what it therefore counts. Intention is changed on the asset itself, under Assets → Intention and zakat.">
        {assetLines.length === 0 ? (
          <p style={{ margin: 0, fontSize: 13, color: 'var(--faint)', lineHeight: 1.6 }}>
            {live
              ? 'Nothing owned beyond money. A property, a vehicle or metal would be judged here.'
              : 'This needs the ledger service — intention and its dates live with the asset, not in the fixtures the screens fall back on.'}
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {assetLines.map((l) => (
              <div key={l.id} style={{
                display: 'grid', gap: 16, padding: '16px 18px', borderRadius: 'var(--r-card)',
                gridTemplateColumns: 'minmax(0,1.3fr) minmax(0,1fr) minmax(0,1.1fr) 140px',
                alignItems: 'start',
                background: l.included ? 'color-mix(in srgb, var(--zakat) 7%, transparent)' : 'var(--surface)',
                border: `1px solid ${l.included ? 'color-mix(in srgb, var(--zakat) 30%, transparent)' : 'var(--hairline)'}`,
              }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 14, fontWeight: 600 }}>{l.name}</span>
                    <Chip>{l.intentionLabel}</Chip>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--faint)', lineHeight: 1.5, marginTop: 6 }}>
                    {l.reason}
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <span className="ov">The dates it turns on</span>
                  <DateText value={l.dates.acquiredOn} size={12} prefix="acquired" empty="no purchase date" />
                  <DateText value={l.dates.intentionSince} size={12} prefix="held so since" empty="intention undated" />
                  <DateText value={l.anchorOn} size={12} prefix="passed nisab" empty="nisab not reached" />
                </div>

                <div>
                  <span className="ov" style={{ display: 'block', marginBottom: 8 }}>Its lunar year</span>
                  <HawlBar hawl={l.hawl} />
                </div>

                <div style={{ textAlign: 'right' }}>
                  <div className="mono" style={{ fontSize: 13, color: 'var(--faint)' }}>{dm(l.value)}</div>
                  <div className="mono" style={{ fontSize: 16, fontWeight: 600, marginTop: 4,
                                                 color: l.included ? 'var(--positive)' : 'var(--faint)' }}>
                    {l.included ? (l.basis === 'rent' ? dm(l.counted) : `+${dm(l.counted)}`) : 'nothing'}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--faint)', marginTop: 2 }}>
                    {l.basis === 'rent'
                      ? (l.included ? 'its rent, already inside cash' : 'charged on its rent')
                      : l.basis === 'value' ? 'charged on its value' : 'outside zakat'}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>
      )}

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
                      onChange={(v) => setPayment({ ...payment, accountId: v })}
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
                      onChange={(v) => setPayment({ ...payment, causeId: v })}
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

      <Panel title="Debts you could subtract"
             hint="Scholars differ. Some subtract only what is already overdue, some the coming year's payments, some nothing at all. Off by default, so the figure above is the larger, safer one."
             action={<Toggle on={deductDebts} onChange={setDeductDebts} label="Subtract debts" />}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 20 }}>
          <table>
            <thead><tr><th>Due</th><th>What it is</th><th>Amount</th></tr></thead>
            <tbody>
              {debtRows.slice(0, 6).map((row) => (
                <tr key={row.id}>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {row.date
                      ? new Date(`${row.date}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
                      : <span style={{ color: 'var(--faint)' }}>owed now</span>}
                  </td>
                  <td style={{ fontSize: 12, color: 'var(--muted)' }}>
                    {row.label}
                    {row.kind === 'borrowed' && (
                      <span className="chip" style={{ marginLeft: 8, fontSize: 10,
                              background: 'color-mix(in srgb, var(--car) 16%, transparent)',
                              color: 'var(--car)' }}>a person</span>
                    )}
                  </td>
                  <td className="mono">{dm(row.amountEgp)}</td>
                </tr>
              ))}
              {debtRows.length > 6 && (
                <tr><td colSpan={2} style={{ fontSize: 11, color: 'var(--faint)' }}>
                  and {debtRows.length - 6} more inside this hawl</td><td /></tr>
              )}
              <tr><td style={{ fontWeight: 600 }} colSpan={2}>Total owed inside this hawl</td>
                  <td className="mono" style={{ fontWeight: 600 }}>{dm(debts)}</td></tr>
            </tbody>
          </table>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Outcome on={!deductDebts} label="Without the deduction" base={dm(base)} due={dm(base * 0.025)} />
            <Outcome on={deductDebts} label="With the deduction" base={dm(Math.max(0, base - debts))}
                     due={dm(Math.max(0, base - debts) * 0.025)} />
          </div>
        </div>
      </Panel>

      {owedToYou > 0 && (
        <Panel title="Money owed to you"
               hint="A debt you expect back is wealth you happen not to be holding, so it counts toward the base. One you have written off does not — which is what writing it off means.">
          <table>
            <thead><tr><th>Owed by</th><th>Due</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
            <tbody>
              {receivables.map((r) => (
                <tr key={r.id}>
                  <td style={{ fontSize: 13 }}>{r.label}</td>
                  <td className="mono" style={{ fontSize: 12, color: 'var(--faint)' }}>
                    {r.due ?? 'no date'}
                  </td>
                  <td className="mono" style={{ textAlign: 'right' }}>{dm(r.amountEgp)}</td>
                </tr>
              ))}
              <tr>
                <td colSpan={2} style={{ fontWeight: 600 }}>Counted toward the base</td>
                <td className="mono" style={{ fontWeight: 600, textAlign: 'right',
                                              color: 'var(--positive)' }}>{dm(owedToYou)}</td>
              </tr>
            </tbody>
          </table>
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
          <EntryRows entries={year.entries} dm={dm}
                     empty="No lines were kept for this year." />
          <tr>
            <td />
            <td style={{ fontWeight: 600 }}>Zakatable, as confirmed</td>
            <td className="mono" style={{ fontWeight: 600, textAlign: 'right' }}>{dm(year.base)}</td>
          </tr>
          <tr>
            <td />
            <td style={{ fontWeight: 600 }}>Zakat due
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
 * The signed lines themselves, wherever they are read.
 *
 * A year being worked out now and a year confirmed three years ago are the same list, and have
 * to look it — an owner comparing this year against the last should be reading one format, not
 * two. So the rows are written once and the tables around them differ.
 */
function EntryRows({ entries, dm, empty }: {
  entries: Entry[];
  dm: (n: number) => string;
  empty: string;
}) {
  if (entries.length === 0) {
    return <tr><td /><td colSpan={2} style={{ fontSize: 12, color: 'var(--faint)' }}>{empty}</td></tr>;
  }
  return (
    <>
      {entries.map((e) => (
        <tr key={e.id}>
          <td className="mono" style={{
            fontSize: 15, fontWeight: 600, textAlign: 'center',
            color: e.sign === -1 ? 'var(--negative)' : e.sign === 1 ? 'var(--positive)' : 'var(--faint)',
          }}>{e.sign === 1 ? '+' : e.sign === -1 ? '−' : '·'}</td>
          <td>
            <div style={{ fontWeight: 500, color: e.sign === 0 ? 'var(--muted)' : undefined }}>{e.label}</div>
            {(e.note ?? e.detail) && (
              <div style={{ fontSize: 11, color: 'var(--faint)' }}>{e.note ?? e.detail}</div>
            )}
          </td>
          {/* A line counting nothing is bracketed rather than hidden: its value is worth
              seeing, and the brackets say it was left out on purpose. */}
          <td className="mono" style={{
            textAlign: 'right',
            color: e.sign === -1 ? 'var(--negative)' : e.sign === 0 ? 'var(--faint)' : undefined,
          }}>
            {e.sign === 0 ? `(${dm(e.amount)})` : `${e.sign === -1 ? '−' : ''}${dm(e.amount)}`}
          </td>
        </tr>
      ))}
    </>
  );
}

/**
 * One pot of wealth, read straight down the page.
 *
 * Every line carries its sign, so nothing has to be inferred from where it sits: a line that
 * adds, a line that comes off, and a line shown at its full value for nothing — a car, a home,
 * jewellery worn. That last kind is the reason the list is worth printing at all. An owner who
 * cannot see their car on it has no way to tell whether it was considered and excluded or
 * simply missed, and a total nobody can check is a total nobody should act on.
 *
 * What the pot owes and what it shows are two different figures once a year has closed. The
 * confirmed figure was fixed the day it closed and does not move; the list underneath is the
 * year now running, which moves with the gold price every day. They are never added together.
 */
function BucketTable({ bucket: b, dm, correction, onCorrection }: {
  bucket: Bucket;
  dm: (n: number) => string;
  correction: number | undefined;
  onCorrection: (n: number) => void;
}) {
  const confirmed = b.confirmed;
  const estimate = b.state === 'confirmed';
  const tone = b.state === 'confirmed' ? 'var(--positive)'
    : b.state === 'draft' ? 'var(--zakat)' : 'var(--muted)';

  return (
    <div style={{
      borderRadius: 'var(--r-card)', border: `1px solid ${b.state === 'running' ? 'var(--hairline)' : `color-mix(in srgb, ${tone} 30%, transparent)`}`,
      background: 'var(--surface)', overflow: 'hidden',
    }}>
      <div style={{
        display: 'flex', gap: 12, alignItems: 'baseline', flexWrap: 'wrap',
        padding: '14px 16px', borderBottom: '1px solid var(--hairline)',
        background: b.state === 'running' ? 'var(--raised)' : `color-mix(in srgb, ${tone} 7%, transparent)`,
      }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>{b.label}</span>
        {b.hawl && (
          <span style={{ fontSize: 11, color: 'var(--faint)' }}>
            year closes {b.hawl.dueHijriText} · {b.hawl.daysRemaining} days away
          </span>
        )}
        <span style={{ marginLeft: 'auto' }}>
          {b.state === 'confirmed' ? <Chip tone="good">Confirmed {confirmed?.dueOn}</Chip>
            : b.state === 'draft' ? <Chip tone="warn">A year has closed — confirm it</Chip>
              : <Chip>Estimate · still running</Chip>}
        </span>
      </div>

      {confirmed && (
        <div style={{
          display: 'flex', gap: 30, flexWrap: 'wrap', padding: '14px 16px',
          borderBottom: '1px solid var(--hairline)',
          background: 'color-mix(in srgb, var(--positive) 6%, transparent)',
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
          {confirmed.note && (
            <div style={{ fontSize: 11, color: 'var(--faint)', alignSelf: 'center', maxWidth: 280 }}>
              {confirmed.note}
            </div>
          )}
        </div>
      )}

      <table>
        <thead>
          <tr>
            <th style={{ width: 30 }}><span className="sr-only">Sign</span></th>
            <th>{estimate ? 'The year now running' : 'What it is'}</th>
            <th style={{ textAlign: 'right' }}>Amount</th>
          </tr>
        </thead>
        <tbody>
          <EntryRows entries={b.entries} dm={dm} empty="Nothing held in this pot." />
          <tr>
            <td />
            <td style={{ fontWeight: 600 }}>Zakatable</td>
            <td className="mono" style={{ fontWeight: 600, textAlign: 'right' }}>{dm(b.base)}</td>
          </tr>
          <tr>
            <td />
            <td style={{ fontWeight: 600 }}>
              Zakat due
              <span style={{ fontSize: 11, color: 'var(--faint)', fontWeight: 400 }}> · 2.5%</span>
              {!b.aboveNisab && (
                <div style={{ fontSize: 11, color: 'var(--faint)', fontWeight: 400 }}>
                  under nisab, so nothing is owed on it
                </div>
              )}
            </td>
            <td className="mono" style={{ fontWeight: 600, textAlign: 'right', fontSize: 16,
                                          color: b.due > 0 ? 'var(--positive)' : 'var(--faint)' }}>
              {dm(b.due)}
            </td>
          </tr>
        </tbody>
      </table>

      {b.state === 'draft' && (
        <div style={{
          display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap',
          padding: '14px 16px', borderTop: '1px solid var(--hairline)',
          background: 'color-mix(in srgb, var(--zakat) 6%, transparent)',
        }}>
          <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, flex: 1, minWidth: 220 }}>
            The year to <strong>{b.closedOn}</strong> has closed. Confirming writes this figure down so it
            stops moving with the market. Change it first if something was missed — the difference is
            recorded as a line of its own rather than replacing the arithmetic.
          </div>
          <Field label="Base to confirm">
            <Amount value={correction ?? Math.round(b.base)} ariaLabel={`${b.label} base to confirm`}
                    onChange={onCorrection} style={{ width: 170, textAlign: 'right' }} />
          </Field>
          <ActionButton capability="zakat.confirm"
            input={() => ({ bucketId: b.id, base: correction ?? Math.round(b.base) })}>
            Confirm this year
          </ActionButton>
        </div>
      )}
    </div>
  );
}

function Step({ label, detail, amount, running, minus, strong, accent }: {
  label: string; detail?: string; amount?: string; running: string;
  minus?: boolean; strong?: boolean; accent?: boolean;
}) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '26px minmax(0,1fr) 160px 160px', gap: 14, alignItems: 'center',
      padding: '13px 14px', borderRadius: 10,
      background: accent ? 'color-mix(in srgb, var(--accent) 7%, transparent)' : strong ? 'var(--raised)' : 'var(--surface)',
      border: `1px solid ${accent ? 'color-mix(in srgb, var(--zakat) 34%, transparent)' : 'var(--hairline)'}`,
    }}>
      <span style={{
        width: 22, height: 22, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 13, fontWeight: 600,
        background: minus ? 'color-mix(in srgb, var(--negative) 10%, transparent)'
                  : accent ? 'color-mix(in srgb, var(--zakat) 22%, transparent)' : 'transparent',
        color: minus ? 'var(--negative)' : accent ? 'var(--positive)' : 'transparent',
      }}>{minus ? '−' : accent ? '=' : ''}</span>
      <div>
        <div style={{ fontSize: 14, fontWeight: accent || strong ? 600 : 400 }}>{label}</div>
        {detail && <div style={{ fontSize: 11, color: 'var(--faint)' }}>{detail}</div>}
      </div>
      <span className="mono" style={{ textAlign: 'right', fontSize: 14, color: minus ? 'var(--negative)' : 'var(--faint)' }}>
        {amount ?? '—'}
      </span>
      <span className="mono" style={{ textAlign: 'right', fontSize: accent ? 18 : 15, fontWeight: accent ? 600 : 500,
                                      color: accent ? 'var(--positive)' : undefined }}>{running}</span>
    </div>
  );
}

function Outcome({ on, label, base, due }: { on: boolean; label: string; base: string; due: string }) {
  return (
    <div style={{
      padding: 18, borderRadius: 'var(--r-card)',
      background: on ? 'color-mix(in srgb, var(--zakat) var(--tint), transparent)' : 'var(--raised)',
      border: `1px solid ${on ? 'color-mix(in srgb, var(--zakat) 34%, transparent)' : 'var(--hairline)'}`,
    }}>
      <div className="ov" style={{ color: on ? 'var(--positive)' : undefined }}>{label}{on ? ' — in force' : ''}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 8 }}>
        <span className="mono" style={{ fontSize: 14, color: 'var(--muted)' }}>{base}</span>
        <span style={{ fontSize: 12, color: 'var(--faint)' }}>× 2.5% =</span>
        <span className="mono" style={{ fontSize: 21, fontWeight: 600, color: on ? 'var(--positive)' : 'var(--muted)' }}>{due}</span>
      </div>
    </div>
  );
}
