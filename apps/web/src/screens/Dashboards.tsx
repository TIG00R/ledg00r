import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../AppState';
import { useLive } from '../Live';
import { ledger } from '../api';
import { Page, Panel, Stat, Stats, Empty } from '../components/UI';
import { Segmented } from '../components/Segmented';
import { Donut } from '../components/Donut';
import { Icon } from '../components/Icon';
import { SectionProvider, Sections, useSection } from '../components/Sections';
import { ModeProvider } from '../components/ModeBar';

/** How tall the tallest bar is drawn, in pixels. */
const PLOT = 150;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** For a group with no colour of its own — distinct at a glance, and calm together. */
const PALETTE = ['var(--cash)', 'var(--car)', 'var(--gold)', 'var(--stocks)',
                 'var(--zakat)', 'var(--sadaqat)', 'var(--positive)', 'var(--muted)'];

type Subject = 'expenses' | 'income' | 'giving';
type Period = 'month' | 'year' | 'all';

interface Report {
  subject: string; period: string; label: string;
  total: number; count: number; previous: number;
  groups: Array<{ key: string; name: string; color: string | null; icon: string | null;
                  amount: number; count: number; share: number }>;
  series: Array<{ bucket: string; amount: number; count: number }>;
  currencies: Array<{ currency: string; amount: number }>;
}

/**
 * What the numbers add up to.
 *
 * Every other screen answers a question about one thing — this account, that property, those
 * shares. This one answers the question you actually ask a ledger: where did it go, and is
 * that more or less than last time. So each subject offers the same three windows, and the
 * answer always carries the period before it to be read against.
 */
export function Dashboards() {
  return (
    <ModeProvider>
      <SectionProvider first="expenses"><Body /></SectionProvider>
    </ModeProvider>
  );
}

