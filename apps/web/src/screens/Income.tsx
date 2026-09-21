import { useEffect, useState } from 'react';
import { Amount } from '../components/Amount';
import { RecordAmount } from '../components/RecordAmount';
import { Select } from '../components/Select';
import { useApp, market } from '../AppState';
import { money, splitByCurrency, toEgp, fromEgp } from '@ledger/engine';
import { Page, Panel, Stat, Stats } from '../components/UI';
import { AccountLine } from '../components/AccountLine';
import { Mark } from '../components/Mark';
import { CurrencySplits } from '../components/CurrencySplits';
import { SectionProvider, Sections, useSection } from '../components/Sections';
import { useLive } from '../Live';
import { Manager } from '../components/Manager';
import { RecordTable } from '../components/RecordTable';
import { ledger } from '../api';
import { DateField } from '../components/DateField';
import { accountOption } from '../accounts';

export function Income() {
  return (
    <SectionProvider first="sources"><Body /></SectionProvider>
  );
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const FALLBACK_LOGGED = [
  { id: 'l1', date: '2026-07-14', source: 'Freelance work', amount: 1800, currency: 'USD', into: 'Nile Bank · USD savings', intoId: 'nile-usd-sav', note: 'Q2 retainer, final invoice' },
  { id: 'l2', date: '2026-05-02', source: 'Freelance work', amount: 1200, currency: 'USD', into: 'Nile Bank · USD savings', intoId: 'nile-usd-sav', note: 'critical, triaged in 3 days' },
  { id: 'l3', date: '2026-04-19', source: 'Freelance work', amount: 1500, currency: 'USD', into: 'Nile Bank · USD savings', intoId: 'nile-usd-sav', note: '' },
  { id: 'l4', date: '2026-03-08', source: 'Freelance work', amount: 600, currency: 'USD', into: 'Nile Bank · USD savings', intoId: 'nile-usd-sav', note: 'medium severity' },
  { id: 'l5', date: '2026-02-11', source: 'Freelance work', amount: 900, currency: 'USD', into: 'Nile Bank · USD savings', intoId: 'nile-usd-sav', note: '' },
];

function Body() {
  const { data, dm, values, currencies, display } = useApp();

  /** things that can earn rent, so a source can name the one that earns it */
  const lettable = data.nodes.filter((n) => n.kind === 'asset' && !n.unit
    && !/^brokerage|^debt-/.test(n.id) && !n.archived);
  /**
   * The accounts income can land in.
   *
   * A source pays into one, which is what makes its payments money rather than a note — so
   * the account is chosen on the source. It used to be taken from a setting that is empty in
   * a ledger nobody has configured, and the form then sent nothing where an account id was
   * required: adding any source at all failed with "the input does not match what this
   * capability takes", and no field on screen said what was missing.
   *
   * Held at a bank, as the accounts screen reads them — the brokerage wallet is the share
   * book's own money and no wage is paid into it.
   */
  const banked = new Set(data.institutions.map((i) => i.id));
  const cashAccounts = data.nodes.filter((n) => n.kind === 'cash' && !n.archived
    && n.parentId && banked.has(n.parentId));
  /**
   * The accounts a source paid in one currency can actually land in.
   *
   * An account holds one currency, so a salary paid in dollars lands in a dollar account —
   * offering every account would offer a destination that cannot receive it, and a pound
   * arriving in a pound account is not the same fact as a pound arriving in an Egyptian one.
   */
  const accountsIn = (code: string) => cashAccounts.filter((n) => (n.currency ?? 'EGP') === code);
  const currencyOf = (v: Record<string, string | number>) =>
    String(v.currency || currencies[0]?.code || 'EGP');
  const accountOptions = (code: string) => accountsIn(code).map((n) => accountOption(data, n));
  /**
   * Which account a draft is actually saying, rather than which one it last said.
   *
   * A picker shows its first option when the value it holds is not among them, so changing
   * the currency leaves the field reading one account while the draft still holds another —
   * and saving would then write the one nobody can see. This is what the picker is showing:
   * the chosen account when it is still a choice, and otherwise the first that is.
   */
  const accountFor = (v: Record<string, string | number>) => {
    const mine = accountsIn(currencyOf(v));
    const chosen = String(v.toAccountId ?? '');
    return mine.some((n) => n.id === chosen) ? chosen : (mine[0]?.id ?? '');
  };
  const { run, live, version } = useLive();
  /**
   * What has actually landed.
   *
   * Read from the ledger and re-read after every write, so recording a payment shows up in
   * the list below rather than appearing to do nothing. With no service, the fixture stands
   * in and the screen still reads correctly.
   */
  const [landed, setLanded] = useState<typeof FALLBACK_LOGGED | null>(null);
  useEffect(() => {
    if (!live) { setLanded(null); return; }
    let off = false;
    (ledger as any)['income.list']({})
      .then((rows: any[]) => {
        if (off) return;
        setLanded(rows.map((r) => ({
          id: r.id, date: r.date, source: r.source, amount: r.amount,
          currency: r.currency, into: r.into, intoId: r.intoId ?? null, note: r.note ?? '',
        })));
      })
      .catch(() => { if (!off) setLanded(null); });
    return () => { off = true; };
  }, [live, version]);
  const LOGGED = landed ?? FALLBACK_LOGGED;

  const { tab } = useSection();
  /*
   * A source's mark comes from the source.
   *
   * There used to be a table of hard-coded marks here, seeded per source id, and it won over
   * whatever had been saved — so uploading a picture wrote it to the database and the screen
   * kept showing the icon this map had chosen. There is no local copy now.
   */
  const scheduled = data.incomeSources.filter((s) => s.scheduled);
  const occasional = data.incomeSources.filter((s) => !s.scheduled);

  const monthly = splitByCurrency(scheduled, (s) => (s.amount == null ? null : { amount: s.amount, currency: s.currency }), market);

  // Derived from the log rather than restated, so the first payment recorded moves it.
  const year = String(new Date().getFullYear());
  const occasionalThisYear = LOGGED.filter((l) => l.date.startsWith(year));
  const occasionalEgp = occasionalThisYear.reduce((s2, l) => s2 + toEgp(l.amount, l.currency, market), 0);
  const perSource = (id: string) => {
    const src = data.incomeSources.find((x) => x.id === id);
    const mine = occasionalThisYear.filter((l) => l.source === src?.name);
    return mine.reduce((s2, l) => s2 + toEgp(l.amount, l.currency, market), 0);
  };
  /**
   * What a source has paid, in the currency that source is paid in.
   *
   * A dollar rent landing in a dollar account was being summarised in pounds, which is a
   * conversion nobody asked for and at today's rate rather than at the rates it arrived on.
   * The sum is still carried in pounds because a source can be paid in more than one
   * currency; it is read back in the source's own.
   */
  const perSourceNative = (id: string) => {
    const src = data.incomeSources.find((x) => x.id === id);
    const cur = src?.currency ?? 'EGP';
    return { amount: fromEgp(perSource(id), cur, market), currency: cur,
             count: occasionalThisYear.filter((l) => l.source === src?.name).length };
  };
  const nativeMoney = (v: { amount: number; currency: string }) =>
    money(v.amount, v.currency, v.currency === 'EGP' ? 0 : 2);
  const accountName = (id: string) => {
    const n = data.nodes.find((x) => x.id === id);
    const inst = data.institutions.find((i) => i.id === n?.parentId);
    return { bank: inst?.name ?? '', account: n?.name ?? id };
  };

  return (
    <Page>
      <Sections sections={[
        { id: 'sources', label: 'Sources', icon: 'income',
          hint: 'Where money comes from. Scheduled sources accrue on their own — double-click one to rename it, change what it pays, or retire it.' },
        { id: 'records', label: 'Records', icon: 'ledger',
          hint: 'Every payment that actually landed, newest first.' },
      ]} />
      <Panel>
        <Stats>
          <Stat label="Scheduled, per month" value={dm(monthly.totalEgp)} sub="what the forecast uses" color="var(--positive)" />
          <Stat label="Occasional, this year" value={dm(occasionalEgp)}
                sub={`${occasionalThisYear.length} payment${occasionalThisYear.length === 1 ? '' : 's'} recorded`} />
          <Stat label="Income accrued since the snapshot" value={dm(values.accrual.income)} sub={`${values.accrual.months.toFixed(2)} months`} />
          <Stat label="Scheduled income ends" value="30 Jun 2028" sub="21 months of salary left" />
        </Stats>
        <div style={{ marginTop: 20, paddingTop: 18, borderTop: '1px solid var(--hairline)' }}>
          <CurrencySplits label="Scheduled income, by the currency it is paid in"
                          splits={monthly.splits} totalEgp={monthly.totalEgp} />
        </div>
      </Panel>

      {tab === 'sources' && (
        <Manager
          markFamily="income"
          addLabel="Add a source"
          fields={[
            { key: 'name', label: 'Name', placeholder: 'Consulting retainer', width: 'minmax(150px,1.6fr)' },
            // A source that simply turns up has no amount to state — what it pays is
            // whatever each payment turned out to be, which is on the record, not here.
            { key: 'amount', label: 'Amount', kind: 'number', width: '130px',
              when: (v) => v.cadence !== 'irregular',
              placeholder: 'what it pays' },
            { key: 'currency', label: 'Currency', kind: 'select', width: '130px',
              options: currencies.map((c) => ({ value: c.code, label: c.code, hint: c.name })) },
            { key: 'cadence', label: 'How often', kind: 'select', width: '150px',
              // every one of these is a cadence the ledger knows. "Daily" was offered here
              // and is not one of them, so choosing it failed the call rather than the field
              options: [
                { value: 'weekly', label: 'Weekly' },
                { value: 'monthly', label: 'Monthly' },
                { value: 'quarterly', label: 'Quarterly' },
                { value: 'annually', label: 'Annually' },
                { value: 'irregular', label: 'Whenever it comes', hint: 'no fixed amount' },
              ] },
            // When it arrives is a different question for each cadence, so each asks its
            // own: a weekday for something weekly, a day of the month for something monthly,
            // and for a quarter both — which month it starts in and which day of that month.
            // When it arrives is a different question for each cadence. A weekly source
            // wants a day of the week; a monthly one a day of the month; a quarterly one a
            // date to count three months from, which is a calendar rather than two lists.
            { key: 'weekday', label: 'Arrives', kind: 'select', width: '160px',
              when: (v) => v.cadence === 'weekly',
              options: WEEKDAYS.map((d, i) => ({ value: String(i), label: `Every ${d}` })) },
            { key: 'dayOfMonth', label: 'Arrives', kind: 'select', width: '160px',
              when: (v) => v.cadence === 'monthly',
              options: [...Array.from({ length: 28 }, (_, i) => ({
                value: String(i + 1), label: `Day ${i + 1}`,
              })), { value: 'last', label: 'Last day' }] },
            { key: 'startDate', label: 'First one', kind: 'date', width: '190px',
              when: (v) => v.cadence === 'quarterly' || v.cadence === 'annually',
              hint: 'and every three months after' },
            /**
             * Where it lands.
             *
             * The column reading "Lands in" used to sit over the picker for the asset that
             * earns the money, so the one question it looked like it was answering was the
             * one it could not answer: the list was of flats and cars, not accounts.
             */
            { key: 'toAccountId', label: 'Lands in', kind: 'select', width: '190px',
              hint: 'accounts held in that currency',
              options: (_row, values) => {
                const code = currencyOf(values);
                const mine = accountOptions(code);
                return mine.length ? mine
                  : [{ value: '', label: `No ${code} account`, hint: 'add one under Accounts' }];
              } },
            /**
             * Rent has to name the thing that earns it.
             *
             * A let flat is outside zakat itself and what it earns is not, so the earnings
             * have to be attributable to the flat — otherwise rent is indistinguishable from
             * a wage once it is in the account, and its own lunar year cannot be measured.
             */
            { key: 'assetId', label: 'Earned by', kind: 'select', width: '180px',
              hint: 'for zakat on rent',
              options: [{ value: '', label: 'Nothing — it is not rent' },
                        ...lettable.map((n) => ({ value: n.id, label: n.name }))] },
          ]}
          rows={[...scheduled, ...occasional].map((src) => {
            const { bank, account } = accountName(src.toNodeId);
            const paid = perSourceNative(src.id);
            return {
              id: src.id,
              mark: src.icon ?? 'income',
              colour: src.scheduled ? '#2E7D52' : '#B37E00',
              values: {
                name: src.name,
                amount: src.amount ?? '',
                currency: src.currency,
                cadence: src.scheduled ? src.cadence : 'irregular',
                dayOfMonth: String(src.dayOfMonth ?? 1),
                annualOn: String(src.startDate?.slice(5, 7) ?? 1),
                toAccountId: src.toNodeId,
                assetId: (src as { assetId?: string | null }).assetId ?? '',
              },
              /* what a closed row cannot otherwise say: where it lands, and — for an
                 occasional source — what it has actually paid this year so far */
              trailing: (
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2,
                              fontSize: 11, color: 'var(--faint)', lineHeight: 1.4 }}>
                  <span>{bank ? `${bank} · ${account}` : account}</span>
                  <span>
                    {src.scheduled ? 'next 1 Oct'
                      : paid.count ? `${nativeMoney(paid)} so far this year` : 'nothing yet this year'}
                  </span>
                </span>
              ),
            };
          })}
          onSave={(id, patch) => {
            const src = data.incomeSources.find((x) => x.id === id);
            // what the row is after this edit, so the account follows the currency on screen
            const after = { currency: src?.currency ?? '', toAccountId: src?.toNodeId ?? '',
                            ...patch } as Record<string, string | number>;
            /**
             * Which account this save actually names.
             *
             * The old account cannot hold a currency it was never changing to hold, so
             * changing the currency really does have to move it — `accountFor` picks a
             * sensible one that can. But the picker offers only active accounts, and an
             * account that has since been archived is not offered there either — so calling
             * `accountFor` whether or not the currency changed re-derived the account from that
             * same narrowed list every time, and a source that had quietly landed on an
             * archived account was reassigned to whatever active account came first the next
             * time anything else on the row was saved, with nobody having touched this field.
             * Left alone when the currency has not changed, the row keeps naming exactly the
             * account it already named — archived or not — and only a real currency change, or
             * the owner's own pick from the field itself, moves it.
             */
            const currencyChanged = src != null && patch.currency !== undefined
              && String(patch.currency) !== src.currency;
            const toAccountId = currencyChanged
              ? (accountFor(after) || undefined)
              : ((patch.toAccountId as string | undefined) || src?.toNodeId || undefined);
            return run('income.source.update', {
            sourceId: id,
            name: patch.name as string | undefined,
            amount: patch.cadence === 'irregular' ? null
                  : patch.amount === '' ? null : (patch.amount as number | undefined),
            currency: patch.currency as string | undefined,
            cadence: patch.cadence as string | undefined,
            dayOfMonth: patch.dayOfMonth === 'last' ? 'last'
                      : patch.dayOfMonth != null ? Number(patch.dayOfMonth) : undefined,
            icon: patch.mark as string | undefined,
            toAccountId,
            assetId: patch.assetId === undefined ? undefined : ((patch.assetId as string) || null),
            });
          }}
          onAdd={(d) => run('income.source.add', {
            name: d.name as string,
            amount: d.cadence === 'irregular' || d.amount === '' || d.amount == null
              ? null : Number(d.amount),
            currency: String(d.currency || currencies[0]?.code || 'EGP'),
            cadence: (d.cadence as string) || 'monthly',
            dayOfMonth: d.dayOfMonth === 'last' ? 'last' : Number(d.dayOfMonth ?? 1),
            // the select shows the first account in the chosen currency until one is picked,
            // so an untouched draft sends what it showed rather than a setting nobody filled in
            toAccountId: accountFor(d),
            icon: d.mark as string | undefined,
            assetId: (d.assetId as string) || undefined,
          })}
          addBlocked={cashAccounts.length === 0
            ? 'Income lands in an account, and this ledger has none yet. Add one under Accounts first.'
            : undefined}
          addValid={(d) => (accountFor(d)
            ? undefined
            : `Nothing can receive ${currencyOf(d)}: there is no account held in it. Add one under Accounts, or choose another currency.`)}
          onDelete={(id) => run('income.source.remove', { sourceId: id })}
          onArchive={(id) => run('income.source.retire', { sourceId: id })}
          clear={{ log: 'income', what: 'every source of income and its schedule' }}
        />
      )}

      {tab === 'records' && (
      <Panel title="Income that landed"
             hint="Every payment that turned up rather than accruing on a schedule. These count from the day they landed and never before.">
        {/* the receipt for what was just recorded, beside the log it changed */}
        <RecordTable
          rows={LOGGED}
          rowKey={(l) => l.id}
          sort={{ key: 'date', dir: 'desc' }}
          empty={{ icon: 'income', title: 'Nothing recorded yet',
                   body: 'Scheduled income accrues on its own; anything irregular counts once you record it.' }}
          columns={[
            { key: 'date', label: 'Date', kind: 'date',
              value: (l) => l.date,
              cell: (l) => <span className="mono" style={{ fontSize: 13 }}>{l.date}</span>,
              field: (d, set) => <DateField value={d.date} onChange={(v) => set({ date: v })} ariaLabel="Date" /> },

            /* Choosing the source answers two more questions on its own: what it is paid in,
               and where it lands. Both were left on whatever the form happened to hold, so a
               dollar retainer arrived, by default, in an Egyptian account. */
            { key: 'source', label: 'Source', kind: 'pick',
              value: (l) => l.source,
              /* A source has a mark of its own, chosen on the tab beside this one, and the
                 log named it in bare text — the one column on this screen where the thing
                 being named was drawn as a word rather than as itself. */
              cell: (l) => {
                const src = data.incomeSources.find((x) => x.name === l.source);
                return (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <Mark mark={src?.icon} size={15} fallback="salary" />
                    <span style={{ fontSize: 13 }}>{l.source}</span>
                  </span>
                );
              },
              /**
               * What this payment is offered against.
               *
               * Adding one only ever names an occasional source — a scheduled one accrues on
               * its own, so it is never what a logged payment is attributed to fresh. But a
               * row being corrected can already name one anyway (an older record, or a source
               * since moved onto a schedule), and the picker has to keep showing what it
               * actually says: leaving the old source off the list because it is no longer
               * occasional is exactly how this picker used to fall back to the first name on
               * it — silently, on open, before anyone had touched a thing.
               */
              field: (d, set, row) => {
                const named = row ? data.incomeSources.find((x) => x.name === row.source) : undefined;
                const already = named && occasional.some((x) => x.id === named.id);
                const option = (x: { id: string; name: string; icon?: string }) =>
                  ({ value: x.id, label: x.name, icon: x.icon });
                const choices = named && !already
                  ? [option(named), ...occasional.map(option)]
                  : occasional.map(option);
                return (
                  <Select ariaLabel="Source" value={d.sourceId}
                          onChange={(v) => {
                            const src = data.incomeSources.find((x) => x.id === v);
                            set({ sourceId: v,
                                  ...(src ? { currency: src.currency, accountId: src.toNodeId } : {}) });
                          }}
                          options={choices} />
                );
              } },

            { key: 'amount', label: 'Amount', kind: 'money',
              value: (l) => toEgp(l.amount, l.currency, market),
              // Paid in one currency into an account held in the same one is not an exchange,
              // and was being restated in the reader's currency as though it were.
              cell: (l) => (
                <RecordAmount amount={l.amount} currency={l.currency}
                              accountId={(l as { intoId?: string | null }).intoId} />
              ),
              field: (d, set) => (
                <span className="field-money">
                  <Amount value={d.amount} ariaLabel="Amount" onChange={(n) => set({ amount: n })} />
                  <Select ariaLabel="Currency" value={d.currency} style={{ width: 92 }}
                          onChange={(v) => {
                            const first = data.nodes.find((n) => n.kind === 'cash' && n.parentId && n.currency === v);
                            const keep = data.nodes.find((n) => n.id === d.accountId)?.currency === v;
                            set({ currency: v, accountId: keep ? d.accountId : (first?.id ?? '') });
                          }}
                          options={currencies.map((c) => ({ value: c.code, label: c.code }))} />
                </span>
              ) },

            { key: 'into', label: 'Landed in', kind: 'pick',
              value: (l) => l.into,
              cell: (l) => (
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {/* the movement names the account by name rather than by id, so the line is
                      drawn from the node that answers to that name where one still does */}
                  <AccountLine id={data.nodes.find((n) => n.name === l.into)?.id} name={l.into} />
                </span>
              ),
              field: (d, set) => (
                <Select ariaLabel="Landed in" value={d.accountId} onChange={(v) => set({ accountId: v })}
                        options={data.nodes.filter((n) => n.kind === 'cash' && n.parentId && n.currency === d.currency)
                          .map((n) => accountOption(data, n))} />
              ) },

            { key: 'note', label: 'Note', kind: 'text',
              value: (l) => l.note,
              cell: (l) => <span style={{ fontSize: 13, color: 'var(--muted)' }}>
                {l.note || <span style={{ color: 'var(--faint)' }}>—</span>}</span>,
              field: (d, set) => <input aria-label="Note" placeholder="what for" value={d.note}
                                        onChange={(e) => set({ note: e.target.value })} /> },
          ]}
          add={{
            label: 'Log income that landed',
            capability: 'income.record',
            blank: (() => {
              // the first source is the one the picker shows, so the account and the currency
              // start as that source's own rather than as a setting nobody has filled in
              const first = occasional[0];
              const currency = first?.currency ?? display;
              return { date: new Date().toISOString().slice(0, 10),
                       sourceId: first?.id ?? '',
                       accountId: first?.toNodeId ?? accountsIn(currency)[0]?.id ?? '',
                       currency, amount: 0, note: '' };
            })(),
            valid: (d) => d.amount > 0 && !!d.accountId,
            build: (d) => ({ sourceId: d.sourceId || undefined, accountId: d.accountId,
                             amount: d.amount, currency: d.currency, date: d.date,
                             note: d.note || undefined }),
          }}
          edit={{
            capability: 'income.correct',
            draftOf: (l) => ({
              date: l.date, amount: l.amount, currency: l.currency,
              accountId: (l as { intoId?: string | null }).intoId ?? '',
              // Matched against every source, not only the occasional ones the picker usually
              // offers — see the field above for why. A source renamed or removed since this
              // payment landed matches nothing at all; the row still names it by the name it
              // was given, which the picker offers nowhere, so it reads as unresolved rather
              // than silently landing on whichever source the list happens to start with.
              sourceId: data.incomeSources.find((x) => x.name === l.source)?.id
                ?? (l.source ? `unresolved:${l.source}` : ''),
              note: l.note ?? '',
            }),
            build: (d, l) => ({ movementId: l.id, accountId: d.accountId || undefined,
                                // an unresolved source is not a choice, so saving leaves the
                                // source as it was rather than sending a value nothing offered
                                sourceId: d.sourceId && !String(d.sourceId).startsWith('unresolved:')
                                  ? d.sourceId : undefined,
                                amount: Number(d.amount),
                                date: d.date, note: d.note ?? '' }),
            blocked: (l) => (l.id.startsWith('tx-') ? undefined
              : 'This payment predates the movement log, so there is nothing to rewrite.'),
          }}
          remove={{
            capability: 'movement.undo',
            build: (l) => ({ movementId: l.id }),
            what: (l) => `${l.source} on ${l.date}`,
            blocked: (l) => (l.id.startsWith('tx-') ? undefined
              : 'This payment predates the movement log, so there is nothing to reverse.'),
          }}
        />
      </Panel>
      )}
    </Page>
  );
}
