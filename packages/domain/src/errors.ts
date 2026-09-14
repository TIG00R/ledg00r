import type { Refusal } from '@ledger/contracts';

/**
 * A rule the domain will not break.
 *
 * Thrown rather than returned so a handler cannot forget to check, and carrying the same
 * shape the API hands back so nothing has to translate between an internal failure and the
 * thing an agent reads.
 */
export class DomainError extends Error {
  constructor(
    readonly code: Refusal['code'],
    message: string,
    readonly remedy?: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }

  toRefusal(): Refusal {
    return { ok: false, code: this.code, message: this.message, remedy: this.remedy };
  }
}

export const refuse = (code: Refusal['code'], message: string, remedy?: string): never => {
  throw new DomainError(code, message, remedy);
};
