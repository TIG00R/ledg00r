# Codebase cleanup

A pass over the whole repository for dead code, unused assets, superseded
implementations and unused dependencies. Checkpoint commit `d2522d8` holds the state
this began from, so `git reset --hard d2522d8` undoes everything below.

## Summary

Audited: every tracked source file (189 of them) across `apps/api`, `apps/web`,
`apps/mcp` and the five `packages/*` workspaces; every static asset; every dependency
declared in the six package manifests; the design directory; and the reference graph
between them.

Removed: 739 lines net, across five commits. Fifty-three unused imports, a filtering
pipeline in two screens that the record table had already replaced, a destination
picker nothing rendered, several pieces of state whose setters had no callers, one
unused CSS token, one dead export, and one unused build dependency worth 32 packages
in the lockfile.

Fixed: three references to assets that no longer exist — the favicon, the
apple-touch icon and the image at the top of the README all pointed at files the
rebrand deleted.

Everything still passes: 946 Node tests, 565 web tests, the typecheck across all six
projects, and the production build. The web bundle is 4 kB smaller.

## Deleted files and assets

No files were deleted. Every source file in the repository has at least one importer,
and every static asset that ships is referenced. The four brand images under
`apps/web/public/brand/ledg00r/` are each used — logo and mascot, one of each per
theme.

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

## Items requiring manual review

These are real findings that were deliberately left alone. Each needs a decision that
is yours, not a mechanical one.

### `apps/web/src/components/Taxonomy.tsx` — 207 lines, now orphaned

`TaxonomyEditor` had exactly one importer, `screens/Settings.tsx`, and that import was
already unused before this pass — so removing the dead import left the component with
no consumer in `src` at all. It looks superseded by `Manager`.

Left in place because the repository was caught mid-refactor (the budgets and logs
screens were still uncommitted when this began), so it is not possible to tell from
the code whether the editor was retired or is between homes. Deleting it would also
mean deleting `apps/web/test/components/Taxonomy.test.tsx`, which is **untracked** —
git could not restore it.

To finish: if the editor is retired, delete the component and its test together. If it
is between homes, wire it back into Settings.

### `apps/api/src/registry-type.ts` — 11 lines, no importer

Exports `LedgerRegistry`, which nothing in the repository references. Its own comment
says the front end imports it for compile-time safety, but `apps/web/src/api.ts` calls
`createClient<any>()` — so the type safety the file describes is not actually wired up.

Left in place because it documents an intention rather than a leftover. It is
types-only and costs nothing at runtime. To finish: either wire `apps/web/src/api.ts`
to `createClient<LedgerRegistry>()`, which is what the file is for, or delete both the
file and the paragraph in `api.ts` that claims the wiring exists.

### `apps/web/src/screens/Placeholder.tsx` — no longer rendered

A "designed, not yet built" stub screen. Every entry in `NAV` now has a real screen in
`App.tsx`, so nothing renders it; only an untracked test imports it. It is scaffolding
for screens that do not exist yet, and the project is still adding screens. Left in
place; delete it when the screen list settles.

### `SUGGESTIONS` in `apps/web/src/screens/Settings.tsx` — 20 lines, unread

A list of eight feature ideas with written rationale, rendered by a panel that is gone.
It is dead by the compiler's reckoning, but it is authored product content rather than
machinery, and deleting it destroys the notes. Either put the panel back or move the
list somewhere it will be read.

### Ignored props

Three props are passed by callers and never read: `arriving` on `Balance`
(`components/Operations.tsx`, passed at line 106), `dm` on `PlanRow`
(`screens/AssetsView.tsx`, passed at line 822), and the `r` parameter of two `blocked`
callbacks in `components/GivingRecords.tsx`. Removing each is behaviour-neutral, but
each may equally be a distinction someone meant to draw and has not drawn yet — the
`arriving` flag in particular looks like an unfinished visual difference between money
leaving and money landing.

### Redundant workspace dependencies

Three packages declare a workspace dependency they never import: `packages/db` declares
`@ledger/contracts`, `packages/domain` declares `@ledger/engine`, and `apps/mcp`
declares `@ledger/db` (it reaches the database through `@ledger/api`). Removing them
saves no bytes — they are symlinks — and the Dockerfile's install stages depend on the
workspace graph, so the risk outweighs the tidiness. Noted rather than changed.

### Design mockups

