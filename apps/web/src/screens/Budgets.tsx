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
import { ModeProvider, useMode } from '../components/ModeBar';
import { SectionProvider, Sections, useSection } from '../components/Sections';
import { BudgetChart, type Line, type Ceiling } from '../components/BudgetChart';

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
    <ModeProvider>
      <SectionProvider first="pools"><Body /></SectionProvider>
    </ModeProvider>
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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function Body() {
  const { tab } = useSection();
  const { data, display, currencies } = useApp();
  const { live, version, run } = useLive();
  const { mode } = useMode();

  const [pools, setPools] = useState<Pool[] | null>(null);
  const [span, setSpan] = useState<Span>('year');
  const [series, setSeries] = useState<{
    buckets: string[]; lines: Line[]; ceilings: Ceiling[]; currency: string } | null>(null);

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
          hint: 'What each ceiling is doing in the period it is in.',
          editHint: 'Change a ceiling, what it covers, or the period it runs on — and add new ones.' },
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
                 hint="A ceiling over one destination or several. What they spend between them counts against one figure.">
            {pools && pools.length === 0 ? (
              <Empty icon="budgets" title="No ceilings set"
                     body="A pool is a ceiling over a period and the destinations it covers — one, or several sharing one figure." />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {(pools ?? []).map((p) => (
                  <PoolCard key={p.id} pool={p} cats={cats} editing={mode === 'edit'}
                            currencies={currencies} run={run} onDone={load} />
                ))}
              </div>
            )}

            {mode === 'edit' && <AddPool cats={cats} currencies={currencies} run={run} onDone={load} />}
            {mode !== 'edit' && (
              <p style={{ margin: '16px 0 0', fontSize: 12, color: 'var(--faint)', lineHeight: 1.5 }}>
                Switch to Edit to change a ceiling or add one. A destination may sit in more than
                one pool; both count it, and both say so.
              </p>
            )}
          </Panel>
        </>
      ) : (
        <Panel title="Where it went, over time"
               hint={`Each destination in its own colour, in ${display}. A dashed rule is a ceiling, at the height one ${span === 'all' ? 'year' : 'month'} of it reaches.`}
               action={
                 <Segmented<Span> value={span} onChange={setSpan} ariaLabel="Over what span"
                   options={[
                     { id: 'year', label: 'This year', icon: 'span', tone: 'var(--gold)' },
                     { id: 'all', label: 'All time', icon: 'ledger', tone: 'var(--gold)' },
                   ]} />
               }>
          {series ? (
            <BudgetChart buckets={series.buckets} lines={series.lines} ceilings={series.ceilings}
                         currency={display}
                         label={(b) => (b.length === 4 ? b : MONTHS[Number(b.slice(5, 7)) - 1]!)} />
          ) : (
            <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>Reading…</p>
          )}
        </Panel>
      )}
    </Page>
  );
}

/** One pool: what it is doing now, what it covers, and — while editing — its fields. */
function PoolCard({ pool: p, cats, editing, currencies, run, onDone }: {
  pool: Pool;
  cats: ReturnType<typeof useApp>['data']['categories'];
  editing: boolean;
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

  return (
    <div style={{ padding: '15px 17px', borderRadius: 'var(--r-card)',
                  background: 'var(--raised)', border: '1px solid var(--hairline)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
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
        <div style={{ textAlign: 'right' }}>
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
        {editing && !draft && (
          <span style={{ display: 'flex', gap: 6 }}>
            <button className="btn quiet" onClick={open} aria-label={`Edit ${p.name}`} title="Edit"
                    style={{ padding: 7, border: 'none' }}>
              <Icon name="edit" size={14} />
            </button>
            <ConfirmDelete what={p.name} size={14}
                           onConfirm={() => { void run('budget.remove', { budgetId: p.id }).then(onDone); }} />
          </span>
        )}
      </div>

      {/* the bar: what is spent, against the ceiling, with the warning mark on it */}
      <div style={{ marginTop: 13, position: 'relative', height: 8, borderRadius: 999,
                    background: 'var(--surface)', overflow: 'hidden' }}>
        <div style={{ width: `${Math.min(100, p.share * 100)}%`, height: '100%',
                      background: tone, borderRadius: 999,
                      transition: 'width 220ms var(--ease)' }} />
      </div>
      <div style={{ position: 'relative', height: 10 }}>
        <span style={{ position: 'absolute', left: `${Math.min(100, p.warnAt * 100)}%`,
                       top: -12, width: 1, height: 12, background: 'var(--faint)' }} />
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
