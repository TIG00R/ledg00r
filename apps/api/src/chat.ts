import { z } from 'zod';
import type { Registry } from '@ledger/contracts';
import type { AppCtx } from './context.js';
import { invoke } from './http.js';
import { PROVIDERS, readAssistant } from './capabilities/assistant.js';
import { skillPrompt } from './skill.js';

/**
 * One turn of conversation, with the ledger's own tools in the model's hand.
 *
 * The point of this is that the assistant does not guess. It is given the same capabilities
 * the screens call, asks for the figures it needs, and answers from what came back — so
 * "how much did I spend on travel this year" is a question with an answer rather than a
 * plausible-sounding number.
 *
 * Two provider shapes cover everything worth covering: Anthropic's, and OpenAI's — which
 * OpenRouter and every local server also speak. The difference between them is a translation
 * at the edge and nothing deeper.
 */
export interface Step { tool: string; summary: string }

/**
 * The house rules, read from the skill rather than written twice.
 *
 * They used to be a string here, which meant this assistant knew them and an assistant
 * connected over MCP — running against the same tools — did not.
 */
const system = () => skillPrompt();

const MAX_STEPS = 8;

export async function runTurn(
  registry: Registry,
  ctx: AppCtx,
  question: string,
  history: Array<{ role: 'user' | 'assistant'; text: string }>,
): Promise<{ answer: string; used: Step[]; provider: string }> {
  const s = readAssistant(ctx.db);
  const known = PROVIDERS.find((p) => p.id === s.provider) ?? PROVIDERS[0];
  const endpoint = s.endpoint ?? known.endpoint;
  const model = s.model ?? known.model;
  const anthropic = /anthropic\.com/.test(endpoint);

  const tools = Object.values(registry).map((cap) => ({
    name: cap.name.replace(/\./g, '_'),
    description: [cap.summary, cap.detail].filter(Boolean).join(' '),
    schema: z.toJSONSchema(cap.input, { io: 'input', target: 'draft-7' }) as Record<string, unknown>,
  }));
  const byName = new Map(Object.values(registry).map((c) => [c.name.replace(/\./g, '_'), c]));

  const used: Step[] = [];
  const messages: any[] = [
    ...history.map((h) => ({ role: h.role, content: h.text })),
    { role: 'user', content: question },
  ];

  for (let step = 0; step < MAX_STEPS; step += 1) {
    const reply = anthropic
      ? await callAnthropic(endpoint, s.key, model, messages, tools)
      : await callOpenAI(endpoint, s.key, model, messages, tools);

    if (reply.calls.length === 0) {
      return { answer: reply.text || 'I have nothing to add.', used, provider: known.name };
    }

    messages.push(reply.raw);
    const results: any[] = [];

    for (const call of reply.calls) {
      const cap = byName.get(call.name);
      if (!cap) {
        results.push({ id: call.id, name: call.name, content: `There is no tool called ${call.name}.` });
        continue;
      }
      try {
        const out = await invoke(cap, call.input, { ...ctx, source: 'assistant' });
        used.push({ tool: cap.name, summary: describe(out) });
        results.push({ id: call.id, name: call.name, content: JSON.stringify(out).slice(0, 12_000) });
      } catch (e) {
        const err = e as Error & { issues?: unknown };
        results.push({
          id: call.id, name: call.name,
          content: JSON.stringify({ ok: false, message: err.message, issues: err.issues }),
        });
      }
    }

    // The two shapes differ only here: Anthropic wants every result in one user message,
    // OpenAI wants one message per result.
    if (anthropic) {
      messages.push({
        role: 'user',
        content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content })),
      });
    } else {
      for (const r of results) {
        messages.push({ role: 'tool', tool_call_id: r.id, name: r.name, content: r.content });
      }
    }
  }

  return {
    answer: 'I went round that several times without settling it. Try asking for one thing at a time.',
    used, provider: known.name,
  };
}

/** A line a person can read, rather than the raw result. */
function describe(out: unknown): string {
  const o = out as Record<string, any>;
  if (Array.isArray(out)) return `${out.length} row${out.length === 1 ? '' : 's'}`;
  if (o?.ok === false) return `refused: ${o.message}`;
  if (o?.summary) return String(o.summary);
  if (o?.total != null) return `total ${Math.round(o.total).toLocaleString()}`;
  if (o?.netWorth != null) return `net worth ${Math.round(o.netWorth).toLocaleString()}`;
  return 'read';
}

interface Reply { text: string; calls: Array<{ id: string; name: string; input: unknown }>; raw: any }

async function callAnthropic(
  endpoint: string, key: string | undefined, model: string, messages: any[], tools: any[],
): Promise<Reply> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key ?? '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model, max_tokens: 2048, system: system(), messages,
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema })),
    }),
  });
  if (!res.ok) throw new Error(await readError(res));
  const body = await res.json() as any;
  const blocks = body.content ?? [];
  return {
    text: blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim(),
    calls: blocks.filter((b: any) => b.type === 'tool_use')
      .map((b: any) => ({ id: b.id, name: b.name, input: b.input })),
    raw: { role: 'assistant', content: blocks },
  };
}

async function callOpenAI(
  endpoint: string, key: string | undefined, model: string, messages: any[], tools: any[],
): Promise<Reply> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system() }, ...messages],
      tools: tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.schema },
      })),
    }),
  });
  if (!res.ok) throw new Error(await readError(res));
  const body = await res.json() as any;
  const msg = body.choices?.[0]?.message ?? {};
  return {
    text: (msg.content ?? '').trim(),
    calls: (msg.tool_calls ?? []).map((c: any) => ({
      id: c.id, name: c.function.name,
      input: safeParse(c.function.arguments),
    })),
    raw: msg,
  };
}

function safeParse(text: string): unknown {
  try { return JSON.parse(text || '{}'); } catch { return {}; }
}

/** Providers say what went wrong in their own shapes; this finds the sentence. */
async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const body = JSON.parse(text);
    return body?.error?.message ?? body?.message ?? `${res.status} ${res.statusText}`;
  } catch {
    return text.slice(0, 300) || `${res.status} ${res.statusText}`;
  }
}
