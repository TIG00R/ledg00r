import { useCallback, useEffect, useState } from 'react';
import { Amount } from '../components/Amount';
import { useApp, market } from '../AppState';
import { money, toEgp, fromEgp } from '@ledger/engine';
import { Page, Panel, Chip, Row, Field, AccountName } from '../components/UI';
import { Icon } from '../components/Icon';
import { OperationPanel, MoveMoney } from '../components/Operations';
import { ModeProvider, useMode } from '../components/ModeBar';
import { SectionProvider, Sections, useSection } from '../components/Sections';
import { useAppearance } from '../Appearance';
import { ConfirmDelete } from '../components/Confirm';
import { Mark, MarkPicker } from '../components/Mark';
import { Select } from '../components/Select';
import { RecordTable } from '../components/RecordTable';
import { DateField } from '../components/DateField';
import { ledger } from '../api';
import { ActionButton, useLive } from '../Live';
import { movementCount } from '@ledger/engine';

const COLS = '54px minmax(220px,1fr) 150px 76px';

export function Accounts() {
  return (
    <ModeProvider>
      <SectionProvider first="accounts"><Body /></SectionProvider>
    </ModeProvider>
  );
}

function Body() {
  const { data, dm, display, values, balances, currencies } = useApp();
  const { mode } = useMode();
  const { tab } = useSection();
  const { appearance } = useAppearance();
  const { run } = useLive();
  /** balances being corrected in Edit mode, before they are recorded */
  const [drafts] = useState<Record<string, number>>({});
  /** edits are held until they are saved, so switching modes does not silently drop them */
  const [names, setNames] = useState<Record<string, string>>({});
  const [pickingInst, setPickingInst] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: '', currency: 'EGP', opening: 0, kind: 'cash' as 'cash' | 'liability' });
  /** a new institution, held until it is added — accounts can only hang off one that exists */
  const [addingBank, setAddingBank] = useState(false);
  const BANK_DRAFT = { name: '', shortCode: '', country: 'Egypt', color: '#24211C' };
  const [bank, setBank] = useState(BANK_DRAFT);
  const nameOf = (id: string, fallback: string) => names[id] ?? fallback;

  /**
   * Accounts held at an institution.
   *
   * The brokerage wallet is cash you hold, but it belongs to the share book rather than to a
   * bank — which is exactly what having no institution says — so it is shown there and not
   * here.
   */
  const cash = data.nodes.filter((n) => n.kind === 'cash' && n.parentId);
  // A card is a liability held at an institution; a contract balance is a liability held
  // against the asset it bought. Only the first belongs among the accounts.
  const atBank = new Set(data.institutions.map((i) => i.id));
  const credit = data.nodes.filter((n) => n.kind === 'liability' && n.parentId && atBank.has(n.parentId));
  // what the account holds: the correction in progress, then the ledger, then the opening
  const qty = (id: string, fallback: number) => drafts[id] ?? balances[id] ?? fallback;

  /** one unit of this currency, priced in the ledger's currency */
  const unitRate = (cur: string) => fromEgp(toEgp(1, cur, market), display, market);
  const inDisplay = (n: (typeof cash)[number]) => toEgp(qty(n.id, n.openingQty), n.currency ?? 'EGP', market);

  const totalCash = cash.reduce((s, n) => s + inDisplay(n), 0);
  const totalCredit = credit.reduce((s, n) => s + qty(n.id, n.openingQty), 0);

  const byCurrency = new Map<string, number>();
  for (const n of cash) byCurrency.set(n.currency!, (byCurrency.get(n.currency!) ?? 0) + qty(n.id, n.openingQty));

  return (
    <Page aside={mode === 'operate' ? (
      <OperationPanel title="Move money"
        hint="Between two of your own accounts. Where the currencies differ this is an exchange, so the rate the bank actually gave you and its fee belong to the record.">
        <MoveMoney />
      </OperationPanel>
    ) : undefined}>
      <Sections sections={[
        { id: 'accounts', label: 'Accounts', icon: 'accounts',
          hint: 'What you hold, and where. Moving money is on the right.',
          editHint: 'Rename an account, change what it holds or what it is held in, add one, archive one.' },
        { id: 'records', label: 'Records', icon: 'ledger',
          hint: 'Every movement that touched an account, newest first.',
          editHint: 'Undo a movement. It writes the opposite rather than erasing it, so the log keeps both.' },
      ]} />

      {tab === 'accounts' && (
      <Panel>
        <div style={{ display: 'flex', gap: 40, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div>
            <div className="ov">Cash across every account</div>
            <div className="mono" style={{ fontSize: 32, fontWeight: 500, letterSpacing: '-0.02em', margin: '6px 0 2px' }}>
              {dm(totalCash)}
            </div>
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>
              less {dm(totalCredit)} owed on credit · net {dm(totalCash - totalCredit)}
            </div>
          </div>
          <div style={{ flex: 1, minWidth: 280, alignSelf: 'center' }}>
            <div style={{ display: 'flex', height: 12, borderRadius: 999, overflow: 'hidden', gap: 2 }}>
              {[...byCurrency].map(([cur, amt]) => (
                <div key={cur} style={{ width: `${(toEgp(amt, cur, market) / totalCash) * 100}%`,
                                        background: appearance.currencies[cur]?.color ?? 'var(--muted)' }} />
              ))}
            </div>
            <div style={{ display: 'flex', gap: 18, marginTop: 12, flexWrap: 'wrap' }}>
              {[...byCurrency].map(([cur, amt]) => (
                <span key={cur} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--muted)' }}>
                  <span style={{ width: 9, height: 9, borderRadius: 3,
                                 background: appearance.currencies[cur]?.color ?? 'var(--muted)' }} />
                  <span className="mono">{money(amt, cur, cur === 'EGP' ? 0 : 2)}</span>
                </span>
              ))}
            </div>
          </div>
        </div>

        <div style={{
          display: 'flex', alignItems: 'center', gap: 14, marginTop: 20, padding: '13px 16px',
          borderRadius: 'var(--r-card)', background: 'color-mix(in srgb, var(--gold) 9%, transparent)',
          border: '1px solid color-mix(in srgb, var(--gold) 28%, transparent)',
        }}>
          <Icon name="warn" size={17} color="var(--gold)" />
          <div style={{ fontSize: 13, color: 'var(--muted)', flex: 1 }}>
            These balances total <strong style={{ color: 'var(--ink)' }}>{dm(totalCash)}</strong>. Working
            the movements forward gives <strong style={{ color: 'var(--ink)' }}>{dm(values.cash)}</strong> —
            the difference is what has not been recorded.
          </div>
        </div>
      </Panel>
      )}

      {tab === 'accounts' && (
      <Row cols={COLS} style={{ padding: '0 18px' }}>
        <span className="ov">Currency</span>
        <span className="ov">Account</span>
        <span className="ov" style={{ textAlign: 'right' }}>1 unit in {display}</span>
        <span />
      </Row>
      )}

      {tab === 'records' && <MovementRecords />}

      {tab === 'accounts' && data.institutions.map((inst) => {
        const accounts = cash.filter((n) => n.parentId === inst.id);
        const cards = credit.filter((n) => n.parentId === inst.id);
        const subtotal = accounts.reduce((s, n) => s + inDisplay(n), 0);
        const instColour = appearance.institutions[inst.id] ?? inst.color;
        return (
          <div key={inst.id} style={{ borderRadius: 14, border: '1px solid var(--hairline)',
                                      background: 'var(--surface)', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '15px 18px',
                          background: 'var(--raised)', borderBottom: '1px solid var(--hairline)' }}>
              {mode === 'edit' ? (
                <button onClick={() => setPickingInst(pickingInst === inst.id ? null : inst.id)}
                        aria-label={`Change the mark for ${inst.name}`}
                        style={{ width: 38, height: 30, borderRadius: 8, cursor: 'pointer', padding: 0,
                                 position: 'relative', border: '1px solid var(--hairline)',
                                 background: inst.logo ? 'var(--surface)' : instColour,
                                 display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {inst.logo
                    ? <Mark mark={inst.logo} size={22} fallback="accounts" />
                    : <span style={{ color: '#fff', fontSize: 10, fontWeight: 700 }}>{inst.shortCode}</span>}
                  <span style={{ position: 'absolute', right: -5, bottom: -5, width: 15, height: 15,
                                 borderRadius: 999, background: 'var(--gold)', display: 'flex',
                                 alignItems: 'center', justifyContent: 'center' }}>
                    <Icon name="edit" size={8} color="#fff" strokeWidth={2.4} motion="none" />
                  </span>
                </button>
              ) : (
                <span style={{ width: 38, height: 30, borderRadius: 8, overflow: 'hidden',
                               background: inst.logo ? 'var(--surface)' : instColour, color: '#fff',
                               display: 'flex', alignItems: 'center', justifyContent: 'center',
                               fontSize: 10, fontWeight: 700 }}>
                  {inst.logo ? <Mark mark={inst.logo} size={24} fallback="accounts" /> : inst.shortCode}
                </span>
              )}
              <div>
                {mode === 'edit' ? (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <input value={nameOf(inst.id, inst.name)} aria-label={`${inst.name} name`}
                           onChange={(e) => setNames({ ...names, [inst.id]: e.target.value })}
                           style={{ fontSize: 15, fontWeight: 600, padding: '4px 8px' }} />
                    {names[inst.id] != null && names[inst.id] !== inst.name && (
                      <ActionButton capability="institution.update" className="btn go sm"
                        style={undefined}
                        onDone={(o) => { if (o.ok) setNames(({ [inst.id]: _, ...r }) => r); }}
                        input={{ institutionId: inst.id, name: names[inst.id] }}>Save</ActionButton>
                    )}
                  </span>
                ) : <div style={{ fontSize: 15, fontWeight: 600 }}>{nameOf(inst.id, inst.name)}</div>}
                <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 2 }}>
                  {inst.country} · {accounts.length} account{accounts.length === 1 ? '' : 's'}
                  {cards.length ? ` + ${cards.length} credit` : ''}
                </div>
              </div>
              <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 16 }}>
                <div style={{ textAlign: 'right' }}>
                  <div className="ov">Here</div>
                  <div className="mono" style={{ fontSize: 16, fontWeight: 500 }}>{dm(subtotal)}</div>
                </div>
                {mode === 'edit' && (
                  <>
                    <button className="btn add" style={{ padding: '7px 12px', fontSize: 12 }}
                            onClick={() => setAdding(adding === inst.id ? null : inst.id)}>
                      <Icon name="plus" size={13} /> Account
                    </button>
                    <ConfirmDelete what={inst.name}
                      blocked={accounts.length + cards.length > 0
                        ? `${inst.name} still holds ${accounts.length + cards.length} account${accounts.length + cards.length === 1 ? '' : 's'}. Archive it instead — every balance and every movement stays readable.`
                        : undefined}
                      onArchive={() => { void run('institution.update', { institutionId: inst.id, archived: true }); }}
                      onConfirm={() => { void run('institution.update', { institutionId: inst.id, archived: true }); }} />
                  </>
                )}
              </div>
            </div>

            {adding === inst.id && mode === 'edit' && (
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end',
                            padding: '14px 18px', borderBottom: '1px solid var(--hairline)',
                            background: 'color-mix(in srgb, var(--positive) 5%, transparent)' }}>
                <Field label="Name">
                  <input autoFocus value={draft.name} aria-label="New account name" placeholder="EGP savings"
                         onChange={(e) => setDraft({ ...draft, name: e.target.value })} style={{ minWidth: 180 }} />
                </Field>
                <Field label="Currency">
                  <Select ariaLabel="New account currency" value={draft.currency} style={{ width: 130 }}
                          onChange={(v) => setDraft({ ...draft, currency: v })}
                          options={currencies.map((c) => ({ value: c.code, label: `${c.symbol} ${c.code}`, hint: c.name }))} />
                </Field>
                <Field label="Opening balance" hint="where it starts, not a movement">
                  <Amount value={draft.opening} ariaLabel="New account opening balance" onChange={(n) => setDraft({ ...draft, opening: n })} style={{ width: 140 }} />
                </Field>
                <Field label="Kind">
                  <Select ariaLabel="New account kind" value={draft.kind}
                          onChange={(v) => setDraft({ ...draft, kind: v as 'cash' | 'liability' })}
                          options={[{ value: 'cash', label: 'An account' },
                                    { value: 'liability', label: 'A credit line' }]} />
                </Field>
                <ActionButton capability="account.add" className="btn add"
                  disabled={!draft.name || draft.currency.length !== 3}
                  onDone={(o) => { if (o.ok) { setDraft({ name: '', currency: 'EGP', opening: 0, kind: 'cash' }); setAdding(null); } }}
                  input={() => ({ institutionId: inst.id, name: draft.name, currency: draft.currency,
                                  kind: draft.kind, openingBalance: draft.opening })}>
                  <Icon name="plus" size={13} /> Add it
                </ActionButton>
                <button className="btn ghost" onClick={() => setAdding(null)}>
                  <Icon name="close" size={14} motion="none" /> Cancel
                </button>
              </div>
            )}

            {pickingInst === inst.id && mode === 'edit' && (
              <div style={{ padding: '0 18px 14px' }}>
                <MarkPicker value={inst.logo ?? undefined} family="cash" tone={instColour}
                  label={`Mark for ${inst.name} — an icon, or the bank's own logo`}
                  onClose={() => setPickingInst(null)}
                  onChange={(m) => { void run('institution.update', { institutionId: inst.id, logo: m }); }} />
              </div>
            )}

            {[...accounts, ...cards].map((n, i, arr) => {
              const isCredit = n.kind === 'liability';
              const cur = n.currency ?? 'EGP';
              const dp = cur === 'EGP' ? 0 : 2;
              const style = appearance.currencies[cur];
              const native = qty(n.id, n.openingQty);
              return (
                <Row key={n.id} cols={COLS} style={{
                  padding: '13px 18px',
                  borderBottom: i === arr.length - 1 ? 'none' : '1px solid var(--hairline)',
                  background: isCredit ? 'color-mix(in srgb, var(--negative) 5%, transparent)' : undefined,
                }}>
                  {/* The mark is what the currency looks like everywhere, so it is set once
                      in the Currency Zone rather than cycled from here. */}
                  <span style={{ width: 38, height: 26, borderRadius: 6, overflow: 'hidden',
                                 background: style?.color ?? 'var(--muted)', color: '#fff', fontSize: 10,
                                 fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {(() => {
                      const reg = currencies.find((c) => c.code === cur);
                      return reg?.mark ? <Mark mark={reg.mark} size={18} /> : cur;
                    })()}
                  </span>

                  <div style={{ minWidth: 0 }}>
                    {mode === 'edit' ? (
                      <AccountEditor node={n} currency={cur} isCredit={isCredit}
                        held={balances[n.id] ?? n.openingQty}
                        currencies={currencies} run={run} />
                    ) : (
                      <>
                        <div style={{ fontSize: 14 }}>{n.name}</div>
                        <div className="mono" style={{ fontSize: 16, fontWeight: 500, marginTop: 2,
                                                       color: isCredit ? 'var(--negative)' : undefined }}>
                          {isCredit ? '−' : ''}{money(native, cur, dp)}
                        </div>
                      </>
                    )}

                    <div className="mono" style={{ fontSize: 12, color: 'var(--faint)', marginTop: 2 }}>
                      {isCredit ? '−' : ''}{dm(toEgp(native, cur, market))}
                    </div>

                    <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                      {isCredit && <Chip tone="bad">a debt, not cash</Chip>}
                    </div>
                  </div>

                  <span className="mono" style={{ textAlign: 'right', fontSize: 13, color: 'var(--muted)' }}>
                    {cur === display ? '1' : unitRate(cur).toFixed(cur === 'EGP' ? 5 : 4)}
                  </span>

                  <span style={{ textAlign: 'right' }}>
                    {mode === 'edit' && (() => {
                      // an account with movements against it cannot go: deleting it would
                      // rewrite what already happened
                      const used = movementCount(data, n.id);
                      return (
                        <ConfirmDelete what={n.name}
                          blocked={used > 0
                            ? `${used} movement${used === 1 ? '' : 's'} name this account. Archiving freezes the balance and keeps every row in the log.`
                            : undefined}
                          onArchive={() => { void run('account.archive', { accountId: n.id }); }}
                          onConfirm={() => { void run('account.archive', { accountId: n.id }); }} />
                      );
                    })()}
                  </span>
                </Row>
              );
            })}
          </div>
        );
      })}


      {/* An account has to hang off an institution, so the bank is added first and the
          accounts after. Without this the only way in was a seeded database. */}
      {tab === 'accounts' && mode === 'edit' && !addingBank && (
        <div>
          <button className="btn" onClick={() => setAddingBank(true)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
            <Icon name="plus" size={14} /> Bank
          </button>
        </div>
      )}

      {tab === 'accounts' && mode === 'edit' && addingBank && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end',
                      padding: '14px 18px', borderRadius: 14, border: '1px solid var(--hairline)',
                      background: 'color-mix(in srgb, var(--positive) 5%, transparent)' }}>
          <Field label="Name">
            <input autoFocus value={bank.name} aria-label="New bank name" placeholder="Nile Bank"
                   onChange={(e) => setBank({ ...bank, name: e.target.value })} style={{ minWidth: 180 }} />
          </Field>
          <Field label="Short code" hint="shown when there is no logo">
            <input value={bank.shortCode} aria-label="New bank short code" placeholder="NILE" maxLength={8}
                   onChange={(e) => setBank({ ...bank, shortCode: e.target.value.toUpperCase() })}
                   style={{ width: 110 }} />
          </Field>
          <Field label="Country">
            <input value={bank.country} aria-label="New bank country" placeholder="Egypt"
                   onChange={(e) => setBank({ ...bank, country: e.target.value })} style={{ width: 150 }} />
          </Field>
          <Field label="Colour">
            <input type="color" value={bank.color} aria-label="New bank colour"
                   onChange={(e) => setBank({ ...bank, color: e.target.value })}
                   style={{ width: 64, height: 34, padding: 2, cursor: 'pointer' }} />
          </Field>
          <ActionButton capability="institution.add" className="btn add"
            disabled={!bank.name.trim() || !bank.shortCode.trim() || bank.country.trim().length < 2}
            onDone={(o) => { if (o.ok) { setBank(BANK_DRAFT); setAddingBank(false); } }}
            input={() => ({ name: bank.name.trim(), shortCode: bank.shortCode.trim(),
                            country: bank.country.trim(), color: bank.color })}>
            <Icon name="plus" size={13} /> Add it
          </ActionButton>
          <button className="btn ghost" onClick={() => { setBank(BANK_DRAFT); setAddingBank(false); }}>
            <Icon name="close" size={14} motion="none" /> Cancel
          </button>
        </div>
      )}

      {/* What the last write did, or why it was refused. Without it a button that the ledger
          turned down — no service behind the screen, most often — looks broken. */}

      {tab === 'accounts' && mode === 'edit' && (
        <p style={{ margin: 0, fontSize: 12, color: 'var(--faint)', lineHeight: 1.55, maxWidth: 780 }}>
          An account with movements against it cannot be deleted — that would rewrite what already
          happened. Archiving freezes the balance, drops it out of the pickers and keeps every row
          in the log that ever referenced it.
        </p>
      )}
    </Page>
  );
}


