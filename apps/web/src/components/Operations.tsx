import { useState } from 'react';
import { useApp, market } from '../AppState';
import { money, toEgp, type DataSet } from '@ledger/engine';
import { Icon, type IconName } from './Icon';
import { Empty, Field } from './UI';
import { Select } from './Select';
import { ActionButton } from '../Live';



/**
 * These take the dataset rather than reaching for it.
 *
 * The screens read a dataset that is empty until a ledger service fills it, and it
 * arrives through the context. A helper at module scope cannot reach a hook, so it is handed
 * what it needs instead of closing over a fixture that may already be out of date.
 */
const cashNodes = (d: DataSet) => d.nodes.filter((n) => n.kind === 'cash' && !n.archived && n.parentId);
const nodeOf = (d: DataSet, id: string) => d.nodes.find((x) => x.id === id)!;
const bankOf = (d: DataSet, id: string) =>
  d.institutions.find((i) => i.id === nodeOf(d, id)?.parentId)?.name ?? '';
const accountOptions = (d: DataSet) => cashNodes(d).map((n) => ({
  value: n.id, label: `${n.name} · ${n.currency}`, hint: bankOf(d, n.id),
}));
const rateOf = (cur: string) => (cur === 'EGP' ? 1 : market.fxRates[cur] ?? 1);

/**
 * Operations sit beside the thing they act on. Money never appears or vanishes — it comes
 * out of a named account, so every panel here starts by asking which one.
 */
export function OperationPanel({ title, hint, children }: {
  title: string; hint?: string; children: React.ReactNode;
}) {
  return (
    <section className="panel" style={{ padding: 20 }}>
      <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{title}</h2>
      {hint && <p style={{ margin: '5px 0 16px', fontSize: 11, color: 'var(--faint)', lineHeight: 1.5 }}>{hint}</p>}
      {children}
    </section>
  );
}

