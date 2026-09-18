import { useCallback, useEffect, useState } from 'react';
import { ledger } from '../api';
import { useApp } from '../AppState';
import { useLive } from '../Live';
import { money, type Currency } from '@ledger/engine';
import { Page, Panel, Stat, Stats, Empty, Chip } from '../components/UI';
import { Icon } from '../components/Icon';
import { Mark } from '../components/Mark';
import { Select } from '../components/Select';
import { Amount } from '../components/Amount';
import { Segmented } from '../components/Segmented';
import { ConfirmDelete } from '../components/Confirm';
import { ClearAll } from '../components/ClearAll';
import { isInteractive } from '../components/RecordTable';
import { SectionProvider, Sections, useSection } from '../components/Sections';
import { Pie } from '../components/Pie';

/** One destination's total over the window the chart is showing, and the colour it wears everywhere else. */
interface SeriesLine { id: string; name: string; color: string; icon: string | null; total: number }
/** A ceiling that applies, restated per bucket so it can be weighed against a total over the same window. */
interface SeriesCeiling { id: string; name: string; color: string; perBucket: number; destinationIds: string[] }

/**
 * Budgets, as pools.
 *
 * A budget here is a ceiling over a period and the destinations it covers — one destination
 * or several. A ceiling over one is a pool with one member, which is why there is no second
 * kind of budget to learn: adding a ceiling to a destination and building a pool out of three
 * are the same act with a different number of boxes ticked.
 *
 * A pool says what it is doing now — spent, left, how long the period has to run — and the
 * chart beside it says how it got there.
 */
export function Budgets() {
  return (
    <SectionProvider first="pools"><Body /></SectionProvider>
  );
}

interface Pool {
  id: string; name: string; color: string; icon: string | null;
  period: string; amount: number; currency: string; anchor: string; warnAt: number;
  note: string | null; archived: boolean;
  from: string; to: string; daysLeft: number;
  spent: number; remaining: number; share: number;
  standing: 'within' | 'close' | 'over';
  members: Array<{ id: string; name: string; color: string; icon: string | null;
                   spent: number; count: number }>;
}

type Period = 'monthly' | 'quarterly' | 'annual';
type Span = 'year' | 'all';

const PERIOD_LABEL: Record<string, string> = {
  monthly: 'a month', quarterly: 'a quarter', annual: 'a year',
};

