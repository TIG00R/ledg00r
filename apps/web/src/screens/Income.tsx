import { useEffect, useMemo, useState } from 'react';
import { Amount } from '../components/Amount';
import { Select, opts } from '../components/Select';
import { useApp, market } from '../AppState';
import { money, splitByCurrency, toEgp } from '@ledger/engine';
import { Page, Panel, Stat, Stats, Chip, Row, Field, Empty, AccountName } from '../components/UI';
import { CurrencySplits } from '../components/CurrencySplits';
import { Icon, ICON_FAMILY, type IconName } from '../components/Icon';
import { useSort, FilterTh, useFilters } from '../components/Table';
import { ModeProvider, useMode } from '../components/ModeBar';
import { SectionProvider, Sections, useSection } from '../components/Sections';
import { ActionButton, useLive } from '../Live';
import { Manager } from '../components/Manager';
import { RecordTable } from '../components/RecordTable';
import { ledger } from '../api';
import { Mark } from '../components/Mark';
import { ConfirmDelete, Dismissable } from '../components/Confirm';
import { DateField } from '../components/DateField';

const COLS = '48px minmax(200px,1.4fr) 140px 190px 160px 70px';

export function Income() {
  return (
    <ModeProvider>
      <SectionProvider first="sources"><Body /></SectionProvider>
    </ModeProvider>
  );
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
                     'July', 'August', 'September', 'October', 'November', 'December'];

const FALLBACK_LOGGED = [
  { id: 'l1', date: '2026-07-14', source: 'Freelance work', amount: 1800, currency: 'USD', into: 'Nile Bank · USD savings', note: 'Q2 retainer, final invoice' },
  { id: 'l2', date: '2026-05-02', source: 'Freelance work', amount: 1200, currency: 'USD', into: 'Nile Bank · USD savings', note: 'critical, triaged in 3 days' },
  { id: 'l3', date: '2026-04-19', source: 'Freelance work', amount: 1500, currency: 'USD', into: 'Nile Bank · USD savings', note: '' },
  { id: 'l4', date: '2026-03-08', source: 'Freelance work', amount: 600, currency: 'USD', into: 'Nile Bank · USD savings', note: 'medium severity' },
  { id: 'l5', date: '2026-02-11', source: 'Freelance work', amount: 900, currency: 'USD', into: 'Nile Bank · USD savings', note: '' },
];