/** Move money between two accounts, across currencies if they differ. */
export function MoveMoney() {
  const { data, balances  } = useApp();
  // Whichever accounts the ledger actually has, rather than two named here: a ledger that
  // does not happen to contain them used to render nothing at all.
  const cash = cashNodes(data);
  const [from, setFrom] = useState(() => cash[0]?.id ?? '');
  const [to, setTo] = useState(() => cash.find((n) => n.id !== cash[0]?.id)?.id ?? cash[0]?.id ?? '');
  const other = (not: string) => cash.find((n) => n.id !== not) ?? cash[0];
  const [amount, setAmount] = useState(1000);
  const [bankRate, setBankRate] = useState('');
  const [fee, setFee] = useState(0);

  // A ledger with nothing in it has nowhere to move money from and nowhere to put it. The
  // panel says so rather than throwing on an account that was never opened.
  const src = cash.length ? nodeOf(data, from) : undefined;
  const dst = cash.length ? nodeOf(data, to === from ? other(from)!.id : to) : undefined;
  if (!src || !dst || cash.length < 2) return (
    <Empty icon="accounts" title="Nowhere to move money yet"
           body="Moving money needs two accounts to move it between. Add them under Accounts, and this is where you will send it." />
  );
  const sameCurrency = src.currency === dst.currency;
  const mid = rateOf(src.currency!) / rateOf(dst.currency!);
  const applied = bankRate ? Number(bankRate) : mid;
  const net = Math.max(0, amount - fee);
  const arrives = sameCurrency ? net : net * applied;
  /**
   * The rate the bank gave against the mid-market rate.
   *
   * Worth showing, because it is what the exchange cost you against the headline rate. It is
   * NOT a change in what you are worth: the money is still yours, it is simply denominated
   * differently, and whatever it is worth is decided by the rate the ledger values it at.
   * Only the fee actually leaves.
   */
  const spread = sameCurrency ? 0 : toEgp(amount * (mid - applied), dst.currency!, market);
  const feeEgp = toEgp(fee, src.currency!, market);

  // What stops a movement being recorded, in the order a person would notice it.
  const held = balances[src.id] ?? src.openingQty;
  const problems: string[] = [];
  if (!(amount > 0)) problems.push('The amount has to be more than nothing.');
  if (fee > amount) problems.push('The fee is larger than the amount being sent.');
  if (amount > held && src.kind === 'cash') {
    problems.push(`${src.name} holds ${money(held, src.currency!, src.currency === 'EGP' ? 0 : 2)}, which is ${money(amount - held, src.currency!, src.currency === 'EGP' ? 0 : 2)} short.`);
  }
  if (!sameCurrency && bankRate && !(Number(bankRate) > 0)) problems.push('The rate has to be a positive number.');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Field label="From">
        <Select value={from} ariaLabel="From account" options={accountOptions(data)}
                onChange={(v) => { setFrom(v); if (v === to) setTo(other(v)!.id); }} />
      </Field>
      <Balance node={src} delta={-amount} />

      <div style={{ display: 'flex', justifyContent: 'center', color: 'var(--faint)' }}>
        <Icon name="arrowdown" size={16} />
      </div>

      <Field label="To">
        <Select value={dst.id} ariaLabel="To account" onChange={setTo}
                options={accountOptions(data).filter((o) => o.value !== from)} />
      </Field>
      <Balance node={dst} delta={arrives} arriving />

      <Field label={`Amount to send · ${src.currency}`}>
        <input className="mono" type="number" aria-label={`Amount to send in ${src.currency}`}
               value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
      </Field>

      {!sameCurrency && (
        <>
          <Field label="Rate the bank gave" hint={`mid-market ${mid.toFixed(4)}`}>
            <input className="mono" type="number" step="0.0001" placeholder={mid.toFixed(4)}
                   aria-label="Rate the bank gave"
                   value={bankRate} onChange={(e) => setBankRate(e.target.value)} />
          </Field>
          <Field label={`Fee · ${src.currency}`}>
            <input className="mono" type="number" aria-label={`Fee in ${src.currency}`}
                   value={fee} onChange={(e) => setFee(Number(e.target.value))} />
          </Field>
        </>
      )}

      <div style={{
        padding: '12px 14px', borderRadius: 'var(--r-card)',
        background: 'var(--raised)', border: '1px solid var(--hairline)',
        display: 'flex', flexDirection: 'column', gap: 7,
      }}>
        <RowLine label="Leaves" value={money(amount, src.currency!, src.currency === 'EGP' ? 0 : 2)} tone="var(--negative)" />
        <RowLine label="Arrives" value={money(arrives, dst.currency!, dst.currency === 'EGP' ? 0 : 2)} tone="var(--positive)" />
        {!sameCurrency && Math.abs(spread) > 0.5 && (
          <RowLine label="Against the mid-market rate"
                   value={`${spread > 0 ? '−' : '+'}${money(Math.abs(spread), 'EGP')}`}
                   tone="var(--muted)" muted />
        )}
        {fee > 0 && <RowLine label="Fee" value={money(feeEgp, 'EGP')} tone="var(--negative)" muted />}
        <div style={{ height: 1, background: 'var(--hairline)', margin: '2px 0' }} />
        <RowLine
          label="Net worth changes by"
          value={fee > 0 ? `−${money(feeEgp, 'EGP')}` : 'nothing'}
          tone={fee > 0 ? 'var(--negative)' : 'var(--faint)'} />
        <span style={{ fontSize: 11, color: 'var(--faint)', lineHeight: 1.45 }}>
          {fee > 0
            ? 'Only the fee leaves. The rest is still yours, in a different account.'
            : 'The money is still yours, in a different account.'}
        </span>
      </div>

      {problems.length > 0 && <Problems list={problems} />}

      <ActionButton capability="movement.transfer" disabled={problems.length > 0}
        input={() => ({
          fromAccountId: from, toAccountId: dst.id, amount,
          rateApplied: bankRate ? Number(bankRate) : undefined,
          fee, note: undefined,
        })}>
        Record the movement
      </ActionButton>
    </div>
  );
}

/** Why the button is off. Stated plainly, next to the button, before it is pressed. */
function Problems({ list }: { list: string[] }) {
  return (
    <div style={{
      display: 'flex', gap: 10, padding: '11px 13px', borderRadius: 'var(--r-card)',
      background: 'color-mix(in srgb, var(--negative) 9%, transparent)',
      border: '1px solid color-mix(in srgb, var(--negative) 26%, transparent)',
    }}>
      <Icon name="warn" size={15} color="var(--negative)" motion="none" />
      <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex',
                   flexDirection: 'column', gap: 5, fontSize: 12, lineHeight: 1.45, color: 'var(--muted)' }}>
        {list.map((p) => <li key={p}>{p}</li>)}
      </ul>
    </div>
  );
}

