import { z } from 'zod';
import { command, query, Outcome } from '@ledger/contracts';
import type { AppCtx } from '../context.js';
import { noted, refusal } from './shared.js';
import { readAuth, writeAuth, issueKey, revokeKey, listKeys } from '../auth.js';

/**
 * Who may call this ledger.
 *
 * A module rather than a fixed policy: off, and nothing is checked; on, and every call from
 * outside this machine needs a key. It ships off, because the first thing an owner does is
 * open their own ledger and a key prompt there is an obstacle, not a protection.
 *
 * The moment it matters is when the ledger is handed to something else — an assistant, a
 * script, another machine. That is what the keys are for, and each one is shown once.
 */
export const accessCaps = (ctxOf: () => AppCtx) => [
  query({
    name: 'access.status',
    context: 'access',
    summary: 'Whether this ledger requires a key, and which keys exist.',
    detail: 'Keys are listed by label and prefix only. The key itself is shown once, when it is issued, and cannot be read back.',
    input: z.object({}),
    output: z.object({
      enabled: z.boolean(),
      trustLoopback: z.boolean(),
      keys: z.array(z.object({
        id: z.string(), label: z.string(), prefix: z.string(),
        createdAt: z.string(), lastUsedAt: z.string().nullable(), revoked: z.boolean(),
      })),
    }),
    handler: async () => {
      const { db } = ctxOf();
      return { ...readAuth(db), keys: listKeys(db) };
    },
  }),

  command({
    name: 'access.configure',
    context: 'access',
    summary: 'Turn the key requirement on or off.',
    detail: 'Turning it on with no key issued would lock every caller out, including the screens, so that is refused. Issue a key first.',
    input: z.object({
      enabled: z.boolean().optional(),
      trustLoopback: z.boolean().optional(),
    }),
    output: Outcome,
    handler: async (patch) => {
      const { db } = ctxOf();
      if (patch.enabled === true) {
        const usable = listKeys(db).filter((k) => !k.revoked);
        if (usable.length === 0) {
          return refusal('not_found', 'There is no key to authenticate with, so turning this on would lock everything out.',
                         'Issue a key first, copy it somewhere safe, then turn this on.');
        }
      }
      const next = writeAuth(db, patch);
      return noted(next.enabled
        ? `Authentication is on${next.trustLoopback ? ', except from this machine' : ''}`
        : 'Authentication is off — anything that can reach this port can read and write');
    },
  }),

  command({
    name: 'access.issueKey',
    context: 'access',
    summary: 'Issue an API key. It is shown once and cannot be read back.',
    detail: 'Give it a label naming what will hold it, so a key can be revoked later without guessing which one it was.',
    input: z.object({ label: z.string().min(1).max(60) }),
    output: z.object({
      id: z.string(), label: z.string(), key: z.string(), prefix: z.string(),
      createdAt: z.string(), warning: z.string(),
    }),
    handler: async ({ label }) => {
      const ctx = ctxOf();
      const issued = issueKey(ctx.db, label, ctx.now);
      return { ...issued, warning: 'Copy this now. It is stored only as a hash and cannot be shown again.' };
    },
  }),

  command({
    name: 'access.revokeKey',
    context: 'access',
    summary: 'Revoke a key. Anything holding it stops working immediately.',
    effect: 'irreversible',
    input: z.object({ keyId: z.string() }),
    output: Outcome,
    handler: async ({ keyId }) => {
      const ctx = ctxOf();
      if (!revokeKey(ctx.db, keyId, ctx.now)) {
        return refusal('not_found', 'There is no live key with that id.');
      }
      const left = listKeys(ctx.db).filter((k) => !k.revoked).length;
      const auth = readAuth(ctx.db);
      if (auth.enabled && left === 0) {
        // Revoking the last key while the requirement is on would lock everyone out, so the
        // requirement goes with it rather than the ledger becoming unreachable.
        writeAuth(ctx.db, { enabled: false });
        return noted('Key revoked. It was the last one, so authentication has been turned off rather than leaving the ledger unreachable.');
      }
      return noted(`Key revoked. ${left} still live.`);
    },
  }),
];
