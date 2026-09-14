import { useState } from 'react';
import { useApp, market } from '../AppState';
import { money, toEgp } from '@ledger/engine';
import { Page, Panel, Stat, Stats, Chip } from '../components/UI';
import { Icon, type IconName } from '../components/Icon';
import { GivingRecords, type GivingRow } from '../components/GivingRecords';
import { ModeBar, ModeProvider } from '../components/ModeBar';

type Kind = 'zakat' | 'sadaqat';

type Row = GivingRow;

/** Both kinds in one list, because what you actually want to know is what left in total. */
const EXTRA: Row[] = [
  { id: 'g1', date: '2026-08-22', kind: 'sadaqat', amount: 3000, currency: 'EGP',
    from: 'nile-egp-cur', categoryId: 'cha-food-aid', note: 'food parcels, shared with a neighbour' },
  { id: 'g2', date: '2026-06-30', kind: 'zakat', amount: 45000, currency: 'EGP',
    from: 'nile-egp-sav', categoryId: 'cha-emergency', note: 'first instalment against the hawl' },
  { id: 'g3', date: '2026-05-14', kind: 'sadaqat', amount: 250, currency: 'USD',
    from: 'nile-usd-sav', categoryId: 'cha-education', note: 'school fees for a relative' },
];

/**
 * Correcting a record is not recording one, so this screen carries the same switch as every
 * other that shows a log — without it the table had nowhere to put its pencil, and reached
 * for a mode that was not there.
 */
export function GivingLog() {
  return <ModeProvider><Body /></ModeProvider>;
}

function Body() {
  const { data, dm } = useApp();
  const [kind, setKind] = useState<'all' | Kind>('all');
  const [q, setQ] = useState('');

  /** what the screen shows when there is no ledger behind it */
  const rows: Row[] = [
    ...data.charity.map((c) => ({
      id: c.id, date: c.date, kind: (c.isZakat ? 'zakat' : 'sadaqat') as Kind,
      amount: c.usd ?? c.egp, currency: c.usd != null ? 'USD' : 'EGP',
      from: 'nile-egp-cur', categoryId: c.categoryId, note: c.note,
    })),
    ...EXTRA,
  ].sort((a, b) => b.date.localeCompare(a.date));

  const totalOf = (k: Kind) => rows.filter((r) => r.kind === k)
    .reduce((s, r) => s + toEgp(r.amount, r.currency, market), 0);

  return (
    <Page>
      <Panel>
        <Stats>
          <Stat label="Given, all time" value={dm(totalOf('zakat') + totalOf('sadaqat'))} sub={`${rows.length} payment${rows.length === 1 ? '' : 's'}`} />
          <Stat label="As zakat" value={dm(totalOf('zakat'))} color="var(--zakat)" sub="counts against the obligation" />
          <Stat label="As sadaqat" value={dm(totalOf('sadaqat'))} color="var(--sadaqat)" sub="given freely, owed by nobody" />
          <Stat label="Zakat still to give" value={dm(176743 - totalOf('zakat'))} color="var(--negative)"
                sub="against 176,743 estimated" />
        </Stats>
      </Panel>

      <ModeBar operateHint="Record what was given. Every payment leaves an account on the day it happened."
               editHint="Correct a record — the amount, the account it left, the cause, whether it counted as zakat — or reverse one that never happened." />

      <Panel title="Everything given"
             hint="Both kinds in one list. The type column is the only thing that separates them, and it is the thing that decides whether a payment reduces what you still owe.">
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          {(['all', 'zakat', 'sadaqat'] as const).map((k) => (
            <button key={k} onClick={() => setKind(k)} aria-pressed={kind === k}
              style={{
                fontSize: 13, fontWeight: 500, padding: '7px 14px', cursor: 'pointer',
                borderRadius: 'var(--r-sm)', border: '1px solid var(--hairline)',
                background: kind === k ? 'var(--raised)' : 'transparent',
                color: kind === k ? (k === 'zakat' ? 'var(--zakat)' : k === 'sadaqat' ? 'var(--sadaqat)' : 'var(--ink)') : 'var(--muted)',
              }}>
              {k === 'all' ? 'Both' : k === 'zakat' ? 'Zakat only' : 'Sadaqat only'}
            </button>
          ))}
        </div>

        <GivingRecords only={kind} search={q} fallback={rows} />
      </Panel>
    </Page>
  );
}
