import { useCallback, useEffect, useState } from 'react';
import { useApp, market } from '../AppState';
import { useLive } from '../Live';
import { ledger } from '../api';
import { money, type CurrencySplit } from '@ledger/engine';
import { Page, Panel, Stat, Stats, Chip, Field } from '../components/UI';
import { Select } from '../components/Select';
import { DateField } from '../components/DateField';
import { Amount } from '../components/Amount';
import { Icon } from '../components/Icon';
import { RecordTable } from '../components/RecordTable';
import { SectionProvider, Sections, useSection } from '../components/Sections';
import { ActionButton } from '../Live';
import { CurrencySplits } from '../components/CurrencySplits';
import { accountOption } from '../accounts';

interface Debt {
  id: string; direction: 'lent' | 'borrowed'; counterparty: string;
  principal: number; outstanding: number; repaid: number; currency: string;
  /** EGP per unit of `currency`, frozen the day this debt was lent or borrowed */
  rate: number | null;
  /** false when there is no frozen rate — this debt converts at today's rate instead */
  rateKnown: boolean;
  startedOn: string; dueOn: string | null; settledOn: string | null;
  accountId: string | null; accountName: string | null;
  note: string | null; nodeId: string;
  settled: boolean; writtenOff: boolean; daysUntilDue: number | null; overdue: boolean;
}

/**
 * What a currency's own rate turns a debt into, in EGP.
 *
 * A debt not lent in EGP carries the rate it was actually lent at, frozen the day it
 * happened — the same way an expense freezes its own rate. One recorded before that was
 * captured has none to read and falls back to today's, which is why `rateKnown` exists:
 * so a fallback shows itself instead of quietly passing for the real thing.
 */
function debtRate(d: Debt): number {
  if (d.currency === 'EGP') return 1;
  return d.rate ?? market.fxRates[d.currency] ?? 1;
}

/** What is still outstanding on a set of debts, grouped by the currency it is held in. */
function splitDebts(rows: Debt[]): { splits: CurrencySplit[]; totalEgp: number; fallback: number } {
  const by = new Map<string, { amount: number; egp: number }>();
  let fallback = 0;
  for (const d of rows) {
    if (!d.outstanding) continue;
    if (!d.rateKnown) fallback += 1;
    const cur = by.get(d.currency) ?? { amount: 0, egp: 0 };
    cur.amount += d.outstanding;
    cur.egp += d.outstanding * debtRate(d);
    by.set(d.currency, cur);
  }
  const splits = [...by.entries()]
    .map(([currency, v]) => ({ currency, amount: v.amount, egp: v.egp }))
    .sort((a, b) => b.egp - a.egp);
  return { splits, totalEgp: splits.reduce((s, x) => s + x.egp, 0), fallback };
}

/**
 * Money lent out, and money owed.
 *
 * Both are debts and the difference is which way they point, so they share a screen and a
 * shape. Lending is not spending: the money leaves an account and becomes something you are
 * owed, so what you are worth does not change — only where it sits does.
 *
 * The distinction matters most at zakat. A debt owed to you is wealth you happen not to be
 * holding, and counts. A debt you owe is money that is not really yours, and comes off.
 */
export function Debts() {
  return (
    <SectionProvider first="lent"><Body /></SectionProvider>
  );
}

