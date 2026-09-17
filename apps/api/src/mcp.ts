import { z } from 'zod';
import type { Capability, Registry } from '@ledger/contracts';
import type { AppCtx } from './context.js';
import { invoke } from './http.js';
import { buildDataset, readMarket } from './read.js';
import { skillText } from './skill.js';

/**
 * The MCP server.
 *
 * Not an adapter bolted on afterwards: the tools here are the capability registry, converted
 * mechanically. An agent and the interface therefore run the same handlers, and there is
 * nothing a person can do through the screens that Claude cannot do through a tool.
 *
 * Two things are added for the agent's sake. The `effect` tag travels into the description,
 * so a model knows before calling whether an action is irreversible. And every write takes
 * `dryRun`, so an agent can ask what would happen before asking for it to happen.
 */

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const EFFECT_NOTE: Record<string, string> = {
  reads: 'Reads only; changes nothing.',
  writes: 'Writes to the ledger. Pass dryRun to see the effect first.',
  irreversible: 'Cannot be undone from here. Confirm with the owner before calling.',
};

/** MCP names may not carry a dot in some clients, so the separator becomes an underscore. */
const toolName = (cap: Capability) => cap.name.replace(/\./g, '_');

export function toolsOf(registry: Registry): McpTool[] {
  return Object.values(registry).map((cap) => ({
    name: toolName(cap),
    description: [cap.summary, cap.detail, EFFECT_NOTE[cap.effect]].filter(Boolean).join(' '),
    // Zod emits the JSON Schema itself, so the tool an agent sees and the schema the
    // handler validates against cannot describe different things.
    inputSchema: z.toJSONSchema(cap.input, { io: 'input', target: 'draft-7' }) as Record<string, unknown>,
  }));
}

/**
 * Resources.
 *
 * Reads an agent wants repeatedly and should not have to spend a tool call on each time —
 * where things stand, what is coming, what the accounts hold. Addressable, so a model can
 * cite what it read rather than restating it.
 */
export const RESOURCES = [
  { uri: 'ledger://skill', name: 'How to use this ledger', description: 'The house rules, the write discipline and the zakat treatments this ledger follows. Read it first.', mimeType: 'text/markdown' },
  { uri: 'ledger://portfolio', name: 'Portfolio', description: 'Net worth and how it is split, in the ledger\'s currency.', mimeType: 'application/json' },
  { uri: 'ledger://accounts', name: 'Accounts', description: 'Every account and what it holds now.', mimeType: 'application/json' },
  { uri: 'ledger://upcoming', name: 'Coming up', description: 'What is due, soonest first.', mimeType: 'application/json' },
  { uri: 'ledger://zakat', name: 'Zakat', description: 'The current hawl, the base, and what is due.', mimeType: 'application/json' },
  { uri: 'ledger://market', name: 'Market', description: 'The rates and prices the ledger is using.', mimeType: 'application/json' },
];

export async function readResource(uri: string, registry: Registry, ctx: AppCtx): Promise<unknown> {
  switch (uri) {
    // Markdown rather than JSON: it is a document for the model to read, not a figure to cite.
    case 'ledger://skill': return skillText();
    case 'ledger://portfolio': return invoke(registry['portfolio.overview']!, {}, ctx);
    case 'ledger://accounts': return invoke(registry['accounts.list']!, {}, ctx);
    case 'ledger://upcoming': return invoke(registry['upcoming.list']!, {}, ctx);
    case 'ledger://zakat': return invoke(registry['zakat.assessment']!, {}, ctx);
    case 'ledger://market': return readMarket(ctx.db);
    default: throw new Error(`There is no resource at ${uri}.`);
  }
}

/**
 * Prompts: the jobs worth doing in one go, packaged so they can be asked for by name.
 */
