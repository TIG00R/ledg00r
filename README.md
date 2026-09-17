<p align="center">
  <img src="apps/web/public/brand/ledg00r/ledg00r-logo-light.png" alt="Ledg00r" width="320">
</p>

# Ledg00r

A personal ledger: what you own, what you owe, what moves between them, and what is coming.

## Features

- **A movement is the only thing that changes a balance.** The log is append-only; corrections
  are new movements that say so, never edits in place. Cash cannot be driven negative, and a
  cross-currency leg carries the rate that applied, frozen.
- **Accounts, assets and debts** across institutions and currencies — cash, liabilities,
  property, vehicles, gold and silver, shares, money lent and borrowed.
- **Zakat on the lunar calendar.** Intention is read before value: a home you live in is
  outside it, something bought to resell counts whole, jewellery worn is outside it. Nothing
  is owed until the amount passes nisab and a full lunar year has run.
- **Installments and standing charges**, with plans that can post themselves on the due date.
- **Budgets as pools.** A ceiling over a month, a quarter or a year, covering one destination
  or several that share the one figure — with a warning the moment a pool passes its ceiling,
  and the whole of it drawn over time, a line per destination in its own colour. Each ceiling
  keeps the currency it was set in, and each expense the currency it was paid in; conversion
  happens when a figure is drawn and nowhere else.
- **A log of what was done**, beside the log of what the money did. A rename, an archive, a
  restated balance, a refusal — none of those move anything, so none of them appear in the
  movements. Restating a balance in particular writes no movement at all: it says so, and the
  act is on the record here.
- **One calendar** for everything dated — paid and due, each asset's lunar year, the zakat
  date, your own entries — on screen and at `/calendar.ics` for a phone or a laptop.
- **Search across every log at once**, through one full-text index. Arabic is folded before
  indexing, so a note is findable typed either way.
- **Live rates and prices** for currencies, gold, silver and shares, from a chosen source or
  typed by hand — every figure recorded with where it came from.
- **An MCP server that is the API.** Every capability is declared once and becomes a tRPC
  procedure, an HTTP route and an MCP tool at the same time, so there is nothing a person can
  do through the screens that Claude cannot do through a tool. Every write takes `dryRun`,
  returns a receipt of which balances changed, and accepts an idempotency key.

## Installation

```bash
npm install
npm run build          # the web bundle
npm run dev:api        # serves it on :8080, empty
```

Open <http://localhost:8080>. The ledger starts with nothing in it and holds only what you
put there.

To look around a worked example instead, copy the demonstration ledger that ships with the
repository into place before the first run:

```bash
mkdir -p data
cp dummy.db data/ledger.db
npm run dev:api
```

`dummy.db` is a complete SQLite ledger of invented money — accounts across currencies,
property and a car, gold, shares, debts with installments, standing charges, giving records
and a set of market prices — enough for every screen to have something to show. It is a
copy, so anything you do to it is yours; delete `data/ledger.db` to start empty again, and
copy `dummy.db` over it again to start the demonstration over.

To work on the interface with hot reload, run the two separately:

```bash
npm run dev:api        # :8080
npm run dev            # :5273, proxying /api to :8080
```

### In a container

```bash
docker compose up --build -d
```

Then <http://localhost:8080>. One image, one volume at `/data`, one port.

Without compose:

```bash
docker build -t ledg00r .
docker run -d --name ledg00r -p 8080:8080 -v ledger-data:/data ledg00r
```

The container comes up empty. The data lives in the `ledger-data` volume rather than the
container, so replacing the image leaves it alone.

To start it on the demonstration ledger instead, put `dummy.db` into the volume and restart:

```bash
docker compose cp dummy.db ledger:/data/ledger.db
docker compose restart ledger
```

### As a tool for Claude

```bash
claude mcp add ledg00r -- npx tsx /path/to/ledger/apps/mcp/src/stdio.ts
```

Or over HTTP, at `/mcp` on the same port.

### Receipts in a chat window

The ledger is at its best when it is wherever you already are. Point an agent that lives in a
chat at the MCP server — Hermes or OpenClaw, over stdio or at `/mcp` — and photographing a
receipt becomes the whole act of recording an expense: send the picture into the bot chat, the
agent reads the total off it, asks whether to deduct it from your usual account, and writes the
movement once you say yes.

The first receipt asks which account it comes out of; that account is remembered as the
default, and every receipt after it asks a single question naming that account. Nothing is
written until you answer, and the reply carries the balance before and after — so tracking
every cent costs a photograph and one word.

The rules the agent follows for this are in [`skills/ledg00r/SKILL.md`](skills/ledg00r/SKILL.md),
which is also served as `ledger://skill`.

## Tests

The suite is not carried in this repository. It runs against the real code rather than
mocks, and each run opens its own SQLite database in memory and throws it away — so nothing
it does can reach a ledger you care about, and nothing it needs is shipped to you.

Nothing runs tests for you either. `npm run build` compiles the bundle and `docker build`
produces a runnable image without a single test having executed, so a broken change ships as
readily as a working one.

## Authentication

**There is no login, and there are no user accounts.** Ledg00r is built for one person on a
port they own: anything that can reach it can read and write.

An optional API key exists — Settings → Access issues one, and it goes in an
`Authorization: Bearer` header — but the requirement is **off by default**, and it is not a
substitute for putting the ledger behind something before exposing it to a network.

If you turn the requirement on and lose every key, `LEDGER_DISABLE_AUTH=1` on the server skips
every check and makes that screen reachable again.

## Environment

| Variable | What it does |
|---|---|
| `PORT` | default 8080 |
| `LEDGER_DATA` | where the database lives; default `./data` |
| `LEDGER_DB` | the file itself; default `$LEDGER_DATA/ledger.db` |
| `LEDGER_WEB` | the built bundle to serve; default `apps/web/dist` |
| `LEDGER_DISABLE_AUTH` | `1` skips every access check — the way back in after locking yourself out |
| `LEDGER_SEED` | a module exporting `seedSet` (or `dataset`), loaded only into an empty ledger. Unset by default: the ledger ships empty |
