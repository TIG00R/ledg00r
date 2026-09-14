import { useEffect, useState } from 'react';
import { useApp } from '../AppState';
import { useLive } from '../Live';
import { ledger } from '../api';
import { Empty, Page, Panel, Stat, Stats, Toggle } from '../components/UI';
import { Icon, hasIcon, type IconName } from '../components/Icon';
import { Segmented } from '../components/Segmented';

/**
 * Every place value can come from or go to is an entity on this chart — a source of
 * income, an account, an asset, an obligation, a category of spending. Adding one is a row
 * in ENTITIES and a row in FLOWS; the layout and the band widths follow from the numbers.
 */

type Kind = 'in' | 'internal' | 'out';
type Column = 'source' | 'account' | 'sink';

interface Entity {
  id: string; label: string; sub: string; column: Column; icon: IconName;
  flowLabel: string; flow: number; stockLabel: string; stock: number | string;
  /** an account that money merely passes through shows a gross figure, not a net one */
  tone?: Kind;
  /** accounts belonging to one institution are drawn inside its own boundary */
  group?: string;
  /** a third line, for what the account held on to */
  keptLabel?: string; kept?: number;
}

interface Flow {
  from: string; to: string; amount: number; kind: Kind; note?: string; count: number;
}

const TONE: Record<Kind, string> = {
  in: 'var(--positive)', internal: 'var(--gold)', out: 'var(--negative)',
};

const ENTITIES: Entity[] = [
  { id: 'salary', column: 'source', label: 'Salary', sub: '$3,000 · monthly', icon: 'salary',
    flowLabel: 'THIS MONTH', flow: 254621, stockLabel: 'SINCE THE OPENING', stock: 1027000, tone: 'in' },
  { id: 'rental', column: 'source', label: 'Room rental', sub: 'E£4,500 · monthly', icon: 'car',
    flowLabel: 'THIS MONTH', flow: 25462, stockLabel: 'SINCE THE OPENING', stock: 102670, tone: 'in' },
  { id: 'freelance', column: 'source', label: 'Freelance', sub: 'irregular · 1 payment', icon: 'briefcase',
    flowLabel: 'THIS MONTH', flow: 30555, stockLabel: 'THIS YEAR', stock: 213881, tone: 'in' },

  { id: 'usd', column: 'account', label: 'USD savings', sub: 'US dollar', icon: 'banknote', group: 'Nile Bank',
    flowLabel: 'CAME IN', flow: 310638, stockLabel: 'BALANCE NOW', stock: '$ 14,000',
    keptLabel: 'STAYED HERE', kept: 246398 },
  { id: 'egp', column: 'account', label: 'EGP current', sub: 'cheques clear here', icon: 'banknote', group: 'Nile Bank',
    flowLabel: 'PASSED THROUGH', flow: 64240, stockLabel: 'BALANCE NOW', stock: 145000 },

  { id: 'plan', column: 'sink', label: 'Riverside equity', sub: '1 cheque cleared', icon: 'realestate',
    flowLabel: 'THIS MONTH', flow: 50742, stockLabel: 'EQUITY NOW', stock: 1046414, tone: 'internal' },
  { id: 'expenses', column: 'sink', label: 'Expenses', sub: '1 movement · Travel', icon: 'expenses',
    flowLabel: 'THIS MONTH', flow: 10017, stockLabel: 'SINCE THE OPENING', stock: 41017, tone: 'out' },
  { id: 'giving', column: 'sink', label: 'Zakat and Sadaqat', sub: '1 payment · food aid', icon: 'zakat',
    flowLabel: 'THIS MONTH', flow: 3000, stockLabel: 'GIVEN ALL TIME', stock: 68000, tone: 'out' },
  { id: 'fees', column: 'sink', label: 'Bank spread and fees', sub: 'what the exchange cost', icon: 'fees',
    flowLabel: 'THIS MONTH', flow: 481, stockLabel: 'THIS YEAR', stock: 8940, tone: 'out' },
];

const FLOWS: Flow[] = [
  { from: 'salary', to: 'usd', amount: 254621, kind: 'in', count: 1 },
  { from: 'rental', to: 'usd', amount: 25462, kind: 'in', count: 1 },
  { from: 'freelance', to: 'usd', amount: 30555, kind: 'in', count: 1 },
  { from: 'usd', to: 'egp', amount: 64240, kind: 'internal', count: 1, note: '$ 1,263 @ 50.85' },
  { from: 'egp', to: 'ph', amount: 50742, kind: 'internal', count: 1 },
  { from: 'egp', to: 'expenses', amount: 10017, kind: 'out', count: 1 },
  { from: 'egp', to: 'giving', amount: 3000, kind: 'out', count: 1 },
  { from: 'usd', to: 'fees', amount: 481, kind: 'out', count: 1, note: 'kept by the bank' },
];

