import { Fragment, useMemo, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { Select, type Option } from './Select';
import { DateField } from './DateField';
import { Empty } from './UI';
import { ConfirmModal } from './Confirm';
import { ClearAll } from './ClearAll';
import { useLive } from '../Live';

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
 *
 * Opening a row used to need a screen-wide switch first: flip to Edit, and every table on the
 * screen turned into a row of pencils at once, whether or not there was anything on the other
 * two worth touching. That put a decision about the whole screen in front of a much smaller
 * one — "I want to fix this row" — and a table with nothing to correct had no way to say so
 * except by having no pencils either.
 *
 * A row opens the way a folder opens: you point at the one you want. Double-clicking it and
 * pressing Enter with it focused are the two ways that always work. A third — a pencil at the
 * end of the row — used to stand there permanently, whether or not the row beside it was ever
 * going to be touched: a page of a hundred rows was a page of a hundred pencils, furniture
 * nobody asked for on ninety-nine of them. It exists again, the same button, the moment the
 * row is pointed at or landed on with Tab — hovering or focusing is the one thing a mouse or a
 * keyboard has already done to say which row is meant, so that is when the hint earns its
 * place (`.rt-hint`, below). It stays in reach of a screen reader the whole time; only the
 * paint waits for that moment.
 *
 * Duplicating and removing move further still. They used to sit beside the pencil at rest
 * too, which put a bin within an idle mouse's reach on every row in the table. Now they wait
 * for the row to actually be open, on the line under it beside Save and Cancel — reaching
 * either takes the same deliberate step as reaching Save.
 *
 * A row that cannot be corrected, duplicated or removed at all (every one of `edit`,
 * `duplicate` and `remove` either absent or `blocked` for it) answers none of the three
 * gestures and stays flat text. One that can do at least one of them opens on any of the
 * three; what it shows once open follows from which of those it can actually do, not from
 * which the table merely offers — a movement with more than one leg cannot be corrected in
 * place but can still be undone, so it opens read-only with a working bin rather than not
 * opening at all. Only one row is ever open, because two half-finished corrections have no
 * way to say which Save belongs to which.
 */
/**
 * A double-click or an Enter meant for the row should not steal a click already meant for
 * something inside it — a filter's own input, a link, a button on a `detail` line. Without
 * this, double-clicking to select a word in a note field opened the row out from under the
 * selection instead of selecting the word.
 */
export function isInteractive(el: EventTarget | null): boolean {
  return !!(el instanceof HTMLElement) && !!el.closest('input, textarea, select, button, a, [contenteditable="true"]');
}
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
   *
   * A plain string is both what is matched and what is shown. An option says more about the
   * same choice — a bank over the account under it, with the bank's mark beside them — which
   * is what a column of accounts needs: the filter over the log reads like the picker that
   * wrote the rows, rather than like a list of bare names. Its `value` is still the text the
   * column holds, because that is what the filter matches against.
   */
  choices?: Array<string | Option>;
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
  /**
   * Copying a row, values and all, so it is ready to edit rather than typed in again.
   *
   * A row's own capability is whatever adds one — the same one `add` uses — so a duplicate is
   * indistinguishable from a row someone typed in by hand, and the plan cannot tell the
   * difference between a payment copied and one entered fresh.
   */
  duplicate?: {
    capability: string | ((row: T) => string);
    build: (row: T) => unknown;
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
    /**
     * The other answer to the bin, for a record that moved money.
     *
     * Removing one usually means putting the money back: the movement behind it is reversed,
     * the balance returns, and the log keeps both halves. That is right when the spending
     * never happened — and wrong when it did and only the record of it is a duplicate, since
     * reversing then invents money that was really spent. So the question offers both: take
     * the record off and put the money back, or take the record off and leave what it moved
     * exactly where it is.
     *
     * Absent on anything that moved nothing, where there is only one thing removal can mean.
     */
    keep?: { label: string; build: (row: T) => unknown; body?: string };
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
  rows, columns, rowKey, sort: initialSort, empty, add, edit, duplicate, remove, clear, trailing, detail,
  trailingWidth = '96px',
}: RecordTableProps<T>) {
  const { run, running } = useLive();
  /**
   * How a log opens, when the screen has not said.
   *
   * Every log in this application is read newest first — what happened today is what is
   * being looked for, and what happened two years ago is what is being scrolled to. A table
   * left to its own devices used to open in whatever order its rows arrived, which for most
   * of them is oldest first. With no order stated, the first column of dates decides it, the
   * latest at the top; a screen that wants another order still says so and is obeyed.
   */
  const byDate = columns.find((c) => c.kind === 'date');
  const [sort, setSort] = useState<Dir | null>(
    initialSort ?? (byDate ? { key: byDate.key, dir: 'desc' } : null));
  const [filters, setFilters] = useState<Record<string, FilterValue>>({});
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Record<string, any>>(add?.blank ?? {});
  const [editing, setEditing] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Record<string, any>>({});
  const [problem, setProblem] = useState<string | null>(null);

  const editable = !!edit;
  const duplicable = !!duplicate;
  const removable = !!remove;
  /**
   * Emptying the log is offered whenever there is a log to empty — the same as the bin on a
   * row that is not blocked — and both ask before they take anything, through their own
   * confirmation. Neither waits on a screen-wide switch any more.
   */
  const clearable = !!clear;
  /**
   * The last column exists for one thing now: the hint that a row can be opened at all.
   *
   * Duplicating and removing used to live here too, as icons standing beside the pencil on
   * every row whether or not anyone was about to touch it. They moved onto the line under an
   * open row, next to Save and Cancel, so this column holds nothing but the pencil — and only
   * while hovering or focus makes it worth showing.
   */
  const actions = editable || duplicable || removable;
  /**
   * How much room the last column needs.
   *
   * One icon, and that is all it ever holds now — Save, Cancel, Duplicate and Remove all sit
   * on their own line under the row being written, so this column's width no longer answers
   * to how many of those a table offers.
   */
  const actionsWidth = 40;

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
                          ? (c.choices ?? [...new Set(rows.map((r) => String(c.value(r))).filter(Boolean))].sort())
                              .map((x) => (typeof x === 'string' ? { value: x, label: x } : x))
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
              const cannotDuplicate = duplicate?.blocked?.(row);
              const cannotRemove = remove?.blocked?.(row);
              /** whether editing, duplicating or removing this row is actually on offer */
              const canEditRow = editable && !cannotEdit;
              const canDuplicateRow = duplicable && !cannotDuplicate;
              const canRemoveRow = removable && !cannotRemove;
              /**
               * Whether this particular row answers to the double-click/Enter/pencil gesture.
               *
               * Edit being blocked is not the same as there being nothing to open for — see
               * the file comment above. A row with nothing unblocked on it has nothing an
               * open would show, so it stays flat text instead.
               */
              const openable = (canEditRow || canDuplicateRow || canRemoveRow) && !isEditing;
              const what = remove?.what(row) ?? 'this record';
              const open = () => { setProblem(null); setEditing(id); setEditDraft(edit ? edit.draftOf(row) : {}); };
              return (
                <Fragment key={id}>
                <tr style={isEditing ? { background: EDITING, cursor: undefined }
                                     : { cursor: openable ? 'pointer' : undefined }}
                    tabIndex={openable ? 0 : undefined}
                    aria-label={openable
                      ? `Double-click, or press Enter, to ${canEditRow ? 'edit' : 'open'} this row`
                      : undefined}
                    onDoubleClick={openable ? (e: MouseEvent<HTMLTableRowElement>) => {
                      if (isInteractive(e.target)) return;
                      open();
                    } : undefined}
                    onKeyDown={openable ? (e: KeyboardEvent<HTMLTableRowElement>) => {
                      if (e.key !== 'Enter' || isInteractive(e.target)) return;
                      e.preventDefault();
                      open();
                    } : undefined}>
                  {columns.map((c) => (
                    <td key={c.key} className="rt-c" style={{ textAlign: c.align ?? 'left',
                                                              verticalAlign: 'middle',
                                                              borderBottom: isEditing ? 'none' : undefined }}>
                      {/* A column with no field of its own keeps showing its value while the
                          row is edited. Blanking it made half the record vanish exactly when
                          someone was trying to check it against what they were typing. A row
                          open only to duplicate or remove it, not to correct it, shows the
                          same read-only value throughout — there is nothing to type into. */}
                      {isEditing && canEditRow && c.field
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
                      {/* At rest this cell paints nothing. `.rt-hint` (in tokens.css) is what
                          keeps the button invisible until the row is hovered or landed on
                          with Tab — a screen reader hears it regardless, since opacity says
                          nothing to the accessibility tree, only to the eye. */}
                      {!isEditing && openable && (
                        <button className="btn quiet rt-hint" onClick={open} tabIndex={-1}
                                aria-label={`${canEditRow ? 'Edit' : 'Open'} ${what}`}
                                title={canEditRow ? 'Edit' : 'Open'}
                                style={{ padding: 7, border: 'none' }}>
                          <Icon name="edit" size={14} />
                        </button>
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
                      <Buttons busy={!!running} what={what}
                        confirm={canEditRow ? { label: 'Save', tone: 'go', icon: 'check', disabled: false,
                          onClick: async () => {
                            setProblem(null);
                            const capability = typeof edit!.capability === 'function'
                              ? edit!.capability(row, editDraft) : edit!.capability;
                            const res = await run(capability, edit!.build(editDraft, row));
                            if (res.ok) { closeEdit(); edit!.onDone?.(); }
                            else setProblem(res.message ?? 'That was not saved.');
                          } } : undefined}
                        note={!canEditRow ? cannotEdit : undefined}
                        cancel={closeEdit}
                        duplicate={duplicable ? {
                          onClick: canDuplicateRow ? async () => {
                            setProblem(null);
                            const capability = typeof duplicate!.capability === 'function'
                              ? duplicate!.capability(row) : duplicate!.capability;
                            const res = await run(capability, duplicate!.build(row));
                            if (!res.ok) setProblem(res.message ?? 'That was not duplicated.');
                            else { closeEdit(); duplicate!.onDone?.(); }
                          } : undefined,
                          blocked: cannotDuplicate,
                        } : undefined}
                        remove={removable ? {
                          onClick: canRemoveRow ? async () => {
                            const capability = typeof remove!.capability === 'function'
                              ? remove!.capability(row) : remove!.capability;
                            const res = await run(capability, remove!.build(row));
                            if (!res.ok) setProblem(res.message ?? 'That was not removed.');
                            else { closeEdit(); remove!.onDone?.(); }
                          } : undefined,
                          blocked: cannotRemove,
                          keep: remove!.keep && canRemoveRow ? {
                            label: remove!.keep.label,
                            body: remove!.keep.body,
                            onClick: async () => {
                              const capability = typeof remove!.capability === 'function'
                                ? remove!.capability(row) : remove!.capability;
                              const res = await run(capability, remove!.keep!.build(row));
                              if (!res.ok) setProblem(res.message ?? 'That was not removed.');
                              else { closeEdit(); remove!.onDone?.(); }
                            },
                          } : undefined,
                        } : undefined} />
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
 * The line under a row being added, corrected, duplicated or removed.
 *
 * Save (or Add) and Cancel come first, in that order, the same pair everywhere in the
 * application. Duplicate and Remove — where the row is open enough to offer them — sit apart
 * from that pair rather than beside it, pushed to the far end of the same line: a bin never
 * shares a corner with Save, and a stray click aimed at finishing an edit does not land on
 * the one action that cannot be undone.
 *
 * `confirm` is absent for a row that is open only for its bin or its duplicate, not for
 * correction — a movement with more than one leg, say — and `note` says why in its place.
 */
function Buttons({ confirm, cancel, busy, note, duplicate, remove, what }: {
  /** `add` takes the theme's contrast, `go` is green: adding and saving are different acts */
  confirm?: { label: string; tone: 'add' | 'go'; icon: IconName; disabled: boolean; onClick: () => void };
  cancel: () => void;
  busy: boolean;
  /** why this row has no Save to press, shown in its place */
  note?: string;
  /** offered once the row is open, subordinate to Save and Cancel */
  duplicate?: { onClick?: () => void; blocked?: string };
  remove?: {
    onClick?: () => void; blocked?: string;
    /** the second answer: the record goes and what it moved stays */
    keep?: { label: string; body?: string; onClick: () => void };
  };
  /** what the row is — for Duplicate and Remove's own labels, and the question Remove asks */
  what?: string;
}) {
  const [asking, setAsking] = useState(false);
  const named = what ?? 'this record';
  return (
    <span className="btn-pair" style={{ justifyContent: 'flex-start' }}>
      {confirm ? (
        <button className={`btn ${confirm.tone} sm`} disabled={confirm.disabled || busy}
                onClick={confirm.onClick}>
          <Icon name={confirm.icon} size={13} motion="none" />
          {busy ? 'Saving…' : confirm.label}
        </button>
      ) : note && <span style={{ fontSize: 12, color: 'var(--faint)' }}>{note}</span>}
      <button className="btn ghost sm" onClick={cancel}>
        <Icon name="close" size={13} motion="none" /> Cancel
      </button>

      {(duplicate || remove) && (
        <span style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
          {duplicate && (duplicate.onClick ? (
            <button className="btn quiet sm" onClick={duplicate.onClick}
                    aria-label={`Duplicate ${named}`} title="Duplicate">
              <Icon name="duplicate" size={13} motion="none" /> Duplicate
            </button>
          ) : (
            <span title={duplicate.blocked} style={{ display: 'flex', alignItems: 'center', gap: 6,
                                                       padding: '0 8px', fontSize: 12, color: 'var(--disabled)' }}>
              <Icon name="duplicate" size={13} motion="none" /> Duplicate
            </span>
          ))}
          {remove && (remove.onClick ? (
            <button className="btn quiet sm" onClick={() => setAsking(true)}
                    aria-label={`Remove ${named}`} title="Remove" style={{ color: 'var(--negative)' }}>
              <Icon name="trash" size={13} motion="none" /> Remove
            </button>
          ) : (
            <span title={remove.blocked} style={{ display: 'flex', alignItems: 'center', gap: 6,
                                                    padding: '0 8px', fontSize: 12, color: 'var(--disabled)' }}>
              <Icon name="trash" size={13} motion="none" /> Remove
            </span>
          ))}
        </span>
      )}

      {/* the question is asked over the page, not on this line: a bin beside Save and Cancel
          is answered by aim rather than by reading */}
      {remove && (
        <ConfirmModal open={asking} onClose={() => setAsking(false)}
          title={`Remove ${named}?`}
          body={remove.keep
            ? (remove.keep.body
              ?? 'Removing it puts the money back where it came from. If the money really did move and only this record is wrong, take the record off and leave the movement standing.')
            : 'This cannot be undone from here.'}
          confirmLabel={remove.keep ? 'Remove and put the money back' : 'Remove'}
          onConfirm={remove.onClick}
          alternative={remove.keep
            ? { label: remove.keep.label, onPick: () => { setAsking(false); remove.keep!.onClick(); } }
            : undefined} />
      )}
    </span>
  );
}

/** One filter, drawn the way its column's data deserves. */
function FilterCell({ kind, label, value, onChange, choices }: {
  kind: FilterKind; label: string; value: FilterValue;
  onChange: (patch: FilterValue) => void; choices: Option[];
}) {
  const box: React.CSSProperties = {
    fontSize: 11, padding: '5px 8px', width: '100%', font: 'inherit', fontWeight: 400,
    letterSpacing: 0, textTransform: 'none', color: 'var(--ink)',
  };

  if (kind === 'pick') {
    return <Select ariaLabel={`Filter by ${label}`} value={value.text ?? ''}
                   onChange={(v) => onChange({ text: v })}
                   options={[{ value: '', label: 'any' }, ...choices]} />;
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
