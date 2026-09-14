import { z } from 'zod';
import { command, query, Outcome } from '@ledger/contracts';
import { schema as t } from '@ledger/db';
import { eq } from 'drizzle-orm';
import type { AppCtx } from '../context.js';
import { noted, refusal, newId } from './shared.js';

/**
 * Marks that are pictures.
 *
 * Anything with a mark — an institution, a currency, a destination, a source of income — may
 * carry an icon from the set or a picture of its own. A bank has a logo; no icon set contains
 * it, and asking someone to pick the nearest shape is asking them to accept a worse answer.
 *
 * The reference stored on the thing is `img:<id>`, so a caller that does not understand
 * pictures still sees a string it can pass around unharmed.
 */
const MAX_BYTES = 512 * 1024;
const ALLOWED = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'image/gif'];

export const markCaps = (ctxOf: () => AppCtx) => [
  command({
    name: 'mark.upload',
    context: 'marks',
    summary: 'Store a picture to use as a mark, and get back the reference to set on something.',
    detail: 'Send the file base64-encoded. PNG, JPEG, WebP, SVG or GIF, up to 512 KB. The reference looks like `img:abc123` and goes wherever an icon name would.',
    input: z.object({
      label: z.string().max(60).optional(),
      mime: z.string().max(40),
      data: z.string().min(1).describe('the file, base64-encoded, without a data: prefix'),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
    }),
    output: z.union([
      z.object({ ref: z.string(), id: z.string(), bytes: z.number() }),
      Outcome,
    ]),
    handler: async (input) => {
      const ctx = ctxOf();
      if (!ALLOWED.includes(input.mime)) {
        return refusal('immutable', `${input.mime} is not a picture this ledger stores.`,
                       `Use one of ${ALLOWED.join(', ')}.`);
      }
      const bytes = Buffer.from(input.data.replace(/^data:[^,]+,/, ''), 'base64');
      if (bytes.byteLength === 0) return refusal('immutable', 'That decoded to nothing.');
      if (bytes.byteLength > MAX_BYTES) {
        return refusal('immutable', `That is ${Math.round(bytes.byteLength / 1024)} KB, and the limit is 512 KB.`,
                       'Scale it down — a mark is never shown larger than about 48 pixels.');
      }
      const id = newId('img');
      ctx.db.insert(t.images).values({
        id, mime: input.mime, bytes, width: input.width ?? null, height: input.height ?? null,
        label: input.label ?? null, createdAt: ctx.now.toISOString(),
      }).run();
      return { ref: `img:${id}`, id, bytes: bytes.byteLength };
    },
  }),

  query({
    name: 'mark.list',
    context: 'marks',
    summary: 'The pictures stored as marks.',
    input: z.object({}),
    output: z.array(z.object({
      id: z.string(), ref: z.string(), mime: z.string(),
      label: z.string().nullable(), bytes: z.number(), createdAt: z.string(),
    })),
    handler: async () => {
      const { db } = ctxOf();
      return db.select().from(t.images).all().map((i) => ({
        id: i.id, ref: `img:${i.id}`, mime: i.mime, label: i.label,
        bytes: (i.bytes as Buffer).byteLength, createdAt: i.createdAt,
      }));
    },
  }),

  command({
    name: 'mark.delete',
    context: 'marks',
    summary: 'Remove a stored picture.',
    detail: 'Anything still using it falls back to a default icon rather than showing a gap.',
    effect: 'irreversible',
    input: z.object({ id: z.string() }),
    output: Outcome,
    handler: async ({ id }) => {
      const { db } = ctxOf();
      const row = db.select().from(t.images).where(eq(t.images.id, id)).get();
      if (!row) return refusal('not_found', 'There is no picture with that id.');
      db.delete(t.images).where(eq(t.images.id, id)).run();
      return noted(`${row.label ?? id} removed`);
    },
  }),
];
