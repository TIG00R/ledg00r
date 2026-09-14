/**
 * The one place this ledger reaches the outside world.
 *
 * Every request a price source makes goes through here, and here refuses anything that is
 * not on the list a source declared for itself. That is deliberate: the list of hosts is a
 * property of the code, not of a settings field, so no configuration a person types can
 * point this at somewhere it has no business being. It is also why the interface offers a
 * choice between named sources rather than a URL box — a URL box is an open socket with a
 * label on it.
 *
 * Answers are held for two minutes. A dashboard that redraws does not re-ask, and a refresh
 * of forty tickers does not turn into forty requests to the same page.
 */
const CACHE_MS = 2 * 60 * 1000;
const cache = new Map<string, { until: number; body: string }>();

/** Enough of a browser to be served the same page a person would be served. */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
         + '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export interface WireOptions {
  /** hosts this request may reach — anything else is refused before a socket is opened */
  allow: string[];
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export async function wire(url: string, opts: WireOptions): Promise<string> {
  const now = Date.now();
  const hit = cache.get(url);
  if (hit && hit.until > now) return hit.body;

  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('only https is fetched');
  if (!opts.allow.includes(parsed.host)) throw new Error(`${parsed.host} is not a host this source may reach`);

  const stop = AbortSignal.timeout(opts.timeoutMs ?? 12_000);
  const res = await fetch(url, {
    signal: stop,
    // A redirect is followed by hand or not at all. Following one automatically is how a
    // request that was checked against the allowlist ends up somewhere that never was.
    redirect: 'manual',
    headers: { 'user-agent': UA, accept: 'application/json,text/html,*/*', ...opts.headers },
  });

  if (res.status >= 300 && res.status < 400) {
    throw new Error(`${parsed.host} moved this page — the source needs updating`);
  }
  if (!res.ok) throw new Error(`${parsed.host} answered ${res.status}`);

  const body = await res.text();
  cache.set(url, { until: now + CACHE_MS, body });
  return body;
}

/** Sources that read a page rather than an API need the numbers out of it. */
export const num = (s: string | undefined): number | undefined => {
  if (s == null) return undefined;
  const n = Number(String(s).replace(/,/g, '').trim());
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** Yahoo in particular starts refusing when asked quickly, so tickers are spaced out. */
export const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const GRAMS_PER_TROY_OUNCE = 31.1034768;
