import { useApp } from '../AppState';
import { Amount } from '../components/Amount';
import { Select } from '../components/Select';
import { DateField } from '../components/DateField';
import { ledger } from '../api';
import { Manager } from '../components/Manager';
import { installmentDueDate, daysUntil, nextInstallment, isPrincipal,
         toEgp } from '@ledger/engine';
import { useCallback, useEffect, useState } from 'react';
import { Page, Panel, Chip, Stat, Empty, Toggle, Field, AccountName } from '../components/UI';
import { Icon } from '../components/Icon';
import { Mark } from '../components/Mark';
import { ActionButton, useLive } from '../Live';
import { RecordTable, isInteractive } from '../components/RecordTable';
import { SectionProvider, Sections, useSection } from '../components/Sections';
import { IntentionPicker, HawlBar } from '../components/Intention';
import { intentionsFor, type Intention } from '@ledger/engine';
import { sourceAccountOptions, INITIAL_PAYMENT } from '../components/Operations';
import { useModules } from '../Modules';

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
    <SectionProvider first="overview"><Body /></SectionProvider>
  );
}

function Body() {
  const { data, values: v, now, dm, autoPay, setAutoPay, balances, currencies, market } = useApp();
  const { tab } = useSection();
  const { run, live, version } = useLive();
  const { enabled } = useModules();
  /** whether the zakat module is on — the one check every intention control on this screen answers to */
  const zakatOn = enabled.giving !== false;
  /** which institution a node sits at, for the second line under an account's name */
  const bankOf = (id?: string | null) =>
    data.institutions.find((i) => i.id === data.nodes.find((n) => n.id === id)?.parentId)?.name ?? null;

  // The arrangement lives in app state rather than this screen, because the reminders and
  // the flow chart both need to know which installments post themselves.
  const auto = Object.fromEntries(Object.entries(autoPay).map(([k, x]) => [k, x.on]));
  const setAuto = (patch: Record<string, boolean>) => {
    for (const [id, on] of Object.entries(patch)) {
      setAutoPay(id, { on });
      // An empty account is not an account. `??` kept a blank string, which the ledger
      // rejects as a malformed id — so the field is left out instead, and the capability
      // falls back to the account already arranged for this property, or says it needs one.
      const from = autoPay[id]?.fromNodeId || data.settings.burnAccountId || undefined;
      void run('autopay.configure', { propertyId: id, enabled: on, ...(from ? { fromAccountId: from } : {}) });
    }
  };
  const payFrom = Object.fromEntries(Object.entries(autoPay).map(([k, x]) => [k, x.fromNodeId]));
  const setPayFrom = (patch: Record<string, string>) => {
    for (const [id, fromNodeId] of Object.entries(patch)) {
      setAutoPay(id, { fromNodeId });
      if (autoPay[id]?.on && fromNodeId) void run('autopay.configure', { propertyId: id, enabled: true, fromAccountId: fromNodeId });
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
  const [upkeep, setUpkeep] = useState({
    propertyId: props[0] ?? '', accountId: data.settings.burnAccountId,
    amount: 0, date: new Date().toISOString().slice(0, 10), note: '',
  });

  /**
   * Which asset's own settings are open — its intention, its zakat dates, whether it logs its
   * own installments. Only one at a time, the same rule every per-row editor in this
   * application keeps: two half-finished corrections have no way to say which Save belongs to
   * which.
   */
  const [openAssetId, setOpenAssetId] = useState<string | null>(null);
  /** which card the pointer is over, so its edit pencil is offered without crowding every
   *  card at once — a keyboard reaches the same editor without ever touching this. */
  const [hoverAssetId, setHoverAssetId] = useState<string | null>(null);

  /**
   * The four tests zakat applies to each thing — what it is, what it is held for, whether the
   * amount reached nisab, and whether a lunar year has run since — read once here rather than
   * once per card, so opening a second card's settings does not ask the ledger the same
   * question again.
   */
  const [zakatLines, setZakatLines] = useState<any[] | null>(null);
  useEffect(() => {
    if (!live || !zakatOn) { setZakatLines(null); return; }
    const call = (ledger as any)['zakat.assessment'];
    if (typeof call !== 'function') { setZakatLines(null); return; }
    let off = false;
    call({})
      .then((a: any) => { if (!off) setZakatLines(a?.assets ?? []); })
      .catch(() => { if (!off) setZakatLines(null); });
    return () => { off = true; };
  }, [live, zakatOn, version]);

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
          hint: 'Everything you own that is not money — a flat, a car, anything else. Double-click one below, press Enter on it, or use its pencil, to edit its mark, its plan, or why it is held.' },
        { id: 'plans', label: 'Installment plans', icon: 'clock',
          hint: 'What each asset still owes, payment by payment. Double-click a payment to reshape it.' },
      ]} />

      {/* A card is as wide as the ring plus what stands beside it — 276 of circle, its own
          padding, and room for a name that is not a word. Below that the two stack, which is
          what the card does on a phone anyway. */}
      {tab === 'overview' && (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(480px, 1fr))', gap: 20 }}>
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
          const r = 118, c = 2 * Math.PI * r;
          const openThis = openAssetId === id;
          /* the raw ledger record behind this card — it alone carries the intention and the
             zakat dates; `o` above is the arithmetic worked out from it plus the plan */
          const asset = assets?.find((a) => a.id === id) ?? null;
          const zakatKind = asset?.kind === 'property' ? 'property' : asset?.kind === 'vehicle' ? 'vehicle' : 'other';
          const knownIntention = intentionsFor(zakatKind).some((opt) => opt.id === asset?.intention);
          const zakatLine = zakatLines?.find((l) => l.id === id) ?? null;
          const startEditing = () => setOpenAssetId(id);
          const stopEditing = () => setOpenAssetId(null);
          return (
            <section key={id} className="panel"
                     style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 18, position: 'relative' }}
                     onMouseEnter={() => setHoverAssetId(id)}
                     onMouseLeave={() => setHoverAssetId((h) => (h === id ? null : h))}
                     tabIndex={openThis ? undefined : 0}
                     aria-label={openThis ? undefined : `Double-click, or press Enter, to edit ${o.name}'s settings`}
                     onDoubleClick={openThis ? undefined : (e) => { if (!isInteractive(e.target)) startEditing(); }}
                     onKeyDown={openThis ? undefined : (e) => {
                       if (e.key !== 'Enter' || isInteractive(e.target)) return;
                       e.preventDefault();
                       startEditing();
                     }}>
              {/* The pencil is a mouse affordance, offered on hover so a screenful of cards is
                  not a screenful of pencils — but the card itself is focusable and answers
                  Enter, which is how a keyboard reaches the same editor without ever hovering
                  anything. */}
              {openThis ? (
                <button className="btn ghost sm" onClick={stopEditing}
                        style={{ position: 'absolute', top: 18, right: 18 }}>
                  <Icon name="close" size={13} motion="none" /> Close
                </button>
              ) : (
                <button className="btn quiet" onClick={startEditing} aria-label={`Edit ${o.name}'s settings`}
                        title="Edit" style={{
                          position: 'absolute', top: 14, right: 14, padding: 7, border: 'none',
                          opacity: hoverAssetId === id ? 1 : 0, transition: 'opacity 120ms var(--ease)',
                        }}>
                  <Icon name="edit" size={14} />
                </button>
              )}
              <div style={{ display: 'flex', gap: 22, alignItems: 'center', flexWrap: 'wrap' }}>
              {/* The ring is where the card's own arithmetic lives — the percentage, and what
                  it is made of, drawn where the eye already goes rather than read a second
                  time underneath. It is sized for the figures rather than for the circle: a
                  property costs millions, those numbers are set in a monospace face, and two
                  of them side by side need the room. The hole inside it, not the ring, is
                  what had to be big. */}
              <div style={{ position: 'relative', width: 276, height: 276, flex: '0 0 276px' }}>
                <svg width="276" height="276" viewBox="0 0 276 276" role="img"
                     aria-label={settled ? `${o.name}, fully owned`
                       : onPlan ? `${o.name} ${pctPaid.toFixed(1)} percent paid`
                       : `${o.name}, owned outright`}>
                  <circle cx="138" cy="138" r={r} fill="none" stroke="var(--hairline)" strokeWidth="13" />
                  <circle cx="138" cy="138" r={r} fill="none" strokeWidth="13" strokeLinecap="round"
                          stroke={settled ? 'var(--positive)' : colour}
                          strokeDasharray={`${(pctPaid / 100) * c} ${c}`} transform="rotate(-90 138 138)" />
                </svg>
                <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
                              alignItems: 'center', justifyContent: 'center', gap: 2, padding: '0 26px' }}>
                  {/* A thing bought outright is not 100% of a contract — it simply has none,
                      so it shows what it is rather than a percentage that means nothing. */}
                  {settled ? (
                    <>
                      <span className="mono" style={{ fontSize: 30, fontWeight: 600, color: 'var(--positive)' }}>100%</span>
                      <span style={{ fontSize: 11, color: 'var(--positive)' }}>fully owned</span>
                      <div style={{ textAlign: 'center', marginTop: 10 }}>
                        <div className="ov" style={{ fontSize: 10 }}>Paid</div>
                        <div className="mono" style={{ fontSize: 17, fontWeight: 500, color: 'var(--positive)' }}>{dm(paid)}</div>
                      </div>
                    </>
                  ) : onPlan ? (
                    <>
                      <span className="mono" style={{ fontSize: 30, fontWeight: 600 }}>{pctPaid.toFixed(1)}%</span>
                      <span style={{ fontSize: 11, color: 'var(--faint)' }}>paid</span>
                      {/* Paid and remaining are the two halves the percentage is made of, so
                          they sit inside it too — the price they add up to stays underneath,
                          it is the one figure that is context rather than progress. One above
                          the other rather than side by side: two seven-figure sums in a row
                          are what used to run out of the circle, and stacking them gives each
                          the full width of the hole. */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 10, alignItems: 'center' }}>
                        <div style={{ textAlign: 'center' }}>
                          <div className="ov" style={{ fontSize: 9 }}>Paid</div>
                          <div className="mono" style={{ fontSize: 15, fontWeight: 500, color: 'var(--positive)', whiteSpace: 'nowrap' }}>{dm(paid)}</div>
                        </div>
                        <div style={{ textAlign: 'center' }}>
                          <div className="ov" style={{ fontSize: 9 }}>Remaining</div>
                          <div className="mono" style={{ fontSize: 15, fontWeight: 500, color: 'var(--negative)', whiteSpace: 'nowrap' }}>{dm(unpaid)}</div>
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      <Mark mark={o.icon} size={32} color={colour}
                            fallback={o.icon === 'car' ? 'car' : 'building'} />
                      <div style={{ textAlign: 'center', marginTop: 10 }}>
                        <div className="ov" style={{ fontSize: 10 }}>Worth</div>
                        <div className="mono" style={{ fontSize: 20, fontWeight: 500 }}>{dm(o.worth)}</div>
                      </div>
                      <span style={{ fontSize: 11, color: 'var(--faint)' }}>owned outright</span>
                    </>
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
              {/* Only the contract total stays beneath the ring — it is the reference figure
                  the ring's own paid-and-remaining add up to, not a third reading of the same
                  progress. */}
              {onPlan && (
                <div style={{ display: 'grid', gap: 12 }}>
                  <Stat label="Total price" value={dm(price)} nowrap />
                </div>
              )}
              {/* What this is held for is read here whether the card is open or not — it was
                  otherwise a fact nobody saw unless they had already opened the card to change
                  something else. The picker itself is read-only until its own pencil is
                  pressed, so showing it here adds nothing to press through by accident. */}
              {zakatOn && live && asset && (
                <div style={{ paddingTop: 14, borderTop: '1px solid var(--hairline)' }}>
                  <IntentionPicker kind={zakatKind}
                    value={knownIntention ? (asset.intention as Intention) : null}
                    onChange={(val) => run('asset.update', { assetId: id, intention: val }).then(loadAssets)} />
                </div>
              )}
                {/* Arranging for a plan to post itself is a setting, not an operation, and it
                    sits with the rest of this asset's settings now — opened the same way they
                    are, rather than sitting permanently on a card that has not been asked to
                    show it. */}
                {onPlan && openThis && (
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
                {/* What zakat makes of the intention above — the dates a lunar year is
                    measured from, and what the assessment makes of them. Gone the moment the
                    zakat module itself is off, not merely hidden: `zakatOn` is the one check
                    every intention control in this application answers to. */}
                {openThis && zakatOn && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 14,
                                paddingTop: 14, borderTop: '1px solid var(--hairline)' }}>
                    {!live || !asset ? (
                      <Empty icon="zakat" title="The ledger is not running"
                             body="Intention and zakat are stored with the asset, so this needs the ledger service rather than the fixtures the screens fall back on." />
                    ) : (
                      <>
                        <div style={{ display: 'grid', gap: 16,
                                      gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}>
                          <Field label="Acquired" hint="the day it became yours">
                            <DateField value={asset.acquiredOn ?? ''} ariaLabel={`${o.name} acquired on`}
                                       onChange={(val) => run('asset.update', { assetId: id, acquiredOn: val }).then(loadAssets)} />
                          </Field>
                          <Field label="Held this way since" hint="a change of mind starts a new lunar year">
                            <DateField value={asset.intentionSince ?? ''} ariaLabel={`${o.name} intention since`}
                                       onChange={(val) => run('asset.update', { assetId: id, intentionSince: val }).then(loadAssets)} />
                          </Field>
                          <Field label="Passed nisab on" hint="leave empty and the intention's own date is used">
                            <DateField value={asset.nisabMetOn ?? ''} ariaLabel={`${o.name} passed nisab on`}
                                       onChange={(val) => run('asset.update', { assetId: id, nisabMetOn: val }).then(loadAssets)} />
                          </Field>
                        </div>

                        <div style={{ padding: '14px 16px', borderRadius: 'var(--r-card)',
                                      background: 'var(--raised)', border: '1px solid var(--hairline)' }}>
                          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center',
                                        marginBottom: zakatLine?.hawl ? 12 : 0 }}>
                            <Chip tone={zakatLine?.included ? 'good' : undefined}>
                              {zakatLine?.included ? `counts ${dm(zakatLine.counted)}` : 'counts nothing'}
                            </Chip>
                            <span style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, flex: 1, minWidth: 220 }}>
                              {zakatLine?.reason ?? 'Working it out needs the zakat assessment, which has not answered yet.'}
                            </span>
                          </div>
                          {zakatLine?.hawl && <HawlBar hawl={zakatLine.hawl} tone={o.colour} />}
                        </div>
                      </>
                    )}
                  </div>
                )}
                {next && due && (() => {
                  // Neither the box nor its border take the asset's colour any more — an
                  // asset without one fell back to the same red the amount is always in, so
                  // a box that meant nothing more than "here is what is due next" read as a
                  // warning on every card. Only the amount stays red: it is money leaving,
                  // and that is the one thing here that is always true regardless of whose
                  // plan it is.
                  const away = daysUntil(due, now);
                  return (
                    <div style={{ padding: '12px 14px', borderRadius: 'var(--r-card)',
                                  background: 'var(--raised)', border: '1px solid var(--hairline)' }}>
                      <div className="ov">Next payment</div>
                      {/* Above the amount, not beside it — a bare "14d" read as part of the
                          number it sat next to. Said as a sentence and given its own line, it
                          reads as the countdown it is before the amount is even reached. */}
                      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
                        {away < 0 ? 'overdue' : `${away} day${away === 1 ? '' : 's'} until next installment`}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 4,
                                    flexWrap: 'wrap' }}>
                        <span className="mono" style={{ fontSize: 17, fontWeight: 500, color: 'var(--negative)',
                                                        whiteSpace: 'nowrap' }}>−{dm(next.amountEgp)}</span>
                        <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                          {due.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })}
                        </span>
                      </div>
                    </div>
                  );
                })()}
            </section>
          );
        })}
      </div>
      )}


      {tab === 'overview' && (
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
              /**
               * What paid for it, when bought outright.
               *
               * Offered only while adding one: an asset already on the books was already
               * settled one way or another, and this field's only honest use is to say what
               * pays for a NEW one. "Initial payment" — a fresh installation's usual answer —
               * states the worth as given and deducts nothing, exactly as leaving it out
               * always has.
               */
              { key: 'accountId', label: 'Paid from', kind: 'select', width: '190px',
                options: sourceAccountOptions(data),
                when: (v) => v.ownership !== 'installments' && !v.existingAsset },
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
                        colour: a.color ?? '#8A8578', existingAsset: 1 },
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
              // left untouched, or explicitly "Initial payment": no account is named, and the
              // worth is simply stated, the way it always has been
              accountId: d.accountId && d.accountId !== INITIAL_PAYMENT ? (d.accountId as string) : undefined,
              icon: d.mark as string | undefined,
              color: (d.colour as string) || undefined,
            }).then(loadAssets)}
            onDelete={(id) => run('asset.remove', { assetId: id }).then(loadAssets)}
          />
        </Panel>
      )}

      {tab === 'plans' && (
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
            { key: 'amountEgp', label: 'Amount', kind: 'amount',
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
                ? { installmentId: r.id, accountId: d.payFrom || undefined, dueDate: d.dueOn,
                    amountEgp: Number(d.amountEgp), note: d.note ?? '' }
                : { propertyId: r.propertyId, installmentId: r.id,
                    dueDate: d.dueOn, amountEgp: Number(d.amountEgp),
                    note: d.note ?? '', payFrom: d.payFrom || undefined };
            },

            onDone: () => { loadSchedule(); loadAssets(); },
          }}
          /*
           * A copy, not a repeat: it goes on the plan the same way any new payment does —
           * `plan.upsert` with no installmentId — so it lands as a fresh, unpaid row a person
           * can then move to next month, or change however it differs from the one it came
           * from. Never copied as paid: a duplicate that arrived already marked paid would
           * try to move money a second time for a payment that only happened once.
           */
          duplicate={{
            capability: 'plan.upsert',
            build: (r) => ({ propertyId: r.propertyId, dueDate: r.dueOn,
                             amountEgp: r.amountEgp, note: r.note,
                             payFrom: r.payFrom || undefined }),
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
          clear={{ log: 'plans',
                   what: 'every plan, every payment on one, and any autopay set up — anything bought on a plan becomes paid for outright',
                   onDone: () => { loadSchedule(); loadAssets(); } }}
        />
      </Panel>
      )}
    </Page>
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

