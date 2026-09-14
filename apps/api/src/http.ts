import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';
import type { Registry, Capability } from '@ledger/contracts';
import { withCtx, type AppCtx } from './context.js';
import { authorise } from './auth.js';
import { buildCalendar } from './capabilities/calendar.js';
import { toIcs } from '@ledger/engine';
import { skillText } from './skill.js';

/**
 * The HTTP surface.
 *
 * Every capability is reachable at `/api/<name>`, taking its input as JSON and answering
 * with its output. There is no hand-written route per capability, because a route written by
 * hand is a route that can disagree with the schema it claims to implement.
 *
 * The static bundle is served from the same origin, which is what lets the whole thing be
 * one container on one port with no CORS to configure.
 */
export interface ServeOptions {
  registry: Registry;
  ctxOf: (over?: Partial<AppCtx>) => AppCtx;
  webRoot?: string;
  onMcp?: (req: IncomingMessage, res: ServerResponse) => boolean;
  /** one turn of the built-in assistant; it needs the registry, so it lives outside it */
  onAsk?: (
    question: string,
    history: Array<{ role: 'user' | 'assistant'; text: string }>,
    ctx: AppCtx,
  ) => Promise<unknown>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

export function createApp(opts: ServeOptions) {
  const { registry, ctxOf, webRoot } = opts;

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    try {
      if (opts.onMcp?.(req, res)) return;

      if (url.pathname === '/health') {
        return json(res, 200, { ok: true, capabilities: Object.keys(registry).length });
      }

      // Marks are served as ordinary images so a page can put one in an <img>. They are
      // immutable once stored — a new picture gets a new id — so they cache forever.
      if (url.pathname.startsWith('/marks/')) {
        const ctx = ctxOf();
        const row = ctx.db.$raw.prepare('SELECT mime, bytes FROM images WHERE id = ?')
          .get(url.pathname.slice('/marks/'.length)) as { mime: string; bytes: Buffer } | undefined;
        if (!row) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'content-type': row.mime, 'content-length': row.bytes.byteLength,
                             'cache-control': 'public, max-age=31536000, immutable' });
        res.end(row.bytes);
        return;
      }

      /**
       * The calendar, as something a calendar application can subscribe to.
       *
       * Not a capability, because what comes back is not JSON — a phone subscribing to a feed
       * wants iCalendar and nothing else. A key may be given in the query string as well as in
       * a header: a subscription is a URL typed into another application, and that application
       * will not be setting headers for us.
       */
      if (url.pathname === '/calendar.ics') {
        const ctx = ctxOf();
        const check = authorise(ctx.db, {
          presented: bearer(req) ?? url.searchParams.get('key') ?? undefined,
          loopback: isLoopback(req), now: ctx.now,
        });
        if (!check.ok) {
          res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(`${check.reason}\nAdd ?key=<key> to the subscription URL.`);
          return;
        }
        const horizon = Number(url.searchParams.get('withinDays') ?? 400);
        const back = Number(url.searchParams.get('backDays') ?? 400);
        const body = toIcs(buildCalendar(ctx, {
          horizonDays: Number.isFinite(horizon) ? horizon : 400,
          backDays: Number.isFinite(back) ? back : 400,
        }), { name: 'Ledg00r', now: ctx.now });
        res.writeHead(200, {
          'content-type': 'text/calendar; charset=utf-8',
          'content-disposition': 'inline; filename="ledg00r.ics"',
          'cache-control': 'no-cache',
        });
        res.end(body);
        return;
      }

      /**
       * The skill, as a file to take away.
       *
       * The same document the built-in assistant runs on and the MCP server serves at
       * `ledger://skill` — offered as a download so it can be dropped into another
       * assistant's skills folder and used with whatever model its owner prefers. It holds
       * no figures and names no account, so it sits outside the key requirement alongside
       * the interface itself.
       */
      if (url.pathname === '/skill.md') {
        const body = skillText();
        res.writeHead(200, {
          'content-type': 'text/markdown; charset=utf-8',
          'content-disposition': 'attachment; filename="SKILL.md"',
          'cache-control': 'no-cache',
        });
        res.end(body);
        return;
      }

      if (url.pathname === '/api' || url.pathname === '/api/') {
        // The catalogue. An agent that has lost its tool list can read it back from here.
        return json(res, 200, Object.values(registry).map(describe));
      }

