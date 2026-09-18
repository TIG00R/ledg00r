import { useCallback, useEffect, useState } from 'react';
import { Amount } from '../components/Amount';
import { useApp, market as staticMarket } from '../AppState';
import { money, fmt, toEgp } from '@ledger/engine';
import { Page, Panel, Stat, Stats, Chip, Field } from '../components/UI';
import { Select } from '../components/Select';
import { DateField } from '../components/DateField';
import { Segmented } from '../components/Segmented';
import { RecordTable } from '../components/RecordTable';
import { HawlBar } from '../components/Intention';
import { Icon } from '../components/Icon';
import { SectionProvider, Sections, useSection } from '../components/Sections';
import { ActionButton, useLive } from '../Live';
import { ledger } from '../api';
import {
  OperationPanel, SourceAccountSelect, INITIAL_PAYMENT, RowLine, Problems, Balance,
  QuantityBalance, defaultAccountId,
} from '../components/Operations';
import { accountOption } from '../accounts';

type Metal = 'gold' | 'silver';

interface Lot {
  id: string; date: string; dateText: string; metal: Metal;
  direction: 'buy' | 'sell'; grams: number; pricePerGram: number;
  totalEgp: number; note: string | null; movementId: string | null;
  /** what the dealer quoted, and in what — the pound figures are the reading of it */
  currency: string; priceNative: number;
  /** the making charge — مصنعية — a gram in that currency, and what it came to in pounds */
  makingPerGram: number; makingEgp: number;
  /** a sale's flat charge, in the account's currency; nought on a purchase */
  fee: number;
  /** the account the money came out of, or went into */
  accountId: string | null;
  /** worn, or held as a store of value — the answer decides whether zakat reaches it */
  intention: 'personal' | 'investment';
}

/**
 * Gold and silver.
 *
 * One screen, because they are the same kind of holding: a weight you own, valued at a price
 * nobody fetches for you. That last part is why the panel beside the ledger sets prices
 * rather than recording another purchase — an estimate of what you are worth rests on those
 * two numbers, and they are the only ones the application cannot work out for itself.
 */
export function Metals() {
  return (
    <SectionProvider first="metals"><Body /></SectionProvider>
  );
}

