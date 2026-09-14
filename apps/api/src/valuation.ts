import { schema as t, allBalances, type Db } from '@ledger/db';
import {
  valueHoldings, computedPositions, type Holdings, type LedgerNode, type MarketState,
} from '@ledger/engine';
import { assetKindOf } from './zakat-assets.js';

/**
 * One answer to "what is this worth", for the whole service.
 *
 * The arithmetic is in the engine; what is here is the reading of the tables — every node's
 * balance, the orders that stand behind the share positions, and the rule that decides
 * whether a thing is a property or a car. Anything that reports a total goes through this, so
 * two screens cannot disagree about the same ledger.
 */
export function ledgerHoldings(db: Db, now: Date, market: MarketState): Holdings {
  const balances = allBalances(db);
  const rows = db.select().from(t.nodes).all();
  const planned = new Set(db.select().from(t.installments).all().map((i) => i.propertyId));

  const nodes: LedgerNode[] = rows.map((n) => ({
    id: n.id, kind: n.kind, name: n.name, parentId: n.parentId ?? undefined,
    currency: n.currency ?? undefined, unit: n.unit ?? undefined,
    valuation: n.valuation, priceKey: n.priceKey ?? undefined,
    openingQty: n.openingQty, color: n.color ?? undefined, archived: n.archived,
  }));

  const orders = db.select().from(t.orders).all().map((o) => ({
    id: o.id, seq: o.seq, date: o.date, ticker: o.ticker, side: o.side,
    shares: o.shares, price: o.price, total: o.total, status: o.status, note: o.note ?? '',
  })) as never;

  const kindOf = (n: LedgerNode) => assetKindOf(
    { id: n.id, name: n.name, assetKind: (rows.find((r) => r.id === n.id) as { assetKind?: string | null } | undefined)?.assetKind },
    planned.has(n.id),
  );

  /**
   * A liability hanging off an asset is that asset's contract; one hanging off a bank is money
   * owed today. The ledger already draws this line for the zakat deduction, and net worth has
   * to draw it the same way or the two disagree.
   */
  const institutions = new Set(db.select().from(t.institutions).all().map((i) => i.id));
  const isContract = (n: LedgerNode) => !n.parentId || !institutions.has(n.parentId);

  return valueHoldings(nodes, balances, market, {
    positions: computedPositions(orders, market.prices),
    kindOf, isContract,
  });
}