/** Buy something with money from a named account. Used by gold, assets and the stock book. */
export function FundFrom({ what, unitLabel, unitPrice, icon, action, capability }: {
  what: string; unitLabel?: string; unitPrice?: number; icon: IconName; action: string;
  /** which capability the button runs; defaults to funding the brokerage */
  capability?: string;
}) {
  const { data, balances  } = useApp();
  // the ledger's own first account, for the same reason as above
  const [from, setFrom] = useState(() => cashNodes(data)[0]?.id ?? '');
  const [qty, setQty] = useState(unitPrice ? 10 : 50000);
  const src = nodeOf(data, from) as ReturnType<typeof nodeOf> | undefined;
  if (!src) return (
    <Empty icon="accounts" title="No account to pay from"
           body="This has to come out of an account. Add one under Accounts and it will be offered here." />
  );
  const costEgp = unitPrice ? qty * unitPrice : toEgp(qty, src.currency!, market);
  const costNative = costEgp / rateOf(src.currency!);

  const held = balances[src.id] ?? src.openingQty;
  const problems: string[] = [];
  if (!(qty > 0)) problems.push('The amount has to be more than nothing.');
  if (costNative > held && src.kind === 'cash') {
    problems.push(`${src.name} holds ${money(held, src.currency!, src.currency === 'EGP' ? 0 : 2)}, which is ${money(costNative - held, src.currency!, src.currency === 'EGP' ? 0 : 2)} short.`);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Field label="Paid from">
        <Select value={from} ariaLabel="Paid from" options={accountOptions(data)} onChange={setFrom} />
      </Field>
      <Balance node={src} delta={-costNative} />

      <div style={{ display: 'flex', justifyContent: 'center', color: 'var(--faint)' }}>
        <Icon name="arrowdown" size={16} />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '11px 13px',
                    borderRadius: 'var(--r-card)', background: 'var(--raised)', border: '1px solid var(--hairline)' }}>
        <span style={{ width: 30, height: 30, borderRadius: 8, flex: '0 0 30px', display: 'flex',
                       alignItems: 'center', justifyContent: 'center',
                       background: 'color-mix(in srgb, var(--gold) 14%, transparent)' }}>
          <Icon name={icon} size={16} color="var(--gold)" />
        </span>
        <div>
          <div style={{ fontSize: 13, fontWeight: 500 }}>{what}</div>
          <div style={{ fontSize: 11, color: 'var(--faint)' }}>gains {money(costEgp, 'EGP')}</div>
        </div>
      </div>

      <Field label={unitLabel ?? `Amount · ${src.currency}`}>
        <input className="mono" type="number" aria-label={unitLabel ?? `Amount in ${src.currency}`}
               value={qty} onChange={(e) => setQty(Number(e.target.value))} />
      </Field>

      <div style={{ padding: '12px 14px', borderRadius: 'var(--r-card)', background: 'var(--raised)',
                    border: '1px solid var(--hairline)', display: 'flex', flexDirection: 'column', gap: 7 }}>
        <RowLine label="Leaves the account"
                 value={money(costNative, src.currency!, src.currency === 'EGP' ? 0 : 2)} tone="var(--negative)" />
        {unitPrice && <RowLine label="At" value={`${money(unitPrice, 'EGP')} each`} tone="var(--muted)" muted />}
        <div style={{ height: 1, background: 'var(--hairline)', margin: '2px 0' }} />
        <RowLine label="Net worth changes by" value="nothing" tone="var(--faint)" />
      </div>
      <p style={{ margin: 0, fontSize: 11, color: 'var(--faint)', lineHeight: 1.5 }}>
        Value moves between two things you own, so the total does not change — only the split does.
      </p>
      {problems.length > 0 && <Problems list={problems} />}

      <ActionButton capability={capability ?? 'book.fund'} disabled={problems.length > 0}
        input={() => (unitPrice
          ? { accountId: from, grams: qty, pricePerGram: unitPrice }
          : { accountId: from, amount: qty })}>
        {action}
      </ActionButton>
    </div>
  );
}

function Balance({ node, delta, arriving }: { node: DataSet['nodes'][number]; delta: number; arriving?: boolean }) {
  const { balances } = useApp();
  // the opening figure is where the account started; what it holds now is that plus every
  // movement recorded against it since
  const before = balances[node.id] ?? node.openingQty;
  const after = before + delta;
  const dp = node.currency === 'EGP' ? 0 : 2;
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--faint)', marginTop: -6 }}>
      <span>holds <span className="mono">{money(before, node.currency!, dp)}</span></span>
      <span>after <span className="mono" style={{ color: after < 0 ? 'var(--negative)' : 'var(--muted)' }}>
        {money(after, node.currency!, dp)}
      </span></span>
    </div>
  );
}

function RowLine({ label, value, tone, muted }: { label: string; value: string; tone: string; muted?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', fontSize: muted ? 11 : 12 }}>
      <span style={{ color: 'var(--muted)' }}>{label}</span>
      <span className="mono" style={{ marginLeft: 'auto', color: tone, fontWeight: muted ? 400 : 500 }}>{value}</span>
    </div>
  );
}
