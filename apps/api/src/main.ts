import { resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { makeApp } from './context.js';
import { buildRegistry } from './capabilities/index.js';
import { bearer, createApp, isLoopback } from './http.js';
import { authorise, readAuth } from './auth.js';
import { runTurn } from './chat.js';
import { assistantReady } from './capabilities/assistant.js';
import { createMcpHandler } from './mcp.js';
import { startScheduler } from './scheduler.js';
import { startMarketRefresh } from './market/refresh.js';
import { isEmpty, seed } from '@ledger/db';

/**
 * One process, one port.
 *
 * The bundle, the API and the MCP HTTP transport are served from the same origin, so the
 * whole thing is a single container with a single volume and no CORS to configure. The
 * scheduler runs inside it, which is what makes autopay and standing charges real rather
 * than promised.
 */
const PORT = Number(process.env.PORT ?? 8080);
const DATA = process.env.LEDGER_DATA ?? resolve(process.cwd(), 'data');
const DB_FILE = process.env.LEDGER_DB ?? resolve(DATA, 'ledger.db');
const WEB_ROOT = process.env.LEDGER_WEB ?? resolve(process.cwd(), 'apps/web/dist');

/**
 * Which ledger this is.
 *
 * Development is a copy of the demonstration fixture under `.dev/`, and it either opens that
 * or it does not open at all. Three places take a database path from the environment and a
 * path is easy to mistype; a ledger opened by accident is someone's actual money.
 */
const ENV = process.env.LEDGER_ENV ?? 'prod';
if (ENV === 'dev' && !DB_FILE.includes('/.dev/')) {
  console.error(`refusing to start: LEDGER_ENV=dev but the database is ${DB_FILE}`);
  console.error('development opens only a database under .dev/ — run `npm run dev:reset` first');
  process.exit(1);
}

if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });

const { db, ctx, ambient } = makeApp(DB_FILE);
const registry = buildRegistry(ambient);

if (await seedIfAsked()) console.log('seeded from the fixture');

const mcp = createMcpHandler(registry, ctx);

const server = createApp({
  registry,
  ctxOf: ctx,
  /**
   * A turn of conversation needs the registry it is a member of, which a capability cannot
   * reach from inside itself — so it is a route rather than a tool.
   */
  onAsk: async (question, history, c) => {
    const ready = assistantReady(c.db);
    if (!ready.ok) return { error: ready.why };
    try {
      return await runTurn(registry, c, question, history);
    } catch (e) {
      return { error: (e as Error).message };
    }
  },
  webRoot: existsSync(WEB_ROOT) ? WEB_ROOT : undefined,
  onMcp: (req, res) => {
    if (!req.url?.startsWith('/mcp')) return false;
    handleMcpHttp(req, res).catch((e) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: (e as Error).message }));
    });
    return true;
  },
});

async function handleMcpHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // The MCP transport answers to the same module as the API. Off means off for both.
  const check = authorise(db, { presented: bearer(req), loopback: isLoopback(req), now: new Date() });
  if (!check.ok) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: check.reason }));
    return;
  }

  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const msg = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  const out = await mcp(msg);

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(out ? JSON.stringify(out) : '');
}

/**
 * Prices go and look for themselves, on the interval the owner set and from the sources the
 * owner chose. Off is a setting like any other, and it is what the ledger does until asked.
 */
startMarketRefresh(ctx);

startScheduler(ctx, ({ posted, skipped, closed }) => {
  // What was paid and how much is the ledger's business, not the terminal's. Development
  // says it plainly because the money there is invented; production counts and stays quiet.
  if (ENV === 'dev') {
    for (const p of posted) console.log(`[scheduler] posted ${p.what}: ${p.amount}`);
    for (const s of skipped) console.warn(`[scheduler] skipped ${s.what} — ${s.because}`);
    for (const c of closed) console.log(`[scheduler] wealth statement ${c.date}: ${c.netWorth} ${c.currency}`);
  } else console.log(`[scheduler] posted ${posted.length}, skipped ${skipped.length}, closed ${closed.length}`);
});

server.listen(PORT, () => {
  console.log(`ledg00r on http://localhost:${PORT}`);
  console.log(`  ${Object.keys(registry).length} capabilities at /api, MCP at /mcp`);
  const auth = readAuth(db);
  console.log(auth.enabled
    ? '  authentication is on — calls need a key issued in Settings'
    : '  authentication is off — anything that can reach this port can read and write');
});

/**
 * Seeding.
 *
 * A fresh volume comes up with a working ledger rather than an empty one, but only when
 * asked and only when empty — mixing a fixture into real records is how a ledger stops being
 * trustworthy.
 */
async function seedIfAsked(): Promise<boolean> {
  if (!process.env.LEDGER_SEED) return false;
  if (!isEmpty(db)) return false;
  const mod = await import(process.env.LEDGER_SEED);
  // a module may offer the records with the warnings that go with them, or just the records
  seed(db, mod.seedSet ?? mod.dataset);
  const market = mod.market;
  if (market) {
    const at = new Date().toISOString();
    const ticks: Array<[string, number]> = [
      ['USD_EGP', market.usdEgp], ['gold_24k_g', market.goldPerG],
      ...Object.entries(market.fxRates ?? {}).map(([c, v]) => [`${c}_EGP`, v as number] as [string, number]),
      ...Object.entries(market.prices ?? {}).map(([t2, v]) => [`price_${t2}`, v as number] as [string, number]),
    ];
    if (market.goldPerOz) ticks.push(['gold_oz_usd', market.goldPerOz]);
    const stmt = db.$raw.prepare('INSERT INTO market_ticks (at, key, value, source, live) VALUES (?, ?, ?, ?, 1)');
    for (const [key, value] of ticks) stmt.run(at, key, value, 'fixture');
  }
  return true;
}
