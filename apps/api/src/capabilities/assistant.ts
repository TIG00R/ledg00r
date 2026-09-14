import { z } from 'zod';
import { command, query, Outcome } from '@ledger/contracts';
import type { AppCtx } from '../context.js';
import { noted, refusal } from './shared.js';
import { readPref, writePref } from '../read.js';

/**
 * Talking to the ledger.
 *
 * Two ways, and they are genuinely different things. Either an assistant runs *inside* this
 * application — you give it a key for a provider, and it calls the same capabilities the
 * screens call — or the ledger is handed to an assistant that already exists, as an MCP
 * server it connects to. The first is convenient; the second is what an agent already living
 * in your editor wants.
 *
 * A provider key is stored the way any credential should be: written, never read back. The
 * screen shows its last four characters and nothing else, and the key itself only ever leaves
 * this process on its way to the provider it belongs to.
 */
export const PROVIDERS = [
  { id: 'anthropic', name: 'Claude', endpoint: 'https://api.anthropic.com/v1/messages',
    model: 'claude-sonnet-5', keyHint: 'sk-ant-…', docs: 'console.anthropic.com' },
  { id: 'openai', name: 'ChatGPT', endpoint: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o', keyHint: 'sk-…', docs: 'platform.openai.com' },
  { id: 'openrouter', name: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'anthropic/claude-sonnet-4', keyHint: 'sk-or-…', docs: 'openrouter.ai' },
  { id: 'local', name: 'Something local', endpoint: 'http://localhost:11434/v1/chat/completions',
    model: 'llama3.1', keyHint: 'usually none', docs: 'Ollama, LM Studio, llama.cpp' },
] as const;

interface AssistantSettings {
  provider: string;
  endpoint?: string;
  model?: string;
  /** written, never read back */
  key?: string;
}

const read = (db: AppCtx['db']): AssistantSettings =>
  readPref<AssistantSettings>(db, 'assistant') ?? { provider: 'anthropic' };

export const assistantCaps = (ctxOf: () => AppCtx) => [
  query({
    name: 'assistant.status',
    context: 'assistant',
    summary: 'Which provider the built-in assistant would use, and whether it has a key.',
    detail: 'The key itself is never returned. Only whether one is set, and its last four characters, which is enough to tell two keys apart.',
    input: z.object({}),
    output: z.object({
      provider: z.string(),
      endpoint: z.string(),
      model: z.string(),
      hasKey: z.boolean(),
      keyTail: z.string().nullable(),
      providers: z.array(z.object({
        id: z.string(), name: z.string(), endpoint: z.string(),
        model: z.string(), keyHint: z.string(), docs: z.string(),
      })),
    }),
    handler: async () => {
      const { db } = ctxOf();
      const s = read(db);
      const known = PROVIDERS.find((p) => p.id === s.provider) ?? PROVIDERS[0];
      return {
        provider: s.provider,
        endpoint: s.endpoint ?? known.endpoint,
        model: s.model ?? known.model,
        hasKey: !!s.key,
        keyTail: s.key ? s.key.slice(-4) : null,
        providers: PROVIDERS.map((p) => ({ ...p })),
      };
    },
  }),

  command({
    name: 'assistant.configure',
    context: 'assistant',
    summary: 'Choose which provider the built-in assistant talks to, and give it a key.',
    detail: 'Leave the key out to change the provider or model without touching it. Send an empty key to forget the one stored.',
    input: z.object({
      provider: z.enum(['anthropic', 'openai', 'openrouter', 'local']).optional(),
      endpoint: z.string().url().optional(),
      model: z.string().max(120).optional(),
      key: z.string().max(400).optional(),
    }),
    output: Outcome,
    handler: async (input) => {
      const ctx = ctxOf();
      const current = read(ctx.db);
      const next: AssistantSettings = {
        provider: input.provider ?? current.provider,
        endpoint: input.endpoint ?? (input.provider ? undefined : current.endpoint),
        model: input.model ?? (input.provider ? undefined : current.model),
        key: input.key === undefined ? current.key : (input.key === '' ? undefined : input.key),
      };
      writePref(ctx.db, 'assistant', next);
      const known = PROVIDERS.find((p) => p.id === next.provider)!;
      return noted(next.key
        ? `Ledg00r will talk through ${known.name}`
        : `${known.name} chosen — it still needs a key before it can answer`);
    },
  }),

  command({
    name: 'assistant.ask',
    context: 'assistant',
    summary: 'Ask the built-in assistant something. It can read this ledger and act on it.',
    detail: 'The question goes to the configured provider along with the ledger\'s own tools, so the answer can be worked out from real figures rather than guessed. Nothing is recorded without the model calling a capability that records it, and every such call obeys the same rules the screens do.',
    effect: 'writes',
    input: z.object({
      question: z.string().min(1).max(4000),
      history: z.array(z.object({
        role: z.enum(['user', 'assistant']),
        text: z.string().max(8000),
      })).max(40).default([]),
    }),
    output: z.object({
      answer: z.string(),
      used: z.array(z.object({ tool: z.string(), summary: z.string() })),
      provider: z.string(),
    }),
    handler: async () => {
      // The turn itself is run by the server rather than a capability, because it needs the
      // registry it is a member of. This exists so the tool list documents it; the HTTP
      // route below is what the screen calls.
      return { answer: '', used: [], provider: '' };
    },
  }),
];

export { read as readAssistant };

/** Whether a question can be asked at all, and why not when it cannot. */
export function assistantReady(db: AppCtx['db']): { ok: true } | { ok: false; why: string } {
  const s = read(db);
  if (s.provider === 'local') return { ok: true };
  if (!s.key) {
    const known = PROVIDERS.find((p) => p.id === s.provider) ?? PROVIDERS[0];
    return { ok: false, why: `Ledg00r has no key for ${known.name} yet.` };
  }
  return { ok: true };
}

export function refuseUnready(why: string) {
  return refusal('not_found', why, 'Give it one under Settings, or connect an assistant you already have to the MCP server instead.');
}
