import { useCallback, useEffect, useState } from 'react';
import { Amount } from '../components/Amount';
import { useApp, market } from '../AppState';
import { Select, opts } from '../components/Select';
import { computedPositions, brokerageCash, money, fmt } from '@ledger/engine';
import { Page, Panel, Stat, Stats, Chip, Toggle, Field, Row } from '../components/UI';
import { Donut } from '../components/Donut';
import { Icon } from '../components/Icon';
import { ActionButton, useLive } from '../Live';
import { ledger } from '../api';
import { ConfirmDelete } from '../components/Confirm';
import { DateField } from '../components/DateField';
import { RecordTable } from '../components/RecordTable';
import { OperationPanel } from '../components/Operations';
import { Segmented } from '../components/Segmented';
import { ModeProvider, useMode } from '../components/ModeBar';
import { SectionProvider, Sections, useSection } from '../components/Sections';

const PALETTE = ['var(--positive)', 'var(--car)', 'var(--gold)', 'var(--stocks)'];

export function Stocks() {
  return (
    <ModeProvider>
      <SectionProvider first="book"><Body /></SectionProvider>
    </ModeProvider>
  );
}

function Body() {
  const { data, dm, reminders, setReminders } = useApp();
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
    ...Object.keys(market.prices),
  ])].sort();
  const { mode } = useMode();
  const { tab } = useSection();

  const positions = computedPositions(data.orders, market.prices);
  const cash = brokerageCash(data);
  const value = positions.reduce((s, p) => s + p.value, 0);
  const cost = positions.reduce((s, p) => s + p.cost, 0);
  const book = value + cash;
  const pl = book - data.settings.stockInitEgp;

  const slices = [
    ...positions.map((p, i) => ({ label: p.ticker, value: p.value, color: PALETTE[i % PALETTE.length]! })),
    { label: 'Cash', value: cash, color: 'var(--disabled)' },
  ];

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
          hint: 'What you thought about a share, on the day you thought it — held or not.',
          editHint: 'Rewrite a note, move it to another day, or file it under another ticker.' },
      ]} />

      <Panel>
        <div style={{ display: 'flex', gap: 36, alignItems: 'center', flexWrap: 'wrap' }}>
          <Donut slices={slices} size={190} thickness={26} centre={
            <>
              <span className="mono" style={{ fontSize: 17, fontWeight: 500 }}>{dm(book)}</span>
              <span style={{ fontSize: 10, color: 'var(--faint)' }}>total book</span>
              <span className="mono" style={{ fontSize: 12, marginTop: 4, color: pl >= 0 ? 'var(--positive)' : 'var(--negative)' }}>
                {pl >= 0 ? '+' : '−'}{dm(Math.abs(pl))} · {data.settings.stockInitEgp > 0 ? `${((pl / data.settings.stockInitEgp) * 100).toFixed(1)}%` : '—'}
              </span>
            </>
          } />
          <div style={{ flex: 1, minWidth: 300 }}>
            <Stats>
              <Stat label="Deployed" value={dm(cost)} />
              <Stat label="Value now" value={dm(value)} />
              <Stat label="Unrealized" value={`+${dm(value - cost)}`} color="var(--positive)" />
              <Stat label="Uninvested" value={dm(cash)} />
            </Stats>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 18 }}>
              {slices.map((s) => (
                <span key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--muted)' }}>
                  <span style={{ width: 9, height: 9, borderRadius: 3, background: s.color }} />
                  {s.label} {book > 0 ? `${((s.value / book) * 100).toFixed(1)}%` : '—'}
                </span>
              ))}
            </div>
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
          hint="Uninvested cash in the brokerage has to arrive from somewhere. Buying a position later moves it again, from that cash into the holding.">
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
              field: (d, set) => <Select ariaLabel="Ticker" value={d.ticker}
                                         onChange={(v) => set({ ticker: v })} options={opts(tickers)} /> },
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
            valid: (d) => d.shares > 0 && d.price > 0 && !!d.ticker,
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

interface Note {
  id: string; ticker: string; name: string | null;
  date: string; note: string; createdAt: string; updatedAt: string | null;
}