export const PROMPTS = [
  {
    name: 'close_the_month',
    description: 'Reconcile the month just ended: check the balances, post what is outstanding, and say what changed.',
    arguments: [{ name: 'month', description: 'YYYY-MM, defaulting to last month', required: false }],
    build: (args: Record<string, string>) => {
      const month = args.month ?? 'the month just ended';
      return `Close ${month} in the ledger.\n\n`
        + `1. Call flow_month for ${month} and summarise where money came from and went.\n`
        + `2. Call accounts_list and say what each account holds at the end of it.\n`
        + `3. Call upcoming_list and name anything that was due in ${month} and is still unpaid.\n`
        + `4. Do not record anything without asking. Say what you would record, and what it would change.`;
    },
  },
  {
    name: 'work_out_zakat',
    description: 'Work out this hawl\'s zakat from what is owned, and explain how the base was arrived at.',
    arguments: [],
    build: () =>
      `Work out the zakat due.\n\n`
      + `1. Call zakat_assessment.\n`
      + `2. Explain the base: what was counted, what was left out, and why.\n`
      + `3. State the threshold in force and whether the base clears it.\n`
      + `4. Note that this is a calculator and not a ruling, and that scholars differ on the treatments.`,
  },
  {
    name: 'reconcile_statement',
    description: 'Compare a bank statement against the ledger and find what is missing.',
    arguments: [{ name: 'account', description: 'the account id the statement belongs to', required: true }],
    build: (args: Record<string, string>) =>
      `Reconcile the statement I am about to paste against account ${args.account}.\n\n`
      + `1. Call accounts_list and note what the ledger thinks that account holds.\n`
      + `2. For each line on the statement, call ledger_search to see whether it is already recorded.\n`
      + `3. List what is missing, with dates and amounts. Do not record anything yet.\n`
      + `4. When I confirm, record each one with expense_record or movement_transfer, using dryRun first.`,
  },
];

/**
 * The protocol itself.
 *
 * Implemented directly rather than through a framework, because the surface an agent needs
 * is small — list tools, call one, list resources, read one, list prompts, get one — and a
 * dependency here would be more code than the handler it replaces.
 */
export function createMcpHandler(registry: Registry, ctxOf: (over?: Partial<AppCtx>) => AppCtx) {
  const byToolName = new Map(Object.values(registry).map((c) => [toolName(c), c]));

  return async function handle(msg: any): Promise<any> {
    const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result });
    const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });

    switch (msg.method) {
      case 'initialize':
        return reply({
          protocolVersion: '2024-11-05',
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: { name: 'ledg00r', version: '0.1.0' },
        });

      case 'notifications/initialized':
        return null;

      case 'tools/list':
        return reply({ tools: toolsOf(registry) });

      case 'tools/call': {
        const cap = byToolName.get(msg.params?.name);
        if (!cap) return fail(-32601, `There is no tool called ${msg.params?.name}.`);
        try {
          const out = await invoke(cap, msg.params?.arguments ?? {}, ctxOf({
            idempotencyKey: msg.params?._meta?.idempotencyKey,
            // so the log of what was done can say an agent did it, not a person at a screen
            source: 'mcp',
          }));
          return reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
        } catch (e) {
          const err = e as Error & { issues?: unknown };
          return reply({
            isError: true,
            content: [{ type: 'text', text: JSON.stringify({
              ok: false,
              message: err.name === 'ZodError' ? 'The arguments do not match what this tool takes.' : err.message,
              issues: err.issues,
            }, null, 2) }],
          });
        }
      }

      case 'resources/list':
        return reply({ resources: RESOURCES });

      case 'resources/read': {
        try {
          const contents = await readResource(msg.params?.uri, registry, ctxOf());
          // One resource is prose. Stringifying it would hand the model a quoted blob with
          // every newline escaped, which is the document made harder to read for nothing.
          const prose = typeof contents === 'string';
          return reply({ contents: [{ uri: msg.params.uri,
                                      mimeType: prose ? 'text/markdown' : 'application/json',
                                      text: prose ? contents : JSON.stringify(contents, null, 2) }] });
        } catch (e) { return fail(-32602, (e as Error).message); }
      }

      case 'prompts/list':
        return reply({ prompts: PROMPTS.map(({ name, description, arguments: a }) => ({ name, description, arguments: a })) });

      case 'prompts/get': {
        const p = PROMPTS.find((x) => x.name === msg.params?.name);
        if (!p) return fail(-32601, `There is no prompt called ${msg.params?.name}.`);
        return reply({
          description: p.description,
          messages: [{ role: 'user', content: { type: 'text', text: p.build(msg.params?.arguments ?? {}) } }],
        });
      }

      case 'ping':
        return reply({});

      default:
        return fail(-32601, `${msg.method} is not something this server handles.`);
    }
  };
}

export { buildDataset };
