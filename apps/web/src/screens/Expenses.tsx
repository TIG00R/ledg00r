import { useEffect, useState } from 'react';
import { Amount } from '../components/Amount';
import { RecordAmount } from '../components/RecordAmount';
import { DateField } from '../components/DateField';
import { Select } from '../components/Select';
import { Segmented } from '../components/Segmented';
import { useApp, market } from '../AppState';
import { useModules } from '../Modules';
import { splitByCurrency, toEgp } from '@ledger/engine';
import { Page, Panel, Stat, Stats, AccountName } from '../components/UI';
import { CurrencySplits } from '../components/CurrencySplits';
import { Pie } from '../components/Pie';
import { SectionProvider, Sections, useSection } from '../components/Sections';
import { useLive } from '../Live';
import { Manager } from '../components/Manager';
import { RecordTable } from '../components/RecordTable';
import { Mark } from '../components/Mark';
import { Budgets } from './Budgets';

export function Expenses() {
  return (
    <SectionProvider first="records"><Body /></SectionProvider>
  );
}

/**
 * Expenses and budgets, as one entry in the sidebar.
 *
 * They were two screens because they were built one after the other, not because they are
 * two different things to somebody balancing a ledger — a destination and the ceiling over
 * it are read together far more often than either is read alone. Each screen keeps every
 * field, every table and its own Edit exactly as it was; a segmented switch at the top just
 * decides which one is in front of you, and choosing one writes it into the address so
 * #/expenses and #/budgets go on meaning what they always meant — including to whatever
 * already links to them, like the calendar.
 *
 * Turning a module off does not hide a tab, it removes the choice: with only one half left
 * standing, that half is the whole screen and there is nothing to switch between.
 */
