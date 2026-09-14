import { z } from 'zod';

/**
 * One registry, three front doors.
 *
 * A capability is declared once — a name, a sentence saying what it does, an input schema, an
 * output schema, and a handler. From that single declaration come the tRPC procedure the web
 * app calls, the MCP tool an agent calls, and the OpenAPI route anything else calls. The
 * interface and the agent therefore run identical code; there is no second-class path for
 * either, and nothing can drift between them.
 *
 * The summary is written for a reader who cannot see the screen, because that is exactly the
 * situation an agent is in.
 */

/** What calling this does to the ledger. Travels into the MCP tool description. */
export type Effect = 'reads' | 'writes' | 'irreversible';

export interface Ctx {
  /** the moment the call is being made; injected so tests can pin the clock */
  now: Date;
  /** set when the caller has already been through a write on this key */
  idempotencyKey?: string;
  /** the caller is asking what would happen, not asking for it to happen */
  dryRun?: boolean;
}

export interface Capability<I extends z.ZodTypeAny = z.ZodTypeAny, O extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  summary: string;
  /** longer guidance, shown to an agent choosing between neighbouring tools */
  detail?: string;
  input: I;
  output: O;
  effect: Effect;
  /** grouping for the tool list and the OpenAPI tags */
  context: string;
  handler: (input: z.infer<I>, ctx: Ctx) => Promise<z.infer<O>>;
}

export function capability<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(c: Capability<I, O>): Capability<I, O> {
  return c;
}

/** A read. Never changes anything, so it needs no idempotency key and no confirmation. */
export const query = <I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  c: Omit<Capability<I, O>, 'effect'>,
): Capability<I, O> => capability({ ...c, effect: 'reads' });

/** A write. Returns a receipt saying what changed, because the caller may not have a screen. */
export const command = <I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  c: Omit<Capability<I, O>, 'effect'> & { effect?: Effect },
): Capability<I, O> => capability({ effect: 'writes', ...c });

export type Registry = Record<string, Capability>;

/** Every capability, grouped by the context that owns it. */
export function byContext(reg: Registry): Record<string, Capability[]> {
  const out: Record<string, Capability[]> = {};
  for (const cap of Object.values(reg)) (out[cap.context] ??= []).push(cap);
  for (const list of Object.values(out)) list.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
