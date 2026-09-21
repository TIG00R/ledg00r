import { useMemo, useState } from 'react';
import { Amount } from '../components/Amount';
import { DateField } from '../components/DateField';
import { Select } from '../components/Select';
import { useApp, market } from '../AppState';
import { splitByCurrency, toEgp, describeLead } from '@ledger/engine';
import { Page, Panel, Stat, Stats, Toggle, Row, Field } from '../components/UI';
import { GivingRecords, type GivingRow } from '../components/GivingRecords';
import { ActionButton, useLive } from '../Live';
import { Manager } from '../components/Manager';
import { Icon } from '../components/Icon';
import { SectionProvider, Sections, useSection } from '../components/Sections';
import { OperationPanel, SourceAccountSelect, realAccountId, defaultAccountId } from '../components/Operations';

/** Sadaqat: giving that is owed to nobody. Money out of a named account, like any other. */
export function Charity() {
  return (
    <SectionProvider first="giving"><Body /></SectionProvider>
  );
}

function Body() {
  const { data, dm, now, reminders, setReminders  } = useApp();
  const { run } = useLive();
  const [logDate, setLogDate] = useState(new Date().toISOString().slice(0, 10));
  const [draft, setDraft] = useState({
    accountId: defaultAccountId(data, data.settings.burnAccountId), amount: 0,
    causeId: data.categories.find((c) => c.domain === 'charity')?.id ?? '', note: '',
  });

  const { tab } = useSection();

  const cats = data.categories.filter((c) => c.domain === 'charity');

  /**
   * What the table shows with no ledger behind the screen.
   *
   * Held steady across renders: the table hands its rows back up, which sets state here, so a
   * list rebuilt each render would never settle.
   */
  const fallbackRows: GivingRow[] = useMemo(
    () => data.charity.filter((c) => !c.isZakat).map((c) => ({
      id: c.id, date: c.date, kind: 'sadaqat' as const,
      amount: c.usd ?? c.egp, currency: c.usd != null ? 'USD' : 'EGP',
      from: data.settings.burnAccountId, categoryId: c.categoryId, note: c.note,
    })),
    [data.charity, data.settings.burnAccountId]);

  /**
   * The totals are the table's own rows, added up.
   *
   * They used to come from the fixture the screens fall back on, which a live service empties
   * — so a ledger holding real gifts announced that nothing had been given, directly above a
   * table listing them.
   */
  const [rows, setRows] = useState<GivingRow[]>(fallbackRows);
  const split = splitByCurrency(rows,
    (c) => ({ amount: c.amount, currency: c.currency }), market);

  const sadaqah = reminders.find((r) => r.subject === 'sadaqah');
  const update = (patch: Partial<(typeof reminders)[number]>) =>
    setReminders(reminders.map((r) => (r.subject === 'sadaqah' ? { ...r, ...patch } : r)));

  return (
    <Page aside={(
      <OperationPanel title="Give something"
        hint="It leaves a named account on the day you record it, so net worth moves with it.">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* The last entry is "Initial payment", the same as every other source picker in
              the ledger: sadaqat given before this ledger existed, or out of cash it never
              saw, is a real record and moves no balance. */}
          <Field label="Paid from">
            <SourceAccountSelect ariaLabel="Source account" value={draft.accountId}
                                 onChange={(v) => setDraft({ ...draft, accountId: v })} />
          </Field>
          <Field label="Amount">
            <Amount value={draft.amount} ariaLabel="Amount" onChange={(n) => setDraft({ ...draft, amount: n })} />
          </Field>
          <Field label="Went to">
            <Select ariaLabel="Cause" value={draft.causeId}
                    onChange={(v) => setDraft({ ...draft, causeId: v })}
                    options={cats.map((c) => ({ value: c.id, label: c.name,
                                               icon: c.icon, iconColor: c.color }))} />
          </Field>
          <Field label="Date"><DateField value={logDate} onChange={setLogDate} ariaLabel="Date it was given" hijri /></Field>
          <Field label="Note">
            <input placeholder="who, and what for" value={draft.note} aria-label="Note"
                   onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
          </Field>
          <ActionButton capability="giving.record" disabled={!(draft.amount > 0)}
            style={{ background: 'var(--sadaqat)', color: 'var(--canvas)' }}
            onDone={(o) => { if (o.ok) setDraft({ ...draft, amount: 0, note: '' }); }}
            input={() => ({
              accountId: realAccountId(draft.accountId),
              amount: draft.amount, causeId: draft.causeId,
              isZakat: false, date: logDate, note: draft.note || undefined,
            })}>
            Record it
          </ActionButton>
        </div>
      </OperationPanel>
    )}>
      <Sections sections={[
        { id: 'giving', label: 'Giving', icon: 'hands',
          hint: 'What you gave, out of a named account, on the day you gave it. Double-click a record to undo it — it writes the opposite movement rather than erasing it.' },
        { id: 'causes', label: 'Causes', icon: 'handout',
          hint: 'Where giving is recorded against — yours to name, mark and colour. Double-click one to change it.' },
      ]} />

      <Panel>
        <Stats>
          <Stat label="Given as sadaqat" value={dm(split.totalEgp)} color="var(--sadaqat)"
                sub={`${rows.length} record${rows.length === 1 ? '' : 's'}`} />
          <Stat label="This year"
                value={dm(rows.filter((c) => c.date.startsWith(String(now.getFullYear())))
                  .reduce((s, c) => s + toEgp(c.amount, c.currency, market), 0))} />
          <Stat label="Owed to nobody" value="—" sub="sadaqat never reduces the zakat figure" />
        </Stats>
      </Panel>

      <Panel title="Recurring giving"
             hint="A standing intention rather than a schedule the app enforces — it reminds you; nothing moves on its own.">
        <Row cols="34px minmax(0,1fr) 210px 66px" style={{
          padding: '14px 16px', borderRadius: 'var(--r-card)',
          background: 'var(--raised)', border: '1px solid var(--hairline)',
        }}>
          <Icon name="hands" size={17} color={sadaqah?.enabled ? 'var(--sadaqat)' : 'var(--faint)'} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 500 }}>Monthly sadaqat</div>
            <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 2 }}>
              {sadaqah?.enabled ? `reminds ${describeLead(sadaqah)} the 1st` : 'no reminder set'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input type="number" min={0} value={sadaqah?.offsetValue ?? 3} aria-label="Sadaqat lead time"
                   onChange={(e) => update({ offsetValue: Number(e.target.value) })} style={{ width: 70 }} />
            <Select ariaLabel="Sadaqat lead unit" value={sadaqah?.offsetUnit ?? 'days'} onChange={(v) => update({ offsetUnit: v as 'days' | 'months' })}
                    options={[{ value: 'days', label: 'days before' }, { value: 'months', label: 'months before' }]} />
          </div>
          <span style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Toggle on={sadaqah?.enabled ?? false} onChange={(v) => update({ enabled: v })} label="Sadaqat reminder" />
          </span>
        </Row>
      </Panel>

      <Panel title="Records"
             hint="Every sadaqat payment, out of the account it left. Each heading filters its own column, and double-clicking a row corrects or reverses it — the same table the zakat screen shows.">
        <GivingRecords only="sadaqat" fallback={fallbackRows} onRows={setRows} />
      </Panel>

      {tab === 'causes' && (
        <Panel title="Where giving goes"
               hint="The causes giving is recorded against. Yours to name, mark and colour — renaming or recolouring one moves no money.">
          <Manager
            markFamily="giving"
            addLabel="Add a cause"
            fields={[
              { key: 'name', label: 'Name', placeholder: 'Food aid' },
              { key: 'colour', label: 'Colour', kind: 'colour', width: '54px' },
              { key: 'note', label: 'Note', placeholder: 'who it reaches' },
            ]}
            rows={cats.map((c) => ({
              id: c.id,
              mark: c.icon,
              colour: c.color,
              values: { name: c.name, colour: c.color, note: (c as { note?: string }).note ?? '' },
              blocked: data.charity.some((x) => x.categoryId === c.id)
                ? 'Giving has been recorded against this cause. Archiving keeps those records readable.'
                : undefined,
            }))}
            onSave={(id, patch) => run('destination.update', {
              destinationId: id,
              name: patch.name as string | undefined,
              color: (patch.colour as string | undefined) ?? undefined,
              icon: patch.mark as string | undefined,
            })}
            onAdd={(d) => run('destination.add', {
              name: d.name as string,
              color: (d.colour as string) || '#8A8578',
              // The mark chosen in the add row is part of the thing being added. Left off,
              // a destination given a picture and a colour arrived wearing the colour and
              // the fallback glyph, which read as the icon picker not working at all.
              icon: (d.mark as string | undefined) || undefined,
              note: (d.note as string) || undefined,
              domain: 'charity',
            })}
            onDelete={(id) => run('destination.remove', { destinationId: id })}
            onArchive={(id) => run('destination.update', { destinationId: id, archived: true })}
          />
        </Panel>
      )}
    </Page>
  );
}
