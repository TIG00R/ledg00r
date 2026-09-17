import { useCallback, useEffect, useState } from 'react';
import { Amount } from '../components/Amount';
import { useApp, market } from '../AppState';
import { Select, opts } from '../components/Select';
import { computedPositions, brokerageCash, money, fmt } from '@ledger/engine';
import { Page, Panel, Stat, Stats, Chip, Toggle, Field, Row } from '../components/UI';
import { Donut } from '../components/Donut';
import { Icon, type IconName } from '../components/Icon';
import { ActionButton, useLive } from '../Live';
import { ledger } from '../api';
import { ConfirmDelete } from '../components/Confirm';
import { DateField } from '../components/DateField';
import { RecordTable } from '../components/RecordTable';
import { OperationPanel } from '../components/Operations';
import { Segmented } from '../components/Segmented';
import { ModeProvider, useMode } from '../components/ModeBar';
import { SectionProvider, Sections, useSection } from '../components/Sections';

/**
 * One colour per holding.
 *
 * Four of them, cycled, meant a fifth share was drawn in the same colour as the first, and
 * with them next to each other on the ring two different companies read as one slice. These
 * are ten hues spaced around the wheel, none of them the green or the red that mean gain and
 * loss everywhere else on this screen, and each is fixed to the ticker rather than to the
 * row's position — so a share keeps its colour when the order of the book changes.
 */
const PALETTE = [
  '#4C6FFF', '#F0883E', '#00B0A0', '#C850C0', '#7A5AF8',
  '#2AA0E8', '#D9455F', '#6BAF3C', '#A2703F',
];

/**
 * The wallet's two parts, kept out of the holdings' colours on purpose.
 *
 * Grey for cash that is free, and the same gold a pending order is chipped with for the cash
 * one has already spoken for — so the two places pending appears on this screen agree. No
 * holding is drawn in either, which is why there is no yellow left in the palette above.
 */
const FREE_CASH = 'var(--disabled)';
const HELD_CASH = 'var(--gold)';

/**
 * A colour for every ticker on the chart, none of them repeated.
 *
 * Where the colour starts is decided by the ticker's own letters, so a share keeps the same
 * one as the book grows and shrinks around it — a running index would have handed it a new
 * colour the moment another share was sold. Where two tickers want the same hue the second
 * walks on to the next free one, because two slices drawn alike is the failure being fixed
 * here and stability is worth less than telling them apart. Past ten holdings the palette is
 * genuinely exhausted and it cycles.
 */
function paletteFor(tickers: string[]): Record<string, string> {
  const taken = new Set<number>();
  const out: Record<string, string> = {};
  for (const ticker of [...tickers].sort()) {
    let h = 0;
    for (const ch of ticker) h = (h * 31 + ch.charCodeAt(0)) % 10007;
    let i = h % PALETTE.length;
    for (let step = 0; step < PALETTE.length && taken.has(i); step += 1) {
      i = (i + 1) % PALETTE.length;
    }
    taken.add(i);
    out[ticker] = PALETTE[i]!;
  }
  return out;
}

export function Stocks() {
  return (
    <ModeProvider>
      <SectionProvider first="book"><Body /></SectionProvider>
    </ModeProvider>
  );
}

