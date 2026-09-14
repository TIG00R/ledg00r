import { AsyncLocalStorage } from 'node:async_hooks';
import { openDb, migrate, ensureFts, ledgerView, type Db } from '@ledger/db';

/**
 * What a capability handler is given.
 *
 * One database handle for the process, a clock that tests can pin, and the ledger view the
 * domain validates against. Handlers receive this rather than reaching for a module-level
 * singleton, which is what lets the same handlers run under the API, the MCP server and a
 * test with an in-memory database.
 */
export interface AppCtx {
  db: Db;
  now: Date;
  idempotencyKey?: string;
  dryRun?: boolean;
  ledger: () => ReturnType<typeof ledgerView>;
}

/**
 * The context of the call in flight.
 *
 * A handler is written against `ctxOf()` rather than being handed a context, so the same
 * handler reads naturally whether it was reached over HTTP, over MCP, or from a test. What
 * makes that safe under concurrent calls is this store: each invocation runs inside its own
 * scope, so one request's idempotency key or dry-run flag can never leak into another's.
 */
const current = new AsyncLocalStorage<AppCtx>();

export function withCtx<T>(ctx: AppCtx, fn: () => T): T {
  return current.run(ctx, fn);
}

export function makeApp(file: string): {
  db: Db;
  ctx: (over?: Partial<AppCtx>) => AppCtx;
  /** what a handler reads: the call in flight, or a bare context outside one */
  ambient: () => AppCtx;
} {
  const db = openDb(file);
  migrate(db);
  ensureFts(db);
  const base = (over: Partial<AppCtx> = {}): AppCtx => ({
    db,
    now: over.now ?? new Date(),
    idempotencyKey: over.idempotencyKey,
    dryRun: over.dryRun,
    ledger: () => ledgerView(db),
  });

  return { db, ctx: base, ambient: () => current.getStore() ?? base() };
}
