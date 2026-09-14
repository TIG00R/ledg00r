import type { DataSet, MarketState, Currency } from '@ledger/engine';

/**
 * What the screens read before a ledger has anything in it.
 *
 * A new ledger opens empty. It used to open on a demonstration fixture — invented accounts,
 * a property plan nobody had agreed to, a net worth belonging to nobody — which made the
 * first screen a thing to clear out rather than a thing to start from. The fixture still
 * exists, but it lives in the tests, which is the only place invented money belongs.
 *
 * Every list is empty rather than absent, so a screen maps over it and draws its own empty
 * state instead of throwing on a missing key.
 */
export const EMPTY_DATASET: DataSet = {
  institutions: [],
  nodes: [],
  transactions: [],
  incomeSources: [],
  installments: [],
  planRules: [],
  goldLots: [],
  orders: [],
  expenses: [],
  charity: [],
  categories: [],
  debts: [],
  snapshot: {
    label: '',
    effectiveFrom: '',
    cashEgp: 0,
    goldGramsOwn: 0,
    reEgp: 0,
    paidByProperty: {},
    totalByProperty: {},
  },
  settings: {
    budgetEgp: 0,
    carPurchaseUsd: 0,
    goldTargetG: 0,
    stockInitEgp: 0,
    incomeContractEnd: '',
    goldKarat: '24',
    goldUseBuyPrice: false,
    goldLocalPremium: 0,
    incomeAccountId: '',
    burnAccountId: '',
    forecast: { rateYr: 0, goldYr: 0, reYr: 0, stkYr: 0, horizon: 5 },
  },
};

/**
 * The market before any tick has been recorded.
 *
 * A rate of zero is not a rate, and the screens say so: `rateLive` and `goldLive` are false
 * until `market.read` returns something, so a figure is never drawn as though it had been
 * quoted. Every rate here is replaced the moment a real tick arrives.
 */
export const EMPTY_MARKET: MarketState = {
  usdEgp: 0,
  goldPerG: 0,
  goldPerOz: null,
  prices: {},
  fxRates: { EGP: 1 } as Record<Currency, number>,
  rateLive: false,
  goldLive: false,
};