function Body() {
  const { data, dm, balances, reminders, setReminders } = useApp();
  const { run } = useLive();

  /**
   * Which tickers this ledger knows.
   *
   * Whatever has been traded, plus whatever has a price recorded — not a list fetched from
   * an exchange, because this is a notebook and the only shares it knows are the ones you
   * have written down.
   */
  const tickers = [...new Set([
    ...data.orders.map((o) => o.ticker),
    // the price table also carries the metals, which are weighed rather than traded in shares
    ...Object.keys(market.prices).filter((k) => TICKER.test(k)),
  ])].sort();
  const { mode } = useMode();
  const { tab } = useSection();

  const positions = computedPositions(data.orders, market.prices);
  /** what there is any of to sell — a share sold down to nothing is not among them */
  const owned = positions.map((p) => p.ticker);
  const colours = paletteFor(positions.map((p) => p.ticker));
  const value = positions.reduce((s, p) => s + p.value, 0);
  const cost = positions.reduce((s, p) => s + p.cost, 0);

  /**
   * What is actually in the brokerage wallet.
   *
   * The wallet is an account in the ledger like any other, and its balance is what has been
   * paid into it less what orders have taken out. It used to be worked out here instead, from
   * a starting figure in settings — which a ledger kept by the service leaves at nought, so
   * every order logged drove the figure further below zero and the ring was being asked to
   * draw a negative share of a total the same minus had shrunk. Where there is no such account
   * — the sample book has none — the old derivation still answers.
   */
  const walletNode = data.nodes.find((n) => n.priceKey === 'brokerage_cash')
                  ?? data.nodes.find((n) => n.id === 'brokerage-cash');
  const wallet = walletNode ? balances[walletNode.id] ?? walletNode.openingQty : brokerageCash(data);

  /**
   * Cash spoken for by orders that have not executed.
   *
   * A pending buy moves nothing — that is what pending means — but the money behind it is not
   * free either, and a wallet that reads as entirely spendable when half of it is committed is
   * the wrong number to make the next decision against. It is held back here rather than
   * posted, because nothing has happened yet and the ledger records what happened.
   *
   * It cannot claim more than the wallet holds: an order written for money that is not there
   * is an intention, not a reservation, and the shortfall is shown as such.
   */
  const pendingBuys = data.orders.filter((o) => o.status === 'pending' && o.side === 'BUY');
  const committed = pendingBuys.reduce((s, o) => s + (o.total || o.shares * o.price), 0);
  const reserved = Math.max(0, Math.min(committed, Math.max(0, wallet)));
  const free = wallet - reserved;
  const uncovered = committed - reserved;

  const book = value + wallet;
  const pl = value - cost;

  const slices = [
    ...positions.map((p) => ({ label: p.ticker, value: p.value, color: colours[p.ticker]! })),
    { label: 'Free cash', value: free, color: FREE_CASH },
    { label: 'Held for pending buys', value: reserved, color: HELD_CASH },
  ];
  /** what the ring is dividing up, so the shares beside it add to a hundred and no more */
  const drawn = slices.reduce((s, x) => s + Math.max(0, x.value), 0);

  const stockReminders = reminders.filter((r) => r.subject === 'stock');
  const update = (id: string, patch: Partial<(typeof reminders)[number]>) =>
    setReminders(reminders.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const detail = (t: string) => (market as any).priceDetail?.[t];

  const [alert, setAlert] = useState({
    ticker: '', direction: 'buy' as 'buy' | 'sell', price: 0, note: '', dueDate: '',
  });
  const alertTicker = alert.ticker || tickers[0] || '';

  return (
    <Page>
      <Sections sections={[
        { id: 'book', label: 'The book', icon: 'stocks',
          hint: 'What you hold, valued at the price you last recorded.',
          editHint: 'Correct a record after the fact.' },
        { id: 'orders', label: 'Orders', icon: 'ledger',
          hint: 'Every order logged, and why it was made.',
          editHint: 'Undo an order. It writes the opposite rather than erasing it.' },
        { id: 'intentions', label: 'Intentions', icon: 'bell',
          hint: 'What you mean to do, and the reason — this ledger watches no market.' },
        { id: 'notebook', label: 'Notebook', icon: 'ledger',
          hint: 'What you thought about a share, and what it paid out — held or not.',
          editHint: 'Rewrite a note or a payout, move it to another day, year, or ticker.' },
      ]} />

      {/*
        * The book, in one ring: every share held, the cash still free, and the cash a pending
        * order has already spoken for. The three add up to what the book is worth, which is
        * why they are drawn together rather than the cash being a footnote beside them.
        */}
      <Panel>
        <div style={{ display: 'flex', gap: 36, alignItems: 'center', flexWrap: 'wrap' }}>
          <Donut slices={slices} size={190} thickness={26} format={dm} centre={
            <>
              <span className="mono" style={{ fontSize: 17, fontWeight: 500 }}>{dm(book)}</span>
              <span style={{ fontSize: 10, color: 'var(--faint)' }}>total book</span>
              <span className="mono" style={{ fontSize: 12, marginTop: 4, color: pl >= 0 ? 'var(--positive)' : 'var(--negative)' }}>
                {pl >= 0 ? '+' : '−'}{dm(Math.abs(pl))} · {cost > 0 ? `${((pl / cost) * 100).toFixed(1)}%` : '—'}
              </span>
            </>
          } />
          <div style={{ flex: 1, minWidth: 300 }}>
            <Stats>
              <Stat label="Deployed" value={dm(cost)} sub="what the shares cost" />
              <Stat label="Value now" value={dm(value)}
                    sub={`${pl >= 0 ? '+' : '−'}${dm(Math.abs(pl))} against cost`} />
              <Stat label="Wallet" value={dm(wallet)} sub="cash sitting in the brokerage"
                    color={wallet < 0 ? 'var(--negative)' : undefined} />
              <Stat label="Held for pending" value={dm(reserved)} sub="behind orders not yet filled"
                    color={reserved > 0 ? HELD_CASH : undefined} />
            </Stats>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 18 }}>
              {slices.filter((s) => s.value > 0).map((s) => (
                <span key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--muted)' }}>
                  <span style={{ width: 9, height: 9, borderRadius: 3, background: s.color }} />
                  {s.label} {drawn > 0 ? `${((s.value / drawn) * 100).toFixed(1)}%` : '—'}
                </span>
              ))}
            </div>

            {/*
              * Two things the ring cannot say, because neither is a share of anything: a
              * wallet that has been drawn past empty, and orders written for money that is
              * not in it. Both are stated in words underneath instead.
              */}
            {wallet < 0 && (
              <p style={{ margin: '14px 0 0', fontSize: 12, color: 'var(--negative)', lineHeight: 1.45 }}>
                The wallet is {dm(Math.abs(wallet))} overdrawn — more has been spent on orders
                than was ever paid into the book. Fund the book, or correct the orders that
                were logged as executed.
              </p>
            )}
            {uncovered > 0 && (
              <p style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--muted)', lineHeight: 1.45 }}>
                Pending buys come to {dm(committed)}, which is {dm(uncovered)} more than the
                wallet holds.
              </p>
            )}
          </div>
        </div>
      </Panel>

      {/*
        * Funding the book sits under the chart it changes, rather than in a column beside
        * every tab: putting money in is something you do to the book, and the book is what
        * the chart above is drawing. It steps aside while records are being corrected, the
        * same as every other panel that writes a movement.
        */}
      {tab === 'book' && mode !== 'edit' && (
        <OperationPanel title="Fund the book"
          hint="The wallet is the raw cash sitting at the broker. It has to arrive from somewhere, and buying a position later moves it again — out of the wallet and into the holding.">
          <BookTransfer />
        </OperationPanel>
      )}

      {tab === 'book' && (
      <Panel title="Positions"
             hint="Held from the orders you logged, and valued at the price you last recorded. A position with no price is shown at cost.">
        <RecordTable
          rows={positions}
          rowKey={(p2) => p2.ticker}
          sort={{ key: 'value', dir: 'desc' }}
          empty={{ icon: 'stocks', title: 'Nothing held',
                   body: 'Log an executed order and the position appears here.' }}
          columns={[
            { key: 'ticker', label: 'Ticker', kind: 'pick',
              value: (p2) => p2.ticker,
              cell: (p2) => <span style={{ fontWeight: 600 }}>{p2.ticker}</span> },
            { key: 'shares', label: 'Shares', kind: 'amount', align: 'right',
              value: (p2) => p2.shares,
              cell: (p2) => <span className="mono">{fmt(p2.shares)}</span> },
            { key: 'avg', label: 'Avg buy', kind: 'amount', align: 'right',
              value: (p2) => p2.avgBuy,
              cell: (p2) => <span className="mono">{p2.avgBuy.toFixed(2)}</span> },
            { key: 'cost', label: 'Cost', kind: 'amount', align: 'right',
              value: (p2) => p2.cost, cell: (p2) => <span className="mono">{dm(p2.cost)}</span> },
            { key: 'price', label: 'Price now', kind: 'amount', align: 'right',
              value: (p2) => p2.price,
              cell: (p2) => (
                <span className="mono" style={{ color: market.prices[p2.ticker] == null ? 'var(--faint)' : undefined }}>
                  {market.prices[p2.ticker] != null ? p2.price.toFixed(2) : 'none set'}
                </span>
              ) },
            { key: 'value', label: 'Value', kind: 'amount', align: 'right',
              value: (p2) => p2.value, cell: (p2) => <span className="mono">{dm(p2.value)}</span> },
            { key: 'pl', label: 'Against cost', kind: 'amount', align: 'right',
              value: (p2) => p2.value - p2.cost,
              cell: (p2) => {
                const gain = p2.value - p2.cost;
                return (
                  <span className="mono" style={{ color: gain >= 0 ? 'var(--positive)' : 'var(--negative)' }}>
                    {gain >= 0 ? '+' : '−'}{dm(Math.abs(gain))}
                    <span style={{ display: 'block', fontSize: 11, color: 'var(--faint)' }}>
                      {p2.cost ? `${((gain / p2.cost) * 100).toFixed(1)}%` : ''}
                    </span>
                  </span>
                );
              } },
          ]}
        />
      </Panel>
      )}

      {tab === 'orders' && (
      <Panel title="Order log"
             hint="What you did and why. An executed order moves cash and the position; a pending one records the intention and moves nothing.">
        <RecordTable
          rows={data.orders}
          rowKey={(o) => o.id}
          sort={{ key: 'date', dir: 'desc' }}
          empty={{ icon: 'ledger', title: 'No orders logged',
                   body: 'This is a notebook — write down what you did and why.' }}
          columns={[
            { key: 'date', label: 'Date', kind: 'date',
              value: (o) => o.date,
              cell: (o) => <span className="mono" style={{ fontSize: 13 }}>{o.date}</span>,
              field: (d, set) => <DateField value={d.date} onChange={(v) => set({ date: v })} ariaLabel="Date" /> },
            { key: 'ticker', label: 'Ticker', kind: 'pick',
              value: (o) => o.ticker,
              cell: (o) => <span style={{ fontWeight: 600 }}>{o.ticker}</span>,
              field: (d, set, row) => <TickerPick draft={d} set={set} known={tickers} owned={owned}
                                                  existing={row?.ticker} /> },
            { key: 'side', label: 'Side', kind: 'pick',
              value: (o) => o.side,
              cell: (o) => <span style={{ color: o.side === 'BUY' ? 'var(--positive)' : 'var(--negative)' }}>{o.side}</span>,
              field: (d, set) => <Select ariaLabel="Side" value={d.side} onChange={(v) => set({ side: v })}
                                         options={[{ value: 'BUY', label: 'Buy' }, { value: 'SELL', label: 'Sell' }]} /> },
            { key: 'shares', label: 'Shares', kind: 'amount', align: 'right',
              value: (o) => o.shares,
              cell: (o) => <span className="mono">{fmt(o.shares)}</span>,
              field: (d, set) => <Amount value={d.shares} ariaLabel="Shares" onChange={(n) => set({ shares: n })} /> },
            { key: 'price', label: 'Price', kind: 'amount', align: 'right',
              value: (o) => o.price,
              cell: (o) => <span className="mono">{o.price.toFixed(2)}</span>,
              field: (d, set) => <Amount value={d.price} ariaLabel="Price" onChange={(n) => set({ price: n })} /> },
            { key: 'total', label: 'Total', kind: 'amount', align: 'right',
              value: (o) => o.total,
              cell: (o) => <span className="mono">{dm(o.total)}</span>,
              // What it came to follows from the shares and the price rather than being typed,
              // so while a row is open it shows what those two currently make.
              field: (d) => (
                <span className="mono" style={{ color: 'var(--faint)' }}>
                  {dm((Number(d.shares) || 0) * (Number(d.price) || 0))}
                </span>
              ) },
            { key: 'status', label: 'Status', kind: 'pick',
              value: (o) => o.status,
              cell: (o) => <Chip tone={o.status === 'executed' ? 'good'
                                     : o.status === 'pending' ? 'warn' : 'neutral'}>{o.status}</Chip>,
              field: (d, set) => <Select ariaLabel="Status" value={d.status} onChange={(v) => set({ status: v })}
                options={[{ value: 'executed', label: 'Executed' }, { value: 'pending', label: 'Pending' },
                          { value: 'cancelled', label: 'Cancelled' }]} /> },
            // The reasoning is the longest thing in the row and was being written through a
            // slot narrower than a ticker. It keeps the width it needs and, while the row is
            // open, a box with more than one line in it.
            { key: 'note', label: 'Comment', kind: 'text', width: '260px',
              value: (o) => (o as { note?: string }).note ?? '',
              cell: (o) => <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                {(o as { note?: string }).note || <span style={{ color: 'var(--faint)' }}>—</span>}</span>,
              field: (d, set) => <textarea aria-label="Comment" rows={3} placeholder="the reasoning"
                                           value={d.note}
                                           onChange={(e) => set({ note: e.target.value })} /> },
          ]}
          add={{
            label: 'Log an order',
            capability: 'order.log',
            blank: { date: new Date().toISOString().slice(0, 10), ticker: tickers[0] ?? '',
                     side: 'BUY', shares: 0, price: 0, status: 'executed', note: '' },
            // A sale is of something held: the picker only offers those, and the button
            // agrees with it rather than letting a typed ticker slip past.
            valid: (d) => d.shares > 0 && d.price > 0 && TICKER.test(String(d.ticker))
              && (d.side !== 'SELL' || owned.includes(d.ticker)),
            build: (d) => ({ ticker: d.ticker, side: d.side, shares: d.shares, price: d.price,
                             status: d.status, date: d.date, note: d.note || undefined }),
          }}
          edit={{
            capability: 'order.correct',
            draftOf: (o) => ({ date: o.date, ticker: o.ticker, side: o.side, shares: o.shares,
                               price: o.price, status: o.status,
                               note: (o as { note?: string }).note ?? '' }),
            build: (d, o) => ({ orderId: o.id, ticker: d.ticker, side: d.side,
                                shares: Number(d.shares), price: Number(d.price),
                                status: d.status, date: d.date, note: d.note ?? '' }),
          }}
          remove={{
            capability: 'movement.undo',
            build: (o) => ({ movementId: (o as { movementId?: string }).movementId }),
            what: (o) => `${o.side} ${o.shares} ${o.ticker}`,
            blocked: (o) => ((o as { movementId?: string }).movementId ? undefined
              : 'This order predates the movement log, so there is nothing to reverse.'),
          }}
        />
      </Panel>
      )}

      {tab === 'notebook' && <Notebook knownTickers={tickers} />}
    </Page>
  );
}