function Body() {
  const { data, dm, values, currencies, balances, display } = useApp();
  /** the same, where the log carries the account's name rather than its id */
  const bankOfName = (name?: string | null) =>
    data.institutions.find((i) => i.id === data.nodes.find((n) => n.name === name)?.parentId)?.name ?? null;

  /** things that can earn rent, so a source can name the one that earns it */
  const lettable = data.nodes.filter((n) => n.kind === 'asset' && !n.unit
    && !/^brokerage|^debt-/.test(n.id) && !n.archived);
  const { run, live, version } = useLive();
  const [logDate, setLogDate] = useState(new Date().toISOString().slice(0, 10));
  const [draftStart, setDraftStart] = useState(new Date().toISOString().slice(0, 10));
  /**
   * What has actually landed.
   *
   * Read from the ledger and re-read after every write, so recording a payment shows up in
   * the list below rather than appearing to do nothing. With no service, the fixture stands
   * in and the screen still reads correctly.
   */
  const [landed, setLanded] = useState<typeof FALLBACK_LOGGED | null>(null);
  useEffect(() => {
    if (!live) { setLanded(null); return; }
    let off = false;
    (ledger as any)['income.list']({})
      .then((rows: any[]) => {
        if (off) return;
        setLanded(rows.map((r) => ({
          id: r.id, date: r.date, source: r.source, amount: r.amount,
          currency: r.currency, into: r.into, note: r.note ?? '',
        })));
      })
      .catch(() => { if (!off) setLanded(null); });
    return () => { off = true; };
  }, [live, version]);
  const LOGGED = landed ?? FALLBACK_LOGGED;

  const [draft, setDraft] = useState({
    sourceId: data.incomeSources.find((x) => !x.scheduled)?.id ?? '',
    accountId: data.settings.incomeAccountId, amount: 0, currency: 'USD', note: '',
  });

  /** only accounts actually held in the chosen currency can receive it */
  const inCurrency = data.nodes.filter((n) => n.kind === 'cash' && n.currency === draft.currency);
  const [draftEnd, setDraftEnd] = useState('');

  const { mode } = useMode();
  const { tab } = useSection();
  /*
   * A source's mark comes from the source.
   *
   * There used to be a table of hard-coded marks here, seeded per source id, and it won over
   * whatever had been saved — so uploading a picture wrote it to the database and the screen
   * kept showing the icon this map had chosen. There is no local copy now.
   */
  const [picking, setPicking] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const scheduled = data.incomeSources.filter((s) => s.scheduled);
  const occasional = data.incomeSources.filter((s) => !s.scheduled);

  const monthly = splitByCurrency(scheduled, (s) => (s.amount == null ? null : { amount: s.amount, currency: s.currency }), market);

  // Derived from the log rather than restated, so the first payment recorded moves it.
  const year = String(new Date().getFullYear());
  const occasionalThisYear = LOGGED.filter((l) => l.date.startsWith(year));
  const occasionalEgp = occasionalThisYear.reduce((s2, l) => s2 + toEgp(l.amount, l.currency, market), 0);
  const perSource = (id: string) => {
    const src = data.incomeSources.find((x) => x.id === id);
    const mine = occasionalThisYear.filter((l) => l.source === src?.name);
    return mine.reduce((s2, l) => s2 + toEgp(l.amount, l.currency, market), 0);
  };
  const accountName = (id: string) => {
    const n = data.nodes.find((x) => x.id === id);
    const inst = data.institutions.find((i) => i.id === n?.parentId);
    return { bank: inst?.name ?? '', account: n?.name ?? id };
  };

  const loggedRows = LOGGED.filter((l) => !q ||
    `${l.source} ${l.note} ${l.into}`.toLowerCase().includes(q.toLowerCase()));
  const logCols = useMemo(() => [
    { key: 'date', value: (l: typeof loggedRows[number]) => l.date, kind: 'date' as const },
    { key: 'source', value: (l: typeof loggedRows[number]) => l.source },
    { key: 'amount', value: (l: typeof loggedRows[number]) => toEgp(l.amount, l.currency, market), kind: 'amount' as const },
    { key: 'into', value: (l: typeof loggedRows[number]) => l.into },
    { key: 'note', value: (l: typeof loggedRows[number]) => l.note, kind: 'text' as const },
  ], [loggedRows]);
  const logFilters = useFilters(loggedRows, logCols);

  const { sorted: logged, sort, toggle } = useSort(logFilters.filtered, {
    date: (l) => l.date,
    source: (l) => l.source,
    amount: (l) => toEgp(l.amount, l.currency, market),
    into: (l) => l.into,
    note: (l) => l.note,
  }, { key: 'date', dir: 'desc' });

  return (
    <Page>
      <Sections sections={[
        { id: 'sources', label: 'Sources', icon: 'income',
          hint: 'Where money comes from. Scheduled sources accrue on their own.',
          editHint: 'Rename a source, change what it pays and how often, add one, retire one.' },
        { id: 'records', label: 'Records', icon: 'ledger',
          hint: 'Every payment that actually landed, newest first.',
          editHint: 'Correct what landed — the amount, the account, the date — or reverse one that never did.' },
      ]} />
      <Panel>
        <Stats>
          <Stat label="Scheduled, per month" value={dm(monthly.totalEgp)} sub="what the forecast uses" color="var(--positive)" />
          <Stat label="Occasional, this year" value={dm(occasionalEgp)}
                sub={`${occasionalThisYear.length} payment${occasionalThisYear.length === 1 ? '' : 's'} recorded`} />
          <Stat label="Income accrued since the snapshot" value={dm(values.accrual.income)} sub={`${values.accrual.months.toFixed(2)} months`} />
          <Stat label="Scheduled income ends" value="30 Jun 2028" sub="21 months of salary left" />
        </Stats>
        <div style={{ marginTop: 20, paddingTop: 18, borderTop: '1px solid var(--hairline)' }}>
          <CurrencySplits label="Scheduled income, by the currency it is paid in"
                          splits={monthly.splits} totalEgp={monthly.totalEgp} />
        </div>
      </Panel>

      <Row cols={COLS} style={{ padding: '0 18px' }}>
        <span /><span className="ov">Source</span><span className="ov">Amount</span>
        <span className="ov">When it arrives</span><span className="ov">Lands in</span><span />
      </Row>

      {tab === 'sources' && mode === 'edit' ? (
        <Manager
          markFamily="income"
          addLabel="Add a source"
          fields={[
            { key: 'name', label: 'Name', placeholder: 'Consulting retainer', width: 'minmax(150px,1.6fr)' },
            // A source that simply turns up has no amount to state — what it pays is
            // whatever each payment turned out to be, which is on the record, not here.
            { key: 'amount', label: 'Amount', kind: 'number', width: '130px',
              when: (v) => v.cadence !== 'irregular',
              placeholder: 'what it pays' },
            { key: 'currency', label: 'Currency', kind: 'select', width: '130px',
              options: currencies.map((c) => ({ value: c.code, label: c.code, hint: c.name })) },
            { key: 'cadence', label: 'How often', kind: 'select', width: '150px',
              options: [
                { value: 'daily', label: 'Daily' },
                { value: 'weekly', label: 'Weekly' },
                { value: 'monthly', label: 'Monthly' },
                { value: 'quarterly', label: 'Quarterly' },
                { value: 'annually', label: 'Annually' },
                { value: 'irregular', label: 'Whenever it comes', hint: 'no fixed amount' },
              ] },
            // When it arrives is a different question for each cadence, so each asks its
            // own: a weekday for something weekly, a day of the month for something monthly,
            // and for a quarter both — which month it starts in and which day of that month.
            // When it arrives is a different question for each cadence. A weekly source
            // wants a day of the week; a monthly one a day of the month; a quarterly one a
            // date to count three months from, which is a calendar rather than two lists.
            { key: 'weekday', label: 'Arrives', kind: 'select', width: '160px',
              when: (v) => v.cadence === 'weekly',
              options: WEEKDAYS.map((d, i) => ({ value: String(i), label: `Every ${d}` })) },
            { key: 'dayOfMonth', label: 'Arrives', kind: 'select', width: '160px',
              when: (v) => v.cadence === 'monthly',
              options: [...Array.from({ length: 28 }, (_, i) => ({
                value: String(i + 1), label: `Day ${i + 1}`,
              })), { value: 'last', label: 'Last day' }] },
            { key: 'startDate', label: 'First one', kind: 'date', width: '190px',
              when: (v) => v.cadence === 'quarterly' || v.cadence === 'annually',
              hint: 'and every three months after' },
            /**
             * Rent has to name the thing that earns it.
             *
             * A let flat is outside zakat itself and what it earns is not, so the earnings
             * have to be attributable to the flat — otherwise rent is indistinguishable from
             * a wage once it is in the account, and its own lunar year cannot be measured.
             */
            { key: 'assetId', label: 'Earned by', kind: 'select', width: '180px',
              hint: 'for zakat on rent',
              options: [{ value: '', label: 'Nothing — it is not rent' },
                        ...lettable.map((n) => ({ value: n.id, label: n.name }))] },
          ]}
          rows={[...scheduled, ...occasional].map((src) => ({
            id: src.id,
            mark: src.icon ?? 'income',
            colour: src.scheduled ? '#2E7D52' : '#B37E00',
            values: {
              name: src.name,
              amount: src.amount ?? '',
              currency: src.currency,
              cadence: src.scheduled ? src.cadence : 'irregular',
              dayOfMonth: String(src.dayOfMonth ?? 1),
              annualOn: String(src.startDate?.slice(5, 7) ?? 1),
              assetId: (src as { assetId?: string | null }).assetId ?? '',
            },
          }))}
          onSave={(id, patch) => run('income.source.update', {
            sourceId: id,
            name: patch.name as string | undefined,
            amount: patch.cadence === 'irregular' ? null
                  : patch.amount === '' ? null : (patch.amount as number | undefined),
            currency: patch.currency as string | undefined,
            cadence: patch.cadence as string | undefined,
            dayOfMonth: patch.dayOfMonth === 'last' ? 'last'
                      : patch.dayOfMonth != null ? Number(patch.dayOfMonth) : undefined,
            icon: patch.mark as string | undefined,
            assetId: patch.assetId === undefined ? undefined : ((patch.assetId as string) || null),
          })}
          onAdd={(d) => run('income.source.add', {
            name: d.name as string,
            amount: d.cadence === 'irregular' || d.amount === '' || d.amount == null
              ? null : Number(d.amount),
            currency: String(d.currency || currencies[0]?.code || 'EGP'),
            cadence: (d.cadence as string) || 'monthly',
            dayOfMonth: d.dayOfMonth === 'last' ? 'last' : Number(d.dayOfMonth ?? 1),
            toAccountId: data.settings.incomeAccountId,
            icon: d.mark as string | undefined,
            assetId: (d.assetId as string) || undefined,
          })}
          onDelete={(id) => run('income.source.retire', { sourceId: id })}
        />
      ) : tab === 'sources' ? (

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {[...scheduled, ...occasional].map((s) => {
          const { bank, account } = accountName(s.toNodeId);
          return (
            <div key={s.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Row cols={COLS} style={{
              padding: '16px 18px', borderRadius: 'var(--r-card)',
              background: s.scheduled ? 'var(--surface)' : 'var(--raised)',
              border: '1px solid var(--hairline)',
            }}>
              {(() => {
                const tone = s.scheduled ? 'var(--positive)' : 'var(--gold)';
                return (
                  <span style={{
                    width: 36, height: 36, borderRadius: 9, display: 'flex', alignItems: 'center',
                    justifyContent: 'center',
                    background: `color-mix(in srgb, ${tone} var(--tint), transparent)`,
                  }}>
                    <Mark mark={s.icon} size={19} color={tone} fallback="income" />
                  </span>
                );
              })()}
              <div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{s.name}</div>
                <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 2 }}>
                  {s.scheduled
                    ? `started ${s.startDate}${s.endDate ? `, ends ${s.endDate}` : ''}`
                    : 'no schedule'}
                </div>
              </div>
              <div>
                <div className="mono" style={{ fontSize: 16, fontWeight: 500, color: s.amount == null ? 'var(--muted)' : undefined }}>
                  {s.amount == null ? 'varies' : money(s.amount, s.currency)}
                </div>
                <div style={{ fontSize: 11, color: 'var(--faint)' }}>
                  {s.amount == null
                    ? (() => {
                        const mine = occasionalThisYear.filter((l) => l.source === s.name);
                        return mine.length ? `avg ${dm(perSource(s.id) / mine.length)}` : 'varies';
                      })()
                    : 'fixed'}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 13 }}>
                  {s.scheduled ? `Monthly, on the ${s.dayOfMonth === 'last' ? 'last day' : `${s.dayOfMonth}st`}` : 'Whenever it comes'}
                </div>
                <div style={{ fontSize: 11, color: 'var(--faint)' }}>
                  {s.scheduled ? 'next 1 Oct' : `${dm(perSource(s.id))} so far this year`}
                </div>
              </div>
              <div style={{ fontSize: 13, color: 'var(--muted)' }}>
                {bank}<br /><span style={{ fontSize: 11, color: 'var(--faint)' }}>{account}</span>
              </div>
              <span />
            </Row>
            </div>
          );
        })}
      </div>
      ) : null}

      {tab === 'records' && (
      <Panel title="Income that landed"
             hint="Every payment that turned up rather than accruing on a schedule. These count from the day they landed and never before.">
        {/* the receipt for what was just recorded, beside the log it changed */}
        <RecordTable
          rows={LOGGED}
          rowKey={(l) => l.id}
          sort={{ key: 'date', dir: 'desc' }}
          empty={{ icon: 'income', title: 'Nothing recorded yet',
                   body: 'Scheduled income accrues on its own; anything irregular counts once you record it.' }}
          columns={[
            { key: 'date', label: 'Date', kind: 'date',
              value: (l) => l.date,
              cell: (l) => <span className="mono" style={{ fontSize: 13 }}>{l.date}</span>,
              field: (d, set) => <DateField value={d.date} onChange={(v) => set({ date: v })} ariaLabel="Date" /> },

            { key: 'source', label: 'Source', kind: 'pick',
              value: (l) => l.source,
              field: (d, set) => (
                <Select ariaLabel="Source" value={d.sourceId} onChange={(v) => set({ sourceId: v })}
                        options={occasional.map((x) => ({ value: x.id, label: x.name }))} />
              ) },

            { key: 'amount', label: 'Amount', kind: 'money',
              value: (l) => toEgp(l.amount, l.currency, market),
              cell: (l) => (
                <>
                  <div className="mono" style={{ fontSize: 14 }}>{money(l.amount, l.currency)}</div>
                  {l.currency !== display && (
                    <div className="mono" style={{ fontSize: 11, color: 'var(--faint)' }}>
                      {dm(toEgp(l.amount, l.currency, market))}
                    </div>
                  )}
                </>
              ),
              field: (d, set) => (
                <span className="field-money">
                  <Amount value={d.amount} ariaLabel="Amount" onChange={(n) => set({ amount: n })} />
                  <Select ariaLabel="Currency" value={d.currency} style={{ width: 92 }}
                          onChange={(v) => {
                            const first = data.nodes.find((n) => n.kind === 'cash' && n.parentId && n.currency === v);
                            const keep = data.nodes.find((n) => n.id === d.accountId)?.currency === v;
                            set({ currency: v, accountId: keep ? d.accountId : (first?.id ?? '') });
                          }}
                          options={currencies.map((c) => ({ value: c.code, label: c.code }))} />
                </span>
              ) },

            { key: 'into', label: 'Landed in', kind: 'pick',
              value: (l) => l.into,
              cell: (l) => (
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                  <AccountName name={l.into} bank={bankOfName(l.into)} />
                </span>
              ),
              field: (d, set) => (
                <Select ariaLabel="Landed in" value={d.accountId} onChange={(v) => set({ accountId: v })}
                        options={data.nodes.filter((n) => n.kind === 'cash' && n.parentId && n.currency === d.currency)
                          .map((n) => ({ value: n.id, label: n.name,
                                         hint: data.institutions.find((i) => i.id === n.parentId)?.name }))} />
              ) },

            { key: 'note', label: 'Note', kind: 'text',
              value: (l) => l.note,
              cell: (l) => <span style={{ fontSize: 13, color: 'var(--muted)' }}>
                {l.note || <span style={{ color: 'var(--faint)' }}>—</span>}</span>,
              field: (d, set) => <input aria-label="Note" placeholder="what for" value={d.note}
                                        onChange={(e) => set({ note: e.target.value })} /> },
          ]}
          add={{
            label: 'Log income that landed',
            capability: 'income.record',
            blank: { date: new Date().toISOString().slice(0, 10),
                     sourceId: occasional[0]?.id ?? '',
                     accountId: data.settings.incomeAccountId,
                     currency: display, amount: 0, note: '' },
            valid: (d) => d.amount > 0 && !!d.accountId,
            build: (d) => ({ sourceId: d.sourceId || undefined, accountId: d.accountId,
                             amount: d.amount, currency: d.currency, date: d.date,
                             note: d.note || undefined }),
          }}
          edit={{
            capability: 'income.correct',
            draftOf: (l) => ({
              date: l.date, amount: l.amount, currency: l.currency,
              accountId: (l as { intoId?: string | null }).intoId ?? '',
              sourceId: occasional.find((x) => x.name === l.source)?.id ?? '',
              note: l.note ?? '',
            }),
            build: (d, l) => ({ movementId: l.id, accountId: d.accountId || undefined,
                                sourceId: d.sourceId || undefined, amount: Number(d.amount),
                                date: d.date, note: d.note ?? '' }),
            blocked: (l) => (l.id.startsWith('tx-') ? undefined
              : 'This payment predates the movement log, so there is nothing to rewrite.'),
          }}
          remove={{
            capability: 'movement.undo',
            build: (l) => ({ movementId: l.id }),
            what: (l) => `${l.source} on ${l.date}`,
            blocked: (l) => (l.id.startsWith('tx-') ? undefined
              : 'This payment predates the movement log, so there is nothing to reverse.'),
          }}
        />
      </Panel>
      )}
    </Page>
  );
}
