import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../AppState';
import { useLive } from '../Live';
import { ledger } from '../api';
import { ConfirmDelete } from '../components/Confirm';
import { AccessSettings } from '../components/AccessSettings';
import { CurrencySettings } from '../components/CurrencySettings';
import { PriceSources } from '../components/PriceSources';
import { DateField } from '../components/DateField';
import { Select } from '../components/Select';
import { describeLead, money, type Reminder } from '@ledger/engine';
import { Page, Panel, Field, Toggle, Chip, Row, Empty } from '../components/UI';
import { AppearanceSettings } from '../components/AppearanceSettings';
import { ModuleSettings, RecurringSettings } from '../components/ModuleSettings';
import { Icon } from '../components/Icon';

const CURRENCIES = ['EGP', 'USD', 'GBP', 'EUR'] as const;

export const SETTINGS_VIEWS = [
  { id: 'settings', label: 'General', icon: 'settings' as const },
  { id: 'settings-modules', label: 'Modules', icon: 'modules' as const },
  { id: 'settings-recurring', label: 'Recurring', icon: 'repeat' as const },
  { id: 'settings-appearance', label: 'Appearance', icon: 'appearance' as const },
  { id: 'settings-reminders', label: 'Notifications', icon: 'bell' as const },
  { id: 'settings-currencies', label: 'Currencies', icon: 'currency' as const },
  { id: 'settings-prices', label: 'Prices', icon: 'price' as const },
  { id: 'settings-access', label: 'Access', icon: 'lock' as const },
];

/**
 * Settings, with its sections along the top.
 *
 * They used to hang off the sidebar, which put them a level below every screen while being
 * the same kind of thing as the tabs already inside one. Along the top they read as what they
 * are — parts of this screen — and the sidebar goes back to naming places rather than
 * unfolding into a second menu.
 */
function Tabs({ view, onNavigate }: { view: string; onNavigate: (id: string) => void }) {
  return (
    <div style={{
      display: 'flex', gap: 4, padding: 4, flexWrap: 'wrap',
      borderRadius: 'var(--r-card)', background: 'var(--raised)',
      border: '1px solid var(--hairline)',
    }}>
      {SETTINGS_VIEWS.map((v) => {
        const on = v.id === view;
        return (
          <button key={v.id} onClick={() => onNavigate(v.id)} aria-pressed={on}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13,
              fontWeight: on ? 500 : 400, padding: '7px 13px', borderRadius: 'var(--r-sm)',
              cursor: 'pointer', border: 'none',
              background: on ? 'var(--control)' : 'transparent',
              color: on ? 'var(--ink)' : 'var(--muted)',
              boxShadow: on ? 'var(--shadow-sm)' : 'none',
              transition: 'background 150ms var(--ease), color 150ms var(--ease)',
            }}>
            <Icon name={v.icon} size={14} />
            {v.label}
          </button>
        );
      })}
    </div>
  );
}

export function Settings({ view, onNavigate }: { view: string; onNavigate: (id: string) => void }) {
  const body =
      view === 'settings-modules' ? <ModuleSettings />
    : view === 'settings-recurring' ? <RecurringSettings />
    : view === 'settings-appearance' ? <AppearanceSettings />
    : view === 'settings-reminders' ? <Reminders />
    : view === 'settings-currencies' ? <CurrencySettings />
    : view === 'settings-prices' ? <PriceSources />
    : view === 'settings-access' ? <AccessSettings />
    : <General />;

  return (
    <Page>
      <Tabs view={view} onNavigate={onNavigate} />
      {body}
    </Page>
  );
}


