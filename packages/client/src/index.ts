import type { z } from 'zod';
import type { Capability, Registry } from '@ledger/contracts';

/**
 * The client.
 *
 * There is no hand-written method per capability, because a method written by hand is one
 * that can disagree with the schema it claims to call. Instead the registry's type is turned
 * into a shape whose keys are capability names and whose values take that capability's input
 * and return its output — so the compiler knows every call site, and a capability renamed on
 * the server breaks the caller here rather than at run time.
 */
export type Client<R extends Registry> = {
  [K in keyof R]: R[K] extends Capability<infer I, infer O>
    ? (input: z.input<I>, opts?: CallOptions) => Promise<z.output<O>>
    : never;
};

export interface CallOptions {
  /** a repeat of the same call must not post twice */
  idempotencyKey?: string;
  /** ask what would happen, without it happening */
  dryRun?: boolean;
  signal?: AbortSignal;
}

export interface ClientOptions {
  baseUrl?: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
  /** called when the ledger refuses or the network does */
  onError?: (name: string, error: LedgerError) => void;
}

export class LedgerError extends Error {
  constructor(readonly code: string, message: string, readonly remedy?: string, readonly issues?: unknown) {
    super(message);
    this.name = 'LedgerError';
  }
}

export function createClient<R extends Registry>(opts: ClientOptions = {}): Client<R> {
  const base = (opts.baseUrl ?? '/api').replace(/\/$/, '');
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);

  return new Proxy({} as Client<R>, {
    get: (_, name: string) => async (input: unknown, call: CallOptions = {}) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (opts.token) headers.authorization = `Bearer ${opts.token}`;
      if (call.idempotencyKey) headers['idempotency-key'] = call.idempotencyKey;
      if (call.dryRun) headers['x-dry-run'] = 'true';

      const res = await doFetch(`${base}/${name}`, {
        method: 'POST', headers, signal: call.signal,
        body: JSON.stringify(input ?? {}),
      });

      const body = await res.json().catch(() => ({ message: res.statusText }));
      if (!res.ok) {
        const err = new LedgerError(body.code ?? String(res.status), body.message ?? 'The ledger refused the call.',
                                    body.remedy, body.issues);
        opts.onError?.(name, err);
        throw err;
      }
      return body;
    },
  });
}

/**
 * A refusal is a value, not an exception.
 *
 * The ledger answers a rule it will not break with `{ ok: false }` and a stable code, so a
 * caller can act on it. This narrows that union without every call site repeating the check.
 */
export const refused = <T extends { ok: boolean }>(r: T): r is T & { ok: false } => r.ok === false;
export const succeeded = <T extends { ok: boolean }>(r: T): r is T & { ok: true } => r.ok === true;
