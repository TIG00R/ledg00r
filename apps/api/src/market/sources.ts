import { wire, num, pause, GRAMS_PER_TROY_OUNCE } from './wire.js';

/**
 * Where a number can come from.
 *
 * Four things are quoted from outside: what a currency is worth, what a gram of gold is
 * worth, what a gram of silver is worth, and what a share last traded at. For each of them
 * this file carries a short list of sources that were tried and found to answer, with the
 * parsing each one needs kept next to it.
 *
 * The owner of the ledger picks one per subject and nothing else. No URL, no key, no JSON
 * path, no host list — those are decisions with security and correctness consequences, and
 * a settings form is the wrong place to make them. What is left to choose is the thing that
 * actually differs between sources, which is whose number you would rather trust: the
 * central bank or the market, the dealer down the road or the world price.
 *
 * Every source states plainly what it is and how often it moves, because that is what the
 * choice is really between.
 */
export type Subject = 'fx' | 'gold' | 'silver' | 'stocks';

export const SUBJECTS: Array<{ id: Subject; label: string; hint: string }> = [
  { id: 'fx', label: 'Currencies', hint: 'What a dollar, a pound or a euro is worth.' },
  { id: 'gold', label: 'Gold', hint: 'One gram, in your own currency.' },
  { id: 'silver', label: 'Silver', hint: 'One gram, in your own currency.' },
  { id: 'stocks', label: 'Shares', hint: 'What each holding last traded at.' },
];

export interface SourceCtx {
  /** the currency this ledger reports in */
  base: string;
  /** the currency codes it holds, base excluded */
  currencies: string[];
  /** the tickers it has positions or orders in */
  tickers: string[];
  /** the last recorded value of a key, for a source that converts a world price */
  known: (key: string) => number | undefined;
}

export interface SourceResult {
  /** market_ticks keys and their values, in the ledger's own currency where that applies */
  ticks: Record<string, number>;
  /** one sentence for the interface — what was taken, and on what basis */
  note: string;
}

export interface Source {
  id: string;
  subject: Subject;
  /** who they are */
  label: string;
  /** what the number is, in a sentence a person can judge */
  what: string;
  /** how often it moves, and how far behind it runs */
  cadence: string;
  hosts: string[];
  /** offered only when the ledger reports in this currency */
  onlyBase?: string;
  /** nothing is fetched — the figure is whatever was last typed in */
  manual?: boolean;
  fetch?: (c: SourceCtx) => Promise<SourceResult>;
}

/* ── currencies ─────────────────────────────────────────────────────────── */

/**
 * The names the Central Bank prints against each rate. It publishes a table for people, not
 * an API, so the mapping from its wording to a currency code lives here.
 */
const CBE_NAMES: Record<string, string> = {
  'US Dollar': 'USD', Euro: 'EUR', 'Pound Sterling': 'GBP', 'Swiss Franc': 'CHF',
  'Japanese Yen': 'JPY', 'Saudi Riyal': 'SAR', 'Kuwaiti Dinar': 'KWD', 'UAE Dirham': 'AED',
  'Qatari Riyal': 'QAR', 'Bahraini Dinar': 'BHD', 'Omani Riyal': 'OMR',
  'Jordanian Dinar': 'JOD', 'Canadian Dollar': 'CAD', 'Australian Dollar': 'AUD',
  'Chinese Yuan': 'CNY', 'Danish Krone': 'DKK', 'Norwegian Krone': 'NOK',
  'Swedish Krona': 'SEK',
};

const cbe: Source = {
  id: 'cbe', subject: 'fx', onlyBase: 'EGP',
  label: 'Central Bank of Egypt',
  what: 'The official rate the banks are told to quote, taken at the middle of its buy and sell.',
  cadence: 'Published on working days. It does not move at the weekend.',
  hosts: ['www.cbe.org.eg'],
  async fetch({ currencies }) {
    const html = await wire('https://www.cbe.org.eg/en/economic-research/statistics/cbe-exchange-rates',
                            { allow: ['www.cbe.org.eg'], timeoutMs: 15_000 });
    return parseCbe(html, currencies);
  },
};

/**
 * The published table is three columns: what the currency is called, what banks buy it at,
 * what they sell it at. The rate recorded is the middle of the two, because neither side is
 * the rate — one is what you would be paid and the other what you would pay.
 *
 * Exported because a parser reading someone else's page is the thing most likely to break
 * quietly, so it is held to a pinned copy of that page in the tests.
 */
