import type { DataSet, LedgerNode } from '@ledger/engine';
import type { Option } from './components/Select';

/** which institution a node sits at, by the node's parent */
export const bankName = (d: DataSet, parentId?: string | null) =>
  d.institutions.find((i) => i.id === parentId)?.name;

/** the mark that institution wears, so a picker of accounts reads like the accounts screen */
export const bankMark = (d: DataSet, parentId?: string | null) =>
  d.institutions.find((i) => i.id === parentId)?.logo ?? undefined;

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
    /**
     * What choosing this option is worth, when that is not the node's id.
     *
     * A picker on a form chooses an account and sends its id. A column filter chooses the
     * text that column holds — an account's name as the log prints it — and matching an id
     * against that would hide every row. Same option, drawn the same way, carrying whichever
     * of the two the caller is actually choosing between.
     */
    value?: string;
  },
): Option {
  const name = extra?.currency ? `${n.name} · ${n.currency}` : n.name;
  const second = extra?.note ? `${name} · ${extra.note}` : name;
  const bank = bankName(d, n.parentId);
  // The bank's own logo, or the node's own mark where it sits at no bank — a broker's wallet
  // has one and a flat has one, and an option with nothing to draw simply has no mark.
  const icon = bankMark(d, n.parentId) ?? n.icon ?? undefined;
  /**
   * What the closed control says.
   *
   * The account alone, which is what it used to say, is the half of the answer a reader
   * already knows: accounts are named for what they hold — "EGP", "USD", "Current" — so a
   * closed picker read as a currency rather than as an account anywhere the bank was the
   * thing that told two of them apart. Closed, it names both, in the order the open list
   * reads them: the bank, then the account held there.
   */
  if (bank) return { value: extra?.value ?? n.id, label: bank, hint: second, trigger: `${bank} · ${name}`, icon };
  /**
   * Nothing holds it, so the thing itself leads.
   *
   * What it is — a broker's wallet, a car, the gold book — is worth saying, but it is not
   * what the option names: a list led by "asset", "cash", "asset" says nothing about which
   * of them is meant, and the names underneath were doing all the work. The name leads and
   * the kind reads quietly under it, which is the same order an account at a bank reads in.
   */
  return extra?.fallback
    ? { value: extra?.value ?? n.id, label: second, hint: extra.fallback, trigger: name, icon }
    : { value: extra?.value ?? n.id, label: second, trigger: name, icon };
}