/**
 * The shape of the page.
 *
 * Sources on the left, your own accounts in the middle, where it went on the right. What
 * changed is the middle: accounts belonging to one bank are laid out side by side inside
 * that bank's boundary, one row per institution, rather than stacked in a single column.
 *
 * Stacking them was what produced the overlapping boxes. A boundary was drawn around
 * whichever cards happened to belong to an institution, and once a column held more than one
 * bank those cards were not next to each other — so one bank's rectangle was drawn straight
 * through another's. Laying each bank out as its own row means a boundary can only ever
 * contain its own accounts, and two boundaries cannot occupy the same band of the page.
 */
const CARD_W: Record<Column, number> = { source: 250, account: 250, sink: 270 };
const CARD_H = 118;
const GAP = 22;
/** between two accounts of the same bank, side by side — wide enough for a band between
    them to be seen, rather than a stub squeezed into the join */
const GAP_X = 76;
/** inside an institution's boundary, and the room its name needs above the cards */
const PAD = 16;
const HEAD = 30;
/** where each column starts, with the accounts' own width deciding where the last one does */
const SOURCE_X = 40;
const ACCOUNT_X = 470;
const COL_GAP = 150;
const TOP = 78;

/** "2026-09" as the month a person would say */
const monthName = (m: string) => {
  const [y, mm] = m.split('-').map(Number);
  return new Date(y!, (mm ?? 1) - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
};

type Span = 'month' | 'quarter' | 'year' | 'all';

/** what the chart is answering for: one month, the months up to it, or the whole ledger */
const spanName = (m: string, span: Span) =>
  span === 'all' ? 'Everything recorded'
    : span === 'month' ? monthName(m)
      : `${monthName(step(m, span === 'year' ? -11 : -2))} to ${monthName(m)}`;

/** the month n months either side of this one, still as "YYYY-MM" */
const step = (m: string, n: number) => {
  const [y, mm] = m.split('-').map(Number);
  const d = new Date(y!, (mm ?? 1) - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

export function Flow() {
  const { dm, data, balances } = useApp();
  const { live, version } = useLive();
  const [combined, setCombined] = useState(true);
  const thisMonth = new Date().toISOString().slice(0, 7);
  const [month, setMonth] = useState(thisMonth);
  /*
   * How much of the ledger the chart is answering for.
   *
   * A quarterly installment lands in one month of three and an annual charge in one of
   * twelve, so a chart that can only show a single month says a property you are still
   * paying for does not exist. The span is what the chart is about; the month is where it
   * ends.
   */
  const [span, setSpan] = useState<Span>('month');
  const [live_, setLive_] = useState<{ entities: Entity[]; flows: Flow[] } | null>(null);

  /**
   * The chart from the movements themselves.
   *
   * Every leg of every movement in the month is a flow between two endpoints, so a transfer
   * between two of your own accounts is on the chart for the same reason a salary is: it
   * moved. The static arrangement below stands in when there is no ledger service, so the
   * screen still explains itself with nothing behind it.
   */
  useEffect(() => {
    if (!live) { setLive_(null); return; }
    let off = false;
    (ledger as any)['flow.month']({ month, span })
      .then((res: { flows: Array<{ from: string; fromName: string; to: string; toName: string;
                                   amount: number; native: number; nativeUnit: string | null;
                                   count: number; kind: string }> }) => {
        if (off) return;
        setLive_(shape(res.flows, data, dm, balances));
      })
      .catch(() => { if (!off) setLive_(null); });
    return () => { off = true; };
  }, [live, version, month, span, data, dm, balances]);

  const entities = live_?.entities ?? ENTITIES;
  const flows = live_?.flows ?? FLOWS;

  const columns: Record<Column, Entity[]> = { source: [], account: [], sink: [] };
  for (const e of entities) columns[e.column].push(e);

  /**
   * The accounts, as rows of one bank each.
   *
   * An account with no institution behind it is still a row, just one without a boundary
   * drawn around it — cash in a drawer belongs on the chart as much as cash in a bank.
   */
  const bankRows: Array<{ name?: string; members: Entity[] }> = [];
  for (const e of columns.account) {
    const row = e.group ? bankRows.find((r) => r.name === e.group) : undefined;
    if (row) row.members.push(e);
    else bankRows.push({ name: e.group, members: [e] });
  }

  /**
   * A bank with more accounts than fit across is wrapped rather than allowed to run off the
   * page. Four is what a laptop shows without scrolling sideways; beyond that the row grows
   * downwards, still inside its own boundary.
   */
  const PER_LINE = 4;
  const linesOf = (r: { members: Entity[] }) => {
    const out: Entity[][] = [];
    for (let i = 0; i < r.members.length; i += PER_LINE) out.push(r.members.slice(i, i + PER_LINE));
    return out;
  };
  const rowH = (r: { name?: string; members: Entity[] }) => {
    const n = linesOf(r).length;
    return n * CARD_H + (n - 1) * GAP + (r.name ? HEAD + PAD * 2 : 0);
  };
  const rowW = (r: { members: Entity[] }) => {
    const across = Math.min(r.members.length, PER_LINE);
    return across * CARD_W.account + (across - 1) * GAP_X;
  };

  const accountsH = bankRows.reduce((h, r) => h + rowH(r), 0) + Math.max(bankRows.length - 1, 0) * GAP;
  const accountsW = Math.max(0, ...bankRows.map((r) => rowW(r) + (r.name ? PAD * 2 : 0)));
  const stackH = (col: Entity[]) => col.length * CARD_H + Math.max(col.length - 1, 0) * GAP;

  const body = Math.max(accountsH, stackH(columns.source), stackH(columns.sink));
  // room under the last row for a band that had to travel back around
  const height = TOP + body + 76;
  const sinkX = ACCOUNT_X + Math.max(accountsW, CARD_W.account) + COL_GAP;
  const width = sinkX + CARD_W.sink + 40;

  const box: Record<string, Box> = {};
  const groups: Array<{ name: string; x: number; y: number; w: number; h: number }> = [];

  // the middle: a row per bank, its accounts side by side inside it
  let y = TOP + (body - accountsH) / 2;
  for (const r of bankRows) {
    const inset = r.name ? PAD : 0;
    let cardY = y + (r.name ? HEAD + PAD : 0);
    for (const line of linesOf(r)) {
      let x = ACCOUNT_X + inset;
      for (const e of line) {
        box[e.id] = { x, y: cardY, w: CARD_W.account, h: CARD_H };
        x += CARD_W.account + GAP_X;
      }
      cardY += CARD_H + GAP;
    }
    if (r.name) {
      groups.push({ name: r.name, x: ACCOUNT_X, y, w: rowW(r) + PAD * 2, h: rowH(r) });
    }
    y += rowH(r) + GAP;
  }

  // the outer columns, each centred against the whole
  for (const [col, x] of [['source', SOURCE_X], ['sink', sinkX]] as Array<[Column, number]>) {
    const stack = columns[col];
    let top = TOP + (body - stackH(stack)) / 2;
    for (const e of stack) {
      box[e.id] = { x, y: top, w: CARD_W[col], h: CARD_H };
      top += CARD_H + GAP;
    }
  }

  /**
   * Where each amount sits.
   *
   * Two bands that meet near the same point put their labels in the same place, and the one
   * drawn second buries the first. Each label is placed where its own route says it belongs
   * and then pushed clear of anything already there, so an amount is always readable even
   * where the chart is busy.
   */
  /*
   * A band needs both its cards.
   *
   * An endpoint with no box left the geometry reading undefined and drawing a stroke from
   * nowhere to nowhere — a band floating clear of the chart with nothing at either end. If
   * a card is missing the band is not drawn at all, which is at least honest.
   */
  const drawn = flows.filter((f) => box[f.from] && box[f.to]);

  const labels = drawn.map((flow) => {
    const g = geometry(box[flow.from]!, box[flow.to]!);
    return { flow, x: g.labelX, y: g.labelY };
  });
  const cards = Object.values(box);
  const taken: Array<{ x: number; y: number; w: number }> = [];
  for (const l of labels) {
    const w = (l.flow.note ?? dm(l.flow.amount)).length * 6.6 + 16;
    const busy = (x: number, y: number) =>
      cards.some((c) => y + 11 > c.y && y - 11 < c.y + c.h && x + w / 2 > c.x && x - w / 2 < c.x + c.w)
      || taken.some((p) => Math.abs(p.y - y) < 24 && Math.abs(p.x - x) < (p.w + w) / 2);

    // Down first, then up. An amount pushed off the bottom of a busy chart is no more
    // readable than one buried under a card.
    let guard = 0;
    while (guard < 14 && busy(l.x, l.y)) { l.y += 13; guard++; }
    if (busy(l.x, l.y)) {
      l.y -= guard * 13;
      guard = 0;
      while (guard < 14 && busy(l.x, l.y)) { l.y -= 13; guard++; }
    }
    taken.push({ x: l.x, y: l.y, w });
  }

  // a month with nothing in it has no widest band, and Math.max of nothing is -Infinity
  const widest = Math.max(1, ...drawn.map((f) => f.amount));
  const thick = (n: number) => Math.max((n / widest) * 54, 3);

  /*
   * What came in is every band arriving from a source, not the ones arriving at one named
   * account — that read the fixture's own id and answered nothing on a real ledger.
   */
  const sum = (k: Kind) => drawn.filter((f) => f.kind === k).reduce((s, f) => s + f.amount, 0);
  const totals = { in: sum('in'), out: sum('out'), internal: sum('internal') };
  const sources = new Set(drawn.filter((f) => f.kind === 'in').map((f) => f.from)).size;
  const kept = totals.in - totals.out;

  return (
    <Page>
      <Panel>
        <Stats>
          <Stat label="Came in" value={`+${dm(totals.in)}`} color={TONE.in}
                sub={`${sources} ${sources === 1 ? 'source' : 'sources'}`} />
          <Stat label="Actually spent" value={`−${dm(totals.out)}`} color={TONE.out} sub="expenses, giving, bank charges" />
          <Stat label="Moved between things you own" value={dm(totals.internal)} color={TONE.internal} sub="between your own accounts and holdings" />
          <Stat label="Kept" value={`${kept < 0 ? '−' : '+'}${dm(Math.abs(kept))}`}
                color={kept < 0 ? TONE.out : TONE.in}
                sub={totals.in ? `${Math.round((kept / totals.in) * 100)}% of what came in` : 'nothing came in'} />
        </Stats>
      </Panel>

      <Panel title={spanName(month, span)}
             hint="Every source and every destination is an entity here — a salary, an account, a property, a category of spending, an obligation. Each band widens and deepens toward where the money went."
             action={
               <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
                 {/* An installment lands in the month it is due, so a property paid in July is
                     nowhere on September's chart. Without a way to move between months the
                     screen looked as though it had forgotten the property. */}
                 <Segmented ariaLabel="How far back the chart reads" value={span} onChange={setSpan}
                            options={[{ id: 'month', label: 'Month' },
                                      { id: 'quarter', label: 'Quarter' },
                                      { id: 'year', label: 'Year' },
                                      { id: 'all', label: 'All' }]} />
                 <div style={{ display: 'flex', alignItems: 'center', gap: 6,
                               visibility: span === 'all' ? 'hidden' : undefined }}>
                   <button className="btn quiet" style={{ padding: '6px 9px', lineHeight: 0 }}
                           aria-label="The month before" onClick={() => setMonth(step(month, -1))}>
                     <Icon name="chevron" size={15} motion="none" />
                   </button>
                   <button className="btn quiet" style={{ padding: '6px 9px', lineHeight: 0 }}
                           aria-label="The month after" disabled={month >= thisMonth}
                           onClick={() => setMonth(step(month, 1))}>
                     <Icon name="chevron" size={15} motion="none"
                           style={{ transform: 'rotate(180deg)' }} />
                   </button>
                   {month !== thisMonth && (
                     <button className="btn quiet" style={{ padding: '6px 11px', fontSize: 12 }}
                             onClick={() => setMonth(thisMonth)}>This month</button>
                   )}
                 </div>
                 <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                   <span style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'right', lineHeight: 1.35 }}>
                     Combine movements<br />
                     <span style={{ fontSize: 11, color: 'var(--faint)' }}>
                       {combined ? 'one band per pair' : 'one band per movement'}
                     </span>
                   </span>
                   <Toggle on={combined} onChange={setCombined} label="Combine movements between the same two entities" />
                 </label>
               </div>
             }>
        {drawn.length === 0 && (
          <Empty icon="flow"
                 title={span === 'all' ? 'Nothing has moved yet' : `Nothing moved in ${spanName(month, span)}`}
                 body="Every movement recorded against these months would be drawn here. Widen the span, or step back, to find one that had some." />
        )}
        <div style={{ overflowX: 'auto', display: drawn.length === 0 ? 'none' : undefined }}>
          <svg viewBox={`0 0 ${width} ${height}`} width="100%"
               style={{ minWidth: Math.min(width, 940) }} role="img"
               aria-label={drawn.map((f) => {
                 const a = entities.find((e) => e.id === f.from)!, b = entities.find((e) => e.id === f.to)!;
                 return `${a.label} to ${b.label}, ${Math.round(f.amount).toLocaleString('en-US')}`;
               }).join('; ')}>
            <defs>
              {(['in', 'internal', 'out'] as Kind[]).map((k) => (
                <linearGradient key={k} id={`g-${k}`} x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor={TONE[k]} stopOpacity="0.07" />
                  <stop offset="55%" stopColor={TONE[k]} stopOpacity="0.26" />
                  <stop offset="100%" stopColor={TONE[k]} stopOpacity="0.5" />
                </linearGradient>
              ))}
            </defs>

            <text x={SOURCE_X} y="46" fontSize="11" fontWeight="600" letterSpacing="1.2" fill="var(--faint)">WHERE IT CAME FROM</text>
            <text x={ACCOUNT_X} y="46" fontSize="11" fontWeight="600" letterSpacing="1.2" fill="var(--faint)">MY ACCOUNTS</text>
            <text x={width - 30} y="46" textAnchor="end" fontSize="11" fontWeight="600" letterSpacing="1.2" fill="var(--faint)">WHERE IT WENT</text>
            <line x1="40" y1="58" x2={width - 30} y2="58" stroke="var(--hairline)" />

            {drawn.map((f) => (
              <Band key={`${f.from}-${f.to}-${f.kind}`} flow={f} a={box[f.from]!} b={box[f.to]!}
                    t={thick(f.amount)} combined={combined} />
            ))}
            {groups.map((g) => (
              <g key={g.name}>
                <rect x={g.x} y={g.y} width={g.w} height={g.h} rx="16"
                      fill="color-mix(in srgb, var(--car) 4%, transparent)"
                      stroke="var(--hairline-strong)" strokeDasharray="5 4" />
                <text x={g.x + PAD} y={g.y + 20} fontSize="10" fontWeight="600" letterSpacing="0.9"
                      fill="var(--faint)">{g.name.toUpperCase()}</text>
              </g>
            ))}
            {entities.map((e) => <Card key={e.id} e={e} at={box[e.id]!} dm={dm} />)}
            {labels.map((l) => (
              <BandLabel key={`l-${l.flow.from}-${l.flow.to}-${l.flow.kind}`}
                         flow={l.flow} x={l.x} y={l.y} dm={dm} />
            ))}
          </svg>
        </div>

        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'center',
                      marginTop: 12, paddingTop: 16, borderTop: '1px solid var(--hairline)' }}>
          {(['in', 'internal', 'out'] as Kind[]).map((k) => (
            <span key={k} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--muted)' }}>
              <span style={{ width: 22, height: 8, borderRadius: 4, background: TONE[k], opacity: 0.5 }} />
              {k === 'in' ? 'Money arriving, and what stayed' : k === 'internal' ? 'Moving between things you own' : 'Actually spent'}
            </span>
          ))}
          <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--muted)' }}>
            The installment is amber, not red — the money became your equity.
          </span>
        </div>
      </Panel>
    </Page>
  );
}

