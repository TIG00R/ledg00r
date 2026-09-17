import { useState } from 'react';
import { Amount } from './Amount';
import { useApp } from '../AppState';
import { ConfirmDelete } from './Confirm';
import { ActionButton, useLive } from '../Live';
import { Select } from './Select';
import { MODULES, useModules } from '../Modules';
import { nextOccurrence, perMonth, money, type RecurringTemplate } from '@ledger/engine';
import { Icon } from './Icon';
import { Chip, Field, Toggle, Row } from './UI';

export function ModuleSettings() {
  const { enabled, toggle } = useModules();
  const on = MODULES.filter((m) => m.core || enabled[m.id]).length;
  return (
    <section className="panel" style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Modules</h2>
        <Chip>{on} of {MODULES.length} on</Chip>
      </div>
      <p style={{ margin: '4px 0 20px', fontSize: 12, color: 'var(--faint)', maxWidth: 760, lineHeight: 1.5 }}>
        This is a set of modules rather than one fixed product. Switching one off takes its
        screen and its sidebar entry away and stops its cards appearing — it never deletes
        the data behind it, so turning it back on finds everything where you left it.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
        {MODULES.map((m) => {
          const isOn = m.core || enabled[m.id];
          return (
            <div key={m.id} style={{
              display: 'flex', gap: 13, padding: '15px 16px', borderRadius: 'var(--r-card)',
              background: isOn ? 'var(--raised)' : 'transparent',
              border: '1px solid var(--hairline)', opacity: isOn ? 1 : 0.6,
            }}>
              <span style={{
                width: 34, height: 34, borderRadius: 9, flex: '0 0 34px',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: isOn ? 'color-mix(in srgb, var(--accent) 13%, transparent)' : 'var(--raised)',
              }}>
                <Icon name={m.icon} size={17} color={isOn ? 'var(--accent)' : 'var(--faint)'} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>{m.label}</span>
                  {m.core && <Chip>always on</Chip>}
                </div>
                <p style={{ margin: '5px 0 0', fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>{m.blurb}</p>
              </div>
              {!m.core && (
                <Toggle on={!!enabled[m.id]} onChange={(v) => toggle(m.id, v)} label={m.label} />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function RecurringSettings() {
  const { data, recurring, setRecurring, dm, now, events, reminders, setReminders, currencies } = useApp();
  const { run } = useLive();
  /** a template only warns if it has been asked to; the event itself shows up regardless */
  const warns = (id: string) => reminders.some((x) => x.subject === 'recurring' && x.subjectId === id && x.enabled);
  const toggleWarn = (id: string, on: boolean) => {
    const existing = reminders.find((x) => x.subject === 'recurring' && x.subjectId === id);
    if (existing) setReminders(reminders.map((x) => (x.id === existing.id ? { ...x, enabled: on } : x)));
    else setReminders([...reminders, { id: `rem-rec-${id}`, subject: 'recurring', subjectId: id,
                                       enabled: on, offsetValue: 3, offsetUnit: 'days' }]);
  };
  const nodeName = (id?: string) => {
    if (!id) return null;
    const n = data.nodes.find((x) => x.id === id);
    const inst = data.institutions.find((i) => i.id === n?.parentId);
    return n ? `${inst ? `${inst.name} · ` : ''}${n.name}` : id;
  };
  const update = (id: string, patch: Partial<RecurringTemplate>) => {
    setRecurring(recurring.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    void run('recurring.update', {
      templateId: id,
      amount: patch.amount, cadence: patch.cadence as any,
      dayOfMonth: patch.dayOfMonth, enabled: patch.enabled,
    });
  };
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({
    name: '', amount: 0, currency: 'EGP',
    cadence: 'monthly' as 'weekly' | 'monthly' | 'quarterly' | 'annually',
    fromNodeId: data.settings.burnAccountId,
  });

  const outgoingPerMonthEgp = recurring
    .filter((r) => r.enabled && !r.internal && !r.toNodeId)
    .reduce((s, r) => s + perMonth(r) * (r.currency === 'EGP' ? 1 : 50.9242), 0);

  return (
    <section className="panel" style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Recurring movements</h2>
        <button className="btn add" style={{ marginLeft: 'auto' }}
                onClick={() => setAdding((v) => !v)}>
          <Icon name="plus" size={14} /> Add a template
        </button>
      </div>
      <p style={{ margin: '4px 0 18px', fontSize: 12, color: 'var(--faint)', maxWidth: 780, lineHeight: 1.5 }}>
        One shape covers both directions. A template with no source is money arriving; one with
        no destination is money leaving; one with both is a transfer between your own accounts.
        Fees and subscriptions belong here — they are small, they repeat, and they are exactly
        what goes unnoticed when nothing is watching for them.
      </p>

      <div style={{ display: 'flex', gap: 14, marginBottom: 18, flexWrap: 'wrap' }}>
        <Chip tone="bad">{dm(outgoingPerMonthEgp)} a month leaving on autopilot</Chip>
        <Chip>{recurring.filter((r) => r.internal).length} internal transfer{recurring.filter((r) => r.internal).length === 1 ? '' : 's'}</Chip>
        <Chip tone={events.some((e) => e.kind === 'recurring' && e.due) ? 'warn' : 'neutral'}>
          {events.filter((e) => e.kind === 'recurring').length} showing in Coming up
        </Chip>
      </div>

      {adding && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                      gap: 14, alignItems: 'end', marginBottom: 18, padding: '16px 18px',
                      borderRadius: 'var(--r-card)',
                      background: 'color-mix(in srgb, var(--positive) 5%, transparent)',
                      border: '1px dashed color-mix(in srgb, var(--positive) 36%, transparent)' }}>
          <Field label="Name">
            <input autoFocus value={draft.name} aria-label="Template name" placeholder="Streaming subscription"
                   onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </Field>
          <Field label="Amount">
            <Amount value={draft.amount} ariaLabel="Template amount" onChange={(n) => setDraft({ ...draft, amount: n })} />
          </Field>
          <Field label="Currency">
            <Select ariaLabel="Template currency" value={draft.currency}
                    onChange={(v) => setDraft({ ...draft, currency: v })}
                    options={currencies.map((c) => ({ value: c.code, label: `${c.symbol} ${c.code}`, hint: c.name }))} />
          </Field>
          <Field label="Out of">
            <Select ariaLabel="Template source" value={draft.fromNodeId}
                    onChange={(v) => setDraft({ ...draft, fromNodeId: v })}
                    options={data.nodes.filter((n) => n.kind === 'cash')
                      .map((n) => ({ value: n.id, label: n.name,
                                     hint: data.institutions.find((i) => i.id === n.parentId)?.name }))} />
          </Field>
          <Field label="How often">
            <Select ariaLabel="Template cadence" value={draft.cadence}
                    onChange={(v) => setDraft({ ...draft, cadence: v as typeof draft.cadence })}
                    options={[{ value: 'weekly', label: 'Weekly' }, { value: 'monthly', label: 'Monthly' },
                              { value: 'quarterly', label: 'Quarterly' }, { value: 'annually', label: 'Annually' }]} />
          </Field>
          <ActionButton capability="recurring.add" disabled={!draft.name || !(draft.amount > 0)}
            onDone={(o) => { if (o.ok) { setDraft({ ...draft, name: '', amount: 0 }); setAdding(false); } }}
            input={() => ({ name: draft.name, amount: draft.amount, currency: draft.currency,
                            cadence: draft.cadence, dayOfMonth: 1, fromAccountId: draft.fromNodeId })}>
            Add it
          </ActionButton>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {recurring.map((r) => {
          const next = nextOccurrence(r, now);
          const direction = r.internal ? 'internal' : r.toNodeId && !r.fromNodeId ? 'in' : 'out';
          const tone = direction === 'in' ? 'var(--positive)' : direction === 'internal' ? 'var(--gold)' : 'var(--negative)';
          return (
            <Row key={r.id} cols="34px minmax(0,1fr) 150px 190px 130px 96px" style={{
              padding: '14px 16px', borderRadius: 'var(--r-card)',
              background: 'var(--raised)', border: '1px solid var(--hairline)', opacity: r.enabled ? 1 : 0.6,
            }}>
              <span style={{
                width: 30, height: 30, borderRadius: 8, display: 'flex', alignItems: 'center',
                justifyContent: 'center', background: `color-mix(in srgb, ${tone} 13%, transparent)`,
              }}>
                <Icon name={direction === 'in' ? 'income' : direction === 'internal' ? 'flow' : 'expenses'}
                      size={15} color={tone} />
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 500 }}>{r.name}</div>
                <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 2 }}>
                  {nodeName(r.fromNodeId) ?? 'from outside'} → {nodeName(r.toNodeId) ?? 'out of your accounts'}
                  {r.note ? ` · ${r.note}` : ''}
                </div>
              </div>
              <span className="mono" style={{ fontSize: 15, color: tone }}>
                {direction === 'in' ? '+' : direction === 'out' ? '−' : ''}
                {r.amount == null ? 'varies' : money(r.amount, r.currency, r.currency === 'EGP' ? 0 : 2)}
              </span>
              <div style={{ display: 'flex', gap: 8 }}>
                <Select ariaLabel={`${r.name} cadence`} value={r.cadence} onChange={(v) => update(r.id, { cadence: v as RecurringTemplate['cadence'] })}
                        options={[{ value: 'weekly', label: 'Weekly' }, { value: 'monthly', label: 'Monthly' },
                                  { value: 'quarterly', label: 'Quarterly' }, { value: 'annually', label: 'Annually' }]} />
                <Select value={String(r.dayOfMonth ?? 1)} ariaLabel={`${r.name} day`} style={{ width: 92 }}
                        onChange={(v) => update(r.id, { dayOfMonth: v === 'last' ? 'last' : Number(v) })}
                        options={[...[1, 5, 10, 15, 20, 25].map((d) => ({ value: String(d), label: `Day ${d}` })), { value: 'last', label: 'Last' }]} />
              </div>
              <span style={{ fontSize: 12, color: 'var(--faint)' }}>
                {next ? `next ${next.toLocaleDateString('en-US', { day: 'numeric', month: 'short' })}` : '—'}
                <button onClick={() => toggleWarn(r.id, !warns(r.id))}
                        aria-label={`Warn before ${r.name}`} aria-pressed={warns(r.id)}
                        title={warns(r.id) ? 'warns 3 days before' : 'no warning'}
                        style={{ display: 'block', marginTop: 3, padding: 0, cursor: 'pointer',
                                 background: 'transparent', border: 'none',
                                 color: warns(r.id) ? 'var(--gold)' : 'var(--disabled)' }}>
                  <Icon name="bell" size={13} />
                </button>
              </span>
              <span style={{ display: 'flex', justifyContent: 'flex-end', gap: 4 }}>
                <Toggle on={r.enabled} onChange={(v) => update(r.id, { enabled: v })} label={r.name} />
                <ConfirmDelete what={r.name} size={14}
                               onConfirm={() => {
                                 setRecurring(recurring.filter((x) => x.id !== r.id));
                                 void run('recurring.update', { templateId: r.id, enabled: false });
                               }} />
              </span>
            </Row>
          );
        })}
      </div>
    </section>
  );
}
