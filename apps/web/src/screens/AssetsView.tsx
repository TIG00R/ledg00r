import { useApp } from '../AppState';
import { Amount } from '../components/Amount';
import { Select } from '../components/Select';
import { DateField } from '../components/DateField';
import { ledger } from '../api';
import { Manager } from '../components/Manager';
import { ConfirmDelete } from '../components/Confirm';
import { installmentDueDate, daysUntil, nextInstallment, isPrincipal,
         toEgp } from '@ledger/engine';
import { useCallback, useEffect, useState } from 'react';
import { Page, Panel, Chip, Stat, Empty, Toggle, Field, AccountName } from '../components/UI';
import { Icon } from '../components/Icon';
import { Mark } from '../components/Mark';
import { ActionButton, useLive } from '../Live';
import { RecordTable } from '../components/RecordTable';
import { ModeProvider, useMode } from '../components/ModeBar';
import { SectionProvider, Sections, useSection } from '../components/Sections';
import { IntentionPicker, HawlBar } from '../components/Intention';
import { intentionsFor, type Intention } from '@ledger/engine';

/** A payment on a plan, as the ledger reports it. */
interface Installment {
  id: string; propertyId: string; property: string;
  dueOn: string; daysAway: number; amountEgp: number;
  note: string; kind: string; buysEquity: boolean;
  paidAt: string | null; autopayFrom: string | null;
  /** the movement that paid it — undoing that movement is what un-pays it */
  movementId?: string | null;
  /** the account it came out of, or the one it is set to come out of */
  payFrom: string | null; payFromName: string | null;
}

export function Assets() {
  return (
    <ModeProvider>
      <SectionProvider first="overview"><Body /></SectionProvider>
    </ModeProvider>
  );
}

