import { useState } from 'react';
import { useApp, market } from '../AppState';
import { money, toEgp, type DataSet } from '@ledger/engine';
import { Icon } from './Icon';
import { Empty, Field } from './UI';
import { Select } from './Select';
import { ActionButton } from '../Live';
import { accountOption } from '../accounts';



/**
 * These take the dataset rather than reaching for it.
 *
 * The screens read a dataset that is empty until a ledger service fills it, and it
 * arrives through the context. A helper at module scope cannot reach a hook, so it is handed
 * what it needs instead of closing over a fixture that may already be out of date.
 */
const cashNodes = (d: DataSet) => d.nodes.filter((n) => n.kind === 'cash' && !n.archived && n.parentId);
const nodeOf = (d: DataSet, id: string) => d.nodes.find((x) => x.id === id)!;
export const accountOptions = (d: DataSet) => cashNodes(d).map((n) => accountOption(d, n, { currency: true }));
const rateOf = (cur: string) => (cur === 'EGP' ? 1 : market.fxRates[cur] ?? 1);

/**
 * A real account to default a picker to, when nothing chosen yet says which one.
 *
 * A setting like the living-burn account is often unset — an empty string — on a ledger
 * nobody has configured it for. Seeding a picker with that directly leaves its state pointing
 * at nothing while the control itself falls back to showing its first option, which reads as
 * chosen without being chosen: a balance read off the real state comes back zero, and a
 * submission sent as it stands names no account at all. Validating the preferred id against
 * the accounts that actually exist, and falling back to the first of them, keeps what the
 * picker shows and what it holds in agreement from the moment it mounts.
 */
export const defaultAccountId = (d: DataSet, preferred?: string | null): string =>
  (preferred && cashNodes(d).some((n) => n.id === preferred)) ? preferred : (cashNodes(d)[0]?.id ?? '');

/**
 * Not an account at all.
 *
 * Every screen that asks where money came from has to allow for money whose source was never
 * an account of yours — an opening position on a fresh installation, or a purchase from years
 * ago nobody can trace to a statement any more. One sentinel, so every picker in the ledger
 * offers it in the same words rather than five screens each inventing "none", "not set" and
 * "unknown" for the same idea.
 */
export const INITIAL_PAYMENT = '__initial_payment__';

/** The account list every source picker offers, plus the one option that names no account. */
export const sourceAccountOptions = (d: DataSet) => [
  ...accountOptions(d),
  { value: INITIAL_PAYMENT, label: 'Initial payment',
    hint: "not from any account, or one you don't remember" },
];

/**
 * The one dropdown for "where did this money come from", used everywhere that question is
 * asked — the movement panel below, a metal purchase, a new asset. Same options, same order,
 * same wording, wherever it appears.
 */
export function SourceAccountSelect({ value, onChange, ariaLabel, style }: {
  value: string; onChange: (v: string) => void; ariaLabel: string; style?: React.CSSProperties;
}) {
  const { data } = useApp();
  return <Select value={value} ariaLabel={ariaLabel} onChange={onChange} style={style}
                 options={sourceAccountOptions(data)} />;
}

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

/**
 * Move money between two accounts, across currencies if they differ — or, choosing "Initial
 * payment" as the source, state what one account already holds with no source at all.
 */