`design/` holds 19 HTML artboards, a `canvas.json` describing their layout, and a
2.9 MB `ledger-dashboard.html`. Nothing in the build references any of it, and
`.dockerignore` excludes the whole directory. It is design reference material, not
code, so none of it was touched. Two observations:

- `CashCurrencies.dc.html` and `ledger-dashboard.html` are not listed in `canvas.json`,
  unlike the other 17 artboards.
- Six of the artboards reference `small_cur_egp.jpg`, `small_cur_eur.jpg`,
  `small_cur_gbp.png` and `small_cur_usd.jpg`, which were deleted in the working tree
  before this pass. Those mockups now have broken `<img>` tags. Restoring the images
  or editing the mockups is a call about the design archive, not cleanup.

### Icon table

Sixteen entries in the `ART` table of `components/Icon.tsx` are never named in source
— `beach`, `fuel`, `shirt`, `ticket` and the rest. They are **not** dead: icon names
are stored as data, in `nodes.icon`, `categories.icon` and `income_sources.icon`.
Reading `dummy.db` confirms exactly those values are held there. The whole table stays.

## Verification results

Baseline was recorded before any change and was fully green, so every result below is
a like-for-like comparison and there are no pre-existing failures to distinguish.

| Check | Baseline | After |
|---|---|---|
| `npm run typecheck` (6 projects) | pass | pass |
| `npm run test:node` | 946 passed, 0 failed | 946 passed, 0 failed |
| `npm run test:web` | 565 passed across 49 files | 565 passed across 49 files |
| `npm run build` | built, 580.36 kB / 164.77 kB gzip | built, 576.36 kB / 163.41 kB gzip |
| CSS bundle | 33.57 kB | 33.52 kB |

There is no linter configured in this repository — no eslint config, no lint script —
so no lint run is reported. In its place, `tsc --noUnusedLocals --noUnusedParameters`
was run over all six projects as a one-off (the flags were not added to any tsconfig);
that is what found most of what was removed. It now reports only the six deliberate
exceptions listed under ignored props and `SUGGESTIONS`.

Assets and routes were checked by running the app against the development ledger and
reading every screen: portfolio, accounts, income, expenses, budgets, stocks, assets,
giving, logs and settings all render their real figures. The only console error is
Vite's HMR websocket, which is the dev server and not the application. The built
`dist/` was checked for the brand images and the favicon path.

Each of the five commits was verified before the next began; the API change was caught
and corrected by the typecheck at that point (an import removed that was in fact used
three times), which is why the batches are small.

### One thing to know about your local install

Partway through, `npm ci` was run to confirm the lockfile change was sound. It
succeeded, but `npm ci` empties `node_modules` first — and the web test tooling
(`vitest`, `jsdom`, `@testing-library/*`, `@vitest/coverage-v8`) is not declared in any
manifest, so it was not reinstalled. It was put back with
`npm install --no-save vitest jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event @vitest/coverage-v8`,
which leaves `package.json` and `package-lock.json` untouched — the lockfile diff is
the drizzle-kit removal and nothing else, and the 565 web tests pass again.

The underlying fragility is worth knowing about: `apps/web/test/`,
`apps/web/vitest.config.ts` and `/tests/` are all gitignored, and the packages they
need are not declared anywhere. Any `npm ci` — including in CI, or on a fresh clone —
leaves the test suites unrunnable. Declaring those five packages as devDependencies of
`@ledger/web` would fix it without tracking the tests themselves.

## Remaining technical debt

- **The frozen filters.** `Expenses` and `GivingLog` each still hold a `q` search
  value whose setter is gone, so the filter it feeds is permanently a no-op. The
  minimal removal was taken; collapsing the remaining branch is a small logic
  simplification rather than a deletion, and was left out on purpose.
- **The client is untyped.** `createClient<any>()` in `apps/web/src/api.ts` gives up
  the compile-time link between the screens and the server's registry that both
  `packages/client` and `registry-type.ts` were built to provide.
- **The bundle is one chunk.** 576 kB, above Vite's 500 kB warning. Code-splitting by
  route would be natural here, since the screens are already switched on one value.
- **Test tooling is undeclared**, as described above.
- **Formatting note:** one line in `screens/Accounts.tsx` had stray spaces inside its
  import braces (`Row , Field ,`), normalised while removing `Empty` from that same
  line. It is the only whitespace change in the diff.