function General() {
  const { data, display, setDisplay, reminders, setReminders, dm, values, settings, setSettings  } = useApp();

  const update = (id: string, patch: Partial<Reminder>) =>
    setReminders(reminders.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const subjectLabel = (r: Reminder) => {
    if (r.subject === 'installment') return data.nodes.find((n) => n.id === r.subjectId)?.name ?? 'Property';
    if (r.subject === 'stock') return `${r.subjectId} · ${r.direction === 'buy' ? 'buy below' : 'sell above'} ${r.triggerPrice}`;
    if (r.subject === 'zakat') return 'Zakat · the hawl date';
    if (r.subject === 'sadaqah') return 'Sadaqah · recurring giving';
    if (r.subject === 'income') return `${data.incomeSources.find((x) => x.id === r.subjectId)?.name ?? 'Income'} · has not landed`;
    if (r.subject === 'recurring') return `${r.subjectId} · standing charge`;
    return r.subjectId ?? r.subject;
  };

  return (
    <>
      <Panel title="The ledger's currency"
             hint="Every headline total renders in this — net worth, the snapshot strip, account balances. Individual records keep the currency they were actually recorded in and are converted for display only.">
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {CURRENCIES.map((c) => {
            const on = c === display;
            return (
              <button key={c} onClick={() => setDisplay(c)} aria-pressed={on}
                style={{
                  display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start',
                  padding: '14px 18px', minWidth: 150, cursor: 'pointer', textAlign: 'left',
                  borderRadius: 'var(--r-card)', color: 'var(--ink)',
                  border: `1px solid ${on ? 'var(--accent)' : 'var(--hairline)'}`,
                  background: on ? 'color-mix(in srgb, var(--accent) 8%, var(--surface))' : 'var(--surface)',
                }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>{c}</span>
                <span className="mono" style={{ fontSize: 13, color: 'var(--muted)' }}>
                  {money(values.total / (c === 'EGP' ? 1 : (c === 'USD' ? values.rate : c === 'GBP' ? 68.8717 : 59.0424)), c)}
                </span>
                <span style={{ fontSize: 11, color: 'var(--faint)' }}>net worth in {c}</span>
              </button>
            );
          })}
        </div>
      </Panel>

      <Panel title="Constants" hint="These drove the old app from inside its markup. They are settings now, so the accrual and the forecast follow them instead of needing the source edited.">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16 }}>
          <Field label="Living budget baseline, monthly" hint="used for any month with nothing logged">
            <input className="mono" value={settings.budgetEgp.toLocaleString('en-US')}
                   aria-label="Living budget baseline"
                   onChange={(e) => setSettings({ budgetEgp: Number(e.target.value.replace(/[^\d.]/g, '')) || 0 })} />
          </Field>
          <Field label="Scheduled income ends">
            <DateField value={settings.incomeContractEnd} ariaLabel="Scheduled income ends"
                       onChange={(v) => setSettings({ incomeContractEnd: v })} />
          </Field>
          <Field label="Gold karat"><Select ariaLabel="Gold karat" value={String(settings.goldKarat)}
            onChange={(v) => setSettings({ goldKarat: v })}
            options={[{ value: '24', label: '24k' }, { value: '21', label: '21k' }]} /></Field>
          <Field label="Gold price to use" hint="the dealer's buy price is the one you would realise">
            <Select ariaLabel="Gold price basis" value={settings.goldUseBuyPrice ? 'buy' : 'sell'}
                    onChange={(v) => setSettings({ goldUseBuyPrice: v === 'buy' })}
                    options={[{ value: 'buy', label: 'Dealer buy' }, { value: 'sell', label: 'Dealer sell' }]} />
          </Field>
          <Field label="Salary lands in">
            <Select ariaLabel="Salary lands in" value={settings.incomeAccountId}
                    onChange={(v) => setSettings({ incomeAccountId: v })}
                    options={data.nodes.filter((n) => n.kind === 'cash').map((n) => ({
                      value: n.id, label: n.name,
                      hint: data.institutions.find((i) => i.id === n.parentId)?.name,
                    }))} />
          </Field>
          <Field label="Living burn drawn from">
            <Select ariaLabel="Living burn drawn from" value={settings.burnAccountId}
                    onChange={(v) => setSettings({ burnAccountId: v })}
                    options={data.nodes.filter((n) => n.kind === 'cash').map((n) => ({
                      value: n.id, label: n.name,
                      hint: data.institutions.find((i) => i.id === n.parentId)?.name,
                    }))} />
          </Field>
        </div>
        <p style={{ margin: '18px 0 0', fontSize: 12, color: 'var(--faint)' }}>
          These are live for this session. Nothing is written to storage yet — the front end has
          no backend, so a reload restores the values the engine ships with.
        </p>
      </Panel>
    </>
  );
}

