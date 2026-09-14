import { useCallback, useEffect, useState } from 'react';
import { Panel, Toggle, Chip } from './UI';
import { Icon, type IconName } from './Icon';
import { Select, opts } from './Select';
import { useLive } from '../Live';
import { ledger } from '../api';

/**
 * Where the outside numbers come from.
 *
 * Four figures cannot be known from inside a ledger — what a currency is worth, what a gram
 * of gold or silver is worth, and what a share last traded at. Each is taken from a source,
 * and this is where the owner says which.
 *
 * What is offered is a choice between people, not between endpoints. A source says who
 * publishes it, what its number actually is, and how far behind it runs, because that is the
 * whole of the decision: the central bank or the market, the dealer down the road or the
 * world price. Nothing here asks for a URL or a key — those are decisions with security and
 * correctness consequences that a settings form cannot fairly explain, so they stay in the
 * code where they can be reviewed.
 *
 * Every source includes typing it in yourself, which fetches nothing. That is not a fallback
 * for a broken feature: for silver in a Cairo shop it may well be the most accurate answer
 * available, and the ledger should not pretend otherwise.
 */
interface Option { id: string; label: string; what: string; cadence: string; manual: boolean }
interface Last { at: string; source: string; ok: boolean; note: string; wrote: number }
interface SubjectRow {
  id: string; label: string; hint: string; chosen: string; options: Option[]; last: Last | null;
}
interface Sources {
  base: string; fallback: boolean; refreshHours: number; subjects: SubjectRow[];
}

const MARK: Record<string, { icon: IconName; color: string }> = {
  fx: { icon: 'banknote', color: 'var(--cash)' },
  gold: { icon: 'gold', color: 'var(--gold)' },
  silver: { icon: 'coins', color: 'var(--muted)' },
  stocks: { icon: 'stocks', color: 'var(--stocks)' },
};

export function PriceSources() {
  const { run, live, version, running } = useLive();
  const [state, setState] = useState<Sources | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!live) return;
    (ledger as any)['market.sources']({})
      .then((s: Sources) => { setState(s); setProblem(null); })
      // A read that fails has to say so. Leaving the panel empty is the one outcome that
      // tells the reader nothing: it looks identical to a ledger with no sources at all.
      .catch((e: Error) => setProblem(e?.message || 'the ledger did not answer'));
  }, [live]);
  useEffect(load, [load, version]);

  const choose = async (subject: string, source: string) => {
    await run('market.chooseSource', { subject, source });
    load();
  };
  const fetchNow = async (subject?: string) => {
    await run('market.refresh', subject ? { subject } : {});
    load();
  };

  if (!live) {
    return (
      <Panel title="Where each price comes from"
             hint="Choosing a source is a decision the back end carries out, so this needs the server running. Without one the interface shows the figures it ships with.">
        <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
          Start the ledger’s own server and this becomes a list of sources to pick from — the
          Central Bank or the market for a rate, Cairo dealers or the world price for gold.
        </p>
      </Panel>
    );
  }

  if (problem || !state) {
    return (
      <Panel title="Where each price comes from"
             hint="The list of sources comes from the ledger itself, and it has not answered.">
        <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
          {problem
            ? <>Asking for the sources failed: <span className="mono">{problem}</span>. Check that
              the ledger’s own server is the one this interface is reaching — in development the
              dev server proxies to whatever port it was pointed at, and another project answering
              there will refuse this call.</>
            : 'Reading the sources…'}
        </p>
        <button className="btn ghost" onClick={load} style={{ marginTop: 14 }}>Try again</button>
      </Panel>
    );
  }

  return (
    <>
      <Panel
        title="Where each price comes from"
        hint={`A ledger cannot know these from the inside. Pick who you would rather believe for each — every option says what its number actually is, and one of them is always you. Everything is quoted in ${state.base}.`}
        action={
          <button className="btn" disabled={running != null} onClick={() => fetchNow()}>
            <Icon name="refresh" size={14} motion="none" />
            {running ? 'Fetching…' : 'Fetch everything now'}
          </button>
        }>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {state.subjects.map((s) => (
            <SubjectCard key={s.id} row={s} busy={running != null}
                         onChoose={(id) => choose(s.id, id)} onFetch={() => fetchNow(s.id)} />
          ))}
        </div>
      </Panel>

      <Habits state={state} onSave={(patch) => run('market.autoRefresh', patch).then(load)} />
    </>
  );
}

/**
 * One subject, its sources, and how the last attempt went.
 *
 * The last attempt is shown whether or not it succeeded, and it names the source that
 * actually answered. That matters when standing in is on: a figure that came from somewhere
 * other than the source you picked should say so on the screen rather than only in a log.
 */
