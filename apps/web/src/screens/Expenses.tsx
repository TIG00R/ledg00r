import { useEffect, useMemo, useState } from 'react';
import { Amount } from '../components/Amount';
import { DateField } from '../components/DateField';
import { Select, opts } from '../components/Select';
import { useApp, market } from '../AppState';
import { money, splitByCurrency, type DataSet } from '@ledger/engine';
import { Page, Panel, Stat, Stats, Empty, Field, AccountName } from '../components/UI';
import { CurrencySplits } from '../components/CurrencySplits';
import { Icon, ICON_FAMILY, type IconName } from '../components/Icon';
import { useSort, FilterTh, useFilters } from '../components/Table';
import { ModeProvider, useMode } from '../components/ModeBar';
import { SectionProvider, Sections, useSection } from '../components/Sections';
import { ActionButton, useLive } from '../Live';
import { Manager } from '../components/Manager';
import { ConfirmDelete } from '../components/Confirm';
import { RecordTable } from '../components/RecordTable';
import { ledger } from '../api';
import { Mark } from '../components/Mark';

export function Expenses() {
  return (
    <ModeProvider>
      <SectionProvider first="records"><Body /></SectionProvider>
    </ModeProvider>
  );
}

function Body() {
  const { data, dm, values, now, currencies, display } = useApp();
  /** which institution a node sits at, for the second line under an account's name */
  const bankOf = (id?: string | null) =>
    data.institutions.find((i) => i.id === data.nodes.find((n) => n.id === id)?.parentId)?.name ?? null;

  const { run, live, version } = useLive();
  const [logDate, setLogDate] = useState(new Date().toISOString().slice(0, 10));
  /**
   * The records, read from the ledger.
   *
   * They used to come from the fixture, so logging an expense wrote to the database and
   * changed nothing on screen — which looks exactly like a button that does not work.
   */
  const [live_, setLive_] = useState<typeof data.expenses | null>(null);
  useEffect(() => {
    if (!live) { setLive_(null); return; }
    let off = false;
    (ledger as any)['expense.list']({ limit: 500 })
      .then((rows: any[]) => {
        if (off) return;
        setLive_(rows.map((r) => ({
          id: r.id, seq: 0, date: r.date, amount: r.amount, currency: r.currency,
          fxAtEntry: 1, egpAmount: r.egpAmount, categoryId: r.destinationId,
          accountId: r.accountId ?? undefined, place: r.place ?? '', note: r.note ?? '',
        })) as typeof data.expenses);
      })
      .catch(() => { if (!off) setLive_(null); });
    return () => { off = true; };
  }, [live, version]);
  const records = live_ ?? data.expenses;

  const [draft, setDraft] = useState({
    accountId: data.settings.burnAccountId,
    amount: 0,
    currency: 'EGP',
    destinationId: data.categories.find((c) => c.domain === 'expense')?.id ?? '',
    place: '', note: '',
  });

  const { mode } = useMode();
  const { tab } = useSection();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('all');
  const [span, setSpan] = useState('all');

  const cats = data.categories.filter((c) => c.domain === 'expense');
  const cInfo = (id: string) => cats.find((c) => c.id === id);
  const accountName = (id?: string) => {
    const n = data.nodes.find((x) => x.id === id);
    const inst = data.institutions.find((i) => i.id === n?.parentId);
    return n ? `${inst?.name ?? ''} · ${n.name}` : '—';
  };

  // the span filter compares ISO dates as strings, which sorts correctly for yyyy-mm-dd
  const spanStart = (() => {
    if (span === 'all') return '';
    const d = new Date(now);
    if (span === 'month') return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
    if (span === 'ytd') return `${d.getFullYear()}-01-01`;
    d.setMonth(d.getMonth() - 3);
    return d.toISOString().slice(0, 10);
  })();

  const filtered = records
    .filter((e) => (cat === 'all' || e.categoryId === cat))
    .filter((e) => !q || `${e.place} ${e.note}`.toLowerCase().includes(q.toLowerCase()))
    .filter((e) => e.date >= spanStart);

  /**
   * The columns are the filters.
   *
   * A destination, an account, a note — each heading filters its own column and they
   * combine, so "everything on the current account, over a hundred, in September" is three
   * choices rather than a search phrased just so.
   */
  const cols = useMemo(() => [
    { key: 'date', value: (e: typeof filtered[number]) => e.date, kind: 'date' as const },
    { key: 'amount', value: (e: typeof filtered[number]) => e.egpAmount, kind: 'amount' as const },
    { key: 'account', value: (e: typeof filtered[number]) => accountName(e.accountId) },
    { key: 'category', value: (e: typeof filtered[number]) => cInfo(e.categoryId)?.name ?? e.categoryId },
    { key: 'place', value: (e: typeof filtered[number]) => e.place },
    { key: 'note', value: (e: typeof filtered[number]) => e.note, kind: 'text' as const },
  ], [filtered]); // eslint-disable-line react-hooks/exhaustive-deps
  const filters = useFilters(filtered, cols);

  const { sorted: rows, sort, toggle } = useSort(filters.filtered, {
    date: (e) => e.date,
    amount: (e) => e.egpAmount,
    account: (e) => accountName(e.accountId),
    category: (e) => cInfo(e.categoryId)?.name ?? e.categoryId,
    place: (e) => e.place,
    note: (e) => e.note,
  }, { key: 'date', dir: 'desc' });

  const split = splitByCurrency(records, (e) => ({ amount: e.amount, currency: e.currency }), market);
  const a = values.accrual;

  return (
    <Page>
      {/*
        * One section, not two.
        *
        * Destinations were never a place to visit — they are what the records point at, and
        * naming or recolouring one is a correction like any other. So they appear under the
        * log while it is being edited, and stay out of the way while it is being read.
        */}
      <Sections sections={[
        { id: 'records', label: 'Records', icon: 'ledger',
          hint: 'Everything spent, newest first. Every column filters itself.',
          editHint: 'Correct a record, or rename, recolour and add the destinations they point at.' },
      ]} />

      {tab === 'records' && (
      <Panel>
        <Stats>
          <Stat label="Logged, all time" value={dm(split.totalEgp)} sub={`${records.length} record${records.length === 1 ? '' : 's'}`} />
          <Stat label="Counted since the opening position" value={dm(a.burn)} sub={`${dm(a.burnLogged)} logged`} color="var(--negative)" />
          <Stat label="Filled in from the baseline" value={dm(a.burnBaseline)} sub="months with nothing recorded" color="var(--gold)" />
          <Stat label="Budget baseline" value={dm(data.settings.budgetEgp)} sub="per month" />
        </Stats>
        <div style={{ marginTop: 20, paddingTop: 18, borderTop: '1px solid var(--hairline)' }}>
          <CurrencySplits label="What you actually spent, by currency" splits={split.splits} totalEgp={split.totalEgp} />
        </div>
      </Panel>

      )}

      {tab === 'records' && (
      <Panel title="Records"
             hint="Every column filters itself, and the filters combine. Adding one happens in the row at the top.">
        {/* the receipt for what was just recorded, beside the log it changed */}
        <RecordTable
          rows={records}
          rowKey={(e) => e.id}
          sort={{ key: 'date', dir: 'desc' }}
          empty={{ icon: 'expenses', title: 'Nothing logged yet',
                   body: 'Until you log something, each month falls back to the budget baseline.' }}
          columns={[
            { key: 'date', label: 'Date', kind: 'date',
              value: (e) => e.date,
              cell: (e) => <span className="mono" style={{ fontSize: 13 }}>{e.date}</span>,
              field: (d, set) => <DateField value={d.date} onChange={(v) => set({ date: v })} ariaLabel="Date" /> },

            { key: 'amount', label: 'Amount', kind: 'money',
              value: (e) => e.egpAmount,
              cell: (e) => (
                <>
                  <div className="mono" style={{ fontSize: 14 }}>
                    {money(e.amount, e.currency, e.currency === 'EGP' ? 0 : 2)}
                  </div>
                  {e.currency !== display && (
                    <div className="mono" style={{ fontSize: 11, color: 'var(--faint)' }}>{dm(e.egpAmount)}</div>
                  )}
                </>
              ),
              field: (d, set) => (
                <span className="field-money">
                  <Amount value={d.amount} ariaLabel="Amount" onChange={(n) => set({ amount: n })} />
                  <Select ariaLabel="Currency" value={d.currency} style={{ width: 92 }}
                          onChange={(v) => set({ currency: v })}
                          options={currencies.map((c) => ({ value: c.code, label: c.code }))} />
                </span>
              ) },

            { key: 'account', label: 'Paid from', kind: 'pick',
              value: (e) => accountName(e.accountId),
              cell: (e) => (
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                  <AccountName name={accountName(e.accountId)} bank={bankOf(e.accountId)} />
                </span>
              ),
              field: (d, set) => (
                <Select ariaLabel="Paid from" value={d.accountId} onChange={(v) => set({ accountId: v })}
                        options={data.nodes.filter((n) => n.kind === 'cash' && n.parentId).map((n) => ({
                          value: n.id, label: n.name,
                          hint: data.institutions.find((i) => i.id === n.parentId)?.name }))} />
              ) },

            { key: 'category', label: 'Goes to', kind: 'pick',
              value: (e) => cInfo(e.categoryId)?.name ?? e.categoryId,
              cell: (e) => {
                const c = cInfo(e.categoryId);
                return (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 24, height: 24, borderRadius: 7, flex: '0 0 24px',
                                   display: 'flex', alignItems: 'center', justifyContent: 'center',
                                   background: `color-mix(in srgb, ${c?.color ?? 'var(--muted)'} 15%, transparent)` }}>
                      <Mark mark={c?.icon} size={13} color={c?.color ?? 'var(--muted)'} fallback="expenses" />
                    </span>
                    <span style={{ fontSize: 13 }}>{c?.name ?? e.categoryId}</span>
                  </span>
                );
              },
              field: (d, set) => (
                <Select ariaLabel="Goes to" value={d.destinationId} onChange={(v) => set({ destinationId: v })}
                        options={cats.map((c) => ({ value: c.id, label: c.name }))} />
              ) },

            { key: 'place', label: 'Place', kind: 'text',
              value: (e) => e.place,
              cell: (e) => <span style={{ fontSize: 13, color: 'var(--muted)' }}>
                {e.place || <span style={{ color: 'var(--faint)' }}>—</span>}</span>,
              field: (d, set) => <input aria-label="Place" placeholder="where" value={d.place}
                                        onChange={(e) => set({ place: e.target.value })} /> },

            { key: 'note', label: 'Note', kind: 'text',
              value: (e) => e.note,
              cell: (e) => <span style={{ fontSize: 13, color: 'var(--muted)' }}>
                {e.note || <span style={{ color: 'var(--faint)' }}>—</span>}</span>,
              field: (d, set) => <input aria-label="Note" placeholder="what for" value={d.note}
                                        onChange={(e) => set({ note: e.target.value })} /> },
          ]}
          add={{
            label: 'Log an expense',
            capability: 'expense.record',
            blank: { date: new Date().toISOString().slice(0, 10),
                     accountId: data.settings.burnAccountId,
                     destinationId: cats[0]?.id ?? '', amount: 0,
                     currency: display, place: '', note: '' },
            valid: (d) => d.amount > 0 && !!d.accountId && !!d.destinationId,
            build: (d) => ({ accountId: d.accountId, amount: d.amount, currency: d.currency,
                             destinationId: d.destinationId, date: d.date,
                             place: d.place || undefined, note: d.note || undefined }),
          }}
          edit={{
            capability: 'expense.correct',
            draftOf: (e) => ({ date: e.date, amount: e.amount, currency: e.currency,
                               accountId: e.accountId ?? '', destinationId: e.categoryId,
                               place: e.place, note: e.note }),
            build: (d, e) => ({ expenseId: e.id, accountId: d.accountId, amount: d.amount,
                                currency: d.currency, destinationId: d.destinationId,
                                date: d.date, place: d.place || undefined, note: d.note || undefined }),
          }}
          remove={{
            capability: 'expense.remove',
            build: (e) => ({ expenseId: e.id }),
            what: (e) => `${e.place || 'this expense'} on ${e.date}`,
          }}
        />
      </Panel>
      )}

      {tab === 'records' && mode === 'edit' && (
        <Panel title="Destinations"
               hint="Where money goes when it leaves. Yours to name, mark and colour — change one here and every record that uses it follows.">
          <Manager
            markFamily="spending"
            addLabel="Add a destination"
            fields={[
              { key: 'name', label: 'Name', placeholder: 'Travel and leisure' },
              { key: 'colour', label: 'Colour', kind: 'colour', width: '54px' },
              { key: 'note', label: 'Note', placeholder: 'what belongs under it' },
            ]}
            rows={cats.map((c) => ({
              id: c.id,
              mark: c.icon,
              colour: c.color,
              values: { name: c.name, colour: c.color, note: (c as { note?: string }).note ?? '' },
              blocked: data.expenses.some((e) => e.categoryId === c.id)
                ? `${data.expenses.filter((e) => e.categoryId === c.id).length} record${data.expenses.filter((e) => e.categoryId === c.id).length === 1 ? '' : 's'} go here. Archiving keeps them readable; deleting would leave them pointing at nothing.`
                : undefined,
            }))}
            onSave={(id, patch) => run('destination.update', {
              destinationId: id,
              name: patch.name as string | undefined,
              color: (patch.colour as string | undefined) ?? undefined,
              icon: patch.mark as string | undefined,
            })}
            onAdd={(d) => run('destination.add', {
              name: d.name as string,
              color: (d.colour as string) || '#8A8578',
              note: (d.note as string) || undefined,
              domain: 'expense',
            })}
            onDelete={(id) => run('destination.update', { destinationId: id, archived: true })}
          />
          <p style={{ margin: '16px 0 0', fontSize: 12, color: 'var(--faint)', lineHeight: 1.5 }}>
            A destination with records against it is archived rather than deleted — it leaves
            the picker and every record that named it stays readable.
          </p>
        </Panel>
      )}

    </Page>
  );
}

function CategorySelect({ cats, value, onChange }: {
  cats: DataSet['categories']; value?: string; onChange?: (v: string) => void;
}) {
  const [own, setOwn] = useState(cats[0]?.id ?? '');
  const id = value ?? own;
  const setId = onChange ?? setOwn;
  const c = cats.find((x) => x.id === id);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
      <span style={{
        width: 32, height: 32, borderRadius: 8, flex: '0 0 32px',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: `color-mix(in srgb, ${c?.color ?? 'var(--muted)'} 15%, transparent)`,
      }}>
        <Mark mark={c?.icon} size={17} color={c?.color ?? 'var(--muted)'} fallback="expenses" />
      </span>
      <Select value={id} onChange={setId} style={{ flex: 1 }} ariaLabel="Destination"
              options={cats.map((x) => ({ value: x.id, label: x.name }))} />
    </div>
  );
}