const SUGGESTIONS: Array<{ title: string; body: string; hard?: boolean }> = [
  { title: 'Which notes mean "not equity"', hard: true,
    body: 'An installment whose note matches maintenance, service or fee buys no equity. That test is a regular expression buried in the code — it should be a list you can add to, because your developer will eventually invent a word neither of us thought of.' },
  { title: 'People and counterparties',
    body: 'Anything held on someone else\u2019s behalf, or owed to you by a person rather than a bank, has nowhere to live. A counterparty record would carry a debt, a share of a property, or a standing arrangement.' },
  { title: 'Which nisab, and what counts', hard: true,
    body: 'Gold or silver, whether debts are deducted, how shares are valued. These are positions you hold, not facts the app should assert — the calculator should record which you chose.' },
  { title: 'Forecast assumptions', hard: true,
    body: 'Rate drift, gold growth, property appreciation, equity return. Five numbers that decide every projected figure, currently written into the source.' },
  { title: 'Budget baselines per destination',
    body: 'One monthly budget stands in for every unlogged month. A baseline per destination would make the estimate honest — and show which parts of it you never actually record.' },
  { title: 'Tags across everything',
    body: 'A free label spanning expenses, movements, orders and notes. It is the cheapest way to answer a question the schema did not anticipate.' },
  { title: 'Dates, numbers and the week',
    body: 'The app assumes en-US formatting and a Gregorian calendar everywhere except zakat. Where a Hijri date is shown, and which day a week starts on, should be yours.' },
  { title: 'Default reminder lead times',
    body: 'Set once per subject rather than per property — a new plan then arrives already warning you at the interval you actually want.' },
];