function Body() {
  const { data, values: v, now, dm, autoPay, setAutoPay, balances, currencies, market } = useApp();
  const { mode } = useMode();
  const { tab } = useSection();
  const { run, live, version } = useLive();
  /** which institution a node sits at, for the second line under an account's name */
  const bankOf = (id?: string | null) =>
    data.institutions.find((i) => i.id === data.nodes.find((n) => n.id === id)?.parentId)?.name ?? null;

  // The arrangement lives in app state rather than this screen, because the reminders and
  // the flow chart both need to know which installments post themselves.
  const auto = Object.fromEntries(Object.entries(autoPay).map(([k, x]) => [k, x.on]));
  const setAuto = (patch: Record<string, boolean>) => {
    for (const [id, on] of Object.entries(patch)) {
      setAutoPay(id, { on });
      void run('autopay.configure', {
        propertyId: id, enabled: on,
        fromAccountId: autoPay[id]?.fromNodeId ?? data.settings.burnAccountId,
      });
    }
  };
  const payFrom = Object.fromEntries(Object.entries(autoPay).map(([k, x]) => [k, x.fromNodeId]));
  const setPayFrom = (patch: Record<string, string>) => {
    for (const [id, fromNodeId] of Object.entries(patch)) {
      setAutoPay(id, { fromNodeId });
      if (autoPay[id]?.on) void run('autopay.configure', { propertyId: id, enabled: true, fromAccountId: fromNodeId });
    }
  };
  /**
   * Everything owned that is not money.
   *
   * Read from the ledger so a car added today appears beside the flats, rather than the two
   * properties the opening snapshot happened to name.
   */
  const [assets, setAssets] = useState<any[] | null>(null);
  const loadAssets = useCallback(() => {
    if (!live) { setAssets(null); return; }
    (ledger as any)['assets.list']({}).then(setAssets).catch(() => setAssets(null));
  }, [live]);
  useEffect(loadAssets, [loadAssets, version]);

  /** the one currency list the whole ledger offers, so an asset picks from what accounts do */
  const currencyOptions = currencies.map((c) => ({
    value: c.code, label: `${c.symbol} ${c.code}`, hint: c.name,
  }));

  /**
   * One card's worth of an owned thing.
   *
   * The ledger's own list is the source when there is one, because it knows about the car
   * and the fixture's snapshot only knows about the two flats. A thing bought outright has
   * no contract and no plan, and reading it as though it had one is what used to take this
   * screen down: the snapshot had no total for a car, and a missing total reached the
   * formatter as undefined.
   *
   * The three figures on a card are one arithmetic, not three readings: the price is what
   * the plan's payments add up to, paid is the ones marked paid, and what is left is the
   * difference. They are all worked out from the same rows in `assets.list`, so paid and
   * outstanding always meet at the price and nothing here can drift from the plan.
   *
   * Equity — the asset's own balance — is a different quantity and is kept as `worth`. It
   * trails the paid figure by whatever bought no equity, upkeep and service charges, so
   * using it as the paid share of a contract would report a plan as behind when it is not.
   */
  const owned = assets
    ? assets.map((a) => {
        const price = a.planTotal || 0;
        const onPlan = price > 0;
        return {
          id: a.id, name: a.name, colour: a.color ?? 'var(--negative)',
          /* the plan is finished — the ledger settles this itself when the last payment is
             made, so the card can say so rather than working it out again from the figures */
          settled: a.ownership === 'owned' && onPlan,
          /* a mark, which is either an icon's name or `img:<id>` for a picture of your own —
             drawn with Mark rather than Icon, or an uploaded photograph silently falls back
             to the default building */
          icon: a.icon ?? (a.kind === 'vehicle' ? 'car' : 'building'),
          onPlan,
          /* what it cost: the contract when there is one, and what it is worth when it was
             bought outright and there is no plan to add up */
          price: onPlan ? price : a.value,
          paid: onPlan ? a.paid : 0,
          unpaid: onPlan ? Math.max(a.remaining, 0) : 0,
          worth: a.value,
          payments: a.payments,
        };
      })
    : Object.keys(data.snapshot.totalByProperty).map((id) => {
        const node = data.nodes.find((n) => n.id === id);
        const price = data.snapshot.totalByProperty[id] ?? 0;
        const paid = v.accrual.paidByProperty[id] ?? 0;
        return {
          id, name: node?.name ?? id, colour: node?.color ?? 'var(--negative)',
          settled: false,
          icon: 'building' as string,
          onPlan: price > 0, price, paid,
          unpaid: Math.max(price - paid, 0),
          worth: paid,
          payments: data.installments.filter((x) => x.propertyId === id).length,
        };
      });
  const props = owned.map((o) => o.id);
  const [planFor, setPlanFor] = useState<string | null>(null);
  const [upkeep, setUpkeep] = useState({
    propertyId: props[0] ?? '', accountId: data.settings.burnAccountId,
    amount: 0, date: new Date().toISOString().slice(0, 10), note: '',
  });

  /**
   * Every payment on every plan, paid and unpaid.
   *
   * It used to be the fixture's own list, filtered to what was still ahead and cut at eight
   * rows. That is why paying one changed nothing on the screen: the fixture does not know
   * what has been paid, so every row kept its Pay button and the payment that had just been
   * made was nowhere to be seen. The ledger knows both, and shows both.
   */
  const [schedule, setSchedule] = useState<Installment[] | null>(null);
  const loadSchedule = useCallback(() => {
    if (!live) { setSchedule(null); return; }
    (ledger as any)['installments.list']({}).then(setSchedule).catch(() => setSchedule(null));
  }, [live]);
  useEffect(loadSchedule, [loadSchedule, version]);

  const planRows: Installment[] = schedule ?? data.installments
    .map((i) => {
      const due = installmentDueDate(i.monthLabel, i.dueDayKind, i.dueDayNum);
      return due && {
        id: i.id, propertyId: i.propertyId,
        property: data.nodes.find((n) => n.id === i.propertyId)?.name ?? i.propertyId,
        dueOn: due.toISOString().slice(0, 10),
        daysAway: daysUntil(due, now),
        amountEgp: i.amountEgp, note: i.note, kind: 'installment',
        buysEquity: isPrincipal(i.note), paidAt: null, autopayFrom: null,
        payFrom: null, payFromName: null,
      };
    })
    .filter(Boolean) as Installment[];

  /**
   * The payment that falls next on a plan.
   *
   * Read off the ledger's schedule when there is one, because it is the only list that
   * records what has been paid. `nextInstallment` can only see dates, so it names the next
   * one on the calendar whether or not it has already been paid — and passes over one that
   * is overdue, which is exactly the payment that falls next.
   */
  const nextDue = (propertyId: string): { amountEgp: number; due: Date } | null => {
    if (schedule) {
      const row = schedule
        .filter((r) => r.propertyId === propertyId && !r.paidAt)
        .sort((a, b) => a.dueOn.localeCompare(b.dueOn))[0];
      return row ? { amountEgp: row.amountEgp, due: new Date(`${row.dueOn}T00:00:00`) } : null;
    }
    const i = nextInstallment(data.installments, now, propertyId);
    const due = i ? installmentDueDate(i.monthLabel, i.dueDayKind, i.dueDayNum) : null;
    return i && due ? { amountEgp: i.amountEgp, due } : null;
  };

  /**
   * The mark of whichever institution holds this account.
   *
   * The bank, never the account: an account picks up no mark of its own, and drawing the
   * generic one put the same red shape beside every bank in the ledger — which named none of
   * them. A bank with a logo wears it; one without wears its short code on its own colour,
   * the way the accounts screen writes it, so the tile is still the bank rather than a
   * stand-in for any account anywhere.
   */
  const InstitutionMark = ({ nodeId }: { nodeId?: string | null }) => {
    const inst = data.institutions.find(
      (i) => i.id === data.nodes.find((n) => n.id === nodeId)?.parentId);
    if (!inst) return null;
    const colour = inst.color ?? 'var(--muted)';
    return (
      <span aria-hidden style={{ width: 26, height: 20, flex: '0 0 26px', borderRadius: 6,
                                 overflow: 'hidden', background: inst.logo ? 'var(--surface)' : colour,
                                 color: '#fff', fontSize: 8, fontWeight: 700, letterSpacing: '.02em',
                                 display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {inst.logo ? <Mark mark={inst.logo} size={18} fallback="accounts" /> : inst.shortCode}
      </span>
    );
  };

  /**
   * A thing you own, named the way it is named everywhere else: its own mark, then its name
   * in ordinary type. Its mark and colour are the ones the cards above already carry.
   */
  const AssetName = ({ id, name }: { id: string; name: string }) => {
    const it = owned.find((o) => o.id === id);
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
        <Mark mark={it?.icon} size={15} color={it?.colour ?? 'var(--muted)'} fallback="building" />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
      </span>
    );
  };

  /**
   * No panel down the side.
   *
   * There was one for paying an installment, from before the schedule could do it. It named
   * one property in its own markup and duplicated a button that now sits on the row it
   * belongs to — and a payment is answered by the row that is due, not by a form beside it.
   */
  return (
    <Page>
      <Sections sections={[
        { id: 'overview', label: 'Assets', icon: 'assets',
          hint: 'Everything you own that is not money — a flat, a car, anything else.',
          editHint: 'Rename an asset, change its mark and colour, add one, archive one.' },
        { id: 'plans', label: 'Installment plans', icon: 'clock',
          hint: 'What each asset still owes, payment by payment.',
          editHint: 'Reshape a plan, add a payment, or record something spent on upkeep.' },
        { id: 'intent', label: 'Intention and zakat', icon: 'zakat',
          hint: 'Why each thing is held, since when, and what zakat therefore reaches.' },
      ]} />

      {tab === 'intent' && <Intentions assets={assets} onSaved={loadAssets} />}
      {tab === 'overview' && (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 20 }}>
        {owned.map((o) => {
          const { id, price, paid, unpaid, onPlan, colour, settled } = o;
          /**
           * A finished plan is a hundred per cent of itself.
           *
           * The share is the payments made against the payments the plan holds, which is the
           * same pair of numbers written under the ring — a ring that disagreed with the
           * figures beneath it would be worse than no ring. Once nothing is left to pay that
           * arithmetic is beside the point: it is paid off.
           */
          const pctPaid = settled ? 100
            : onPlan && price > 0 ? Math.min((paid / price) * 100, 100) : 100;
          const next = onPlan ? nextDue(id) : null;
          const due = next?.due ?? null;
          const r = 44, c = 2 * Math.PI * r;
          return (
            <section key={id} className="panel"
                     style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 18 }}>
              <div style={{ display: 'flex', gap: 22, alignItems: 'center' }}>
              <div style={{ position: 'relative', width: 104, height: 104, flex: '0 0 104px' }}>
                <svg width="104" height="104" viewBox="0 0 118 118" role="img"
                     aria-label={settled ? `${o.name}, fully owned`
                       : onPlan ? `${o.name} ${pctPaid.toFixed(1)} percent paid`
                       : `${o.name}, owned outright`}>
                  <circle cx="59" cy="59" r={r} fill="none" stroke="var(--hairline)" strokeWidth="10" />
                  <circle cx="59" cy="59" r={r} fill="none" strokeWidth="10" strokeLinecap="round"
                          stroke={settled ? 'var(--positive)' : colour}
                          strokeDasharray={`${(pctPaid / 100) * c} ${c}`} transform="rotate(-90 59 59)" />
                </svg>
                <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
                              alignItems: 'center', justifyContent: 'center' }}>
                  {/* A thing bought outright is not 100% of a contract — it simply has none,
                      so it shows what it is rather than a percentage that means nothing. */}
                  {settled ? (
                    <>
                      <span className="mono" style={{ fontSize: 20, fontWeight: 500, color: 'var(--positive)' }}>100%</span>
                      <span style={{ fontSize: 10, color: 'var(--positive)' }}>fully owned</span>
                    </>
                  ) : onPlan ? (
                    <>
                      <span className="mono" style={{ fontSize: 20, fontWeight: 500 }}>{pctPaid.toFixed(1)}%</span>
                      <span style={{ fontSize: 10, color: 'var(--faint)' }}>paid</span>
                    </>
                  ) : (
                    <Mark mark={o.icon} size={30} color={colour}
                          fallback={o.icon === 'car' ? 'car' : 'building'} />
                  )}
                </div>
              </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                    <Mark mark={o.icon} size={18} color={colour}
                          fallback={o.icon === 'car' ? 'car' : 'building'} />
                    <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>{o.name}</h2>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--faint)', marginTop: 4 }}>
                    {onPlan
                      ? `${o.payments} installments`
                      : 'Owned outright · no plan against it'}
                  </div>
                </div>
              </div>
              {/* The figures sit under the ring rather than beside the name, because they are
                  what the ring is: the same paid and outstanding, written out. One under the
                  other, in the order the arithmetic runs — the price, then what has gone
                  against it, then what is left — so millions never break between the currency
                  and the digits, and paid and remaining carry the colours they carry
                  everywhere else rather than being told apart by their labels alone. */}
              <div style={{ display: 'grid', gap: 12 }}>
                {onPlan ? (
                  <>
                    <Stat label="Total price" value={dm(price)} nowrap />
                    <Stat label="Paid" value={dm(paid)} color="var(--positive)" nowrap />
                    <Stat label="Remaining" value={dm(unpaid)} color="var(--negative)" nowrap />
                  </>
                ) : (
                  <Stat label="Worth" value={dm(o.worth)} nowrap />
                )}
              </div>
              {mode === 'edit' && onPlan && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <button className="btn ghost" style={{ alignSelf: 'flex-start' }}
                            onClick={() => setPlanFor(planFor === id ? null : id)}>
                      <Icon name="edit" size={14} />
                      {planFor === id ? 'Close the plan' : `Edit ${o.name}'s payment plan`}
                    </button>
                  </div>
                )}
                {/* Arranging for a plan to post itself is a setting, not an operation — it is
                    decided once, alongside renaming the thing and changing its mark. */}
                {mode === 'edit' && onPlan && (
                  <div style={{
                    padding: '12px 14px', borderRadius: 'var(--r-card)',
                    background: 'var(--raised)', border: '1px solid var(--hairline)',
                    display: 'flex', flexDirection: 'column', gap: 10,
                  }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 11, cursor: 'pointer' }}>
                      <Toggle on={auto[id] ?? false} onChange={(v) => setAuto({ ...auto, [id]: v })}
                              label={`Log ${o.name} installments automatically`} />
                      <span style={{ fontSize: 12, lineHeight: 1.4 }}>
                        Log each installment on its due date
                        <span style={{ display: 'block', fontSize: 11, color: 'var(--faint)' }}>
                          {auto[id] ? 'recorded for you, and flagged if the account is short' : 'you record each one by hand'}
                        </span>
                      </span>
                    </label>
                    {auto[id] && (
                      <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{ fontSize: 12, color: 'var(--muted)', flex: '0 0 auto' }}>out of</span>
                        <Select value={payFrom[id] ?? data.settings.burnAccountId}
                                onChange={(v) => setPayFrom({ ...payFrom, [id]: v })}
                                ariaLabel={`Account paying ${o.name}`} style={{ flex: 1 }}
                                options={data.nodes.filter((n) => n.kind === 'cash').map((n) => ({
                                  value: n.id,
                                  label: n.name,
                                  hint: data.institutions.find((x) => x.id === n.parentId)?.name,
                                }))} />
                      </label>
                    )}
                    {auto[id] && next && (() => {
                      // The promise made by the toggle: say so when the account cannot cover it.
                      // Both figures come off the same balance — the service's, when there is
                      // a service — because reading what is held from one source and what is
                      // short from another is how an account with a million in it was told it
                      // was fifty thousand short of its own next payment.
                      const acct = data.nodes.find((n) => n.id === (payFrom[id] ?? data.settings.burnAccountId));
                      if (!acct) return null;
                      // the installment is in pounds, so the balance is read in pounds too,
                      // rather than a dollar account's raw count being compared to one
                      const held = toEgp(balances[acct.id] ?? acct.openingQty, acct.currency ?? 'EGP', market);
                      // a credit line is meant to be short; only a cash account being short is news
                      const short = acct.kind === 'cash' ? Math.max(0, next.amountEgp - held) : 0;
                      return short > 0 ? (
                        <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start', fontSize: 11,
                                      lineHeight: 1.45, color: 'var(--negative)' }}>
                          <Icon name="warn" size={13} color="var(--negative)" motion="none" />
                          <span>{acct.name} holds {dm(held)} — {dm(short)} short of the next payment.</span>
                        </div>
                      ) : (
                        <div style={{ display: 'flex', gap: 9, alignItems: 'center', fontSize: 11,
                                      color: 'var(--faint)' }}>
                          <Icon name="check" size={13} color="var(--positive)" motion="none" />
                          <span>{acct.name} covers the next payment, with {dm(held - next.amountEgp)} left.</span>
                        </div>
                      );
                    })()}
                  </div>
                )}
                {next && due && (
                  <div style={{ padding: '12px 14px', borderRadius: 'var(--r-card)',
                                background: `color-mix(in srgb, ${colour} 8%, transparent)`,
                                border: `1px solid color-mix(in srgb, ${colour} 24%, transparent)` }}>
                    <div className="ov" style={{ color: colour }}>Next payment</div>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 4,
                                  flexWrap: 'wrap' }}>
                      <span className="mono" style={{ fontSize: 17, fontWeight: 500, color: colour,
                                                      whiteSpace: 'nowrap' }}>−{dm(next.amountEgp)}</span>
                      <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                        {due.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })}
                        {' · '}
                        {daysUntil(due, now) < 0 ? 'overdue' : `${daysUntil(due, now)}d`}
                      </span>
                    </div>
                  </div>
                )}
            </section>
          );
        })}
      </div>
      )}


      {tab === 'overview' && planFor && <PlanEditor propertyId={planFor} onClose={() => setPlanFor(null)} />}

      {tab === 'overview' && mode === 'edit' && (
        <Panel title="What you own"
               hint="A flat, a car, anything else. What differs between them is the mark and the words, not how they behave — each is either paid for outright or still on a plan.">
          <Manager
            markFamily="assets"
            addLabel="Add an asset"
            fields={[
              { key: 'name', label: 'Name', placeholder: 'Riverside Residences · unit 4' },
              { key: 'kind', label: 'What it is', kind: 'select', width: '150px',
                options: [
                  { value: 'property', label: 'Property' },
                  { value: 'vehicle', label: 'Vehicle' },
                  { value: 'equipment', label: 'Equipment' },
                  { value: 'other', label: 'Something else' },
                ] },
              { key: 'ownership', label: 'Paid for', kind: 'select', width: '170px',
                options: [
                  { value: 'owned', label: 'Outright', hint: 'worth what you paid' },
                  { value: 'installments', label: 'On a plan', hint: 'grows as you pay' },
                ] },
              { key: 'value', label: 'Worth', kind: 'number', width: '140px',
                hint: 'in the currency beside it',
                when: (v) => v.ownership !== 'installments' },
              /**
               * What the worth is stated in.
               *
               * A car bought in dollars is worth dollars, and typing the number without
               * saying so made it a pound figure — the ledger read twenty thousand dollars
               * as twenty thousand pounds. It sits beside the amount, and only where there
               * is an amount to state: a plan is paid in the ledger's own currency.
               *
               * Choosing it converts nothing. It says what the number already was, and the
               * number and the currency are both kept as they were entered — the conversion
               * happens when a total has to be drawn, and nowhere else.
               */
              { key: 'currency', label: 'Currency', kind: 'select', width: '120px',
                options: currencyOptions,
                when: (v) => v.ownership !== 'installments' },
              { key: 'colour', label: 'Colour', kind: 'colour', width: '64px' },
            ]}
            rows={(assets ?? []).map((a) => ({
              id: a.id, mark: a.icon ?? undefined, colour: a.color ?? '#8A8578',
              // The worth as it was entered, in its own currency — `value` is that same worth
              // converted for the totals, and showing it here read as a dollar car restated
              // in pounds the moment its currency was chosen. A service too old to say what
              // was entered falls back to the converted figure, which is what it used to
              // show: worse than the truth, better than an empty box.
              values: { name: a.name, kind: a.kind, ownership: a.ownership,
                        value: Math.round(a.amount ?? a.value), currency: a.currency ?? 'EGP',
                        colour: a.color ?? '#8A8578' },
              trailing: (
                <span style={{ fontSize: 11, color: 'var(--faint)', whiteSpace: 'nowrap' }}>
                  {a.payments ? `${a.payments} payment${a.payments === 1 ? '' : 's'}` : 'no plan'}
                </span>
              ),
            }))}
            onSave={(id, patch) => run('asset.update', {
              assetId: id,
              name: patch.name as string | undefined,
              kind: patch.kind as string | undefined,
              ownership: patch.ownership as string | undefined,
              // what it is worth, in its own currency — the field was drawn and read and
              // then dropped on the way out, so correcting a worth changed nothing at all
              value: patch.value === undefined ? undefined : Number(patch.value),
              currency: patch.currency as string | undefined,
              icon: patch.mark as string | undefined,
              color: patch.colour as string | undefined,
            }).then(loadAssets)}
            onAdd={(d) => run('asset.add', {
              name: d.name as string,
              kind: (d.kind as string) || 'other',
              ownership: (d.ownership as string) || 'owned',
              value: Number(d.value ?? 0),
              // the select shows the first currency until one is chosen, so an untouched
              // draft has to send what it showed rather than a guess of its own
              currency: (d.currency as string) || currencyOptions[0]?.value || 'EGP',
              icon: d.mark as string | undefined,
              color: (d.colour as string) || undefined,
            }).then(loadAssets)}
            onDelete={(id) => run('asset.remove', { assetId: id }).then(loadAssets)}
          />
        </Panel>
      )}

      {tab === 'plans' && mode === 'edit' && (
        <Panel title="Something spent on upkeep"
               hint="Maintenance, a service charge, a fee — money that leaves an account and buys no equity, which is the same distinction the plan already draws.">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 18 }}>
            <Field label="Which property">
              <Select ariaLabel="Property" value={upkeep.propertyId}
                      onChange={(v) => setUpkeep({ ...upkeep, propertyId: v })}
                      options={props.map((pid) => ({
                        value: pid, label: data.nodes.find((n) => n.id === pid)?.name ?? pid,
                      }))} />
            </Field>
            <Field label="Paid from">
              <Select ariaLabel="Paid from" value={upkeep.accountId}
                      onChange={(v) => setUpkeep({ ...upkeep, accountId: v })}
                      options={data.nodes.filter((n) => n.kind === 'cash').map((n) => ({
                        value: n.id, label: `${n.name} · ${n.currency}`,
                        hint: data.institutions.find((i) => i.id === n.parentId)?.name,
                      }))} />
            </Field>
            <Field label="Amount">
              <Amount value={upkeep.amount} ariaLabel="Amount" onChange={(n) => setUpkeep({ ...upkeep, amount: n })} />
            </Field>
            <Field label="Date">
              <DateField value={upkeep.date} onChange={(v) => setUpkeep({ ...upkeep, date: v })}
                         ariaLabel="Date it was spent" />
            </Field>
            <Field label="Note" hint="what it was for">
              <input aria-label="Upkeep note" placeholder="annual maintenance, a fine, a fitting"
                     value={upkeep.note} onChange={(e) => setUpkeep({ ...upkeep, note: e.target.value })} />
            </Field>
            <div style={{ display: 'flex', alignItems: 'flex-end' }}>
              <ActionButton capability="property.expense" disabled={!(upkeep.amount > 0)}
                onDone={(o) => { if (o.ok) setUpkeep({ ...upkeep, amount: 0, note: '' }); }}
                input={() => ({ propertyId: upkeep.propertyId, accountId: upkeep.accountId,
                                amount: upkeep.amount, date: upkeep.date,
                                note: upkeep.note || undefined })}>
                Record it
              </ActionButton>
            </div>
          </div>
        </Panel>
      )}

      {tab === 'plans' && (
      <Panel title="Every payment on every plan"
             hint="Paid and still to come, in one list — each heading filters its own column, so one property, or everything over a hundred thousand, or only what is still owed, is a choice rather than a search. A row that drains cash without buying equity says so.">
        <RecordTable<Installment>
          rows={planRows}
          rowKey={(r) => r.id}
          sort={{ key: 'dueOn', dir: 'asc' }}
          empty={{ icon: 'clock', title: 'No plans yet',
                   body: 'A property bought on installments carries its schedule here.' }}
          columns={[
            { key: 'dueOn', label: 'Due', kind: 'date',
              value: (r) => r.dueOn,
              /* how far off it is goes under the date, not after it: on one line the two
                 together outran the column and the days were cut off mid-number */
              cell: (r) => (
                <span style={{ display: 'block', minWidth: 0 }}>
                  <span className="mono" style={{ display: 'block' }}>
                    {new Date(`${r.dueOn}T12:00:00`).toLocaleDateString('en-US',
                      { day: 'numeric', month: 'short', year: 'numeric' })}
                  </span>
                  {!r.paidAt && (
                    <span className="mono" style={{ display: 'block', fontSize: 10, color: 'var(--faint)' }}>
                      {r.daysAway}d
                    </span>
                  )}
                </span>
              ),
              field: (d, set) => (
                <DateField value={d.dueOn ?? ''} ariaLabel="Due date"
                           onChange={(v) => set({ dueOn: v })} />
              ) },
            /**
             * Which property the payment belongs to.
             *
             * Its own mark and its own name, read as a name. It used to be a coloured tag,
             * which made a property look like a status — and the colour said nothing beyond
             * "this is the first one, that is the second".
             */
            { key: 'property', label: 'Property', kind: 'pick',
              value: (r) => r.property,
              cell: (r) => <AssetName id={r.propertyId} name={r.property} />,
              field: (d, set, row) => (row?.paidAt
                ? <AssetName id={row.propertyId} name={row.property} />
                : <Select ariaLabel="Property" value={d.propertyId ?? ''}
                          onChange={(v) => set({ propertyId: v })}
                          options={owned.filter((o) => o.onPlan)
                            .map((o) => ({ value: o.id, label: o.name }))} />) },
            /**
             * What the payment is for in money.
             *
             * Editable whether or not it has been paid. A paid row showed the figure as text,
             * which read as "this cannot be changed" — but the ledger corrects a made payment
             * perfectly well: it reverses the movement and writes it again as you meant it.
             * The row above already offered its date for editing, so refusing the amount was
             * not even a consistent refusal.
             */
            { key: 'amountEgp', label: 'Amount', kind: 'amount', align: 'right',
              value: (r) => r.amountEgp,
              cell: (r) => <span className="mono">{dm(r.amountEgp)}</span>,
              field: (d, set) => (
                <Amount value={d.amountEgp ?? 0} ariaLabel="Amount"
                        onChange={(n) => set({ amountEgp: n })} />) },
            /**
             * Which account it comes out of.
             *
             * For a payment already made this is a fact read back from the movement, and
             * changing it rewrites that movement. For one still owed it is an intention the
             * plan carries, and the Pay button uses it — so the account is chosen once, on
             * the row, rather than assumed at the moment of paying.
             */
            { key: 'payFrom', label: 'Paid from', kind: 'pick', width: '176px',
              value: (r) => r.payFromName ?? 'not set',
              cell: (r) => (r.payFromName
                ? <AccountName name={r.payFromName} bank={bankOf(r.payFrom)}
                               mark={<InstitutionMark nodeId={r.payFrom} />} />
                : <span style={{ color: 'var(--faint)' }}>not set</span>),
              field: (d, set) => (
                <Select ariaLabel="Account it comes out of" value={d.payFrom ?? ''}
                        onChange={(v) => set({ payFrom: v })}
                        options={[{ value: '', label: 'not set' },
                                  ...data.nodes.filter((n) => n.kind === 'cash').map((n) => ({
                                    value: n.id, label: n.name,
                                    hint: data.institutions.find((x) => x.id === n.parentId)?.name,
                                  }))]} />
              ) },
            /**
             * What the payment is for.
             *
             * The widest column and the last thing read before the state of the row, because
             * it is the only one holding a sentence: "quarterly instalment", "annual
             * maintenance". Squeezed between the property and the amount it was cut off
             * mid-word, so it sits here and wraps.
             */
            { key: 'note', label: 'What it is', kind: 'text',
              value: (r) => r.note || '—',
              cell: (r) => (
                <span className="rt-wrap-text" style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {r.note || '—'}
                  {!r.buysEquity && <span style={{ color: 'var(--gold)' }}> · buys no equity</span>}
                </span>
              ),
              field: (d, set) => (
                <textarea aria-label="What this payment is" rows={3}
                          placeholder="quarterly, annual balloon"
                          value={d.note ?? ''} onChange={(e) => set({ note: e.target.value })} />) },
            /**
             * Whether it has been paid — and the way to pay it.
             *
             * Paid is the state worth colouring; still owed is the ordinary condition of a
             * plan, so it says so plainly and the day a payment was made sits under the word.
             * Marking it paid here writes the movement, out of the account named in the row;
             * marking a paid one still owed undoes that movement. Neither is a flag being
             * flipped — there is money on both sides of it — which is why it can only be done
             * in Edit, and why the row says which account it will come out of.
             */
            { key: 'status', label: 'Status', kind: 'pick', width: '108px',
              value: (r) => (r.paidAt ? 'paid' : 'still owed'),
              cell: (r) => <PaymentStatus paidAt={r.paidAt} />,
              /* Offered while adding as well as while editing. A plan is usually written down
                 after part of it has been paid, and the row being added said "still owed"
                 whatever the truth was — so recording a payment made in March took adding it,
                 saving it, and then editing it to say what it already was.
                 Short labels on the picker: the column is headed Status, and the field has to
                 fit beside five others on one line. */
              field: (d, set) => (
                <Select ariaLabel="Paid or still owed" value={String(d.status ?? 'owed')}
                        onChange={(v) => set({ status: v })}
                        options={[{ value: 'owed', label: 'Owed', hint: 'not paid yet' },
                                  { value: 'paid', label: 'Paid', hint: 'writes the movement' }]} />) },
          ]}
          add={{
            label: 'Add a payment', capability: 'plan.upsert',
            blank: { propertyId: owned.find((o) => o.onPlan)?.id ?? '',
                     dueOn: new Date().toISOString().slice(0, 10), amountEgp: 0,
                     note: '', payFrom: '', status: 'owed' },
            // a payment said to be paid has money on the other side of it, so it has to say
            // which account that money left — the same thing paying one on the plan asks
            valid: (d) => !!d.propertyId && !!d.dueOn && Number(d.amountEgp) > 0
              && (d.status !== 'paid' || !!d.payFrom),
            build: (d) => ({ propertyId: d.propertyId, dueDate: d.dueOn,
                             amountEgp: Number(d.amountEgp), note: d.note || undefined,
                             payFrom: d.payFrom || undefined,
                             ...(d.status === 'paid'
                               ? { paidFrom: d.payFrom, paidOn: d.dueOn }
                               : {}) }),
            onDone: () => { loadSchedule(); loadAssets(); },
          }}
          /**
           * One pencil, four things it can mean.
           *
           * Reshaping what is still owed changes the plan. Correcting what was paid rewrites
           * the movement. Marking one paid writes that movement, and marking a paid one still
           * owed undoes it. Which of the four it is follows from the row and from what the
           * draft asks for, so the person editing states the outcome rather than choosing the
           * machinery.
           */
          edit={{
            capability: (r, d) => {
              const wantsPaid = d.status === 'paid';
              if (wantsPaid && !r.paidAt) return 'installment.pay';
              if (!wantsPaid && r.paidAt) return 'movement.undo';
              return r.paidAt ? 'installment.correct' : 'plan.upsert';
            },
            draftOf: (r) => ({ propertyId: r.propertyId, dueOn: r.dueOn,
                               amountEgp: r.amountEgp, note: r.note,
                               payFrom: r.payFrom ?? '',
                               status: r.paidAt ? 'paid' : 'owed' }),
            build: (d, r) => {
              const wantsPaid = d.status === 'paid';
              if (wantsPaid && !r.paidAt) {
                return { installmentId: r.id,
                         accountId: d.payFrom || r.payFrom || r.autopayFrom || undefined };
              }
              // a paid row with no movement behind it has nothing to undo; the ledger says so
              if (!wantsPaid && r.paidAt) return { movementId: r.movementId ?? '' };
              return r.paidAt
                ? { installmentId: r.id, accountId: d.payFrom || undefined, date: d.dueOn,
                    amountEgp: Number(d.amountEgp), note: d.note ?? '' }
                : { propertyId: r.propertyId, installmentId: r.id,
                    dueDate: d.dueOn, amountEgp: Number(d.amountEgp),
                    note: d.note ?? '', payFrom: d.payFrom || undefined };
            },

            onDone: () => { loadSchedule(); loadAssets(); },
          }}
          /*
            * A paid row comes off the same way an unpaid one does. The ledger reverses the
            * movement that paid it first, so the money returns to the account it left and the
            * plan and the accounts never disagree — there is nothing here for a person to do
            * in two steps and get half-way through.
            */
          remove={{
            capability: 'plan.remove',
            build: (r) => ({ installmentId: r.id }),
            what: (r) => `the payment due ${r.dueOn}`,
            onDone: () => { loadSchedule(); loadAssets(); },
          }}
        />
      </Panel>
      )}
    </Page>
  );
}

