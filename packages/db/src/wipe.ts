import type { Db } from './client.js';
import { forgetSequences } from './repo.js';

/**
 * Emptying a log, and emptying the whole ledger.
 *
 * Removing one record reverses the movement behind it and keeps both rows, because that is
 * what makes a ledger checkable. Emptying a log is the other gesture entirely: the answer to
 * "there should be nothing here" is nothing, not two hundred records and two hundred
 * reversals. So a clear erases the movements its records stand on, balances fall back to the
 * quantities their accounts opened with, and the table is genuinely empty.
 *
 * The two gestures are not rivals. One is a correction and says so; the other is asked for in
 * a dialog that spells out what is about to go and cannot be reached without saying yes.
 */

export interface LogSpec {
  /** what this log is called where a person is asked about it */
  label: string;
  /** what it holds, in a sentence, for the dialog that asks */
  what: string;
  /** the tables it owns; the first is the one whose rows are counted */
  tables: string[];
  /**
   * The column naming the movement behind each row, where the records moved money.
   *
   * Clearing such a log deletes those movements too — `legs` follow by cascade — which is
   * what returns the balances rather than leaving them standing on records that no longer
   * exist.
   */
  movementColumn?: string;
  /** kinds to drop from the search index */
  search?: string[];
  /** rows in `nodes` this log owns, named by the prefix of their ids */
  nodePrefix?: string;
}

/**
 * Every record log, named once.
 *
 * The per-log clear, the clear-everything, the Settings screen and the counts it shows all
 * read this, so none of them can offer a log another does not have.
 */
export const LOGS = {
  expenses: {
    label: 'Spending', what: 'every expense recorded, and the movements behind them',
    tables: ['expenses'], movementColumn: 'movement_id', search: ['expense'],
  },
  giving: {
    label: 'Giving', what: 'every record of giving, and the movements behind them',
    tables: ['charity'], movementColumn: 'movement_id', search: ['giving'],
  },
  orders: {
    label: 'Share orders', what: 'every order logged, and the movements behind them',
    tables: ['orders'], movementColumn: 'movement_id', search: ['order'],
  },
  metals: {
    label: 'Metal lots', what: 'every gold and silver lot, and the movements behind them',
    tables: ['gold_lots'], movementColumn: 'movement_id', search: ['lot'],
  },
  debts: {
    label: 'Debts', what: 'everything lent out and everything owed, with their movements',
    tables: ['debts'], nodePrefix: 'debt-',
  },
  plans: {
    label: 'Payment plans', what: 'every plan, every payment on one, and any autopay set up',
    tables: ['installments', 'plan_rules', 'autopay'], movementColumn: 'movement_id',
  },
  movements: {
    label: 'Movements', what: 'the movement log itself, and every record standing on it',
    tables: ['transactions'], search: ['movement'],
  },
  calendar: {
    label: 'Calendar entries', what: 'the entries you put on the calendar yourself',
    tables: ['calendar_entries'],
  },
  notes: {
    label: 'Share notes', what: 'everything written down about a share',
    tables: ['stock_notes'], search: ['note'],
  },
  dividends: {
    label: 'Dividends', what: 'every distribution recorded against a share',
    tables: ['stock_dividends'],
  },
  stocks: {
    label: 'The share notebook', what: 'the names you gave the tickers you follow',
    tables: ['stocks'],
  },
  budgets: {
    label: 'Budgets', what: 'every ceiling, and which destinations it covered',
    tables: ['budgets'],
  },
  reminders: {
    label: 'Reminders', what: 'everything being watched for, and what you dismissed',
    tables: ['reminders', 'dismissals'],
  },
  recurring: {
    label: 'Standing charges', what: 'every template that posts on its own',
    tables: ['recurring_templates'],
  },
  income: {
    label: 'Income sources', what: 'every source of income and its schedule',
    tables: ['income_sources'],
  },
  zakat: {
    label: 'Zakat years', what: 'every lunar year you have confirmed',
    tables: ['zakat_years'],
  },
  scenarios: {
    label: 'Scenarios', what: 'the what-ifs saved on the dashboards',
    tables: ['scenarios'],
  },
  actions: {
    label: 'The log of what was done', what: 'every act recorded, including the refusals',
    tables: ['actions'],
  },
  prices: {
    label: 'Prices', what: 'every rate and price this ledger has recorded',
    tables: ['market_ticks'],
  },
  marks: {
    label: 'Uploaded marks', what: 'every picture uploaded to stand as an icon',
    tables: ['images'],
  },
  statements: {
    label: 'Wealth statements', what: 'every daily snapshot saved, automatic or corrected by hand',
    tables: ['wealth_statements'],
  },
} satisfies Record<string, LogSpec>;

