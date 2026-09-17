# Codebase cleanup

Two passes over the whole repository for dead code, unused assets, superseded
implementations and unused dependencies, and then a look at what the MCP server offers an
agent. Checkpoint commit `d2522d8` holds the state this began from, so
`git reset --hard d2522d8` undoes everything below.

## Summary

Audited: every tracked source file (189 of them) across `apps/api`, `apps/web`,
`apps/mcp` and the five `packages/*` workspaces; every static asset; every dependency
declared in the six package manifests; the design directory; and the reference graph
between them.

Removed, over two passes: 1,100 lines net. Fifty-three unused imports, a filtering pipeline
in two screens that the record table had already replaced, a destination picker nothing
rendered, several pieces of state whose setters had no callers, one unused CSS token, one
dead export, and one unused build dependency worth 32 packages in the lockfile — then, in a
second pass, three orphaned modules, an unread list of feature ideas, four arguments that
were passed and never read, and three workspace dependencies nothing imported.

Fixed: three references to assets that no longer exist — the favicon, the apple-touch icon
and the image at the top of the README all pointed at files the rebrand deleted. And the web
test tooling, which was installed but named in no manifest, so `npm ci` left both suites
unrunnable; it is a devDependency of the web workspace now.

Everything still passes: 946 Node tests, 554 web tests (565 before, less the eleven that
covered deleted code), the typecheck across all six projects, and the production build. The
web bundle is 4 kB smaller.

## Deleted files and assets

No asset was deleted. Every static asset that ships is referenced: the four brand images
under `apps/web/public/brand/ledg00r/` are each used — logo and mascot, one of each per
theme.

Three source files went, all in the second pass, each with no importer left in `src`:

| Path | What it was | Why it went |
|---|---|---|
| `apps/web/src/components/Taxonomy.tsx` | a 207-line editor for naming and colouring destinations | its only importer was `screens/Settings.tsx`, whose import of it was already dead; superseded by `Manager` |
| `apps/web/src/screens/Placeholder.tsx` | a "designed, not yet built" stub screen | every entry in `NAV` now has a real screen in `App.tsx`; nothing rendered it |
| `apps/api/src/registry-type.ts` | the registry's type, exported for the front end | nothing referenced `LedgerRegistry`; `apps/web/src/api.ts` calls `createClient<any>()`, so the wiring the file described was never made |

Their tests went with them — `apps/web/test/components/Taxonomy.test.tsx` and the
`Placeholder` block inside `apps/web/test/screens/Portfolio.test.tsx`. Both are untracked, so
git cannot restore them; that is why the first pass left them alone, and the owner asked for
them in the second.

Every source file that remains has at least one importer.

Three assets had already been deleted in the working tree before this pass
(`apps/web/public/logo.png`, `logo.jpeg`, `apple-touch-icon.png`, as part of the
rebrand). What this pass did was repair the references left pointing at them; see
below.

## Dead code removed

### The filtering the record table replaced — `screens/Expenses.tsx`, `screens/Income.tsx`

Both screens carried a complete filtering and sorting pipeline from before
`RecordTable` did that work itself: a search box, a destination filter and a span
filter whose setters no longer had callers; the derived list those filters produced;
the column descriptors; `useFilters`; and a `useSort` call whose entire result —
sorted rows, sort state, toggle — was read by nothing.

Evidence: `RecordTable` receives `rows={records}` directly, not the filtered list, and
filters its own columns (the panel hint on screen still says so). TypeScript's
`--noUnusedLocals` reported every binding in the chain as unread, and removing the
head of the chain cascaded cleanly to the tail with no other reference appearing.
Confirmed on screen afterwards: the Expenses table still renders its per-column filter
row.

Also removed from those two screens: the draft form state the operation panels
replaced (`draft`/`setDraft` on both, plus `logDate`, `draftStart`, `draftEnd`,
`picking`, `inCurrency` on Income), and `MONTH_NAMES`, a month-name table nothing read.

### `CategorySelect` — `screens/Expenses.tsx`

A 24-line component, not exported, never rendered, with no test against it. Replaced
by the destination field the record table draws.

### Reminder helpers with no panel behind them

