import type { Capability, Registry } from '@ledger/contracts';
import type { AppCtx } from '../context.js';
import { ledgerCaps } from './ledger.js';
import { spendingCaps } from './spending.js';
import { givingCaps } from './giving.js';
import { holdingCaps } from './holdings.js';
import { planningCaps } from './planning.js';
import { overviewCaps } from './overview.js';
import { accessCaps } from './access.js';
import { markCaps } from './marks.js';
import { currencyCaps } from './currencies.js';
import { movementCaps } from './movements.js';
import { dashboardCaps } from './dashboard.js';
import { assetCaps } from './assets.js';
import { assistantCaps } from './assistant.js';
import { debtCaps } from './debts.js';
import { marketCaps } from './market.js';
import { calendarCaps, calendarEntryCaps } from './calendar.js';
import { notebookCaps } from './notebook.js';

/**
 * The registry.
 *
 * Everything the ledger can do, in one list. The tRPC router, the MCP tool list and the
 * OpenAPI document are all generated from this, so a capability added here appears in all
 * three at once and cannot exist in one and not another.
 */
export function buildRegistry(ctxOf: () => AppCtx): Registry {
  const all: Capability[] = [
    ...ledgerCaps(ctxOf),
    ...spendingCaps(ctxOf),
    ...givingCaps(ctxOf),
    ...holdingCaps(ctxOf),
    ...planningCaps(ctxOf),
    ...overviewCaps(ctxOf),
    ...accessCaps(ctxOf),
    ...markCaps(ctxOf),
    ...currencyCaps(ctxOf),
    ...movementCaps(ctxOf),
    ...dashboardCaps(ctxOf),
    ...assetCaps(ctxOf),
    ...assistantCaps(ctxOf),
    ...debtCaps(ctxOf),
    ...marketCaps(ctxOf),
    ...calendarCaps(ctxOf),
    ...calendarEntryCaps(ctxOf),
    ...notebookCaps(ctxOf),
  ] as Capability[];

  const reg: Registry = {};
  for (const cap of all) {
    if (reg[cap.name]) throw new Error(`two capabilities are called ${cap.name}`);
    reg[cap.name] = cap;
  }
  return reg;
}
