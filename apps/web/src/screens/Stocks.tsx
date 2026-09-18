import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Amount } from '../components/Amount';
import { useApp, market } from '../AppState';
import { Select, opts } from '../components/Select';
import { computedPositions, brokerageCash, fmt, money, intentionsFor, intentionLabel,
         type Intention } from '@ledger/engine';
import { Page, Panel, Stat, Stats, Chip, Field, Empty } from '../components/UI';
import { Donut } from '../components/Donut';
import { Icon } from '../components/Icon';
import { Mark, MarkPicker } from '../components/Mark';
import { ActionButton, useLive } from '../Live';
import { ledger } from '../api';
import { DateField } from '../components/DateField';
import { RecordTable } from '../components/RecordTable';
import { OperationPanel, SourceAccountSelect, INITIAL_PAYMENT, RowLine, Problems, Balance, defaultAccountId } from '../components/Operations';
import { Segmented } from '../components/Segmented';
import { SectionProvider, Sections, useSection } from '../components/Sections';
import { useModules } from '../Modules';
import { accountOption } from '../accounts';

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
    <SectionProvider first="book"><Body /></SectionProvider>
  );
}

/**
 * One of the three headline figures, ahead of the tabs rather than inside any one of them —
 * wallet, clouds and stocks are all read regardless of which tab is open, so none of them
 * belongs to a tab.
 */
function HeadlineFigure({ label, value, tone, sub }: {
  label: string; value: string; tone?: string; sub?: ReactNode;
}) {
  return (
    <div style={{ flex: '1 1 200px', minWidth: 170, padding: '15px 18px',
                  borderRadius: 'var(--r-card)', background: 'var(--surface)',
                  border: '1px solid var(--hairline)' }}>
      <div className="ov">{label}</div>
      <div className="mono" style={{ fontSize: 22, fontWeight: 600, marginTop: 5, color: tone }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 5 }}>{sub}</div>}
    </div>
  );
}

/**
 * What an order actually moved through the wallet.
 *
 * The broker's charge belongs to the order rather than to each share in it, so it is added
 * once to what a buy took out and taken once off what a sale put back — the same arithmetic
 * `order.log` posts, read here so the column and the wallet agree. An order from before fees
 * were recorded carries none, and reads exactly as it always did.
 */
function orderMoved(o: { side: string; shares: number; price: number; total?: number; fee?: number }): number {
  const gross = o.total || o.shares * o.price;
  const fee = o.fee ?? 0;
  return o.side === 'BUY' ? gross + fee : Math.max(0, gross - fee);
}

/** A book of one's own — its wallet, its clouds wallet, as `exchange.list` answers it. */
interface ExchangeRow {
  id: string; name: string; logo: string | null;
  walletNodeId: string; cloudsNodeId: string; archived: boolean;
}

/** An account and what it holds right now, as `accounts.list` answers it. */
interface AccountRow { id: string; balance: number }

/** A position as `positions.list` answers it — richer than the local accrual, and scoped to one exchange. */
interface PositionRow {
  ticker: string; shares: number; avgBuy: number; cost: number; price: number; value: number;
  priced: boolean; pricedAt: string | null;
}

/** An order as `orders.list` answers it, carrying what a sale actually earned. */
interface OrderRow {
  id: string; date: string; ticker: string; side: 'BUY' | 'SELL'; shares: number; price: number;
  total: number; fee: number; intention: Intention | null;
  status: string; note: string | null; movementId: string | null;
  realizedPnl: number | null; realizedPnlPct: number | null;
}

/**
 * Which book is open, and everything done to a book as a whole.
 *
 * It reads as a switch, at the top of the screen, because that is what it is: every figure
 * below it — the wallet, the clouds, the ring, both tables — belongs to whichever book is
 * lit here, and a control that decides what an entire screen is about belongs above the
 * screen rather than in the middle of it. Each book wears its broker's mark beside its name,
 * for the same reason a share does: a picture is what the glance finds, and two brokers named
 * in the same grey are two things to read rather than one to recognise.
 *
 * One exchange still gets the switch, with one thing on it — the one book is a book, and the
 * pencil that renames it and the mark that identifies it hang off the same control either
 * way. "Another exchange" sits beside it, since opening the second one is how the switch
 * comes to have anything to switch between.
 */