function Body() {
  const { tab } = useSection();
  const { dm, data, display, currencies } = useApp();
  const { live, version } = useLive();
  const [rows, setRows] = useState<Debt[] | null>(null);
  const [summary, setSummary] = useState<any>(null);
  const [settling, setSettling] = useState<Debt | null>(null);

  const load = useCallback(() => {
    if (!live) { setRows(null); return; }
    (ledger as any)['debts.list']({ includeSettled: true }).then(setRows).catch(() => setRows(null));
    (ledger as any)['debts.summary']({}).then(setSummary).catch(() => setSummary(null));
  }, [live]);
  useEffect(load, [load, version]);

  const lent = (rows ?? []).filter((d) => d.direction === 'lent');
  const borrowed = (rows ?? []).filter((d) => d.direction === 'borrowed');
  const here = tab === 'lent' ? lent : borrowed;
  const isLent = tab === 'lent';
  const tone = isLent ? 'var(--positive)' : 'var(--negative)';
  const accounts = data.nodes.filter((n) => n.kind === 'cash' && n.parentId);

  // What is still outstanding on this side, by the currency it is actually held in — the
  // same debts the "Owed to you" / "You owe" stat above is adding up.
  const split = splitDebts(here.filter((d) => !d.settled));

  /**
   * The account a new debt starts against, and the currency that goes with it.
   *
   * A picker shows the first of what it is offered when the value it was given names nothing,
   * but it does not choose it — so a blank that pointed at an account this ledger does not
   * have looked filled in and was not: the row said "A Bank · EGP account" while nothing had
   * been chosen, Add stayed disabled with nothing to say why, and no debt could be recorded
   * at all. The one the ledger suggests for spending is used where it exists, and otherwise
   * whichever account does — and the currency follows it, because a picker offering only
   * accounts in the draft's currency has nothing to offer when nothing is held in it.
   */
  const suggested = accounts.find((n) => n.id === data.settings.burnAccountId)
                 ?? accounts.find((n) => n.currency === display)
                 ?? accounts[0];
  /** the account to fall back to when the currency changes out from under the chosen one */
  const inCurrency = (currency: string, chosen: string) =>
    (accounts.find((n) => n.id === chosen && n.currency === currency)
     ?? accounts.find((n) => n.currency === currency))?.id ?? '';

  return (
    <Page>
      <Sections sections={[
        { id: 'lent', label: 'Lent out', icon: 'out',
          hint: 'Money you are owed. It counts toward what you are worth, and toward zakat. Double-click one to change who it is with, or the note on it.' },
        { id: 'borrowed', label: 'Owed by you', icon: 'in',
          hint: 'Money you owe. It comes off the zakat base when you choose to deduct debts. Double-click one to change who it is with, or the note on it.' },
      ]} />

      <Panel>
        <Stats>
          <Stat label="Owed to you" value={dm(summary?.owedToYou ?? 0)} color="var(--positive)"
                sub={`${summary?.lentCount ?? 0} still open`} />
          <Stat label="You owe" value={dm(summary?.owedByYou ?? 0)} color="var(--negative)"
                sub={`${summary?.borrowedCount ?? 0} still open`} />
          <Stat label="Net" value={dm(summary?.net ?? 0)}
                color={(summary?.net ?? 0) >= 0 ? 'var(--positive)' : 'var(--negative)'}
                sub={(summary?.net ?? 0) >= 0 ? 'more owed to you than by you' : 'more owed by you'} />
          <Stat label="Closed" value={String((rows ?? []).filter((d) => d.settled).length)}
                sub="repaid in full, or written off" />
        </Stats>

        {/*
          * The total above is one figure in the display currency; this is what it is made
          * of — a debt in dollars converted at the rate it was actually lent or borrowed at,
          * not at whatever the dollar is worth this minute. One recorded before that rate was
          * captured has none to read and is folded in at today's rate instead, which is what
          * the note below says, rather than leaving it to look like the real thing.
          */}
        {split.splits.length > 0 && (
          <div style={{ marginTop: 20, paddingTop: 18, borderTop: '1px solid var(--hairline)' }}>
            <CurrencySplits label={isLent ? 'Owed to you, by currency' : 'You owe, by currency'}
                            splits={split.splits} totalEgp={split.totalEgp} compact />
            {split.fallback > 0 && (
              <p style={{ margin: '10px 0 0', fontSize: 11, color: 'var(--faint)', lineHeight: 1.5 }}>
                {split.fallback} of these {split.fallback === 1 ? 'was' : 'were'} recorded before a rate
                was frozen on it, and {split.fallback === 1 ? 'converts' : 'convert'} at today's rate
                until it is corrected.
              </p>
            )}
          </div>
        )}

        {/* The thing a person actually wants to know about a debt at zakat time. */}
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginTop: 20,
                      padding: '13px 15px', borderRadius: 'var(--r-card)',
                      background: 'color-mix(in srgb, var(--zakat) 8%, transparent)',
                      border: '1px solid color-mix(in srgb, var(--zakat) 26%, transparent)' }}>
          <Icon name="zakat" size={17} color="var(--zakat)" motion="none" />
          <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.55 }}>
            At zakat, what is <strong style={{ color: 'var(--ink)' }}>owed to you</strong> is
            counted — it is wealth you happen not to be holding. What
            you <strong style={{ color: 'var(--ink)' }}>owe</strong> comes off, if you have
            chosen to deduct debts on the Zakat screen. A loan you have written off is neither.
          </div>
        </div>
      </Panel>


      <Panel title={isLent ? 'Lent out' : 'Owed by you'}
             hint={isLent
               ? 'What you have lent and how much has come back. Recording a loan takes it out of an account — it is not spending, so what you are worth does not change.'
               : 'What you have borrowed and how much you have repaid. Borrowing brings cash in and an obligation with it.'}>
        <RecordTable
          rows={here}
          rowKey={(d) => d.id}
          sort={{ key: 'started', dir: 'desc' }}
          empty={{ icon: isLent ? 'out' : 'in',
                   title: isLent ? 'Nothing lent out' : 'Nothing owed',
                   body: isLent
                     ? 'Lending is recorded against an account, so the money has somewhere to come from.'
                     : 'Borrowing is recorded into an account, so the money has somewhere to land.' }}
          columns={[
            /*
              * The widths are the ones the row needs while it is being written: a name, two
              * amounts with a currency beside one of them, an account picker and two dates.
              * Left to the browser the note took half the table and the account had sixty
              * pixels to draw a picker in.
              */
            { key: 'who', label: isLent ? 'Owed by' : 'Owed to', width: '132px',
              value: (d) => d.counterparty,
              cell: (d) => (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
                  <span style={{ width: 26, height: 26, borderRadius: 999, flex: '0 0 26px',
                                 display: 'flex', alignItems: 'center', justifyContent: 'center',
                                 fontSize: 11, fontWeight: 600,
                                 background: `color-mix(in srgb, ${tone} 16%, transparent)`, color: tone }}>
                    {d.counterparty.slice(0, 2).toUpperCase()}
                  </span>
                  <span style={{ fontSize: 13, textDecoration: d.settled ? 'line-through' : undefined,
                                 opacity: d.settled ? 0.6 : 1 }}>{d.counterparty}</span>
                </span>
              ),
              field: (draft, set) => (
                <input aria-label="Who" placeholder="a name" value={draft.counterparty}
                       onChange={(e) => set({ counterparty: e.target.value })} />
              ) },

            { key: 'started', label: isLent ? 'Lent on' : 'Borrowed on', kind: 'date', width: '120px',
              value: (d) => d.startedOn,
              cell: (d) => <span className="mono" style={{ fontSize: 13 }}>{d.startedOn}</span>,
              field: (draft, set) => (
                <DateField value={draft.startedOn ?? ''} ariaLabel="When it happened"
                           onChange={(v) => set({ startedOn: v })} />
              ) },

            { key: 'principal', label: 'Principal', kind: 'money', width: '176px',
              value: (d) => d.principal,
              cell: (d) => <span className="mono" style={{ fontSize: 13, color: 'var(--muted)' }}>
                {money(d.principal, d.currency, d.currency === 'EGP' ? 0 : 2)}</span>,
              field: (draft, set) => (
                <span className="field-money">
                  <Amount value={draft.amount} ariaLabel="Amount" onChange={(n) => set({ amount: n })} />
                  {/* The account moves with the currency: the picker beside it offers only
                      accounts held in what is being lent, so a chosen pound account left
                      standing under a dollar loan is a choice that is no longer on offer. */}
                  <Select ariaLabel="Currency" value={draft.currency} style={{ width: 92 }}
                          onChange={(v) => set({ currency: v,
                                                 accountId: inCurrency(v, draft.accountId) })}
                          options={currencies.map((c) => ({ value: c.code, label: c.code }))} />
                </span>
              ) },

            { key: 'outstanding', label: 'Still owing', kind: 'amount', width: '116px',
              value: (d) => d.outstanding,
              cell: (d) => (
                <>
                  <span className="mono" style={{ fontSize: 14, fontWeight: 500,
                          color: d.settled ? 'var(--faint)' : tone }}>
                    {money(d.outstanding, d.currency, d.currency === 'EGP' ? 0 : 2)}
                  </span>
                  {d.repaid > 0.005 && !d.settled && (
                    <span style={{ display: 'block', fontSize: 11, color: 'var(--faint)' }}>
                      {money(d.repaid, d.currency, 0)} back
                    </span>
                  )}
                </>
              ) },

            /*
              * Which account it came out of, or landed in — read from the movement that
              * recorded the debt rather than stored twice. The picker offers only accounts
              * in the currency being lent: a loan in dollars cannot leave a pound account,
              * and offering one is offering a refusal.
              */
            { key: 'from', label: isLent ? 'Out of' : 'Into', kind: 'pick', width: '148px',
              value: (d) => d.accountName ?? '—',
              cell: (d) => <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                {d.accountName ?? <span style={{ color: 'var(--faint)' }}>—</span>}</span>,
              field: (draft, set) => {
                const here2 = accounts.filter((n) => !draft.currency || n.currency === draft.currency);
                return (
                  <Select ariaLabel="Account" value={draft.accountId}
                          onChange={(v) => set({ accountId: v })}
                          options={here2.length
                            ? here2.map((n) => accountOption(data, n, { currency: true }))
                            : [{ value: '', label: `no ${draft.currency} account` }]} />
                );
              } },

            /*
              * When it closed, which is a fact rather than a plan: it follows from the last
              * repayment or from writing the loan off, so it is read here and never typed.
              */
            { key: 'settled', label: 'Settled', kind: 'date', width: '120px',
              value: (d) => d.settledOn ?? '',
              cell: (d) => {
                if (!d.settled) return <span style={{ fontSize: 12, color: 'var(--faint)' }}>still open</span>;
                return (
                  <span>
                    <span className="mono" style={{ fontSize: 13 }}>{d.settledOn ?? '—'}</span>
                    {d.writtenOff && (
                      <span style={{ display: 'block' }}><Chip>written off</Chip></span>
                    )}
                  </span>
                );
              } },

            // A note wraps and the row grows, rather than the column growing to hold one line.
            { key: 'note', label: 'Note', kind: 'text', width: '156px',
              value: (d) => d.note ?? '',
              cell: (d) => <span className="rt-wrap-text" style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                {d.note || <span style={{ color: 'var(--faint)' }}>—</span>}</span>,
              field: (draft, set) => (
                <textarea aria-label="Note" rows={3} placeholder="what it was for" value={draft.note}
                          onChange={(e) => set({ note: e.target.value })} />
              ) },
          ]}
          /*
            * Recording a payment, in part or in full, from the row it is against — a debt is
            * usually paid down in pieces, and the panel that takes the amount opens under the
            * table rather than in a column beside it.
            */
          /*
            * Recording a payment, and — for a loan out — giving up on one. Both belong here
            * rather than in the bin at the end of the row: the bin removes a record that
            * should never have been written down, and writing a loan off says the opposite,
            * that it was real and is not coming back. They are different acts and are no
            * longer the same gesture.
            */
          trailing={(d) => (d.settled ? null : (
            <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button className={`btn sm ${isLent ? 'go' : 'danger'}`} onClick={() => setSettling(d)}
                      style={{ whiteSpace: 'nowrap' }}>
                {isLent ? 'Money back' : 'Pay some'}
              </button>
              {isLent && (
                <ActionButton capability="debt.writeOff" className="btn ghost sm"
                  style={{ whiteSpace: 'nowrap' }}
                  input={() => ({ debtId: d.id })}
                  onDone={(o) => { if (o.ok) load(); }}>
                  Write off
                </ActionButton>
              )}
            </span>
          ))}
          trailingWidth={isLent ? '188px' : '104px'}
          add={{
            label: isLent ? 'Lend money to someone' : 'Record something you borrowed',
            capability: 'debt.record',
            blank: { counterparty: '', amount: 0,
                     currency: suggested?.currency ?? display,
                     accountId: suggested?.id ?? '',
                     startedOn: new Date().toISOString().slice(0, 10), note: '' },
            valid: (d) => !!d.counterparty.trim() && d.amount > 0 && !!d.accountId,
            build: (d) => ({ direction: isLent ? 'lent' : 'borrowed',
                             counterparty: d.counterparty.trim(), accountId: d.accountId,
                             amount: d.amount, currency: d.currency,
                             startedOn: d.startedOn || undefined, note: d.note || undefined }),
            onDone: load,
          }}
          /*
            * A closed debt is still a record, and a record that says the wrong name or the
            * wrong day is worth correcting whether or not the money has come back. What
            * cannot change is the amount: that is what the movement behind it says happened.
            */
          edit={{
            capability: 'debt.update',
            draftOf: (d) => ({ counterparty: d.counterparty, startedOn: d.startedOn,
                               note: d.note ?? '', amount: d.principal, currency: d.currency,
                               accountId: d.accountId ?? '' }),
            build: (draft, d) => ({ debtId: d.id, counterparty: draft.counterparty,
                                    startedOn: draft.startedOn || undefined,
                                    note: draft.note || undefined }),
            onDone: load,
          }}
          /*
            * Removing a debt takes the record away and reverses everything it moved, which
            * is what "this should never have been written down" means. A loan you genuinely
            * made and have given up on is written off instead, from the button on the row.
            */
          remove={{
            capability: 'debt.remove',
            build: (d) => ({ debtId: d.id }),
            what: (d) => (isLent ? `the loan to ${d.counterparty}` : `what you owe ${d.counterparty}`),
            onDone: load,
          }}
          clear={{ log: 'debts',
                   what: 'everything lent out and everything owed, with the movements behind them',
                   onDone: load }}
        />

        {settling && (
          <div style={{ marginTop: 20, paddingTop: 18, borderTop: '1px solid var(--hairline)' }}>
            <h3 style={{ margin: '0 0 4px', fontSize: 13, fontWeight: 600 }}>
              {settling.direction === 'lent' ? 'Money coming back' : 'Paying it back'}
            </h3>
            <p style={{ margin: '0 0 16px', fontSize: 11.5, color: 'var(--faint)', lineHeight: 1.5 }}>
              {settling.direction === 'lent'
                ? `${settling.counterparty} is returning some of what they owe. It lands in an account of yours.`
                : `Repaying ${settling.counterparty}. It comes out of an account of yours.`}
            </p>
            <Settle debt={settling} accounts={accounts}
                    onClose={() => setSettling(null)} onDone={load} />
          </div>
        )}

        {isLent && (
          <p style={{ margin: '18px 0 0', fontSize: 12, color: 'var(--faint)', lineHeight: 1.55 }}>
            <strong style={{ color: 'var(--muted)' }}>Write off</strong> is for a loan you made
            and no longer expect back: it leaves what you are worth and stops counting toward
            zakat, and the log keeps both the loan and the day you gave up on it.
            The <strong style={{ color: 'var(--muted)' }}>bin</strong> is for one that should
            never have been recorded — the money goes back to the account it left and the
            record is gone.
          </p>
        )}
      </Panel>
    </Page>
  );
}

