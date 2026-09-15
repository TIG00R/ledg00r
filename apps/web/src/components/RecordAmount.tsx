import { money, toEgp, fromEgp } from '@ledger/engine';
import { useApp, market } from '../AppState';

/** Piastres are worth printing; a currency worth thousands to the pound is not. */
const dp = (currency: string) => (currency === 'EGP' ? 0 : 2);

/**
 * What was recorded, in the currency it was recorded in.
 *
 * A figure used to be restated underneath in whatever currency the screen was being read in,
 * which meant a dollar rent paid into a dollar account was quietly reported in pounds — an
 * exchange that never happened, at a rate from today rather than from the day it landed. The
 * second line is now about the account rather than about the reader: it appears only when the
 * money genuinely changed currency on its way in, and it says what the account received.
 *
 * Where there is no account — a figure that belongs to nothing in particular — there is
 * nothing for it to have been converted into, and the native amount stands alone.
 */
export function RecordAmount({ amount, currency, accountId, accountCurrency, sign = '' }: {
  amount: number;
  currency: string;
  /** the account the money reached or left; its currency is read from the ledger */
  accountId?: string | null;
  /** or the account's currency outright, where the caller already has it */
  accountCurrency?: string | null;
  /** a minus for money that left, where the row does not say so another way */
  sign?: string;
}) {
  const { data } = useApp();
  const held = accountCurrency
    ?? (accountId ? data.nodes.find((n) => n.id === accountId)?.currency ?? null : null);
  const exchanged = !!held && held !== currency;

  return (
    <>
      <div className="mono" style={{ fontSize: 14 }}>
        {sign}{money(amount, currency, dp(currency))}
      </div>
      {exchanged && (
        <div className="mono" style={{ fontSize: 11, color: 'var(--faint)' }}>
          {sign}{money(fromEgp(toEgp(amount, currency, market), held, market), held, dp(held))}
        </div>
      )}
    </>
  );
}

export { dp as decimalsFor };