`screens/Settings.tsx` kept `update` and `subjectLabel`, and `screens/Stocks.tsx` kept
`stockReminders`, `update`, `detail`, and an `alert` draft with its derived
`alertTicker` — all dead once the panels that rendered them moved. Their `reminders` /
`setReminders` context bindings went with them.

### Smaller remains of the same moves

- `screens/Accounts.tsx` — `cyc`, a 13-line colour cycler for institutions and
  currencies, with no caller; `setDrafts`, whose state is now read-only.
- `screens/Charity.tsx` — `cInfo` and `accountName`, two lookup helpers with no
  callers.
- `screens/Dashboards.tsx`, `screens/Assistant.tsx`, `screens/Logs.tsx`,
  `components/Operations.tsx` — unread names in context destructures.
- `components/Ledg00r.tsx` — `LEDG00R_ART`, an exported pair of image dimensions with
  no consumer anywhere in the repository.

### Unused imports

Fifty-three in total: seven in `apps/api` (across the giving, holdings, overview,
planning and spending capabilities, and the scheduler) and forty-six in `apps/web`.
Found with `tsc --noUnusedLocals --noUnusedParameters`, which the project's own
tsconfigs do not enable. Names only; nothing that runs was touched.

### Unused CSS token

`--positive-ink`, defined in both the light and dark blocks of
`apps/web/src/styles/tokens.css` and read by no rule and no inline style. Its
counterpart `--negative-ink` is read by `.btn.danger` and stays. Checked against
dynamically composed variables too — the three places that build a variable name at
runtime compose `--positive`, `--negative` or `--gold`, never an `-ink` variant.

## Dependencies removed

**`drizzle-kit`** (devDependency of `packages/db`). The schema is migrated by hand:
numbered steps of raw SQL in `packages/db/src/migrate.ts`, run on boot and guarded by
a version table. There is no `drizzle.config.*` anywhere in the repository, no npm
script that invokes the kit, and no import of it. Its only appearance was the manifest
line that installed it. Removing it drops 32 packages from the lockfile (the kit plus
its `@esbuild-kit` toolchain and `@drizzle-team/brocli`).

`drizzle-orm` itself is used heavily (18 import sites in `apps/api` alone) and stays.
Every other declared dependency was checked and is used: `lucide-react` (the whole
icon set), `better-sqlite3`, `zod`, `tsx`, `c8` (the coverage scripts),
`@types/better-sqlite3` (better-sqlite3 ships no types of its own), `react`,
`react-dom`, `vite`, `typescript`, `@vitejs/plugin-react`.

## References repaired

The rebrand deleted `logo.png` and `apple-touch-icon.png`, and three references kept
asking for them — a browser tab with no mark on it, an apple-touch icon that 404s, and
a broken image at the top of the README. Each now names a file that exists:

| Where | Was | Now |
|---|---|---|
| `apps/web/index.html` favicon | `/logo.png` | `/brand/ledg00r/ledg00r-mascot-light.png` |
| `apps/web/index.html` apple-touch | `/apple-touch-icon.png` | `/brand/ledg00r/ledg00r-mascot-light.png` |
| `README.md` header image | `apps/web/public/logo.png` | `apps/web/public/brand/ledg00r/ledg00r-logo-light.png` |

Verified in the built output: `apps/web/dist/brand/ledg00r/` contains all four images
and `dist/index.html` points into it.

## Resolved in the second pass

Everything the first pass left for a decision has since been decided. What went is in
**Deleted files and assets** above and in the two lists below; what stays is at the end.

### Also removed

- **`SUGGESTIONS`** in `screens/Settings.tsx` — a 20-line list of eight feature ideas with
  written rationale, rendered by a panel that is gone. It was left the first time because it
  is authored content rather than machinery; it is in git history if the ideas are wanted
  back.
- **Four arguments passed and never read.** `arriving` on `Balance`
  (`components/Operations.tsx`) and `dm` on `PlanRow` (`screens/AssetsView.tsx`), each dropped
  from the signature and from its one call site. The unused `r` parameter of two `blocked`
  callbacks in `components/GivingRecords.tsx`. And `now` on the exported
  `ledgerHoldings(db, now, market)` in `apps/api/src/valuation.ts` — four call sites in three
  files, plus two in `tests/api/read.test.ts`, which had to be updated by hand because they
  pass positionally and would otherwise have bound the market to the clock.
