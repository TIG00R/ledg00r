import { useCallback, useEffect, useState } from 'react';
import { ledger } from '../api';
import { useLive } from '../Live';
import { Panel, Row, Empty, Field } from './UI';
import { Icon } from './Icon';
import { ClearAll } from './ClearAll';
import { ConfirmModal } from './Confirm';

/**
 * Taking things away.
 *
 * Everywhere else in this application removing something is a correction: the movement behind
 * a record is reversed, the log keeps both rows, and what happened goes on being readable.
 * This screen is the other thing entirely, and it is on a page of its own for that reason —
 * these three controls erase, and a control that erases should not sit next to one that
 * renames a bank.
 *
 * They are arranged by how much they take, and each says what it takes before it is pressed.
 */

/** The words that have to be typed before the whole ledger goes. Matched exactly. */
const PHRASE = 'DESTROY EVERYTHING';

interface Count { log: string; label: string; what: string; count: number;
  /** whether this log's records stand on movements, so clearing it asks which is meant */
  movements?: boolean }

export function DataSettings() {
  const { live, version, run, running } = useLive();
  const [counts, setCounts] = useState<Count[] | null>(null);

  const load = useCallback(() => {
    if (!live) { setCounts(null); return; }
    (ledger as any)['records.counts']({})
      .then((rows: Count[]) => setCounts(rows))
      .catch(() => setCounts([]));
  }, [live]);
  useEffect(load, [load, version]);

  if (!live) {
    return (
      <Panel title="Data">
        <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
          These controls act on the ledger&rsquo;s own database, and there is none behind this
          screen yet. Start the ledger service and they will appear.
        </p>
      </Panel>
    );
  }

  const held = (counts ?? []).filter((c) => c.count > 0);
  const total = held.reduce((n, c) => n + c.count, 0);

  return (
    <>
      <Panel title="Clear a log"
             hint="Emptying a log is not the same as removing a record from it. Removing one reverses the movement behind it and keeps both rows, which is what makes this ledger checkable. Clearing erases: the records go, the movements they stood on go with them, and the balances fall back to what their accounts opened with.">
        {held.length === 0 ? (
          <Empty icon="ledger" title="Every log is empty"
                 body="There is nothing recorded in this ledger yet, so there is nothing here to clear." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {held.map((c) => (
              <Row key={c.log} cols="minmax(0,1fr) 92px 140px" style={{
                padding: '13px 15px', borderRadius: 'var(--r-card)',
                background: 'var(--raised)', border: '1px solid var(--hairline)',
              }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 500 }}>{c.label}</div>
                  <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 2, lineHeight: 1.5 }}>
                    {c.what}
                  </div>
                </div>
                <span className="mono" style={{ fontSize: 14 }}>
                  {c.count.toLocaleString('en-US')}
                </span>
                <span style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <ClearAll log={c.log} what={c.what} count={c.count} label="Clear"
                            movements={c.movements ?? false} onDone={load} />
                </span>
              </Row>
            ))}
          </div>
        )}
      </Panel>

      {total > 0 && (
        <Panel title="Clear every log at once"
               hint="What is left is the shape you set up rather than anything that happened in it: the banks, the accounts and the balances they opened with, the destinations you spend against, your currencies, your settings and your keys. Everything recorded since is gone.">
          <ClearAll capability="records.clearAll" input={{ confirm: true }}
                    label="Clear every log" count={total} onDone={load}
                    what={`everything in all ${held.length} log${held.length === 1 ? '' : 's'} — every record, and every movement behind one`} />
        </Panel>
      )}

      <Destroy busy={running === 'data.destroy'}
               onDestroy={() => run('data.destroy', { confirm: PHRASE }).then((o) => { if (o.ok) load(); })} />
    </>
  );
}

/**
 * The last one.
 *
 * Two gates, not one. The phrase has to be typed, because a button that only needs a click is
 * a button that gets clicked; and the dialog still asks afterwards, because what is about to
 * happen deserves to be read once in a sentence rather than inferred from a red rectangle.
 */
function Destroy({ onDestroy, busy }: { onDestroy: () => void; busy: boolean }) {
  const [typed, setTyped] = useState('');
  const [asking, setAsking] = useState(false);
  const ready = typed.trim() === PHRASE;

  return (
    <Panel title="Destroy everything"
           style={{ borderColor: 'color-mix(in srgb, var(--negative) 34%, transparent)' }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 18 }}>
        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
                       width: 34, height: 34, borderRadius: 10, flex: '0 0 34px',
                       background: 'color-mix(in srgb, var(--negative) 13%, transparent)' }}>
          <Icon name="warn" size={17} color="var(--negative)" motion="none" />
        </span>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.6 }}>
          <p style={{ margin: 0 }}>
            This empties every table in the database. Every record, every movement, every
            account and every bank; every destination, every budget, every plan and every
            reminder; your currencies, every setting, every access key, every picture you have
            uploaded, the search index, and the log of what was done.
          </p>
          <p style={{ margin: '10px 0 0' }}>
            The database keeps its shape and loses everything in it, so what comes back is a
            ledger nobody has used yet — the empty gold, silver and brokerage holdings included,
            because without those there is nowhere for metal or shares to live at all.
          </p>
          <p style={{ margin: '10px 0 0', color: 'var(--negative)' }}>
            Nothing is kept anywhere, and there is no undo. Take a copy of the database file
            first if the figures matter.
          </p>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <Field label="Type the words to unlock it"
               hint={ready ? 'the button below is live' : `exactly: ${PHRASE}`}>
          <input value={typed} aria-label="Confirmation phrase" placeholder={PHRASE}
                 autoComplete="off" spellCheck={false}
                 onChange={(e) => setTyped(e.target.value)} style={{ minWidth: 240 }} />
        </Field>
        <button className="btn danger" disabled={!ready || busy} onClick={() => setAsking(true)}>
          <Icon name="trash" size={14} motion="none" />
          {busy ? 'Destroying…' : 'Destroy everything'}
        </button>
      </div>

      <ConfirmModal open={asking} onClose={() => setAsking(false)}
        title="Destroy everything in this ledger?"
        confirmLabel="Destroy it all"
        body="Every row of every table goes, including the accounts, the settings and the access keys. What comes back is an empty ledger. This cannot be undone and no copy is kept."
        onConfirm={() => { setTyped(''); onDestroy(); }} />
    </Panel>
  );
}
