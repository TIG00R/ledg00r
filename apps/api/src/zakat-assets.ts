import { schema as t, allBalances, type Db } from '@ledger/db';
import { readPref } from './read.js';
import {
  assessAssets, metalBuckets, rentPot, defaultIntention, hawlFrom, unitValue,
  NISAB_GOLD_G, NISAB_SILVER_G,
  type Valuation,
  type AssetForZakat, type AssetClass, type Intention, type MetalLot,
  type Receipt, type ZakatLine, type MarketState,
} from '@ledger/engine';

/**
 * The ledger's own things, put to the zakat rules.
 *
 * The arithmetic is in the engine, where it can be tested without a database. What lives here
 * is the reading: which rows are assets, what each one is worth today, what rent it has
 * earned and when, and how much metal is held for wearing rather than for holding. Two
 * capabilities need the answer — the assessment and the calendar — so it is assembled once.
 */

export interface AssetsForZakat {
  lines: ZakatLine[];
  /**
   * What the qualifying lines add to the base.
   *
   * Only things charged on their own value. Rent is not added here and must not be: it landed
   * in a bank account, so the cash figure has already counted it once. What the rent rule
   * changes is the other direction — rent that has not yet carried a lunar year is taken back
   * out, which is `heldBack`.
   */
  counted: number;
  /** rent that has carried a lunar year, already inside the base through cash */
  countedRent: number;
  /** rent earned but not yet zakatable, which cash would otherwise count a year early */
  heldBack: number;
  metal: {
    zakatableEgp: number;
    personalGrams: number;
    investmentGrams: number;
    lines: ZakatLine[];
  };
}

const KIND: Record<string, AssetClass> = {
  property: 'property', vehicle: 'vehicle', equipment: 'other', other: 'other',
};

/**
 * What kind of thing a node is.
 *
 * Stated on the record once it has been set, and otherwise worked out the same way the assets
 * list works it out: something with a payment plan against it is a property bought on one, and
 * a car names itself. Deriving rather than relying on the migration means a ledger seeded
 * afterwards — the fixture, for one — is classified too, and a flat is not read as a chattel.
 */
export function assetKindOf(
  node: { id: string; name: string; assetKind?: string | null },
  hasPlan: boolean,
): AssetClass {
  if (node.assetKind) return KIND[node.assetKind] ?? 'other';
  if (/car|vehicle|truck|bike/i.test(`${node.id} ${node.name}`)) return 'vehicle';
  return hasPlan ? 'property' : 'other';
}

/**
 * What a thing is worth, in the ledger's currency.
 *
 * The engine already knows the rule, including that a fixed value stated in another currency
 * is still another currency — a car bought for twenty thousand dollars is not twenty thousand
 * pounds. Reading it here rather than restating it keeps the assessment and the holdings
 * totals from disagreeing about the same car.
 */
function valueOf(
  n: { valuation: string; priceKey: string | null; currency: string | null },
  qty: number, market: MarketState,
): number {
  return qty * unitValue({
    id: '', kind: 'asset', name: '', openingQty: 0,
    valuation: n.valuation as Valuation,
    priceKey: n.priceKey ?? undefined,
    currency: n.currency ?? undefined,
  }, market);
}

/**
 * Rent, read off the movements rather than off a field.
 *
 * An income source can name the asset it comes from, and income is recorded as a movement out
 * of that source's external node. So what a flat has earned is the sum of the income
 * movements attributable to it, each with the day it landed — which is exactly what a lunar
 * year has to be measured over.
 */
