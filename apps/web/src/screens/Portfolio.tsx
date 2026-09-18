import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../AppState';
import { useLive } from '../Live';
import { ledger } from '../api';
import { money, type Currency } from '@ledger/engine';
import { Donut } from '../components/Donut';
import { Icon } from '../components/Icon';
import { Chip } from '../components/UI';
import { Amount } from '../components/Amount';
import { ConfirmDelete } from '../components/Confirm';
import { Segmented } from '../components/Segmented';
import { isInteractive } from '../components/RecordTable';
import { useAppearance, type AssetKey } from '../Appearance';
import { MarketPanel, UpcomingPanel } from '../components/Shell';

export function Portfolio({ onNavigate }: { onNavigate: (id: string) => void }) {
  const { values: v, dm, display } = useApp();
  const { appearance } = useAppearance();
  const style = (k: AssetKey) => appearance.assets[k];
  const a = v.accrual;

  /**
   * The piles, and only the piles that hold something.
   *
   * Every category used to be drawn whether or not anything was in it, so a ledger with one
   * car in it still showed Real estate, Gold and Stocks at nothing — five headings standing
   * in for holdings nobody had entered. What is drawn now is what is held; a thing that is
   * none of the named kinds lands in "Other", which is a pile rather than a silence:
   * before it existed such a thing counted towards the total and appeared in no line at all.
   *
   * Money lent out is one of the named kinds. It is owned — a debt owed to you is wealth you
   * happen not to be holding — but it is not a chattel, and reading it as one drew a loan to
   * a friend in the pile with the machines.
   */
  const slices = ([
    ['cash', v.cash], ['realestate', v.re], ['gold', v.gold], ['car', v.car],
    ['stocks', v.stocks], ['debt', v.debt], ['other', v.other],
  ] as Array<[AssetKey, number]>)
    .filter(([, value]) => value !== 0)
    .map(([key, value]) => ({
      key, value, label: style(key).label, color: style(key).color,
    }));

  return (
    <main style={{ padding: 24, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 300px',
                   gap: 20, alignItems: 'start', maxWidth: 1440, margin: '0 auto', width: '100%' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20, minWidth: 0 }}>

        {/* The overview is one chart and its legend. The strip that used to sit here said the
            same thing as the ring further down the page, and the list under that said it a
            third time — so the shares are drawn once, as a ring, with the figures beneath it. */}
        <section className="panel" style={{ padding: '32px 28px' }}>
          <div style={{ textAlign: 'center' }}>
            <div className="ov">Total net worth</div>
            <div className="mono" style={{ fontSize: 46, fontWeight: 500, letterSpacing: '-0.03em',
                                           margin: '10px 0 6px', lineHeight: 1 }}>
              {dm(v.total)}
            </div>
            {/* No rate is not a rate of zero: until one has been recorded there is nothing
                to convert at, and the line says nothing rather than saying NaN. */}
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>
              {v.rate > 0
                ? display === 'EGP'
                  ? `≈ ${money(v.total / v.rate, 'USD')} at ${v.rate.toFixed(4)}`
                  : `${money(v.total, 'EGP')} at ${v.rate.toFixed(4)}`
                : 'no rate recorded yet'}
            </div>
          </div>

          {slices.length === 0 ? (
            <p style={{ margin: '26px 0 4px', textAlign: 'center', fontSize: 13,
                        color: 'var(--faint)' }}>
              Nothing is held yet. What you add under Accounts, Assets, Gold and Stocks is
              what this splits.
            </p>
          ) : (
          <div style={{ display: 'flex', justifyContent: 'center', margin: '26px 0 22px' }}>
            <Donut slices={slices} size={236} thickness={32} format={(n) => dm(n)}
                   centre={<span style={{ fontSize: 12, color: 'var(--faint)' }}>
                     Point at a slice to name it
                   </span>} />
          </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 16 }}>
            {slices.map((s) => (
              <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                <span style={{
                  width: 34, height: 34, borderRadius: 9, flex: '0 0 34px',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: `color-mix(in srgb, ${s.color} 15%, transparent)`,
                }}>
                  <Icon name={style(s.key).icon} color={s.color} size={18} />
                </span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>{s.label}</div>
                  <div className="mono" style={{ fontSize: 15, fontWeight: 500 }}>{dm(s.value)}</div>
                  <div style={{ fontSize: 11, color: 'var(--faint)' }}>
                    {/* nothing is not 0% of nothing; a ledger holding nothing has no shares */}
                    {v.total > 0 ? `${((s.value / v.total) * 100).toFixed(1)}%` : '—'}
                    {s.key === 'gold' ? ` · ${a.goldGrams.toFixed(1)} g` : ''}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        <WealthTimeline />
      </div>

      <aside style={{ display: 'flex', flexDirection: 'column', gap: 20, position: 'sticky', top: 82 }}>
        <MarketPanel />
        <UpcomingPanel onNavigate={onNavigate} />
      </aside>
    </main>
  );
}

interface Statement {
  id: string; date: string; month: string; currency: string;
  netWorth: number; source: 'auto' | 'manual'; note: string | null;
}

interface Point { key: string; date: string; netWorth: number; currency: string; source: 'auto' | 'manual' }

type Span = 'month' | 'year' | 'all';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const labelFor = (span: Span, key: string) => {
  if (span === 'month') return String(Number(key.slice(8, 10)));
  if (span === 'year') return MONTHS[Number(key.slice(5, 7)) - 1];
  return key;
};

/**
 * What things were worth, over time.
 *
 * `portfolio.overview` above answers what is held right now, and the answer moves every time
 * a price does — asking again tomorrow gives a different figure for today. This reads
 * `wealth.statement.series` instead: one frozen point a day, written by the scheduler alone
 * at the day's first tick — nothing else creates one. A point does not move once it is drawn;
 * only a deliberate correction, on the raw row below, changes what it reads.
 */
function WealthTimeline() {
  const { live, version, run } = useLive();
  const [span, setSpan] = useState<Span>('month');
  const [series, setSeries] = useState<{ span: Span; points: Point[] } | null>(null);
  const [rows, setRows] = useState<Statement[] | null>(null);

  const loadSeries = useCallback(() => {
    if (!live) { setSeries(null); return; }
    (ledger as any)['wealth.statement.series']({ span }).then(setSeries).catch(() => setSeries(null));
  }, [live, span]);
  useEffect(loadSeries, [loadSeries, version]);

  const loadRows = useCallback(() => {
    if (!live) { setRows(null); return; }
    (ledger as any)['wealth.statement.list']({}).then(setRows).catch(() => setRows([]));
  }, [live]);
  useEffect(loadRows, [loadRows, version]);

  if (!live) return null;

  const points = series?.points ?? [];

  return (
    <section className="panel" style={{ padding: '24px 26px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Wealth timeline</div>
          <div style={{ fontSize: 12, color: 'var(--faint)' }}>
            What everything owned came to, saved once a day on its own.
          </div>
        </div>
        <Segmented<Span> value={span} onChange={setSpan} ariaLabel="Over what span"
          options={[
            { id: 'month', label: 'This month', icon: 'calendar', tone: 'var(--positive)' },
            { id: 'year', label: 'This year', icon: 'span', tone: 'var(--positive)' },
            { id: 'all', label: 'All time', icon: 'ledger', tone: 'var(--positive)' },
          ]} />
      </div>

      {points.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
          Nothing is saved yet. The first point is written automatically, once the day rolls
          over — there is nothing to press to start it sooner.
        </p>
      ) : (
        <AreaAxis span={span} points={points} />
      )}

      {rows && rows.length > 0 && (
        <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--hairline)',
                      display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[...rows].reverse().slice(0, 14).map((r) => (
            <StatementRow key={r.id} row={r} run={run} onDone={() => { loadRows(); loadSeries(); }} />
          ))}
          {rows.length > 14 && (
            <span style={{ fontSize: 11, color: 'var(--faint)' }}>
              and {rows.length - 14} earlier day{rows.length - 14 === 1 ? '' : 's'}, not shown here
            </span>
          )}
        </div>
      )}
    </section>
  );
}

const PLOT_H = 140;
const PAD_X = 8;

/**
 * The area itself, drawn from whatever points the span handed back.
 *
 * The path is built in a fixed-size box and stretched to the panel's width with
 * `preserveAspectRatio="none"`, which is what lets one point read as a flat line across the
 * full width instead of collapsing to a dot in the corner.
 */
function AreaAxis({ span, points }: { span: Span; points: Point[] }) {
  const values = points.map((p) => p.netWorth);
  const max = Math.max(...values);
  const min = Math.min(0, ...values);
  const range = max - min || 1;
  const w = 600;
  const n = points.length;
  const x = (i: number) => (n === 1 ? 0 : PAD_X + (i / (n - 1)) * (w - PAD_X * 2));
  const y = (v: number) => PLOT_H - ((v - min) / range) * (PLOT_H - 10) - 4;

  // One point has nothing to interpolate between, so it is drawn as a flat line the full
  // width of the panel — a level held steady rather than a dot alone in the middle of nothing,
  // which is what a single-vertex path degenerates to and reads as an empty chart.
  const line = n === 1
    ? `M 0 ${y(points[0]!.netWorth)} L ${w} ${y(points[0]!.netWorth)}`
    : points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(p.netWorth)}`).join(' ');
  const area = n === 1
    ? `M 0 ${y(points[0]!.netWorth)} L ${w} ${y(points[0]!.netWorth)} L ${w} ${PLOT_H} L 0 ${PLOT_H} Z`
    : `${line} L ${x(n - 1)} ${PLOT_H} L ${x(0)} ${PLOT_H} Z`;
  const last = points[points.length - 1]!;
  const first = points[0]!;
  const rising = last.netWorth >= first.netWorth;

  return (
    <div>
      <svg viewBox={`0 0 ${w} ${PLOT_H}`} preserveAspectRatio="none"
           style={{ width: '100%', height: PLOT_H, display: 'block', overflow: 'visible' }}>
        <defs>
          <linearGradient id="wealth-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={rising ? 'var(--positive)' : 'var(--negative)'} stopOpacity="0.35" />
            <stop offset="100%" stopColor={rising ? 'var(--positive)' : 'var(--negative)'} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#wealth-area)" stroke="none" />
        <path d={line} fill="none" stroke={rising ? 'var(--positive)' : 'var(--negative)'}
              strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"
              vectorEffect="non-scaling-stroke" />
        {points.map((p, i) => (
          <circle key={p.key} cx={n === 1 ? w / 2 : x(i)} cy={y(p.netWorth)} r={n > 40 ? 0 : 3}
                  fill={p.source === 'manual' ? 'var(--gold)' : (rising ? 'var(--positive)' : 'var(--negative)')}>
            <title>{`${p.date}: ${money(p.netWorth, p.currency as Currency)}${p.source === 'manual' ? ' (by hand)' : ''}`}</title>
          </circle>
        ))}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6,
                    fontSize: 10, color: 'var(--faint)' }}>
        <span>{labelFor(span, first.key)} · {money(first.netWorth, first.currency as Currency)}</span>
        <span className="mono" style={{ color: rising ? 'var(--positive)' : 'var(--negative)' }}>
          {labelFor(span, last.key)} · {money(last.netWorth, last.currency as Currency)}
        </span>
      </div>
    </div>
  );
}

/**
 * One saved day: what it read when it was written, and the correction it opens into.
 *
 * Double-click, like every other row in this application, opens it to be corrected — a typed
 * figure and a note, saved with Save and Cancel rather than the row quietly changing.
 */
function StatementRow({ row, run, onDone }: {
  row: Statement;
  run: ReturnType<typeof useLive>['run'];
  onDone: () => void;
}) {
  const [draft, setDraft] = useState<null | { netWorth: number; note: string }>(null);
  const openable = !draft;
  const open = () => setDraft({ netWorth: row.netWorth, note: row.note ?? '' });

  if (draft) {
    return (
      <div style={{ padding: '10px 12px', borderRadius: 'var(--r-card)',
                    background: 'var(--raised)', border: '1px solid var(--hairline)',
                    display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 13, fontWeight: 600, minWidth: 90 }}>{row.date}</span>
        <span className="field-money" style={{ width: 170 }}>
          <Amount value={draft.netWorth} ariaLabel={`Net worth for ${row.date}`}
                  onChange={(n) => setDraft({ ...draft, netWorth: n })} />
        </span>
        <input value={draft.note} placeholder="note" aria-label={`Note for ${row.date}`}
               onChange={(e) => setDraft({ ...draft, note: e.target.value })}
               style={{ fontSize: 12, padding: '6px 8px', flex: '1 1 160px', minWidth: 120 }} />
        <span className="btn-pair">
          <button className="btn go sm" onClick={() => {
            void run('wealth.statement.update', {
              id: row.id, netWorth: draft.netWorth, note: draft.note || null,
            }).then(() => { setDraft(null); onDone(); });
          }}>
            <Icon name="check" size={13} motion="none" /> Save
          </button>
          <button className="btn ghost sm" onClick={() => setDraft(null)}>
            <Icon name="close" size={13} motion="none" /> Cancel
          </button>
        </span>
      </div>
    );
  }

  return (
    <div className="mgr-row" style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5,
                  padding: '4px 2px', cursor: openable ? 'pointer' : undefined }}
         tabIndex={0} aria-label={`Double-click, or press Enter, to correct ${row.date}`}
         onDoubleClick={(e) => { if (!isInteractive(e.target)) open(); }}
         onKeyDown={(e) => {
           if (e.key !== 'Enter' || isInteractive(e.target)) return;
           e.preventDefault();
           open();
         }}>
      <span style={{ minWidth: 90, fontWeight: 600 }}>{row.date}</span>
      <span className="mono" style={{ minWidth: 110 }}>
        {money(row.netWorth, row.currency as Currency)}
      </span>
      <Chip tone={row.source === 'manual' ? 'info' : 'neutral'}>
        {row.source === 'manual' ? 'by hand' : 'auto'}
      </Chip>
      {row.note && <span style={{ color: 'var(--faint)', flex: 1, minWidth: 0,
                                  overflow: 'hidden', textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap' }}>{row.note}</span>}
      <span style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
        <button className="btn quiet rt-hint" onClick={open} aria-label={`Correct ${row.date}`} title="Correct"
                style={{ padding: 5, border: 'none' }}>
          <Icon name="edit" size={12} />
        </button>
        <ConfirmDelete what={`the statement for ${row.date}`} size={12} className="rt-hint"
                       onConfirm={() => { void run('wealth.statement.remove', { id: row.id }).then(onDone); }} />
      </span>
    </div>
  );
}
