/**
 * What everything is worth, from what is actually held.
 *
 * There were two answers to "what am I worth" in this app and they disagreed. One walked
 * forward from the opening snapshot — income in, spending out, installments paid — which is a
 * forecast and right for a forecast. The other read the balances the movement log actually
 * produces, which is right for everything else, and is what the zakat base was already using.
 * A ledger that reports a net worth its own zakat calculation contradicts is a ledger nobody
 * should trust, so this is the one definition both now take.
 *
 * The rule is dull on purpose: every node is worth its quantity times whatever its valuation
 * says a unit of it is worth, money you owe comes off, and shares are added from the orders
 * that bought them because a share is not held as a node.
 */

import type { LedgerNode, MarketState } from './types.js';

export interface Holdings {
  /** money, including whatever is sitting uninvested at the broker */
  cash: number;
  /** gold and silver, by weight */
  metals: number;
  /** property */
  realEstate: number;
  /** vehicles */
  vehicles: number;
  /** anything else owned that is not money — including money lent out */
  other: number;
  /** shares at the last price recorded for each */
  shares: number;
  /**
   * Uninvested money sitting at the broker, counted inside `cash` as well.
   *
   * It is money, so it belongs in the cash pile that decides net worth and the zakat base.
   * It is also the other half of the share book — the Stocks screen draws it beside the
   * positions, the flow screen groups it with them, and the accounts screen leaves it out
   * because it is not held at a bank. Reported separately so a screen that reads the book
   * as one thing can add it to the shares without a second definition of which node it is.
   */
  brokerageCash: number;
  /** what is held by weight, in grams — the quantity behind `metals` */
  goldGrams: number;
  silverGrams: number;
  /** card balances and money borrowed, as a positive number */
  liabilities: number;
  /**
   * What is still to be paid under a purchase plan, as a positive number.
   *
   * Kept apart from what you owe, and deliberately not subtracted. A property bought on
   * installments is held here as the equity actually paid for, and the balance of the contract
   * is what buys the rest of it — subtracting that balance from equity that does not yet
   * include it would count the same shortfall twice and report a fortune as a debt.
   */
  contracts: number;
  /** owned, less owed */
  total: number;
  byNode: Record<string, number>;
}

export interface PricedPosition { ticker: string; shares: number; price: number; value: number }

const CODE = /^([A-Za-z]{3})_[A-Za-z]{3}$/;

/** Silver rather than gold, by whichever of the two names the ledger gave the holding. */
const isSilver = (n: LedgerNode) => n.id === 'silver' || n.priceKey === 'silver_g';

/**
 * The broker's own cash account.
 *
 * Named by its price key, with the id as the fallback for a ledger written before that key
 * existed — the same two readings the Stocks screen and the transfer capability take.
 */
export const isBrokerageCash = (n: LedgerNode) =>
  n.kind === 'cash' && (n.priceKey === 'brokerage_cash' || /^brokerage/.test(n.id));

/** One unit of what this node holds, in the ledger's currency. */
export function unitValue(n: LedgerNode, m: MarketState): number {
  if (n.unit === 'g') {
    // metal is priced per gram, and each metal has its own price
    if (n.id === 'silver' || n.priceKey === 'silver_g') return m.prices.silver_g ?? 0;
    return m.prices.gold_g ?? m.goldPerG ?? 0;
  }
  if (n.valuation === 'live_price') return m.prices[n.priceKey ?? ''] ?? 0;
  if (n.valuation === 'fx') {
    const key = n.priceKey ?? n.currency ?? '';
    const code = (CODE.exec(key)?.[1] ?? key).toUpperCase();
    return m.fxRates[code] ?? 1;
  }
  // face and fixed are already in the ledger's currency, unless the node names another
  const code = (n.currency ?? 'EGP').toUpperCase();
  return code === 'EGP' ? 1 : m.fxRates[code] ?? 1;
}

/**
 * Everything owned and owed, split the way the screens report it.
 *
 * `assetKind` decides which pile a thing lands in, and is passed in rather than read off the
 * node because the ledger derives it — something with a payment plan against it is a property,
 * a car names itself — and the derivation belongs where the plans are.
 */
export function valueHoldings(
  nodes: LedgerNode[],
  balances: Record<string, number>,
  m: MarketState,
  opts: {
    positions?: PricedPosition[];
    kindOf?: (n: LedgerNode) => string;
    /** true when a liability is the balance of a purchase plan rather than money owed today */
    isContract?: (n: LedgerNode) => boolean;
  } = {},
): Holdings {
  const out: Holdings = {
    cash: 0, metals: 0, realEstate: 0, vehicles: 0, other: 0, shares: 0,
    brokerageCash: 0, goldGrams: 0, silverGrams: 0,
    liabilities: 0, contracts: 0, total: 0, byNode: {},
  };

  for (const n of nodes) {
    if (n.archived) continue;
    if (n.kind === 'external') continue;
    const qty = balances[n.id] ?? n.openingQty ?? 0;
    const value = qty * unitValue(n, m);
    out.byNode[n.id] = value;

    if (n.kind === 'liability') {
      if (opts.isContract?.(n)) out.contracts += Math.max(0, value);
      else out.liabilities += Math.max(0, value);
      continue;
    }
    if (n.kind === 'cash') {
      out.cash += value;
      if (isBrokerageCash(n)) out.brokerageCash += value;
      continue;
    }
    if (n.unit === 'g') {
      out.metals += value;
      // the weight itself, which is what a holding of metal is actually reported as
      if (isSilver(n)) out.silverGrams += qty; else out.goldGrams += qty;
      continue;
    }

    const kind = opts.kindOf?.(n) ?? 'other';
    if (kind === 'property') out.realEstate += value;
    else if (kind === 'vehicle') out.vehicles += value;
    else out.other += value;
  }

  out.shares = (opts.positions ?? []).reduce((s, p) => s + p.value, 0);
  out.total = out.cash + out.metals + out.realEstate + out.vehicles + out.other
    + out.shares - out.liabilities;
  return out;
}