function rentReceipts(db: Db, assetId: string, market: MarketState): Receipt[] {
  const sources = db.select().from(t.incomeSources).all()
    .filter((s) => (s as { assetId?: string | null }).assetId === assetId);
  if (!sources.length) return [];

  const externals = new Set(sources.map((s) => `ext-${s.id.replace(/^src-/, '')}`));
  const nodes = new Map(db.select().from(t.nodes).all().map((n) => [n.id, n]));
  const income = new Set(db.select().from(t.transactions).all()
    .filter((tx) => tx.kind === 'income').map((tx) => tx.id));

  return db.select().from(t.legs).all()
    .filter((l) => income.has(l.transactionId) && l.fromNodeId && externals.has(l.fromNodeId))
    .map((l) => {
      const into = l.toNodeId ? nodes.get(l.toNodeId) : undefined;
      const currency = into?.currency ?? 'EGP';
      const rate = currency === 'EGP' ? 1 : market.fxRates[currency] ?? 1;
      return { date: l.date, amountEgp: (l.qtyTo ?? l.qtyFrom ?? 0) * rate };
    })
    .filter((r) => r.amountEgp > 0);
}

/**
 * Every asset, judged, plus the metal split by why it is held.
 *
 * `nisab` is the threshold in force — gold's or silver's, whichever the owner chose — because
 * each line is tested against it on its own: a flat held to sell, and the rent a let flat has
 * earned, each have to clear the threshold and then carry a full lunar year before anything is
 * owed on them.
 */