      if (url.pathname.startsWith('/api/')) {
        const ctx = ctxOf();
        const check = authorise(ctx.db, {
          presented: bearer(req), loopback: isLoopback(req), now: ctx.now,
        });
        if (!check.ok) {
          return json(res, 401, { ok: false, code: 'unauthorised', message: check.reason,
                                  remedy: 'Turn authentication off in Settings, or issue a key there and send it.' });
        }
        const name = url.pathname.slice('/api/'.length);

        // The assistant's turn is a route rather than a capability, because running one needs
        // the whole registry — which nothing inside the registry can reach.
        if (name === 'assistant.ask' && opts.onAsk) {
          const body = (await readJson(req)) as { question?: string; history?: any[] };
          if (!body.question) return json(res, 400, { ok: false, message: 'Ask something.' });
          return json(res, 200, await opts.onAsk(body.question, body.history ?? [], ctxOf()));
        }

        const cap = registry[name];
        if (!cap) {
          return json(res, 404, { ok: false, code: 'not_found', message: `There is no capability called ${name}.`,
                                  remedy: 'GET /api lists every capability by name.' });
        }
        const body = req.method === 'GET'
          ? Object.fromEntries(url.searchParams)
          : await readJson(req);
        return json(res, 200, await invoke(cap, body, ctxOf({
          idempotencyKey: header(req, 'idempotency-key'),
          dryRun: header(req, 'x-dry-run') === 'true',
        })));
      }

      if (webRoot) return serveStatic(res, webRoot, url.pathname);
      return json(res, 404, { ok: false, message: 'Nothing is served here.' });
    } catch (e) {
      const err = e as Error & { issues?: unknown };
      if (err.name === 'ZodError') {
        return json(res, 400, { ok: false, code: 'invalid_input',
                                message: 'The input does not match what this capability takes.',
                                issues: err.issues });
      }
      console.error(err);
      return json(res, 500, { ok: false, code: 'error', message: err.message });
    }
  });
}

/**
 * Run one capability.
 *
 * Input and output both go through the schema, in both directions — an output that does not
 * match what the capability promised is a bug worth failing on rather than passing along.
 * The handler runs inside the call's own context scope, so its idempotency key and dry-run
 * flag belong to this call and no other.
 */
export async function invoke(cap: Capability, raw: unknown, ctx: AppCtx): Promise<unknown> {
  const input = cap.input.parse(coerce(cap.input, raw));
  const out = await withCtx(ctx, () => cap.handler(input, ctx as any));
  return cap.output.parse(out);
}

/**
 * A query string carries only strings, so a number stays a string unless something says
 * otherwise. This walks the schema and converts what the schema says is not a string, which
 * keeps `GET /api/expense.list?limit=20` working without weakening the schema itself.
 */
function coerce(schema: z.ZodTypeAny, value: unknown): unknown {
  if (value == null || typeof value !== 'object') return value;
  // zod 3 exposed the shape as a function, zod 4 as an object; accept either
  const raw = (schema as any)?._def?.shape ?? (schema as any)?.shape;
  const shape = typeof raw === 'function' ? raw() : raw;
  if (!shape || typeof shape !== 'object') return value;
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const [key, field] of Object.entries<any>(shape)) {
    const v = out[key];
    if (typeof v !== 'string') continue;
    const inner = unwrap(field);
    if (inner instanceof z.ZodNumber) out[key] = Number(v);
    else if (inner instanceof z.ZodBoolean) out[key] = v === 'true';
    else if (inner instanceof z.ZodArray && v.includes(',')) out[key] = v.split(',');
  }
  return out;
}

/** Peel optionals, defaults and pipes until the type that decides the coercion is reached. */
function unwrap(f: any): any {
  let cur = f;
  for (let i = 0; i < 8 && cur; i += 1) {
    const inner = cur?._def?.innerType ?? cur?._def?.schema ?? cur?._def?.in;
    if (!inner) break;
    cur = inner;
  }
  return cur;
}

export function describe(cap: Capability) {
  return { name: cap.name, context: cap.context, summary: cap.summary,
           detail: cap.detail, effect: cap.effect };
}

/**
 * Where a request came from.
 *
 * Inside a container everything published arrives from the bridge network rather than the
 * loopback interface, so a browser on the host looks remote. That is why the module is off by
 * default: an owner opening their own ledger should not meet a key prompt.
 */
export function isLoopback(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress ?? '';
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

export function bearer(req: IncomingMessage): string | undefined {
  return header(req, 'authorization')?.replace(/^Bearer\s+/i, '') ?? header(req, 'x-ledger-token');
}

const header = (req: IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
                          'content-length': Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** The bundle, with every unknown path falling back to index.html so the hash route works. */
async function serveStatic(res: ServerResponse, root: string, pathname: string): Promise<void> {
  const safe = resolve(root, `.${pathname}`);
  if (!safe.startsWith(resolve(root))) { res.writeHead(403).end(); return; }

  const file = existsSync(safe) && extname(safe) ? safe : join(root, 'index.html');
  if (!existsSync(file)) { res.writeHead(404).end('not built'); return; }

  const body = await readFile(file);
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  res.end(body);
}