/**
 * Editing a payment plan.
 *
 * A plan is a list of dated amounts, and until one is paid it is only an intention — so it
 * can be changed, moved or removed. Once paid it is a movement, and the plan stops being the
 * place to change it: undoing that movement is, which is why a paid row here is read-only and
 * says so rather than silently refusing.
 */
function PlanEditor({ propertyId, onClose }: { propertyId: string; onClose: () => void }) {
  const { dm, data } = useApp();
  const { run, live, version } = useLive();
  const [plan, setPlan] = useState<any | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({
    dueDate: new Date().toISOString().slice(0, 10), amountEgp: 0,
    note: '', kind: 'installment', status: 'owed', payFrom: '',
  });
  const accounts = data.nodes.filter((n) => n.kind === 'cash')
    .map((n) => ({ value: n.id, label: n.name,
                   hint: data.institutions.find((x) => x.id === n.parentId)?.name }));

  const load = useCallback(() => {
    if (!live) { setPlan(null); return; }
    (ledger as any)['plan.read']({ propertyId }).then(setPlan).catch(() => setPlan(null));
  }, [live, propertyId]);
  useEffect(load, [load, version]);

  if (!live) {
    return (
      <Panel title="Payment plan">
        <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
          The plan lives in the ledger service, and there is none behind this screen yet.
        </p>
      </Panel>
    );
  }

  return (
    <Panel title={plan ? `${plan.property} — payment plan` : 'Payment plan'}
           hint="Everything still ahead is yours to reshape. A payment already made is a movement, and undoing that is what changes it."
           action={<button className="btn ghost" onClick={onClose}>Close</button>}>
      {plan && (
        <div style={{ display: 'flex', gap: 30, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
          <Stat label="Contract" value={dm(plan.total)} sub={`${plan.installments.length} payment${plan.installments.length === 1 ? '' : 's'}`} />
          <Stat label="Paid" value={dm(plan.paid)} color="var(--positive)" />
          <Stat label="Remaining" value={dm(plan.remaining)} color="var(--negative)" />
          {/* A plan with nothing left to pay is finished, and the thing is yours outright.
              The ledger settles that itself when the last payment is made; this is it said
              where the plan is read. */}
          {plan.installments.length > 0 && plan.installments.every((i: any) => i.paidAt) && (
            <Chip tone="good">fully paid off</Chip>
          )}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {plan?.installments.map((i: any) => (
          <PlanRow key={i.id} row={i}
                   onSave={(patch) => run(
                     // a payment already made is corrected through its movement; one still
                     // owed is only a line on a plan, and the plan is where it changes
                     i.paidAt ? 'installment.correct' : 'plan.upsert',
                     i.paidAt
                       ? { installmentId: i.id, date: patch.dueDate as string | undefined,
                           amountEgp: patch.amountEgp as number | undefined,
                           note: patch.note as string | undefined }
                       : { propertyId, installmentId: i.id, ...patch }).then(load)}
                   onRemove={() => run('plan.remove', { installmentId: i.id }).then(load)} />
        ))}
      </div>

      {adding ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                      gap: 18, alignItems: 'end', marginTop: 16, padding: '16px 18px',
                      borderRadius: 'var(--r-card)',
                      background: 'color-mix(in srgb, var(--positive) 5%, transparent)',
                      border: '1px dashed color-mix(in srgb, var(--positive) 36%, transparent)' }}>
          <Field label="Due">
            <DateField value={draft.dueDate} onChange={(v) => setDraft({ ...draft, dueDate: v })}
                       ariaLabel="New payment due" />
          </Field>
          <Field label="Amount">
            <Amount value={draft.amountEgp} ariaLabel="New payment amount" onChange={(n) => setDraft({ ...draft, amountEgp: n })} />
          </Field>
          <Field label="What it is">
            <Select ariaLabel="New payment kind" value={draft.kind}
                    onChange={(v) => setDraft({ ...draft, kind: v })}
                    options={[
                      { value: 'installment', label: 'Installment', hint: 'buys equity' },
                      { value: 'maintenance', label: 'Maintenance', hint: 'buys none' },
                      { value: 'fee', label: 'Fee', hint: 'buys none' },
                    ]} />
          </Field>
          <Field label="Note">
            <input aria-label="New payment note" placeholder="quarterly, annual balloon"
                   value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
          </Field>
          {/**
            * Whether it has been paid already.
            *
            * Most plans are written down after part of them has been paid, so a row being
            * added had to be saved as owed and then edited to say what it already was. Saying
            * it here writes the movement with the row — which is why the account it came out
            * of is asked for in the same breath: there is money on the other side of "paid".
            */}
          <Field label="Status">
            <Select ariaLabel="New payment paid or still owed" value={draft.status}
                    onChange={(v) => setDraft({ ...draft, status: v })}
                    options={[{ value: 'owed', label: 'Still owed', hint: 'not paid yet' },
                              { value: 'paid', label: 'Already paid', hint: 'writes the movement' }]} />
          </Field>
          <Field label={draft.status === 'paid' ? 'Paid from' : 'To be paid from'}>
            <Select ariaLabel="Account the payment comes out of" value={draft.payFrom}
                    onChange={(v) => setDraft({ ...draft, payFrom: v })}
                    options={[{ value: '', label: 'not set' }, ...accounts]} />
          </Field>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn add"
              disabled={!(draft.amountEgp > 0) || (draft.status === 'paid' && !draft.payFrom)}
              onClick={async () => {
                const { status, payFrom, ...rest } = draft;
                await run('plan.upsert', {
                  propertyId, ...rest,
                  payFrom: payFrom || undefined,
                  ...(status === 'paid' ? { paidFrom: payFrom, paidOn: draft.dueDate } : {}),
                });
                setDraft({ ...draft, amountEgp: 0, note: '' });
                setAdding(false);
                load();
              }}>Add it</button>
            <button className="btn ghost" onClick={() => setAdding(false)}>
              <Icon name="close" size={14} motion="none" /> Cancel
            </button>
          </div>
        </div>
      ) : (
        <button className="btn ghost" style={{ marginTop: 16 }} onClick={() => setAdding(true)}>
          <Icon name="plus" size={14} /> Add a payment
        </button>
      )}
    </Panel>
  );
}

/**
 * Whether a payment has been made.
 *
 * Green for paid, with the day under it in the quiet colour every secondary line uses. Still
 * owed carries no fill at all: it is what a plan mostly is, and colouring it made every row
 * look like it needed attention.
 */
function PaymentStatus({ paidAt }: { paidAt: string | null }) {
  if (!paidAt) {
    return (
      <span className="chip" style={{ background: 'transparent', color: 'var(--muted)',
                                      border: '1px solid var(--hairline-strong)' }}>
        still owed
      </span>
    );
  }
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, alignItems: 'flex-start' }}>
      <Chip tone="good">paid</Chip>
      <span className="mono" style={{ fontSize: 10, color: 'var(--faint)' }}>{paidAt}</span>
    </span>
  );
}

