#!/usr/bin/env -S npx tsx
import { resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { makeApp } from '@ledger/api/src/context.js';
import { buildRegistry } from '@ledger/api/src/capabilities/index.js';
import { createMcpHandler } from '@ledger/api/src/mcp.js';

/**
 * The MCP server over stdio, for Claude Code and Claude Desktop.
 *
 * The same registry the HTTP server exposes, reached without a network hop. Trust comes from
 * the pipe: a process that can write to this server's stdin is already running as the owner,
 * so there is no token to present.
 *
 * Nothing may be written to stdout except protocol messages — a stray console.log corrupts
 * the stream — so every diagnostic goes to stderr.
 */
const DATA = process.env.LEDGER_DATA ?? resolve(process.env.HOME ?? '.', '.ledg00r');
const DB_FILE = process.env.LEDGER_DB ?? resolve(DATA, 'ledger.db');
if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });

const { ctx, ambient } = makeApp(DB_FILE);
const registry = buildRegistry(ambient);
const handle = createMcpHandler(registry, ctx);

console.error(`ledg00r mcp: ${DB_FILE}, ${Object.keys(registry).length} capabilities`);

const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  const text = line.trim();
  if (!text) continue;
  try {
    const out = await handle(JSON.parse(text));
    if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch (e) {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0', id: null,
      error: { code: -32700, message: (e as Error).message },
    })}\n`);
  }
}
