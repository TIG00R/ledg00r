import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { eq, isNull } from 'drizzle-orm';
import { schema as t, type Db } from '@ledger/db';
import { readPref, writePref } from './read.js';

/**
 * Authentication, as a module that can be switched off.
 *
 * It is off by default, and while it is off nothing is checked — not the loopback exception,
 * not a header, nothing. That is the point of a module: disabled means the code does not run,
 * rather than running and being lenient.
 *
 * Switched on, every call from anywhere must carry a key. Keys are issued here, shown once,
 * and stored only as a hash, so this table leaking does not hand anyone the ledger.
 */
export interface AuthSettings {
  enabled: boolean;
  /** loopback callers skip the check even when the module is on */
  trustLoopback: boolean;
}

export const DEFAULT_AUTH: AuthSettings = { enabled: false, trustLoopback: true };

export function readAuth(db: Db): AuthSettings {
  return { ...DEFAULT_AUTH, ...(readPref<Partial<AuthSettings>>(db, 'auth') ?? {}) };
}

export function writeAuth(db: Db, patch: Partial<AuthSettings>): AuthSettings {
  const next = { ...readAuth(db), ...patch };
  writePref(db, 'auth', next);
  return next;
}

const hash = (key: string) => createHash('sha256').update(key).digest('hex');

export interface IssuedKey { id: string; label: string; key: string; prefix: string; createdAt: string }

/**
 * Issue a key.
 *
 * The plain key is returned exactly once. `lg_` makes it recognisable in a log or a config
 * file, and the prefix stored alongside the hash lets the settings screen tell two keys apart
 * without ever holding either.
 */
export function issueKey(db: Db, label: string, now: Date): IssuedKey {
  const key = `lg_${randomBytes(24).toString('base64url')}`;
  const id = `key-${randomBytes(6).toString('hex')}`;
  const createdAt = now.toISOString();
  db.insert(t.apiKeys).values({
    id, label, hash: hash(key), prefix: key.slice(0, 10), createdAt,
  }).run();
  return { id, label, key, prefix: key.slice(0, 10), createdAt };
}

export function revokeKey(db: Db, id: string, now: Date): boolean {
  const row = db.select().from(t.apiKeys).where(eq(t.apiKeys.id, id)).get();
  if (!row || row.revokedAt) return false;
  db.update(t.apiKeys).set({ revokedAt: now.toISOString() }).where(eq(t.apiKeys.id, id)).run();
  return true;
}

export function listKeys(db: Db) {
  return db.select().from(t.apiKeys).all().map((k) => ({
    id: k.id, label: k.label, prefix: k.prefix, createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt, revoked: !!k.revokedAt,
  }));
}

/** Constant-time, so a wrong key cannot be narrowed down by how long the answer takes. */
function sameKey(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface AuthResult { ok: boolean; reason?: string; keyId?: string }

/**
 * May this call proceed?
 *
 * The order matters. The module being off is answered first and without looking at anything
 * else, so a disabled module costs nothing and cannot half-apply.
 */
export function authorise(db: Db, opts: { presented?: string; loopback: boolean; now: Date }): AuthResult {
  // The way back in. Turning the requirement on and then losing the only key would otherwise
  // lock the owner out of their own ledger with no way to reach the screen that turns it off,
  // so an environment variable — which needs access to the machine anyway — overrides it.
  if (process.env.LEDGER_DISABLE_AUTH === '1') return { ok: true };

  const auth = readAuth(db);
  if (!auth.enabled) return { ok: true };
  if (auth.trustLoopback && opts.loopback) return { ok: true };

  const presented = opts.presented?.trim();
  if (!presented) {
    return { ok: false, reason: 'This ledger requires a key. Send it as `Authorization: Bearer <key>`.' };
  }

  const candidate = hash(presented);
  const live = db.select().from(t.apiKeys).where(isNull(t.apiKeys.revokedAt)).all();
  const match = live.find((k) => sameKey(k.hash, candidate));
  if (!match) return { ok: false, reason: 'That key is not one this ledger issued, or it has been revoked.' };

  db.update(t.apiKeys).set({ lastUsedAt: opts.now.toISOString() }).where(eq(t.apiKeys.id, match.id)).run();
  return { ok: true, keyId: match.id };
}
