import type { DataSet, LedgerNode } from '@ledger/engine';
import type { Option } from './components/Select';

/** which institution a node sits at, by the node's parent */
export const bankName = (d: DataSet, parentId?: string | null) =>
  d.institutions.find((i) => i.id === parentId)?.name;

/**
 * An account, as one option in a picker.
 *
 * The bank is the first line and the account is the second. An account's own name is the
 * thing being chosen, but it is rarely the thing being looked for: a list of "USD account",
 * "Current", "Savings" is read by hunting for the bank that holds each one, which used to
 * be the quieter line underneath. Reading the bank first sorts the list by eye — every
 * account at one bank reads as a block — and the account name still says which of them it is.
 *
 * The closed control keeps naming the account, because that is what was chosen; the bank is
 * how it was found, not what it is.
 */
export function accountOption(
  d: DataSet,
  n: LedgerNode,
  extra?: {
    /** whether the currency belongs beside the account's name */
    currency?: boolean;
    /** anything else the second line should carry, such as an account being a credit line */
    note?: string;
    /** what stands in for a bank on a node that has none — the kind of thing it is */
    fallback?: string;
  },
): Option {
  const name = extra?.currency ? `${n.name} · ${n.currency}` : n.name;
  const second = extra?.note ? `${name} · ${extra.note}` : name;
  const bank = bankName(d, n.parentId) ?? extra?.fallback;
  return bank
    ? { value: n.id, label: bank, hint: second, trigger: name }
    : { value: n.id, label: second, trigger: name };
}