interface Box { x: number; y: number; w: number; h: number }

/**
 * Where a band runs between two cards, and where its amount can sit.
 *
 * A band leaves and arrives by a side, never by the top or the bottom — bands dropping out
 * of the underside of a card and rising into another read as a different kind of thing from
 * the ones travelling across, and the chart stopped being one picture. What it no longer
 * does is insist on leaving by the right: a card behind another on the page is reached by
 * the left edge and the right one, which is the short way round rather than a loop.
 *
 * The loop survives for two cards that overlap across the page, where neither side has clear
 * air between them.
 */
function geometry(a: Box, b: Box) {
  const y0 = a.y + a.h / 2, y1 = b.y + b.h / 2;
  const rightwards = b.x + b.w / 2 >= a.x + a.w / 2;
  const clear = rightwards ? b.x - (a.x + a.w) : a.x - (b.x + b.w);

  if (clear <= 0) {
    // nothing clear to either side: out of the right edge, below the row, and back into the left
    const x0 = a.x + a.w, x1 = b.x;
    const mid = (x0 + x1) / 2;
    const detour = Math.max(a.y + a.h, b.y + b.h) + 46;
    return {
      around: true, x0, y0, x1, y1, mid, detour,
      spine: `M ${x0},${y0} C ${x0 + 70},${y0} ${x0 + 70},${detour} ${mid},${detour}`
           + ` C ${x1 - 70},${detour} ${x1 - 70},${y1} ${x1},${y1}`,
      labelX: mid, labelY: detour,
    };
  }

  const x0 = rightwards ? a.x + a.w : a.x;
  const x1 = rightwards ? b.x : b.x + b.w;
  const mid = (x0 + x1) / 2;
  return {
    around: false, x0, y0, x1, y1, mid, detour: 0,
    spine: `M ${x0},${y0} C ${mid},${y0} ${mid},${y1} ${x1},${y1}`,
    labelX: mid, labelY: (y0 + y1) / 2,
  };
}

