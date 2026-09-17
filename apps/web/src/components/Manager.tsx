import { useState, type ReactNode } from 'react';
import { Mark, MarkPicker } from './Mark';
import { Select, type Option } from './Select';
import { DateField } from './DateField';
import { ConfirmDelete } from './Confirm';
import { ClearAll } from './ClearAll';
import { Icon } from './Icon';
import { useLive } from '../Live';

/**
 * Editing a list of things in place.
 *
 * The earlier arrangement put a panel beside the screen with a button that opened something
 * else. That is one indirection too many for what is actually being done: the thing is on
 * screen, its name is right there, and the obvious move is to change it where it sits. So
 * every field here is a real input, Save appears when something has changed, and the row that
 * adds a new one looks like the rows above it.
 *
 * `dirty` is per row rather than global, so editing one thing never risks saving another.
 */
export interface ManagedField {
  key: string;
  label: string;
  kind?: 'text' | 'number' | 'colour' | 'select' | 'date';
  width?: string;
  placeholder?: string;
  /** shown under the field, when the field needs a word of explanation */
  hint?: string;
  /** for `select`; may depend on the row, so a currency can narrow what follows it */
  options?: Option[] | ((row: ManagedRow, draft: Record<string, string | number>) => Option[]);
  /** hidden when this returns false — a day-of-month only matters for a monthly cadence */
  when?: (values: Record<string, string | number>) => boolean;
}

export interface ManagedRow {
  id: string;
  mark?: string;
  colour?: string;
  values: Record<string, string | number>;
  /** why this row cannot be deleted, when it cannot */
  blocked?: string;
  /** shown after the fields, for anything the row wants to say */
  trailing?: ReactNode;
}

