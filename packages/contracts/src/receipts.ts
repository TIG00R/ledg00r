import { z } from 'zod';
import { Currency, DateOnly } from './primitives.js';

/**
 * Ids on the way out are plain strings.
 *
 * Branding exists to stop one kind of id being passed where another belongs, which is a
 * hazard at a call site, not in a result. An id read back out of the ledger goes through the
 * input schema again the moment it is used, so branding it here would buy nothing and force
 * a cast at every boundary.
 */
const IdOut = z.string();

/**
 * What a write did.
 *
 * An agent cannot look at the screen afterwards, so every command says what it changed: the
 * movement it wrote, and each balance before and after. This is also what a dry run returns,
 * which is why the preview in the Move money panel and the answer an agent gets are produced
 * by the same code rather than by two implementations that agree until they do not.
 */
export const BalanceChange = z.object({
  nodeId: IdOut,
  name: z.string(),
  currency: Currency.optional(),
  unit: z.string().optional(),
  before: z.number(),
  after: z.number(),
});
export type BalanceChange = z.infer<typeof BalanceChange>;

export const Receipt = z.object({
  ok: z.literal(true),
  /** absent on a dry run, because nothing was written */
  movementId: IdOut.optional(),
  dryRun: z.boolean().default(false),
  kind: z.string(),
  date: DateOnly,
  summary: z.string(),
  changes: z.array(BalanceChange),
  /** anything the caller should know but which did not stop the write */
  warnings: z.array(z.string()).default([]),
});
export type Receipt = z.infer<typeof Receipt>;

/**
 * Why a write was refused.
 *
 * Refusals are values rather than thrown strings so an agent can act on them: `code` is
 * stable and matchable, `message` is for a person, and `remedy` says what would make the
 * same call succeed.
 */
export const Refusal = z.object({
  ok: z.literal(false),
  code: z.enum([
    'unbalanced', 'insufficient_funds', 'unknown_node', 'archived_node',
    'missing_rate', 'not_found', 'immutable', 'invalid_period', 'duplicate',
  ]),
  message: z.string(),
  remedy: z.string().optional(),
});
export type Refusal = z.infer<typeof Refusal>;

export const Outcome = z.discriminatedUnion('ok', [Receipt, Refusal]);
export type Outcome = z.infer<typeof Outcome>;