/**
 * A band between two boxes.
 *
 * The band runs side to side and thickens up and down, whichever way round the two cards
 * are. The loop is kept for two cards with no clear air to either side, which is also what
 * that movement looks like: money leaving your accounts and arriving back in them.
 *
 * Direction is carried by a dashed centreline travelling along the band, so it reads without
 * an arrowhead — a shape that had already proved too heavy at this size.
 */
function Band({ flow, a, b, t, combined }: {
  flow: Flow; a: Box; b: Box; t: number; combined: boolean;
}) {
  const g = geometry(a, b);
  const bands = combined ? [t] : [t * 0.5, t * 0.3, t * 0.2];

  if (g.around) {
    const half = Math.max(2, t / 2);
    return (
      <g>
        <path d={g.spine} fill="none" stroke={TONE[flow.kind]} strokeOpacity="0.22"
              strokeWidth={half * 2} strokeLinecap="round" />
        <path d={g.spine} fill="none" stroke={TONE[flow.kind]} strokeOpacity="0.75"
              strokeWidth={1.5} strokeLinecap="round"
              strokeDasharray="7 9" className="flow-run" />
      </g>
    );
  }

  const { x0, y0, x1, y1, mid } = g;
  let acc = -t / 2;

  return (
    <g>
      {bands.map((bt, i) => {
        const from = y0 + acc + bt / 2, to = y1 + acc + bt / 2;
        acc += bt + (combined ? 0 : 4);
        const t0 = bt * 0.55;
        return (
          <g key={i}>
            <path
              d={`M ${x0},${from - t0 / 2} C ${mid},${from - t0 / 2} ${mid},${to - bt / 2} ${x1},${to - bt / 2}
                  L ${x1},${to + bt / 2} C ${mid},${to + bt / 2} ${mid},${from + t0 / 2} ${x0},${from + t0 / 2} Z`}
              fill={`url(#g-${flow.kind})`} stroke={TONE[flow.kind]} strokeOpacity="0.26" strokeWidth="1" />
            {i === 0 && (
              <path d={`M ${x0},${from} C ${mid},${from} ${mid},${to} ${x1},${to}`}
                    fill="none" stroke={TONE[flow.kind]} strokeOpacity="0.6"
                    strokeWidth={1.4} strokeLinecap="round"
                    strokeDasharray="7 9" className="flow-run" />
            )}
          </g>
        );
      })}
    </g>
  );
}

