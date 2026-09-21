import { useEffect, useMemo, useState } from 'react';
import { useApp, market } from '../AppState';
import { toEgp } from '@ledger/engine';
import { Page, Panel, Stat, Stats } from '../components/UI';
import { GivingRecords, type GivingRow } from '../components/GivingRecords';
import { useLive } from '../Live';
import { ledger } from '../api';

type Kind = 'zakat' | 'sadaqat';

type Row = GivingRow;

/** a year as the zakat log keeps it, for the half of giving that answers to one */
interface LoggedYear {
  id: string; label: string; dueOn: string; dueHijri: string; manual: boolean;
  due: number; paid: number; remaining: number;
}

/**
 * Every gift, zakat and sadaqat together — read here, corrected on the table itself.
 *
 * This screen used to carry the Operate/Edit switch every log-bearing screen carried, purely
 * so the table underneath had a mode to check before it would show its pencil. The table
 * checks nothing now: double-click a row, press Enter with it focused, or press its pencil,
 * and it opens for correction whichever way you got here.
 */
export function GivingLog() {
  return <Body />;
}

function Body() {
  const { data, dm } = useApp();
  const { live, version } = useLive();
  const [kind, setKind] = useState<'all' | Kind>('all');

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
  const [years, setYears] = useState<LoggedYear[]>([]);
  useEffect(() => {
    if (!live) { setYears([]); return; }
    let off = false;
    (ledger as any)['zakat.years']({})
      .then((ys: LoggedYear[]) => { if (!off) setYears(ys ?? []); })
      .catch(() => { if (!off) setYears([]); });
    return () => { off = true; };
  }, [live, version]);
  const outstanding = live ? years.reduce((s, y) => s + y.remaining, 0) : null;

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

      <Panel title="Everything given"
             hint="Both kinds in one list. The type column is the only thing that separates them, and it is the thing that decides whether a payment reduces what you still owe. Double-click a row to correct it, or to reverse one that never happened.">
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

        <GivingRecords only={kind} fallback={fallback} onRows={setShown} />
      </Panel>

      {/*
        * The years the giving answers to.
        *
        * Half of what is given is given against something: a lunar year that closed owing a
        * figure. The list above is every payment and says nothing about what they were for,
        * and the years lived on another screen entirely — so "have I paid what I owed" could
        * only be answered by reading two pages and doing the subtraction. A year typed in by
        * hand has no payments to list at all; what it remembers being paid is the only record
        * of it there is, and it belongs where giving is read.
        */}
      {years.length > 0 && (
        <Panel title="The years this answers to"
               hint="What each closed lunar year owed, what has been given against it, and what is left. Corrected on the zakat screen, where the years are kept.">
          <div className="rt-wrap">
            <table className="rt">
              <thead>
                <tr>
                  <th className="rt-h">Year to</th>
                  <th className="rt-h">Owed</th>
                  <th className="rt-h">Given against it</th>
                  <th className="rt-h">Still to pay</th>
                </tr>
              </thead>
              <tbody>
                {years.map((y) => (
                  <tr key={y.id}>
                    <td className="rt-c">
                      <span className="mono public" style={{ fontSize: 13 }}>{y.dueOn}</span>
                      <span className="at-bank">
                        {y.dueHijri}{y.manual ? ' · typed in' : ''}
                      </span>
                    </td>
                    <td className="mono rt-c">{dm(y.due)}</td>
                    <td className="mono rt-c">{dm(y.paid)}</td>
                    <td className="mono rt-c" style={{ fontWeight: 600,
                                                       color: y.remaining > 0 ? 'var(--negative)' : 'var(--positive)' }}>
                      {y.remaining > 0 ? dm(y.remaining) : 'discharged'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </Page>
  );
}
