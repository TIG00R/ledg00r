/** Display formatting. Locale is pinned to en-US, as the original app assumes. */

export const fmt = (n: number, dp = 0) =>
  n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });

/**
 * Millions to 2dp, thousands to a whole K, otherwise plain.
 *
 * DELIBERATE DEVIATION (DECISIONS Q5 / INVENTORY F-094): the original never divided
 * before appending "K", so 995,672 rendered as "995,672K". Display only; nothing
 * downstream parses the string.
 */
export function fmtM(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${fmt(Math.round(n / 1_000))}K`;
  return fmt(Math.round(n));
}

export const fmtUsd = (egp: number, rate: number) => `$${fmt(Math.round(egp / rate))}`;

export const signed = (n: number, dp = 0) => `${n < 0 ? '−' : '+'}${fmt(Math.abs(n), dp)}`;

export const pct = (n: number, dp = 1) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(dp)}%`;
