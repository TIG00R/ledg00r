import { useCallback, useEffect, useState } from 'react';
import { useApp, market } from '../AppState';
import { money, toEgp } from '@ledger/engine';
import { RecordTable } from './RecordTable';
import { AccountLine } from './AccountLine';
import { Icon, type IconName } from './Icon';
import { Amount } from './Amount';
import { RecordAmount } from './RecordAmount';
import { DateField } from './DateField';
import { Select } from './Select';
import { useLive } from '../Live';
import { ledger } from '../api';
import { accountOption } from '../accounts';

/**
 * Everything given, as one table.
 *
 * There were two of these: the zakat screen's list and the sadaqat screen's, each with its own
 * columns, its own sorting and its own idea of which account the money came out of — one of
 * them simply printed the same account against every row. They are one list with a type
 * column, so this is one component, and the screen that shows it says which kinds it wants.
 */
export type GivingKind = 'zakat' | 'sadaqat';

export interface GivingRow {
  id: string; date: string; kind: GivingKind; amount: number; currency: string;
  from: string; categoryId: string; note: string;
}

export function GivingRecords({ only, search, fallback, onRows }: {
  /** which kinds to show; both when it is not said */
  only?: 'all' | GivingKind;
  /** an outside search box, where the screen has one */
  search?: string;
  /** what to show when there is no ledger service behind the screen */
  fallback: GivingRow[];
  /**
   * What this table is actually showing, handed back to the screen around it.
   *
   * A screen that totals giving has to total the same records the table lists. Working them
   * out separately is how a heading came to say nothing was given while the rows underneath
   * it listed payments — two answers to one question, and no way for a reader to tell which
   * of them is the ledger's.
   */
  onRows?: (rows: GivingRow[]) => void;
}) {
  const { data, currencies } = useApp();

  const { live, version } = useLive();

  const cats = data.categories.filter((c) => c.domain === 'charity');
  const cInfo = (id: string) => cats.find((c) => c.id === id);
  const accountName = (id: string) => {
    const n = data.nodes.find((x) => x.id === id);
    const inst = data.institutions.find((i) => i.id === n?.parentId);
    return n ? `${inst?.name ? `${inst.name} · ` : ''}${n.name}` : '—';
  };
  /** every account giving can leave, drawn in the filter the way the picker draws them */
  const accountChoices = () => data.nodes.filter((n) => n.kind === 'cash')
    .map((n) => accountOption(data, n, { value: accountName(n.id) }));

  const [live_, setLive_] = useState<GivingRow[] | null>(null);
  const loadGiving = useCallback(() => {
    if (!live) { setLive_(null); return; }
    (ledger as any)['giving.list']({})
      .then((rs: any[]) => setLive_(rs.map((c) => ({
        id: c.id, date: c.date, kind: (c.isZakat ? 'zakat' : 'sadaqat') as GivingKind,
        amount: c.amount, currency: c.currency, from: c.accountId ?? '',
        categoryId: c.causeId, note: c.note ?? '',
      }))))
      .catch(() => setLive_(null));
  }, [live]);
  useEffect(loadGiving, [loadGiving, version]);

  const rows = (live_ ?? fallback).slice().sort((a, b) => b.date.localeCompare(a.date));
  // Reported after the render that used them, so the screen around this one never totals a
  // list the table has not drawn.
  useEffect(() => { onRows?.(rows); }, [live_, fallback, onRows]);
  const q = (search ?? '').trim().toLowerCase();
  const matching = rows
    .filter((r) => !only || only === 'all' || r.kind === only)
    .filter((r) => !q || `${r.note} ${cInfo(r.categoryId)?.name ?? ''} ${accountName(r.from)}`
      .toLowerCase().includes(q));

  return (
      <RecordTable
        rows={matching}
        rowKey={(r) => r.id}
        sort={{ key: 'date', dir: 'desc' }}
        empty={{ icon: 'hands', title: 'Nothing given yet',
               body: 'Giving comes out of an account on the day it happened.' }}
        columns={[
          { key: 'date', label: 'Date', kind: 'date',
            value: (r) => r.date,
            cell: (r) => <span className="mono" style={{ fontSize: 13 }}>{r.date}</span>,
            field: (d, set) => <DateField value={d.date ?? ''} ariaLabel="Date" hijri
                                  onChange={(v) => set({ date: v })} /> },
          { key: 'kind', label: 'Type', kind: 'pick',
            value: (r) => (r.kind === 'zakat' ? 'Zakat' : 'Sadaqat'),
            cell: (r) => {
            const t = r.kind === 'zakat' ? 'var(--zakat)' : 'var(--sadaqat)';
            return (
              <span className="chip" style={{
                background: `color-mix(in srgb, ${t} var(--tint), transparent)`, color: t,
                display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Icon name={r.kind === 'zakat' ? 'zakat' : 'hands'} size={12} color={t} />
                {r.kind === 'zakat' ? 'Zakat' : 'Sadaqat'}
              </span>
            );
            },
            field: (d, set) => (
            <Select ariaLabel="Zakat or sadaqat" value={d.isZakat ? 'zakat' : 'sadaqat'}
                  onChange={(v) => set({ isZakat: v === 'zakat' })}
                  options={[{ value: 'zakat', label: 'Zakat', hint: 'counts against the obligation' },
                          { value: 'sadaqat', label: 'Sadaqat', hint: 'given freely' }]} />
            ) },
          { key: 'amount', label: 'Amount', kind: 'money',
            value: (r) => toEgp(r.amount, r.currency, market),
            // Given in the currency the account is held in is not an exchange, and was being
            // restated in the reader's currency as though it were.
            cell: (r) => <RecordAmount amount={r.amount} currency={r.currency} accountId={r.from} />,
            field: (d, set) => (
            <span className="field-money">
              <Amount value={d.amount ?? 0} ariaLabel="Amount" onChange={(n) => set({ amount: n })} />
              <Select ariaLabel="Currency" value={d.currency ?? 'EGP'} style={{ width: 88 }}
                    onChange={(v) => set({ currency: v })}
                    options={currencies.map((c) => ({ value: c.code, label: c.code }))} />
            </span>
            ) },
          { key: 'from', label: 'Paid from', kind: 'pick',
            value: (r) => accountName(r.from),
            choices: accountChoices(),
            cell: (r) => (
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                <AccountLine id={r.from} />
              </span>
            ),
            field: (d, set) => (
            <Select ariaLabel="Paid from" value={d.accountId ?? ''}
                  onChange={(v) => set({ accountId: v })}
                  options={data.nodes.filter((n) => n.kind === 'cash')
                    .map((n) => accountOption(data, n))} />
            ) },
          { key: 'to', label: 'Went to', kind: 'pick',
            value: (r) => cInfo(r.categoryId)?.name ?? r.categoryId,
            cell: (r) => {
            const c = cInfo(r.categoryId);
            return (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 24, height: 24, borderRadius: 7, flex: '0 0 24px',
                           display: 'flex', alignItems: 'center', justifyContent: 'center',
                           background: `color-mix(in srgb, ${c?.color ?? 'var(--muted)'} var(--tint), transparent)` }}>
                  <Icon name={(c?.icon as IconName) ?? 'charity'} size={13} color={c?.color ?? 'var(--muted)'} />
                </span>
                <span style={{ fontSize: 13 }}>{c?.name ?? r.categoryId}</span>
              </span>
            );
            },
            field: (d, set) => (
            <Select ariaLabel="Went to" value={d.causeId ?? ''}
                  onChange={(v) => set({ causeId: v })}
                  options={cats.map((c) => ({ value: c.id, label: c.name,
                                             icon: c.icon, iconColor: c.color }))} />
            ) },
          { key: 'note', label: 'Note', kind: 'text',
            value: (r) => r.note,
            cell: (r) => <span style={{ fontSize: 13, color: 'var(--muted)' }}>
            {r.note || <span style={{ color: 'var(--faint)' }}>—</span>}</span>,
            field: (d, set) => <input aria-label="Note" placeholder="what it was for"
                              value={d.note ?? ''}
                              onChange={(e) => set({ note: e.target.value })} /> },
        ]}
        add={{
          label: 'Record giving',
          capability: 'giving.record',
          blank: { date: new Date().toISOString().slice(0, 10), amount: 0, currency: 'EGP',
                 accountId: data.settings.burnAccountId, causeId: cats[0]?.id ?? '',
                 isZakat: false, note: '' },
          valid: (d) => Number(d.amount) > 0 && !!d.accountId && !!d.causeId,
          build: (d) => ({ accountId: d.accountId, amount: Number(d.amount),
                       currency: d.currency, causeId: d.causeId,
                       isZakat: !!d.isZakat, date: d.date, note: d.note || undefined }),
          onDone: loadGiving,
        }}
        edit={{
          capability: 'giving.correct',
          draftOf: (r) => ({ date: r.date, amount: r.amount, currency: r.currency,
                         accountId: r.from, causeId: r.categoryId,
                         isZakat: r.kind === 'zakat', note: r.note }),
          build: (d, r) => ({ givingId: r.id, accountId: d.accountId || undefined,
                        amount: Number(d.amount), currency: d.currency,
                        causeId: d.causeId, isZakat: !!d.isZakat,
                        date: d.date, note: d.note ?? '' }),
          blocked: () => (live_ ? undefined
            : 'This screen is showing the figures it ships with. Start the ledger to correct one.'),
          onDone: loadGiving,
        }}
        remove={{
          capability: 'giving.remove',
          build: (r) => ({ givingId: r.id }),
          keep: { label: 'Just remove the record',
                  build: (r) => ({ givingId: r.id, reverse: false }) },
          what: (r) => `${r.kind === 'zakat' ? 'zakat' : 'sadaqat'} of ${money(r.amount, r.currency)} on ${r.date}`,
          blocked: () => (live_ ? undefined
            : 'This screen is showing the figures it ships with. Start the ledger to remove one.'),
          onDone: loadGiving,
        }}
        clear={{ log: 'giving',
                 what: 'every record of giving, zakat and sadaqat alike, and the movements behind them',
                 onDone: loadGiving }}
      />
  );
}