function PlanRow({ row, onSave, onRemove }: {
  row: any;
  onSave: (patch: Record<string, unknown>) => void;
  onRemove: () => void;
}) {
  const [edit, setEdit] = useState<Record<string, any>>({});
  const dirty = Object.keys(edit).length > 0;
  const paid = !!row.paidAt;

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '150px 140px minmax(0,1fr) 130px auto',
      gap: 14, alignItems: 'center', padding: '13px 15px', borderRadius: 'var(--r-card)',
      background: dirty ? 'color-mix(in srgb, var(--gold) 7%, var(--raised))' : 'var(--raised)',
      border: `1px solid ${dirty ? 'color-mix(in srgb, var(--gold) 32%, transparent)' : 'var(--hairline)'}`,
      opacity: paid ? 0.8 : 1,
    }}>
      {/* A paid row is a record rather than an intention, but it is still a record that can
          be wrong — so it is written in the same fields as the rest, and saving one corrects
          the movement behind it instead of the plan in front of it. */}
      <DateField value={edit.dueDate ?? row.dueDate ?? ''} ariaLabel={`Due date for ${row.monthLabel}`}
                 onChange={(v) => setEdit({ ...edit, dueDate: v })} />
      <Amount value={edit.amountEgp ?? row.amountEgp} ariaLabel={`Amount for ${row.monthLabel}`}
              onChange={(n) => setEdit({ ...edit, amountEgp: n })} />
      <input aria-label={`Note for ${row.monthLabel}`} placeholder="what this payment is"
             value={edit.note ?? row.note ?? ''}
             onChange={(e) => setEdit({ ...edit, note: e.target.value })} />
      {/* One tag, saying the one thing a row on a plan is: paid, or not yet. Whether a payment
          buys equity is what the payment is for, and it is written in that column. */}
      <span><PaymentStatus paidAt={row.paidAt ?? null} /></span>
      <span style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        {dirty && (
          <>
            <button className="btn go sm" onClick={() => { onSave(edit); setEdit({}); }}>
              <Icon name="check" size={13} motion="none" /> Save
            </button>
            <button className="btn ghost sm" onClick={() => setEdit({})}>
              <Icon name="close" size={13} motion="none" /> Cancel
            </button>
          </>
        )}
        {!dirty && (
          <ConfirmDelete what={`the payment due ${row.dueDate}`} size={14}
            onConfirm={onRemove} />
        )}
      </span>
    </div>
  );
}

