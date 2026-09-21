import type { Db } from './client.js';
import { FTS_DDL } from './client.js';
import { ensureStructuralNodes } from './wipe.js';

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
      ensureStructuralNodes(db);
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
      ensureStructuralNodes(db);
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
      ensureStructuralNodes(db);
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
  {
    version: 21,
    name: 'what a share paid out',
    up: (db) => db.$raw.exec(`
      CREATE TABLE IF NOT EXISTS stock_dividends (
        id         TEXT PRIMARY KEY,
        ticker     TEXT NOT NULL,
        year       INTEGER NOT NULL,
        months     TEXT NOT NULL DEFAULT '',
        kind       TEXT NOT NULL,
        amount     REAL NOT NULL,
        currency   TEXT,
        note       TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT);
      CREATE INDEX IF NOT EXISTS stock_div_ticker_year ON stock_dividends (ticker, year);
      CREATE UNIQUE INDEX IF NOT EXISTS stock_div_unique ON stock_dividends (ticker, year, kind);
    `),
  },
  {
    version: 22,
    name: 'a restated balance is not a movement',
    /**
     * Correcting a balance used to write a movement between the account and an adjustment
     * node called "Corrections", whose kind is `external` — and the money flow draws
     * anything external as a source of income, so every correction was reported as earnings
     * from a source nobody has.
     *
     * The movements are folded back into the accounts they restated: each account's opening
     * figure absorbs what its corrections moved, so every balance reads exactly what it read
     * before this ran, and the legs, the transactions and the adjustment node go.
     */
    up: (db) => db.$raw.exec(`
      UPDATE nodes SET opening_qty = opening_qty + COALESCE((
        SELECT SUM(COALESCE(l.qty_to, l.qty_from, 0))
        FROM legs l WHERE l.to_node_id = nodes.id AND l.from_node_id = 'adj-correction'
      ), 0) - COALESCE((
        SELECT SUM(COALESCE(l.qty_from, l.qty_to, 0))
        FROM legs l WHERE l.from_node_id = nodes.id AND l.to_node_id = 'adj-correction'
      ), 0)
      WHERE id IN (
        SELECT to_node_id FROM legs WHERE from_node_id = 'adj-correction'
        UNION
        SELECT from_node_id FROM legs WHERE to_node_id = 'adj-correction');

      DELETE FROM transactions WHERE id IN (
        SELECT transaction_id FROM legs
        WHERE from_node_id = 'adj-correction' OR to_node_id = 'adj-correction');
      DELETE FROM legs WHERE from_node_id = 'adj-correction' OR to_node_id = 'adj-correction';
      DELETE FROM nodes WHERE id = 'adj-correction';
    `),
  },
  {
    version: 23,
    name: 'a log of what was done',
    /**
     * Every command the ledger runs, recorded where it can be read back.
     *
     * The movements say what happened to the money. They cannot say what happened to
     * anything else — a rename, an archive, a restated balance, a refusal — and a restated
     * balance in particular now writes no movement at all. This is where those go.
     */
    up: (db) => db.$raw.exec(`
      CREATE TABLE IF NOT EXISTS actions (
        id          TEXT PRIMARY KEY,
        at          TEXT NOT NULL,
        capability  TEXT NOT NULL,
        context     TEXT NOT NULL,
        summary     TEXT NOT NULL,
        outcome     TEXT NOT NULL,
        input       TEXT,
        movement_id TEXT,
        subject_id  TEXT,
        source      TEXT NOT NULL DEFAULT 'api');
      CREATE INDEX IF NOT EXISTS action_at ON actions (at DESC);
      CREATE INDEX IF NOT EXISTS action_cap_at ON actions (capability, at DESC);
      CREATE INDEX IF NOT EXISTS action_outcome_at ON actions (outcome, at DESC);
    `),
  },
  {
    version: 24,
    name: 'budget pools',
    /**
     * A budget is a pool: a ceiling over a period, and the destinations it covers.
     *
     * A ceiling over one destination is a pool with one member, so nothing has to be
     * redesigned the first time two destinations belong to one ceiling — "Food" over both
     * groceries and eating out is the same object as "Groceries" alone. A destination may
     * sit in more than one pool; the screens say so rather than hiding the overlap.
     *
     * The ceiling carries the currency it was set in, because a ceiling is a decision made
     * in a currency and not a figure to be restated every time the display currency changes.
     */
    up: (db) => db.$raw.exec(`
      CREATE TABLE IF NOT EXISTS budgets (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        color      TEXT NOT NULL DEFAULT '#8A8578',
        icon       TEXT,
        period     TEXT NOT NULL,
        amount     REAL NOT NULL,
        currency   TEXT NOT NULL,
        -- the date the periods are counted from: which day a month turns over, which month
        -- a year does. Without it a quarterly ceiling has no answer to "which quarter".
        anchor     TEXT NOT NULL,
        -- how close to the ceiling is close enough to be warned, as a fraction
        warnAt     REAL NOT NULL DEFAULT 0.8,
        note       TEXT,
        archived   INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS budget_archived ON budgets (archived);

      CREATE TABLE IF NOT EXISTS budget_members (
        budget_id   TEXT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
        category_id TEXT NOT NULL,
        PRIMARY KEY (budget_id, category_id));
      CREATE INDEX IF NOT EXISTS budget_member_cat ON budget_members (category_id);
    `),
  },
  {
    version: 25,
    name: 'a destination says where it is usually paid from',
    /**
     * Which account a kind of spending normally comes out of.
     *
     * There was one answer for the whole ledger — the living-burn account in Settings — so
     * groceries off the debit card and a flight off the dollar account both opened on the
     * same account and one of them was corrected every time. The destination is the thing
     * that knows: it is chosen first, and everything else about the expense follows it.
     *
     * Null means the ledger's own default still applies, which is what every existing
     * destination keeps.
     */
    up: (db) => {
      // guarded the way every other added column here is: a step must survive being replayed
      // against a database whose version table was lost or rolled back
      try { db.$raw.exec('ALTER TABLE categories ADD COLUMN account_id TEXT'); }
      catch { /* already there */ }
    },
  },
  {
    version: 26,
    name: 'a debt remembers the rate it was lent at',
    /**
     * Money lent or borrowed in a foreign currency has to be worth something in the
     * ledger's own, and that has always been worked out at whatever rate happened to be
     * current when someone asked — so a dollar loan quietly grew or shrank in the totals
     * every time the dollar moved, with nothing recorded ever having actually changed. An
     * expense freezes its rate the day it is spent; a debt now does the same the day it is
     * lent or borrowed. Existing debts get no rate here — there is no honest way to know
     * what it was — and fall back to today's, visibly, until they are.
     */
    up: (db) => {
      try { db.$raw.exec('ALTER TABLE debts ADD COLUMN rate REAL'); }
      catch { /* already there */ }
    },
  },
  {
    version: 27,
    name: 'clouds — a second wallet, for now',
    /**
     * A place to save that will one day compound.
     *
     * Until the interest itself is built, a cloud is indistinguishable from the brokerage
     * wallet next to it: cash, held at the broker, read back the same way. It gets its own
     * node rather than a flag on the existing one, on exactly the terms `ensureStructuralNodes`
     * already gives the wallet — because the day compounding is built, this is the row it
     * has to grow out of, and a wallet wearing two hats would have made that harder, not
     * easier.
     */
    up: (db) => {
      ensureStructuralNodes(db);
    },
  },
  {
    version: 28,
    name: 'a ticker carries its own logo',
    /**
     * A company has a mark the icon set does not draw, the same way a bank does — so the
     * notebook's index of tickers gets the same column marks.ts already gave institutions:
     * an icon name, or `img:<id>` into the pictures table.
     */
    up: (db) => {
      try { db.$raw.exec('ALTER TABLE stocks ADD COLUMN logo TEXT'); }
      catch { /* already there */ }
    },
  },
  {
    version: 29,
    name: 'a sale remembers what it made, once',
    /**
     * What a sale earned against the average cost of every share behind it, at the moment it
     * was sold — the Stocks screen already works this average out to show a position, and a
     * sale now has it written to its own row rather than left to be re-derived from orders
     * that keep changing underneath it. Existing sales get no figure: there is no honest way
     * to know what the owner saw at the time, and backfilling one would show a number that
     * was never actually reported.
     */
    up: (db) => {
      for (const sql of [
        'ALTER TABLE orders ADD COLUMN realized_pnl REAL',
        'ALTER TABLE orders ADD COLUMN realized_pnl_pct REAL',
      ]) {
        try { db.$raw.exec(sql); } catch { /* already there */ }
      }
    },
  },
  {
    version: 30,
    name: 'a holding remembers the money it was bought with',
    /**
     * Most of what comes in here arrives in dollars, and buying gold or a share means turning
     * some of it into pounds first. The gold can go up in pounds while the dollar that bought
     * it went up more — a loss dressed as a gain, and nothing could tell the two apart because
     * every holding was only ever compared against its own currency. So a purchase now keeps
     * the account it came out of, that account's own currency, what actually left it, and the
     * rate applied that day — the same freezing a debt already does, for the same reason — so
     * the ledger can ask, alongside what a holding is worth today, what the money would be
     * worth now had it simply stayed where it was.
     *
     * Nothing is backfilled. A lot, a buy or an asset recorded before this column existed has
     * no honest rate to give it, and none is invented — it reads back as no source at all.
     */
    up: (db) => {
      for (const sql of [
        'ALTER TABLE gold_lots ADD COLUMN source_currency TEXT',
        'ALTER TABLE gold_lots ADD COLUMN source_amount REAL',
        'ALTER TABLE gold_lots ADD COLUMN source_rate REAL',
        'ALTER TABLE orders ADD COLUMN account_id TEXT',
        'ALTER TABLE orders ADD COLUMN source_currency TEXT',
        'ALTER TABLE orders ADD COLUMN source_amount REAL',
        'ALTER TABLE orders ADD COLUMN source_rate REAL',
        'ALTER TABLE nodes ADD COLUMN source_account_id TEXT',
        'ALTER TABLE nodes ADD COLUMN source_currency TEXT',
        'ALTER TABLE nodes ADD COLUMN source_amount REAL',
        'ALTER TABLE nodes ADD COLUMN source_rate REAL',
      ]) {
        try { db.$raw.exec(sql); } catch { /* already there */ }
      }
    },
  },
  {
    version: 31,
    name: 'an exchange above the book',
    /**
     * There was exactly one share book: one wallet, one set of orders, one set of positions,
     * all reached by an id nothing ever had to think about. An owner with money at more than
     * one broker needs more than one of each, so the book itself becomes a row that a wallet
     * and an order belong to, rather than the one thing there has only ever been one of.
     *
     * What already exists becomes the first exchange, called 'main' rather than something
     * generated, because every capability that touches the share book has to default to it —
     * and a default has to be a fixed id, not one looked up. It keeps the wallet and the
     * clouds wallet it always had, under the ids they always had, so nothing that already
     * pointed at `brokerage-cash` or `clouds-cash` moves. Every order already logged is given
     * to it too: the column's own DEFAULT does that for the rows already in the table, the
     * same way SQLite fills in any other NOT NULL column added with one.
     */
    up: (db) => {
      db.$raw.exec(`
        CREATE TABLE IF NOT EXISTS exchanges (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          wallet_node_id TEXT NOT NULL,
          clouds_node_id TEXT NOT NULL,
          archived INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL);
      `);
      try { db.$raw.exec("ALTER TABLE orders ADD COLUMN exchange_id TEXT NOT NULL DEFAULT 'main'"); }
      catch { /* already there */ }
      db.$raw.exec('CREATE INDEX IF NOT EXISTS ord_exchange ON orders (exchange_id, date)');
      ensureStructuralNodes(db);
    },
  },
  {
    version: 32,
    name: 'why a share is held',
    /**
     * Zakat is worked out from what a thing is held for, not from what it is — a gold lot
     * already carries this, a property already carries this, and a share held nothing at all.
     * The answer belongs to the ticker rather than to any one order, the same way a name or a
     * logo does: every order for it, and every position built from them, means the same
     * company. Left unset it reads back null, which the interface reads as "not stated" rather
     * than guessing at a default that was never actually chosen.
     */
    up: (db) => {
      try { db.$raw.exec('ALTER TABLE stocks ADD COLUMN intention TEXT'); }
      catch { /* already there */ }
    },
  },
  {
    version: 33,
    name: 'what a sale of metal cost to make',
    /**
     * A flat charge on a sale — the dealer's cut, the transfer — comes off what arrives, and
     * until now it was applied to the movement and then forgotten. The lot recorded the gross,
     * so correcting that sale afterwards reversed a smaller payment than it wrote back and
     * quietly handed the fee to the account, again on every correction. Kept on the lot, in
     * the account's own currency the way it was given, the correction can put back exactly
     * what the sale took.
     *
     * Existing rows read zero, which is what they were: no sale before this could carry one.
     */
    up: (db) => {
      try { db.$raw.exec('ALTER TABLE gold_lots ADD COLUMN fee REAL NOT NULL DEFAULT 0'); }
      catch { /* already there */ }
    },
  },
  {
    version: 34,
    name: 'what a lot cost, making included',
    /**
     * `total_egp` used to be the metal alone, and every reader added the making charge back on
     * top. Now the total is what the lot actually cost — the gram price and the making charge
     * summed before the weight multiplies them, which is how a dealer quotes it — and the
     * readers add nothing. Rows written under the old reading would be understated by exactly
     * the making charge, so they are brought up to the new one here.
     *
     * Which reading a row was written under is not recorded anywhere, so it is inferred from
     * the arithmetic rather than assumed: a row whose total is still the bare metal is an old
     * one, and a row whose total already carries the making charge is left alone. A row with
     * no making charge reads the same either way and is not touched at all.
     */
    up: (db) => {
      const lots = db.$raw.prepare(
        `SELECT id, direction, grams, price_per_gram AS price, total_egp AS total, making_egp AS making
           FROM gold_lots WHERE making_egp IS NOT NULL AND making_egp > 0`,
      ).all() as Array<{ id: string; direction: string; grams: number; price: number; total: number; making: number }>;
      const set = db.$raw.prepare('UPDATE gold_lots SET total_egp = ? WHERE id = ?');
      // A hundredth of a pound: enough to survive the rounding of a rate, far below the
      // making charge on any real lot.
      const near = (a: number, b: number) => Math.abs(a - b) < 0.01;
      for (const lot of lots) {
        const metalOnly = lot.grams * lot.price;
        if (!near(lot.total, metalOnly)) continue;
        // Buying, the making charge was paid on top; selling, it came out of what arrived.
        set.run(lot.direction === 'sell' ? metalOnly - lot.making : metalOnly + lot.making, lot.id);
      }
    },
  },
  {
    version: 35,
    name: 'a wealth statement, frozen at the month it closed',
    /**
     * Net worth read live moves every time a price does, so asking again tomorrow answers a
     * different figure for today. A timeline needs the opposite: what the answer was, written
     * once and left alone until someone deliberately corrects it — the same reading a
     * confirmed zakat year already gets.
     */
    up: (db) => db.$raw.exec(`
      CREATE TABLE IF NOT EXISTS wealth_statements (
        id         TEXT PRIMARY KEY,
        month      TEXT NOT NULL,
        date       TEXT NOT NULL,
        currency   TEXT NOT NULL,
        net_worth  REAL NOT NULL,
        allocation TEXT NOT NULL,
        source     TEXT NOT NULL DEFAULT 'auto',
        note       TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS wealth_stmt_month ON wealth_statements (month);
    `),
  },
  {
    version: 36,
    name: 'a wealth statement every day, not once a month',
    /**
     * A month was too coarse to say "at the end of each day" — the scheduler now writes one
     * row per day, so `date` is what a row is uniquely for, and `month` becomes a plain,
     * non-unique column kept only so a month or a year can be read by index rather than by
     * scanning `date` with `substr`.
     */
    up: (db) => db.$raw.exec(`
      DROP INDEX IF EXISTS wealth_stmt_month;
      CREATE UNIQUE INDEX IF NOT EXISTS wealth_stmt_date ON wealth_statements (date);
      CREATE INDEX IF NOT EXISTS wealth_stmt_month ON wealth_statements (month);
    `),
  },
  {
    version: 37,
    name: 'an order carries its own fee, and what it was bought for',
    /**
     * A broker charges for the order, not for each share in it, and that charge is real money
     * leaving the wallet — so it is kept on the order and read into the cost of a buy and out
     * of the proceeds of a sale. Intention moves here for the same reason it lives on a gold
     * lot rather than on "gold": shares of one ticker bought to keep and bought to trade are
     * two different answers, and the ticker cannot hold both.
     *
     * Nothing is backfilled. An order logged before this has no fee to find — zero is the
     * honest reading, since none was ever recorded — and no intention, which reads as not
     * stated rather than as either answer.
     */
    up: (db) => {
      for (const sql of [
        'ALTER TABLE orders ADD COLUMN fee REAL NOT NULL DEFAULT 0',
        'ALTER TABLE orders ADD COLUMN intention TEXT',
      ]) {
        try { db.$raw.exec(sql); } catch { /* already there */ }
      }
    },
  },
  {
    version: 38,
    name: 'an exchange wears its broker\'s mark',
    /**
     * A second book is a second broker, and a broker has a logo the same way a bank does.
     * The switch between books is read at a glance, and a picture is what makes that glance
     * work — so the mark is kept beside the name, in the same shape every other mark in this
     * ledger takes: an icon name, or `img:<id>`.
     */
    up: (db) => {
      try { db.$raw.exec('ALTER TABLE exchanges ADD COLUMN logo TEXT'); } catch { /* already there */ }
    },
  },
  {
    version: 39,
    name: 'a maintenance payment already made still went into the property',
    /**
     * A paid installment counts towards what the property is worth whatever it bought — a
     * maintenance charge, a service fee and a payment that buys a share of the building are
     * all money handed over for it. Every path that pays one writes it that way now.
     *
     * The payments made before that was settled do not say so. They were written with no
     * receiving side at all: the money left the account and arrived nowhere, so the
     * property's value — which is the walk of its own legs — stopped short of what the same
     * screens report as paid. A flat with three maintenance charges behind it read half a
     * million pounds under its own plan, and the zakat assessment, which reads the value,
     * repeated the difference.
     *
     * So the leg is pointed at the property it was always for. Only a payment the ledger
     * still calls paid, whose movement is a `installment` that has not been undone, and
     * whose property is still an asset on the books; nothing else is touched, and a leg that
     * already names where it went is left exactly as it is.
     */
    up: (db) => db.$raw.exec(`
      UPDATE legs
         SET to_node_id = (SELECT i.property_id FROM installments i
                            WHERE i.movement_id = legs.transaction_id),
             qty_to = COALESCE(qty_to, qty_from)
       WHERE to_node_id IS NULL
         AND from_node_id IS NOT NULL
         AND transaction_id IN (
           SELECT i.movement_id
             FROM installments i
             JOIN transactions tx ON tx.id = i.movement_id
             JOIN nodes n ON n.id = i.property_id AND n.kind = 'asset'
            WHERE i.paid_at IS NOT NULL
              AND i.movement_id IS NOT NULL
              AND tx.kind = 'installment'
              AND NOT EXISTS (SELECT 1 FROM transactions r WHERE r.corrects_id = tx.id))
    `),
  },
  {
    version: 40,
    name: 'autopay remembers the day it was switched on',
    /**
     * Arranging for a plan to pay itself is a promise about what happens next, not a claim
     * about what already happened. Without a date to start from, switching it on posted every
     * payment that had ever fallen due — a plan typed in with a year of history behind it
     * emptied the account in one tick and filled the log with payments nobody had made.
     *
     * The standing charges have answered this since they were written: a template added today
     * does not reach back and post last month. This is the same date, kept for the same
     * reason.
     *
     * An arrangement already switched on starts from today. Reading it as "always" is what
     * would make the upgrade itself post the backlog.
     */
    up: (db) => {
      try { db.$raw.exec('ALTER TABLE autopay ADD COLUMN since TEXT'); } catch { /* already there */ }
      db.$raw.prepare('UPDATE autopay SET since = ? WHERE since IS NULL')
        .run(new Date().toISOString().slice(0, 10));
    },
  },
  {
    version: 41,
    name: 'an asset remembers what it cost and what it sold for',
    /**
     * Selling something is the other half of owning it, and the ledger could not say it.
     *
     * What a thing is worth is a figure that moves — a flat is repriced, a car loses value —
     * so the asset's own quantity cannot answer "what did you pay for it" once anybody has
     * corrected it. `bought_for` is that first figure, frozen the day the thing was added, in
     * the currency it is held in; every asset already here is backfilled with what it opened
     * at, which is exactly what was typed when it was added.
     *
     * The rest is the sale: the day, the price and the currency it fetched, the account the
     * money landed in, and the figure the profit was measured against — what had been paid
     * towards it on a plan, or what it cost outright. Kept rather than recomputed, because a
     * profit worked out from today's prices two years after the sale is not the profit that
     * was made.
     */
    up: (db) => {
      for (const col of ['bought_for REAL', 'bought_currency TEXT', 'sold_on TEXT',
                         'sold_price REAL', 'sold_currency TEXT', 'sold_account_id TEXT',
                         'sold_basis REAL', 'sold_movement_id TEXT']) {
        try { db.$raw.exec(`ALTER TABLE nodes ADD COLUMN ${col}`); } catch { /* already there */ }
      }
      // An asset on a plan opens at nothing and grows with its payments, so there is no price
      // to remember; what it cost is the sum of what has been paid, which the plan already says.
      db.$raw.exec(`
        UPDATE nodes
           SET bought_for = opening_qty, bought_currency = currency
         WHERE kind = 'asset'
           AND bought_for IS NULL
           AND opening_qty > 0
           AND COALESCE(ownership, 'owned') <> 'installments'
      `);
    },
  },
  {
    version: 42,
    name: 'a year closes itself, and the reckoning takes the owner\'s own lines',
    /**
     * Two changes to the same screen, and both are about who decides.
     *
     * A year used to wait for a button. What is owed was settled the day the lunar year
     * closed, and asking someone to press Confirm before the ledger would say so meant a year
     * could sit closed and unrecorded for months. Years close themselves now; `manual` marks
     * the ones typed in for the record instead — a year from before this ledger existed,
     * where all that is remembered is what was owed and what was paid. `paid_manual` is that
     * remembered payment, counted beside the giving records booked against the year.
     *
     * And the reckoning was the ledger's alone. `zakat_entries` is the owner's half of it:
     * a line the ledger cannot see (coins kept elsewhere, a debt nobody recorded), or a
     * correction to one it worked out. An override keeps the computed figure beside it, so
     * what the arithmetic said is never lost and the change can be taken back.
     */
    up: (db) => {
      for (const col of ['manual INTEGER NOT NULL DEFAULT 0', 'paid_manual REAL NOT NULL DEFAULT 0']) {
        try { db.$raw.exec(`ALTER TABLE zakat_years ADD COLUMN ${col}`); } catch { /* already there */ }
      }
      db.$raw.exec(`
        CREATE TABLE IF NOT EXISTS zakat_entries (
          id          TEXT PRIMARY KEY,
          bucket      TEXT NOT NULL,
          /* the computed line this corrects, or null for a line the owner wrote */
          entry_id    TEXT,
          label       TEXT,
          grp         TEXT,
          sign        INTEGER NOT NULL DEFAULT 1,
          amount      REAL,
          removed     INTEGER NOT NULL DEFAULT 0,
          note        TEXT,
          created_at  TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS zakat_entry_target
          ON zakat_entries(bucket, entry_id) WHERE entry_id IS NOT NULL;
      `);
    },
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