export function assetsForZakat(db: Db, now: Date, market: MarketState, nisab: number): AssetsForZakat {
  const balances = allBalances(db);
  const rows = db.select().from(t.nodes).all();

  const things = rows.filter((n) => n.kind === 'asset'
    && !n.unit
    && n.priceKey !== 'brokerage_cash'
    && !/^brokerage/.test(n.id)
    && !/^debt-/.test(n.id)
    && !n.archived);

  const planned = new Set(db.select().from(t.installments).all().map((i) => i.propertyId));

  const input: AssetForZakat[] = things.map((n) => {
    const anyN = n as typeof n & {
      intention?: string | null; intentionSince?: string | null;
      acquiredOn?: string | null; nisabMetOn?: string | null; assetKind?: string | null;
    };
    const kind = assetKindOf(anyN, planned.has(n.id));
    const intention = (anyN.intention as Intention | null) ?? defaultIntention(kind);
    return {
      id: n.id, name: n.name, kind,
      intention,
      value: valueOf(n, balances[n.id] ?? n.openingQty, market),
      acquiredOn: anyN.acquiredOn ?? null,
      intentionSince: anyN.intentionSince ?? null,
      nisabMetOn: anyN.nisabMetOn ?? null,
      rent: intention === 'rent' ? rentPot(rentReceipts(db, n.id, market), nisab, now) : null,
    };
  });

  const lines = assessAssets(input, { now, nisab });

  // Metal is a weight held in one node per metal, with every lot on record — so which part is
  // worn and which is held, and the day the held part passed nisab, are read rather than
  // stated.
  const metalLines: ZakatLine[] = [];
  let zakatableEgp = 0;
  let personalGrams = 0;
  let investmentGrams = 0;

  /**
   * The day a weight that predates the log has been held from.
   *
   * A ledger opened from a snapshot holds metal nobody recorded buying, and a holding whose
   * purchase is not on record still has a year running over it — it did not come into
   * existence when the books were opened. The opening position's own date is the earliest
   * defensible answer, and the first movement ever recorded stands in when there is none.
   */
  const snapshot = readPref<{ effectiveFrom?: string }>(db, 'snapshot');
  const firstMovement = db.select().from(t.transactions).all()
    .map((x) => x.date).sort()[0];
  const openingSince = snapshot?.effectiveFrom ?? firstMovement ?? null;

  for (const metal of ['gold', 'silver'] as const) {
    const node = rows.find((n) => n.id === metal);
    if (!node) continue;
    const perGram = metal === 'gold'
      ? market.goldPerG
      : market.prices.silver_g ?? 0;

    const raw = db.select().from(t.goldLots).all().filter((l) => (l.metal ?? 'gold') === metal);
    const lots: MetalLot[] = raw.map((l) => ({
      date: l.date ?? (/^\d{4}-\d{2}-\d{2}$/.test(l.dateText) ? l.dateText : ''),
      grams: l.grams,
      direction: l.direction,
      intention: ((l as { intention?: string | null }).intention as Intention | null) ?? 'investment',
    }));

    /**
     * What is worn comes off what is held, not the other way round.
     *
     * The weight the ledger holds is the node's balance — it counts every movement, including
     * the ones whose lot rows predate this and carry no usable date. So the jewellery is taken
     * from the lots that say they are jewellery, and everything else is the holding. That way
     * a lot with an unreadable date cannot quietly delete metal from the assessment.
     */
    const heldGrams = Math.max(0, balances[metal] ?? node.openingQty);
    const worn = Math.max(0, raw
      .filter((l) => ((l as { intention?: string | null }).intention ?? 'investment') === 'personal')
      .reduce((s, l) => s + (l.direction === 'sell' ? -l.grams : l.grams), 0));
    const wornGrams = Math.min(worn, heldGrams);
    const holdingGrams = Math.max(0, heldGrams - wornGrams);

    const nisabGrams = metal === 'gold' ? NISAB_GOLD_G : NISAB_SILVER_G;
    const fromLots = metalBuckets(lots, nisabGrams, now)
      .find((b) => b.intention === 'investment');

    /**
     * When the year over this metal started.
     *
     * What the owner says wins: a holding bought before this ledger existed has a date only
     * they know, and guessing it from the day the books were opened would restart a year that
     * has actually been running for a decade. Failing that it is read off the lots, and
     * failing those it falls back to the opening position's own date.
     */
    const stated = (node as { nisabMetOn?: string | null; intentionSince?: string | null });
    const anchorOn = (holdingGrams >= nisabGrams
      ? stated.nisabMetOn ?? stated.intentionSince ?? null : null)
      ?? fromLots?.anchorOn
      ?? (holdingGrams >= nisabGrams ? openingSince : null);
    const hawl = anchorOn ? hawlFrom(anchorOn, now) : null;

    for (const [intention, grams] of [
      ['investment', holdingGrams], ['personal', wornGrams],
    ] as Array<[Intention, number]>) {
      if (grams <= 0) continue;
      const value = grams * perGram;
      if (intention === 'personal') personalGrams += grams;
      else investmentGrams += grams;

      const included = intention === 'investment' && !!hawl?.complete;
      if (included) zakatableEgp += value;

      metalLines.push({
        id: `${metal}-${intention}`,
        name: `${metal === 'gold' ? 'Gold' : 'Silver'} — ${grams.toFixed(1)} g`,
        kind: 'metal',
        intention,
        intentionLabel: intention === 'personal' ? 'Worn — a woman\'s jewellery' : 'Held as a holding',
        basis: intention === 'personal' ? 'none' : 'value',
        value,
        counted: included ? value : 0,
        included,
        heldBack: 0,
        aboveNisab: grams >= nisabGrams,
        hawl: intention === 'investment' ? hawl : null,
        anchorOn: intention === 'investment' ? anchorOn : null,
        dates: { acquiredOn: null, intentionSince: null,
                 nisabMetOn: intention === 'investment' ? anchorOn : null },
        reason: intention === 'personal'
          ? 'Worn rather than held, so it is outside zakat.'
          : !anchorOn
            ? `Held as a holding, but ${grams.toFixed(1)} g has not reached the ${nisabGrams} g nisab.`
            : hawl?.complete
              ? `Held as a holding, above ${nisabGrams} g since ${anchorOn}, and a full lunar year has run.`
              : `Held as a holding, above ${nisabGrams} g since ${anchorOn}. The lunar year closes in ${hawl?.daysRemaining ?? 0} days.`,
      });
    }
  }

  return {
    lines,
    counted: lines.filter((l) => l.basis === 'value').reduce((s, l) => s + l.counted, 0),
    countedRent: lines.filter((l) => l.basis === 'rent').reduce((s, l) => s + l.counted, 0),
    heldBack: lines.reduce((s, l) => s + l.heldBack, 0),
    metal: { zakatableEgp, personalGrams, investmentGrams, lines: metalLines },
  };
}