/** Amounts ride on top of everything, on their own plate, so nothing buries them. */
function BandLabel({ flow, x, y, dm }: { flow: Flow; x: number; y: number; dm: (n: number) => string }) {
  const text = flow.note ?? dm(flow.amount);
  const w = text.length * 6.6 + 16;
  return (
    <g>
      <rect x={x - w / 2} y={y - 11} width={w} height={22} rx="7"
            fill="var(--canvas)" stroke="var(--hairline)" />
      <text x={x} y={y + 4} textAnchor="middle" fontSize="11" fontWeight="600"
            fill={TONE[flow.kind]} fontFamily="var(--mono)">{text}</text>
    </g>
  );
}

function Card({ e, at, dm }: { e: Entity; at: Box; dm: (n: number) => string }) {
  const tone = e.tone ? TONE[e.tone] : 'var(--ink)';
  const sign = e.tone === 'out' ? '−' : e.tone === 'in' ? '+' : '';
  return (
    <g>
      <rect x={at.x} y={at.y} width={at.w} height={at.h} rx="12" fill="var(--surface)" stroke="var(--hairline)" />
      <rect x={at.x + 16} y={at.y + 14} width="32" height="32" rx="9"
            fill={`color-mix(in srgb, ${tone} 14%, transparent)`} />
      <foreignObject x={at.x + 24} y={at.y + 22} width="18" height="18">
        <Icon name={e.icon} size={17} color={tone} />
      </foreignObject>
      <text x={at.x + 58} y={at.y + 30} fontSize="14" fontWeight="600" fill="var(--ink)">{e.label}</text>
      <text x={at.x + 58} y={at.y + 46} fontSize="11" fill="var(--faint)">{e.sub}</text>
      <line x1={at.x + 16} y1={at.y + 62} x2={at.x + at.w - 16} y2={at.y + 62} stroke="var(--hairline)" />
      <text x={at.x + 16} y={at.y + 80} fontSize="10" fontWeight="600" letterSpacing="0.8" fill="var(--faint)">{e.flowLabel}</text>
      <text x={at.x + at.w - 16} y={at.y + 82} textAnchor="end" fontSize="17" fontWeight="500"
            fill={tone} fontFamily="var(--mono)">{sign}{dm(e.flow)}</text>
      {/* an account has a balance to state as well as what moved; everything else was
          printing the same figure twice, once under each heading */}
      {e.stockLabel && (
        <>
          <text x={at.x + 16} y={at.y + 96} fontSize="10" fontWeight="600" letterSpacing="0.8" fill="var(--faint)">{e.stockLabel}</text>
          <text x={at.x + at.w - 16} y={at.y + 97} textAnchor="end" fontSize="13" fontWeight="500"
                fill="var(--muted)" fontFamily="var(--mono)">
            {typeof e.stock === 'number' ? dm(e.stock) : e.stock}
          </text>
        </>
      )}
      {e.kept != null && (
        <>
          <text x={at.x + 16} y={at.y + 111} fontSize="10" fontWeight="600" letterSpacing="0.8"
                fill="var(--faint)">{e.keptLabel}</text>
          <text x={at.x + at.w - 16} y={at.y + 112} textAnchor="end" fontSize="13" fontWeight="500"
                fill={TONE.in} fontFamily="var(--mono)">{dm(e.kept)}</text>
        </>
      )}
    </g>
  );
}