- **`MASCOT`** in `components/Ledg00r.tsx`, which became unused when `LEDG00R_ART` went. The
  wordmark's ratio is still written down because it is not square; the mascot is.
- **The frozen search in `screens/GivingLog.tsx`** — a `q` whose setter had gone, passed to
  `GivingRecords`. The prop is live, tested machinery and stays; the caller simply stops
  passing a permanently empty string.
- **Three workspace dependencies nothing imported**: `@ledger/contracts` from `packages/db`,
  `@ledger/engine` from `packages/domain`, and `@ledger/db` from `apps/mcp`, which reaches the
  database through `@ledger/api`. Verified with a full `npm ci` and the whole suite afterwards,
  since the Docker install stages read the workspace graph.

### Still standing, on purpose

- **Design mockups.** `design/` holds 19 HTML artboards, a `canvas.json` describing their
  layout, and a 2.9 MB `ledger-dashboard.html`. Nothing in the build references any of it and
  `.dockerignore` excludes the directory, so it was left untouched — it is a design archive,
  not code, and deleting it is a call about design history rather than about dead code. Two
  things in it are worth knowing:
  - `CashCurrencies.dc.html` and `ledger-dashboard.html` are not listed in `canvas.json`,
    unlike the other 17 artboards.
  - Six artboards reference `small_cur_egp.jpg`, `small_cur_eur.jpg`, `small_cur_gbp.png` and
    `small_cur_usd.jpg`, which were deleted in the working tree before this began. Those
    mockups now have broken `<img>` tags.
- **The icon table.** Sixteen entries in `ART` (`components/Icon.tsx`) are never named in
  source — `beach`, `fuel`, `shirt`, `ticket` and the rest. They are **not** dead: icon names
  are stored as data, in `nodes.icon`, `categories.icon` and `income_sources.icon`. Reading
  `dummy.db` confirms exactly those values are held there.
- **The `scenarios` table.** It exists in the schema and the seed loader and has no capability,
  no engine use and no screen. It is an unbuilt feature rather than a dead one; building it is
  not cleanup.

## What the agent can reach

Separate from the cleanup, and asked for afterwards: the MCP server was brought up to date
with the features added since its surface was last looked at.

The tools themselves needed nothing. They are the capability registry converted mechanically,
so budgets and the action log became tools the moment they became capabilities — 122 of them
before this, 125 after. What was stale was everything around them.

**Three capabilities filled real gaps:**

| Capability | What it answers |
|---|---|
| `budget.check` | what a purchase would do to every ceiling covering that destination — where each pool stands now, where it would stand afterwards, and whether it crosses. The budget half of a dry run: nothing is written. A destination under no ceiling answers `uncovered: true`, which is an answer rather than a failure. |
| `actions.summary` | the shape of a window of the log: how much moved money, how much moved nothing, what was refused, grouped by area, by capability and by whether a person or an agent asked. It matches what the Logs screen shows. |
| `action.read` | one act in full by id, with the movement it wrote resolved — including whether that movement has since been corrected, which is derived rather than stored. |

**Seven more resources.** The list described a ledger with no ceilings and no record of what
was changed; it now carries `budgets`, `debts`, `destinations`, `catalogue`, `actions`,
`calendar` and `settings` alongside the original six. `catalogue` and `destinations` are the
ones to read before a write, since they carry the ids everything is recorded against.

**Four more prompts**, joining the original three: `review_budgets`, `before_you_spend`,
`what_changed` and `where_the_money_goes`.

**The skill document** gained a Budgets section, a section on the log of what was done, and
the new names in its capability table and resource list — one file that the built-in
assistant, the `ledger://skill` resource and the `/skill.md` download all read, so none of
them can fall behind the others.

All three were exercised end to end over stdio MCP against a real ledger — a pool created,
a purchase checked against it, the act read back out of the log — and over HTTP, which serves
the same registry.

### Not added

- **Appearance and modules** are per-browser preferences in `localStorage`, not ledger state.
  An agent has no browser, and there is nothing on the server for it to read.