export function parseCbe(html: string, currencies: string[]): SourceResult {
  const rows = html.matchAll(
    /<tr[^>]*>\s*<td[^>]*>\s*([A-Za-z][A-Za-z .]+?)\s*<\/td>\s*<td[^>]*>\s*([0-9.]+)\s*<\/td>\s*<td[^>]*>\s*([0-9.]+)\s*<\/td>/g);

  const ticks: Record<string, number> = {};
  for (const [, name, buy, sell] of rows) {
    const code = CBE_NAMES[name!.trim()];
    const b = num(buy), s = num(sell);
    if (!code || !b || !s || !currencies.includes(code)) continue;
    ticks[`${code}_EGP`] = (b + s) / 2;
  }
  if (!Object.keys(ticks).length) throw new Error('the rate table did not read as expected');
  return { ticks, note: `${Object.keys(ticks).length} official rates, at the middle of buy and sell.` };
}

/**
 * Every open exchange-rate service quotes against the dollar, so what one currency is worth
 * in another is the ratio of their two dollar rates. Crossing it here rather than asking for
 * a table in the ledger's own currency keeps that currency in charge — and refuses plainly
 * when a source does not carry it, rather than quietly reporting in dollars.
 */
export function crossFromUsd(rates: Record<string, number>, base: string,
                             currencies: string[]): SourceResult {
  const perUsd = (code: string) => (code === 'USD' ? 1 : rates[code]);
  const basePerUsd = perUsd(base);
  if (!basePerUsd) throw new Error(`this source does not carry ${base}`);

  const ticks: Record<string, number> = {};
  for (const code of currencies) {
    const r = perUsd(code);
    if (r) ticks[`${code}_${base}`] = basePerUsd / r;
  }
  if (!Object.keys(ticks).length) throw new Error('none of your currencies were carried');
  return { ticks, note: `${Object.keys(ticks).length} rates, crossed through the dollar.` };
}

/** The open exchange-rate services answer in the same shape, so they share a reader. */
const fromUsdTable = (url: string, host: string) => async ({ base, currencies }: SourceCtx): Promise<SourceResult> => {
  const body = await wire(url, { allow: [host] });
  return crossFromUsd((JSON.parse(body).rates ?? {}) as Record<string, number>, base, currencies);
};

const erApi: Source = {
  id: 'er-api', subject: 'fx',
  label: 'ExchangeRate-API',
  what: 'A market rate averaged across data providers. Carries the Egyptian pound and most other currencies.',
  cadence: 'Once a day.',
  hosts: ['open.er-api.com'],
  fetch: fromUsdTable('https://open.er-api.com/v6/latest/USD', 'open.er-api.com'),
};

const fxRatesApi: Source = {
  id: 'fxratesapi', subject: 'fx',
  label: 'FXRatesAPI',
  what: 'A market rate that moves through the day rather than once. Carries the Egyptian pound.',
  cadence: 'Through the trading day.',
  hosts: ['api.fxratesapi.com'],
  fetch: fromUsdTable('https://api.fxratesapi.com/latest?base=USD', 'api.fxratesapi.com'),
};

const frankfurter: Source = {
  id: 'frankfurter', subject: 'fx',
  label: 'European Central Bank',
  what: 'The ECB reference rate. Authoritative for the euro, the pound and the dollar — it does not carry the Egyptian pound.',
  cadence: 'Once each working day, at about 16:00 in Frankfurt.',
  hosts: ['api.frankfurter.dev'],
  fetch: fromUsdTable('https://api.frankfurter.dev/v1/latest?base=USD', 'api.frankfurter.dev'),
};

/* ── gold and silver ────────────────────────────────────────────────────── */

/**
 * The dealer's table, as Egypt actually trades it.
 *
 * Local gold is not the world price converted: it carries a local premium and a workmanship
 * charge, and the two prices in each row are what the dealer sells at and what he buys back
 * at. What you own is worth the buy-back, so that is the one recorded — valuing a holding at
 * the price you would have to pay to replace it flatters it by the whole spread.
 */
export function parseIsagha(html: string, purities: string[],
                            key: (p: string) => string | null): SourceResult {
  const rows = html.matchAll(/<span>\s*عيار\s*(\d+)\s*<\/span>([\s\S]*?)<\/tr>/g);

  const ticks: Record<string, number> = {};
  let took = '';
  for (const [, purity, row] of rows) {
    if (!purities.includes(purity!)) continue;
    const nums = [...row!.matchAll(/([0-9][0-9,]*\.?[0-9]*)\s*ج\.م/g)].map((m) => num(m[1]));
    // sell first, then the day's change, then buy — the buy-back is the third figure
    const buy = nums[2] ?? nums[0];
    const k = key(purity!);
    if (!buy || !k) continue;
    ticks[k] = buy;
    took ||= purity!;
  }
  if (!Object.keys(ticks).length) throw new Error('the dealer table did not read as expected');
  return { ticks, note: `Cairo dealers, at the buy-back price for ${took}.` };
}