function ExchangeBar({ exchanges, exchangeId, onChange, onAdded, onChanged }: {
  exchanges: ExchangeRow[]; exchangeId: string; onChange: (id: string) => void;
  onAdded: (row: ExchangeRow) => void;
  onChanged: (row: ExchangeRow) => void;
}) {
  const { run, running } = useLive();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [picking, setPicking] = useState(false);
  const [name, setName] = useState('');

  const open = exchanges.find((e) => e.id === exchangeId);

  const submitNew = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const res = await run('exchange.add', { name: trimmed });
    if (res.ok) {
      const row = res as unknown as { id: string; walletNodeId: string; cloudsNodeId: string };
      onAdded({ id: row.id, name: trimmed, logo: null, walletNodeId: row.walletNodeId,
                cloudsNodeId: row.cloudsNodeId, archived: false });
      setName('');
      setAdding(false);
    }
  };

  const submitRename = async () => {
    const trimmed = name.trim();
    if (!trimmed || !open) return;
    const res = await run('exchange.rename', { exchangeId: open.id, name: trimmed });
    if (res.ok) {
      onChanged({ ...open, name: trimmed });
      setName('');
      setEditing(false);
    }
  };

  const setMark = async (mark: string) => {
    if (!open) return;
    const res = await run('exchange.rename', { exchangeId: open.id, logo: mark });
    if (res.ok) onChanged({ ...open, logo: mark });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {/* The switch itself, built like `Segmented` rather than from it: a book carries a
            mark, which may be an uploaded picture, and that is not an icon name. */}
        <div role="group" aria-label="Which exchange"
             style={{ display: 'inline-flex', gap: 4, padding: 3, borderRadius: 'var(--r-sm)',
                      background: 'var(--raised)', border: '1px solid var(--hairline)', flexWrap: 'wrap' }}>
          {exchanges.map((e) => {
            const on = e.id === exchangeId;
            return (
              <button key={e.id} onClick={() => onChange(e.id)} aria-pressed={on}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 500,
                  padding: '7px 14px', borderRadius: 'calc(var(--r-sm) * 0.75)', cursor: 'pointer',
                  border: 'none',
                  background: on ? 'var(--control)' : 'transparent',
                  color: on ? 'var(--ink)' : 'var(--muted)',
                  boxShadow: on ? 'var(--shadow-sm)' : 'none',
                  transition: 'background 150ms var(--ease), color 150ms var(--ease)',
                }}>
                <Mark mark={e.logo ?? undefined} size={15}
                      color={on ? 'var(--ink)' : 'var(--muted)'} fallback="stocks" />
                {e.name}
              </button>
            );
          })}
        </div>

        {/* What is done to the open book: its name, and its mark. Both are edits to the one
            row, so they hang together off the book that is lit. */}
        {open && !editing && (
          <>
            <button type="button" className="btn quiet" title="Rename this exchange"
                    aria-label={`Rename ${open.name}`}
                    onClick={() => { setName(open.name); setEditing(true); }}
                    style={{ padding: 7, border: 'none' }}>
              <Icon name="edit" size={14} />
            </button>
            <button type="button" className="btn quiet" title="Change this exchange's mark"
                    aria-label={`Change the mark for ${open.name}`}
                    onClick={() => setPicking((v) => !v)}
                    style={{ padding: 7, border: 'none' }}>
              <Mark mark={open.logo ?? undefined} size={15} fallback="stocks" />
            </button>
          </>
        )}

        {open && editing && (
          <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <input aria-label="Exchange name" value={name} placeholder="the broker's name"
                   style={{ width: 170 }} autoFocus
                   onChange={(e) => setName(e.target.value)}
                   onKeyDown={(e) => { if (e.key === 'Enter') void submitRename(); }} />
            <button type="button" className="btn go sm" disabled={!name.trim() || !!running}
                    onClick={() => void submitRename()}>
              <Icon name="check" size={13} motion="none" /> Rename
            </button>
            <button type="button" className="btn ghost sm" onClick={() => { setEditing(false); setName(''); }}>
              <Icon name="close" size={13} motion="none" /> Cancel
            </button>
          </span>
        )}

        {adding ? (
          <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <input aria-label="New exchange name" value={name} placeholder="the broker's name"
                   style={{ width: 170 }} autoFocus
                   onChange={(e) => setName(e.target.value)}
                   onKeyDown={(e) => { if (e.key === 'Enter') void submitNew(); }} />
            <button type="button" className="btn go sm" disabled={!name.trim() || !!running}
                    onClick={() => void submitNew()}>
              <Icon name="check" size={13} motion="none" /> Add
            </button>
            <button type="button" className="btn ghost sm" onClick={() => { setAdding(false); setName(''); }}>
              <Icon name="close" size={13} motion="none" /> Cancel
            </button>
          </span>
        ) : !editing && (
          <button type="button" className="btn ghost sm"
                  onClick={() => { setName(''); setAdding(true); }}>
            <Icon name="plus" size={13} /> Another exchange
          </button>
        )}
      </div>

      {open && picking && (
        <MarkPicker value={open.logo ?? undefined} family="stocks"
                    label={`The mark for ${open.name}`}
                    onChange={(mark) => { void setMark(mark); }}
                    onClose={() => setPicking(false)} />
      )}
    </div>
  );
}

