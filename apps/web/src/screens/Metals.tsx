import { useCallback, useEffect, useState } from 'react';
import { Amount } from '../components/Amount';
import { useApp, market as staticMarket } from '../AppState';
import { money, fmt } from '@ledger/engine';
import { Page, Panel, Stat, Stats, Chip, Field } from '../components/UI';
import { Select } from '../components/Select';
import { DateField } from '../components/DateField';
import { Segmented } from '../components/Segmented';
import { Icon } from '../components/Icon';
import { RecordTable } from '../components/RecordTable';
import { HawlBar } from '../components/Intention';
import { ModeProvider } from '../components/ModeBar';
import { SectionProvider, Sections, useSection } from '../components/Sections';
import { ActionButton, useLive } from '../Live';
import { ledger } from '../api';

type Metal = 'gold' | 'silver';

interface Lot {
  id: string; date: string; dateText: string; metal: Metal;
  direction: 'buy' | 'sell'; grams: number; pricePerGram: number;
  totalEgp: number; note: string | null; movementId: string | null;
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
    <ModeProvider>
      <SectionProvider first="metals"><Body /></SectionProvider>
    </ModeProvider>
  );
}

function Body() {
  const { dm, balances, data, dm: _dm } = useApp();
  const { tab } = useSection();
  const { run, live, version } = useLive();

  const [metal, setMetal] = useState<Metal>('gold');
  const [lots, setLots] = useState<Lot[] | null>(null);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [trade, setTrade] = useState({
    accountId: data.settings.burnAccountId, grams: 0, pricePerGram: 0, note: '',
    intention: 'investment' as 'personal' | 'investment',
  });
  const [logDate, setLogDate] = useState(new Date().toISOString().slice(0, 10));

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
  const paid = bought.reduce((s, l) => s + l.totalEgp, 0);
  const boughtG = bought.reduce((s, l) => s + l.grams, 0);
  const avgCost = boughtG ? paid / boughtG : 0;
  const worth = held * perGram;


  const tone = metal === 'gold' ? 'var(--gold)' : '#9AA3AD';
  const accounts = data.nodes.filter((n) => n.kind === 'cash');
  const short = side === 'sell' && trade.grams > held;

  return (
    <Page>
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
        // Holdings is a reading of the records, not a thing to correct, so it carries no
        // Edit switch — what would be corrected is on the Records tab beside it.
        { id: 'metals', label: 'Holdings', icon: 'gold',
          hint: 'What you hold and what it is worth at the price recorded for it.' },
        { id: 'records', label: 'Records', icon: 'ledger',
          hint: 'Every purchase and sale, with the reason it was made.',
          editHint: 'Correct a purchase or a sale, or take one off the ledger.' },
      ]} />

      {tab === 'metals' && (
      <Panel>
        <Stats>
          <Stat label={`${metal === 'gold' ? 'Gold' : 'Silver'} held`} value={`${held.toFixed(1)} g`}
                sub={`${(held / 31.1035).toFixed(2)} troy oz`} />
          <Stat label="Worth now" value={dm(worth)}
                sub={perGram ? `at ${fmt(perGram)} a gram` : 'no price recorded'} />
          <Stat label="Average cost" value={avgCost ? money(avgCost, 'EGP') : '—'}
                sub={boughtG ? `over ${boughtG.toFixed(1)} g bought` : 'nothing bought yet'} />
          <Stat label="Against cost" value={avgCost ? dm(worth - held * avgCost) : '—'}
                color={worth >= held * avgCost ? 'var(--positive)' : 'var(--negative)'}
                sub={avgCost ? `${(((perGram - avgCost) / avgCost) * 100).toFixed(1)}% a gram` : ''} />
          {/* Two weights, because only one of them is reached by zakat. */}
          <Stat label="Held as a holding" value={`${holdingG.toFixed(1)} g`}
                sub={holdingG ? 'the weight zakat can reach' : 'nothing held as a holding'} />
          <Stat label="Worn" value={`${wornG.toFixed(1)} g`}
                sub={wornG ? 'jewellery in use — outside zakat' : 'none recorded as worn'} />
        </Stats>
      </Panel>
      )}

      {/* Holdings offers no Edit switch of its own, so the form that records a movement
          must not vanish because some other screen was left in editing. */}
      {tab === 'metals' && (
        <Panel title="Record a movement"
               hint="Metal is paid for out of a named account, and selling puts the money back into one. Net worth does not change — value moves between two things you own.">
          <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
            <Segmented<'buy' | 'sell'> value={side} onChange={setSide} ariaLabel="Buying or selling"
              options={[
                { id: 'buy', label: 'Buying', icon: 'in', tone: 'var(--positive)' },
                { id: 'sell', label: 'Selling', icon: 'out', tone: 'var(--negative)' },
              ]} />
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>
              {side === 'buy' ? `${metal} in, money out` : `${metal} out, money in`}
            </span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 18 }}>
            <Field label="Date"><DateField value={logDate} onChange={setLogDate} ariaLabel="Date of the movement" /></Field>
            <Field label="Grams" hint={side === 'sell' ? `${held.toFixed(1)} g held` : undefined}>
              <Amount value={trade.grams} ariaLabel="Grams" onChange={(n) => setTrade({ ...trade, grams: n })} />
            </Field>
            <Field label="Price per gram" hint={`in force: ${perGram ? fmt(perGram) : 'none'}`}>
              <Amount value={trade.pricePerGram} ariaLabel="Price per gram" onChange={(n) => setTrade({ ...trade, pricePerGram: n })} placeholder={String(perGram || 0)} />
            </Field>
            <Field label="Total" hint="computed from the two above">
              <input className="mono" readOnly aria-label="Total"
                     value={fmt(trade.grams * (trade.pricePerGram || perGram))} />
            </Field>
            <Field label={side === 'buy' ? 'Paid from' : 'Proceeds into'}>
              <Select ariaLabel="Account" value={trade.accountId}
                      onChange={(v) => setTrade({ ...trade, accountId: v })}
                      options={accounts.map((n) => ({
                        value: n.id, label: `${n.name} · ${n.currency}`,
                        hint: data.institutions.find((i) => i.id === n.parentId)?.name,
                      }))} />
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
          </div>

          {short && (
            <p style={{ margin: '16px 0 0', fontSize: 12, color: 'var(--negative)' }}>
              You hold {held.toFixed(1)} g, which is {(trade.grams - held).toFixed(1)} g short.
            </p>
          )}


          <div style={{ marginTop: 16 }}>
            {/* One width, whichever way the movement goes: a button that grows with the
                number typed beside it moves under the cursor while it is being aimed at. */}
            <ActionButton capability={side === 'buy' ? 'metal.buy' : 'metal.sell'}
              disabled={!(trade.grams > 0) || short || !(trade.pricePerGram || perGram)}
              className={side === 'sell' ? 'btn danger' : 'btn go'}
              style={{ width: 170, justifyContent: 'center' }}
              onDone={(o) => { if (o.ok) { setTrade({ ...trade, grams: 0, note: '' }); load(); } }}
              input={() => ({
                accountId: trade.accountId, metal, grams: trade.grams,
                pricePerGram: trade.pricePerGram || perGram,
                date: logDate, note: trade.note || undefined,
                intention: trade.intention,
              })}>
              {side === 'buy' ? 'Record a buy' : 'Record a sell'}
            </ActionButton>
          </div>
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
            { key: 'grams', label: 'Grams', kind: 'amount', align: 'right', width: '112px',
              value: (l) => l.grams,
              cell: (l) => <span className="mono" style={{ color: tone }}>
                {l.direction === 'sell' ? '−' : '+'}{l.grams}</span>,
              field: (d, set) => <Amount value={d.grams ?? 0} ariaLabel="Grams"
                                         onChange={(n) => set({ grams: n })} /> },
            { key: 'price', label: 'Price / g', kind: 'amount', align: 'right', width: '118px',
              value: (l) => l.pricePerGram,
              cell: (l) => <span className="mono">{fmt(l.pricePerGram)}</span>,
              field: (d, set) => <Amount value={d.pricePerGram ?? 0} ariaLabel="Price a gram"
                                         onChange={(n) => set({ pricePerGram: n })} /> },
            { key: 'total', label: 'Total', kind: 'amount', align: 'right', width: '136px',
              value: (l) => l.totalEgp,
              // What it came to follows from the grams and the price; it is not typed in.
              cell: (l) => <span className="mono">{dm(l.totalEgp)}</span>,
              field: (d) => (
                <span className="mono" style={{ color: 'var(--faint)' }}>
                  {dm((Number(d.grams) || 0) * (Number(d.pricePerGram) || 0))}
                </span>
              ) },
            { key: 'account', label: 'Paid from', kind: 'pick', width: '148px',
              value: (l) => accountName(l.accountId),
              cell: (l) => <span style={{ fontSize: 12, color: 'var(--muted)' }}>{accountName(l.accountId)}</span>,
              // A lot from before the ledger names no account, and the picker must say so
              // rather than showing the first one in the list as though it had been chosen.
              field: (d, set) => (
                <Select ariaLabel="Account" value={d.accountId ?? ''}
                        onChange={(v) => set({ accountId: v })}
                        options={[{ value: '', label: '— none recorded' },
                                  ...data.nodes.filter((n) => n.kind === 'cash').map((n) => ({
                                    value: n.id, label: n.name,
                                    hint: data.institutions.find((i) => i.id === n.parentId)?.name }))]} />
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
                     grams: 0, pricePerGram: 0, accountId: data.settings.burnAccountId,
                     intention: 'investment', note: '' },
            valid: (d) => Number(d.grams) > 0 && !!d.accountId,
            build: (d) => ({ metal, accountId: d.accountId, grams: Number(d.grams),
                             pricePerGram: Number(d.pricePerGram) || undefined,
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
                               pricePerGram: l.pricePerGram, accountId: l.accountId ?? '',
                               intention: l.intention ?? 'investment', note: l.note ?? '' }),
            build: (d, l) => ({ lotId: l.id, grams: Number(d.grams),
                                pricePerGram: Number(d.pricePerGram),
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
        />
      </Panel>
      )}
    </Page>
  );
}
