import { z } from 'zod';

/**
 * Identifiers, branded.
 *
 * Every id in this system is a string, which means every id is assignable to every other id
 * unless something stops it. Branding is that something: an `AccountId` will not go where a
 * `CategoryId` belongs, and the mistake is caught while typing rather than at the point a
 * query silently returns nothing.
 */
const brand = <B extends string>(b: B, pattern = /^[a-z0-9][a-z0-9-]{0,63}$/i) =>
  z.string().regex(pattern, `not a ${b} id`).brand<B>();

export const NodeId = brand('NodeId');
export const AccountId = brand('AccountId');
export const InstitutionId = brand('InstitutionId');
export const MovementId = brand('MovementId');
export const CategoryId = brand('CategoryId');
export const SourceId = brand('SourceId');
export const TemplateId = brand('TemplateId');
export const ReminderId = brand('ReminderId');
export const PropertyId = brand('PropertyId');
export const InstallmentId = brand('InstallmentId');
export const LotId = brand('LotId');
export const OrderId = brand('OrderId');
export const RecordId = brand('RecordId');

export type NodeId = z.infer<typeof NodeId>;
export type AccountId = z.infer<typeof AccountId>;
export type InstitutionId = z.infer<typeof InstitutionId>;
export type MovementId = z.infer<typeof MovementId>;
export type CategoryId = z.infer<typeof CategoryId>;
export type SourceId = z.infer<typeof SourceId>;
export type TemplateId = z.infer<typeof TemplateId>;
export type ReminderId = z.infer<typeof ReminderId>;
export type PropertyId = z.infer<typeof PropertyId>;
export type InstallmentId = z.infer<typeof InstallmentId>;
export type LotId = z.infer<typeof LotId>;
export type OrderId = z.infer<typeof OrderId>;
export type RecordId = z.infer<typeof RecordId>;

/** A ticker is not an id in the same sense — it is the market's name for the thing. */
export const Ticker = z.string().regex(/^[A-Z][A-Z0-9.]{0,11}$/, 'not a ticker');
export type Ticker = z.infer<typeof Ticker>;
