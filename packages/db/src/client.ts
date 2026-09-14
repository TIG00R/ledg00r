import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema> & { $raw: Database.Database };

/**
 * Open the ledger.
 *
 * WAL because reads and the scheduler's writes overlap; foreign keys on because the schema
 * relies on them; a busy timeout so a write waiting on the scheduler waits rather than
 * failing. `:memory:` is what the tests use.
 */
export function openDb(file: string): Db {
  const raw = new Database(file);
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');
  raw.pragma('busy_timeout = 5000');
  raw.pragma('synchronous = NORMAL');
  const db = drizzle(raw, { schema });
  // the raw handle stays reachable: FTS5 and the projection upserts are hand-written SQL
  return Object.assign(db, { $raw: raw }) as Db;
}

/**
 * Full-text search over every log at once.
 *
 * One table fed by the writers, so the search box on each screen and the agent's
 * `ledger.search` tool hit the same index. `porter` stems English, so "flights" finds
 * "flight". Arabic needs more than the tokenizer offers — letters typed interchangeably are
 * folded in `search.ts` before the text ever reaches here — so the indexed columns hold
 * folded text and the `shown_` columns hold what was actually written.
 */
export const FTS_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(
  kind UNINDEXED,
  record_id UNINDEXED,
  occurred_on UNINDEXED,
  title,
  body,
  shown_title UNINDEXED,
  shown_body UNINDEXED,
  tokenize = 'porter unicode61 remove_diacritics 2'
);
`;

export function ensureFts(db: Db): void {
  db.$raw.exec(FTS_DDL);
}

/** Everything a write touches happens at once, projections included, or none of it does. */
export function inTransaction<T>(db: Db, fn: () => T): T {
  return db.$raw.transaction(fn)();
}

export { schema, sql };