export type LogName = keyof typeof LOGS;

export const LOG_NAMES = Object.keys(LOGS) as LogName[];

/**
 * The record tables that stand on a movement.
 *
 * Clearing the movement log has to take these with it: a record whose movement is gone claims
 * something the balances no longer agree with, which is the one state this ledger must never
 * be left in.
 */
const MONEY_LOGS: LogName[] = ['expenses', 'giving', 'orders', 'metals', 'debts', 'plans'];

/** How many rows a log holds, counted on the table a person would say it is. */
export function countLog(db: Db, log: LogName): number {
  const row = db.$raw.prepare(`SELECT COUNT(*) AS n FROM "${LOGS[log].tables[0]}"`).get() as { n: number };
  return row.n;
}

export function countLogs(db: Db): Array<{
  log: LogName; label: string; what: string; count: number; movements: boolean;
}> {
  return LOG_NAMES.map((log) => ({
    log, label: LOGS[log].label, what: LOGS[log].what, count: countLog(db, log),
    /*
     * Whether emptying this log has two answers to choose between.
     *
     * Said here rather than worked out again by whatever is asking. A screen guessing from
     * the log's name which of them stand on movements is a screen that will guess wrong the
     * first time a log is added, and offer one answer where there are two.
     */
    movements: !!(LOGS[log] as LogSpec).movementColumn,
  }));
}

/**
 * Empty one log.
 *
 * Inside a single transaction, with foreign keys deferred to the end of it: the order rows
 * have to come out in would otherwise depend on which table references which, and deferring
 * lets the whole thing be judged once, when it is consistent again.
 */
export function clearLog(db: Db, log: LogName, opts: { movements?: boolean } = {}): number {
  const spec: LogSpec = LOGS[log];
  /**
   * Whether the movements behind the records go with them.
   *
   * They always did, and for most of what this is used for that is right: a record whose
   * movement is gone claims something the balances do not agree with. But it is not the only
   * thing "clear this log" can mean. A log imported twice, or kept in two places and now kept
   * in one, is a list of records that are wrong about money that really moved — and erasing
   * the movements there rewrites every balance in the ledger to undo spending that happened.
   * So the caller says which it means, and the movement log itself has no choice to make: it
   * is the movements.
   */
  const withMovements = opts.movements ?? true;
  let removed = 0;

  db.$raw.transaction(() => {
    db.$raw.exec('PRAGMA defer_foreign_keys = ON');

    // The movement log stands under every money record, so emptying it empties those first.
    if (log === 'movements') for (const other of MONEY_LOGS) removed += clearRows(db, LOGS[other], true);

    removed += clearRows(db, spec, withMovements || log === 'movements');
  })();

  forgetSequences();
  return removed;
}

/** Every record log, leaving accounts, destinations, currencies and settings standing. */
export function clearAllRecords(db: Db): number {
  let removed = 0;
  db.$raw.transaction(() => {
    db.$raw.exec('PRAGMA defer_foreign_keys = ON');
    for (const log of LOG_NAMES) removed += clearRows(db, LOGS[log], true);
  })();
  forgetSequences();
  return removed;
}

/**
 * Everything.
 *
 * Every row of every table, the search index included. What survives is the shape: the
 * schema, the record of which migrations have run — without which the next boot would try
 * them all again — and the three holdings the migrations create, which are structure rather
 * than data. Gold, silver and the brokerage wallet are how the application knows metal and
 * shares exist at all; a ledger without them is not an empty ledger, it is a broken one.
 */