function Body() {
  const { tab } = useSection();
  const { dm } = useApp();
  const { live, version } = useLive();
  const [period, setPeriod] = useState<Period>('month');
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    if (!live) { setReport(null); return; }
    setLoading(true);
    (ledger as any)['dashboard.read']({ subject: tab as Subject, period })
      .then(setReport)
      .catch(() => setReport(null))
      .finally(() => setLoading(false));
  }, [live, tab, period]);
  useEffect(load, [load, version]);

  const change = report && report.previous > 0
    ? (report.total - report.previous) / report.previous
    : null;
  const tone = tab === 'income' ? 'var(--positive)' : tab === 'giving' ? 'var(--zakat)' : 'var(--negative)';
  const peak = Math.max(1, ...(report?.series ?? []).map((s) => s.amount));
  const busiest = (report?.series ?? []).find((s) => s.amount === peak) ?? null;

  return (
    <Page>
      <Sections sections={[
        { id: 'expenses', label: 'Expenses', icon: 'expenses', hint: 'Where money went, and whether that is more than the period before.' },
        { id: 'income', label: 'Income', icon: 'income', hint: 'What arrived, and from which source.' },
        { id: 'giving', label: 'Giving', icon: 'zakat', hint: 'Zakat and sadaqat, by cause.' },
      ]} />

      <Panel>
        <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <Segmented<Period> value={period} onChange={setPeriod} ariaLabel="Over what period"
            options={[
              { id: 'month', label: 'This month', icon: 'calendar', tone },
              { id: 'year', label: 'This year', icon: 'span', tone },
              { id: 'all', label: 'All time', icon: 'ledger', tone },
            ]} />
          {report && (
            <span style={{ fontSize: 12, color: 'var(--faint)', alignSelf: 'center' }}>
              {report.label} · {report.count} record{report.count === 1 ? '' : 's'}
            </span>
          )}
        </div>

        {!live ? (
          <p style={{ margin: '20px 0 0', fontSize: 13, color: 'var(--muted)' }}>
            The figures come from the ledger service, and there is none behind this screen yet.
          </p>
        ) : (
          <div style={{ marginTop: 22 }}>
            <Stats>
              <Stat label={`${tab === 'income' ? 'Received' : tab === 'giving' ? 'Given' : 'Spent'}, ${report?.label.toLowerCase() ?? ''}`}
                    value={dm(report?.total ?? 0)} color={tone}
                    sub={loading ? 'reading…'
                      : `${report?.count ?? 0} record${(report?.count ?? 0) === 1 ? '' : 's'}`} />
              <Stat label="The period before" value={dm(report?.previous ?? 0)}
                    sub={period === 'all' ? 'nothing to compare against' : 'same length, one back'} />
              <Stat label="Change"
                    value={change == null ? '—' : `${change > 0 ? '+' : ''}${(change * 100).toFixed(0)}%`}
                    color={change == null ? undefined
                      : (tab === 'income' ? change >= 0 : change <= 0) ? 'var(--positive)' : 'var(--negative)'}
                    sub={change == null ? '' : dm(Math.abs((report?.total ?? 0) - (report?.previous ?? 0)))} />
              <Stat label="Largest single call"
                    value={report?.groups[0] ? dm(report.groups[0].amount) : '—'}
                    sub={report?.groups[0]?.name ?? ''} />
            </Stats>
          </div>
        )}
      </Panel>

      {report && report.groups.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 20 }}>
          {/**
            * Two questions, two shapes.
            *
            * A ring answers "of what I spent, how much went where" — the whole is the point,
            * so the shares are what the eye should read. Bars answer "when", which a ring
            * cannot show at all, and which is the question that actually catches a month
            * that got away from you.
            */}
          <Panel title={tab === 'income' ? 'Which sources' : tab === 'giving' ? 'Which causes' : 'Where it went'}
                 hint={`Shares of ${dm(report.total)}${report.currencies.length > 1
                   ? `, recorded in ${report.currencies.map((c) => c.currency).join(' and ')}` : ''}.`}>
            <div style={{ display: 'flex', gap: 26, alignItems: 'center', flexWrap: 'wrap' }}>
              <Donut size={200} thickness={26} format={(v) => dm(v)}
                slices={report.groups.slice(0, 8).map((g, i) => ({
                  label: g.name, value: g.amount,
                  color: g.color ?? PALETTE[i % PALETTE.length]!,
                }))}
                centre={
                  <>
                    <span className="mono" style={{ fontSize: 17, fontWeight: 500 }}>{dm(report.total)}</span>
                    <span style={{ fontSize: 10, color: 'var(--faint)' }}>
                      {report.count} record{report.count === 1 ? '' : 's'}
                    </span>
                  </>
                } />

              <div style={{ flex: 1, minWidth: 190, display: 'flex', flexDirection: 'column', gap: 9 }}>
                {report.groups.slice(0, 8).map((g, i) => (
                  <div key={g.key} style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                    <span style={{ width: 9, height: 9, borderRadius: 3, flex: '0 0 9px',
                                   background: g.color ?? PALETTE[i % PALETTE.length] }} />
                    <span style={{ flex: 1, minWidth: 0, fontSize: 13, whiteSpace: 'nowrap',
                                   overflow: 'hidden', textOverflow: 'ellipsis' }}>{g.name}</span>
                    <span className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>
                      {(g.share * 100).toFixed(1)}%
                    </span>
                    <span className="mono" style={{ fontSize: 12, minWidth: 74, textAlign: 'right' }}>
                      {dm(g.amount)}
                    </span>
                  </div>
                ))}
                {report.groups.length > 8 && (
                  <span style={{ fontSize: 11, color: 'var(--faint)' }}>
                    and {report.groups.length - 8} more, too small to draw
                  </span>
                )}
              </div>
            </div>
          </Panel>

          <Panel title="When"
                 hint={period === 'all' ? 'One bar a year — which years it happened in.'
                                        : 'One bar a month — which months it happened in.'}>
            {report.series.length < 2 ? (
              <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
                Only one {period === 'all' ? 'year' : 'month'} has anything in it, so there is
                no shape to show yet.
              </p>
            ) : (
              <>
                {/* Bar heights are computed rather than given as percentages: a percentage
                    resolves against the parent's height, and a column that sizes to its own
                    content has none — which collapses every bar to a line. */}
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: PLOT + 34 }}>
                  {report.series.map((s2) => {
                    const tallest = s2.amount === peak;
                    return (
                      <div key={s2.bucket} style={{ flex: 1, display: 'flex', flexDirection: 'column',
                                                    alignItems: 'center', justifyContent: 'flex-end',
                                                    gap: 6, minWidth: 0, height: '100%' }}>
                        <span className="mono" style={{ fontSize: 10,
                                color: tallest ? 'var(--ink)' : 'var(--faint)' }}>
                          {s2.amount >= 1000 ? `${Math.round(s2.amount / 1000)}k` : Math.round(s2.amount)}
                        </span>
                        <div title={`${s2.bucket}: ${dm(s2.amount)} over ${s2.count} record${s2.count === 1 ? '' : 's'}`}
                             style={{ width: '100%', height: Math.max(4, (s2.amount / peak) * PLOT),
                                      borderRadius: '5px 5px 2px 2px', flex: '0 0 auto',
                                      background: tallest ? tone : `color-mix(in srgb, ${tone} 52%, transparent)`,
                                      transition: 'height 260ms var(--ease)' }} />
                        <span style={{ fontSize: 10, color: 'var(--faint)', whiteSpace: 'nowrap',
                                       overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>
                          {s2.bucket.length > 4 ? MONTHS[Number(s2.bucket.slice(5, 7)) - 1] : s2.bucket}
                        </span>
                      </div>
                    );
                  })}
                </div>
                <div style={{ display: 'flex', gap: 26, marginTop: 18, paddingTop: 16,
                              borderTop: '1px solid var(--hairline)', flexWrap: 'wrap' }}>
                  <Stat label={`Busiest ${period === 'all' ? 'year' : 'month'}`}
                        value={dm(peak)} color={tone}
                        sub={busiest ? (busiest.bucket.length > 4
                          ? `${MONTHS[Number(busiest.bucket.slice(5, 7)) - 1]} ${busiest.bucket.slice(0, 4)}`
                          : busiest.bucket) : ''} />
                  <Stat label="Average" value={dm(report.total / report.series.length)}
                        sub={`over ${report.series.length} ${period === 'all' ? 'years' : 'months'}`} />
                </div>
              </>
            )}
          </Panel>
        </div>
      )}

      {report && report.groups.length === 0 && (
        <Panel>
          <Empty icon={tab === 'income' ? 'income' : tab === 'giving' ? 'charity' : 'expenses'}
                 title="Nothing in this period"
                 body="Record something, or widen the window above." />
        </Panel>
      )}

    </Page>
  );
}

export { Icon };