function SubjectCard({ row, busy, onChoose, onFetch }: {
  row: SubjectRow; busy: boolean; onChoose: (id: string) => void; onFetch: () => void;
}) {
  const mark = MARK[row.id] ?? { icon: 'currency' as IconName, color: 'var(--muted)' };
  const stoodIn = row.last && row.last.ok && row.last.source !== row.chosen;

  return (
    <div style={{
      borderRadius: 'var(--r-card)', background: 'var(--raised)',
      border: '1px solid var(--hairline)', padding: '16px 17px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 14 }}>
        <span style={{
          width: 34, height: 34, borderRadius: 9, flex: '0 0 34px',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: `color-mix(in srgb, ${mark.color} 15%, transparent)`,
        }}>
          <Icon name={mark.icon} color={mark.color} size={18} />
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 500 }}>{row.label}</div>
          <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 2 }}>{row.hint}</div>
        </div>
        <button className="btn ghost" disabled={busy} onClick={onFetch}
                style={{ marginLeft: 'auto', fontSize: 12, padding: '7px 12px' }}>
          Fetch now
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 9 }}>
        {row.options.map((o) => {
          const on = o.id === row.chosen;
          return (
            <button key={o.id} onClick={() => onChoose(o.id)} aria-pressed={on} disabled={busy}
              style={{
                textAlign: 'left', cursor: busy ? 'default' : 'pointer', padding: '12px 13px',
                borderRadius: 'var(--r-sm)', background: on ? 'var(--control)' : 'transparent',
                border: `1px solid ${on ? 'color-mix(in srgb, var(--ink) 22%, transparent)' : 'var(--hairline)'}`,
                boxShadow: on ? 'var(--shadow-sm)' : 'none',
                transition: 'background 150ms var(--ease), border-color 150ms var(--ease)',
              }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <span style={{
                  width: 13, height: 13, borderRadius: 999, flex: '0 0 13px',
                  border: `1px solid ${on ? 'var(--ink)' : 'var(--hairline)'}`,
                  background: on ? 'var(--ink)' : 'transparent',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  {on && <span style={{ width: 5, height: 5, borderRadius: 999, background: 'var(--paper)' }} />}
                </span>
                <span style={{ fontSize: 13, fontWeight: on ? 500 : 400 }}>{o.label}</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.5, marginTop: 7 }}>{o.what}</div>
              <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 5 }}>{o.cadence}</div>
            </button>
          );
        })}
      </div>

      {row.last && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 13, flexWrap: 'wrap' }}>
          <Chip tone={row.last.ok ? (stoodIn ? 'warn' : 'good') : 'bad'}>
            {row.last.ok ? (row.last.wrote ? `${row.last.wrote} recorded` : 'nothing to record') : 'could not'}
          </Chip>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>{row.last.note}</span>
          <span style={{ fontSize: 11, color: 'var(--faint)', marginLeft: 'auto' }}>{ago(row.last.at)}</span>
        </div>
      )}
    </div>
  );
}

/**
 * Whether to go and look without being asked, and what to do when a source is silent.
 *
 * Standing in is worth a decision rather than a default, because it trades one thing for
 * another: a figure always present, against a figure that quietly came from somewhere other
 * than the source you chose. It is on, and it says so wherever it happened.
 */
function Habits({ state, onSave }: { state: Sources; onSave: (patch: Record<string, unknown>) => void }) {
  return (
    <Panel title="Going to look on its own"
           hint="Between visits every total rests on the last figure recorded, which is why each one carries the moment it was taken.">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
          padding: '13px 15px', borderRadius: 'var(--r-card)',
          background: 'var(--raised)', border: '1px solid var(--hairline)',
        }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 500 }}>How often</div>
            <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 2 }}>
              Only the sources you chose are asked, and only the figures this ledger actually holds.
            </div>
          </div>
          <Select ariaLabel="How often to fetch" style={{ width: 180 }}
                  value={String(state.refreshHours)}
                  onChange={(v) => onSave({ every: Number(v) })}
                  options={opts([
                    'Never — only when I ask', 'Every hour', 'Every 6 hours',
                    'Every 12 hours', 'Once a day',
                  ]).map((o, i) => ({ ...o, value: ['0', '1', '6', '12', '24'][i]! }))} />
        </div>

        <div style={{
          padding: '13px 15px', borderRadius: 'var(--r-card)',
          background: 'var(--raised)', border: '1px solid var(--hairline)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 500 }}>Stand in when a source is silent</div>
              <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 2 }}>
                {state.fallback ? 'On — and whoever answered is named above.' : 'Off — a silent source leaves that figure where it was.'}
              </div>
            </div>
            <Toggle on={state.fallback} label="Stand in when a source is silent"
                    onChange={(v) => onSave({ standIn: v })} />
          </div>
          <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 10, lineHeight: 1.55 }}>
            A page that has been redesigned, or a service having a bad afternoon, otherwise
            leaves that figure at whatever it was. With this on the other sources for the same
            subject are tried in turn, and the one that answered is named above rather than
            passed off as your choice.
          </div>
        </div>
      </div>
    </Panel>
  );
}

function ago(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