function Body() {
  const { data, dm, balances } = useApp();
  const { version, run, live } = useLive();
  const { enabled } = useModules();
  /** whether the zakat module is on — the one check every intention control on this screen answers to */
  const zakatOn = enabled.giving !== false;

  /**
   * More than one book.
   *
   * Every exchange has its own wallet, its own clouds wallet and its own orders, so the three
   * headline figures and both tables below follow whichever one is chosen here rather than
   * always reading the first. Against the fixtures this screen falls back on when there is no
   * ledger service, there is exactly the one book there has always been, so nothing here
   * changes what those screens already prove.
   */
  const [exchanges, setExchanges] = useState<ExchangeRow[]>([]);
  const [exchangeId, setExchangeId] = useState('main');
  useEffect(() => {
    if (!live) { setExchanges([]); return; }
    ask<ExchangeRow>('exchange.list').then((rows) => {
      setExchanges(rows);
      setExchangeId((cur) => (rows.some((r) => r.id === cur) ? cur : (rows[0]?.id ?? 'main')));
    });
  }, [live, version]);

  /** Every position and every order, read scoped to the open exchange rather than the first. */
  const [scopedPositions, setScopedPositions] = useState<PositionRow[] | null>(null);
  const [scopedOrders, setScopedOrders] = useState<OrderRow[] | null>(null);
  useEffect(() => {
    if (!live) { setScopedPositions(null); setScopedOrders(null); return; }
    let cancelled = false;
    const posCall = (ledger as any)['positions.list'];
    if (typeof posCall === 'function') {
      posCall({ exchangeId }).then((rows: PositionRow[]) => { if (!cancelled) setScopedPositions(rows ?? []); })
        .catch(() => { if (!cancelled) setScopedPositions([]); });
    }
    const ordCall = (ledger as any)['orders.list'];
    if (typeof ordCall === 'function') {
      ordCall({ exchangeId, limit: 500 }).then((rows: OrderRow[]) => { if (!cancelled) setScopedOrders(rows ?? []); })
        .catch(() => { if (!cancelled) setScopedOrders([]); });
    }
    return () => { cancelled = true; };
  }, [live, exchangeId, version]);
  /** whether the exchange-scoped reads above answered, or this is the fixture book instead */
  const usingScoped = live && scopedPositions != null && scopedOrders != null;

  /** Every account and what it holds, so the chosen exchange's wallet and clouds read their
   *  own balance rather than the first exchange's. */
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  useEffect(() => {
    if (!live) { setAccounts([]); return; }
    ask<AccountRow>('accounts.list').then(setAccounts);
  }, [live, version]);

  /** When the prices on screen were last taken, so a book priced before today can say so. */
  const [pricedAt, setPricedAt] = useState<string | null>(null);
  useEffect(() => {
    if (!live) { setPricedAt(null); return; }
    const call = (ledger as any)['market.sources'];
    if (typeof call !== 'function') return;
    call({}).then((res: { subjects?: Array<{ id: string; pricedAt: string | null }> }) => {
      setPricedAt(res?.subjects?.find((s) => s.id === 'stocks')?.pricedAt ?? null);
    }).catch(() => setPricedAt(null));
  }, [live, version]);

  /**
   * The company behind each ticker — its full name, and its own logo where one was ever
   * given.
   *
   * Read from the notebook's index rather than from anywhere on the book itself: a ticker
   * bought once and never written about otherwise still has a row there, because logging a
   * new one writes it in on the way. Refreshed on every successful write anywhere on the
   * screen, so a logo just uploaded shows up without a reload.
   */
  const [tickerMeta, setTickerMeta] = useState<Record<string, { name: string | null; logo: string | null; intention: Intention | null }>>({});
  const loadTickerMeta = useCallback(() => {
    ask<Followed>('stocks.list').then((rows) => {
      setTickerMeta(Object.fromEntries(rows.map((r) => [r.ticker, { name: r.name, logo: r.logo, intention: r.intention ?? null }])));
    });
  }, []);
  useEffect(loadTickerMeta, [loadTickerMeta, version]);

  /**
   * The name and logo typed in while writing a ticker this ledger has never seen.
   *
   * `order.log` itself knows nothing of a company's name or its picture — it moves shares
   * and cash — so the two travel here instead, on the side, and are written to the notebook
   * once the order they arrived with has actually gone through. A ticker already known needs
   * neither, and carries `null` instead of asking a second capability to do nothing.
   */
  const pendingTickerMeta = useRef<{ ticker: string; name: string; logo: string } | null>(null);

  /**
   * Which tickers this ledger knows.
   *
   * Whatever has been traded, plus whatever has a price recorded — not a list fetched from
   * an exchange, because this is a notebook and the only shares it knows are the ones you
   * have written down.
   */
  /**
   * The orders and the positions this screen actually draws.
   *
   * Scoped to the open exchange once there is a ledger service to scope them against — each
   * exchange keeps its own book, so a position or an order read from the first one while a
   * second is open would be answering about the wrong broker. Without a service there is
   * exactly the one book the fixtures have always had, and `data.orders` still answers it
   * directly, the way every screen proved against it already expects.
   */
  const ordersForScreen: Array<OrderRow | (typeof data.orders)[number]> = usingScoped ? scopedOrders! : data.orders;
  const tickers = [...new Set([
    ...ordersForScreen.map((o) => o.ticker),
    // the price table also carries the metals, which are weighed rather than traded in shares
    ...Object.keys(market.prices).filter((k) => TICKER.test(k)),
  ])].sort();
  const { tab } = useSection();

  const positions: PositionRow[] = usingScoped ? scopedPositions! : computedPositions(data.orders, market.prices)
    .map((p) => ({ ...p, priced: market.prices[p.ticker] != null, pricedAt: null }));
  /** what there is any of to sell — a share sold down to nothing is not among them */
  const owned = positions.map((p) => p.ticker);
  const colours = paletteFor(positions.map((p) => p.ticker));
  const value = positions.reduce((s, p) => s + p.value, 0);
  const cost = positions.reduce((s, p) => s + p.cost, 0);

  /**
   * What is actually in the brokerage wallet, and in the clouds beside it.
   *
   * Each exchange has its own wallet and its own clouds wallet — `exchange.list` names both —
   * and the balance behind either is read from `accounts.list` rather than derived here, so
   * the figure this screen shows is the one the rest of the ledger already agrees is right.
   * Without a service, or before the exchange list has answered, the old derivation stands:
   * a node found by the fixture's own id, or — for a sample book with none — the legacy
   * reading a starting figure in settings used to give.
   */
  const openExchange = usingScoped ? exchanges.find((e) => e.id === exchangeId) : undefined;
  let wallet: number;
  let clouds: number;
  if (openExchange) {
    wallet = accounts.find((a) => a.id === openExchange.walletNodeId)?.balance ?? 0;
    clouds = accounts.find((a) => a.id === openExchange.cloudsNodeId)?.balance ?? 0;
  } else {
    const walletNode = data.nodes.find((n) => n.priceKey === 'brokerage_cash')
                    ?? data.nodes.find((n) => n.id === 'brokerage-cash');
    wallet = walletNode ? balances[walletNode.id] ?? walletNode.openingQty : brokerageCash(data);
    const cloudsNode = data.nodes.find((n) => n.priceKey === 'clouds_cash')
                    ?? data.nodes.find((n) => n.id === 'clouds-cash');
    clouds = cloudsNode ? balances[cloudsNode.id] ?? cloudsNode.openingQty : 0;
  }

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
  const pendingBuys = ordersForScreen.filter((o) => o.status === 'pending' && o.side === 'BUY');
  // The charge is part of what a pending buy will actually take out of the wallet, so it is
  // held back with the rest of it rather than surfacing as a shortfall the day it executes.
  const committed = pendingBuys.reduce((s, o) => s + (o.total || o.shares * o.price)
                                                   + ((o as { fee?: number }).fee ?? 0), 0);
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

  /** Said quietly, next to the positions it describes, only when it is not today's own price. */
  const asAtText = asAtLabel(pricedAt);

  return (
    <Page>
      {/* Which book is open, above everything it decides — once there is a ledger service to
          keep more than one. The fixtures this screen falls back on have exactly the one book
          and no service to rename it with, so nothing is offered for them to switch between. */}
      {live && exchanges.length > 0 && (
        <ExchangeBar exchanges={exchanges} exchangeId={exchangeId} onChange={setExchangeId}
          onAdded={(row) => { setExchanges((rows) => [...rows, row]); setExchangeId(row.id); }}
          onChanged={(row) => setExchanges((rows) => rows.map((r) => (r.id === row.id ? row : r)))} />
      )}

      {/*
        * Three figures, under the switch and about whichever book it has lit: the cash sitting
        * free at that broker, the cash set aside in its cloud that will one day compound, and
        * what the holdings in that book are worth right now — with which way that is moving,
        * and by how much, so the headline number is never read alone.
        */}
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <HeadlineFigure label="Wallet" value={dm(wallet)}
                        tone={wallet < 0 ? 'var(--negative)' : undefined}
                        sub="cash at the broker, uninvested" />
        <HeadlineFigure label="Clouds" value={dm(clouds)}
                        sub="a savings cloud — compounding comes later" />
        <HeadlineFigure label="Stocks" value={dm(value)}
                        sub={
                          <span style={{ display: 'flex', alignItems: 'center', gap: 4,
                                         color: pl >= 0 ? 'var(--positive)' : 'var(--negative)', fontWeight: 500 }}>
                            <Icon name={pl >= 0 ? 'arrow' : 'arrowdown'} size={11} motion="none"
                                  color={pl >= 0 ? 'var(--positive)' : 'var(--negative)'}
                                  style={pl >= 0 ? { transform: 'rotate(-90deg)' } : undefined} />
                            {cost > 0 ? `${Math.abs((pl / cost) * 100).toFixed(1)}%` : '—'}
                            {' · '}{pl >= 0 ? '+' : '−'}{dm(Math.abs(pl))}
                          </span>
                        } />
      </div>

      <Sections sections={[
        { id: 'book', label: 'The book', icon: 'stocks',
          hint: 'What you hold, valued at the price you last recorded.' },
        { id: 'orders', label: 'Orders', icon: 'ledger',
          hint: 'Every order logged, why it was made, what the broker charged for it, and what those shares are held for. Double-click one to undo it — it writes the opposite rather than erasing it.' },
        { id: 'notebook', label: 'Notebook', icon: 'ledger',
          hint: 'What you thought about a share, and what it paid out — held or not. Double-click one to rewrite it, or move it to another day, year, or ticker.' },
      ]} />

      {/*
        * The book, in one ring: every share held, the cash still free, and the cash a pending
        * order has already spoken for. The three add up to what the book is worth, which is
        * why they are drawn together rather than the cash being a footnote beside them.
        *
        * Funding the book stands beside it rather than under it: putting money in is what
        * changes the ring, and the two read as one act when they are next to each other. On a
        * narrow screen there is no "beside", so the form wraps underneath — which is where it
        * used to live permanently.
        */}
      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <Panel style={{ flex: '1 1 460px', minWidth: 0 }}>
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
              {/* the wallet itself is one of the three headline figures above, so it is not
                  repeated here — only what this ring cannot otherwise say */}
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
        * It used to step aside whenever the screen was flipped to Edit, which was never
        * really about this panel — it was the only way records had a pencil at all. A record
        * opens for correction on its own row now (see `RecordTable`), so funding the book no
        * longer has anything to step aside for.
        */}
      {tab === 'book' && (
        <div style={{ flex: '0 1 380px', minWidth: 300 }}>
          <OperationPanel title="Fund the book"
            hint="The wallet is the raw cash sitting at the broker. It has to arrive from somewhere, and buying a position later moves it again — out of the wallet and into the holding.">
            <BookTransfer exchangeId={usingScoped ? exchangeId : undefined} exchanges={exchanges} />
          </OperationPanel>
        </div>
      )}
      </div>

      {tab === 'book' && (
      <Panel title="Positions"
             hint="Held from the orders you logged, and valued at the price you last recorded. A position with no price is shown at cost.">
        {/* Not shouted — a fact about the source, stated the way the rest of this screen
            states a fact, once it is worth saying at all: only when today's own close is not
            what the book is valued at. */}
        {asAtText && (
          <p style={{ margin: '0 0 12px', fontSize: 11, color: 'var(--faint)' }}>{asAtText}</p>
        )}
        <RecordTable
          rows={positions}
          rowKey={(p2) => p2.ticker}
          sort={{ key: 'pl', dir: 'desc' }}
          empty={{ icon: 'stocks', title: 'Nothing held',
                   body: 'Log an executed order and the position appears here.' }}
          columns={[
            { key: 'ticker', label: 'Ticker', kind: 'pick',
              value: (p2) => p2.ticker,
              cell: (p2) => {
                const meta = tickerMeta[p2.ticker];
                const tone = colours[p2.ticker] ?? 'var(--muted)';
                return (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
                    <span style={{ width: 30, height: 30, borderRadius: 9, flexShrink: 0,
                                   display: 'flex', alignItems: 'center', justifyContent: 'center',
                                   background: `color-mix(in srgb, ${tone} var(--tint), transparent)` }}>
                      <Mark mark={meta?.logo ?? undefined} size={17} color={tone} fallback="stocks" />
                    </span>
                    <span style={{ minWidth: 0 }}>
                      <span style={{ fontWeight: 600 }}>{p2.ticker}</span>
                      {meta?.name && (
                        <span style={{ display: 'block', fontSize: 11, color: 'var(--faint)',
                                       overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {meta.name}
                        </span>
                      )}
                    </span>
                  </span>
                );
              } },
            { key: 'shares', label: 'Shares', kind: 'amount',
              value: (p2) => p2.shares,
              cell: (p2) => <span className="mono">{fmt(p2.shares)}</span> },
            { key: 'price', label: 'Price now', kind: 'amount',
              value: (p2) => p2.price,
              cell: (p2) => (
                <span className="mono" style={{ color: market.prices[p2.ticker] == null ? 'var(--faint)' : undefined }}>
                  {market.prices[p2.ticker] != null ? p2.price.toFixed(2) : 'none set'}
                </span>
              ) },
            // The average price a share of this position was bought at — the one figure
            // "avg buy" and "average cost" used to both carry under different names, read back
            // in the position's currency rather than as a bare number, the way the other money
            // columns are.
            { key: 'value', label: 'Avg cost', kind: 'amount',
              value: (p2) => p2.avgBuy, cell: (p2) => <span className="mono">{dm(p2.avgBuy)}</span> },
            { key: 'pl', label: 'Current value', kind: 'amount',
              value: (p2) => p2.value, cell: (p2) => <span className="mono">{dm(p2.value)}</span> },
          ]}
        />
      </Panel>
      )}

      {tab === 'orders' && (
      <Panel title="Order log"
             hint="What you did and why. An executed order moves cash and the position; a pending one records the intention and moves nothing.">
        <RecordTable
          rows={ordersForScreen}
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
              // The same mark the book draws, for the same reason: a code is not a company
              // six months later, and the picture is what the eye finds the row by.
              cell: (o) => {
                const meta = tickerMeta[o.ticker];
                const tone = colours[o.ticker] ?? 'var(--muted)';
                return (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
                    <span style={{ width: 26, height: 26, borderRadius: 8, flexShrink: 0,
                                   display: 'flex', alignItems: 'center', justifyContent: 'center',
                                   background: `color-mix(in srgb, ${tone} var(--tint), transparent)` }}>
                      <Mark mark={meta?.logo ?? undefined} size={15} color={tone} fallback="stocks" />
                    </span>
                    <span style={{ minWidth: 0 }}>
                      <span style={{ fontWeight: 600 }}>{o.ticker}</span>
                      {meta?.name && (
                        <span style={{ display: 'block', fontSize: 11, color: 'var(--faint)',
                                       overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {meta.name}
                        </span>
                      )}
                    </span>
                  </span>
                );
              },
              field: (d, set, row) => <TickerPick draft={d} set={set} known={tickers} owned={owned}
                                                  existing={row?.ticker} /> },
            { key: 'side', label: 'Side', kind: 'pick',
              value: (o) => o.side,
              cell: (o) => <span style={{ color: o.side === 'BUY' ? 'var(--positive)' : 'var(--negative)' }}>{o.side}</span>,
              field: (d, set) => <Select ariaLabel="Side" value={d.side} onChange={(v) => set({ side: v })}
                                         options={[{ value: 'BUY', label: 'Buy' }, { value: 'SELL', label: 'Sell' }]} /> },
            { key: 'shares', label: 'Shares', kind: 'amount',
              value: (o) => o.shares,
              cell: (o) => <span className="mono">{fmt(o.shares)}</span>,
              field: (d, set) => <Amount value={d.shares} ariaLabel="Shares" onChange={(n) => set({ shares: n })} /> },
            { key: 'price', label: 'Price', kind: 'amount',
              value: (o) => o.price,
              cell: (o) => <span className="mono">{o.price.toFixed(2)}</span>,
              field: (d, set) => <Amount value={d.price} ariaLabel="Price" onChange={(n) => set({ price: n })} /> },
            // What the broker charged for the order as a whole. One charge for the order, never
            // one per share — a commission of fifty is fifty whether it bought one share or a
            // hundred — so it is added once to a buy and taken once off a sale.
            { key: 'fee', label: 'Fee', kind: 'amount',
              value: (o) => (o as { fee?: number }).fee ?? 0,
              cell: (o) => {
                const f = (o as { fee?: number }).fee ?? 0;
                return f > 0 ? <span className="mono" style={{ color: 'var(--negative)' }}>{dm(f)}</span>
                             : <span style={{ color: 'var(--faint)' }}>—</span>;
              },
              field: (d, set) => <Amount value={Number(d.fee) || 0} ariaLabel="Fee"
                                         onChange={(n) => set({ fee: n })} /> },
            { key: 'total', label: 'Total', kind: 'amount',
              value: (o) => orderMoved(o),
              // What the order actually moved through the wallet: the shares' price with the
              // fee added on a buy, and taken off on a sale — the figure the wallet itself
              // changed by, rather than a headline the fee is missing from.
              cell: (o) => <span className="mono">{dm(orderMoved(o))}</span>,
              // What it came to follows from the shares, the price and the fee rather than
              // being typed, so while a row is open it shows what those three currently make.
              field: (d) => (
                <span className="mono" style={{ color: 'var(--faint)' }}>
                  {dm(orderMoved({ side: d.side, shares: Number(d.shares) || 0,
                                   price: Number(d.price) || 0, fee: Number(d.fee) || 0 }))}
                </span>
              ) },
            { key: 'status', label: 'Status', kind: 'pick',
              value: (o) => o.status,
              cell: (o) => <Chip tone={o.status === 'executed' ? 'good'
                                     : o.status === 'pending' ? 'warn' : 'neutral'}>{o.status}</Chip>,
              field: (d, set) => <Select ariaLabel="Status" value={d.status} onChange={(v) => set({ status: v })}
                options={[{ value: 'executed', label: 'Executed' }, { value: 'pending', label: 'Pending' },
                          { value: 'cancelled', label: 'Cancelled' }]} /> },
            // What a sale earned against the average cost of every share behind it, the day it
            // was sold. Null for a buy, and null for a sale logged before this was tracked — and
            // a null reads as nothing at all here, never as a dash or a nought that would say
            // the sale broke even when the truth is simply that no figure was ever kept for it.
            { key: 'realized', label: 'Realised', kind: 'amount',
              value: (o) => (o as { realizedPnl?: number | null }).realizedPnl ?? '',
              cell: (o) => {
                const pnl = (o as { realizedPnl?: number | null }).realizedPnl;
                if (pnl == null) return null;
                const pct = (o as { realizedPnlPct?: number | null }).realizedPnlPct;
                const tone = pnl >= 0 ? 'var(--positive)' : 'var(--negative)';
                return (
                  <span className="mono" style={{ color: tone }}>
                    {pnl >= 0 ? '+' : '−'}{dm(Math.abs(pnl))}
                    {pct != null && (
                      <span style={{ fontSize: 11, marginLeft: 4, opacity: 0.85 }}>
                        {' '}({pct >= 0 ? '+' : '−'}{Math.abs(pct).toFixed(1)}%)
                      </span>
                    )}
                  </span>
                );
              } },
            /**
             * What these shares are held for.
             *
             * Asked on the order rather than on the ticker, because it is the order that is
             * the act: shares of one company bought to keep and bought to trade are two
             * different answers, and a ticker cannot hold both. Only asked at all while the
             * zakat module is on — it is the one question zakat is worked out from, and
             * nothing else on this screen reads it.
             */
            ...(zakatOn ? [{ key: 'intention', label: 'Held for', kind: 'pick' as const,
              width: '150px',
              value: (o: { intention?: Intention | null }) => o.intention ?? '',
              cell: (o: { intention?: Intention | null }) => {
                const v = o.intention ?? null;
                return v
                  ? <span style={{ fontSize: 12, color: v === 'investment' ? 'var(--zakat)' : 'var(--muted)' }}>
                      {intentionLabel('stock', v)}
                    </span>
                  : <span style={{ color: 'var(--faint)' }}>—</span>;
              },
              field: (d: Record<string, any>, set: (patch: Record<string, unknown>) => void) => (
                <Select ariaLabel="Held for" value={String(d.intention ?? '')}
                        onChange={(v) => set({ intention: v })}
                        options={intentionsFor('stock').map((o) => ({ value: o.id, label: o.label }))} />
              ) }] : []),
            // The reasoning is the longest thing in the row and was being written through a
            // slot narrower than a ticker. It keeps the width it needs and, while the row is
            // open, a box with more than one line in it.
            { key: 'note', label: 'Comment', kind: 'text', width: '260px',
              value: (o) => (o as { note?: string }).note ?? '',
              cell: (o) => <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                {(o as { note?: string }).note || <span style={{ color: 'var(--faint)' }}>—</span>}</span>,
              field: (d, set) => (
                <textarea aria-label="Comment" rows={3} placeholder="the reasoning"
                          value={d.note} onChange={(e) => set({ note: e.target.value })} />
              ) },
          ]}
          add={{
            label: 'Log an order',
            capability: 'order.log',
            blank: { date: new Date().toISOString().slice(0, 10), ticker: tickers[0] ?? '',
                     side: 'BUY', shares: 0, price: 0, fee: 0, intention: 'investment',
                     status: 'executed', note: '', tickerName: '', tickerLogo: '' },
            // A sale is of something held: the picker only offers those, and the button
            // agrees with it rather than letting a typed ticker slip past.
            valid: (d) => d.shares > 0 && d.price > 0 && TICKER.test(String(d.ticker))
              && (d.side !== 'SELL' || owned.includes(d.ticker))
              && (d.side !== 'SELL' || (Number(d.fee) || 0) < d.shares * d.price),
            // `order.log` takes none of `tickerName`/`tickerLogo` — those two are read back out
            // here, on the side, and written to the notebook in `onDone` once the order they
            // arrived with has actually gone through.
            build: (d) => {
              pendingTickerMeta.current = (d.tickerName || d.tickerLogo)
                ? { ticker: String(d.ticker).toUpperCase(),
                    name: String(d.tickerName || '').trim(), logo: String(d.tickerLogo || '').trim() }
                : null;
              return { ticker: d.ticker, side: d.side, shares: d.shares, price: d.price,
                       fee: Number(d.fee) || 0,
                       intention: zakatOn && d.intention ? d.intention : undefined,
                       status: d.status, date: d.date, note: d.note || undefined,
                       exchangeId: usingScoped ? exchangeId : undefined };
            },
            onDone: () => {
              const meta = pendingTickerMeta.current;
              pendingTickerMeta.current = null;
              if (meta && (meta.name || meta.logo)) {
                void run('stock.name.set', { ticker: meta.ticker,
                  name: meta.name || undefined, logo: meta.logo || undefined });
              }
            },
          }}
          edit={{
            capability: 'order.correct',
            draftOf: (o) => ({ date: o.date, ticker: o.ticker, side: o.side, shares: o.shares,
                               price: o.price, fee: (o as { fee?: number }).fee ?? 0,
                               intention: (o as { intention?: Intention | null }).intention ?? '',
                               status: o.status,
                               note: (o as { note?: string }).note ?? '' }),
            build: (d, o) => ({ orderId: o.id, ticker: d.ticker, side: d.side,
                                shares: Number(d.shares), price: Number(d.price),
                                fee: Number(d.fee) || 0,
                                intention: zakatOn && d.intention ? d.intention : undefined,
                                status: d.status, date: d.date, note: d.note ?? '' }),
          }}
          remove={{
            capability: 'movement.undo',
            build: (o) => ({ movementId: (o as { movementId?: string }).movementId }),
            what: (o) => `${o.side} ${o.shares} ${o.ticker}`,
            blocked: (o) => ((o as { movementId?: string }).movementId ? undefined
              : 'This order predates the movement log, so there is nothing to reverse.'),
          }}
          clear={{ log: 'orders',
                   what: 'every order logged, and the movements behind them' }}
        />
      </Panel>
      )}

      {tab === 'notebook' && <Notebook knownTickers={tickers} />}
    </Page>
  );
}