/**
 * Turning legs into a chart.
 *
 * A leg names two endpoints and an amount, and this decides what each endpoint is.
 *
 * The left-hand column is income and nothing else: a salary, a rent, a piece of freelance
 * work — the sources you have declared, whether they arrive on a date or whenever they
 * happen. What it is not is every direction money has ever arrived from. A friend repaying
 * what you lent, a correction, a borrowing — those are movements, not earnings, and drawn as
 * sources they made the month look like income it was not. Those legs are left off the
 * chart rather than dressed up as a source.
 *
 * Metal and shares are each one thing rather than a card per node: gold and silver are the
 * one ledger you keep them in, and the brokerage cash and the book behind it are the one
 * wallet you trade from. Splitting them put two halves of the same holding on opposite sides
 * of the page.
 */

/** the holdings that are drawn as a single object rather than a card per node */
const GROUPED = {
  metals: { label: 'Gold and silver ledger', one: 'holding', many: 'holdings',
            icon: 'gold' as IconName, tone: 'internal' as Kind },
  stocks: { label: 'Stocks wallet', one: 'position', many: 'positions',
            icon: 'stocks' as IconName, tone: 'internal' as Kind },
  expenses: { label: 'Expenses', one: 'category', many: 'categories',
              icon: 'expenses' as IconName, tone: 'out' as Kind },
  giving: { label: 'Zakat and Sadaqat', one: 'cause', many: 'causes',
            icon: 'zakat' as IconName, tone: 'out' as Kind },
  debts: { label: 'Debt payments', one: 'counterparty', many: 'counterparties',
           icon: 'handshake' as IconName, tone: 'internal' as Kind },
};

