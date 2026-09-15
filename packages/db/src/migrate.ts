import type { Db } from './client.js';
import { FTS_DDL } from './client.js';

/**
 * Migrations, run on boot, idempotent.
 *
 * Each step is `CREATE ... IF NOT EXISTS` or guarded by the version table, so booting a
 * container twice against the same volume is a no-op rather than an error. The version
 * number is what lets a later release add a column without guessing whether it is there.
 */
interface Step { version: number; name: string; up: (db: Db) => void }

const STEPS: Step[] = [
  {
    version: 1,
    name: 'core tables',
    up: (db) => db.$raw.exec(`
      CREATE TABLE IF NOT EXISTS institutions (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, short_code TEXT NOT NULL,
        country TEXT NOT NULL, color TEXT NOT NULL, logo TEXT,
        archived INTEGER NOT NULL DEFAULT 0);

      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, parent_id TEXT,
        currency TEXT, unit TEXT, valuation TEXT NOT NULL, price_key TEXT,
        opening_qty REAL NOT NULL DEFAULT 0, color TEXT,
        archived INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS node_parent ON nodes(parent_id);
      CREATE INDEX IF NOT EXISTS node_kind ON nodes(kind, archived);

      CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY, seq INTEGER NOT NULL, date TEXT NOT NULL, kind TEXT NOT NULL,
        note TEXT, automatic INTEGER NOT NULL DEFAULT 0, corrects_id TEXT,
        idempotency_key TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE INDEX IF NOT EXISTS tx_date ON transactions(date);
      CREATE INDEX IF NOT EXISTS tx_kind_date ON transactions(kind, date);
      CREATE INDEX IF NOT EXISTS tx_seq ON transactions(seq);
      CREATE UNIQUE INDEX IF NOT EXISTS tx_idem ON transactions(idempotency_key)
        WHERE idempotency_key IS NOT NULL;

      CREATE TABLE IF NOT EXISTS legs (
        id TEXT PRIMARY KEY,
        transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL, date TEXT NOT NULL,
        from_node_id TEXT, to_node_id TEXT, qty_from REAL, qty_to REAL,
        rate_applied REAL, fee_qty REAL, fee_node_id TEXT, category_id TEXT);
      CREATE INDEX IF NOT EXISTS leg_tx ON legs(transaction_id);
      CREATE INDEX IF NOT EXISTS leg_from_date ON legs(from_node_id, date);
      CREATE INDEX IF NOT EXISTS leg_to_date ON legs(to_node_id, date);
      CREATE INDEX IF NOT EXISTS leg_cat_date ON legs(category_id, date);

      CREATE TABLE IF NOT EXISTS categories (
        id TEXT PRIMARY KEY, domain TEXT NOT NULL, name TEXT NOT NULL, color TEXT NOT NULL,
        icon TEXT, note TEXT, archived INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS cat_domain ON categories(domain, archived);
    `),
  },
  {
    version: 2,
    name: 'logs',
    up: (db) => db.$raw.exec(`
      CREATE TABLE IF NOT EXISTS expenses (
        id TEXT PRIMARY KEY, seq INTEGER NOT NULL, date TEXT NOT NULL, amount REAL NOT NULL,
        currency TEXT NOT NULL, egp_amount REAL NOT NULL, rate REAL, account_id TEXT,
        category_id TEXT NOT NULL, place TEXT, note TEXT, movement_id TEXT);
      CREATE INDEX IF NOT EXISTS exp_date ON expenses(date);
      CREATE INDEX IF NOT EXISTS exp_cat_date ON expenses(category_id, date);
      CREATE INDEX IF NOT EXISTS exp_acct_date ON expenses(account_id, date);

      CREATE TABLE IF NOT EXISTS charity (
        id TEXT PRIMARY KEY, seq INTEGER NOT NULL, date TEXT NOT NULL, egp REAL NOT NULL,
        usd REAL, currency TEXT NOT NULL DEFAULT 'EGP', account_id TEXT,
        category_id TEXT NOT NULL, note TEXT, is_zakat INTEGER NOT NULL DEFAULT 0,
        movement_id TEXT);
      CREATE INDEX IF NOT EXISTS give_kind_date ON charity(is_zakat, date);
      CREATE INDEX IF NOT EXISTS give_date ON charity(date);

      CREATE TABLE IF NOT EXISTS gold_lots (
        id TEXT PRIMARY KEY, seq INTEGER NOT NULL, date_text TEXT NOT NULL, date TEXT,
        direction TEXT NOT NULL DEFAULT 'buy', grams REAL NOT NULL,
        price_per_gram REAL NOT NULL, total_egp REAL NOT NULL,
        usd_paid REAL NOT NULL DEFAULT 0, account_id TEXT, movement_id TEXT);
      CREATE INDEX IF NOT EXISTS lot_date ON gold_lots(date);

      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY, seq INTEGER NOT NULL, date TEXT NOT NULL, time TEXT,
        ticker TEXT NOT NULL, side TEXT NOT NULL, shares REAL NOT NULL, price REAL NOT NULL,
        total REAL NOT NULL, status TEXT NOT NULL, movement_id TEXT);
      CREATE INDEX IF NOT EXISTS ord_ticker_date ON orders(ticker, date);
      CREATE INDEX IF NOT EXISTS ord_status ON orders(status, date);
    `),
  },
  {
    version: 3,
    name: 'plans and planning',
    up: (db) => db.$raw.exec(`
      CREATE TABLE IF NOT EXISTS plan_rules (
        id TEXT PRIMARY KEY, property_id TEXT NOT NULL, seq INTEGER NOT NULL,
        kind TEXT NOT NULL, interval_months INTEGER, amount_egp REAL NOT NULL,
        first_due_month TEXT NOT NULL, due_day_kind TEXT NOT NULL, due_day_num INTEGER,
        count INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS rule_property ON plan_rules(property_id, seq);

      CREATE TABLE IF NOT EXISTS installments (
        id TEXT PRIMARY KEY, property_id TEXT NOT NULL, rule_id TEXT,
        month_label TEXT NOT NULL, due_date TEXT, due_day_kind TEXT NOT NULL,
        due_day_num INTEGER, amount_egp REAL NOT NULL, note TEXT NOT NULL DEFAULT '',
        paid_at TEXT, movement_id TEXT);
      CREATE INDEX IF NOT EXISTS inst_due ON installments(due_date);
      CREATE INDEX IF NOT EXISTS inst_property_due ON installments(property_id, due_date);
      CREATE INDEX IF NOT EXISTS inst_unpaid ON installments(due_date) WHERE paid_at IS NULL;

      CREATE TABLE IF NOT EXISTS income_sources (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, amount REAL, currency TEXT NOT NULL,
        cadence TEXT NOT NULL, day_of_month TEXT, start_date TEXT, end_date TEXT,
        to_node_id TEXT NOT NULL, scheduled INTEGER NOT NULL DEFAULT 1, icon TEXT,
        color TEXT, archived INTEGER NOT NULL DEFAULT 0);

      CREATE TABLE IF NOT EXISTS recurring_templates (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, from_node_id TEXT, to_node_id TEXT,
        amount REAL, currency TEXT NOT NULL, cadence TEXT NOT NULL, day_of_month TEXT,
        start_date TEXT, end_date TEXT, category_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 1, internal INTEGER NOT NULL DEFAULT 0,
        note TEXT, last_posted_for TEXT);
      CREATE INDEX IF NOT EXISTS rec_enabled ON recurring_templates(enabled);

      CREATE TABLE IF NOT EXISTS reminders (
        id TEXT PRIMARY KEY, subject TEXT NOT NULL, subject_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 1, offset_value INTEGER NOT NULL DEFAULT 0,
        offset_unit TEXT NOT NULL DEFAULT 'days', note TEXT, direction TEXT,
        trigger_price REAL, cadence TEXT, grace_days INTEGER);
      CREATE INDEX IF NOT EXISTS rem_subject ON reminders(subject, subject_id);

      CREATE TABLE IF NOT EXISTS dismissals (
        event_id TEXT PRIMARY KEY, until TEXT, "on" TEXT NOT NULL);

      CREATE TABLE IF NOT EXISTS autopay (
        property_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0,
        from_node_id TEXT NOT NULL);

      CREATE TABLE IF NOT EXISTS scenarios (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, note TEXT, as_of TEXT,
        usd_egp REAL, gold_per_g REAL);

      CREATE TABLE IF NOT EXISTS preferences (
        key TEXT PRIMARY KEY, value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

      CREATE TABLE IF NOT EXISTS market_ticks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, key TEXT NOT NULL,
        value REAL NOT NULL, source TEXT, live INTEGER NOT NULL DEFAULT 1);
      CREATE INDEX IF NOT EXISTS tick_key_at ON market_ticks(key, at);
    `),
  },
  {
    version: 4,
    name: 'projections and search',
    up: (db) => {
      db.$raw.exec(`
        CREATE TABLE IF NOT EXISTS node_balances (
          node_id TEXT PRIMARY KEY, qty REAL NOT NULL, as_of TEXT NOT NULL);

        CREATE TABLE IF NOT EXISTS period_totals (
          context TEXT NOT NULL, bucket TEXT NOT NULL, key TEXT NOT NULL,
          currency TEXT NOT NULL, amount REAL NOT NULL, count INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (context, bucket, key, currency));
        CREATE INDEX IF NOT EXISTS pt_context_bucket ON period_totals(context, bucket);
      `);
      db.$raw.exec(FTS_DDL);
    },
  },
  {
    version: 5,
    name: 'api keys',
    up: (db) => db.$raw.exec(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        -- only the hash is stored: a key that can be read back out of the database is a key
        -- that leaks with a backup
        hash TEXT NOT NULL,
        prefix TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT);
      CREATE INDEX IF NOT EXISTS key_hash ON api_keys(hash) WHERE revoked_at IS NULL;
    `),
  },
  {
    version: 6,
    name: 'marks',
    up: (db) => db.$raw.exec(`
      CREATE TABLE IF NOT EXISTS images (
        id TEXT PRIMARY KEY,
        mime TEXT NOT NULL,
        bytes BLOB NOT NULL,
        width INTEGER,
        height INTEGER,
        label TEXT,
        created_at TEXT NOT NULL);
    `),
  },
  {
    version: 7,
    name: 'tags',
    up: (db) => db.$raw.exec(`
      CREATE TABLE IF NOT EXISTS tags (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        color TEXT NOT NULL,
        note TEXT);

      CREATE TABLE IF NOT EXISTS node_tags (
        node_id TEXT NOT NULL,
        tag_id TEXT NOT NULL,
        PRIMARY KEY (node_id, tag_id));
      CREATE INDEX IF NOT EXISTS node_tag_by_tag ON node_tags(tag_id);
    `),
  },
  {
    version: 8,
    name: 'metals and notes',
    up: (db) => {
      // A lot and an order both wanted somewhere to say why, and silver needed a holding of
      // its own rather than being folded into gold's.
      for (const sql of [
        "ALTER TABLE gold_lots ADD COLUMN note TEXT",
        "ALTER TABLE gold_lots ADD COLUMN metal TEXT NOT NULL DEFAULT 'gold'",
        "ALTER TABLE orders ADD COLUMN note TEXT",
        "ALTER TABLE installments ADD COLUMN kind TEXT NOT NULL DEFAULT 'installment'",
        "ALTER TABLE reminders ADD COLUMN due_date TEXT",
      ]) {
        try { db.$raw.exec(sql); } catch { /* already there */ }
      }
      db.$raw.exec(`
        INSERT OR IGNORE INTO nodes (id, kind, name, currency, unit, valuation, price_key, opening_qty)
        VALUES ('silver', 'asset', 'Silver', NULL, 'g', 'live_price', 'silver_g', 0);
      `);
    },
  },
  {
    version: 9,
    name: 'dashboard indexes',
    up: (db) => db.$raw.exec(`
      -- A dashboard asks the same three questions of every log: this month, this year, all
      -- time, grouped by where it went. These are the covering indexes for exactly that, so
      -- the answer is read from an index rather than assembled by scanning the table.
      CREATE INDEX IF NOT EXISTS exp_month
        ON expenses(substr(date, 1, 7), category_id, currency);
      CREATE INDEX IF NOT EXISTS exp_year
        ON expenses(substr(date, 1, 4), category_id, currency);
      CREATE INDEX IF NOT EXISTS give_month
        ON charity(substr(date, 1, 7), is_zakat, category_id);
      CREATE INDEX IF NOT EXISTS give_year
        ON charity(substr(date, 1, 4), is_zakat, category_id);
      CREATE INDEX IF NOT EXISTS tx_month_kind
        ON transactions(substr(date, 1, 7), kind);
      CREATE INDEX IF NOT EXISTS tx_year_kind
        ON transactions(substr(date, 1, 4), kind);
      CREATE INDEX IF NOT EXISTS leg_month
        ON legs(substr(date, 1, 7), from_node_id, to_node_id);

      -- The projection is what a dashboard actually reads; this orders it the way the
      -- screens ask for it rather than the way it was written.
      CREATE INDEX IF NOT EXISTS pt_key_bucket ON period_totals(context, key, bucket);
    `),
  },
  {
    version: 10,
    name: 'drop tags',
    up: (db) => db.$raw.exec(`
      -- Tags turned out to be a second way of saying what a name already says. Removing the
      -- tables rather than leaving them empty, so nothing reads a thing that is not there.
      DROP TABLE IF EXISTS node_tags;
      DROP TABLE IF EXISTS tags;
    `),
  },
  {
    version: 11,
    name: 'brokerage wallet and asset kinds',
    up: (db) => {
      // The brokerage wallet is money you hold, so it is a node like any other — but it
      // belongs to the share book rather than to a bank, which is why it hangs off no
      // institution and is filtered out of the accounts screen by that fact.
      db.$raw.exec(`
        INSERT OR IGNORE INTO nodes (id, kind, name, parent_id, currency, valuation, price_key, opening_qty)
        VALUES ('brokerage-cash', 'cash', 'Brokerage wallet', NULL, 'EGP', 'face', 'brokerage_cash', 0);
      `);
      for (const sql of [
        // Assets are one family — a flat, a car, anything bought on a plan or outright — so
        // they carry what kind they are and how they were paid for.
        "ALTER TABLE nodes ADD COLUMN asset_kind TEXT",
        "ALTER TABLE nodes ADD COLUMN ownership TEXT",
        "ALTER TABLE nodes ADD COLUMN icon TEXT",
      ]) {
        try { db.$raw.exec(sql); } catch { /* already there */ }
      }
      // Classify what is already there: anything with a payment plan against it is a
      // property bought on one, a car is a vehicle, and the rest keep their own counsel.
      db.$raw.exec(`
        UPDATE nodes SET asset_kind = 'property', ownership = 'installments'
        WHERE kind = 'asset' AND unit IS NULL AND asset_kind IS NULL
          AND id IN (SELECT DISTINCT property_id FROM installments);
        UPDATE nodes SET asset_kind = 'vehicle', ownership = 'owned'
        WHERE kind = 'asset' AND unit IS NULL AND asset_kind IS NULL
          AND (lower(name) LIKE '%car%' OR lower(id) LIKE '%car%');
        UPDATE nodes SET ownership = 'owned'
        WHERE kind = 'asset' AND unit IS NULL AND ownership IS NULL;
      `);
    },
  },
  {
    version: 12,
    name: 'debts',
    up: (db) => db.$raw.exec(`
      CREATE TABLE IF NOT EXISTS debts (
        id TEXT PRIMARY KEY,
        -- 'lent' is money that will come back to you; 'borrowed' is money that will not
        direction TEXT NOT NULL,
        counterparty TEXT NOT NULL,
        principal REAL NOT NULL,
        currency TEXT NOT NULL,
        started_on TEXT NOT NULL,
        due_on TEXT,
        note TEXT,
        -- the node this debt is held as, so it counts toward what you own or owe
        node_id TEXT NOT NULL,
        settled_at TEXT,
        -- a debt you have given up on stops counting toward zakat, and says why
        written_off_at TEXT,
        created_at TEXT NOT NULL);

      CREATE INDEX IF NOT EXISTS debt_open ON debts(direction, settled_at);
      CREATE INDEX IF NOT EXISTS debt_due ON debts(due_on) WHERE settled_at IS NULL;
    `),
  },
  {
    version: 13,
    name: 'installment pays from a named account',
    /**
     * Which account a payment comes out of belongs to the payment.
     *
     * It was decided at the moment of paying and forgotten immediately afterwards, so a
     * schedule could not say where next month's money is coming from, and a payment made out
     * of the wrong account could not be told apart from one made out of the right one.
     */
    up: (db) => {
      try { db.$raw.exec("ALTER TABLE installments ADD COLUMN pay_from TEXT"); } catch { /* already there */ }
    },
  },
  {
    version: 14,
    name: 'why a thing is held, and since when',
    /**
     * Zakat turns on intention, and intention has a date.
     *
     * A flat lived in, a flat let out and a flat held to resell are the same record with
     * three different answers, and the answer decides whether zakat reaches it at all. The
     * date matters as much as the answer: the lunar year runs from the day the intention was
     * formed, or from the day the amount passed nisab if that came later, so both are kept
     * rather than inferred from when the row happened to be written.
     */
    up: (db) => {
      for (const sql of [
        "ALTER TABLE nodes ADD COLUMN intention TEXT",
        "ALTER TABLE nodes ADD COLUMN intention_since TEXT",
        "ALTER TABLE nodes ADD COLUMN acquired_on TEXT",
        "ALTER TABLE nodes ADD COLUMN nisab_met_on TEXT",
        // a lot of metal is worn or held; the two are not zakated alike
        "ALTER TABLE gold_lots ADD COLUMN intention TEXT",
        // rent has to be attributable to the thing that earned it
        "ALTER TABLE income_sources ADD COLUMN asset_id TEXT",
      ]) {
        try { db.$raw.exec(sql); } catch { /* already there */ }
      }
      // What is already recorded keeps the safest reading of itself: a home is a home, a car
      // is driven, and metal is a holding. Anything else is stated by the owner.
      db.$raw.exec(`
        UPDATE nodes SET intention = 'live_in'
          WHERE kind = 'asset' AND unit IS NULL AND intention IS NULL AND asset_kind = 'property';
        UPDATE nodes SET intention = 'personal'
          WHERE kind = 'asset' AND unit IS NULL AND intention IS NULL AND asset_kind = 'vehicle';
        UPDATE nodes SET intention = 'personal'
          WHERE kind = 'asset' AND unit IS NULL AND intention IS NULL;
        UPDATE gold_lots SET intention = 'investment' WHERE intention IS NULL;
      `);
    },
  },
  {
    version: 15,
    name: 'the calendar keeps its own entries',
    /**
     * A calendar that only shows what the ledger derived is a report, not a calendar.
     *
     * The things an owner actually needs to remember — a contract signing, a viewing, a
     * meeting about one of these flats — are not implied by any movement, so there has to be
     * somewhere to put them. `lunar_annually` is a repeat of its own because an anniversary
     * in the lunar calendar drifts eleven days a year against this one.
     */
    up: (db) => db.$raw.exec(`
      CREATE TABLE IF NOT EXISTS calendar_entries (
        id TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        title TEXT NOT NULL,
        note TEXT,
        color TEXT,
        repeat TEXT NOT NULL DEFAULT 'none',
        remind_days INTEGER NOT NULL DEFAULT 0,
        amount REAL,
        currency TEXT,
        done_at TEXT,
        created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS cal_entry_date ON calendar_entries(date);
    `),
  },
  {
    version: 16,
    name: 'gold holding',
    up: (db) => {
      // Silver got a node of its own at version 8; gold never did, because until then it
      // came in with the fixtures and nobody started a ledger without them. A ledger that
      // begins empty has to be able to buy gold too, so the holding is created here on the
      // same terms as silver's — priced from the same market key the reader looks up.
      db.$raw.exec(`
        INSERT OR IGNORE INTO nodes (id, kind, name, currency, unit, valuation, price_key, opening_qty)
        VALUES ('gold', 'asset', 'Gold', NULL, 'g', 'live_price', 'gold_24k_g', 0);
      `);
    },
  },
  {
    version: 17,
    name: 'balances read from the log',
    up: (db) => {
      // The balance and totals tables were a cache of the movement log, kept in step by the
      // write path. Keeping them in step is the part that failed — an account's opening
      // quantity was left out when its first row was created — and a cache that can disagree
      // with the log is a second answer to a question that has one. Both are computed on
      // read now, so there is nothing left to drift and nothing left to reconcile.
      db.$raw.exec(`
        DROP TABLE IF EXISTS node_balances;
        DROP TABLE IF EXISTS period_totals;
        -- from_node_id and to_node_id are already indexed; the fee side never was, because
        -- nothing read it back on its own.
        CREATE INDEX IF NOT EXISTS leg_fee ON legs(fee_node_id);
      `);
    },
  },
  {
    version: 18,
    name: 'zakat years, confirmed and paid against',
    up: (db) => {
      // What is owed is fixed on the day the hawl closes. Working it out from today's prices
      // means it moves every time it is asked for, so a year the owner has confirmed is
      // written down — base, rate, thresholds, the prices behind them, and the lines that
      // made it. Only confirmed years get a row; one still being worked out is computed.
      db.$raw.exec(`
        CREATE TABLE IF NOT EXISTS zakat_years (
          id           TEXT PRIMARY KEY,
          bucket       TEXT NOT NULL,
          label        TEXT NOT NULL,
          start_on     TEXT NOT NULL,
          due_on       TEXT NOT NULL,
          due_hijri    TEXT NOT NULL,
          anchor_on    TEXT,
          base         REAL NOT NULL,
          due          REAL NOT NULL,
          nisab        REAL NOT NULL,
          basis        TEXT NOT NULL,
          gold_per_g   REAL,
          silver_per_g REAL,
          entries      TEXT NOT NULL,
          note         TEXT,
          confirmed_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS zy_bucket_due ON zakat_years (bucket, due_on);
        CREATE UNIQUE INDEX IF NOT EXISTS zy_unique ON zakat_years (bucket, due_on);
      `);

      // A zakat payment that names no year discharges nothing, because zakat is owed for a
      // particular year. Existing payments keep the flag and gain no year: which year they
      // paid is not recoverable, and guessing would credit the wrong one.
      try { db.$raw.exec('ALTER TABLE charity ADD COLUMN zakat_year_id TEXT'); } catch { /* already there */ }
      db.$raw.exec('CREATE INDEX IF NOT EXISTS give_year ON charity (zakat_year_id)');
    },
  },
  {
    version: 19,
    name: 'metal quoted in its own currency, with the making charge',
    up: (db) => {
      // A dealer quotes in dollars as readily as in pounds, and charges workmanship —
      // مصنعية — on top of the metal. The pound figures stay what every reading uses; these
      // say what was actually quoted, and what was paid for the work rather than the gram.
      for (const sql of [
        "ALTER TABLE gold_lots ADD COLUMN currency TEXT",
        "ALTER TABLE gold_lots ADD COLUMN price_native REAL",
        "ALTER TABLE gold_lots ADD COLUMN making_per_gram REAL NOT NULL DEFAULT 0",
        "ALTER TABLE gold_lots ADD COLUMN making_egp REAL NOT NULL DEFAULT 0",
      ]) {
        try { db.$raw.exec(sql); } catch { /* already there */ }
      }
      // Everything recorded before this was quoted in pounds, because nothing else was on
      // offer — saying so is better than leaving the column empty for a reader to guess at.
      db.$raw.exec("UPDATE gold_lots SET currency = 'EGP' WHERE currency IS NULL");
      db.$raw.exec('UPDATE gold_lots SET price_native = price_per_gram WHERE price_native IS NULL');
    },
  },
  {
    version: 20,
    name: 'the share notebook',
    up: (db) => db.$raw.exec(`
      CREATE TABLE IF NOT EXISTS stocks (
        ticker     TEXT PRIMARY KEY,
        name       TEXT,
        created_at TEXT NOT NULL);

      CREATE TABLE IF NOT EXISTS stock_notes (
        id         TEXT PRIMARY KEY,
        ticker     TEXT NOT NULL,
        date       TEXT NOT NULL,
        note       TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT);
      CREATE INDEX IF NOT EXISTS stock_note_ticker_date ON stock_notes (ticker, date);
      CREATE INDEX IF NOT EXISTS stock_note_date ON stock_notes (date);
    `),
  },
];

export function migrate(db: Db): { from: number; to: number; applied: string[] } {
  db.$raw.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, name TEXT, at TEXT)');
  const row = db.$raw.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null };
  const from = row?.v ?? 0;
  const applied: string[] = [];

  for (const step of STEPS) {
    if (step.version <= from) continue;
    db.$raw.transaction(() => {
      step.up(db);
      db.$raw.prepare('INSERT INTO schema_version (version, name, at) VALUES (?, ?, ?)')
        .run(step.version, step.name, new Date().toISOString());
    })();
    applied.push(`${step.version}. ${step.name}`);
  }
  return { from, to: STEPS.at(-1)!.version, applied };
}
