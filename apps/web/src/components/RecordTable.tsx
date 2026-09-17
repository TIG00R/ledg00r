import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { Select } from './Select';
import { DateField } from './DateField';
import { Empty } from './UI';
import { ConfirmModal } from './Confirm';
import { ClearAll } from './ClearAll';
import { useLive } from '../Live';
import { useMode } from './ModeBar';

/**
 * Every log in this application, drawn once.
 *
 * There were seven tables with seven ideas about where the add button goes, which columns
 * filter, whether a row can be corrected and what the buttons are called. This is the one
 * answer: headings that sort and filter themselves, a row at the top that adds, a row that
 * turns into fields when edited, and the same three buttons everywhere — green to add or
 * save, grey to cancel, red to remove.
 *
 * A screen describes its columns and what a record is; nothing else about a table is that
 * screen's business.
 */
/** the two shades a row wears while it is being written: adding is green, correcting is gold */
const ADDING = 'color-mix(in srgb, var(--positive) 7%, transparent)';
const EDITING = 'color-mix(in srgb, var(--gold) 7%, transparent)';

export type Cmp = string | number;
/**
 * What a column holds, which decides how it filters and how wide it is.
 *
 * `money` is an amount with the unit it is in — the same filter as an amount, and room for
 * the currency picker that sits beside the number while the row is being edited.
 */
export type FilterKind = 'pick' | 'text' | 'amount' | 'money' | 'date' | 'none';

export interface Column<T> {
  key: string;
  label: string;
  /** what this column reads for sorting and filtering */
  value: (row: T) => Cmp;
  /** how it is drawn; falls back to `value` */
  cell?: (row: T) => ReactNode;
  kind?: FilterKind;
  width?: string;
  align?: 'left' | 'right';
  /**
   * Whether this column may wrap onto a second line.
   *
   * A column of sentences — a note, a place, a description — should wrap and take whatever
   * room is left. Everything else is a value that has to be read whole: a date, an amount
   * and its unit, an account, a destination, a status. Those never wrap and are never cut;
   * the column grows to hold them and the table scrolls if it must. Left unsaid, a column
   * of the `text` kind wraps and every other kind does not.
   */
  wrap?: boolean;
  /**
   * What a 'pick' filter offers.
   *
   * Left alone it offers the values the loaded rows happen to contain, which answers "what is
   * already in this log" rather than "what could be in it" — a column of accounts then lists
   * whichever accounts were touched recently and silently omits the rest. A column that knows
   * its own vocabulary states it here.
   */
  choices?: string[];
  /** the control shown when this cell is being added or edited */
  field?: (draft: Record<string, any>, set: (patch: Record<string, any>) => void, row?: T) => ReactNode;
}

interface Dir { key: string; dir: 'asc' | 'desc' }
interface FilterValue { text?: string; min?: string; max?: string; from?: string; to?: string }

export interface RecordTableProps<T> {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  sort?: Dir;
  empty?: { icon: IconName; title: string; body: string };
  /** adding a record, through the row at the top */
  add?: {
    label: string;
    /** a function where what is being added decides it — buying metal is not selling it */
    capability: string | ((draft: Record<string, any>) => string);
    blank: Record<string, any>;
    build: (draft: Record<string, any>) => unknown;
    valid: (draft: Record<string, any>) => boolean;
    onDone?: () => void;
  };
  /** correcting one, in place */
  edit?: {
    /**
     * What correcting this row calls.
     *
     * A function where it depends on the row and on what is being asked for it: a payment
     * still owed is corrected by changing the plan, one already made by rewriting the
     * movement that paid it, and one being marked paid by paying it. Three capabilities and
     * one gesture, which is why the draft is offered here as well as the row.
     */
    capability: string | ((row: T, draft: Record<string, any>) => string);
    draftOf: (row: T) => Record<string, any>;
    build: (draft: Record<string, any>, row: T) => unknown;
    /** why this row cannot be edited, when it cannot */
    blocked?: (row: T) => string | undefined;
    onDone?: () => void;
  };
  /** removing one */
  remove?: {
    capability: string | ((row: T) => string);
    build: (row: T) => unknown;
    what: (row: T) => string;
    blocked?: (row: T) => string | undefined;
    onDone?: () => void;
  };
  /**
   * Emptying the whole log, as opposed to removing one row of it.
   *
   * Offered while editing, beside the count, because it is the same kind of act as the bin on
   * a row and belongs where that one is reachable. `log` is the name `records.clear` knows it
   * by; the count comes from the rows the table was given.
   */
  clear?: { log: string; what: string; onDone?: () => void };
  /**
   * A line of its own under the row.
   *
   * For what belongs to one record rather than beside it — the repayments against a debt,
   * say. Returning nothing leaves the row alone, so only the rows with something to show
   * carry the extra line.
   */
  detail?: (row: T) => ReactNode;
  /** shown after the last column, before the buttons */
  trailing?: (row: T) => ReactNode;
  /** how much room that column needs */
  trailingWidth?: string;
}