/**
 * When the prices behind the book were actually taken, said only when it is not today.
 *
 * A weekend, a holiday, or simply no connection since — all of them mean the number on screen
 * is not a lie, only a slightly older truth, and the honest thing is to say which day it is
 * from rather than let it pass as this morning's. Said as the day of the week when that is
 * still legible — the last six days — and as the date itself once it is not.
 */
export function asAtLabel(pricedAt: string | null): string | null {
  if (!pricedAt) return null;
  const priced = new Date(pricedAt);
  if (Number.isNaN(priced.getTime())) return null;
  const today = new Date();
  if (priced.toDateString() === today.toDateString()) return null;
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const daysAgo = Math.round((startOfDay(today) - startOfDay(priced)) / 86_400_000);
  if (daysAgo >= 1 && daysAgo <= 6) {
    return `Prices are as at ${priced.toLocaleDateString(undefined, { weekday: 'long' })}'s close.`;
  }
  return `Prices are as at ${priced.toISOString().slice(0, 10)}.`;
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
  const [pickingLogo, setPickingLogo] = useState(false);
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
      <span style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <input aria-label="New ticker" value={typed} placeholder="NVDA" autoFocus
               style={{ width: 150, textTransform: 'uppercase' }}
               onChange={(e) => set({ ticker: e.target.value.toUpperCase() })} />
        {/*
          * The first order for a share this ledger has never seen is also the natural place
          * to say what the company is called and hand it a logo — asked nowhere else, since
          * every later order for the same ticker already knows both.
          */}
        <input aria-label="Full company name" value={draft.tickerName ?? ''}
               placeholder="the company's full name" style={{ width: 190 }}
               onChange={(e) => set({ tickerName: e.target.value })} />
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, position: 'relative' }}>
          <span style={{ width: 26, height: 26, borderRadius: 7, flexShrink: 0,
                         display: 'flex', alignItems: 'center', justifyContent: 'center',
                         background: 'var(--raised)', border: '1px solid var(--hairline)' }}>
            <Mark mark={draft.tickerLogo || undefined} size={15} fallback="stocks" />
          </span>
          <button type="button" className="btn ghost" style={{ fontSize: 11, padding: '4px 8px' }}
                  onClick={() => setPickingLogo(true)}>
            {draft.tickerLogo ? 'Change logo' : 'Add a logo'}
          </button>
          {pickingLogo && (
            <MarkPicker value={draft.tickerLogo || undefined} family="stocks"
                        label="Logo for the new ticker"
                        onChange={(mark) => set({ tickerLogo: mark })}
                        onClose={() => setPickingLogo(false)} />
          )}
        </span>
        <button type="button"
                onClick={() => { setWriting(false); set({ ticker: choices[0] ?? '', tickerName: '', tickerLogo: '' }); }}
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
  ticker: string; name: string | null; logo: string | null;
  intention: Intention | null;
  notes: number;
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
          clear={{ log: 'notes', what: 'everything written down about a share',
                   onDone: load }}
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
            { key: 'year', label: 'Year', kind: 'amount', width: '90px',
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
            { key: 'amount', label: 'Value', kind: 'amount', width: '150px',
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
          clear={{ log: 'dividends', what: 'every distribution recorded against a share',
                   onDone: load }}
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
function BookTransfer({ exchangeId, exchanges }: { exchangeId?: string; exchanges: ExchangeRow[] }) {
  const { data, balances, dm, market: liveMarket } = useApp();
  const [direction, setDirection] = useState<'in' | 'out'>('in');
  const [source, setSource] = useState<'account' | 'dividends'>('account');
  const [accountId, setAccountId] = useState<string>('');
  const [ticker, setTicker] = useState('');
  const [amount, setAmount] = useState(0);
  const [bankRate, setBankRate] = useState('');
  const [fee, setFee] = useState(0);
  const [note, setNote] = useState('');

  // The open exchange's own wallet, once there is more than the one book — the fixtures this
  // panel falls back on have exactly the one, and keep the node it has always been found by.
  const openExchange = exchangeId ? exchanges.find((e) => e.id === exchangeId) : undefined;
  const book = openExchange
    ? data.nodes.find((n) => n.id === openExchange.walletNodeId)
    : (data.nodes.find((n) => n.priceKey === 'brokerage_cash') ?? data.nodes.find((n) => n.id === 'brokerage-cash'));
  const inBook = book ? balances[book.id] ?? book.openingQty : 0;
  /**
   * Which account this actually means, nothing chosen yet defaults to.
   *
   * The living-burn setting is often unset, or the ledger's data can arrive a moment after
   * this component first renders — either way, baking a default into `useState` freezes it at
   * whatever was true the instant this mounted, and a picker seeded from an empty ledger stays
   * pointed at nothing even once the real one loads while still visibly showing its first
   * option. Working the default out fresh on every render, and using it everywhere the raw
   * state would otherwise read as unset, keeps what is shown and what is held in agreement.
   */
  const accountIdOrDefault = accountId || defaultAccountId(data, data.settings.burnAccountId);
  const acct = data.nodes.find((n) => n.id === accountIdOrDefault);
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

  // Choosing "Initial payment" on the way in says the wallet already holds this much, with
  // nothing to deduct it from — the opening position a fresh installation needs.
  const startingBook = direction === 'in' && source === 'account' && accountId === INITIAL_PAYMENT;

  const rateOf = (cur: string) => (cur === 'EGP' ? 1 : liveMarket.fxRates[cur] ?? 1);
  const bookCur = book?.currency ?? 'EGP';
  const acctCur = acct?.currency ?? 'EGP';
  const crosses = !byDividend && !startingBook && acctCur !== bookCur;
  const mid = crosses
    ? (direction === 'in' ? rateOf(acctCur) / rateOf(bookCur) : rateOf(bookCur) / rateOf(acctCur))
    : 1;
  const applied = bankRate ? Number(bankRate) : mid;
  const net = Math.max(0, amount - fee);
  const arrives = crosses ? net * applied : net;

  // Nothing of yours is short when the money comes from outside the ledger, or states an
  // opening position rather than moving anything.
  const short = byDividend || startingBook ? false : direction === 'out' ? amount > inBook : amount > held;
  const shortBy = direction === 'out' ? amount - inBook : amount - held;

  // The wallet side of the movement, drawn the same way an account is: a label and a
  // before/after line — there is only ever the one wallet for this book, so it is a fixed
  // field rather than a picker.
  const walletField = <span style={{ fontSize: 13, color: 'var(--muted)' }}>Brokerage wallet</span>;
  const walletBalance = book && (
    <Balance node={book} delta={direction === 'in' ? arrives : -amount} />
  );

  if (startingBook) {
    const problems: string[] = [];
    if (!(amount > 0)) problems.push('The amount has to be more than nothing.');
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Segmented<'in' | 'out'> value={direction} onChange={setDirection} ariaLabel="Which way"
          options={[
            { id: 'in', label: 'Put money in', icon: 'in', tone: 'var(--positive)' },
            { id: 'out', label: 'Take money out', icon: 'out', tone: 'var(--negative)' },
          ]} />
        <Segmented<'account' | 'dividends'> value={source} onChange={setSource} ariaLabel="Where from"
          options={[
            { id: 'account', label: 'Out of an account', icon: 'accounts', tone: 'var(--muted)' },
            { id: 'dividends', label: 'From a dividend', icon: 'income', tone: 'var(--positive)' },
          ]} />
        <Field label="From">
          <SourceAccountSelect value={accountId} ariaLabel="Out of" onChange={setAccountId} />
        </Field>

        <div style={{ display: 'flex', justifyContent: 'center', color: 'var(--faint)' }}>
          <Icon name="arrowdown" size={16} />
        </div>

        <Field label="Into">{walletField}</Field>
        {book && <Balance node={book} delta={amount} />}

        <Field label={`Starting value · ${bookCur}`}>
          <Amount value={amount} ariaLabel={`Starting value in ${bookCur}`} onChange={setAmount} />
        </Field>
        <div style={{ padding: '12px 14px', borderRadius: 'var(--r-card)', background: 'var(--raised)',
                      border: '1px solid var(--hairline)', display: 'flex', flexDirection: 'column', gap: 7 }}>
          <RowLine label="Recorded" value={money(amount, bookCur, bookCur === 'EGP' ? 0 : 2)} tone="var(--muted)" />
          <div style={{ height: 1, background: 'var(--hairline)', margin: '2px 0' }} />
          <RowLine label="Net worth changes by" value={`+${money(amount, bookCur, bookCur === 'EGP' ? 0 : 2)}`} tone="var(--positive)" />
        </div>
        <p style={{ margin: 0, fontSize: 11, color: 'var(--faint)', lineHeight: 1.5 }}>
          No money moves. This states what the wallet already holds — nothing is deducted from
          any account, and nothing here says where it came from.
        </p>
        {problems.length > 0 && <Problems list={problems} />}
        <ActionButton capability="account.correctBalance" disabled={problems.length > 0}
          onDone={(o) => { if (o.ok) setAmount(0); }}
          input={() => ({ accountId: book!.id, actual: inBook + amount })}>
          Record the starting value
        </ActionButton>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
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

      {/* From, then To — the same order every movement in this ledger asks in, and the
          same before/after line under each: the account (or the dividend, which has none)
          on the way in, the wallet on the way out, and the other way round leaving. */}
      {direction === 'in' ? (
        byDividend ? (
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
          <>
            <Field label="From">
              <SourceAccountSelect value={accountIdOrDefault} ariaLabel="Account" onChange={setAccountId} />
            </Field>
            {acct && <Balance node={acct} delta={-amount} />}
          </>
        )
      ) : (
        <>
          <Field label="From">{walletField}</Field>
          {walletBalance}
        </>
      )}

      <div style={{ display: 'flex', justifyContent: 'center', color: 'var(--faint)' }}>
        <Icon name="arrowdown" size={16} />
      </div>

      {direction === 'in' ? (
        <>
          <Field label="Into">{walletField}</Field>
          {walletBalance}
        </>
      ) : (
        <>
          <Field label="Into">
            <Select ariaLabel="Account" value={accountIdOrDefault} onChange={setAccountId}
                    options={data.nodes.filter((n) => n.kind === 'cash')
                      .map((n) => accountOption(data, n, { currency: true }))} />
          </Field>
          {acct && <Balance node={acct} delta={arrives} />}
        </>
      )}

      <Field label={byDividend ? 'Amount' : `Amount · ${direction === 'in' ? acctCur : bookCur}`}
             hint={byDividend ? 'What the distribution actually paid you'
                   : direction === 'out' ? `${dm(inBook)} available` : `${dm(held)} in that account`}>
        <Amount value={amount} ariaLabel="Amount"
                   onChange={(n) => setAmount(n)} />
      </Field>

      {/* The rate is only a question when there are two currencies to reconcile. The fee is
          not: a broker takes one for moving money in, for taking it out, and whether or not
          the account it comes from is in the wallet's own currency. */}
      {crosses && (
        <Field label="Rate the bank gave" hint={`mid-market ${mid.toFixed(4)}`}>
          <input className="mono" type="number" step="0.0001" placeholder={mid.toFixed(4)}
                 aria-label="Rate the bank gave"
                 value={bankRate} onChange={(e) => setBankRate(e.target.value)} />
        </Field>
      )}
      {!byDividend && (
        <Field label={`Fee · ${direction === 'in' ? acctCur : bookCur}`}
               hint="Charged on the way in and on the way out, in the same currency the amount is sent in — some brokers take one even when nothing is being exchanged.">
          <Amount value={fee} ariaLabel="Fee" onChange={setFee} />
        </Field>
      )}

      <Field label="Note">
        <input aria-label="Transfer note" placeholder="topping up, taking profit"
               value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>

      {!byDividend && (
        <div style={{ padding: '12px 14px', borderRadius: 'var(--r-card)', background: 'var(--raised)',
                      border: '1px solid var(--hairline)', display: 'flex', flexDirection: 'column', gap: 7 }}>
          <RowLine label="Leaves" value={money(amount, direction === 'in' ? acctCur : bookCur,
                                               (direction === 'in' ? acctCur : bookCur) === 'EGP' ? 0 : 2)}
                   tone="var(--negative)" />
          <RowLine label="Arrives" value={money(arrives, direction === 'in' ? bookCur : acctCur,
                                                (direction === 'in' ? bookCur : acctCur) === 'EGP' ? 0 : 2)}
                   tone="var(--positive)" />
          {fee > 0 && <RowLine label="Fee" value={money(fee, direction === 'in' ? acctCur : bookCur)} tone="var(--negative)" muted />}
          <div style={{ height: 1, background: 'var(--hairline)', margin: '2px 0' }} />
          <RowLine label="Net worth changes by" value={fee > 0 ? `−${money(fee, direction === 'in' ? acctCur : bookCur)}` : 'nothing'}
                   tone={fee > 0 ? 'var(--negative)' : 'var(--faint)'} />
        </div>
      )}

      {short && amount > 0 && (
        <Problems list={[`${direction === 'out' ? 'The book holds' : `${acct?.name} holds`} ${money(direction === 'out' ? inBook : held, direction === 'out' ? bookCur : acctCur)}, which is ${money(shortBy, direction === 'out' ? bookCur : acctCur)} short.`]} />
      )}
      {crosses && bankRate && !(Number(bankRate) > 0) && (
        <Problems list={['The rate has to be a positive number.']} />
      )}
      {!byDividend && fee > amount && amount > 0 && (
        <Problems list={['The fee is larger than the amount being sent.']} />
      )}

      {/* money leaving is red wherever it is offered, and it is the same button underneath */}
      <ActionButton capability="book.transfer"
        disabled={!(amount > 0) || short || (!byDividend && !accountIdOrDefault)
          || (crosses && !!bankRate && !(Number(bankRate) > 0))
          || (!byDividend && fee > amount)}
        className={direction === 'out' ? 'btn danger' : 'btn go'}
        onDone={(o) => { if (o.ok) { setAmount(0); setNote(''); setTicker(''); setFee(0); setBankRate(''); } }}
        input={() => ({
          direction, amount, source: byDividend ? 'dividends' : 'account',
          exchangeId,
          accountId: byDividend ? undefined : accountIdOrDefault,
          ticker: byDividend && ticker ? ticker : undefined,
          rateApplied: crosses && bankRate ? Number(bankRate) : undefined,
          fee: byDividend ? undefined : (fee || undefined),
          note: note || undefined,
        })}>
        {byDividend ? 'Pay it in' : direction === 'in' ? 'Move it in' : 'Move it out'}
      </ActionButton>
    </div>
  );
}