function Body() {
  const { dm, balances, data } = useApp();
  const { tab } = useSection();
  const { run, live, version } = useLive();

  const [metal, setMetal] = useState<Metal>('gold');
  const [lots, setLots] = useState<Lot[] | null>(null);
  const [prices, setPrices] = useState<Record<string, number>>({});

  /** the zakat reading of this weight, worked out by the ledger rather than by this screen */
  const [zakatLines, setZakatLines] = useState<any[] | null>(null);

  const load = useCallback(() => {
    if (!live) { setLots(null); setZakatLines(null); return; }
    (ledger as any)['metals.lots']({})
      .then(setLots).catch(() => setLots(null));
    (ledger as any)['market.read']({})
      .then((m: any) => setPrices(m.prices ?? {})).catch(() => undefined);
    (ledger as any)['zakat.assessment']({})
      .then((a: any) => setZakatLines(a?.assets ?? [])).catch(() => setZakatLines(null));
  }, [live]);
  useEffect(load, [load, version]);

  const perGram = prices[metal === 'gold' ? 'gold_g' : 'silver_g']
    ?? (metal === 'gold' ? staticMarket.goldPerG : 0);
  const held = balances[metal] ?? 0;

  const mine = (lots ?? []).filter((l) => l.metal === metal);
  /** an account reads as its bank and its name, the same way it does everywhere else */
  const accountName = (id: string | null) => {
    const n = data.nodes.find((x) => x.id === id);
    if (!n) return '—';
    const inst = data.institutions.find((i) => i.id === n.parentId);
    return inst ? `${inst.name} · ${n.name}` : n.name;
  };
  /**
   * Worn, and held.
   *
   * Two weights rather than one, because jewellery in ordinary use is outside zakat on the
   * position this ledger follows and metal kept as a holding is not. The split is read off the
   * lots, so it follows the record rather than a figure typed once.
   */
  const weightOf = (want: 'personal' | 'investment') => mine
    .filter((l) => (l.intention ?? 'investment') === want)
    .reduce((s2, l) => s2 + (l.direction === 'sell' ? -l.grams : l.grams), 0);
  const wornG = Math.max(0, weightOf('personal'));
  const holdingG = Math.max(0, weightOf('investment'));

  const bought = mine.filter((l) => l.direction === 'buy');
  /* What the metal actually cost: the gram, plus the workmanship charged on top of it. A
     lot's totalEgp is already the two summed — grams x (price a gram + making a gram) — so
     the average is read straight off it rather than added to a second time. */
  const paid = bought.reduce((s, l) => s + l.totalEgp, 0);
  const makingPaid = bought.reduce((s, l) => s + (l.makingEgp ?? 0), 0);
  const boughtG = bought.reduce((s, l) => s + l.grams, 0);
  const avgCost = boughtG ? paid / boughtG : 0;
  const worth = held * perGram;


  const tone = metal === 'gold' ? 'var(--gold)' : '#9AA3AD';

  return (
    <Page aside={(
      <OperationPanel title="Record a movement"
        hint="Metal is paid for out of a named account, and selling puts the money back into one. Net worth does not change beyond what a making charge or a fee actually costs.">
        <MetalTrade metal={metal} perGram={perGram} held={held} onDone={load} />
      </OperationPanel>
    )}>
      {/*
        * Which metal, and what it is worth today.
        *
        * The price is not asked for here any more — it is fetched from whichever source is
        * chosen under Prices, the same way every other rate in this ledger is. What is left
        * is the choice of metal, which decides everything below it, and the figure that
        * choice is being valued at.
        */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <Segmented<Metal> value={metal} onChange={setMetal} ariaLabel="Which metal"
          options={[
            { id: 'gold', label: 'Gold', icon: 'gold', tone: 'var(--gold)' },
            { id: 'silver', label: 'Silver', icon: 'coins', tone: '#9AA3AD' },
          ]} />
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>
          {perGram
            ? <>valued at <span className="mono" style={{ color: tone }}>{money(perGram, 'EGP')}</span> a gram</>
            : 'no price recorded for this metal yet'}
        </span>
      </div>

      <Sections sections={[
        // Holdings is a reading of the records, not a thing to correct — what would be
        // corrected is on the Records tab beside it.
        { id: 'metals', label: 'Holdings', icon: 'gold',
          hint: 'What you hold and what it is worth at the price recorded for it.' },
        { id: 'records', label: 'Records', icon: 'ledger',
          hint: 'Every purchase and sale, with the reason it was made. Double-click one to correct it, or take it off the ledger.' },
      ]} />

      {tab === 'metals' && (
      <Panel>
        <Stats>
          <Stat label={`${metal === 'gold' ? 'Gold' : 'Silver'} held`} value={`${held.toFixed(1)} g`}
                sub={`${(held / 31.1035).toFixed(2)} troy oz`} />
          {/* The three figures are one subtraction, so they are written the same way: what
              the weight is worth, what it cost, and the difference — each a total, with the
              gram price that produced it underneath. Reading a total against a per-gram
              figure was asking the eye to do the multiplication. */}
          <Stat label="Worth now" value={dm(worth)}
                sub={perGram ? `at ${dm(perGram)} a gram` : 'no price recorded'} />
          <Stat label="Average cost" value={avgCost ? dm(held * avgCost) : '—'}
                sub={avgCost
                  ? `at ${dm(avgCost)} a gram${makingPaid ? `, making included` : ''} · ${boughtG.toFixed(1)} g bought`
                  : 'nothing bought yet'} />
          <Stat label="Against cost" value={avgCost ? dm(worth - held * avgCost) : '—'}
                color={worth >= held * avgCost ? 'var(--positive)' : 'var(--negative)'}
                sub={avgCost
                  ? `${dm(perGram - avgCost)} a gram · ${(((perGram - avgCost) / avgCost) * 100).toFixed(1)}%`
                  : ''} />
          {/* Two weights, because only one of them is reached by zakat. */}
          <Stat label="Held as a holding" value={`${holdingG.toFixed(1)} g`}
                sub={holdingG ? 'the weight zakat can reach' : 'nothing held as a holding'} />
          <Stat label="Worn" value={`${wornG.toFixed(1)} g`}
                sub={wornG ? 'jewellery in use — outside zakat' : 'none recorded as worn'} />
        </Stats>
      </Panel>
      )}

      {tab === 'metals' && live && (() => {
        /**
         * What zakat makes of this weight.
         *
         * Two questions, and the ledger answers both: how much of it is worn — which is
         * outside zakat — and how long the rest has been held above nisab. The date can be
         * stated here because a holding bought before this ledger existed has a date only its
         * owner knows, and the day the books were opened is not it.
         */
        const line = (zakatLines ?? []).find((l) => l.id === `${metal}-investment`);
        const worn = (zakatLines ?? []).find((l) => l.id === `${metal}-personal`);
        return (
          <Panel title={`Zakat on your ${metal}`}
                 hint="Jewellery in ordinary use is outside zakat on the position this ledger follows. What is held as a store of value is inside it — once it passes nisab and a full lunar year has run over it.">
            <div style={{ display: 'grid', gap: 20,
                          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
              <div>
                <div className="ov" style={{ marginBottom: 8 }}>The split</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <Chip tone={line?.included ? 'good' : undefined}>
                      {line ? `${holdingG.toFixed(1)} g held` : 'nothing held'}
                    </Chip>
                    <span className="mono" style={{ fontSize: 13 }}>
                      {line?.included ? dm(line.counted) : 'counts nothing yet'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <Chip>{wornG.toFixed(1)} g worn</Chip>
                    <span style={{ fontSize: 12, color: 'var(--faint)' }}>outside zakat</span>
                  </div>
                  <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--faint)', lineHeight: 1.55 }}>
                    {line?.reason ?? worn?.reason ?? 'Nothing of this metal is recorded.'}
                  </p>
                </div>
              </div>

              <Field label="Held above nisab since"
                     hint="the day the held weight passed nisab and has stayed there — leave it and the record is used">
                <DateField value={line?.anchorOn ?? ''} ariaLabel={`${metal} held above nisab since`}
                           onChange={(v) => run('asset.update', { assetId: metal, nisabMetOn: v }).then(load)} />
              </Field>

              <div>
                <div className="ov" style={{ marginBottom: 8 }}>Its lunar year</div>
                <HawlBar hawl={line?.hawl ?? null} tone={tone} />
              </div>
            </div>
          </Panel>
        );
      })()}

      {tab === 'records' && (
      <Panel title="Movement ledger"
             hint="Every purchase and sale, with the reason it was made. Undoing one writes its opposite rather than removing it, so the record still says both things happened.">
        <RecordTable
          rows={mine}
          rowKey={(l) => l.id}
          sort={{ key: 'date', dir: 'desc' }}
          empty={{ icon: 'gold', title: `No ${metal} recorded yet`,
                   body: 'Buying is recorded against an account, so the money has somewhere to come from.' }}
          columns={[
            /*
              * The columns are the fields of the form that records one, in the order that
              * form asks for them and at the widths those controls actually need — a row
              * being corrected is the widest the table ever gets, and sizing for the reading
              * row is what left the account and the intention wrapping over three lines.
              */
            { key: 'date', label: 'Date', kind: 'date', width: '138px',
              value: (l) => l.date ?? l.dateText,
              cell: (l) => <span className="mono" style={{ fontSize: 13 }}>{l.dateText}</span>,
              field: (d, set) => <DateField value={d.date ?? ''} ariaLabel="Date"
                                            onChange={(v) => set({ date: v })} /> },
            { key: 'direction', label: 'Movement', kind: 'pick', width: '108px',
              choices: ['Buy', 'Sell'],
              value: (l) => (l.direction === 'sell' ? 'Sell' : 'Buy'),
              cell: (l) => <Chip tone={l.direction === 'sell' ? 'bad' : 'good'}>
                {l.direction === 'sell' ? 'Sell' : 'Buy'}</Chip>,
              // Which way a lot went is not a correction — reversing it is. Adding one says.
              field: (d, set, row) => (row
                ? <Chip tone={row.direction === 'sell' ? 'bad' : 'good'}>
                    {row.direction === 'sell' ? 'Sell' : 'Buy'}</Chip>
                : <Select ariaLabel="Buying or selling" value={d.direction ?? 'buy'}
                          onChange={(v) => set({ direction: v })}
                          options={[{ value: 'buy', label: 'Buy', hint: 'money out, grams in' },
                                    { value: 'sell', label: 'Sell', hint: 'grams out, money in' }]} />) },
            { key: 'grams', label: 'Grams', kind: 'amount', width: '112px',
              value: (l) => l.grams,
              cell: (l) => <span className="mono" style={{ color: tone }}>
                {l.direction === 'sell' ? '−' : '+'}{l.grams}</span>,
              field: (d, set) => <Amount value={d.grams ?? 0} ariaLabel="Grams"
                                         onChange={(n) => set({ grams: n })} /> },
            { key: 'price', label: 'Price / g', kind: 'amount', width: '124px',
              value: (l) => l.pricePerGram,
              /* Quoted in dollars, it is read back in dollars: the pound figure is in the
                 total beside it, and printing both here said the same thing twice. */
              cell: (l) => (
                <span className="mono">{fmt(l.priceNative ?? l.pricePerGram)}
                  {(l.currency ?? 'EGP') !== 'EGP' && (
                    <span style={{ fontSize: 10, color: 'var(--faint)' }}> {l.currency}</span>
                  )}
                </span>
              ),
              field: (d, set) => <Amount value={d.pricePerGram ?? 0} ariaLabel="Price a gram"
                                         onChange={(n) => set({ pricePerGram: n })} /> },
            /* مصنعية: what the workmanship cost by the gram, in the currency it was quoted
               in. Nought on a lot bought as bullion, which is most of them. */
            { key: 'making', label: 'Making / g', kind: 'amount', width: '118px',
              value: (l) => l.makingPerGram ?? 0,
              cell: (l) => (l.makingPerGram
                ? <span className="mono">{fmt(l.makingPerGram)}</span>
                : <span style={{ color: 'var(--faint)' }}>—</span>),
              field: (d, set) => <Amount value={d.makingPerGram ?? 0} ariaLabel="Making charge a gram"
                                         onChange={(n) => set({ makingPerGram: n })} /> },
            { key: 'total', label: 'Total', kind: 'amount', width: '136px',
              value: (l) => l.totalEgp,
              // What it came to follows from the grams and the price; it is not typed in.
              cell: (l) => <span className="mono">{dm(l.totalEgp)}</span>,
              // The making charge is a per-gram amount added to the gram price before the
              // weight multiplies it — buying it is spent, selling it is taken off — so the
              // preview while adding or correcting a row has to run the same formula the
              // capability does, or the figure shown here would disagree with what gets saved.
              field: (d, set, row) => {
                const direction = row?.direction ?? d.direction ?? 'buy';
                const grams = Number(d.grams) || 0;
                const price = Number(d.pricePerGram) || 0;
                const making = Number(d.makingPerGram) || 0;
                const total = grams * (direction === 'sell' ? price - making : price + making);
                return (
                  <span className="mono" style={{ color: 'var(--faint)' }}>
                    {dm(total)}
                  </span>
                );
              } },
            // The flat charge on the deal itself, in the account's own currency — one charge
            // for the lot, however many grams it was, which is what separates it from the
            // making charge in the column before it.
            { key: 'fee', label: 'Fee', kind: 'amount', width: '110px',
              value: (l) => l.fee ?? 0,
              cell: (l) => (l.fee
                ? <span className="mono" style={{ color: 'var(--negative)' }}>{dm(l.fee)}</span>
                : <span style={{ color: 'var(--faint)' }}>—</span>),
              field: (d, set) => <Amount value={Number(d.fee) || 0} ariaLabel="Fee"
                                         onChange={(n) => set({ fee: n })} /> },
            { key: 'account', label: 'Paid from', kind: 'pick', width: '148px',
              value: (l) => accountName(l.accountId),
              cell: (l) => <span style={{ fontSize: 12, color: 'var(--muted)' }}>{accountName(l.accountId)}</span>,
              // A lot from before the ledger names no account, and the picker must say so
              // rather than showing the first one in the list as though it had been chosen.
              field: (d, set) => (
                <Select ariaLabel="Account" value={d.accountId ?? ''}
                        onChange={(v) => set({ accountId: v })}
                        options={[{ value: '', label: '— none recorded' },
                                  ...data.nodes.filter((n) => n.kind === 'cash')
                                    .map((n) => accountOption(data, n))]} />
              ) },
            /*
              * One word in the chip, and what it means under it. "A holding · zakatable" in
              * a column this wide broke across three lines and read as two different values.
              */
            { key: 'intention', label: 'Held for', kind: 'pick', width: '124px',
              choices: ['A holding', 'Worn'],
              value: (l) => ((l.intention ?? 'investment') === 'personal' ? 'Worn' : 'A holding'),
              cell: (l) => {
                const worn = (l.intention ?? 'investment') === 'personal';
                return (
                  <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 3,
                                 alignItems: 'flex-start' }}>
                    <Chip tone={worn ? undefined : 'good'}>{worn ? 'Worn' : 'A holding'}</Chip>
                    <span style={{ fontSize: 10, color: 'var(--faint)', whiteSpace: 'nowrap' }}>
                      {worn ? 'not zakatable' : 'zakatable'}
                    </span>
                  </span>
                );
              },
              field: (d, set) => (
                <Select ariaLabel="Held for" value={(d.intention as string) ?? 'investment'}
                        onChange={(v) => set({ intention: v })}
                        options={[
                          { value: 'investment', label: 'A holding', hint: 'zakatable' },
                          { value: 'personal', label: 'Worn', hint: 'not zakatable' },
                        ]} />
              ) },
            { key: 'note', label: 'Note', kind: 'text',
              value: (l) => l.note ?? '',
              cell: (l) => <span style={{ fontSize: 13, color: 'var(--muted)' }}>
                {l.note || <span style={{ color: 'var(--faint)' }}>—</span>}</span>,
              field: (d, set) => <input aria-label="Note" placeholder="why"
                                        value={d.note ?? ''}
                                        onChange={(e) => set({ note: e.target.value })} /> },
          ]}
          add={{
            label: `Record ${metal} bought or sold`,
            // Buying and selling are different capabilities and one gesture.
            capability: (d) => (d.direction === 'sell' ? 'metal.sell' : 'metal.buy'),
            blank: { date: new Date().toISOString().slice(0, 10), direction: 'buy',
                     grams: 0, pricePerGram: 0, makingPerGram: 0, fee: 0,
                     accountId: defaultAccountId(data, data.settings.burnAccountId),
                     intention: 'investment', note: '' },
            valid: (d) => Number(d.grams) > 0 && !!d.accountId,
            build: (d) => ({ metal, accountId: d.accountId, grams: Number(d.grams),
                             pricePerGram: Number(d.pricePerGram) || undefined,
                             makingPerGram: Number(d.makingPerGram) || undefined,
                             fee: Number(d.fee) || undefined,
                             date: d.date, note: d.note || undefined,
                             intention: d.intention || 'investment' }),
          }}
          /*
            * Every record here can be corrected and every one can be taken off, the same two
            * buttons as every other log in this application. A lot held from before the books
            * were opened has no movement behind it, which used to leave both greyed out — the
            * ledger now moves the holding's opening weight instead, so the row answers to the
            * same gestures as one bought through it.
            */
          edit={{
            capability: 'metal.correctLot',
            // A lot carried in from before the ledger has a date only in words — "Feb 2026" —
            // which no date field can hold, so it is offered empty and left alone if it is
            // left empty.
            draftOf: (l) => ({ date: l.date ?? '', grams: l.grams,
                               pricePerGram: l.pricePerGram, makingPerGram: l.makingPerGram ?? 0,
                               // The lot's own flat charge, whichever way it went. Opened
                               // without it the row would save as though the deal never cost
                               // anything, and the account would quietly gain it back.
                               fee: l.fee ?? 0,
                               accountId: l.accountId ?? '',
                               intention: l.intention ?? 'investment', note: l.note ?? '' }),
            build: (d, l) => ({ lotId: l.id, grams: Number(d.grams),
                                pricePerGram: Number(d.pricePerGram),
                                makingPerGram: Number(d.makingPerGram) || undefined,
                                fee: Number(d.fee) || 0,
                                accountId: d.accountId || undefined,
                                intention: d.intention || undefined,
                                date: d.date || undefined, note: d.note ?? '' }),
            onDone: load,
          }}
          remove={{
            capability: 'metal.removeLot',
            build: (l) => ({ lotId: l.id }),
            what: (l) => `${l.direction} of ${l.grams} g`,
            onDone: load,
          }}
          clear={{ log: 'metals',
                   what: 'every gold and silver lot, and the movements behind them',
                   onDone: load }}
        />
      </Panel>
      )}
    </Page>
  );
}

/**
 * Buying and selling metal, in the same shape Move money uses: pick where it leaves, see
 * what that holds before and after, the same going the other way, then the amount and what
 * it costs on top of the metal itself.
 *
 * Buying is money leaving an account and grams arriving in the holding; selling is the same
 * movement read backwards — the holding is what "From" or "To" means when there is no
 * account to pick, since there is only ever the one holding of this metal. Net worth does
 * not move on its own: only a making charge or a flat fee genuinely leaves, the same way a
 * fee is the only thing Move money ever takes off the top.
 */
function MetalTrade({ metal, perGram, held, onDone }: {
  metal: Metal; perGram: number; held: number; onDone: () => void;
}) {
  const { data, market, currencies } = useApp();
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  // The living-burn account is often unset, and seeding this with an id that names no
  // account left "Paid from" showing the first account on the list while actually holding
  // none — invisible here (there is no balance hint on this field), but real: the button
  // stayed enabled and the write was refused for a NodeId that was never really chosen.
  const [trade, setTrade] = useState({
    accountId: defaultAccountId(data, data.settings.burnAccountId), grams: 0, pricePerGram: 0, note: '',
    intention: 'investment' as 'personal' | 'investment',
    /* what the dealer quotes in, and the workmanship they charge on top of the metal */
    currency: 'EGP', makingPerGram: 0,
    /* a flat charge on the sale itself, in the account's own currency — distinct from the
       making charge, which is quoted a gram in whatever currency the metal itself was */
    fee: 0,
  });
  const [logDate, setLogDate] = useState(new Date().toISOString().slice(0, 10));

  const accounts = data.nodes.filter((n) => n.kind === 'cash');
  // Distinct from the "Gold held"/"Silver held" stat above — the same words in both places
  // read as two different totals disagreeing with each other.
  const holdingLabel = `Your ${metal}`;
  const short = side === 'sell' && trade.grams > held;

  /* The quote, as it was given: a price a gram in some currency, and the workmanship charged
     on top of it. Everything the ledger stores is pounds, so this is only what the form
     shows and what the capability is handed — the conversion happens once, on the way in. */
  const fx = trade.currency === 'EGP' ? 1 : market.fxRates[trade.currency] ?? 1;
  const quotedPrice = trade.pricePerGram || perGram / fx;
  const quotedTotal = trade.grams
    * (side === 'buy' ? quotedPrice + trade.makingPerGram : quotedPrice - trade.makingPerGram);
  /* Selling for less than the dealer keeps is a typed figure rather than a sale. */
  const swallowed = side === 'sell' && trade.makingPerGram >= quotedPrice;

  // Buying, choosing "Initial payment" says this weight is already yours — an opening
  // position, not a purchase — so no price, no making charge and no account is asked for.
  const startingWeight = side === 'buy' && trade.accountId === INITIAL_PAYMENT;

  // Which account this actually means, nothing chosen yet defaults to — worked out fresh on
  // every render rather than baked into `trade`'s initial state, since that state can freeze
  // at whatever the ledger held (often nothing at all) the instant this screen first mounted.
  const accountIdOrDefault = trade.accountId || defaultAccountId(data, data.settings.burnAccountId);

  // The account named is where the money comes from on a buy, and where it lands on a sale.
  const acct = accounts.find((n) => n.id === accountIdOrDefault);
  const acctRate = acct && acct.currency !== 'EGP' ? (market.fxRates[acct.currency ?? 'EGP'] ?? 1) : 1;
  // What the metal itself is worth in the account's own currency, before any flat fee — what
  // leaves the account on a buy, what a sale earns before its fee comes off.
  const amountInAcctCurrency = (quotedTotal * fx) / acctRate;
  const feeSwallows = side === 'sell' && trade.fee > 0 && !(amountInAcctCurrency - trade.fee > 0);
  // The making charge, read in pounds — money spent, or kept by the dealer, that buys or
  // sells no weight, so it is the one thing here that behaves exactly like a transfer's fee.
  const makingEgp = toEgp(trade.grams * trade.makingPerGram, trade.currency, market);
  const feeEgp = toEgp(trade.fee, acct?.currency ?? 'EGP', market);
  const lostEgp = makingEgp + feeEgp;

  if (startingWeight) {
    const problems: string[] = [];
    if (!(trade.grams > 0)) problems.push('The amount has to be more than nothing.');
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="From">
          <SourceAccountSelect value={trade.accountId} ariaLabel="Paid from"
            onChange={(v) => setTrade({ ...trade, accountId: v })} />
        </Field>

        <div style={{ display: 'flex', justifyContent: 'center', color: 'var(--faint)' }}>
          <Icon name="arrowdown" size={16} />
        </div>

        <Field label="Into">
          <span style={{ fontSize: 13, color: 'var(--muted)' }}>your {metal} holding</span>
        </Field>
        <QuantityBalance before={held} after={held + trade.grams} format={(n) => `${n.toFixed(1)} g`} />

        <Field label="Date"><DateField value={logDate} onChange={setLogDate} ariaLabel="Date of the movement" /></Field>
        <Field label="Grams">
          <Amount value={trade.grams} ariaLabel="Grams" onChange={(n) => setTrade({ ...trade, grams: n })} />
        </Field>
        <Field label="Held for"
               hint={trade.intention === 'personal'
                 ? 'worn in ordinary use, so zakat does not reach it'
                 : 'a store of value, so zakat reaches it once it passes nisab and carries a lunar year'}>
          <Select ariaLabel="What this metal is held for" value={trade.intention}
                  onChange={(v) => setTrade({ ...trade, intention: v as 'personal' | 'investment' })}
                  options={[
                    { value: 'investment', label: 'A holding', hint: 'zakatable' },
                    { value: 'personal', label: 'Worn — jewellery', hint: 'not zakatable' },
                  ]} />
        </Field>
        <Field label="Note" hint="why, for reading back later">
          <input aria-label="Note" placeholder="carried over from before this ledger"
                 value={trade.note} onChange={(e) => setTrade({ ...trade, note: e.target.value })} />
        </Field>

        <div style={{ padding: '12px 14px', borderRadius: 'var(--r-card)', background: 'var(--raised)',
                      border: '1px solid var(--hairline)', display: 'flex', flexDirection: 'column', gap: 7 }}>
          <RowLine label="Recorded" value={`${trade.grams} g`} tone="var(--muted)" />
          <div style={{ height: 1, background: 'var(--hairline)', margin: '2px 0' }} />
          <RowLine label="Net worth changes by"
                   value={perGram ? `+${money(trade.grams * perGram, 'EGP')}` : 'unknown — no price recorded'}
                   tone="var(--positive)" />
        </div>
        <p style={{ margin: 0, fontSize: 11, color: 'var(--faint)', lineHeight: 1.5 }}>
          No money moves. This states what you already hold — nothing is deducted from any
          account, and nothing here says where it came from.
        </p>

        {problems.length > 0 && <Problems list={problems} />}

        <ActionButton capability="account.correctBalance" disabled={problems.length > 0}
          className="btn go" style={{ width: 170, justifyContent: 'center' }}
          onDone={(o) => { if (o.ok) { setTrade({ ...trade, grams: 0, note: '' }); onDone(); } }}
          input={() => ({ accountId: metal, actual: held + trade.grams })}>
          Record the starting weight
        </ActionButton>
      </div>
    );
  }

  // The holding side of the movement has nothing to pick — there is only ever the one
  // holding of this metal — so it is a fixed label rather than a picker, the way Move money
  // itself falls back to plain text once there is nothing left to choose between.
  const holdingField = <span style={{ fontSize: 13, color: 'var(--muted)' }}>your {metal} holding</span>;
  const holdingBalance = (
    <QuantityBalance before={held} after={held + (side === 'buy' ? trade.grams : -trade.grams)}
                     format={(n) => `${n.toFixed(1)} g`} />
  );
  const accountField = side === 'buy'
    ? <SourceAccountSelect value={accountIdOrDefault} ariaLabel="Paid from"
        onChange={(v) => setTrade({ ...trade, accountId: v })} />
    : <Select ariaLabel="Account" value={accountIdOrDefault}
              onChange={(v) => setTrade({ ...trade, accountId: v })}
              options={accounts.map((n) => accountOption(data, n, { currency: true }))} />;
  const accountBalance = acct && (
    <Balance node={acct}
             delta={side === 'buy' ? -(amountInAcctCurrency + trade.fee)
                                   : Math.max(0, amountInAcctCurrency - trade.fee)} />
  );

  const problems: string[] = [];
  if (!(trade.grams > 0)) problems.push('The amount has to be more than nothing.');
  if (short) problems.push(`You hold ${held.toFixed(1)} g, which is ${(trade.grams - held).toFixed(1)} g short.`);
  if (swallowed) problems.push(`A making charge of ${fmt(trade.makingPerGram)} ${trade.currency} a gram takes the whole sale. Lower it, or raise the price a gram.`);
  if (feeSwallows) problems.push(`A fee of ${trade.fee} ${acct?.currency ?? ''} takes the whole sale. Lower it, or raise the price a gram.`);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <Segmented<'buy' | 'sell'> value={side} onChange={setSide} ariaLabel="Buying or selling"
          options={[
            { id: 'buy', label: 'Buying', icon: 'in', tone: 'var(--positive)' },
            { id: 'sell', label: 'Selling', icon: 'out', tone: 'var(--negative)' },
          ]} />
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>
          {side === 'buy' ? `${metal} in, money out` : `${metal} out, money in`}
        </span>
      </div>

      <Field label="Date"><DateField value={logDate} onChange={setLogDate} ariaLabel="Date of the movement" /></Field>

      <Field label={side === 'buy' ? 'Paid from' : holdingLabel}>
        {side === 'buy' ? accountField : holdingField}
      </Field>
      {side === 'buy' ? accountBalance : holdingBalance}

      <div style={{ display: 'flex', justifyContent: 'center', color: 'var(--faint)' }}>
        <Icon name="arrowdown" size={16} />
      </div>

      <Field label={side === 'buy' ? holdingLabel : 'Proceeds into'}>
        {side === 'buy' ? holdingField : accountField}
      </Field>
      {side === 'buy' ? holdingBalance : accountBalance}

      <Field label="Grams">
        <Amount value={trade.grams} ariaLabel="Grams" onChange={(n) => setTrade({ ...trade, grams: n })} />
      </Field>

      {/* A dealer quotes in whatever they trade in. The currency is asked for beside the
          price rather than assumed from the account, because the two are different
          questions: what was agreed, and where the money came from. */}
      <Field label="Quoted in" hint="the currency the dealer priced it in">
        <Select ariaLabel="Currency the price is quoted in" value={trade.currency}
                onChange={(v) => setTrade({ ...trade, currency: v })}
                options={currencies.map((c) => ({
                  value: c.code, label: `${c.symbol} ${c.code}`, hint: c.name,
                }))} />
      </Field>
      <Field label="Price per gram"
             hint={perGram ? `in force: ${fmt(perGram / fx, fx === 1 ? 0 : 2)} ${trade.currency}` : 'no price recorded'}>
        <Amount value={trade.pricePerGram} ariaLabel="Price per gram" onChange={(n) => setTrade({ ...trade, pricePerGram: n })}
                placeholder={String(Math.round(perGram / fx) || 0)} />
      </Field>
      {/* مصنعية: the workmanship, charged by the gram on top of the metal. Buying, it is
          money spent that buys no weight; selling, it is what the dealer keeps. */}
      <Field label="Making charge per gram"
             hint={side === 'buy' ? 'مصنعية — paid on top of the metal'
                                  : 'مصنعية — taken off what you are paid'}>
        <Amount value={trade.makingPerGram} ariaLabel="Making charge per gram"
                onChange={(n) => setTrade({ ...trade, makingPerGram: n })} />
      </Field>
      <Field label="Total"
             hint={side === 'buy' ? 'the metal and the making, in the quoted currency'
                                  : 'the metal less the making, in the quoted currency'}>
        <input className="mono" readOnly aria-label="Total"
               value={`${fmt(quotedTotal)} ${trade.currency}`} />
      </Field>

      {/* A dealer charges for the deal, not only for the metal — a commission on a purchase is
          as ordinary as one on a sale, and neither is the making charge, which is quoted by
          the gram. Paid on a buy, taken off a sale, and in both cases money that buys no
          weight. */}
      <Field label={`Fee · ${acct?.currency ?? 'EGP'}`}
             hint={side === 'buy' ? 'a flat charge on the purchase itself, on top of the making charge'
                                  : 'a flat charge on the sale itself, on top of the making charge'}>
        <Amount value={trade.fee} ariaLabel="Fee" onChange={(n) => setTrade({ ...trade, fee: n })} />
      </Field>

      <Field label="Held for"
             hint={trade.intention === 'personal'
               ? 'worn in ordinary use, so zakat does not reach it'
               : 'a store of value, so zakat reaches it once it passes nisab and carries a lunar year'}>
        <Select ariaLabel="What this metal is held for" value={trade.intention}
                onChange={(v) => setTrade({ ...trade, intention: v as 'personal' | 'investment' })}
                options={[
                  { value: 'investment', label: 'A holding', hint: 'zakatable' },
                  { value: 'personal', label: 'Worn — jewellery', hint: 'not zakatable' },
                ]} />
      </Field>
      <Field label="Note" hint="why, for reading back later">
        <input aria-label="Note" placeholder="a dealer, a gift, a plan"
               value={trade.note} onChange={(e) => setTrade({ ...trade, note: e.target.value })} />
      </Field>

      <div style={{
        padding: '12px 14px', borderRadius: 'var(--r-card)', background: 'var(--raised)',
        border: '1px solid var(--hairline)', display: 'flex', flexDirection: 'column', gap: 7,
      }}>
        <RowLine label="Leaves"
                 value={side === 'buy'
                   ? money(amountInAcctCurrency + trade.fee, acct?.currency ?? 'EGP', acct?.currency === 'EGP' ? 0 : 2)
                   : `${trade.grams} g`}
                 tone="var(--negative)" />
        <RowLine label="Arrives"
                 value={side === 'buy'
                   ? `${trade.grams} g`
                   : money(Math.max(0, amountInAcctCurrency - trade.fee), acct?.currency ?? 'EGP', acct?.currency === 'EGP' ? 0 : 2)}
                 tone="var(--positive)" />
        {makingEgp > 0 && <RowLine label="Making charge" value={money(makingEgp, 'EGP')} tone="var(--negative)" muted />}
        {trade.fee > 0 && <RowLine label="Fee" value={money(feeEgp, 'EGP')} tone="var(--negative)" muted />}
        <div style={{ height: 1, background: 'var(--hairline)', margin: '2px 0' }} />
        <RowLine label="Net worth changes by" value={lostEgp > 0 ? `−${money(lostEgp, 'EGP')}` : 'nothing'}
                 tone={lostEgp > 0 ? 'var(--negative)' : 'var(--faint)'} />
        <span style={{ fontSize: 11, color: 'var(--faint)', lineHeight: 1.45 }}>
          {lostEgp > 0
            ? 'Only the making charge, and any fee, actually leave. The rest becomes metal, still yours.'
            : 'The money becomes metal — still yours, weighed differently.'}
        </span>
      </div>

      {problems.length > 0 && <Problems list={problems} />}

      <div>
        {/* One width, whichever way the movement goes: a button that grows with the number
            typed beside it moves under the cursor while it is being aimed at. */}
        <ActionButton capability={side === 'buy' ? 'metal.buy' : 'metal.sell'}
          disabled={!(trade.grams > 0) || !accountIdOrDefault || short || swallowed || feeSwallows || !(trade.pricePerGram || perGram)}
          className={side === 'sell' ? 'btn danger' : 'btn go'}
          style={{ width: 170, justifyContent: 'center' }}
          onDone={(o) => { if (o.ok) { setTrade({ ...trade, grams: 0, note: '' }); onDone(); } }}
          input={() => ({
            accountId: accountIdOrDefault, metal, grams: trade.grams,
            pricePerGram: quotedPrice, currency: trade.currency,
            makingPerGram: trade.makingPerGram || undefined,
            fee: trade.fee || undefined,
            date: logDate, note: trade.note || undefined,
            intention: trade.intention,
          })}>
          {side === 'buy' ? 'Record a buy' : 'Record a sell'}
        </ActionButton>
      </div>
    </div>
  );
}