export function MoveMoney() {
  const { data, balances  } = useApp();
  // Whichever accounts the ledger actually has, rather than two named here: a ledger that
  // does not happen to contain them used to render nothing at all.
  const cash = cashNodes(data);
  // A single account has nowhere to transfer to, but it can still be given a starting value —
  // which is the only one of the two things this panel does that a lone account can ask for.
  const [from, setFrom] = useState<string>(() => (cash.length > 1 ? cash[0]!.id : INITIAL_PAYMENT));
  const [to, setTo] = useState(() => cash.find((n) => n.id !== cash[0]?.id)?.id ?? cash[0]?.id ?? '');
  const other = (not: string) => cash.find((n) => n.id !== not) ?? cash[0];
  const [amount, setAmount] = useState(1000);
  const [bankRate, setBankRate] = useState('');
  const [fee, setFee] = useState(0);

  // A ledger with nothing in it has nowhere to move money from and nowhere to put it. The
  // panel says so rather than throwing on an account that was never opened.
  if (!cash.length) return (
    <Empty icon="accounts" title="Nowhere to move money yet"
           body="Moving money needs an account to move it into. Add one under Accounts, and this is where you will send it." />
  );

  const starting = from === INITIAL_PAYMENT;

  // Choosing "Initial payment" says the account already holds this much, with nothing to
  // deduct it from — the opening position a fresh installation needs, without a fictitious
  // transfer to explain it.
  if (starting) {
    const dst = nodeOf(data, cash.some((n) => n.id === to) ? to : cash[0]!.id);
    const dp = dst.currency === 'EGP' ? 0 : 2;
    const held = balances[dst.id] ?? dst.openingQty;
    const problems: string[] = [];
    if (!(amount > 0)) problems.push('The amount has to be more than nothing.');

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="From">
          <SourceAccountSelect value={from} ariaLabel="From account" onChange={setFrom} />
        </Field>

        <div style={{ display: 'flex', justifyContent: 'center', color: 'var(--faint)' }}>
          <Icon name="arrowdown" size={16} />
        </div>

        <Field label="Into">
          <Select value={dst.id} ariaLabel="Which account" onChange={setTo} options={accountOptions(data)} />
        </Field>
        <Balance node={dst} delta={amount} />

        <Field label={`Starting value · ${dst.currency}`}>
          <input className="mono" type="number" aria-label={`Starting value in ${dst.currency}`}
                 value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
        </Field>

        <div style={{
          padding: '12px 14px', borderRadius: 'var(--r-card)',
          background: 'var(--raised)', border: '1px solid var(--hairline)',
          display: 'flex', flexDirection: 'column', gap: 7,
        }}>
          <RowLine label="Recorded" value={money(amount, dst.currency!, dp)} tone="var(--muted)" />
          <div style={{ height: 1, background: 'var(--hairline)', margin: '2px 0' }} />
          <RowLine label="Net worth changes by" value={`+${money(amount, dst.currency!, dp)}`} tone="var(--positive)" />
        </div>
        <p style={{ margin: 0, fontSize: 11, color: 'var(--faint)', lineHeight: 1.5 }}>
          No money moves. This states what {dst.name} already holds — nothing is deducted from
          anywhere, and nothing here says where it came from.
        </p>

        {problems.length > 0 && <Problems list={problems} />}

        <ActionButton capability="account.correctBalance" disabled={problems.length > 0}
          input={() => ({ accountId: dst.id, actual: held + amount })}>
          Record the starting value
        </ActionButton>
      </div>
    );
  }

  const src = nodeOf(data, from);
  if (cash.length < 2) return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Field label="From">
        <SourceAccountSelect value={from} ariaLabel="From account" onChange={setFrom} />
      </Field>
      <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
        Add a second account to move money between two of your own — or choose "Initial
        payment" above to record what {src.name} already holds.
      </p>
    </div>
  );
  const dst = nodeOf(data, to === from ? other(from)!.id : to);
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
        <SourceAccountSelect value={from} ariaLabel="From account"
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
      <Balance node={dst} delta={arrives} />

      <Field label={`Amount to send · ${src.currency}`}>
        <input className="mono" type="number" aria-label={`Amount to send in ${src.currency}`}
               value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
      </Field>

      {!sameCurrency && (
        <Field label="Rate the bank gave" hint={`mid-market ${mid.toFixed(4)}`}>
          <input className="mono" type="number" step="0.0001" placeholder={mid.toFixed(4)}
                 aria-label="Rate the bank gave"
                 value={bankRate} onChange={(e) => setBankRate(e.target.value)} />
        </Field>
      )}
      <Field label={`Fee · ${src.currency}`}
             hint="Some banks charge one even between accounts of the same currency, or for a cash withdrawal.">
        <input className="mono" type="number" aria-label={`Fee in ${src.currency}`}
               value={fee} onChange={(e) => setFee(Number(e.target.value))} />
      </Field>

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
export function Problems({ list }: { list: string[] }) {
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

/**
 * What something held before this act, and what it holds after — the one line every
 * endpoint in a movement gets, whether it is money in an account or a weight of metal.
 * `Balance` below is the money-flavoured case of this; a screen with a quantity that is not
 * money (grams, shares) reads exactly the same way, formatted its own way.
 */
export function QuantityBalance({ before, after, format }: {
  before: number; after: number; format: (n: number) => string;
}) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--faint)', marginTop: -6 }}>
      <span>holds <span className="mono">{format(before)}</span></span>
      <span>after <span className="mono" style={{ color: after < 0 ? 'var(--negative)' : 'var(--muted)' }}>
        {format(after)}
      </span></span>
    </div>
  );
}

export function Balance({ node, delta }: { node: DataSet['nodes'][number]; delta: number }) {
  const { balances } = useApp();
  // the opening figure is where the account started; what it holds now is that plus every
  // movement recorded against it since
  const before = balances[node.id] ?? node.openingQty;
  const dp = node.currency === 'EGP' ? 0 : 2;
  return <QuantityBalance before={before} after={before + delta} format={(n) => money(n, node.currency!, dp)} />;
}

export function RowLine({ label, value, tone, muted }: { label: string; value: string; tone: string; muted?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', fontSize: muted ? 11 : 12 }}>
      <span style={{ color: 'var(--muted)' }}>{label}</span>
      <span className="mono" style={{ marginLeft: 'auto', color: tone, fontWeight: muted ? 400 : 500 }}>{value}</span>
    </div>
  );
}