/**
 * Editing one account.
 *
 * Name, what it holds and what it is held in, changed together and saved once. The earlier
 * arrangement put a Save beside the name and another beside the balance, which made two
 * fields of one thing look like two different things — and left the currency out entirely,
 * offering a colour cycle in its place.
 *
 * The balance is the exception that has to be explained: restating it moves no money and
 * says nothing about where the difference came from. It used to write a movement from an
 * adjustment account so the log could "account for" it, which accounted for nothing — the
 * money flow read that account as a source and reported income nobody had earned. The act
 * itself is kept under Logs.
 */
function AccountEditor({ node, currency, held, currencies, run, isCredit }: {
  node: { id: string; name: string };
  currency: string;
  held: number;
  isCredit: boolean;
  currencies: ReturnType<typeof useApp>['currencies'];
  run: ReturnType<typeof useLive>['run'];
}) {
  const [draft, setDraft] = useState({ name: node.name, currency, balance: held });
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);

  const renamed = draft.name.trim() !== node.name;
  const recurrencied = draft.currency !== currency;
  const restated = Math.abs(draft.balance - held) > 0.005;
  const dirty = renamed || recurrencied || restated;

  const save = async () => {
    setBusy(true);
    setSaid(null);
    const said: string[] = [];
    if (renamed || recurrencied) {
      const res = await run('account.update', {
        accountId: node.id,
        name: renamed ? draft.name.trim() : undefined,
        currency: recurrencied ? draft.currency : undefined,
      });
      if (!res.ok) { setSaid(res.message ?? 'That could not be saved.'); setBusy(false); return; }
      said.push(res.summary ?? 'renamed');
    }
    if (restated) {
      const res = await run('account.correctBalance', { accountId: node.id, actual: draft.balance });
      if (!res.ok) { setSaid(res.message ?? 'The balance could not be corrected.'); setBusy(false); return; }
      said.push('balance restated');
    }
    setSaid(said.join(' · '));
    setBusy(false);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9, marginBottom: 4 }}>
      <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap', alignItems: 'center' }}>
        <input value={draft.name} aria-label={`${node.name} name`}
               onChange={(e) => setDraft({ ...draft, name: e.target.value })}
               style={{ fontSize: 14, padding: '6px 9px', minWidth: 150, flex: '1 1 150px' }} />
        <Amount value={draft.balance} ariaLabel={`${node.name} balance`}
                onChange={(n) => setDraft({ ...draft, balance: n })}
                style={{ width: 140, padding: '6px 9px', fontSize: 14 }} />
        <Select ariaLabel={`${node.name} currency`} value={draft.currency}
                style={{ width: 120 }}
                onChange={(v) => setDraft({ ...draft, currency: v })}
                options={currencies.map((c) => ({ value: c.code, label: `${c.symbol} ${c.code}`, hint: c.name }))} />
      </div>

      {restated && (
        <span style={{ fontSize: 11, color: 'var(--gold)', lineHeight: 1.45 }}>
          Saving restates this balance by {(draft.balance - held) > 0 ? '+' : '−'}
          {Math.abs(draft.balance - held).toLocaleString()} {draft.currency}. No movement is
          recorded, so nothing in the ledger says where the difference came from — the change
          itself is kept under Logs.
        </span>
      )}
      {isCredit && restated && (
        <span style={{ fontSize: 11, color: 'var(--faint)' }}>
          This is a debt, so a larger number means you owe more.
        </span>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="btn go sm" disabled={!dirty || busy} onClick={save}>
          <Icon name="check" size={13} motion="none" /> {busy ? 'Saving…' : 'Save'}
        </button>
        {dirty && (
          <button className="btn ghost sm"
                  onClick={() => { setDraft({ name: node.name, currency, balance: held }); setSaid(null); }}>
            <Icon name="close" size={13} motion="none" /> Cancel
          </button>
        )}
        {said && <span style={{ fontSize: 11, color: 'var(--muted)' }}>{said}</span>}
      </div>
    </div>
  );
}