export function Manager({
  rows, fields, markFamily, addLabel, emptyLabel, addBlocked, addValid,
  onSave, onDelete, onAdd, onArchive, clear, canDelete = true,
}: {
  rows: ManagedRow[];
  fields: ManagedField[];
  markFamily: string;
  addLabel: string;
  emptyLabel?: string;
  /**
   * Why nothing can be added yet, when something is missing first.
   *
   * An income source has to land in an account, so a ledger with no accounts cannot have one
   * — and saying that here beats offering the form and refusing what it sends, which is what
   * "The input does not match what this capability takes" was.
   */
  addBlocked?: string;
  /**
   * Why this particular draft cannot be added yet, when it cannot.
   *
   * Returns the reason, or nothing when the draft is fine. Said beside a disabled Add rather
   * than discovered by sending it: an income source paid in a currency no account is held in
   * has nowhere to land, and the form knows that before the ledger is asked.
   */
  addValid?: (draft: Record<string, string | number>) => string | undefined;
  onSave: (id: string, patch: Record<string, string | number>) => void | Promise<unknown>;
  /** deleting the row outright; the ledger refuses where something still names it */
  onDelete?: (id: string) => void | Promise<unknown>;
  /**
   * Archiving it instead, offered in the same dialog.
   *
   * The gentler answer, and usually the right one: it takes the thing out of the pickers and
   * leaves every record that named it readable. The interface cannot tell which rows have
   * records behind them, so it offers both and lets the ledger refuse the wrong one.
   */
  onArchive?: (id: string) => void | Promise<unknown>;
  onAdd?: (draft: Record<string, string | number>) => void | Promise<unknown>;
  /**
   * Emptying the whole list, as opposed to removing one row of it.
   *
   * `log` is the name `records.clear` knows the list by. Absent where there is no such log —
   * the currencies live in a setting rather than a table, and there is no sense in which they
   * can be emptied.
   */
  clear?: { log: string; what: string; onDone?: () => void };
  canDelete?: boolean;
}) {
  const [edits, setEdits] = useState<Record<string, Record<string, string | number>>>({});
  const [picking, setPicking] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Record<string, string | number>>({});
  const { running } = useLive();

  const valueOf = (row: ManagedRow, key: string) => edits[row.id]?.[key] ?? row.values[key] ?? '';
  const markOf = (row: ManagedRow) => (edits[row.id]?.mark as string) ?? row.mark;
  const colourOf = (row: ManagedRow) => (edits[row.id]?.colour as string) ?? row.colour ?? '#8A8578';
  const dirty = (id: string) => Object.keys(edits[id] ?? {}).length > 0;

  const change = (id: string, key: string, v: string | number) =>
    setEdits((e) => ({ ...e, [id]: { ...e[id], [key]: v } }));
  const forget = (id: string) => setEdits(({ [id]: _, ...rest }) => rest);

  // The add row and the edited rows share one grid so their columns line up down the panel.
  // Without this each row sized itself and the fields marched about as values changed.
  /**
   * The columns for one row.
   *
   * Only the fields actually shown take a column. Reserving space for a hidden one — which is
   * what happened when a weekly source hid the day-of-month field — left a gap and pushed
   * everything after it out of line with the row above.
   */
  const columnsFor = (values: Record<string, string | number>) =>
    `44px ${fields.filter((f) => !f.when || f.when(values))
      .map((f) => f.width ?? 'minmax(120px,1fr)').join(' ')} minmax(150px, auto)`;

  const optionsFor = (f: ManagedField, row: ManagedRow, values: Record<string, string | number>) =>
    typeof f.options === 'function' ? f.options(row, values) : (f.options ?? []);

  const cell = (
    f: ManagedField,
    value: string | number,
    set: (v: string | number) => void,
    aria: string,
    options: Option[],
  ) => {
    if (f.kind === 'colour') {
      return <input type="color" aria-label={aria} value={String(value || '#8A8578')}
                    onChange={(e) => set(e.target.value)}
                    style={{ width: '100%', height: 34, padding: 2, cursor: 'pointer' }} />;
    }
    if (f.kind === 'select') {
      return <Select ariaLabel={aria} value={String(value)} options={options} onChange={set} />;
    }
    if (f.kind === 'date') {
      return <DateField value={String(value ?? '')} ariaLabel={aria} onChange={set} />;
    }
    return <input aria-label={aria} type={f.kind === 'number' ? 'number' : 'text'}
                  className={f.kind === 'number' ? 'mono' : undefined}
                  value={value} placeholder={f.placeholder}
                  onChange={(e) => set(f.kind === 'number' ? Number(e.target.value) : e.target.value)}
                  style={{ fontSize: 13, padding: '7px 9px', width: '100%' }} />;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {rows.length === 0 && emptyLabel && (
        <p style={{ margin: '4px 0 8px', fontSize: 12, color: 'var(--faint)' }}>{emptyLabel}</p>
      )}

      {clear && rows.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <ClearAll log={clear.log} what={clear.what} count={rows.length} onDone={clear.onDone} />
        </div>
      )}

      {rows.map((row) => (
        <div key={row.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: columnsFor({ ...row.values, ...(edits[row.id] ?? {}) }),
            gap: 12, alignItems: 'center',
            padding: '13px 15px', borderRadius: 'var(--r-card)',
            background: dirty(row.id) ? 'color-mix(in srgb, var(--gold) 7%, var(--raised))' : 'var(--raised)',
            border: `1px solid ${dirty(row.id) ? 'color-mix(in srgb, var(--gold) 32%, transparent)' : 'var(--hairline)'}`,
          }}>
            <button onClick={() => setPicking(picking === row.id ? null : row.id)}
              aria-label={`Change the mark for ${row.values[fields[0]!.key] ?? row.id}`}
              style={{
                width: 34, height: 34, borderRadius: 9, cursor: 'pointer', position: 'relative',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: `color-mix(in srgb, ${colourOf(row)} 15%, transparent)`,
                border: '1px solid var(--hairline)',
              }}>
              <Mark mark={markOf(row)} size={18} color={colourOf(row)} />
              <span style={{ position: 'absolute', right: -4, bottom: -4, width: 14, height: 14,
                             borderRadius: 999, background: 'var(--gold)', display: 'flex',
                             alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="edit" size={8} color="#fff" strokeWidth={2.4} motion="none" />
              </span>
            </button>

            {fields.map((f) => {
              const values = { ...row.values, ...(edits[row.id] ?? {}) };
              if (f.when && !f.when(values)) return null;
              const name = String(row.values[fields[0]!.key] ?? row.id);
              return (
                <span key={f.key} style={{ minWidth: 0 }}>
                  {cell(f, valueOf(row, f.key), (v) => {
                    change(row.id, f.key, v);
                    if (f.kind === 'colour') change(row.id, 'colour', v);
                  }, `${f.label} for ${name}`, optionsFor(f, row, values))}
                </span>
              );
            })}

            <span style={{ display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'flex-end' }}>
              {row.trailing}
              {dirty(row.id) && (
                <span className="btn-pair">
                  <button className="btn go sm" disabled={!!running}
                    onClick={async () => { await onSave(row.id, edits[row.id]!); forget(row.id); }}>
                    <Icon name="check" size={13} motion="none" /> Save
                  </button>
                  <button className="btn ghost sm" onClick={() => forget(row.id)}>
                    <Icon name="close" size={13} motion="none" /> Cancel
                  </button>
                </span>
              )}
              {canDelete && onDelete && !dirty(row.id) && (
                <ConfirmDelete what={String(row.values[fields[0]!.key] ?? row.id)}
                               blocked={row.blocked} size={14}
                               onConfirm={() => { void onDelete(row.id); }}
                               onArchive={onArchive ? () => { void onArchive(row.id); } : undefined} />
              )}
            </span>
          </div>

          {picking === row.id && (
            /**
             * A mark is saved the moment it is chosen.
             *
             * Everything else here is typed, so it waits for Save — but choosing an icon, or
             * uploading a picture, is a finished act: the picker closes and the thing looks
             * done. Leaving it as a pending edit meant an uploaded photograph sat in the
             * screen's memory and never reached the record, which read as the upload having
             * silently failed.
             */
            <MarkPicker value={markOf(row)} family={markFamily} tone={colourOf(row)}
              label={`Mark for ${row.values[fields[0]!.key] ?? row.id}`}
              onClose={() => setPicking(null)}
              onChange={(m) => { void onSave(row.id, { ...edits[row.id], mark: m }); forget(row.id); }} />
          )}
        </div>
      ))}

      {onAdd && addBlocked ? (
        <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--faint)' }}>{addBlocked}</p>
      ) : onAdd && (adding ? (
        <>
        <div style={{
          display: 'grid', gridTemplateColumns: columnsFor(draft), gap: 12, alignItems: 'center',
          padding: '13px 15px', borderRadius: 'var(--r-card)',
          background: 'color-mix(in srgb, var(--positive) 6%, transparent)',
          border: '1px dashed color-mix(in srgb, var(--positive) 40%, transparent)',
        }}>
          {/* A new thing gets its mark here, rather than having to be saved first and then
              edited — which is what "adding a picture does not work" actually meant. */}
          <button onClick={() => setPicking(picking === '__new' ? null : '__new')}
            aria-label="Mark for the new one"
            style={{ width: 34, height: 34, borderRadius: 9, cursor: 'pointer', position: 'relative',
                     display: 'flex', alignItems: 'center', justifyContent: 'center',
                     background: 'var(--surface)', border: '1px solid var(--hairline)' }}>
            {draft.mark
              ? <Mark mark={String(draft.mark)} size={18} color={String(draft.colour ?? 'var(--positive)')} />
              : <Icon name="plus" size={16} color="var(--positive)" />}
          </button>
          {fields.map((f) => {
            if (f.when && !f.when(draft)) return null;
            const blank: ManagedRow = { id: '', values: {} };
            return (
              <span key={f.key} style={{ minWidth: 0 }}>
                {cell(f, draft[f.key] ?? (f.kind === 'select' ? (optionsFor(f, blank, draft)[0]?.value ?? '') : ''),
                      (v) => setDraft({ ...draft, [f.key]: v }),
                      `New ${f.label}`, optionsFor(f, blank, draft))}
              </span>
            );
          })}
          <span className="btn-pair">
            <button className="btn add sm"
              disabled={!draft[fields[0]!.key] || !!running || !!addValid?.(draft)}
              onClick={async () => { await onAdd(draft); setDraft({}); setAdding(false); setPicking(null); }}>
              <Icon name="plus" size={13} motion="none" /> Add
            </button>
            <button className="btn ghost sm"
                    onClick={() => { setDraft({}); setAdding(false); setPicking(null); }}>
              <Icon name="close" size={13} motion="none" /> Cancel
            </button>
          </span>
        </div>

        {addValid?.(draft) && (
          <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--gold)' }}>{addValid(draft)}</p>
        )}

        {picking === '__new' && (
          <MarkPicker value={draft.mark ? String(draft.mark) : undefined} family={markFamily}
            tone={String(draft.colour ?? '#8A8578')}
            label="Mark for the new one — an icon, or a picture of your own"
            onClose={() => setPicking(null)}
            onChange={(m) => setDraft({ ...draft, mark: m })} />
        )}
        </>
      ) : (
        <button className="btn ghost" onClick={() => setAdding(true)}
          style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          <Icon name="plus" size={14} /> {addLabel}
        </button>
      ))}
    </div>
  );
}
