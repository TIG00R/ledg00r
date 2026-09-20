import { useCallback, useEffect, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { Amount } from '../components/Amount';
import { Donut } from '../components/Donut';
import { useApp, market } from '../AppState';
import { money, toEgp, fromEgp, type Currency } from '@ledger/engine';
import { Page, Panel, Chip, Row, Field, AccountName } from '../components/UI';
import { Icon } from '../components/Icon';
import { OperationPanel, MoveMoney } from '../components/Operations';
import { SectionProvider, Sections, useSection } from '../components/Sections';
import { useAppearance } from '../Appearance';
import { ConfirmDelete } from '../components/Confirm';
import { Mark, MarkPicker } from '../components/Mark';
import { Select } from '../components/Select';
import { RecordTable, isInteractive } from '../components/RecordTable';
import { DateField } from '../components/DateField';
import { ledger } from '../api';
import { ActionButton, useLive } from '../Live';
import { movementCount } from '@ledger/engine';
import { accountOption } from '../accounts';

// the last column now holds a pencil beside the bin, rather than the bin alone
const COLS = '54px minmax(220px,1fr) 150px 108px';

export function Accounts() {
  return (
    <SectionProvider first="accounts"><Body /></SectionProvider>
  );
}

function Body() {
  const { data, dm, display, values, balances, currencies } = useApp();
  const { tab } = useSection();
  const { appearance } = useAppearance();
  const { run } = useLive();
  /** balances being corrected before they are recorded */
  const [drafts] = useState<Record<string, number>>({});
  /** name edits are held until they are saved, so closing the row by mistake does not lose them */
  const [names, setNames] = useState<Record<string, string>>({});
  const [pickingInst, setPickingInst] = useState<string | null>(null);
  /**
   * The one row open for correction — a bank, or an account under one — named
   * `inst:<id>` or `acct:<id>` so the two kinds never collide. Double-click a row, press
   * Enter with it focused, or press its pencil; only one is ever open at a time.
   */
  const [openId, setOpenId] = useState<string | null>(null);
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
   * These are the ones a bank stands behind, and they are grouped under the bank that holds
   * them. Cash held anywhere else is just as real and is drawn underneath them — see `loose`.
   */
  const cash = data.nodes.filter((n) => n.kind === 'cash' && n.parentId && atBankOf(data).has(n.parentId));
  /**
   * Cash you hold that no bank holds for you.
   *
   * A broker's wallet, its savings cloud, and the same two for every other exchange opened
   * beside it. This money was shown nowhere on this screen: it left a bank account, which the
   * log recorded, and then arrived somewhere the accounts screen did not admit existed — so
   * "where did that go" had no answer here. It is money you hold, so it is drawn with the
   * accounts and counted in the total, under its own heading rather than under a bank that
   * does not hold it.
   */
  const loose = data.nodes.filter((n) => n.kind === 'cash'
                                      && !(n.parentId && atBankOf(data).has(n.parentId)));
  // A card is a liability held at an institution; a contract balance is a liability held
  // against the asset it bought. Only the first belongs among the accounts.
  const atBank = atBankOf(data);
  const credit = data.nodes.filter((n) => n.kind === 'liability' && n.parentId && atBank.has(n.parentId));
  // what the account holds: the correction in progress, then the ledger, then the opening
  const qty = (id: string, fallback: number) => drafts[id] ?? balances[id] ?? fallback;

  /** one unit of this currency, priced in the ledger's currency */
  const unitRate = (cur: string) => fromEgp(toEgp(1, cur, market), display, market);
  const inDisplay = (n: (typeof cash)[number]) => toEgp(qty(n.id, n.openingQty), n.currency ?? 'EGP', market);

  // Every account's cash, the broker's wallets included — they were left out, which is why
  // this figure and the one the movements work out to could never be made to agree.
  const totalCash = [...cash, ...loose].reduce((s, n) => s + inDisplay(n), 0);
  const totalCredit = credit.reduce((s, n) => s + qty(n.id, n.openingQty), 0);

  const byCurrency = new Map<string, number>();
  for (const n of [...cash, ...loose]) byCurrency.set(n.currency!, (byCurrency.get(n.currency!) ?? 0) + qty(n.id, n.openingQty));

  return (
    <Page aside={(
      <OperationPanel title="Move money"
        hint="Between two of your own accounts. Where the currencies differ this is an exchange, so the rate the bank actually gave you and its fee belong to the record.">
        <MoveMoney />
      </OperationPanel>
    )}>
      <Sections sections={[
        { id: 'accounts', label: 'Accounts', icon: 'accounts',
          hint: 'What you hold, and where. Double-click a bank or an account to rename it, correct it, add one, or archive one.' },
        { id: 'records', label: 'Records', icon: 'ledger',
          hint: 'Every movement that touched an account, newest first. Double-click one to undo it — it writes the opposite rather than erasing it, so the log keeps both.' },
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
          <div style={{ display: 'flex', gap: 24, alignItems: 'center', flexWrap: 'wrap', flex: 1, minWidth: 280 }}>
            <Donut
              slices={[...byCurrency].map(([cur, amt]) => ({
                label: cur,
                value: toEgp(amt, cur, market),
                color: appearance.currencies[cur]?.color ?? 'var(--muted)',
              }))}
              size={140} thickness={18} format={(n) => dm(n)}
              centre={<span style={{ fontSize: 11, color: 'var(--faint)' }}>by currency</span>}
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
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
        <span className="ov">1 unit in {display}</span>
        <span />
      </Row>
      )}

      {tab === 'records' && <MovementRecords />}

      {tab === 'accounts' && data.institutions.map((inst) => {
        const accounts = cash.filter((n) => n.parentId === inst.id);
        const cards = credit.filter((n) => n.parentId === inst.id);
        const subtotal = accounts.reduce((s, n) => s + inDisplay(n), 0);
        const instColour = appearance.institutions[inst.id] ?? inst.color;
        const openThis = openId === `inst:${inst.id}`;
        const startEditing = () => setOpenId(`inst:${inst.id}`);
        const stopEditing = () => {
          setOpenId(null);
          setNames(({ [inst.id]: _drop, ...rest }) => rest);
          setPickingInst(null);
        };
        return (
          <div key={inst.id} style={{ borderRadius: 14, border: '1px solid var(--hairline)',
                                      background: 'var(--surface)', overflow: 'hidden' }}>
            <div className="mgr-row"
                 style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '15px 18px',
                          background: 'var(--raised)', borderBottom: '1px solid var(--hairline)',
                          cursor: openThis ? undefined : 'pointer' }}
                 tabIndex={openThis ? undefined : 0}
                 aria-label={openThis ? undefined : `Double-click, or press Enter, to edit ${inst.name}`}
                 onDoubleClick={openThis ? undefined : (e) => { if (!isInteractive(e.target)) startEditing(); }}
                 onKeyDown={openThis ? undefined : (e) => {
                   if (e.key !== 'Enter' || isInteractive(e.target)) return;
                   e.preventDefault();
                   startEditing();
                 }}>
              {openThis ? (
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
                {openThis ? (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <input value={nameOf(inst.id, inst.name)} aria-label={`${inst.name} name`}
                           onChange={(e) => setNames({ ...names, [inst.id]: e.target.value })}
                           style={{ fontSize: 15, fontWeight: 600, padding: '4px 8px' }} />
                    {names[inst.id] != null && names[inst.id] !== inst.name && (
                      <ActionButton capability="institution.update" className="btn go sm"
                        style={undefined}
                        onDone={(o) => { if (o.ok) stopEditing(); }}
                        input={{ institutionId: inst.id, name: names[inst.id] }}>Save</ActionButton>
                    )}
                    <button className="btn ghost sm" onClick={stopEditing}>
                      <Icon name="close" size={13} motion="none" /> Close
                    </button>
                    <Chip tone="warn">no movement is recorded</Chip>
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
                {!openThis && (
                  <button className="btn quiet rt-hint" onClick={startEditing} aria-label={`Edit ${inst.name}`}
                          title="Edit" style={{ padding: 7, border: 'none' }}>
                    <Icon name="edit" size={14} />
                  </button>
                )}
                <button className="btn add" style={{ padding: '7px 12px', fontSize: 12 }}
                        onClick={() => setAdding(adding === inst.id ? null : inst.id)}>
                  <Icon name="plus" size={13} /> Account
                </button>
                <ConfirmDelete what={inst.name} className="rt-hint"
                  blocked={accounts.length + cards.length > 0
                    ? `${inst.name} still holds ${accounts.length + cards.length} account${accounts.length + cards.length === 1 ? '' : 's'}. Archive it instead — every balance and every movement stays readable.`
                    : undefined}
                  onArchive={() => { void run('institution.update', { institutionId: inst.id, archived: true }); }}
                  onConfirm={() => { void run('institution.remove', { institutionId: inst.id }); }} />
              </div>
            </div>

            {adding === inst.id && (
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

            {pickingInst === inst.id && openThis && (
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
              const openAcct = openId === `acct:${n.id}`;
              const openAccount = () => setOpenId(`acct:${n.id}`);
              return (
                <Row key={n.id} cols={COLS} style={{
                  padding: '13px 18px',
                  borderBottom: i === arr.length - 1 ? 'none' : '1px solid var(--hairline)',
                  background: isCredit ? 'color-mix(in srgb, var(--negative) 5%, transparent)' : undefined,
                  cursor: openAcct ? undefined : 'pointer',
                }}
                tabIndex={openAcct ? undefined : 0}
                aria-label={openAcct ? undefined : `Double-click, or press Enter, to edit ${n.name}`}
                onDoubleClick={openAcct ? undefined : (e: MouseEvent<HTMLDivElement>) => { if (!isInteractive(e.target)) openAccount(); }}
                onKeyDown={openAcct ? undefined : (e: KeyboardEvent<HTMLDivElement>) => {
                  if (e.key !== 'Enter' || isInteractive(e.target)) return;
                  e.preventDefault();
                  openAccount();
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
                    {openAcct ? (
                      <AccountEditor node={n} currency={cur} isCredit={isCredit}
                        held={balances[n.id] ?? n.openingQty}
                        currencies={currencies} run={run} onClose={() => setOpenId(null)} />
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

                  <span className="mono" style={{ fontSize: 13, color: 'var(--muted)' }}>
                    {cur === display ? '1' : unitRate(cur).toFixed(cur === 'EGP' ? 5 : 4)}
                  </span>

                  <span style={{ display: 'flex', justifyContent: 'flex-end', gap: 4 }}>
                    {!openAcct && (
                      <button className="btn quiet rt-hint" onClick={openAccount} aria-label={`Edit ${n.name}`}
                              title="Edit" style={{ padding: 7, border: 'none' }}>
                        <Icon name="edit" size={14} />
                      </button>
                    )}
                    {(() => {
                      // an account with movements against it cannot go: deleting it would
                      // rewrite what already happened
                      const used = movementCount(data, n.id);
                      return (
                        <ConfirmDelete what={n.name} className="rt-hint"
                          blocked={used > 0
                            ? `${used} movement${used === 1 ? '' : 's'} name this account. Archiving freezes the balance and keeps every row in the log.`
                            : undefined}
                          onArchive={() => { void run('account.archive', { accountId: n.id }); }}
                          onConfirm={() => { void run('account.remove', { accountId: n.id }); }} />
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
      {tab === 'accounts' && !addingBank && (
        <div>
          <button className="btn" onClick={() => setAddingBank(true)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
            <Icon name="plus" size={14} /> Bank
          </button>
        </div>
      )}

      {tab === 'accounts' && addingBank && (
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

      {/*
        * Cash no bank holds: a broker's wallet, its savings cloud, and the same pair for every
        * other exchange. Money moved into one of these left a bank account and arrived here,
        * and until this block existed it arrived somewhere this screen did not draw — so the
        * movement was recorded and the destination was invisible. It is read here rather than
        * edited: the book that owns it is where it is renamed and where money is put into it.
        */}
      {tab === 'accounts' && loose.length > 0 && (
        <div style={{ borderRadius: 14, border: '1px solid var(--hairline)',
                      background: 'var(--surface)', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '15px 18px',
                        background: 'var(--raised)', borderBottom: '1px solid var(--hairline)' }}>
            <span style={{ width: 38, height: 30, borderRadius: 8, background: 'var(--control)',
                           display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="stocks" size={17} color="var(--muted)" />
            </span>
            <div>
              <div style={{ fontSize: 15, fontWeight: 600 }}>Held outside a bank</div>
              <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 2 }}>
                a broker's wallet and its cloud · {loose.length} account{loose.length === 1 ? '' : 's'}
              </div>
            </div>
            <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
              <div className="ov">Here</div>
              <div className="mono" style={{ fontSize: 16, fontWeight: 500 }}>
                {dm(loose.reduce((sum, n) => sum + inDisplay(n), 0))}
              </div>
            </div>
          </div>
          {loose.map((n) => (
            <Row key={n.id} cols={COLS} style={{ padding: '12px 18px', borderTop: '1px solid var(--hairline)' }}>
              <span className="mono" style={{ fontSize: 12, color: 'var(--faint)' }}>{n.currency}</span>
              <span style={{ fontSize: 13 }}>{n.name}</span>
              <span className="mono" style={{ fontSize: 13 }}>
                {money(qty(n.id, n.openingQty), n.currency as Currency, n.currency === 'EGP' ? 0 : 2)}
              </span>
              <span />
            </Row>
          ))}
        </div>
      )}

      {tab === 'accounts' && (
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
function AccountEditor({ node, currency, held, currencies, run, isCredit, onClose }: {
  node: { id: string; name: string };
  currency: string;
  held: number;
  isCredit: boolean;
  currencies: ReturnType<typeof useApp>['currencies'];
  run: ReturnType<typeof useLive>['run'];
  /** the row this editor lives in has closed — either the correction was saved, or given up on */
  onClose: () => void;
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
    onClose();
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
        <button className="btn go sm" disabled={busy} onClick={save}>
          <Icon name="check" size={13} motion="none" /> {busy ? 'Saving…' : 'Save'}
        </button>
        <button className="btn ghost sm" onClick={onClose}>
          <Icon name="close" size={13} motion="none" /> {dirty ? 'Cancel' : 'Close'}
        </button>
        <Chip tone="warn">no movement is recorded</Chip>
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
                qtyFrom?: number | null; rateApplied?: number | null;
                /** what a bank kept on the way — out of the same account the movement left */
                feeQty?: number | null }>;
}

/** What a movement may be called. The ledger accepts these and nothing else. */
const MOVEMENT_KINDS = ['income', 'expense', 'transfer', 'exchange', 'installment',
                        'purchase', 'sale', 'giving', 'correction'] as const;

/**
 * Which institutions actually stand behind an account.
 *
 * A node's parent is an institution only when the ledger has one by that id — a property's
 * outstanding balance hangs off the asset that bought it, which is a parent but not a bank.
 */
function atBankOf(data: ReturnType<typeof useApp>['data']): Set<string> {
  return new Set(data.institutions.map((i) => i.id));
}

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
  const institutions = atBankOf(data);
  /**
   * Every account a movement can be read by — the ones a bank holds, and the cash held
   * outside one: a broker's wallet and its cloud. Leaving those out meant money moved into
   * the book could not be read back from the book's own side, which is half of what a
   * transfer is. A property's outstanding balance is still not an account, and is still not
   * here: it is a liability hanging off the asset that bought it.
   */
  const accounts = data.nodes.filter((n) => (n.kind === 'cash' && (!n.parentId || institutions.has(n.parentId)))
                                            || (n.kind === 'liability' && n.parentId && institutions.has(n.parentId)));

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
      .map((n) => accountOption(data, n, { fallback: n.kind })),
  ];
  /**
   * Every place a movement could name, for the column filters.
   *
   * A filter over a column of accounts used to offer the bare names the log prints, so a
   * picker that everywhere else in the application reads "Nile Bank / Current · EGP" with the
   * bank's mark beside it read "Current" here, and two accounts called Current at two banks
   * were one indistinguishable line. The filter matches the text the column holds — that is
   * what a filter can match — but it is drawn as the account it names, which is what a reader
   * is looking for. Names are unique here because a name is all the column has to go on: two
   * accounts sharing one make one entry that finds the movements of both, and saying so twice
   * would only promise a distinction the log cannot make.
   */
  const endpointChoices = [...new Map([...endpoints]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((n) => [n.name, accountOption(data, n, { fallback: n.kind, value: n.name })]))
    .values()];
  /** which institution a node sits at, for the second line under an account's name */
  const bankOf = (id?: string | null) =>
    data.institutions.find((i) => i.id === data.nodes.find((n) => n.id === id)?.parentId)?.name ?? null;

  /**
   * Which currency a figure in this log is counted in.
   *
   * A movement's amount is in the unit of the account it left, or of the one it reached where
   * it left nothing of yours. Printed bare, a column mixing pounds and dollars reads as one
   * currency and the wrong one: 20 out of a dollar account looked smaller than 300 out of a
   * pound account. The letters are the account's own, so what the column says is what the
   * account actually lost.
   */
  const currencyOf = (m: Movement): string | null => {
    const leg = m.legs[0];
    if (!leg) return null;
    // An employer and a landlord are nodes with no currency of their own, and a salary names
    // one on the side the money came from — so the side that answers is whichever of the two
    // is actually held in something.
    const side = (id?: string | null) => (id ? data.nodes.find((n) => n.id === id)?.currency ?? null : null);
    return side(leg.fromNodeId) ?? side(leg.toNodeId);
  };

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

  /**
   * What the movement took out of the account it came from.
   *
   * A leg's own amount is what reached the other end; a charge taken on the way is recorded
   * beside it and comes out of the same account. The account lost both, so both are what the
   * log has to say it lost.
   */
  const leftSource = (m: Movement): number => {
    const leg = m.legs[0];
    if (!leg || leg.qtyFrom == null) return 0;
    return leg.qtyFrom + (leg.feeQty ?? 0);
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
                          ...accounts.map((n) => accountOption(data, n,
                            n.kind === 'liability' ? { note: 'credit' } : undefined))]} />
      </div>

      {/* The movement log is a log like any other, so it is drawn by the same table: every
          heading filters its own column, and double-clicking a row corrects it.
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
            choices: endpointChoices,
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
            choices: endpointChoices,
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
          { key: 'amount', label: 'Amount', kind: 'amount',
            /* What actually left the source: the sum that moved plus the charge taken on the
               way, because both came out of the same account. Sorting and filtering read the
               same figure the eye does. */
            value: (m) => leftSource(m),
            cell: (m) => {
              const leg = m.legs[0] ?? {};
              const way = flowOf(m);
              const colour = way === 'in' ? 'var(--positive)'
                           : way === 'out' ? 'var(--negative)' : undefined;
              const fee = leg.feeQty ?? 0;
              const code = currencyOf(m);
              return (
                <span className="mono" style={{ color: colour, fontWeight: way ? 500 : undefined }}>
                  {leg.qtyFrom != null
                    ? `${way === 'in' ? '+' : way === 'out' ? '−' : ''}${Math.round(leftSource(m)).toLocaleString()}${code ? ` ${code}` : ''}`
                    : '—'}
                  {/* A movement with a charge on it moved two figures, not one: what the
                      account lost, and what the other end received. Showing only the second
                      made a thousand pounds sent read as nine hundred and eighty — the fee
                      was recorded and nothing on screen said so. */}
                  {fee > 0 && leg.qtyFrom != null && (
                    <span style={{ display: 'block', fontSize: 11, color: 'var(--faint)' }}>
                      {Math.round(leg.qtyFrom).toLocaleString()} arrived · {Math.round(fee).toLocaleString()} fee
                      {code ? ` ${code}` : ''}
                    </span>
                  )}
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
          /* What the bank kept. Its own column so a year of charges can be sorted to the top
             and totalled by eye, rather than hiding under the amount it came out of. */
          { key: 'fee', label: 'Fee', kind: 'amount',
            value: (m) => m.legs[0]?.feeQty ?? 0,
            cell: (m) => {
              const fee = m.legs[0]?.feeQty ?? 0;
              const code = currencyOf(m);
              return fee > 0
                ? <span className="mono" style={{ color: 'var(--negative)' }}>
                    {Math.round(fee).toLocaleString()}{code ? ` ${code}` : ''}
                  </span>
                : <span style={{ color: 'var(--faint)' }}>—</span>;
            } },
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
        /*
          * The movement log is what every other log stands on, so emptying it empties those
          * too — the expenses, the giving, the orders, the lots and the debts all name a
          * movement, and a record pointing at one that no longer exists claims something the
          * balances do not agree with.
          */
        clear={{ log: 'movements',
                 what: 'the movement log itself, and every record standing on it — spending, giving, orders, metal lots, debts and plans',
                 onDone: load }}
      />
    </Panel>
  );
}