function Body() {
  const { tab } = useSection();
  const { data, display, currencies } = useApp();
  const { live, version, run } = useLive();

  const [pools, setPools] = useState<Pool[] | null>(null);
  const [span, setSpan] = useState<Span>('year');
  const [series, setSeries] = useState<{
    buckets: string[]; lines: SeriesLine[]; ceilings: SeriesCeiling[]; currency: string } | null>(null);

  const cats = data.categories.filter((c) => c.domain === 'expense');

  const load = useCallback(() => {
    if (!live) { setPools(null); return; }
    (ledger as any)['budgets.list']({}).then(setPools).catch(() => setPools([]));
  }, [live]);
  useEffect(load, [load, version]);

  /**
   * The chart follows the display currency.
   *
   * Every expense keeps the amount and the currency it was recorded in; the conversion is
   * asked for here, when it is drawn, so changing the ledger's currency in Settings redraws
   * the chart rather than rewriting anything.
   */
  useEffect(() => {
    if (!live) { setSeries(null); return; }
    let off = false;
    (ledger as any)['budget.series']({ span, currency: display })
      .then((s: any) => { if (!off) setSeries(s); })
      .catch(() => { if (!off) setSeries(null); });
    return () => { off = true; };
  }, [live, version, span, display]);

  const over = (pools ?? []).filter((p) => p.standing === 'over');
  const close = (pools ?? []).filter((p) => p.standing === 'close');

  return (
    <Page>
      <Sections sections={[
        { id: 'pools', label: 'Pools', icon: 'expenses',
          hint: 'What each ceiling is doing in the period it is in. Double-click one to change it.' },
        { id: 'chart', label: 'Over time', icon: 'dashboards',
          hint: 'What each destination cost, month by month, against the ceilings that watch it.' },
      ]} />

      {!live ? (
        <Panel>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
            Budgets come from the ledger service, and there is none behind this screen yet.
          </p>
        </Panel>
      ) : tab === 'pools' ? (
        <>
          <Panel>
            <Stats>
              <Stat label="Pools" value={String(pools?.length ?? 0)}
                    sub={`${(pools ?? []).reduce((n, p) => n + p.members.length, 0)} destination${(pools ?? []).reduce((n, p) => n + p.members.length, 0) === 1 ? '' : 's'} covered`} />
              <Stat label="Over the ceiling" value={String(over.length)}
                    color={over.length ? 'var(--negative)' : undefined}
                    sub={over.length ? over.map((p) => p.name).join(', ') : 'nothing has gone past'} />
              <Stat label="Close to it" value={String(close.length)}
                    color={close.length ? 'var(--gold)' : undefined}
                    sub={close.length ? close.map((p) => p.name).join(', ') : 'nothing is near'} />
              <Stat label="Not covered"
                    value={String(cats.filter((c) => !(pools ?? []).some((p) => p.members.some((m) => m.id === c.id))).length)}
                    sub="destinations with no ceiling on them" />
            </Stats>
          </Panel>

          <Panel title="Pools"
                 hint="A ceiling over one destination or several. What they spend between them counts against one figure."
                 action={(
                   <ClearAll log="budgets" count={pools?.length ?? 0}
                             what="every ceiling, and which destinations it covered"
                             onDone={load} />
                 )}>
            {pools && pools.length === 0 ? (
              <Empty icon="budgets" title="No ceilings set"
                     body="A pool is a ceiling over a period and the destinations it covers — one, or several sharing one figure." />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {(pools ?? []).map((p) => (
                  <PoolCard key={p.id} pool={p} cats={cats}
                            currencies={currencies} run={run} onDone={load} />
                ))}
              </div>
            )}

            <AddPool cats={cats} currencies={currencies} run={run} onDone={load} />
            <p style={{ margin: '16px 0 0', fontSize: 12, color: 'var(--faint)', lineHeight: 1.5 }}>
              A destination may sit in more than one pool; both count it, and both say so.
            </p>
          </Panel>
        </>
      ) : (
        <Panel title="Where it went"
               hint={`Each destination's share of what was spent ${span === 'all' ? 'across every year' : 'this year'}, in ${display}. A destination whose ceiling that spending has passed is called out below — a pie shows share, not whether it went over.`}
               action={
                 <Segmented<Span> value={span} onChange={setSpan} ariaLabel="Over what span"
                   options={[
                     { id: 'year', label: 'This year', icon: 'span', tone: 'var(--gold)' },
                     { id: 'all', label: 'All time', icon: 'ledger', tone: 'var(--gold)' },
                   ]} />
               }>
          {series ? (
            <SpendPie series={series} currency={display} />
          ) : (
            <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>Reading…</p>
          )}
        </Panel>
      )}
    </Page>
  );
}

/**
 * Where it went, as a pie rather than a line.
 *
 * One wedge per destination, in the colour it wears everywhere else — the log, the pools
 * above, the pickers. A pie says share; it says nothing about a ceiling by itself, which is
 * exactly what the line used to draw as a dashed rule. That fact is not dropped, only moved:
 * a destination whose ceiling the spending drawn here has passed — the ceiling restated over
 * this same window, compared against what its pool actually spent in it — gets called out
 * beside its own row, in words, rather than folded into a shape that cannot say "past" on its
 * own. The percentage stays written beside every row for the reason `Pie` gives: a tilted
 * disc flatters the wedges nearest the viewer, and the figures must not be left to it.
 */
