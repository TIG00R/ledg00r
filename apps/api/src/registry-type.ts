import { buildRegistry } from './capabilities/index.js';

/**
 * The registry's type, exported for the client.
 *
 * The front end imports this and nothing else from the API — types only, erased at build
 * time, so the browser bundle carries no server code. What it buys is that renaming a
 * capability or changing its input breaks the call site in the interface at compile time
 * rather than at run time in front of the owner.
 */
export type LedgerRegistry = ReturnType<typeof buildRegistry>;