/** Recording a repayment, either way. */
function Settle({ debt, accounts, onClose, onDone }: {
  debt: Debt;
  accounts: ReturnType<typeof useApp>['data']['nodes'];
  onClose: () => void;
  onDone: () => void;
}) {
  const { data } = useApp();
  const [amount, setAmount] = useState(debt.outstanding);
  /** an account that can actually receive this money: one held in the debt's own currency */
  const usable = accounts.filter((n) => n.kind === 'cash' && n.parentId && n.currency === debt.currency);
  const [accountId, setAccountId] = useState(
    usable.find((n) => n.id === data.settings.burnAccountId)?.id ?? usable[0]?.id ?? '');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  const [fee, setFee] = useState(0);
  const lent = debt.direction === 'lent';
  /**
   * What the payment actually settles.
   *
   * A bank charge comes off what arrives, the same as on any other movement here. Money owed
   * to you was repaid in full and the charge was taken on the way, so the debt falls by the
   * whole amount; money you are paying back reaches the creditor lighter, so the debt falls
   * by what is left of it.
   */
  const credited = lent ? amount : Math.max(0, amount - fee);
  const all = credited >= debt.outstanding - 0.005;
  const left = Math.max(0, debt.outstanding - credited);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ padding: '12px 14px', borderRadius: 'var(--r-card)',
                    background: 'var(--raised)', border: '1px solid var(--hairline)' }}>
        <div className="ov">Still owing</div>
        <div className="mono" style={{ fontSize: 20, fontWeight: 500, marginTop: 4 }}>
          {money(debt.outstanding, debt.currency, debt.currency === 'EGP' ? 0 : 2)}
        </div>
        <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 2 }}>
          of {money(debt.principal, debt.currency, 0)} · {debt.counterparty}
        </div>
      </div>

      <div style={{ display: 'grid', gap: 18,
                    gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}>
        {/* Part of it is the ordinary case, not the exception — a debt comes back in pieces. */}
        <Field label="Amount"
               hint={all ? 'this settles it'
                         : `${money(left, debt.currency, debt.currency === 'EGP' ? 0 : 2)} would still be owing`}>
          <Amount value={amount} ariaLabel="Repayment amount" onChange={setAmount} />
        </Field>

        <Field label={lent ? 'Into' : 'Out of'}
               hint={usable.length ? `accounts held in ${debt.currency}` : `no ${debt.currency} account`}>
          <Select ariaLabel="Account" value={accountId} onChange={setAccountId}
                  options={usable.length
                    ? usable.map((n) => accountOption(data, n, { currency: true }))
                    : [{ value: '', label: `no ${debt.currency} account` }]} />
        </Field>

        {/* Banks charge for a transfer and for a withdrawal, in the debt's own currency, and
            whichever way the money is going. */}
        <Field label={`Fee · ${debt.currency}`}
               hint={lent ? 'taken out of what reaches your account'
                          : 'taken out of what reaches them, on top of nothing else'}>
          <Amount value={fee} ariaLabel="Fee" onChange={setFee} />
        </Field>

        <Field label="Date"><DateField value={date} onChange={setDate} ariaLabel="Date repaid" /></Field>

        <Field label="Note">
          <input aria-label="Repayment note" placeholder="in cash, by transfer"
                 value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn ghost sm" onClick={() => setAmount(debt.outstanding + (lent ? 0 : fee))}>
          All of it — {money(debt.outstanding + (lent ? 0 : fee), debt.currency, debt.currency === 'EGP' ? 0 : 2)}
        </button>
        <button className="btn ghost sm" onClick={() => setAmount(Math.round(debt.outstanding / 2))}>
          Half
        </button>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <ActionButton capability="debt.settle"
          disabled={!(amount > 0) || fee >= amount || credited > debt.outstanding + 0.005 || !accountId}
          style={{ background: lent ? 'var(--positive)' : 'var(--negative)', color: '#fff' }}
          onDone={(o) => { if (o.ok) { onDone(); onClose(); } }}
          input={() => ({ debtId: debt.id, accountId, amount, fee: fee || undefined,
                          date, note: note || undefined })}>
          {all ? (lent ? 'Record the last of it back' : 'Record the final repayment')
               : (lent ? 'Record part of it back' : 'Record a part payment')}
        </ActionButton>

        <button className="btn ghost" onClick={onClose}>
          <Icon name="close" size={14} motion="none" /> Cancel
        </button>
      </div>

      <p style={{ margin: 0, fontSize: 11, color: 'var(--faint)', lineHeight: 1.5 }}>
        {lent
          ? `The money returns to the account you choose, and what you are owed falls by the same amount.${
              fee > 0 ? ' Only the fee actually leaves — net worth falls by that and nothing else.' : ' Net worth does not change.'}`
          : `The money leaves the account you choose, and what you owe falls by what reaches them.${
              fee > 0 ? ' Only the fee actually leaves — net worth falls by that and nothing else.' : ' Net worth does not change.'}`}
      </p>
    </div>
  );
}