- **`scenarios`** has a table and no feature. Giving it capabilities would be building the
  feature, not exposing one.

## Verification results

Baseline was recorded before any change and was fully green, so every result below is
a like-for-like comparison and there are no pre-existing failures to distinguish.

| Check | Baseline | After |
|---|---|---|
| `npm run typecheck` (6 projects) | pass | pass |
| `npm run test:node` | 946 passed, 0 failed | 946 passed, 0 failed |
| `npm run test:web` | 565 passed across 49 files | 554 passed across 48 files |
| `npm run build` | built, 580.36 kB / 164.77 kB gzip | built, 576.30 kB / 163.40 kB gzip |
| CSS bundle | 33.57 kB | 33.52 kB |
| MCP tools / resources / prompts | 122 / 6 / 3 | 125 / 13 / 7 |

The eleven web tests that are gone covered `Taxonomy.tsx` and `Placeholder.tsx`, which were
deleted; no test was removed for failing or for looking unused.

There is no linter configured in this repository — no eslint config, no lint script — so no
lint run is reported. In its place, `tsc --noUnusedLocals --noUnusedParameters` was run over
all six projects as a one-off (the flags were not added to any tsconfig); that is what found
most of what was removed. **It now reports zero findings in all six projects**, where the
baseline had 106. Turning those two flags on permanently would keep it that way; they are
left off because that is a change to how the project builds, not a cleanup.

Assets and routes were checked by running the app against the development ledger and
reading every screen: portfolio, accounts, income, expenses, budgets, stocks, assets,
giving, logs and settings all render their real figures. The only console error is
Vite's HMR websocket, which is the dev server and not the application. The built
`dist/` was checked for the brand images and the favicon path.

Each commit was verified before the next began; the API change was caught and corrected by
the typecheck at that point (an import removed that was in fact used three times), which is
why the batches are small.

### The test tooling, and one thing that happened on the way

Partway through the first pass, `npm ci` was run to confirm a lockfile change was sound. It
succeeded, but `npm ci` empties `node_modules` first — and the web test tooling (`vitest`,
`jsdom`, `@testing-library/*`, `@vitest/coverage-v8`) was declared in no manifest, so it was
not reinstalled and both web suites stopped running. It was put back immediately with
`npm install --no-save`, which left `package.json` and `package-lock.json` untouched.

The underlying fragility is now fixed rather than noted: those five packages are
devDependencies of `@ledger/web`, at the versions that were already installed, and a clean
`npm ci` followed by `npm run test:web` was run to prove it. The tests themselves stay out of
the repository — `apps/web/test/`, `apps/web/vitest.config.ts` and `/tests/` are all still
gitignored — but what they need to run no longer does.

One consequence worth remembering: because those suites are untracked, `git` cannot restore
them. Three test edits were made by hand alongside the deletions — the `Placeholder` block
removed from `apps/web/test/screens/Portfolio.test.tsx`, the whole of
`apps/web/test/components/Taxonomy.test.tsx` deleted, and two `ledgerHoldings` call sites
updated in `tests/api/read.test.ts`.

## Remaining technical debt

- **The client is untyped.** `createClient<any>()` in `apps/web/src/api.ts` gives up the
  compile-time link between the screens and the server's registry that `packages/client` was
  built to provide. The type that described the missing half, `registry-type.ts`, has now been
  deleted as dead; wiring it properly means reintroducing it deliberately rather than leaving
  a file that claims a guarantee it does not give.
- **The bundle is one chunk.** 576 kB, above Vite's 500 kB warning. Code-splitting by route
  would be natural here, since the screens are already switched on one value.
- **`dummy.db` predates budgets.** The demonstration ledger has no pools in it, so the Budgets
  screen and `budgets.list` both come up empty against the ledger the README tells a newcomer
  to copy. It is generated by `tests/make-dummy.ts`, which is untracked.
- **The design archive has broken images**, as described above.
- **Formatting note:** one line in `screens/Accounts.tsx` had stray spaces inside its import
  braces (`Row , Field ,`), normalised while removing `Empty` from that same line. It is the
  only whitespace change in the diff.
