import { createClient, refused, succeeded, LedgerError } from '@ledger/client';

/**
 * The ledger, as the interface sees it.
 *
 * One client, typed from the server's own registry, so a capability renamed or reshaped on
 * the back end fails to compile here instead of failing in front of whoever is using it.
 *
 * The base URL is relative because the API serves this bundle from the same origin, which is
 * what lets the whole thing be one container with no CORS to configure. A token is only
 * needed when the two are on different machines, and then it comes from the environment
 * rather than being typed into a field that would store it in the page.
 */
export type Ledger = ReturnType<typeof makeLedger>;

function makeLedger() {
  return createClient<any>({
    baseUrl: import.meta.env.VITE_LEDGER_API ?? '/api',
    token: import.meta.env.VITE_LEDGER_TOKEN,
    // so the log of what was done can tell a person at a screen from an agent over MCP
    source: 'web',
    onError: (name, err) => console.error(`[ledger] ${name}: ${err.message}`),
  });
}

export const ledger = makeLedger();
export { refused, succeeded, LedgerError };

/**
 * Is there a back end at all, and is it this one?
 *
 * The interface runs against fixtures when there is none, which is how it has been built and
 * how it should keep working. Rather than guessing, it asks once and remembers.
 *
 * A 200 is not enough to answer with. In development the dev server proxies to whatever port
 * it was pointed at, and something else answering there — another project, a container left
 * running — returns a perfectly good page for `/health`. The interface then believes it is
 * live, every read fails, and the screens go quiet rather than falling back to the fixtures
 * they were built on. So the answer has to look like this ledger's answer: JSON, saying it is
 * well, and counting the capabilities it serves.
 */
let live: Promise<boolean> | null = null;
export function apiAvailable(): Promise<boolean> {
  live ??= fetch('/health')
    .then((r) => (r.ok ? r.json() : null))
    .then((body: any) => body?.ok === true && typeof body?.capabilities === 'number')
    .catch(() => false);
  return live;
}