export function ExpensesAndBudgets() {
  const { enabled } = useModules();
  const expensesOn = enabled.expenses !== false;
  const budgetsOn = enabled.budgets !== false;

  const readHalf = (): 'expenses' | 'budgets' =>
    window.location.hash.replace(/^#\/?/, '').split('/')[0] === 'budgets' ? 'budgets' : 'expenses';
  const [half, setHalf] = useState<'expenses' | 'budgets'>(readHalf);
  useEffect(() => {
    const onHash = () => setHalf(readHalf());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  if (!expensesOn && !budgetsOn) return null;
  if (!budgetsOn) return <Expenses />;
  if (!expensesOn) return <Budgets />;

  return (
    <>
      <div style={{ maxWidth: 1440, margin: '0 auto', width: '100%', padding: '20px 24px 0' }}>
        <Segmented value={half} ariaLabel="Expenses or budgets"
          onChange={(v) => { window.location.hash = `/${v}`; }}
          options={[
            { id: 'expenses', label: 'Expenses', icon: 'expenses' },
            { id: 'budgets', label: 'Budgets', icon: 'budgets' },
          ]} />
      </div>
      {half === 'expenses' ? <Expenses /> : <Budgets />}
    </>
  );
}

function Body() {
  const { data, dm, values, currencies, display } = useApp();
  /** which institution a node sits at, for the second line under an account's name */
  const bankOf = (id?: string | null) =>
    data.institutions.find((i) => i.id === data.nodes.find((n) => n.id === id)?.parentId)?.name ?? null;

  const { run } = useLive();
  /**
   * The records, read from the ledger.
   *
   * This screen used to fetch the log for itself, which made it the only place in the
   * application that knew what had been spent — the portfolio's expenses split said nothing
   * was recorded, and a destination with records against it offered itself for deletion. The
   * log is loaded where every other list is loaded, once, and read from here.
   */
  const records = data.expenses;

  const { tab } = useSection();
  const cats = data.categories.filter((c) => c.domain === 'expense');
  const cInfo = (id: string) => cats.find((c) => c.id === id);
  /** the accounts money can actually leave: cash, held somewhere */
  const payable = data.nodes.filter((n) => n.kind === 'cash' && n.parentId);
  /**
   * Which account a destination is usually paid from.
   *
   * The destination's own answer, then the ledger's one default. A person picks what they
   * spent on before they think about which card it was on, so the destination is what
   * decides — and the account stays a field they can override on the row.
   */
  const usualAccount = (destinationId: string) =>
    cInfo(destinationId)?.accountId ?? data.settings.burnAccountId;
  const accountName = (id?: string) => {
    const n = data.nodes.find((x) => x.id === id);
    const inst = data.institutions.find((i) => i.id === n?.parentId);
    return n ? `${inst?.name ?? ''} · ${n.name}` : '—';
  };

  const split = splitByCurrency(records, (e) => ({ amount: e.amount, currency: e.currency }), market);

  /**
   * What was spent on each destination, largest first.
   *
   * Read from the same records the table below draws, in the ledger's own currency, so the
   * circle and the log can never disagree. A record pointing at a destination that has since
   * been removed keeps its own name rather than being dropped — it was still spent.
   */
  const byDestination = [...records.reduce((acc, e) => {
    const c = cInfo(e.categoryId);
    const key = e.categoryId;
    const prev = acc.get(key) ?? { id: key, name: c?.name ?? 'No destination',
                                   color: c?.color ?? 'var(--muted)', total: 0 };
    prev.total += toEgp(e.amount, e.currency, market);
    acc.set(key, prev);
    return acc;
  }, new Map<string, { id: string; name: string; color: string; total: number }>()).values()]
    .filter((d) => d.total > 0)
    .sort((a2, b2) => b2.total - a2.total);
  const a = values.accrual;

  return (
    <Page>
      {/*
        * One section, not two.
        *
        * Destinations were never a place to visit — they are what the records point at, and
        * naming or recolouring one is a correction like any other, so they sit under the log
        * rather than off in a section of their own.
        */}
      <Sections sections={[
        { id: 'records', label: 'Records', icon: 'ledger',
          hint: 'Everything spent, newest first. Every column filters itself. Double-click a record, or a destination below, to correct it.' },
      ]} />

      {tab === 'records' && (
      <Panel>
        <Stats>
          <Stat label="Logged, all time" value={dm(split.totalEgp)} sub={`${records.length} record${records.length === 1 ? '' : 's'}`} />
          <Stat label="Counted since the opening position" value={dm(a.burn)} sub={`${dm(a.burnLogged)} logged`} color="var(--negative)" />
          <Stat label="Filled in from the baseline" value={dm(a.burnBaseline)} sub="months with nothing recorded" color="var(--gold)" />
          <Stat label="Budget baseline" value={dm(data.settings.budgetEgp)} sub="per month" />
        </Stats>
        <div style={{ marginTop: 20, paddingTop: 18, borderTop: '1px solid var(--hairline)',
                      display: 'flex', gap: 34, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          {/* Where it went, as a circle: one wedge per destination, each in the colour it
              wears in the log below and in the pickers. Every figure on this screen was a
              total or a row until now — the one question a log cannot answer at a glance is
              what the shape of the spending is, and that is exactly what a circle says. */}
          <div style={{ minWidth: 250 }}>
            <div className="ov" style={{ marginBottom: 6 }}>Where it went</div>
            {byDestination.length === 0 ? (
              <p style={{ margin: 0, fontSize: 12, color: 'var(--faint)' }}>
                Nothing has been logged yet, so there is nothing to draw.
              </p>
            ) : (
              <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', alignItems: 'center' }}>
                <Pie size={196}
                     slices={byDestination.map((d) => ({ label: d.name, value: d.total, color: d.color }))}
                     format={(n) => dm(n)}
                     caption={
                       <span style={{ fontSize: 11, color: 'var(--faint)' }}>
                         {byDestination.length} destination{byDestination.length === 1 ? '' : 's'}
                       </span>
                     } />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 190 }}>
                  {byDestination.map((d) => (
                    <span key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
                      <span style={{ width: 9, height: 9, borderRadius: 3, background: d.color, flex: '0 0 auto' }} />
                      <span style={{ flex: 1 }}>{d.name}</span>
                      <span className="mono" style={{ color: 'var(--muted)' }}>{dm(d.total)}</span>
                      <span className="mono" style={{ color: 'var(--faint)', fontSize: 11 }}>
                        {split.totalEgp > 0 ? `${((d.total / split.totalEgp) * 100).toFixed(1)}%` : '—'}
                      </span>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div style={{ minWidth: 250, flex: 1 }}>
            <CurrencySplits label="What you actually spent, by currency" splits={split.splits} totalEgp={split.totalEgp} />
          </div>
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
              // Spent in the currency the account is held in is not an exchange, and was being
              // restated in the reader's currency as though it were.
              cell: (e) => (
                <RecordAmount amount={e.amount} currency={e.currency} accountId={e.accountId} />
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
              /*
               * Choosing where it went chooses what it came out of — while a record is being
               * added. Correcting one leaves the account alone: the row already names the
               * account the money really left, and re-applying a default over it would be
               * the screen overruling what happened.
               */
              field: (d, set, row) => (
                <Select ariaLabel="Goes to" value={d.destinationId}
                        onChange={(v) => set(row
                          ? { destinationId: v }
                          : { destinationId: v, accountId: usualAccount(v) })}
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
                     // the first destination's usual account, not the ledger's for everything
                     accountId: usualAccount(cats[0]?.id ?? ''),
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
          clear={{ log: 'expenses',
                   what: 'every expense recorded, and the movements behind them' }}
        />
      </Panel>
      )}

      {tab === 'records' && (
        <Panel title="Destinations"
               hint="Where money goes when it leaves. Yours to name, mark and colour — change one here and every record that uses it follows.">
          <Manager
            markFamily="spending"
            addLabel="Add a destination"
            fields={[
              { key: 'name', label: 'Name', placeholder: 'Travel and leisure' },
              { key: 'colour', label: 'Colour', kind: 'colour', width: '54px' },
              /**
               * Which account this kind of spending usually comes out of.
               *
               * The destination is what a person picks first, and everything else about the
               * expense follows it — so it is the thing that should know. There used to be
               * one answer for the whole ledger, which meant groceries off the debit card
               * and a flight off the dollar account both opened on the same account and one
               * of them was corrected every single time.
               */
              { key: 'account', label: 'Usually paid from', kind: 'select', width: 'minmax(150px,1fr)',
                options: [{ value: '', label: 'the ledger\'s default' },
                          ...payable.map((n) => ({ value: n.id, label: n.name,
                            hint: data.institutions.find((i) => i.id === n.parentId)?.name }))] },
              { key: 'note', label: 'Note', placeholder: 'what belongs under it' },
            ]}
            rows={cats.map((c) => ({
              id: c.id,
              mark: c.icon,
              colour: c.color,
              values: { name: c.name, colour: c.color, account: c.accountId ?? '',
                        note: (c as { note?: string }).note ?? '' },
              blocked: data.expenses.some((e) => e.categoryId === c.id)
                ? `${data.expenses.filter((e) => e.categoryId === c.id).length} record${data.expenses.filter((e) => e.categoryId === c.id).length === 1 ? '' : 's'} go here. Archiving keeps them readable; deleting would leave them pointing at nothing.`
                : undefined,
            }))}
            onSave={(id, patch) => run('destination.update', {
              destinationId: id,
              name: patch.name as string | undefined,
              color: (patch.colour as string | undefined) ?? undefined,
              icon: patch.mark as string | undefined,
              // an empty account is a choice — "no usual account, use the ledger's" — so it
              // is sent rather than treated as nothing said
              accountId: patch.account as string | undefined,
            })}
            onAdd={(d) => run('destination.add', {
              name: d.name as string,
              color: (d.colour as string) || '#8A8578',
              // The mark chosen in the add row is part of the thing being added. Left off,
              // a destination given a picture and a colour arrived wearing the colour and
              // the fallback glyph, which read as the icon picker not working at all.
              icon: (d.mark as string | undefined) || undefined,
              accountId: (d.account as string) || undefined,
              note: (d.note as string) || undefined,
              domain: 'expense',
            })}
            onDelete={(id) => run('destination.remove', { destinationId: id })}
            onArchive={(id) => run('destination.update', { destinationId: id, archived: true })}
          />
          <p style={{ margin: '16px 0 0', fontSize: 12, color: 'var(--faint)', lineHeight: 1.5 }}>
            A destination with records against it cannot be deleted, and archiving is offered
            instead — it leaves the picker and every record that named it stays readable. The account is a default
            for what comes next: choosing a destination while logging an expense fills it in,
            and every expense already recorded keeps the account it actually came out of.
          </p>
        </Panel>
      )}

    </Page>
  );
}