/**
 * Why each thing is held, and what follows from it.
 *
 * The four tests zakat applies to a thing — what it is, what it is held for, whether the
 * amount reached nisab, and whether a lunar year has run since it did — are all decided here,
 * so this is where all four are shown. The answer to the second is chosen; the other three are
 * read off the dates, which is why the dates are editable beside it rather than buried.
 */
function Intentions({ assets, onSaved }: { assets: any[] | null; onSaved: () => void }) {
  const { run, live, version } = useLive();
  const { dm } = useApp();
  const [lines, setLines] = useState<any[] | null>(null);

  useEffect(() => {
    if (!live) { setLines(null); return; }
    let off = false;
    (ledger as any)['zakat.assessment']({})
      .then((a: any) => { if (!off) setLines(a?.assets ?? []); })
      .catch(() => { if (!off) setLines(null); });
    return () => { off = true; };
  }, [live, version]);

  if (!live) {
    return (
      <Panel title="Intention and zakat">
        <Empty icon="zakat" title="The ledger is not running"
               body="Intention is stored with the asset, so this needs the ledger service rather than the fixtures the screens fall back on." />
      </Panel>
    );
  }

  const rows = assets ?? [];
  if (!rows.length) {
    return (
      <Panel title="Intention and zakat">
        <Empty icon="assets" title="Nothing owned yet"
               body="Add a property or a vehicle under Assets and its intention will be asked for here." />
      </Panel>
    );
  }

  return (
    <>
      <Panel title="What zakat reaches, and what it does not"
             hint="Four things decide it, in this order: what the thing is, what it is held for, whether the amount ever reached nisab, and whether a full lunar year has run since it did. A thing that fails any one of them owes nothing — and says which one.">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {rows.map((a) => {
            const line = lines?.find((l) => l.id === a.id);
            const kind = a.kind === 'property' ? 'property' : a.kind === 'vehicle' ? 'vehicle' : 'other';
            const known = intentionsFor(kind).some((o) => o.id === a.intention);
            return (
              <section key={a.id} className="panel" style={{ padding: 20 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
                  <Mark mark={a.icon ?? (a.kind === 'vehicle' ? 'car' : 'building')}
                        size={18} color={a.color ?? 'var(--zakat)'}
                        fallback={a.kind === 'vehicle' ? 'car' : 'building'} />
                  <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{a.name}</h3>
                  <Chip>{a.kind}</Chip>
                  <span className="mono" style={{ marginLeft: 'auto', fontSize: 14 }}>{dm(a.value)}</span>
                </div>

                <IntentionPicker kind={kind} value={known ? (a.intention as Intention) : null}
                  onChange={(v) => run('asset.update', { assetId: a.id, intention: v }).then(onSaved)} />

                <div style={{ display: 'grid', gap: 16, marginTop: 18,
                              gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}>
                  <Field label="Acquired" hint="the day it became yours">
                    <DateField value={a.acquiredOn ?? ''} ariaLabel={`${a.name} acquired on`}
                               onChange={(v) => run('asset.update', { assetId: a.id, acquiredOn: v }).then(onSaved)} />
                  </Field>
                  <Field label="Held this way since" hint="a change of mind starts a new lunar year">
                    <DateField value={a.intentionSince ?? ''} ariaLabel={`${a.name} intention since`}
                               onChange={(v) => run('asset.update', { assetId: a.id, intentionSince: v }).then(onSaved)} />
                  </Field>
                  <Field label="Passed nisab on" hint="leave empty and the intention's own date is used">
                    <DateField value={a.nisabMetOn ?? ''} ariaLabel={`${a.name} passed nisab on`}
                               onChange={(v) => run('asset.update', { assetId: a.id, nisabMetOn: v }).then(onSaved)} />
                  </Field>
                </div>

                <div style={{ marginTop: 18, padding: '14px 16px', borderRadius: 'var(--r-card)',
                              background: 'var(--raised)', border: '1px solid var(--hairline)' }}>
                  <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center',
                                marginBottom: line?.hawl ? 12 : 0 }}>
                    <Chip tone={line?.included ? 'good' : undefined}>
                      {line?.included ? `counts ${dm(line.counted)}` : 'counts nothing'}
                    </Chip>
                    <span style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, flex: 1, minWidth: 220 }}>
                      {line?.reason ?? 'Working it out needs the zakat assessment, which has not answered yet.'}
                    </span>
                  </div>
                  {line?.hawl && <HawlBar hawl={line.hawl} tone={a.color ?? 'var(--zakat)'} />}
                </div>
              </section>
            );
          })}
        </div>
      </Panel>

      <Panel title="Rent, and how it is counted"
             hint="A let thing is outside zakat itself, so what is owed turns on what it earns. Link the income source to the asset in Income, and every payment recorded against it counts toward that asset's own nisab and its own lunar year.">
        <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6,
                      display: 'flex', flexDirection: 'column', gap: 9 }}>
          <div>Rent that has not yet carried a full lunar year is taken back out of the cash figure,
            so the base cannot charge on it a year early through the account it landed in.</div>
          <div>Once a lunar year closes on rent that passed nisab, that year's rent is what counts —
            and the year after starts from the anniversary.</div>
        </div>
      </Panel>
    </>
  );
}
