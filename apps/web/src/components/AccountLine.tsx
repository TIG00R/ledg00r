import { useApp } from '../AppState';
import { Mark } from './Mark';

/**
 * An account, in a table, drawn the way every picker in this application draws one.
 *
 * The bank leads and the account is read under it, with the bank's own mark beside them.
 * That order is not a preference: a ledger's accounts are named for what they hold — "EGP",
 * "USD", "Current", "Savings" — so a column led by the account's own name is a column of
 * currencies, and the thing that tells two of them apart was the quiet line underneath. The
 * pickers lead with the bank; a table that kept the old order meant choosing an account and
 * reading it back looked like two different things.
 *
 * Anything with no bank over it — a broker's wallet, a property, an employer money arrived
 * from — leads with its own name, since there is nothing else to say about where it sits, and
 * wears its own mark where it has one.
 *
 * Given an id it reads everything from the ledger. Given only a name it draws what it was
 * handed, which is what a movement's own record of a node since removed amounts to.
 */
export function AccountLine({ id, name, mark }: {
  /** the node, where the caller knows it */
  id?: string | null;
  /** what to call it when there is no node to read, or none was found */
  name?: string | null;
  /** a mark to use instead of the one the ledger holds */
  mark?: string;
}) {
  const { data } = useApp();
  const node = id ? data.nodes.find((n) => n.id === id) : undefined;
  const bank = node?.parentId
    ? data.institutions.find((i) => i.id === node.parentId)
    : undefined;
  const account = node?.name ?? name ?? '—';
  const own = mark ?? bank?.logo ?? (node as { icon?: string } | undefined)?.icon;

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
      {/*
        * A bank with a logo wears it. One without wears its short code on its own colour, the
        * way the accounts screen writes it — a bank drawn as nothing at all reads as an
        * account belonging to nobody, and every bank in a column then looks alike.
        */}
      {(own || bank) && (
        <span aria-hidden style={{
          width: 24, height: 20, flex: '0 0 24px', borderRadius: 6, overflow: 'hidden',
          background: own ? 'transparent' : (bank?.color ?? 'var(--muted)'),
          color: '#fff', fontSize: 8, fontWeight: 700, letterSpacing: '.02em',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {own ? <Mark mark={own} size={17} fallback="accounts" /> : bank?.shortCode}
        </span>
      )}
      <span style={{ display: 'block', minWidth: 0 }}>
        <span style={{ display: 'block' }}>{bank?.name ?? account}</span>
        {bank && <span className="at-bank">{account}</span>}
      </span>
    </span>
  );
}