function Reminders() {
  const { data, reminders, setReminders, recurring } = useApp();
  const { run, live, version } = useLive();

  /**
   * The reminders this ledger holds.
   *
   * They live in the ledger once there is one, because a reminder that only exists in the
   * browser is a reminder that disappears when the tab does. Without a service the fixture's
   * own list stands in, and adding or removing one there changes the session and says so.
   */
  const [rows, setRows] = useState<Reminder[] | null>(null);
  const load = useCallback(() => {
    if (!live) { setRows(null); return; }
    (ledger as any)['reminders.list']({})
      .then((rs: any[]) => setRows(rs.map((r) => ({
        id: r.id, subject: r.subject, subjectId: r.subjectId ?? undefined,
        enabled: r.enabled, offsetValue: r.offsetValue, offsetUnit: r.offsetUnit,
        direction: r.direction ?? undefined, triggerPrice: r.triggerPrice ?? undefined,
        note: r.note ?? undefined, dueDate: r.dueDate ?? undefined,
        graceDays: r.graceDays ?? undefined, cadence: r.cadence ?? undefined,
      })) as Reminder[]))
      .catch(() => setRows(null));
  }, [live]);
  useEffect(load, [load, version]);

  const list = rows ?? reminders;

  const update = (r: Reminder, patch: Partial<Reminder>) => {
    if (rows) {
      void run('reminder.set', {
        reminderId: r.id, subject: r.subject, subjectId: r.subjectId,
        enabled: patch.enabled ?? r.enabled,
        offsetValue: patch.offsetValue ?? r.offsetValue,
        offsetUnit: patch.offsetUnit ?? r.offsetUnit,
      }).then(load);
      // shown at once; the reload confirms it rather than the screen waiting to react
      setRows(rows.map((x) => (x.id === r.id ? { ...x, ...patch } : x)));
      return;
    }
    setReminders(reminders.map((x) => (x.id === r.id ? { ...x, ...patch } : x)));
  };

  const remove = (r: Reminder) => {
    if (rows) { void run('reminder.remove', { reminderId: r.id }).then(load); return; }
    setReminders(reminders.filter((x) => x.id !== r.id));
  };

  const add = (draft: Omit<Reminder, 'id'>) => {
    if (rows) {
      void run('reminder.set', { ...draft, asNew: true }).then(load);
      return;
    }
    setReminders([...reminders, { ...draft, id: `rem-${Date.now().toString(36)}` }]);
  };

  const subjectLabel = (r: Reminder) => {
    if (r.subject === 'installment') return data.nodes.find((n) => n.id === r.subjectId)?.name ?? 'Property';
    if (r.subject === 'stock') return `${r.subjectId} · ${r.direction === 'buy' ? 'buy below' : 'sell above'} ${r.triggerPrice ?? ''}`.trim();
    if (r.subject === 'zakat') return 'Zakat · the hawl date';
    if (r.subject === 'sadaqah') return 'Sadaqah · recurring giving';
    if (r.subject === 'income') return `${data.incomeSources.find((x) => x.id === r.subjectId)?.name ?? 'Income'} · has not landed`;
    if (r.subject === 'recurring') return `${recurring.find((t) => t.id === r.subjectId)?.name ?? r.subjectId} · standing charge`;
    return r.subjectId ?? r.subject;
  };

  return (
    <>
      <Panel title="Reminders"
             hint="A reminder never creates or moves a payment. It decides how far ahead you get told, so switching one off hides the warning and never the obligation — and removing one does the same, permanently.">
        {list.length === 0 && (
          <Empty icon="bell" title="Nothing is being watched"
                 body="Add one below and it will appear in Coming up at the notice you asked for." />
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {list.map((r) => (
            <Row key={r.id} cols="34px minmax(0,1fr) 210px 66px 34px" style={{
              padding: '14px 16px', borderRadius: 'var(--r-card)',
              background: 'var(--raised)', border: '1px solid var(--hairline)',
            }}>
              <span style={{
                width: 30, height: 30, borderRadius: 8, display: 'flex', alignItems: 'center',
                justifyContent: 'center', background: 'var(--surface)', border: '1px solid var(--hairline)',
              }}>
                <Icon name={r.subject === 'zakat' ? 'zakat' : r.subject === 'stock' ? 'stocks'
                          : r.subject === 'sadaqah' ? 'charity' : 'building'} size={15}
                      color={r.enabled ? 'var(--accent)' : 'var(--faint)'} />
              </span>
              <div>
                <div style={{ fontSize: 14, fontWeight: 500 }}>{subjectLabel(r)}</div>
                <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 2 }}>
                  {r.subject === 'stock'
                    ? 'fires whenever the price crosses'
                    : `warns ${describeLead(r)} it falls due`}
                </div>
              </div>
              {r.subject === 'stock' ? (
                <Chip tone="info">price alert</Chip>
              ) : (
                <div style={{ display: 'flex', gap: 8 }}>
                  <input type="number" min={0} value={r.offsetValue} aria-label="How far ahead"
                    onChange={(e) => update(r, { offsetValue: Number(e.target.value) })}
                    style={{ width: 70 }} />
                  <Select ariaLabel="Lead time unit" value={r.offsetUnit}
                          onChange={(v) => update(r, { offsetUnit: v as 'days' | 'months' })}
                          options={[{ value: 'days', label: 'days before' }, { value: 'months', label: 'months before' }]} />
                </div>
              )}
              <span style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Toggle on={r.enabled} onChange={(v) => update(r, { enabled: v })}
                        label={`${subjectLabel(r)} reminder`} />
              </span>
              <span style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <ConfirmDelete what={subjectLabel(r)} onConfirm={() => remove(r)} />
              </span>
            </Row>
          ))}
        </div>
        {!rows && live === false && (
          <p style={{ margin: '16px 0 0', fontSize: 12, color: 'var(--faint)' }}>
            These are the ones the interface ships with. Adding or removing one lasts as long as
            this session — with the ledger&rsquo;s own server running they are kept.
          </p>
        )}
      </Panel>

      <AddReminder onAdd={add} />
    </>
  );
}