const isaghaTable = (url: string, purities: string[], key: (p: string) => string | null) =>
  async (): Promise<SourceResult> => {
    const html = await wire(url, { allow: ['market.isagha.com'], timeoutMs: 15_000 });
    return parseIsagha(html, purities, key);
  };

const isaghaGold: Source = {
  id: 'isagha', subject: 'gold', onlyBase: 'EGP',
  label: 'iSagha — Egyptian dealers',
  what: 'What gold changes hands for in Egypt, including the local premium. This is the price you would actually be paid.',
  cadence: 'Through the day, as the shops move.',
  hosts: ['market.isagha.com'],
  fetch: isaghaTable('https://market.isagha.com/prices', ['24', '22', '21', '18'],
                     (p) => (p === '24' ? 'gold_24k_g' : `gold_${p}k_g`)),
};

const isaghaSilver: Source = {
  id: 'isagha', subject: 'silver', onlyBase: 'EGP',
  label: 'iSagha — Egyptian dealers',
  what: 'What silver changes hands for in Egypt. Recorded at 999, the purity a gram is normally quoted in.',
  cadence: 'Through the day, as the shops move.',
  hosts: ['market.isagha.com'],
  fetch: isaghaTable('https://market.isagha.com/prices/silver', ['999'], () => 'silver_g'),
};

/**
 * A world price is quoted per troy ounce in dollars, so reaching a gram in your own currency
 * needs the dollar rate this ledger already holds. If there is none, that is said rather than
 * guessed — a metal price resting on an invented rate is worse than no metal price.
 */
const perGram = (usdPerOz: number, base: string, known: SourceCtx['known']) => {
  if (base === 'USD') return usdPerOz / GRAMS_PER_TROY_OUNCE;
  const rate = known(`USD_${base}`);
  if (!rate) throw new Error(`the dollar has no rate yet — record one, or use a source quoted in ${base}`);
  return (usdPerOz / GRAMS_PER_TROY_OUNCE) * rate;
};

const metalTicks = (subject: 'gold' | 'silver', oz: number, base: string,
                    known: SourceCtx['known']): Record<string, number> =>
  (subject === 'gold'
    ? { gold_oz_usd: oz, gold_24k_g: perGram(oz, base, known) }
    : { silver_oz_usd: oz, silver_g: perGram(oz, base, known) });

const goldApi = (subject: 'gold' | 'silver'): Source => ({
  id: 'gold-api', subject,
  label: 'Gold-API world spot',
  what: `The international spot price of ${subject}, converted to a gram at the dollar rate you hold. It carries no local premium.`,
  cadence: 'Through the trading day.',
  hosts: ['api.gold-api.com'],
  async fetch({ base, known }) {
    const symbol = subject === 'gold' ? 'XAU' : 'XAG';
    const body = await wire(`https://api.gold-api.com/price/${symbol}`, { allow: ['api.gold-api.com'] });
    const oz = num(String(JSON.parse(body).price));
    if (!oz) throw new Error('no price came back');
    return {
      ticks: metalTicks(subject, oz, base, known),
      note: `World spot $${oz.toFixed(2)} the ounce, converted at the dollar rate on file.`,
    };
  },
});

const goldPrice = (subject: 'gold' | 'silver'): Source => ({
  id: 'goldprice', subject,
  label: 'GoldPrice.org',
  what: `A second reading of the international spot price of ${subject}, converted the same way. Useful when the first is quiet.`,
  cadence: 'Through the trading day.',
  hosts: ['data-asg.goldprice.org'],
  async fetch({ base, known }) {
    const body = await wire('https://data-asg.goldprice.org/dbXRates/USD', {
      allow: ['data-asg.goldprice.org'],
      // the endpoint answers its own page and nobody else, so it is asked as that page
      headers: { referer: 'https://goldprice.org/', origin: 'https://goldprice.org' },
    });
    const item = (JSON.parse(body).items ?? [])[0] ?? {};
    const oz = num(String(subject === 'gold' ? item.xauPrice : item.xagPrice));
    if (!oz) throw new Error('no price came back');
    return {
      ticks: metalTicks(subject, oz, base, known),
      note: `World spot $${oz.toFixed(2)} the ounce, converted at the dollar rate on file.`,
    };
  },
});

/* ── shares ─────────────────────────────────────────────────────────────── */