function shape(
  rows: Array<{ from: string; fromName: string; to: string; toName: string;
                amount: number; native: number; nativeUnit: string | null;
                count: number; kind: string }>,
  data: ReturnType<typeof useApp>['data'],
  dm: (egp: number, dp?: number) => string,
  balances: Record<string, number>,
): { entities: Entity[]; flows: Flow[] } {
  const nodeOf = (id: string) => data.nodes.find((n) => n.id === id);
  const instOf = (id: string) => data.institutions.find((i) => i.id === nodeOf(id)?.parentId);
  const categoryOf = (id: string) => data.categories.find((c) => c.id === id);
  const sourceOf = (id: string) => {
    const n = nodeOf(id);
    return n && data.incomeSources.find((i) => i.name === n.name);
  };

  /** gold and silver are one object, and so are the brokerage's cash and its book */
  const groupOf = (id: string): keyof typeof GROUPED | null => {
    // the brokerage's two halves are named by id across the app — the screens and the
    // service both reach for 'brokerage-cash' the same way
    if (id === 'brokerage' || id === 'brokerage-cash') return 'stocks';
    const cat = data.categories.find((c) => c.id === id);
    if (cat) return cat.domain === 'charity' ? 'giving' : 'expenses';
    if (id.startsWith('debt-')) return 'debts';
    const n = nodeOf(id);
    if (!n) return null;
    if (n.unit === 'g') return 'metals';
    if (n.unit === 'share' || n.priceKey?.startsWith('price_')) return 'stocks';
    if (n.kind === 'liability') return 'debts';
    return null;
  };

  /**
   * Yours to send from: an account, or a holding you can sell back into one.
   *
   * A debt is deliberately not on this list. Money arriving because somebody repaid you is
   * a movement rather than a month's earnings, and drawing it made a chart of what you live
   * on into a chart of everything that touched an account.
   */
  const mine = (id: string) =>
    nodeOf(id)?.kind === 'cash' || groupOf(id) === 'metals' || groupOf(id) === 'stocks';
  /** a debt either way round, and a settled one has already left the catalogue */
  const isDebt = (id: string) => id.startsWith('debt-') || nodeOf(id)?.kind === 'liability';
  /**
   * Yours, in the sense that matters here: the money is still yours after the movement.
   * Repaying what you borrowed cancels an obligation and an installment buys equity —
   * counted as spending, a month of settling up looked like a month of living far beyond
   * your means. Only what leaves for a category, a charity or the outside is spent.
   */
  const own = (id: string) => {
    const g = groupOf(id);
    // spending and giving are grouped onto one card each, which does not make them yours
    if (g) return g !== 'expenses' && g !== 'giving';
    const n = nodeOf(id);
    // a category of spending is not a node, and 'outside' is not one either
    return n ? n.kind !== 'external' : false;
  };
  /** a declared income source — the only thing the left-hand column is allowed to hold */
  const earned = (id: string) => nodeOf(id)?.kind === 'external';

  /** the id a leg is drawn against, which is the group's when the endpoint is in one */
  const endpoint = (id: string) => groupOf(id) ?? id;

  const seen = new Map<string, Entity>();
  const total = new Map<string, number>();
  const members: Partial<Record<keyof typeof GROUPED, Set<string>>> = {};

  const touch = (id: string, name: string, side: 'from' | 'to', amount: number) => {
    const key = endpoint(id);
    total.set(key, (total.get(key) ?? 0) + amount);

    const grouped = groupOf(id);
    // what the group is made of, counted on every leg — recorded only when the card was
    // first made, a group of eight said it stood for one
    if (grouped) (members[grouped] ??= new Set()).add(nodeOf(id)?.name ?? categoryOf(id)?.name ?? name);

    if (seen.has(key)) return;

    if (grouped) {
      seen.set(key, {
        id: key, label: GROUPED[grouped].label, sub: '',
        column: 'sink', icon: GROUPED[grouped].icon, tone: GROUPED[grouped].tone,
        flowLabel: 'moved', flow: 0, stockLabel: '', stock: 0,
      });
      return;
    }

    const n = nodeOf(id);
    const cat = categoryOf(id);
    const src = sourceOf(id);
    const inst = instOf(id);
    const cash = n?.kind === 'cash';
    const debt = isDebt(id);

    const icon: IconName =
      cash ? 'banknote'
      : src && hasIcon(src.icon) ? src.icon
      // the same fallback the Income screen uses, so a source is not one picture there and
      // another here
      : n?.kind === 'external' ? 'income'
      : cat && hasIcon(cat.icon) ? cat.icon
      : cat?.domain === 'charity' ? 'hands'
      : debt ? 'handshake'
      : n?.kind === 'asset' ? 'realestate'
      : 'expenses';

    const sub =
      cash ? `${inst ? `${inst.name} · ` : ''}${n?.currency ?? n?.unit ?? ''}`.trim()
      : src ? (src.scheduled ? `${src.cadence}${src.dayOfMonth ? ` · day ${src.dayOfMonth}` : ''}` : src.cadence)
      : n?.kind === 'external' ? 'income source'
      // a settled debt has left the catalogue, and guessing which way it ran from its name
      // is how a repayment ends up labelled as a loan
      : debt ? (n?.kind === 'asset' ? 'money you lent'
              : n?.kind === 'liability' ? 'money you owe' : 'a debt')
      : cat ? (cat.domain === 'charity' ? 'giving' : 'spending')
      : n?.kind === 'asset' ? 'something you own'
      : 'no destination recorded';

    seen.set(key, {
      id: key,
      // a leg with no destination is money that simply left — the service calls that
      // endpoint 'outside', which is a fine id and a poor thing to print on a card
      label: n?.name ?? cat?.name ?? (id === 'outside' ? 'Outside your accounts' : name),
      sub,
      column: cash ? 'account' : side === 'from' ? 'source' : 'sink',
      icon,
      tone: cash ? undefined : side === 'from' ? 'in' : debt || n?.kind === 'asset' ? 'internal' : 'out',
      // an account both sends and receives, so the figure on it is what moved, not what came
      // in — the first leg that happened to mention it was deciding the wording
      flowLabel: cash ? 'moved' : side === 'from' ? 'in' : 'out',
      flow: 0,
      stockLabel: cash ? 'balance now' : '',
      stock: 0,
      group: cash && inst ? inst.name : undefined,
    });
  };

  const flows: Flow[] = rows
    // Money arriving from anything but a declared source — a debt repaid, a correction, a
    // one-off nobody will see again — is a movement rather than income, and is left off.
    .filter((r) => r.amount > 0 && (mine(r.from) || earned(r.from)))
    .map((r) => {
      touch(r.from, r.fromName, 'from', r.amount);
      touch(r.to, r.toName, 'to', r.amount);
      const kind: Kind = own(r.from) && own(r.to) ? 'internal'
                       : own(r.to) ? 'in' : 'out';
      // A movement in a currency other than the ledger's says so, rather than being silently
      // restated — 5,500 dollars is not 5,500 pounds.
      const foreign = r.nativeUnit && r.nativeUnit !== 'EGP'
        ? `${r.nativeUnit} ${Math.round(r.native).toLocaleString()}`
        : undefined;
      return { from: endpoint(r.from), to: endpoint(r.to), amount: r.amount, kind,
               count: r.count, note: foreign };
    })
    // two nodes of one group are one object, so a leg between them has nowhere left to go
    .filter((f) => f.from !== f.to);

  /*
   * One band per pair and direction.
   *
   * Grouping brings pairs together that were distinct legs — a purchase and an exchange
   * between the same two accounts, gold and silver bought from the same current account —
   * and two bands with the same ends are drawn on top of each other, each one hiding how
   * much the other was for.
   */
  const merged = new Map<string, Flow>();
  for (const f of flows) {
    const key = `${f.from}|${f.to}|${f.kind}`;
    const at = merged.get(key);
    if (!at) { merged.set(key, { ...f }); continue; }
    at.amount += f.amount;
    at.count += f.count;
    // two legs in different currencies have no one figure to quote
    if (at.note !== f.note) at.note = undefined;
  }

  /*
   * A grouped card names what it stands for.
   *
   * One card per category turned a month of ordinary spending into eight destinations, none
   * of them large enough to matter and all of them competing with the installment for the
   * eye. Grouped, the card says what it is made of — "3 categories · Travel, Health and one
   * more" — and the Expenses screen is where the detail lives.
   */
  const madeOf = (key: string) => {
    const set = members[key as keyof typeof GROUPED];
    if (!set) return '';
    const names = [...set];
    const g = GROUPED[key as keyof typeof GROUPED];
    const listed = names.length <= 2 ? names.join(' and ')
      : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
    const counted = `${names.length} ${names.length === 1 ? g.one : g.many}`;
    // the sub line is one line on a card, and a long name simply runs off the edge of it
    const full = `${counted} · ${listed}`;
    return full.length <= 36 ? full : counted;
  };

  const entities = [...seen.values()].map((e) => ({
    ...e,
    sub: e.id in members ? madeOf(e.id) : e.sub,
    flow: total.get(e.id) ?? 0,
    stock: e.column === 'account'
      ? dm(balances[e.id] ?? 0)
      : dm(total.get(e.id) ?? 0),
  }));

  return { entities, flows: [...merged.values()] };
}