export function RecordTable<T>({
  rows, columns, rowKey, sort: initialSort, empty, add, edit, remove, clear, trailing, detail,
  trailingWidth = '96px',
}: RecordTableProps<T>) {
  const { run, running } = useLive();
  const { mode } = useMode();
  const [sort, setSort] = useState<Dir | null>(initialSort ?? null);
  const [filters, setFilters] = useState<Record<string, FilterValue>>({});
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Record<string, any>>(add?.blank ?? {});
  const [editing, setEditing] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Record<string, any>>({});
  const [problem, setProblem] = useState<string | null>(null);

  const editable = !!edit && mode === 'edit';
  const removable = !!remove && mode === 'edit';
  /**
   * Emptying the log is an edit like any other, and a destructive one, so it lives behind the
   * same switch the bin does rather than sitting over every table being read.
   */
  const clearable = mode === 'edit';
  /**
   * The last column exists for the pencil and the bin, and for nothing else.
   *
   * Adding used to keep it alive too, which gave every table a column that was empty on every
   * row — and once a row opened, wide enough to need pinning, so a shaded seam ran the height
   * of the table beside eight empty cells. Confirming a row is now a line under it, so the
   * column comes and goes with the two buttons that actually live in it.
   */
  const actions = editable || removable;
  /**
   * How much room the last column needs.
   *
   * Two icons, side by side, and that is all it ever holds: Save and Cancel sit on their own
   * line under the row being written, so this width no longer changes when one opens. A
   * column that grew on opening pushed the table past its panel, turned on the pinned edge,
   * and moved every value in every row sideways to make room for buttons in one of them.
   * Ninety-six was the old width, sized for those buttons; two icons need eighty.
   */
  const actionsWidth = 80;

  const kindOf = (c: Column<T>): FilterKind => {
    if (c.kind) return c.kind;
    const sample = rows[0] ? c.value(rows[0]) : '';
    if (typeof sample === 'number') return 'amount';
    if (typeof sample === 'string' && /^\d{4}-\d{2}-\d{2}/.test(sample)) return 'date';
    const seen = new Set<string>();
    for (const r of rows) { seen.add(String(c.value(r))); if (seen.size > 12) return 'text'; }
    return 'pick';
  };

  /**
   * How wide a column is — as a floor, never as a ceiling.
   *
   * The table used to lay out on stated widths and nothing else, which made every width a
   * ceiling as well: "Groceries" became "Grocerie", "Bills & Utilities" became "Bills & Ut",
   * and an account and its bank were cut mid-word. A column that cannot show its value is
   * not narrower, it is wrong.
   *
   * So these are the widths a row being *edited* needs — an edited row carries a date field,
   * pickers and an amount box where the read row has text, and it is the wider of the two —
   * and the browser is free to give a column more when its contents ask for more. What it
   * may never do is give it less than it needs and hide the difference.
   */
  const WIDTH: Partial<Record<FilterKind, number>> = {
    date: 138, amount: 108, money: 176, pick: 112, none: 64,
  };
  /**
   * A column of words has no natural width; this is the floor below which it stops being
   * readable. It is a floor, not a width — where there is room the column takes what is left,
   * and stating it lower only decides when the table starts to scroll instead of crushing
   * every column beside it.
   */
  const WORDS = 144;
  const widthOf = (c: Column<T>) => c.width ?? (WIDTH[kindOf(c)] ? `${WIDTH[kindOf(c)]}px` : undefined);
  /**
   * Which columns hold a sentence rather than a value.
   *
   * Only these wrap, and only these absorb the room left over once every other column has
   * taken what its contents need. Everything else is read on one line, whole.
   */
  const wraps = (c: Column<T>) => c.wrap ?? kindOf(c) === 'text';
  const wrapping = columns.filter(wraps).length;

  /**
   * The narrowest the table can be drawn without a column collapsing.
   *
   * Fixed layout gives every column exactly what it was promised and shares out what is left;
   * when there is nothing left, the columns with no stated width — the notes, the places —
   * were being squeezed to nothing. Stating the floor means the panel scrolls sideways
   * instead, which is the honest outcome: the table is wider than the space it was given.
   */
  /** a stated width in pixels, or nothing — anything else is a column that takes what is left */
  const px = (w?: string) => {
    const n = w ? parseInt(w, 10) : NaN;
    return Number.isFinite(n) ? n : null;
  };
  const floor = columns.reduce((n, c) => n + (px(widthOf(c)) ?? WORDS), 0)
    + (trailing ? px(trailingWidth) ?? 0 : 0) + (actions ? actionsWidth : 0);

  const shown = useMemo(() => {
    const kept = rows.filter((row) => columns.every((c) => {
      const f = filters[c.key];
      if (!f) return true;
      const has = c.value(row);
      if (f.min && Number(has) < Number(f.min)) return false;
      if (f.max && Number(has) > Number(f.max)) return false;
      if (f.from && String(has).slice(0, 10) < f.from) return false;
      if (f.to && String(has).slice(0, 10) > f.to) return false;
      if (f.text && !String(has).toLowerCase().includes(f.text.toLowerCase())) return false;
      return true;
    }));
    if (!sort) return kept;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return kept;
    const sign = sort.dir === 'asc' ? 1 : -1;
    return [...kept].sort((a, b) => {
      const x = col.value(a); const y = col.value(b);
      return (typeof x === 'number' && typeof y === 'number'
        ? x - y : String(x).localeCompare(String(y))) * sign;
    });
  }, [rows, columns, filters, sort]);

  const anyFilter = Object.values(filters).some((f) => f && Object.values(f).some(Boolean));
  const setFilter = (key: string, patch: FilterValue) =>
    setFilters((f) => ({ ...f, [key]: { ...f[key], ...patch } }));

  /** every column, for the rows that run the width of the table */
  const span = columns.length + (trailing ? 1 : 0) + (actions ? 1 : 0);

  const closeAdd = () => { setAdding(false); setDraft(add?.blank ?? {}); setProblem(null); };
  const closeEdit = () => { setEditing(null); setEditDraft({}); setProblem(null); };

  return (
    <div>
      {/* The strip above the table: what a filter is hiding, and — while editing — the one
          control that empties the log rather than correcting a row of it. */}
      {(anyFilter || (clear && clearable)) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12,
                      flexWrap: 'wrap' }}>
          {anyFilter && (
            <>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                {shown.length} of {rows.length} shown
              </span>
              <button className="btn ghost" style={{ padding: '5px 11px', fontSize: 12 }}
                      onClick={() => setFilters({})}>Clear the filters</button>
            </>
          )}
          {clear && clearable && (
            <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
              <ClearAll log={clear.log} what={clear.what} count={rows.length}
                        onDone={clear.onDone} />
            </span>
          )}
        </div>
      )}

      <div className="rt-wrap" style={{ overflowX: 'auto' }}>
        {/*
          * Automatic layout, not fixed.
          *
          * Fixed layout hands every column exactly what it was promised and clips whatever
          * does not fit, which is how a destination lost the end of its name. Automatic
          * layout treats the stated width as a starting point and lets a column grow to its
          * contents; the columns of sentences are told to take everything left over, and the
          * table's own floor decides when the panel scrolls sideways instead.
          */}
        <table className="rt" style={{ width: '100%', minWidth: floor }}>
          <colgroup>
            {columns.map((c) => (
              <col key={c.key}
                   style={{ width: c.width
                     ?? (wraps(c) ? `${Math.floor(100 / wrapping)}%` : widthOf(c)) }} />
            ))}
            {trailing && <col style={{ width: trailingWidth }} />}
            {actions && <col style={{ width: `${actionsWidth}px` }} />}
          </colgroup>
          <thead>
            <tr>
              {columns.map((c) => {
                const kind = kindOf(c);
                const f = filters[c.key] ?? {};
                const on = sort?.key === c.key;
                return (
                  <th key={c.key} className="rt-h"
                      /* The floor the column may not go below. Automatic layout will happily
                         starve a column that wraps in favour of ones that cannot, which left
                         a note four characters wide beside six comfortable columns. */
                      style={{ textAlign: c.align ?? 'left', verticalAlign: 'top',
                               minWidth: c.width ?? (wraps(c) ? `${WORDS}px` : widthOf(c)) }}>
                    <button
                      onClick={() => setSort((s) => (s?.key === c.key
                        ? { key: c.key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
                        : { key: c.key, dir: 'desc' }))}
                      aria-label={`Sort by ${c.label}`}
                      style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer',
                               font: 'inherit', letterSpacing: 'inherit', textTransform: 'inherit',
                               color: on ? 'var(--ink)' : 'inherit', padding: '0 0 7px',
                               background: 'transparent', border: 'none', width: '100%',
                               justifyContent: c.align === 'right' ? 'flex-end' : 'flex-start' }}>
                      {c.label}
                      <Icon name="chevron" size={10} motion="none"
                            style={{ opacity: on ? 1 : 0.25,
                                     transform: on && sort!.dir === 'asc' ? 'rotate(-90deg)' : 'rotate(90deg)' }} />
                    </button>

                    {kind !== 'none' && (
                      <FilterCell kind={kind} label={c.label} value={f}
                        onChange={(patch) => setFilter(c.key, patch)}
                        choices={kind === 'pick'
                          ? c.choices ?? [...new Set(rows.map((r) => String(c.value(r))).filter(Boolean))].sort()
                          : []} />
                    )}
                  </th>
                );
              })}
              {trailing && <th className="rt-h" />}
              {actions && <th className="rt-h" />}
            </tr>
          </thead>

          <tbody>
            {add && (adding ? (
              <>
                <tr style={{ background: ADDING }}>
                  {columns.map((c) => (
                    <td key={c.key} className="rt-c" style={{ verticalAlign: 'middle',
                                                              borderBottom: 'none' }}>
                      {c.field
                        ? <span className="rt-field">{c.field(draft, (patch) => setDraft({ ...draft, ...patch }))}</span>
                        : <span style={{ color: 'var(--faint)', fontSize: 12 }}>—</span>}
                    </td>
                  ))}
                  {trailing && <td className="rt-c" style={{ borderBottom: 'none' }} />}
                  {actions && <td className="rt-c" style={{ borderBottom: 'none' }} />}
                </tr>
                <tr style={{ background: ADDING }}>
                  <td className="rt-c" colSpan={span}>
                    <Buttons
                      busy={!!running}
                      confirm={{ label: 'Add', tone: 'add', icon: 'plus',
                        disabled: !add.valid(draft),
                        onClick: async () => {
                          setProblem(null);
                          const capability = typeof add.capability === 'function'
                            ? add.capability(draft) : add.capability;
                          const res = await run(capability, add.build(draft));
                          if (res.ok) { closeAdd(); add.onDone?.(); }
                          else setProblem(res.message ?? 'That was not recorded.');
                        } }}
                      cancel={closeAdd} />
                  </td>
                </tr>
              </>
            ) : (
              <tr>
                <td className="rt-c" colSpan={span}>
                  {/* Seeded when the form opens, not when the table first drew. The blank is
                      worked out from what the ledger holds — which source is first, what it is
                      paid in, where it lands — and on the first render the service has usually
                      answered nothing yet, so a form opened later started empty. */}
                  <button className="btn add sm"
                          onClick={() => { setDraft(add.blank); setAdding(true); }}>
                    <Icon name="plus" size={14} /> {add.label}
                  </button>
                </td>
              </tr>
            ))}

            {problem && (
              <tr>
                <td className="rt-c" colSpan={span}>
                  <span style={{ fontSize: 12, color: 'var(--negative)' }}>{problem}</span>
                </td>
              </tr>
            )}

            {shown.length === 0 && !adding && empty && (
              <tr>
                <td className="rt-c" colSpan={span}>
                  <Empty icon={empty.icon} title={empty.title} body={empty.body} />
                </td>
              </tr>
            )}

            {shown.map((row) => {
              const id = rowKey(row);
              const isEditing = editing === id;
              const cannotEdit = edit?.blocked?.(row);
              const cannotRemove = remove?.blocked?.(row);
              return (
                <Fragment key={id}>
                <tr style={isEditing ? { background: EDITING } : undefined}>
                  {columns.map((c) => (
                    <td key={c.key} className="rt-c" style={{ textAlign: c.align ?? 'left',
                                                              verticalAlign: 'middle',
                                                              borderBottom: isEditing ? 'none' : undefined }}>
                      {/* A column with no field of its own keeps showing its value while the
                          row is edited. Blanking it made half the record vanish exactly when
                          someone was trying to check it against what they were typing. */}
                      {isEditing && c.field
                        ? <span className="rt-field">{c.field(editDraft, (patch) => setEditDraft({ ...editDraft, ...patch }), row)}</span>
                        : (
                          /* A column of dates wears a calendar, so a date is recognisable as
                             one at a glance rather than by its shape. */
                          <span className={[
                            'rt-cell',
                            kindOf(c) === 'date' ? 'rt-date' : '',
                            // a sentence wraps; a value is read whole, on one line
                            wraps(c) ? 'rt-cell-wrap' : '',
                          ].filter(Boolean).join(' ')}>
                            {kindOf(c) === 'date' && <Icon name="calendar" size={12} motion="none" />}
                            <span>{c.cell ? c.cell(row) : String(c.value(row))}</span>
                          </span>
                        )}
                    </td>
                  ))}
                  {trailing && <td className="rt-c"
                                   style={{ borderBottom: isEditing ? 'none' : undefined }}>{trailing(row)}</td>}
                  {actions && (
                    <td className="rt-c"
                        style={{ borderBottom: isEditing ? 'none' : undefined }}>
                      {isEditing ? null : (
                        <RowActions
                          onEdit={editable && !cannotEdit
                            ? () => { setEditing(id); setEditDraft(edit!.draftOf(row)); } : undefined}
                          editBlocked={editable ? cannotEdit : undefined}
                          onRemove={removable && !cannotRemove
                            ? async () => {
                                const capability = typeof remove!.capability === 'function'
                                  ? remove!.capability(row) : remove!.capability;
                                const res = await run(capability, remove!.build(row));
                                if (!res.ok) setProblem(res.message ?? 'That was not removed.');
                                else remove!.onDone?.();
                              } : undefined}
                          removeBlocked={removable ? cannotRemove : undefined}
                          what={remove?.what(row) ?? 'this record'} />
                      )}
                    </td>
                  )}
                </tr>
                {!isEditing && detail?.(row) && (
                  <tr>
                    <td className="rt-c" colSpan={span} style={{ paddingTop: 0 }}>
                      {detail(row)}
                    </td>
                  </tr>
                )}
                {isEditing && (
                  <tr style={{ background: EDITING }}>
                    <td className="rt-c" colSpan={span}>
                      <Buttons busy={!!running}
                        confirm={{ label: 'Save', tone: 'go', icon: 'check', disabled: false,
                          onClick: async () => {
                            setProblem(null);
                            const capability = typeof edit!.capability === 'function'
                              ? edit!.capability(row, editDraft) : edit!.capability;
                            const res = await run(capability, edit!.build(editDraft, row));
                            if (res.ok) { closeEdit(); edit!.onDone?.(); }
                            else setProblem(res.message ?? 'That was not saved.');
                          } }}
                        cancel={closeEdit} />
                    </td>
                  </tr>
                )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * The two buttons that end an edit.
 *
 * On their own line under the row being written, rather than in a column of their own. Inside
 * a column they had to be either stacked, which made a pair of buttons unlike every other pair
 * in the application, or wide — and wide meant a column that grew the moment a row opened,
 * pushed the table past its panel, and left an empty pinned column beside every other row.
 */
function Buttons({ confirm, cancel, busy }: {
  /** `add` takes the theme's contrast, `go` is green: adding and saving are different acts */
  confirm: { label: string; tone: 'add' | 'go'; icon: IconName; disabled: boolean; onClick: () => void };
  cancel: () => void;
  busy: boolean;
}) {
  return (
    <span className="btn-pair" style={{ justifyContent: 'flex-start' }}>
      <button className={`btn ${confirm.tone} sm`} disabled={confirm.disabled || busy}
              onClick={confirm.onClick}>
        <Icon name={confirm.icon} size={13} motion="none" />
        {busy ? 'Saving…' : confirm.label}
      </button>
      <button className="btn ghost sm" onClick={cancel}>
        <Icon name="close" size={13} motion="none" /> Cancel
      </button>
    </span>
  );
}

/** Edit and remove, stacked in the same column width so nothing shifts between rows. */
function RowActions({ onEdit, onRemove, what, editBlocked, removeBlocked }: {
  onEdit?: () => void;
  onRemove?: () => void;
  what: string;
  editBlocked?: string;
  removeBlocked?: string;
}) {
  const [asking, setAsking] = useState(false);
  if (!onEdit && !onRemove && !editBlocked && !removeBlocked) return null;

  return (
    // the column reserves this width; asking for more than it reserved gave the whole table a
    // horizontal scrollbar and cut the last icon in half
    <span style={{ display: 'flex', gap: 6, width: '100%', justifyContent: 'flex-end' }}>
      {onEdit && (
        <button className="btn quiet" onClick={onEdit} aria-label={`Edit ${what}`} title="Edit"
                style={{ padding: 7, border: 'none' }}>
          <Icon name="edit" size={14} />
        </button>
      )}
      {editBlocked && !onEdit && (
        <span title={editBlocked} style={{ display: 'flex', padding: 7, color: 'var(--disabled)' }}>
          <Icon name="edit" size={14} motion="none" />
        </span>
      )}
      {onRemove && (
        <button className="btn quiet" onClick={() => setAsking(true)}
                aria-label={`Remove ${what}`} title="Remove"
                style={{ padding: 7, border: 'none', color: 'var(--negative)' }}>
          <Icon name="trash" size={14} />
        </button>
      )}
      {removeBlocked && !onRemove && (
        <span title={removeBlocked} style={{ display: 'flex', padding: 7, color: 'var(--disabled)' }}>
          <Icon name="trash" size={14} motion="none" />
        </span>
      )}

      {/* the question is asked over the page, not in the cell: two small buttons in a
          96-pixel column are answered by aim rather than by reading */}
      <ConfirmModal open={asking} onClose={() => setAsking(false)}
        title={`Remove ${what}?`}
        body="This cannot be undone from here."
        onConfirm={onRemove} />
    </span>
  );
}

/** One filter, drawn the way its column's data deserves. */
function FilterCell({ kind, label, value, onChange, choices }: {
  kind: FilterKind; label: string; value: FilterValue;
  onChange: (patch: FilterValue) => void; choices: string[];
}) {
  const box: React.CSSProperties = {
    fontSize: 11, padding: '5px 8px', width: '100%', font: 'inherit', fontWeight: 400,
    letterSpacing: 0, textTransform: 'none', color: 'var(--ink)',
  };

  if (kind === 'pick') {
    return <Select ariaLabel={`Filter by ${label}`} value={value.text ?? ''}
                   onChange={(v) => onChange({ text: v })}
                   options={[{ value: '', label: 'any' },
                             ...choices.map((c) => ({ value: c, label: c }))]} />;
  }
  if (kind === 'amount' || kind === 'money') {
    return (
      <span style={{ display: 'flex', gap: 5 }}>
        <input value={value.min ?? ''} aria-label={`Least ${label}`} placeholder="from"
               inputMode="decimal" style={{ ...box, width: '50%' }}
               onChange={(e) => onChange({ min: e.target.value })} />
        <input value={value.max ?? ''} aria-label={`Most ${label}`} placeholder="to"
               inputMode="decimal" style={{ ...box, width: '50%' }}
               onChange={(e) => onChange({ max: e.target.value })} />
      </span>
    );
  }
  // One above the other. Side by side, two calendars asked for a column twice as wide as the
  // dates underneath it, and every other column paid for it.
  if (kind === 'date') {
    return (
      <span className="rt-daterange">
        <DateField value={value.from ?? ''} ariaLabel={`${label} from`}
                   onChange={(v) => onChange({ from: v || undefined })} />
        <DateField value={value.to ?? ''} ariaLabel={`${label} to`} min={value.from}
                   onChange={(v) => onChange({ to: v || undefined })} />
      </span>
    );
  }
  return <input value={value.text ?? ''} aria-label={`Filter by ${label}`} placeholder="any"
                style={box} onChange={(e) => onChange({ text: e.target.value })} />;
}