/**
 * Adding one.
 *
 * What a reminder needs depends entirely on what it watches: a property needs to know which
 * property, an intention about a share needs a direction and a price, and the zakat date
 * needs neither because a ledger has one. So the form asks for the subject first and then
 * only for what that subject actually requires.
 */
function AddReminder({ onAdd }: { onAdd: (r: Omit<Reminder, 'id'>) => void }) {
  const { data, recurring } = useApp();
  const { live, version } = useLive();
  /**
   * The properties there is a plan against.
   *
   * Read from the ledger, because the dataset the screens hold carries no installments when
   * there is a service — which is why this picker used to be empty, and why the form then
   * quietly accepted a reminder that named no property and therefore warned about nothing.
   */
  const [plans, setPlans] = useState<Array<{ id: string; name: string }> | null>(null);
  /** the tickers there is a position in, read from the ledger for the same reason */
  const [tickers, setTickers] = useState<string[] | null>(null);
  useEffect(() => {
    if (!live) { setPlans(null); setTickers(null); return; }
    let cancelled = false;
    (ledger as any)['installments.list']({})
      .then((rows: Array<{ propertyId: string; property: string }>) => {
        if (cancelled) return;
        const seen = new Map<string, string>();
        for (const r of rows ?? []) if (!seen.has(r.propertyId)) seen.set(r.propertyId, r.property);
        setPlans([...seen].map(([id, name]) => ({ id, name })));
      })
      .catch(() => { if (!cancelled) setPlans([]); });
    (ledger as any)['positions.list']({})
      .then((rows: Array<{ ticker: string }>) => {
        if (!cancelled) setTickers((rows ?? []).map((r) => r.ticker));
      })
      .catch(() => { if (!cancelled) setTickers([]); });
    return () => { cancelled = true; };
  }, [live, version]);

  const [subject, setSubject] = useState<Reminder['subject']>('installment');
  const [subjectId, setSubjectId] = useState('');
  const [offsetValue, setOffsetValue] = useState(3);
  const [offsetUnit, setOffsetUnit] = useState<'days' | 'months'>('days');
  const [direction, setDirection] = useState<'buy' | 'sell'>('buy');
  const [price, setPrice] = useState('');
  const [note, setNote] = useState('');

  const targets: Array<{ value: string; label: string; hint?: string }> =
      subject === 'installment'
        ? (plans ?? data.nodes
            .filter((n) => data.installments.some((i) => i.propertyId === n.id))
            .map((n) => ({ id: n.id, name: n.name })))
            .map((pl) => ({ value: pl.id, label: pl.name, hint: 'a payment falling due' }))
    : subject === 'income'
        ? data.incomeSources.map((s) => ({ value: s.id, label: s.name, hint: 'has not landed' }))
    : subject === 'recurring'
        ? recurring.map((t) => ({ value: t.id, label: t.name, hint: 'standing charge' }))
    : subject === 'stock'
        ? [...new Set(tickers ?? data.orders.map((o) => o.ticker))].map((t) => ({ value: t, label: t }))
    : [];

  /**
   * Whether this subject is one that has to name what it watches.
   *
   * It is the subject that decides, never the list: an empty list means there is nothing to
   * watch yet, which is a reason to say so rather than to accept a reminder with no target.
   * A targetless installment reminder is matched against no property and warns about nothing.
   */
  const needsTarget = subject === 'installment' || subject === 'income'
                   || subject === 'recurring' || subject === 'stock';
  const nothingToWatch = needsTarget && targets.length === 0;
  const ready = !needsTarget || !!subjectId;

  const submit = () => {
    if (!ready) return;
    onAdd({
      subject, subjectId: needsTarget ? subjectId : undefined, enabled: true,
      offsetValue: subject === 'stock' ? 0 : offsetValue,
      offsetUnit: subject === 'stock' ? 'days' : offsetUnit,
      ...(subject === 'stock'
        ? { direction, triggerPrice: Number(price) || undefined }
        : {}),
      ...(note ? { note } : {}),
    });
    setSubjectId(''); setPrice(''); setNote('');
  };

  return (
    <Panel title="Add a reminder"
           hint="Choose what it watches. Everything else follows from that — a property needs to know which one, an intention about a share needs the price you have in mind.">
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="What it watches">
          <Select ariaLabel="What the reminder watches" value={subject} style={{ width: 210 }}
                  onChange={(v) => { setSubject(v as Reminder['subject']); setSubjectId(''); }}
                  options={[
                    { value: 'installment', label: 'A payment on a plan', hint: 'before it falls due' },
                    { value: 'income', label: 'Income that should land', hint: 'when it has not' },
                    { value: 'recurring', label: 'A standing charge', hint: 'before it posts' },
                    { value: 'zakat', label: 'The zakat date', hint: 'the hawl' },
                    { value: 'sadaqah', label: 'Recurring giving', hint: 'sadaqah' },
                    { value: 'stock', label: 'An intention about a share', hint: 'buy or sell' },
                  ]} />
        </Field>

        {needsTarget && (
          <Field label="Which one">
            {nothingToWatch ? (
              <div style={{ fontSize: 12, color: 'var(--muted)', width: 220, paddingTop: 6 }}>
                {subject === 'installment' ? 'No property is on a plan yet.'
                 : subject === 'income' ? 'No source of income yet.'
                 : subject === 'recurring' ? 'No standing charge yet.'
                 : 'Nothing has been bought yet.'}
              </div>
            ) : (
              <Select ariaLabel="Which one" value={subjectId} style={{ width: 220 }}
                      onChange={setSubjectId}
                      options={[{ value: '', label: 'Choose one' }, ...targets]} />
            )}
          </Field>
        )}

        {subject === 'stock' ? (
          <>
            <Field label="Intention">
              <Select ariaLabel="Buy or sell" value={direction} style={{ width: 150 }}
                      onChange={(v) => setDirection(v as 'buy' | 'sell')}
                      options={[{ value: 'buy', label: 'Buy below' }, { value: 'sell', label: 'Sell above' }]} />
            </Field>
            <Field label="Price you have in mind">
              <input type="number" min={0} step="0.01" value={price} aria-label="Trigger price"
                     onChange={(e) => setPrice(e.target.value)} style={{ width: 130 }} />
            </Field>
          </>
        ) : (
          <Field label="How far ahead">
            <div style={{ display: 'flex', gap: 8 }}>
              <input type="number" min={0} value={offsetValue} aria-label="How far ahead"
                     onChange={(e) => setOffsetValue(Number(e.target.value))} style={{ width: 70 }} />
              <Select ariaLabel="Lead time unit" value={offsetUnit} style={{ width: 150 }}
                      onChange={(v) => setOffsetUnit(v as 'days' | 'months')}
                      options={[{ value: 'days', label: 'days before' }, { value: 'months', label: 'months before' }]} />
            </div>
          </Field>
        )}

        <Field label="Why, if it helps">
          <input value={note} aria-label="Note" placeholder="so it still makes sense later"
                 onChange={(e) => setNote(e.target.value)} style={{ width: 240 }} />
        </Field>

        <button className="btn add" onClick={submit} disabled={!ready}>
          <Icon name="plus" size={14} /> Add
        </button>
      </div>
    </Panel>
  );
}