/** What the ledger will accept as a ticker, so a new one is refused here rather than there. */
const TICKER = /^[A-Z][A-Z0-9.]{0,11}$/;

/** the picker's own entry for "none of these" — not a ticker, so it cannot be one */
const WRITE_ONE = '\u0000new';

/**
 * Which share an order is for.
 *
 * Two things the plain picker could not do. A share this ledger has never seen had to be
 * traded elsewhere first before it could be logged here, which for a notebook is backwards —
 * the first buy of a company is exactly the order worth writing down, so the list ends with a
 * way to write one that is not on it. And the list offered every ticker for a sale as well as
 * for a buy, including shares that were never held or have already been sold out of, which is
 * an order that cannot be true; on a sale it offers only what there is some of.
 *
 * A row being corrected keeps its own ticker on offer however far the position has since
 * fallen — a sale that closed a holding is still a sale of it, and correcting the price of
 * one should not quietly move it to another company.
 */
function TickerPick({ draft, set, known, owned, existing }: {
  draft: Record<string, any>;
  set: (patch: Record<string, any>) => void;
  known: string[]; owned: string[]; existing?: string;
}) {
  const selling = draft.side === 'SELL';
  const [writing, setWriting] = useState(false);
  const choices = [...new Set([...(selling ? owned : known), ...(existing ? [existing] : [])])].sort();

  /**
   * Switching a draft to a sale can leave it naming a share there is none of. The draft
   * follows the list rather than the list being quietly wrong: a row already written keeps
   * its ticker, and anything else falls to the first share actually held.
   */
  useEffect(() => {
    if (!selling || writing) return;
    if (choices.includes(draft.ticker)) return;
    set({ ticker: choices[0] ?? '' });
  }, [selling, writing, draft.ticker, choices.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  // Nothing is held, so there is nothing this sale could be of.
  if (selling && choices.length === 0) {
    return <span style={{ fontSize: 11, color: 'var(--faint)' }}>nothing held to sell</span>;
  }

  if (writing) {
    const typed = String(draft.ticker ?? '');
    return (
      <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <input aria-label="New ticker" value={typed} placeholder="NVDA" autoFocus
               style={{ width: 110, textTransform: 'uppercase' }}
               onChange={(e) => set({ ticker: e.target.value.toUpperCase() })} />
        <button type="button" onClick={() => { setWriting(false); set({ ticker: choices[0] ?? '' }); }}
                style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                         fontSize: 11, color: 'var(--faint)', textAlign: 'left' }}>
          pick a known one
        </button>
        {typed && !TICKER.test(typed) && (
          <span style={{ fontSize: 11, color: 'var(--negative)' }}>letters and digits, twelve at most</span>
        )}
      </span>
    );
  }

  return (
    <Select ariaLabel="Ticker" value={draft.ticker}
            onChange={(v) => {
              if (v === WRITE_ONE) { setWriting(true); set({ ticker: '' }); return; }
              set({ ticker: v });
            }}
            options={[
              ...opts(choices),
              // only on a buy: the first of a share you do not have cannot be a sale
              ...(selling ? [] : [{ value: WRITE_ONE, label: '+ A ticker not listed',
                                    hint: 'write one this ledger has not seen' }]),
            ]} />
  );
}

