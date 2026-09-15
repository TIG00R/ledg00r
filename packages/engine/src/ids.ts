/**
 * Random tails for readable ids.
 *
 * The ids in this ledger are meant to be read — `exp-mu26sl3u2asq` says what it names — so
 * they are a prefix, a moment, and a random tail rather than an opaque UUID. The tail is the
 * part that has to actually be random, because two records that collide on an id are two
 * records where one has quietly replaced the other, and a ledger that loses a row without
 * saying so is worse than one that refuses to write it.
 *
 * `Math.random().toString(36).slice(2, 6)` was doing this job and was wrong twice over. It
 * carried about four base-36 characters — roughly 1.7 million values, which at five hundred
 * records inside one millisecond collides about once in fifteen batches — and it was not even
 * reliably four: `Math.random()` returning 0.5 stringifies to `0.i`, and the slice then yields
 * a single character. The rare short tail is the dangerous half, because it is the one nobody
 * sees until two records share an id.
 *
 * What is here draws from the platform's cryptographic source, always emits exactly the length
 * asked for, and rejects the byte values that would make the first four letters of the
 * alphabet slightly likelier than the rest.
 */

/** lowercase alphanumeric, so an id stays one word however it is quoted */
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * The largest multiple of 36 that fits in a byte.
 *
 * 256 is not a multiple of 36, so mapping every byte with a modulo would make 0-3 land four
 * times in every 256 draws and the rest three. Discarding the 252-255 tail costs a redraw
 * about one time in sixty-four and makes every character equally likely.
 */
const LIMIT = 252;

/**
 * The most `getRandomValues` will fill in one call. Asking for more throws, so a long token
 * draws its bytes in several passes rather than one oversized request.
 */
const MAX_DRAW = 65_536;

/** Web Crypto, which Node and the browser both have — this file is used by both. */
function fill(bytes: Uint8Array): Uint8Array {
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function pool(size: number): Uint8Array {
  return fill(new Uint8Array(Math.min(Math.max(size, 8), MAX_DRAW)));
}

/**
 * A random string of exactly `length` characters.
 *
 * Ten characters is about 3.6 × 10^15 values, which at five hundred records in a millisecond
 * puts a collision somewhere around one in thirty trillion batches.
 */
export function randomToken(length = 10): string {
  if (length <= 0) return '';
  let out = '';
  // Asking for a little extra up front means the refill loop almost never runs.
  let bytes = pool(Math.ceil(length * 1.2) + 4);
  let i = 0;
  while (out.length < length) {
    if (i >= bytes.length) { bytes = pool(bytes.length); i = 0; }
    const b = bytes[i++]!;
    if (b >= LIMIT) continue;
    out += ALPHABET[b % 36];
  }
  return out;
}

/**
 * An id that says what it names, when it was made, and nothing else twice.
 *
 * The moment is in there for the same reason the prefix is: a person scanning the log can see
 * at a glance which of two records came first. It contributes nothing to uniqueness — that is
 * the tail's job alone, so that records written inside the same millisecond are as safe as
 * records written a year apart.
 */
export function newId(prefix: string, tailLength = 10): string {
  return `${prefix}-${Date.now().toString(36)}${randomToken(tailLength)}`;
}