/**
 * Every movement that touched an account.
 *
 * Money was being moved with nowhere to see it having moved, which meant the only evidence a
 * transfer had happened was a balance that had changed. This is the log itself.
 */
/** A movement, as the ledger reports it to the log. */
interface Movement {
  id: string; date: string; kind: string; note: string | null;
  automatic: boolean; reversedBy?: string | null; reverses?: string | null;
  legs: Array<{ fromNodeId?: string | null; fromName?: string | null;
                toNodeId?: string | null; toName?: string | null;
                qtyFrom?: number | null; rateApplied?: number | null }>;
}

/** What a movement may be called. The ledger accepts these and nothing else. */
const MOVEMENT_KINDS = ['income', 'expense', 'transfer', 'exchange', 'installment',
                        'purchase', 'sale', 'giving', 'correction'] as const;

function MovementRecords() {
  const { data } = useApp();
  const { live, version } = useLive();
  const [rows, setRows] = useState<Movement[] | null>(null);
  const [account, setAccount] = useState('');

  /**
   * The accounts a movement can name.
   *
   * An account is money you hold somewhere, which is what having an institution above it
   * says. A property's outstanding balance is a liability hanging off the asset itself, not
   * an account at a bank — listing it here put "Riverside Residences owed" among the current accounts
   * and made the picker read as a list of everything the ledger knows.
   */
  const institutions = new Set(data.institutions.map((i) => i.id));
  const accounts = data.nodes.filter((n) => (n.kind === 'cash' || n.kind === 'liability')
                                            && n.parentId && institutions.has(n.parentId));

  /**
   * Where money comes from and goes to, which is wider than the accounts.
   *
   * A salary arrives from an employer and rent leaves to a landlord; neither is an account of
   * yours, and a movement that names one still has to be findable by it.
   */
  const endpoints = data.nodes;
  const endpointOptions = [
    { value: '', label: 'Nowhere named' },
    ...[...endpoints].sort((a, b) => a.name.localeCompare(b.name))
      .map((n) => ({ value: n.id, label: n.name,
                     hint: data.institutions.find((i) => i.id === n.parentId)?.name ?? n.kind })),
  ];
  /** every place a movement could name, for the column filters */
  const endpointNames = [...new Set(endpoints.map((n) => n.name))].sort();
  /** which institution a node sits at, for the second line under an account's name */
  const bankOf = (id?: string | null) =>
    data.institutions.find((i) => i.id === data.nodes.find((n) => n.id === id)?.parentId)?.name ?? null;

  /**
   * Which way the money went, from where this screen is standing.
   *
   * With one account chosen, in and out are that account's: what arrived in it and what left
   * it. Looking at every account, they are your cash as a whole — money that went from a bank
   * into gold has left, even though you still own the gold, because this is the log of what
   * the accounts did.
   *
   * A movement between two of your own accounts is neither, and is left uncoloured rather
   * than counted twice: nothing came in and nothing went out, it only moved.
   */
  const cashIds = new Set(data.nodes.filter((n) => n.kind === 'cash').map((n) => n.id));
  const flowOf = (m: Movement): 'in' | 'out' | null => {
    const leg = m.legs[0];
    if (!leg) return null;
    const mine = (id?: string | null) => !!id && (account ? id === account : cashIds.has(id));
    const from = mine(leg.fromNodeId);
    const to = mine(leg.toNodeId);
    if (from === to) return null;
    return to ? 'in' : 'out';
  };

  const load = useCallback(() => {
    if (!live) { setRows(null); return; }
    (ledger as any)['movements.list']({ accountId: account || undefined, limit: 300 })
      .then(setRows).catch(() => setRows(null));
  }, [live, account]);
  useEffect(load, [load, version]);

  if (!live) {
    return (
      <Panel title="Records">
        <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
          The movement log lives in the ledger service, and there is none behind this screen yet.
        </p>
      </Panel>
    );
  }

  return (
    <Panel title="Records"
           hint="Every movement, newest first. Undoing one writes its opposite, so the balance returns and the log still says both things happened.">
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <Select ariaLabel="Which account" value={account} onChange={setAccount} style={{ minWidth: 240 }}
                options={[{ value: '', label: 'Every account' },
                          ...accounts.map((n) => ({
                            value: n.id, label: n.name,
                            hint: `${data.institutions.find((i) => i.id === n.parentId)?.name ?? ''}${n.kind === 'liability' ? ' · credit' : ''}`.trim(),
                          }))]} />
      </div>

      {/* The movement log is a log like any other, so it is drawn by the same table: every
          heading filters its own column, and every column can be corrected in Edit mode.
          Correcting reverses the movement and posts the corrected one in its place, so the
          balances follow and the log still says both things happened. */}
      <RecordTable<Movement>
        rows={rows ?? []}
        rowKey={(m) => m.id}
        sort={{ key: 'date', dir: 'desc' }}
        empty={{ icon: 'ledger', title: 'Nothing recorded yet',
                 body: 'Moving money between accounts writes a movement, and it appears here.' }}
        columns={[
          { key: 'date', label: 'Date', kind: 'date',
            value: (m) => m.date,
            cell: (m) => <span className="mono" style={{ fontSize: 13 }}>{m.date}</span>,
            field: (d, set) => (
              <DateField value={String(d.date ?? '')} ariaLabel="Date"
                         onChange={(v) => set({ date: v })} />
            ) },
          { key: 'kind', label: 'What', kind: 'pick',
            choices: [...MOVEMENT_KINDS],
            value: (m) => m.kind,
            /* two chips side by side widened the column and, once it wrapped, sat over the
               account name in the next one — so "automatic" reads as a small second line
               under the kind, the same way a bank reads under its account */
            cell: (m) => (
              <span style={{ display: 'block', minWidth: 0 }}>
                <Chip tone={m.kind === 'income' ? 'good'
                          : m.kind === 'correction' ? 'warn'
                          : m.kind === 'expense' || m.kind === 'giving' ? 'bad' : 'info'}>
                  {m.kind}
                </Chip>
                {m.automatic && <span className="at-bank">automatic</span>}
              </span>
            ),
            field: (d, set) => (
              <Select ariaLabel="What this movement is" value={String(d.kind ?? 'transfer')}
                      onChange={(v) => set({ kind: v })}
                      options={MOVEMENT_KINDS.map((k) => ({ value: k, label: k }))} />
            ) },
          { key: 'from', label: 'Source', kind: 'pick',
            choices: endpointNames,
            value: (m) => m.legs[0]?.fromName ?? '—',
            cell: (m) => (m.legs[0]?.fromName
              ? <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                  <AccountName name={m.legs[0].fromName!} bank={bankOf(m.legs[0].fromNodeId)} />
                </span>
              : <span style={{ fontSize: 12, color: 'var(--faint)' }}>—</span>),
            field: (d, set) => (
              <Select ariaLabel="Source" value={String(d.fromAccountId ?? '')}
                      onChange={(v) => set({ fromAccountId: v })} options={endpointOptions} />
            ) },
          { key: 'to', label: 'Destination', kind: 'pick',
            choices: endpointNames,
            value: (m) => m.legs[0]?.toName ?? '—',
            cell: (m) => (m.legs[0]?.toName
              ? <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                  <AccountName name={m.legs[0].toName!} bank={bankOf(m.legs[0].toNodeId)} />
                </span>
              : <span style={{ fontSize: 12, color: 'var(--faint)' }}>—</span>),
            field: (d, set) => (
              <Select ariaLabel="Destination" value={String(d.toAccountId ?? '')}
                      onChange={(v) => set({ toAccountId: v })} options={endpointOptions} />
            ) },
          /*
            * The amount says which way it went.
            *
            * Green and a plus for what arrived, red and a minus for what left, and the
            * ordinary colour for a movement between two of your own accounts — a log where
            * every figure looks the same makes you read two more columns to learn the one
            * thing you wanted from this one.
            */
          { key: 'amount', label: 'Amount', kind: 'amount', align: 'right',
            value: (m) => m.legs[0]?.qtyFrom ?? 0,
            cell: (m) => {
              const leg = m.legs[0] ?? {};
              const way = flowOf(m);
              const colour = way === 'in' ? 'var(--positive)'
                           : way === 'out' ? 'var(--negative)' : undefined;
              return (
                <span className="mono" style={{ color: colour, fontWeight: way ? 500 : undefined }}>
                  {leg.qtyFrom != null
                    ? `${way === 'in' ? '+' : way === 'out' ? '−' : ''}${Math.round(leg.qtyFrom).toLocaleString()}`
                    : '—'}
                  {/* a rate is read, not calculated with, so it is shown to four places
                      rather than to the fifteen the arithmetic produced */}
                  {leg.rateApplied ? (
                    <span style={{ display: 'block', fontSize: 11, color: 'var(--faint)' }}>
                      @ {Number(leg.rateApplied.toFixed(4))}
                    </span>
                  ) : null}
                </span>
              );
            },
            field: (d, set) => (
              <Amount value={Number(d.amount ?? 0)} ariaLabel="Amount"
                      onChange={(n) => set({ amount: n })} />
            ) },
          { key: 'note', label: 'Note', kind: 'text',
            value: (m) => m.note ?? '',
            cell: (m) => (
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                {m.note || <span style={{ color: 'var(--faint)' }}>—</span>}
                {m.reversedBy && <span style={{ display: 'block', fontSize: 11, color: 'var(--gold)' }}>undone</span>}
              </span>
            ),
            field: (d, set) => (
              <input aria-label="Note" placeholder="what this was"
                     value={d.note ?? ''} onChange={(e) => set({ note: e.target.value })} />
            ) },
        ]}
        /**
         * Correcting a movement is not editing one.
         *
         * The ledger never rewrites a movement in place — a past that can change is a past
         * nobody can check. Saving here reverses what was recorded and posts the corrected
         * movement in its place, in one act: if the correction is refused, the reversal goes
         * with it. The log keeps both rows, which is what makes the correction visible as one.
         */
        edit={{
          capability: 'movement.amend',
          draftOf: (m) => ({
            date: m.date,
            kind: m.kind,
            fromAccountId: m.legs[0]?.fromNodeId ?? '',
            toAccountId: m.legs[0]?.toNodeId ?? '',
            amount: m.legs[0]?.qtyFrom ?? 0,
            note: m.note ?? '',
          }),
          build: (d, m) => ({
            movementId: m.id,
            date: d.date || undefined,
            kind: d.kind || undefined,
            fromAccountId: d.fromAccountId || null,
            toAccountId: d.toAccountId || null,
            amount: Number(d.amount) > 0 ? Number(d.amount) : undefined,
            note: d.note ?? '',
          }),
          blocked: (m) => (m.reversedBy ? 'That movement has already been undone, so there is nothing to correct.'
                         : m.reverses ? 'That movement is itself a correction. Correct the one it replaced.'
                         : m.legs.length > 1 ? 'That movement has more than one leg. Undo it and record the corrected one.'
                         : undefined),
          onDone: load,
        }}
        remove={{
          capability: 'movement.undo',
          build: (m) => ({ movementId: m.id }),
          what: (m) => `the ${m.kind} of ${m.date}`,
          blocked: (m) => (m.reversedBy ? 'That movement has already been undone.'
                         : m.reverses ? 'That movement is itself a reversal.' : undefined),
          onDone: load,
        }}
      />
    </Panel>
  );
}