interface Note {
  id: string; ticker: string; name: string | null;
  date: string; note: string; createdAt: string; updatedAt: string | null;
}

interface Followed {
  ticker: string; name: string | null; notes: number;
  latestNote: string | null; latestOn: string | null;
}

/**
 * One list out of the ledger, or an empty one.
 *
 * A service that does not answer — an older one that has never heard of this capability, or
 * one that is down — leaves the panel empty rather than taking the screen down with it. The
 * name is looked up rather than called straight, because a capability that is not there is
 * not a function and calling it would throw before there was a promise to catch.
 */
const ask = <T,>(name: string): Promise<T[]> => {
  const call = (ledger as any)[name];
  if (typeof call !== 'function') return Promise.resolve([]);
  return call({}).then((rows: T[]) => rows ?? []).catch(() => []);
};

interface Dividend {
  id: string; ticker: string; name: string | null;
  year: number; months: number[];
  kind: 'cash' | 'shares'; amount: number; currency: string | null;
  note: string | null; createdAt: string; updatedAt: string | null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The months a payout came in, read back as months rather than as numbers. */
const monthsLabel = (months: number[]) =>
  months.length === 0 ? '—' : months.map((m) => MONTHS[m - 1]).join(', ');

/**
 * Which months a company distributed in.
 *
 * Twelve buttons rather than a list of numbers, because a payer that distributes in March and
 * September is two clicks and no typing, and because the shape of a year — one payout, two,
 * four — is legible at a glance in a way "3,9" is not.
 */
function MonthPicker({ value, onChange }: { value: number[]; onChange: (v: number[]) => void }) {
  const toggle = (m: number) =>
    onChange(value.includes(m) ? value.filter((x) => x !== m) : [...value, m].sort((a, b) => a - b));
  return (
    <div role="group" aria-label="Months" style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {MONTHS.map((label, i) => {
        const m = i + 1;
        const on = value.includes(m);
        return (
          <button key={label} type="button" aria-label={label} aria-pressed={on}
                  onClick={() => toggle(m)}
                  style={{ padding: '3px 7px', fontSize: 11, cursor: 'pointer',
                           borderRadius: 'var(--r-chip, 6px)',
                           border: `1px solid ${on ? 'var(--positive)' : 'var(--hairline)'}`,
                           background: on ? 'color-mix(in srgb, var(--positive) 16%, transparent)' : 'transparent',
                           color: on ? 'var(--positive)' : 'var(--muted)' }}>
            {label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The notebook.
 *
 * The order log says what was done. This says what was thought — why a share was passed over,
 * the dividend that makes a date matter, the thesis that has since aged badly. It is dated by
 * the day the thought belongs to rather than the day it was typed, because a view read back
 * without knowing when it was formed is worth very little.
 *
 * A note can be written about a ticker this ledger has never traded, which is most of what a
 * notebook is for: the shares you decided against are the ones worth remembering deciding
 * against.
 */
function Notebook({ knownTickers }: { knownTickers: string[] }) {
  const { live, version } = useLive();
  const { currencies } = useApp();
  // The currency a new payout is written in unless another is chosen — the first one this
  // ledger offers, which is the one everything else is reported in.
  const base = currencies[0]?.code ?? 'EGP';
  const [notes, setNotes] = useState<Note[]>([]);
  const [followed, setFollowed] = useState<Followed[]>([]);
  const [dividends, setDividends] = useState<Dividend[]>([]);

  const load = useCallback(() => {
    if (!live) { setNotes([]); setFollowed([]); setDividends([]); return; }
    ask<Note>('stock.notes.list').then(setNotes);
    ask<Followed>('stocks.list').then(setFollowed);
    ask<Dividend>('stock.dividends.list').then(setDividends);
  }, [live]);
  useEffect(load, [load, version]);

  // whatever has been traded or priced, plus whatever has been written about
  const suggestions = [...new Set([...knownTickers, ...followed.map((f) => f.ticker)])].sort();
  const nameOf = (ticker: string) =>
    followed.find((f) => f.ticker === ticker.toUpperCase())?.name ?? '';
  const latest = notes.reduce<string | null>((a, n) => (a && a > n.date ? a : n.date), null);
  const payoutYears = [...new Set(dividends.map((d) => d.year))].sort((a, b) => b - a).map(String);
  const thisYear = new Date().getFullYear();

  return (
    <>
      <Panel title="The notebook"
             hint="One line per thought, under the share it is about. Nothing here moves money or changes a position — it is the reasoning, kept where the reasoning can be found again.">
        <Stats>
          <Stat label="Shares followed" value={String(followed.length)}
                sub={followed.length === 1 ? 'in the notebook' : 'held or not'} />
          <Stat label="Notes written" value={String(notes.length)} />
          <Stat label="Payout years" value={String(dividends.length)}
                sub={payoutYears.length ? payoutYears.join(', ') : 'nothing recorded'} />
          <Stat label="Last written" value={latest ?? '—'} nowrap />
        </Stats>
      </Panel>

      <Panel>
        <datalist id="notebook-tickers">
          {suggestions.map((t2) => <option key={t2} value={t2} />)}
        </datalist>
        <RecordTable
          rows={notes}
          rowKey={(n) => n.id}
          sort={{ key: 'date', dir: 'desc' }}
          empty={{ icon: 'ledger', title: 'Nothing written down',
                   body: live
                     ? 'Write a note about a share — what you decided, and why it made sense at the time.'
                     : 'The notebook is kept by the ledger service, and there is none behind this screen.' }}
          columns={[
            { key: 'date', label: 'Date', kind: 'date',
              value: (n) => n.date,
              cell: (n) => (
                <span className="mono" style={{ fontSize: 13 }}>
                  {n.date}
                  {n.updatedAt && (
                    <span style={{ display: 'block', fontSize: 11, color: 'var(--faint)' }}>edited</span>
                  )}
                </span>
              ),
              field: (d, set) => <DateField value={d.date} onChange={(v) => set({ date: v })} ariaLabel="Date" /> },
            // Typed rather than picked: a note about a share you have never bought is the
            // whole point, and a picker can only offer the ones you have.
            { key: 'ticker', label: 'Ticker', kind: 'pick',
              value: (n) => n.ticker,
              choices: suggestions,
              cell: (n) => <span style={{ fontWeight: 600 }}>{n.ticker}</span>,
              field: (d, set) => (
                <input aria-label="Ticker" list="notebook-tickers" value={d.ticker}
                       placeholder="NVDA" style={{ width: 110, textTransform: 'uppercase' }}
                       onChange={(e) => set({ ticker: e.target.value.toUpperCase() })} />
              ) },
            // The company belongs to the ticker, not to the note: naming it here names it
            // everywhere the ticker appears, which is what renaming one means.
            // a company's name is a value, not a sentence: it is read whole, on one line
            { key: 'name', label: 'Company', kind: 'text', width: '200px', wrap: false,
              value: (n) => n.name ?? '',
              cell: (n) => (
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {n.name || <span style={{ color: 'var(--faint)' }}>unnamed</span>}
                </span>
              ),
              field: (d, set) => (
                <input aria-label="Company" value={d.name} placeholder={nameOf(d.ticker) || 'the company'}
                       style={{ width: 180 }} onChange={(e) => set({ name: e.target.value })} />
              ) },
            { key: 'note', label: 'Note', kind: 'text', width: '460px',
              value: (n) => n.note,
              cell: (n) => (
                <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'pre-wrap' }}>{n.note}</span>
              ),
              field: (d, set) => (
                <textarea aria-label="Note" rows={4} placeholder="what you decided, and why"
                          value={d.note} onChange={(e) => set({ note: e.target.value })} />
              ) },
          ]}
          add={{
            label: 'Write a note',
            capability: 'stock.note.add',
            blank: { date: new Date().toISOString().slice(0, 10), ticker: '', name: '', note: '' },
            valid: (d) => !!String(d.ticker).trim() && !!String(d.note).trim(),
            build: (d) => ({ ticker: d.ticker, date: d.date, note: d.note,
                             name: String(d.name).trim() || undefined }),
            onDone: load,
          }}
          edit={{
            capability: 'stock.note.edit',
            draftOf: (n) => ({ date: n.date, ticker: n.ticker, name: n.name ?? '', note: n.note }),
            build: (d, n) => ({ noteId: n.id, ticker: d.ticker, date: d.date, note: d.note,
                                name: String(d.name).trim() || undefined }),
            onDone: load,
          }}
          remove={{
            capability: 'stock.note.remove',
            build: (n) => ({ noteId: n.id }),
            what: (n) => `the ${n.ticker} note of ${n.date}`,
            onDone: load,
          }}
        />
      </Panel>

      {/*
        * What a share paid out, by year.
        *
        * A note, like everything else on this tab: it moves no money and changes no position.
        * A year is worth writing down because the months a company distributes in are the
        * part you cannot reconstruct later, and because a decision about next year is made
        * against what actually arrived rather than against what was hoped for. Money that
        * really reached the wallet is put there by the transfer that moved it, on the book
        * tab, which is a separate act on purpose.
        */}
      <Panel title="Dividends"
             hint="What each share distributed, and in which months of which year. A record for reading a year back — nothing here moves money or changes a position.">
        <RecordTable
          rows={dividends}
          rowKey={(d) => d.id}
          sort={{ key: 'year', dir: 'desc' }}
          empty={{ icon: 'income', title: 'No payouts recorded',
                   body: live
                     ? 'Write down what a share paid out in a year, and the months it came in.'
                     : 'The notebook is kept by the ledger service, and there is none behind this screen.' }}
          columns={[
            { key: 'ticker', label: 'Ticker', kind: 'pick',
              value: (d) => d.ticker,
              choices: suggestions,
              cell: (d) => (
                <span>
                  <span style={{ fontWeight: 600 }}>{d.ticker}</span>
                  {d.name && (
                    <span style={{ display: 'block', fontSize: 11, color: 'var(--faint)' }}>{d.name}</span>
                  )}
                </span>
              ),
              field: (d, set) => (
                <input aria-label="Ticker" list="notebook-tickers" value={d.ticker}
                       placeholder="NVDA" style={{ width: 110, textTransform: 'uppercase' }}
                       onChange={(e) => set({ ticker: e.target.value.toUpperCase() })} />
              ) },
            { key: 'year', label: 'Year', kind: 'amount', align: 'right', width: '90px',
              value: (d) => d.year,
              cell: (d) => <span className="mono">{d.year}</span>,
              field: (d, set) => (
                <Amount value={d.year} ariaLabel="Year" style={{ width: 80 }}
                        onChange={(n) => set({ year: n })} />
              ) },
            // The months are the part a year cannot be reconstructed without: a payer that
            // distributes twice is a different share from one that distributes once, and by
            // next spring nobody remembers which it was.
            { key: 'months', label: 'Months', kind: 'text', width: '230px',
              value: (d) => d.months.join(','),
              cell: (d) => (
                <span style={{ fontSize: 12, color: d.months.length ? 'var(--muted)' : 'var(--faint)' }}>
                  {monthsLabel(d.months)}
                </span>
              ),
              field: (d, set) => (
                <MonthPicker value={d.months} onChange={(v) => set({ months: v })} />
              ) },
            { key: 'kind', label: 'Paid in', kind: 'pick', width: '110px',
              value: (d) => d.kind,
              choices: ['cash', 'shares'],
              cell: (d) => <Chip tone={d.kind === 'cash' ? 'good' : 'info'}>
                {d.kind === 'cash' ? 'money' : 'shares'}</Chip>,
              field: (d, set) => <Select ariaLabel="Paid in" value={d.kind}
                                         onChange={(v) => set({ kind: v })}
                                         options={[{ value: 'cash', label: 'Money' },
                                                   { value: 'shares', label: 'Shares' }]} /> },
            // Money or shares in the same column, because it is the same question — what did
            // the year come to — and the unit beside the number says which was meant.
            { key: 'amount', label: 'Value', kind: 'amount', align: 'right', width: '150px',
              value: (d) => d.amount,
              cell: (d) => (
                <span className="mono">
                  {fmt(d.amount, d.kind === 'cash' ? 2 : 0)}
                  <span style={{ marginLeft: 5, fontSize: 11, color: 'var(--faint)' }}>
                    {d.kind === 'cash' ? d.currency ?? '' : d.amount === 1 ? 'share' : 'shares'}
                  </span>
                </span>
              ),
              field: (d, set) => (
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <Amount value={d.amount} ariaLabel="Value" style={{ width: 92 }}
                          onChange={(n) => set({ amount: n })} />
                  {d.kind === 'cash'
                    ? <Select ariaLabel="Currency" value={d.currency}
                              onChange={(v) => set({ currency: v })}
                              options={currencies.map((c) => ({ value: c.code, label: c.code }))} />
                    : <span style={{ fontSize: 11, color: 'var(--faint)' }}>shares</span>}
                </div>
              ) },
            { key: 'note', label: 'Note', kind: 'text', width: '300px',
              value: (d) => d.note ?? '',
              cell: (d) => (
                <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'pre-wrap' }}>
                  {d.note || <span style={{ color: 'var(--faint)' }}>—</span>}
                </span>
              ),
              field: (d, set) => (
                <textarea aria-label="Note" rows={3} placeholder="what it means for next year"
                          value={d.note} onChange={(e) => set({ note: e.target.value })} />
              ) },
          ]}
          add={{
            label: 'Record a payout',
            capability: 'stock.dividend.add',
            blank: { ticker: '', year: thisYear, months: [], kind: 'cash',
                     amount: 0, currency: base, note: '' },
            valid: (d) => !!String(d.ticker).trim() && Number(d.year) > 0 && Number(d.amount) > 0,
            build: (d) => ({ ticker: d.ticker, year: Number(d.year), months: d.months,
                             kind: d.kind, amount: Number(d.amount),
                             currency: d.kind === 'cash' ? d.currency : undefined,
                             note: String(d.note).trim() || undefined }),
            onDone: load,
          }}
          edit={{
            capability: 'stock.dividend.edit',
            draftOf: (d) => ({ ticker: d.ticker, year: d.year, months: d.months, kind: d.kind,
                               amount: d.amount, currency: d.currency ?? base, note: d.note ?? '' }),
            build: (d, row) => ({ dividendId: row.id, ticker: d.ticker, year: Number(d.year),
                                  months: d.months, kind: d.kind, amount: Number(d.amount),
                                  currency: d.kind === 'cash' ? d.currency : undefined,
                                  note: String(d.note).trim() }),
            onDone: load,
          }}
          remove={{
            capability: 'stock.dividend.remove',
            build: (d) => ({ dividendId: d.id }),
            what: (d) => `what ${d.ticker} paid out in ${d.year}`,
            onDone: load,
          }}
        />
      </Panel>
    </>
  );
}


/**
 * Money into the brokerage wallet, or back out of it.
 *
 * A broker is somewhere you keep money, not somewhere it disappears into, so taking it back
 * has to be as ordinary as putting it in. The panel used to offer only one direction, which
 * quietly said the money was gone.
 */
function BookTransfer() {
  const { data, balances, dm } = useApp();
  const [direction, setDirection] = useState<'in' | 'out'>('in');
  const [source, setSource] = useState<'account' | 'dividends'>('account');
  const [accountId, setAccountId] = useState(data.settings.burnAccountId);
  const [ticker, setTicker] = useState('');
  const [amount, setAmount] = useState(0);
  const [note, setNote] = useState('');

  const book = data.nodes.find((n) => n.id === 'brokerage-cash');
  const inBook = book ? balances[book.id] ?? book.openingQty : 0;
  const acct = data.nodes.find((n) => n.id === accountId);
  const held = acct ? balances[acct.id] ?? acct.openingQty : 0;

  /**
   * Where the money comes from, on the way in.
   *
   * Taking money out always goes to an account of yours, so the choice only exists inwards —
   * and it is offered there because a dividend is the one sort of money that lands in the
   * wallet without any account of yours being lighter for it. Calling it a transfer would
   * have meant taking it out of somewhere it never was.
   */
  const byDividend = direction === 'in' && source === 'dividends';
  const payers = [...new Set(data.orders.map((o) => o.ticker))].sort();

  // Nothing of yours is short when the money comes from outside the ledger.
  const short = byDividend ? false : direction === 'out' ? amount > inBook : amount > held;
  const shortBy = direction === 'out' ? amount - inBook : amount - held;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Segmented<'in' | 'out'> value={direction} onChange={setDirection} ariaLabel="Which way"
        options={[
          { id: 'in', label: 'Put money in', icon: 'in', tone: 'var(--positive)' },
          { id: 'out', label: 'Take money out', icon: 'out', tone: 'var(--negative)' },
        ]} />

      {direction === 'in' && (
        <Segmented<'account' | 'dividends'> value={source} onChange={setSource} ariaLabel="Where from"
          options={[
            { id: 'account', label: 'Out of an account', icon: 'accounts', tone: 'var(--muted)' },
            { id: 'dividends', label: 'From a dividend', icon: 'income', tone: 'var(--positive)' },
          ]} />
      )}

      {/* Which way, drawn: a bank on one side, the book on the other, and the arrow between
          them pointing where the money actually goes. */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14,
                    padding: '14px 16px', borderRadius: 'var(--r-card)',
                    background: 'var(--raised)', border: '1px solid var(--hairline)' }}>
        <Waypoint icon={byDividend ? 'income' : 'accounts'}
                  label={byDividend ? (ticker ? `${ticker} dividends` : 'dividends')
                                    : acct?.name ?? 'an account'}
                  tone={direction === 'in' ? 'var(--positive)' : 'var(--muted)'} />
        <span style={{ display: 'flex', color: direction === 'in' ? 'var(--positive)' : 'var(--negative)',
                       transform: direction === 'in' ? 'none' : 'scaleX(-1)' }}>
          <Icon name="arrow" size={20} motion="none" />
        </span>
        <Waypoint icon="stocks" label="Brokerage wallet"
                  tone={direction === 'in' ? 'var(--muted)' : 'var(--negative)'} />
      </div>

      <div style={{ padding: '12px 14px', borderRadius: 'var(--r-card)',
                    background: 'var(--raised)', border: '1px solid var(--hairline)' }}>
        <div className="ov">In the wallet</div>
        <div className="mono" style={{ fontSize: 18, fontWeight: 500, marginTop: 4 }}>{dm(inBook)}</div>
      </div>

      {byDividend ? (
        <Field label="Paid by"
               hint="Which share distributed it. The payout is attributed to that ticker rather than arriving from nowhere.">
          <>
            <datalist id="dividend-payers">
              {payers.map((p2) => <option key={p2} value={p2} />)}
            </datalist>
            <input aria-label="Paid by" list="dividend-payers" value={ticker}
                   placeholder="NVDA — or leave it blank"
                   style={{ textTransform: 'uppercase' }}
                   onChange={(e) => setTicker(e.target.value.toUpperCase())} />
          </>
        </Field>
      ) : (
        <Field label={direction === 'in' ? 'Out of' : 'Into'}>
          <Select ariaLabel="Account" value={accountId} onChange={setAccountId}
                  options={data.nodes.filter((n) => n.kind === 'cash').map((n) => ({
                    value: n.id, label: `${n.name} · ${n.currency}`,
                    hint: data.institutions.find((i) => i.id === n.parentId)?.name,
                  }))} />
        </Field>
      )}

      <Field label="Amount"
             hint={byDividend ? 'What the distribution actually paid you'
                   : direction === 'out' ? `${dm(inBook)} available` : `${dm(held)} in that account`}>
        <Amount value={amount} ariaLabel="Amount"
                   onChange={(n) => setAmount(n)} />
      </Field>

      <Field label="Note">
        <input aria-label="Transfer note" placeholder="topping up, taking profit"
               value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>

      {short && amount > 0 && (
        <p style={{ margin: 0, fontSize: 12, color: 'var(--negative)', lineHeight: 1.45 }}>
          {direction === 'out' ? 'The book holds' : `${acct?.name} holds`}{' '}
          {dm(direction === 'out' ? inBook : held)}, which is {dm(shortBy)} short.
        </p>
      )}


      {/* money leaving is red wherever it is offered, and it is the same button underneath */}
      <ActionButton capability="book.transfer" disabled={!(amount > 0) || short}
        className={direction === 'out' ? 'btn danger' : 'btn go'}
        onDone={(o) => { if (o.ok) { setAmount(0); setNote(''); setTicker(''); } }}
        input={() => ({
          direction, amount, source: byDividend ? 'dividends' : 'account',
          accountId: byDividend ? undefined : accountId,
          ticker: byDividend && ticker ? ticker : undefined,
          note: note || undefined,
        })}>
        {byDividend ? 'Pay it in' : direction === 'in' ? 'Move it in' : 'Move it out'}
      </ActionButton>
    </div>
  );
}

/** One end of the transfer, so the direction has two things to be between. */
function Waypoint({ icon, label, tone }: { icon: IconName; label: string; tone: string }) {
  return (
    <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
                   minWidth: 0, flex: 1 }}>
      <span style={{ width: 38, height: 38, borderRadius: 10, display: 'flex',
                     alignItems: 'center', justifyContent: 'center',
                     background: `color-mix(in srgb, ${tone} 15%, transparent)` }}>
        <Icon name={icon} size={20} color={tone} />
      </span>
      <span style={{ fontSize: 11, color: 'var(--faint)', textAlign: 'center',
                     whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                     maxWidth: '100%' }}>{label}</span>
    </span>
  );
}