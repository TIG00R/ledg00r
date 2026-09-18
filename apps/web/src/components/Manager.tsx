import { useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { Mark, MarkPicker } from './Mark';
import { Select, type Option } from './Select';
import { DateField } from './DateField';
import { ConfirmDelete } from './Confirm';
import { ClearAll } from './ClearAll';
import { Icon } from './Icon';
import { useLive } from '../Live';
import { isInteractive } from './RecordTable';

/**
 * Editing a list of things in place.
 *
 * The earlier arrangement put a panel beside the screen with a button that opened something
 * else. That is one indirection too many for what is actually being done: the thing is on
 * screen, its name is right there, and the obvious move is to change it where it sits.
 *
 * A row used to stand open as fields the whole time, which meant a list of things people
 * rename twice a year kept eight inputs live for the other 364 days, and correcting the one
 * that was wrong first meant flipping a switch for the whole screen. A row here reads as
 * plain text until you point at it: double-click it, or press Enter with it focused — the
 * same gesture `RecordTable` opens a row with, for the same reason. Only one row is ever
 * open, so there is never a question of which Save belongs to which.
 *
 * The pencil is a hint now, not furniture: it paints nothing until the row is hovered or
 * landed on with Tab, the same `.rt-hint` behaviour `RecordTable` uses, so a list of forty
 * things is not forty pencils sitting there whether or not anyone means to touch them. The
 * bin moved further still — off the row entirely, onto the line an open row shows beside
 * Save and Cancel — because reaching it should take the same deliberate step as reaching
 * either of those, not an idle one aimed at nothing in particular.
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
  /** the one row open for correction, and what it currently reads while it is open */
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string | number>>({});
  const [picking, setPicking] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addDraft, setAddDraft] = useState<Record<string, string | number>>({});
  const { running } = useLive();

  const isOpen = (id: string) => openId === id;
  const valueOf = (row: ManagedRow, key: string) => (isOpen(row.id) ? draft[key] : row.values[key]) ?? '';
  const markOf = (row: ManagedRow) => (isOpen(row.id) ? (draft.mark as string | undefined) || undefined : row.mark);
  const colourOf = (row: ManagedRow) =>
    (isOpen(row.id) ? (draft.colour as string | undefined) : row.colour) ?? '#8A8578';

  const openRow = (row: ManagedRow) => {
    setOpenId(row.id);
    setDraft({ ...row.values, mark: row.mark ?? '', colour: row.colour ?? '' });
    setPicking(null);
  };
  const closeRow = () => { setOpenId(null); setDraft({}); setPicking(null); };
  const change = (key: string, v: string | number) => setDraft((d) => ({ ...d, [key]: v }));
  const save = async (row: ManagedRow) => { await onSave(row.id, draft); closeRow(); };

  // The row and the add row are laid out the same way so a field sits in the same place down
  // the panel. Without this each row sized itself and the fields marched about as values
  // changed.
  /**
   * How much room a field asks for, and whether it may take more.
   *
   * The row used to be a CSS grid whose columns were the fields' own widths, which cannot
   * shrink below what they ask for — so income's row, with a currency, a cadence, a day and
   * an account all open at once, asked for more width than the card had, and the grid let the
   * overflow stand: Save and Cancel, in the last column, were pushed out past the card's own
   * border. Shrinking the columns instead (down to `minmax(0, …)`) kept everything inside the
   * card, but at the cost of the field itself — "Whenever it comes" read as "We…", which
   * answers overflow by making the row unreadable instead.
   *
   * The row is a flex line now, and a field's width is a floor rather than a column: it never
   * renders narrower than what it asked for, and a card too narrow for every field on one line
   * wraps the rest onto another rather than crushing any of them.
   */
  const trackFor = (width?: string): { min: number; grow: number } => {
    if (!width) return { min: 120, grow: 1 };
    const mm = /^minmax\(\s*(\d+)px\s*,\s*(.+?)\s*\)$/.exec(width);
    if (!mm) return { min: parseInt(width, 10) || 120, grow: 0 };
    const [, min, max] = mm;
    return { min: Number(min), grow: max!.endsWith('fr') ? parseFloat(max!) : 0 };
  };
  const basisOf = (width?: string) => {
    const { min, grow } = trackFor(width);
    return { flex: `${grow} 1 ${min}px`, minWidth: min };
  };

  const optionsFor = (f: ManagedField, row: ManagedRow, values: Record<string, string | number>) =>
    typeof f.options === 'function' ? f.options(row, values) : (f.options ?? []);

  /** What a field reads as while the row is closed — a label's worth of a value, not a form. */
  const displayText = (f: ManagedField, row: ManagedRow): string => {
    const v = row.values[f.key];
    if (f.kind === 'select') {
      const found = optionsFor(f, row, row.values).find((o) => String(o.value) === String(v ?? ''));
      return found?.label ?? (v || v === 0 ? String(v) : '—');
    }
    return v === '' || v == null ? '—' : String(v);
  };
  /**
   * The second line under a closed row's name: everything else it holds, said plainly.
   *
   * A colour is left out of it — it is already on the mark beside the name, and saying
   * "Colour: #8A8578" in words beside a swatch would be the same fact twice.
   */
  const summaryOf = (row: ManagedRow) => fields.slice(1)
    .filter((f) => f.kind !== 'colour' && (!f.when || f.when(row.values)))
    .map((f) => `${f.label}: ${displayText(f, row)}`)
    .join('   ·   ');

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

      {rows.map((row) => {
        const open = isOpen(row.id);
        const name = String(row.values[fields[0]!.key] ?? row.id);
        const summary = summaryOf(row);
        return (
        <div key={row.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div
            className={!open ? 'mgr-row' : undefined}
            tabIndex={!open ? 0 : undefined}
            aria-label={!open ? `Double-click, or press Enter, to edit ${name}` : undefined}
            onDoubleClick={!open ? (e: MouseEvent<HTMLDivElement>) => {
              if (isInteractive(e.target)) return;
              openRow(row);
            } : undefined}
            onKeyDown={!open ? (e: KeyboardEvent<HTMLDivElement>) => {
              if (e.key !== 'Enter' || isInteractive(e.target)) return;
              e.preventDefault();
              openRow(row);
            } : undefined}
            style={{
              display: 'flex', flexWrap: 'wrap',
              gap: 12, alignItems: 'center',
              padding: '13px 15px', borderRadius: 'var(--r-card)',
              cursor: !open ? 'pointer' : undefined,
              background: open ? 'color-mix(in srgb, var(--gold) 7%, var(--raised))' : 'var(--raised)',
              border: `1px solid ${open ? 'color-mix(in srgb, var(--gold) 32%, transparent)' : 'var(--hairline)'}`,
            }}>
            {open ? (
              <button onClick={() => setPicking(picking === row.id ? null : row.id)}
                aria-label={`Change the mark for ${name}`}
                style={{
                  flex: '0 0 auto',
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
            ) : (
              <span aria-hidden style={{
                flex: '0 0 auto', width: 34, height: 34, borderRadius: 9,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: `color-mix(in srgb, ${colourOf(row)} 15%, transparent)`,
                border: '1px solid var(--hairline)',
              }}>
                <Mark mark={markOf(row)} size={18} color={colourOf(row)} />
              </span>
            )}

            {open ? (
              fields.map((f) => {
                const values = draft;
                if (f.when && !f.when(values)) return null;
                return (
                  <span key={f.key} style={basisOf(f.width)}>
                    {cell(f, valueOf(row, f.key), (v) => {
                      change(f.key, v);
                      if (f.kind === 'colour') change('colour', v);
                    }, `${f.label} for ${name}`, optionsFor(f, row, values))}
                  </span>
                );
              })
            ) : (
              <div style={{ flex: '1 1 220px', minWidth: 160 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{name}</div>
                {summary && (
                  <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 2 }}>{summary}</div>
                )}
              </div>
            )}

            <span style={{ display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'flex-end',
                           flex: '1 1 150px', minWidth: 150 }}>
              {row.trailing}
              {open ? (
                <>
                  <span className="btn-pair">
                    <button className="btn go sm" disabled={!!running}
                      onClick={() => { void save(row); }}>
                      <Icon name="check" size={13} motion="none" /> Save
                    </button>
                    <button className="btn ghost sm" onClick={closeRow}>
                      <Icon name="close" size={13} motion="none" /> Cancel
                    </button>
                  </span>
                  {/* Subordinate to Save and Cancel — after them, smaller, and its own icon
                      rather than part of that pair, so a bin never shares a corner with the
                      button that finishes an edit. Only offered once the row is open, the
                      same as `RecordTable`'s. */}
                  {canDelete && onDelete && (
                    <ConfirmDelete what={name} blocked={row.blocked} size={13}
                                   onConfirm={() => { void onDelete(row.id); }}
                                   onArchive={onArchive ? () => { void onArchive(row.id); } : undefined} />
                  )}
                </>
              ) : (
                /* At rest this paints nothing — `.rt-hint` (tokens.css) keeps it invisible
                   until the row is hovered or landed on with Tab, the same hint the whole row
                   already answers a double-click or an Enter to. A screen reader still hears
                   the button regardless; only the paint waits. */
                <button className="btn quiet rt-hint" onClick={() => openRow(row)} tabIndex={-1}
                        aria-label={`Edit ${name}`} title="Edit" style={{ padding: 7, border: 'none' }}>
                  <Icon name="edit" size={14} />
                </button>
              )}
            </span>
          </div>

          {open && picking === row.id && (
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
              label={`Mark for ${name}`}
              onClose={() => setPicking(null)}
              onChange={(m) => { void onSave(row.id, { ...draft, mark: m }); closeRow(); }} />
          )}
        </div>
        );
      })}

      {onAdd && addBlocked ? (
        <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--faint)' }}>{addBlocked}</p>
      ) : onAdd && (adding ? (
        <>
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center',
          padding: '13px 15px', borderRadius: 'var(--r-card)',
          background: 'color-mix(in srgb, var(--positive) 6%, transparent)',
          border: '1px dashed color-mix(in srgb, var(--positive) 40%, transparent)',
        }}>
          {/* A new thing gets its mark here, rather than having to be saved first and then
              edited — which is what "adding a picture does not work" actually meant. */}
          <button onClick={() => setPicking(picking === '__new' ? null : '__new')}
            aria-label="Mark for the new one"
            style={{ flex: '0 0 auto',
                     width: 34, height: 34, borderRadius: 9, cursor: 'pointer', position: 'relative',
                     display: 'flex', alignItems: 'center', justifyContent: 'center',
                     background: 'var(--surface)', border: '1px solid var(--hairline)' }}>
            {addDraft.mark
              ? <Mark mark={String(addDraft.mark)} size={18} color={String(addDraft.colour ?? 'var(--positive)')} />
              : <Icon name="plus" size={16} color="var(--positive)" />}
          </button>
          {fields.map((f) => {
            if (f.when && !f.when(addDraft)) return null;
            const blank: ManagedRow = { id: '', values: {} };
            return (
              <span key={f.key} style={basisOf(f.width)}>
                {cell(f, addDraft[f.key] ?? (f.kind === 'select' ? (optionsFor(f, blank, addDraft)[0]?.value ?? '') : ''),
                      (v) => setAddDraft({ ...addDraft, [f.key]: v }),
                      `New ${f.label}`, optionsFor(f, blank, addDraft))}
              </span>
            );
          })}
          <span className="btn-pair" style={{ flex: '1 1 150px', minWidth: 150 }}>
            <button className="btn add sm"
              disabled={!addDraft[fields[0]!.key] || !!running || !!addValid?.(addDraft)}
              onClick={async () => { await onAdd(addDraft); setAddDraft({}); setAdding(false); setPicking(null); }}>
              <Icon name="plus" size={13} motion="none" /> Add
            </button>
            <button className="btn ghost sm"
                    onClick={() => { setAddDraft({}); setAdding(false); setPicking(null); }}>
              <Icon name="close" size={13} motion="none" /> Cancel
            </button>
          </span>
        </div>

        {addValid?.(addDraft) && (
          <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--gold)' }}>{addValid(addDraft)}</p>
        )}

        {picking === '__new' && (
          <MarkPicker value={addDraft.mark ? String(addDraft.mark) : undefined} family={markFamily}
            tone={String(addDraft.colour ?? '#8A8578')}
            label="Mark for the new one — an icon, or a picture of your own"
            onClose={() => setPicking(null)}
            onChange={(m) => setAddDraft({ ...addDraft, mark: m })} />
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