const mubasher: Source = {
  id: 'mubasher', subject: 'stocks',
  label: 'Mubasher — Egyptian exchange',
  what: 'The last trade on the EGX, read from the page Mubasher publishes. It covers Egyptian names and nothing else.',
  cadence: 'Fifteen minutes behind the exchange.',
  hosts: ['www.mubasher.info'],
  async fetch({ tickers }) {
    const ticks: Record<string, number> = {};
    const missed: string[] = [];
    for (const ticker of tickers.slice(0, 40)) {
      try {
        const html = await wire(
          `https://www.mubasher.info/markets/EGX/stocks/${encodeURIComponent(ticker)}`,
          { allow: ['www.mubasher.info'], timeoutMs: 15_000 });
        const price = parseMubasher(html);
        if (price) ticks[`price_${ticker}`] = price; else missed.push(ticker);
      } catch { missed.push(ticker); }
      await pause(250);
    }
    if (!Object.keys(ticks).length) throw new Error('no price read for any of your holdings');
    return {
      ticks,
      note: missed.length
        ? `${Object.keys(ticks).length} priced. Not carried: ${missed.join(', ')}.`
        : `${Object.keys(ticks).length} priced, fifteen minutes behind the exchange.`,
    };
  },
};

/** The last traded price, out of the summary Mubasher prints at the top of a stock's page. */
export const parseMubasher = (html: string): number | undefined =>
  num(/market-summary__last-price[^>]*>\s*([0-9.,]+)/.exec(html)?.[1]);

const yahoo: Source = {
  id: 'yahoo', subject: 'stocks',
  label: 'Yahoo Finance',
  what: 'The last close for anything listed anywhere — Egyptian names, and the ones Mubasher does not carry.',
  cadence: 'Delayed, and it refuses when asked too quickly.',
  hosts: ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'],
  async fetch({ tickers }) {
    const ticks: Record<string, number> = {};
    const missed: string[] = [];
    for (const ticker of tickers.slice(0, 40)) {
      // A bare ticker in this ledger is an Egyptian one, which Yahoo suffixes.
      const symbols = ticker.includes('.') ? [ticker] : [`${ticker}.CA`, ticker];
      let got: number | undefined;
      for (const symbol of symbols) {
        for (const host of yahoo.hosts) {
          try {
            const body = await wire(
              `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`,
              { allow: yahoo.hosts });
            const meta = JSON.parse(body).chart?.result?.[0]?.meta ?? {};
            got = num(String(meta.regularMarketPrice ?? meta.previousClose));
          } catch { /* the next host, then the next symbol */ }
          if (got) break;
        }
        if (got) break;
      }
      if (got) ticks[`price_${ticker}`] = got; else missed.push(ticker);
      await pause(400);
    }
    if (!Object.keys(ticks).length) throw new Error('Yahoo answered nothing — it refuses when asked too often');
    return {
      ticks,
      note: missed.length ? `${Object.keys(ticks).length} priced. Not found: ${missed.join(', ')}.`
                          : `${Object.keys(ticks).length} priced.`,
    };
  },
};

/* ── typed in by hand ───────────────────────────────────────────────────── */

const byHand = (subject: Subject, what: string): Source => ({
  id: 'manual', subject, manual: true,
  label: 'You type it in',
  what,
  cadence: 'Whenever you say so, and never on its own.',
  hosts: [],
});

/**
 * Every source, in the order it is offered.
 *
 * Order matters twice: it is the order the interface lists them in, and — where falling back
 * is allowed — the order the next one is tried in when the chosen one is silent.
 */
export const SOURCES: Source[] = [
  cbe, erApi, fxRatesApi, frankfurter,
  byHand('fx', 'The rate your own bank gave you, which is the one your money actually moved at.'),

  isaghaGold, goldApi('gold'), goldPrice('gold'),
  byHand('gold', 'What your dealer quotes.'),

  isaghaSilver, goldApi('silver'), goldPrice('silver'),
  byHand('silver', 'What your dealer quotes.'),

  mubasher, yahoo,
  byHand('stocks', 'The price on your broker’s screen.'),
];

export const forSubject = (subject: Subject, base: string): Source[] =>
  SOURCES.filter((s) => s.subject === subject && (!s.onlyBase || s.onlyBase === base));

export const findSource = (subject: Subject, id: string): Source | undefined =>
  SOURCES.find((s) => s.subject === subject && s.id === id);

/** What each subject falls back to when nothing has been chosen. */
export const DEFAULT_SOURCE: Record<Subject, string> = {
  fx: 'cbe', gold: 'isagha', silver: 'isagha', stocks: 'mubasher',
};