function SpendPie({ series, currency }: {
  series: { buckets: string[]; lines: SeriesLine[]; ceilings: SeriesCeiling[] };
  currency: string;
}) {
  const total = series.lines.reduce((s, l) => s + l.total, 0);

  const overIds = new Set<string>();
  for (const c of series.ceilings) {
    const ceilingOverWindow = c.perBucket * series.buckets.length;
    const spentByIt = series.lines
      .filter((l) => c.destinationIds.includes(l.id))
      .reduce((s, l) => s + l.total, 0);
    if (ceilingOverWindow > 0 && spentByIt > ceilingOverWindow) {
      c.destinationIds.forEach((id) => overIds.add(id));
    }
  }

  if (series.lines.length === 0) {
    return (
      <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
        Nothing was spent in this window, so there is nothing to draw.
      </p>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 28, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <Pie
        slices={series.lines.map((l) => ({ label: l.name, value: l.total, color: l.color }))}
        size={232}
        format={(n) => money(n, currency as Currency)}
        caption={
          <>
            <span style={{ fontSize: 11, color: 'var(--faint)' }}>spent</span>
            <span className="mono" style={{ fontSize: 15, fontWeight: 500 }}>
              {money(total, currency as Currency)}
            </span>
          </>
        }
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 9, flex: 1, minWidth: 220 }}>
        {series.lines.map((l) => (
          <span key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
            <span style={{ width: 9, height: 9, borderRadius: 3, background: l.color, flex: '0 0 auto' }} />
            <span style={{ flex: 1 }}>{l.name}</span>
            <span className="mono" style={{ color: 'var(--muted)' }}>{money(l.total, currency as Currency)}</span>
            {/* The share in words, because a tilted disc cannot be trusted to rank the
                wedges by eye — the reason `Pie` asks for it. */}
            <span className="mono" style={{ color: 'var(--faint)', fontSize: 11 }}>
              {total > 0 ? `${((l.total / total) * 100).toFixed(1)}%` : '—'}
            </span>
            {overIds.has(l.id) && <Chip tone="bad">over its ceiling</Chip>}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * One pool: what it is doing now, what it covers, and — once opened — its fields.
 *
 * A pool is a row like any other, so it opens the same way `RecordTable` opens one: double-
 * click it, press Enter with it focused, or press its pencil.
 */
function PoolCard({ pool: p, cats, currencies, run, onDone }: {
  pool: Pool;
  cats: ReturnType<typeof useApp>['data']['categories'];
  currencies: ReturnType<typeof useApp>['currencies'];
  run: ReturnType<typeof useLive>['run'];
  onDone: () => void;
}) {
  const [draft, setDraft] = useState<null | {
    name: string; amount: number; currency: string; period: Period;
    warnAt: number; members: string[];
  }>(null);
  const tone = p.standing === 'over' ? 'var(--negative)'
             : p.standing === 'close' ? 'var(--gold)' : p.color;

  const open = () => setDraft({
    name: p.name, amount: p.amount, currency: p.currency, period: p.period as Period,
    warnAt: p.warnAt, members: p.members.map((m) => m.id),
  });
  const openable = !draft;

  return (
    <div style={{ padding: '15px 17px', borderRadius: 'var(--r-card)',
                  background: 'var(--raised)', border: '1px solid var(--hairline)' }}>
      <div className="mgr-row" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                    cursor: openable ? 'pointer' : undefined }}
           tabIndex={openable ? 0 : undefined}
           aria-label={openable ? `Double-click, or press Enter, to edit ${p.name}` : undefined}
           onDoubleClick={openable ? (e) => { if (!isInteractive(e.target)) open(); } : undefined}
           onKeyDown={openable ? (e) => {
             if (e.key !== 'Enter' || isInteractive(e.target)) return;
             e.preventDefault();
             open();
           } : undefined}>
        <span style={{ width: 36, height: 36, borderRadius: 10, flex: '0 0 36px',
                       display: 'flex', alignItems: 'center', justifyContent: 'center',
                       background: `color-mix(in srgb, ${p.color} 15%, transparent)` }}>
          <Mark mark={p.icon ?? undefined} size={19} color={p.color} fallback="expenses" />
        </span>
        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{p.name}</div>
          <div style={{ fontSize: 11, color: 'var(--faint)' }}>
            {money(p.amount, p.currency as Currency)} {PERIOD_LABEL[p.period]} ·{' '}
            {p.from} to {p.to} · {p.daysLeft} day{p.daysLeft === 1 ? '' : 's'} left
          </div>
        </div>
        <div>
          <div className="mono" style={{ fontSize: 16, fontWeight: 500, color: tone }}>
            {money(p.spent, p.currency as Currency)}
          </div>
          <div style={{ fontSize: 11, color: 'var(--faint)' }}>
            {p.remaining >= 0
              ? `${money(p.remaining, p.currency as Currency)} left`
              : `${money(-p.remaining, p.currency as Currency)} over`}
          </div>
        </div>
        <Chip tone={p.standing === 'over' ? 'bad' : p.standing === 'close' ? 'warn' : 'good'}>
          {Math.round(p.share * 100)}%
        </Chip>
        {openable && (
          <span style={{ display: 'flex', gap: 6 }}>
            <button className="btn quiet rt-hint" onClick={open} aria-label={`Edit ${p.name}`} title="Edit"
                    style={{ padding: 7, border: 'none' }}>
              <Icon name="edit" size={14} />
            </button>
            <ConfirmDelete what={p.name} size={14} className="rt-hint"
                           onConfirm={() => { void run('budget.remove', { budgetId: p.id }).then(onDone); }} />
          </span>
        )}
      </div>

      {/* What is spent against the ceiling, as a pie rather than a bar: spent and left are
          two parts of one figure, which is the one thing a pie says better than anything
          else. Past the ceiling there is no "left" to draw, so the wedges become what the
          ceiling covered and what was spent beyond it — the chart changes what it is
          dividing rather than pretending a hundred and twenty per cent fits in a circle. */}
      <div style={{ marginTop: 13, display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
        <Pie size={148}
             slices={p.remaining >= 0
               ? [{ label: 'Spent', value: p.spent, color: tone },
                  { label: 'Left', value: p.remaining, color: 'var(--hairline-strong)' }]
               : [{ label: 'The ceiling', value: p.amount, color: 'var(--gold)' },
                  { label: 'Over it', value: -p.remaining, color: 'var(--negative)' }]}
             format={(n) => money(n, p.currency as Currency)}
             caption={
               <span style={{ fontSize: 11, color: 'var(--faint)' }}>
                 {p.remaining >= 0
                   ? `${money(p.remaining, p.currency as Currency)} of ${money(p.amount, p.currency as Currency)} left`
                   : `${money(-p.remaining, p.currency as Currency)} past ${money(p.amount, p.currency as Currency)}`}
               </span>
             } />
        <span style={{ fontSize: 11, color: 'var(--faint)', lineHeight: 1.6 }}>
          It is called close at {Math.round(p.warnAt * 100)}%.
        </span>
      </div>

      <div style={{ marginTop: 8, display: 'flex', gap: 7, flexWrap: 'wrap' }}>
        {p.members.map((m) => (
          <span key={m.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
                                    fontSize: 11.5, padding: '4px 9px', borderRadius: 999,
                                    background: 'var(--surface)', border: '1px solid var(--hairline)' }}>
            <Mark mark={m.icon ?? undefined} size={12} color={m.color} fallback="expenses" />
            {m.name}
            <span className="mono" style={{ color: 'var(--faint)' }}>
              {money(m.spent, p.currency as Currency)}
            </span>
          </span>
        ))}
      </div>

      {draft && (
        <PoolFields draft={draft} setDraft={setDraft} cats={cats} currencies={currencies}
          onCancel={() => setDraft(null)}
          onSave={async () => {
            await run('budget.update', {
              budgetId: p.id, name: draft.name, amount: draft.amount,
              currency: draft.currency, period: draft.period, warnAt: draft.warnAt,
              destinationIds: draft.members,
            });
            setDraft(null);
            onDone();
          }} />
      )}
    </div>
  );
}

/** Adding one. The same fields, opened from a button rather than from a row. */
function AddPool({ cats, currencies, run, onDone }: {
  cats: ReturnType<typeof useApp>['data']['categories'];
  currencies: ReturnType<typeof useApp>['currencies'];
  run: ReturnType<typeof useLive>['run'];
  onDone: () => void;
}) {
  const [draft, setDraft] = useState<null | {
    name: string; amount: number; currency: string; period: Period;
    warnAt: number; members: string[];
  }>(null);

  if (!draft) {
    return (
      <button className="btn add sm" style={{ marginTop: 16 }}
        onClick={() => setDraft({ name: '', amount: 0, currency: 'EGP', period: 'monthly',
                                  warnAt: 0.8, members: [] })}>
        <Icon name="plus" size={14} /> Set a ceiling
      </button>
    );
  }

  return (
    <div style={{ marginTop: 16, padding: '15px 17px', borderRadius: 'var(--r-card)',
                  background: 'color-mix(in srgb, var(--positive) 6%, transparent)',
                  border: '1px dashed color-mix(in srgb, var(--positive) 40%, transparent)' }}>
      <PoolFields draft={draft} setDraft={setDraft as any} cats={cats} currencies={currencies}
        onCancel={() => setDraft(null)}
        onSave={async () => {
          await run('budget.add', {
            name: draft.name, amount: draft.amount, currency: draft.currency,
            period: draft.period, warnAt: draft.warnAt, destinationIds: draft.members,
          });
          setDraft(null);
          onDone();
        }} />
    </div>
  );
}

/**
 * The fields of a pool.
 *
 * Shared between adding and editing, because they are the same thing said twice otherwise —
 * and the destinations are ticked here rather than added one at a time, which is what makes
 * "a ceiling on groceries" and "a ceiling on food" one gesture with a different number of
 * ticks.
 */
function PoolFields({ draft, setDraft, cats, currencies, onSave, onCancel }: {
  draft: { name: string; amount: number; currency: string; period: Period;
           warnAt: number; members: string[] };
  setDraft: (d: typeof draft) => void;
  cats: ReturnType<typeof useApp>['data']['categories'];
  currencies: ReturnType<typeof useApp>['currencies'];
  onSave: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const { running } = useLive();
  const toggle = (id: string) => setDraft({
    ...draft,
    members: draft.members.includes(id)
      ? draft.members.filter((m) => m !== id)
      : [...draft.members, id],
  });
  const ready = draft.name.trim().length > 0 && draft.amount > 0 && draft.members.length > 0;

  return (
    <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--hairline)',
                  display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <input value={draft.name} aria-label="Budget name" placeholder="what this covers"
               onChange={(e) => setDraft({ ...draft, name: e.target.value })}
               style={{ fontSize: 13, padding: '7px 9px', minWidth: 160, flex: '1 1 160px' }} />
        <span className="field-money" style={{ width: 210 }}>
          <Amount value={draft.amount} ariaLabel="Ceiling"
                  onChange={(n) => setDraft({ ...draft, amount: n })} />
          <Select ariaLabel="Ceiling currency" value={draft.currency} style={{ width: 92 }}
                  onChange={(v) => setDraft({ ...draft, currency: v })}
                  options={currencies.map((c) => ({ value: c.code, label: c.code }))} />
        </span>
        <Select ariaLabel="Period" value={draft.period} style={{ width: 140 }}
                onChange={(v) => setDraft({ ...draft, period: v as Period })}
                options={[{ value: 'monthly', label: 'a month' },
                          { value: 'quarterly', label: 'a quarter' },
                          { value: 'annual', label: 'a year' }]} />
        {/*
          * How close is close enough to be warned, typed rather than chosen.
          *
          * A list of fractions offered five answers and refused the sixth: somebody who wants
          * to hear about it at 65% had no way to say so. It is a percentage of the ceiling,
          * so it is written as one — the pool stores the fraction, and nothing but this field
          * ever needs to know that.
          */}
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>warn at</span>
          <Amount value={Math.round(draft.warnAt * 100)}
                  ariaLabel="Warn at, as a percentage of the ceiling"
                  placeholder="80" min={0}
                  style={{ width: 62, textAlign: 'right' }}
                  onChange={(n) => setDraft({ ...draft, warnAt: Math.min(100, n) / 100 })} />
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>% of it</span>
        </span>
      </div>

      <div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 7 }}>
          What this ceiling covers — one destination, or several sharing the one figure.
        </div>
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
          {cats.map((c) => {
            const on = draft.members.includes(c.id);
            return (
              <button key={c.id} onClick={() => toggle(c.id)} aria-pressed={on}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 7, cursor: 'pointer',
                  fontSize: 12, padding: '6px 11px', borderRadius: 999,
                  background: on ? `color-mix(in srgb, ${c.color} 16%, transparent)` : 'var(--surface)',
                  border: `1px solid ${on ? c.color : 'var(--hairline)'}`,
                  color: on ? 'var(--ink)' : 'var(--muted)',
                }}>
                <Mark mark={c.icon} size={13} color={c.color} fallback="expenses" />
                {c.name}
              </button>
            );
          })}
        </div>
      </div>

      <span className="btn-pair" style={{ justifyContent: 'flex-start' }}>
        <button className="btn go sm" disabled={!ready || !!running} onClick={() => void onSave()}>
          <Icon name="check" size={13} motion="none" /> Save
        </button>
        <button className="btn ghost sm" onClick={onCancel}>
          <Icon name="close" size={13} motion="none" /> Cancel
        </button>
      </span>
    </div>
  );
}