interface Followed {
  ticker: string; name: string | null; notes: number;
  latestNote: string | null; latestOn: string | null;
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
  const [notes, setNotes] = useState<Note[]>([]);
  const [followed, setFollowed] = useState<Followed[]>([]);

  const load = useCallback(() => {
    if (!live) { setNotes([]); setFollowed([]); return; }
    (ledger as any)['stock.notes.list']({}).then((rows: Note[]) => setNotes(rows ?? []))
      .catch(() => setNotes([]));
    (ledger as any)['stocks.list']({}).then((rows: Followed[]) => setFollowed(rows ?? []))
      .catch(() => setFollowed([]));
  }, [live]);
  useEffect(load, [load, version]);

  // whatever has been traded or priced, plus whatever has been written about
  const suggestions = [...new Set([...knownTickers, ...followed.map((f) => f.ticker)])].sort();
  const nameOf = (ticker: string) =>
    followed.find((f) => f.ticker === ticker.toUpperCase())?.name ?? '';
  const latest = notes.reduce<string | null>((a, n) => (a && a > n.date ? a : n.date), null);

  return (
    <>
      <Panel title="The notebook"
             hint="One line per thought, under the share it is about. Nothing here moves money or changes a position — it is the reasoning, kept where the reasoning can be found again.">
        <Stats>
          <Stat label="Shares followed" value={String(followed.length)}
                sub={followed.length === 1 ? 'in the notebook' : 'held or not'} />
          <Stat label="Notes written" value={String(notes.length)} />
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
            { key: 'name', label: 'Company', kind: 'text', width: '200px',
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
  const [accountId, setAccountId] = useState(data.settings.burnAccountId);
  const [amount, setAmount] = useState(0);
  const [note, setNote] = useState('');

  const book = data.nodes.find((n) => n.id === 'brokerage-cash');
  const inBook = book ? balances[book.id] ?? book.openingQty : 0;
  const acct = data.nodes.find((n) => n.id === accountId);
  const held = acct ? balances[acct.id] ?? acct.openingQty : 0;

  const short = direction === 'out' ? amount > inBook : amount > held;
  const shortBy = direction === 'out' ? amount - inBook : amount - held;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Segmented<'in' | 'out'> value={direction} onChange={setDirection} ariaLabel="Which way"
        options={[
          { id: 'in', label: 'Put money in', icon: 'in', tone: 'var(--positive)' },
          { id: 'out', label: 'Take money out', icon: 'out', tone: 'var(--negative)' },
        ]} />

      {/* Which way, drawn: a bank on one side, the book on the other, and the arrow between
          them pointing where the money actually goes. */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14,
                    padding: '14px 16px', borderRadius: 'var(--r-card)',
                    background: 'var(--raised)', border: '1px solid var(--hairline)' }}>
        <Waypoint icon="accounts" label={acct?.name ?? 'an account'}
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
        <div className="ov">Uninvested in the book</div>
        <div className="mono" style={{ fontSize: 18, fontWeight: 500, marginTop: 4 }}>{dm(inBook)}</div>
      </div>

      <Field label={direction === 'in' ? 'Out of' : 'Into'}>
        <Select ariaLabel="Account" value={accountId} onChange={setAccountId}
                options={data.nodes.filter((n) => n.kind === 'cash').map((n) => ({
                  value: n.id, label: `${n.name} · ${n.currency}`,
                  hint: data.institutions.find((i) => i.id === n.parentId)?.name,
                }))} />
      </Field>

      <Field label="Amount" hint={direction === 'out' ? `${dm(inBook)} available` : `${dm(held)} in that account`}>
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
        onDone={(o) => { if (o.ok) { setAmount(0); setNote(''); } }}
        input={() => ({ accountId, direction, amount, note: note || undefined })}>
        {direction === 'in' ? 'Move it in' : 'Move it out'}
      </ActionButton>
    </div>
  );
}

/** One end of the transfer, so the direction has two things to be between. */
function Waypoint({ icon, label, tone }: { icon: 'accounts' | 'stocks'; label: string; tone: string }) {
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