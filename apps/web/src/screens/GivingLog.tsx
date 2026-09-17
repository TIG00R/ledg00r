import { useEffect, useMemo, useState } from 'react';
import { useApp, market } from '../AppState';
import { toEgp } from '@ledger/engine';
import { Page, Panel, Stat, Stats } from '../components/UI';
import { GivingRecords, type GivingRow } from '../components/GivingRecords';
import { ModeBar, ModeProvider } from '../components/ModeBar';
import { useLive } from '../Live';
import { ledger } from '../api';

type Kind = 'zakat' | 'sadaqat';

type Row = GivingRow;

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
  const { live, version } = useLive();
  const [kind, setKind] = useState<'all' | Kind>('all');
  const [q] = useState('');

  /**
   * What the screen shows with no ledger behind it: a ledger with no records in it.
   *
   * Held steady across renders on purpose. The table hands its rows back up, which sets state
   * here, which renders again — and a fallback rebuilt each time would be a new array every
   * render and so a loop that never settles.
   */
  const fallback: Row[] = useMemo(() => data.charity.map((c) => ({
    id: c.id, date: c.date, kind: (c.isZakat ? 'zakat' : 'sadaqat') as Kind,
    amount: c.usd ?? c.egp, currency: c.usd != null ? 'USD' : 'EGP',
    from: data.settings.burnAccountId, categoryId: c.categoryId, note: c.note,
  })), [data.charity, data.settings.burnAccountId]);

  /**
   * The totals are the table's own rows, added up.
   *
   * They used to be worked out from a separate list that carried three invented payments, so
   * a ledger that had given nothing announced sixty thousand given and forty-five thousand of
   * it as zakat. A heading over a table has to be that table's arithmetic, or it is somebody
   * else's money on a reader's screen.
   */
  const [shown, setShown] = useState<Row[]>(fallback);
  const rows = shown;
  const totalOf = (k: Kind) => rows.filter((r) => r.kind === k)
    .reduce((s, r) => s + toEgp(r.amount, r.currency, market), 0);

  /**
   * What is still owed, from the years actually confirmed.
   *
   * Not an estimate of what this year might come to: a year still running owes nothing yet,
   * and a figure that mixes the two tells an owner to pay something nobody is owed.
   */
  const [outstanding, setOutstanding] = useState<number | null>(null);
  useEffect(() => {
    if (!live) { setOutstanding(null); return; }
    let off = false;
    (ledger as any)['zakat.years']({})
      .then((ys: Array<{ remaining: number }>) => {
        if (!off) setOutstanding((ys ?? []).reduce((s, y) => s + y.remaining, 0));
      })
      .catch(() => { if (!off) setOutstanding(null); });
    return () => { off = true; };
  }, [live, version]);

  return (
    <Page>
      <Panel>
        <Stats>
          <Stat label="Given, all time" value={dm(totalOf('zakat') + totalOf('sadaqat'))} sub={`${rows.length} payment${rows.length === 1 ? '' : 's'}`} />
          <Stat label="As zakat" value={dm(totalOf('zakat'))} color="var(--zakat)" sub="counts against the obligation" />
          <Stat label="As sadaqat" value={dm(totalOf('sadaqat'))} color="var(--sadaqat)" sub="given freely, owed by nobody" />
          <Stat label="Zakat still to give"
                value={outstanding == null ? '—' : dm(outstanding)}
                color={outstanding ? 'var(--negative)' : 'var(--muted)'}
                sub={outstanding == null ? 'needs the ledger service'
                  : outstanding > 0 ? 'across every year you have confirmed'
                    : 'every confirmed year is discharged'} />
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

        <GivingRecords only={kind} search={q} fallback={fallback} onRows={setShown} />
      </Panel>
    </Page>
  );
}