export function destroyEverything(db: Db): { tables: number; rows: number } {
  const tables = db.$raw.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
      AND name NOT LIKE 'search_%'
      AND name NOT IN ('schema_version', 'search')
  `).all() as Array<{ name: string }>;

  let rows = 0;
  db.$raw.transaction(() => {
    db.$raw.exec('PRAGMA defer_foreign_keys = ON');
    for (const { name } of tables) rows += db.$raw.prepare(`DELETE FROM "${name}"`).run().changes;
    // the virtual table, never its shadows: FTS keeps its own storage consistent
    rows += db.$raw.prepare('DELETE FROM search').run().changes;
    // so the one autoincrementing id in the schema starts from the beginning again
    try { db.$raw.exec('DELETE FROM sqlite_sequence'); } catch { /* nothing autoincrements yet */ }
    ensureStructuralNodes(db);
  })();

  forgetSequences();
  return { tables: tables.length, rows };
}

/**
 * The holdings the migrations create, and the wipe puts back.
 *
 * They are the same three inserts that arrived with versions 8, 11 and 16, lifted here so the
 * migration and the wipe cannot disagree about what an empty ledger contains. `OR IGNORE`
 * throughout, so calling it against a ledger that already has them does nothing.
 */
export function ensureStructuralNodes(db: Db): void {
  db.$raw.exec(`
    INSERT OR IGNORE INTO nodes (id, kind, name, currency, unit, valuation, price_key, opening_qty)
      VALUES ('silver', 'asset', 'Silver', NULL, 'g', 'live_price', 'silver_g', 0);
    INSERT OR IGNORE INTO nodes (id, kind, name, currency, unit, valuation, price_key, opening_qty)
      VALUES ('gold', 'asset', 'Gold', NULL, 'g', 'live_price', 'gold_24k_g', 0);
    INSERT OR IGNORE INTO nodes (id, kind, name, parent_id, currency, valuation, price_key, opening_qty)
      VALUES ('brokerage-cash', 'cash', 'Brokerage wallet', NULL, 'EGP', 'face', 'brokerage_cash', 0);
    -- The clouds are a second wallet at the same broker: cash, held the same way, waiting
    -- for compound interest that has not been built yet. Until then it is exactly the
    -- brokerage wallet's own row, a second time, under its own name and its own key.
    INSERT OR IGNORE INTO nodes (id, kind, name, parent_id, currency, valuation, price_key, opening_qty)
      VALUES ('clouds-cash', 'cash', 'Clouds', NULL, 'EGP', 'face', 'clouds_cash', 0);
  `);
  // The book itself is structure too, on the same terms as the wallet it owns: an owner who
  // has never heard the word "exchange" still needs one for every order and every position to
  // belong to, and 'main' is the one this ledger has always had — the fixed id is what lets
  // every capability that touches the share book default to it without first looking it up.
  if (hasTable(db, 'exchanges')) {
    db.$raw.exec(`
      INSERT OR IGNORE INTO exchanges (id, name, wallet_node_id, clouds_node_id, archived, created_at)
        VALUES ('main', 'Main', 'brokerage-cash', 'clouds-cash', 0, '${new Date().toISOString()}');
    `);
  }
}

/** A table a migration earlier than this call may not have created yet. Checked, not assumed. */
function hasTable(db: Db, name: string): boolean {
  return !!db.$raw.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name);
}

/**
 * One log's rows, and everything that only exists because of them.
 *
 * The movements go before the records that name them, because the records are where the
 * movement ids are read from. Assumed to be running inside a transaction already.
 */
function clearRows(db: Db, spec: LogSpec, withMovements: boolean): number {
  if (spec.movementColumn && withMovements) {
    for (const table of spec.tables) {
      if (!hasColumn(db, table, spec.movementColumn)) continue;
      db.$raw.prepare(`
        DELETE FROM transactions WHERE id IN
          (SELECT "${spec.movementColumn}" FROM "${table}" WHERE "${spec.movementColumn}" IS NOT NULL)
      `).run();
    }
  }

  // A debt is held as a node, so the node goes with the record; nothing else would ever
  // remove it, and a stray one shows up in what you are worth.
  if (spec.nodePrefix && withMovements) {
    const ids = db.$raw.prepare('SELECT node_id AS id FROM debts').all() as Array<{ id: string }>;
    const del = db.$raw.prepare('DELETE FROM transactions WHERE id IN (SELECT transaction_id FROM legs WHERE from_node_id = ? OR to_node_id = ?)');
    for (const { id } of ids) del.run(id, id);
    db.$raw.prepare('DELETE FROM nodes WHERE id LIKE ?').run(`${spec.nodePrefix}%`);
  }

  let removed = 0;
  for (const table of spec.tables) {
    removed += db.$raw.prepare(`DELETE FROM "${table}"`).run().changes;
  }
  for (const kind of spec.search ?? []) {
    db.$raw.prepare('DELETE FROM search WHERE kind = ?').run(kind);
  }
  return removed;
}

/** A column a migration may not have added yet. Checked rather than assumed. */
function hasColumn(db: Db, table: string, column: string): boolean {
  const cols = db.$raw.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}
