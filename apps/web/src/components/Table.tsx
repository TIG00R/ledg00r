import { useMemo, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { Select } from './Select';
import { DateField } from './DateField';

export type Dir = 'asc' | 'desc';

/**
 * Sorting a table of records.
 *
 * Every table in the app shows a list someone will eventually want ordered differently —
 * the biggest expense, the oldest lot, the position that has lost the most. The comparison
 * is per column rather than generic because the columns are not all the same kind of thing:
 * a date sorts as a string, an amount as a number, a category by its name.
 *
 * Ties keep their original order. JavaScript's sort is stable, so a second click on a
 * column does not reshuffle rows that compare equal — it only flips the direction.
 */
export function useSort<T>(rows: T[], columns: Record<string, (row: T) => string | number>, initial?: { key: string; dir: Dir }) {
  const [sort, setSort] = useState<{ key: string; dir: Dir } | null>(initial ?? null);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const pick = columns[sort.key];
    if (!pick) return rows;
    const sign = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = pick(a); const y = pick(b);
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * sign;
      return String(x).localeCompare(String(y)) * sign;
    });
  }, [rows, sort, columns]);

  /** clicking the active column flips it; clicking another starts that one descending */
  const toggle = (key: string) =>
    setSort((s) => (s?.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }));

  return { sorted, sort, toggle };
}

/** A column heading that sorts. Renders a plain heading when the column has no comparison. */
export function Th({ label, sortKey, sort, toggle, align }: {
  label: ReactNode;
  sortKey?: string;
  sort?: { key: string; dir: Dir } | null;
  toggle?: (key: string) => void;
  align?: 'left' | 'right';
}) {
  if (!sortKey || !toggle) return <th style={{ textAlign: align ?? 'left' }}>{label}</th>;
  const on = sort?.key === sortKey;
  return (
    <th style={{ textAlign: align ?? 'left', padding: 0 }}>
      <button onClick={() => toggle(sortKey)} aria-label={`Sort by ${typeof label === 'string' ? label : sortKey}`}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer',
          font: 'inherit', color: on ? 'var(--ink)' : 'inherit', padding: '10px 0',
          background: 'transparent', border: 'none', letterSpacing: 'inherit', textTransform: 'inherit',
        }}>
        {label}
        <span style={{ display: 'flex', opacity: on ? 1 : 0.28, transition: 'opacity 150ms var(--ease)' }}>
          <Icon name="chevron" size={11} motion="none"
                style={{ transform: on && sort!.dir === 'asc' ? 'rotate(-90deg)' : 'rotate(90deg)' }} />
        </span>
      </button>
    </th>
  );
}

/**
 * Filtering by column.
 *
 * A single search box across a whole table answers "where did I see that word" and nothing
 * else. Filtering the column itself answers the questions people actually have of a ledger —
 * everything on this account, everything in that category, everything over a hundred — so
 * each heading carries its own filter and they combine.
 *
 * A column of a few repeated values gets a picker of exactly those values; anything else
 * gets a text match. Which one is right follows from the data rather than being declared.
 */
export type FilterKind = 'pick' | 'text' | 'amount' | 'date';

/**
 * A column that filters itself.
 *
 * `kind` decides the control, and it follows from what the column holds rather than from
 * taste: a handful of repeated values is a list to choose from, an amount is a range with two
 * ends, a date is two calendars, and everything else is a match. Offering a dropdown of every
 * distinct amount — which is what happened before — is a list of one entry per row.
 */
export interface ColumnFilter<T> {
  key: string;
  value: (row: T) => string | number;
  label?: (row: T) => string;
  kind?: FilterKind;
}

export interface FilterValue { text?: string; min?: number; max?: number; from?: string; to?: string }

/** What a column holds decides how it is filtered, unless the caller says otherwise. */
function kindOf<T>(c: ColumnFilter<T>, rows: T[]): FilterKind {
  if (c.kind) return c.kind;
  const sample = rows[0] ? c.value(rows[0]) : '';
  if (typeof sample === 'number') return 'amount';
  if (typeof sample === 'string' && /^\d{4}-\d{2}-\d{2}/.test(sample)) return 'date';
  const seen = new Set<string>();
  for (const r of rows) { seen.add(String(c.value(r))); if (seen.size > 12) return 'text'; }
  return 'pick';
}

export function useFilters<T>(rows: T[], columns: ColumnFilter<T>[]) {
  const [active, setActive] = useState<Record<string, FilterValue>>({});

  const filtered = useMemo(() => rows.filter((row) => columns.every((c) => {
    const f = active[c.key];
    if (!f) return true;
    const has = c.value(row);

    if (f.min != null && Number(has) < f.min) return false;
    if (f.max != null && Number(has) > f.max) return false;
    if (f.from && String(has).slice(0, 10) < f.from) return false;
    if (f.to && String(has).slice(0, 10) > f.to) return false;
    if (f.text && !String(has).toLowerCase().includes(f.text.toLowerCase())) return false;
    return true;
  })), [rows, columns, active]);

  const choicesFor = (c: ColumnFilter<T>): string[] => {
    const seen = new Set<string>();
    for (const row of rows) {
      const v = c.label ? c.label(row) : String(c.value(row));
      if (v) seen.add(v);
      if (seen.size > 40) break;
    }
    return [...seen].sort();
  };

  return {
    filtered,
    active,
    any: Object.values(active).some((f) => f && (f.text || f.min != null || f.max != null || f.from || f.to)),
    set: (key: string, patch: FilterValue) =>
      setActive((a) => ({ ...a, [key]: { ...a[key], ...patch } })),
    clear: () => setActive({}),
    choicesFor,
    kindOf: (c: ColumnFilter<T>) => kindOf(c, rows),
  };
}

/** A heading that sorts, with the column's own filter beneath it. */
export function FilterTh<T>({ label, sortKey, sort, toggle, align, filter, filters }: {
  label: string;
  sortKey?: string;
  sort?: { key: string; dir: Dir } | null;
  toggle?: (key: string) => void;
  align?: 'left' | 'right';
  filter?: ColumnFilter<T>;
  filters?: ReturnType<typeof useFilters<T>>;
}) {
  const kind = filter && filters ? filters.kindOf(filter) : 'text';
  const f = filter && filters ? filters.active[filter.key] ?? {} : {};
  const set = (patch: FilterValue) => filter && filters?.set(filter.key, patch);
  const small: React.CSSProperties = {
    fontSize: 11, padding: '4px 6px', font: 'inherit', fontWeight: 400,
    letterSpacing: 0, textTransform: 'none', width: '100%',
  };

  return (
    <th style={{ textAlign: align ?? 'left', padding: '0 18px 8px 0', verticalAlign: 'top' }}>
      {sortKey && toggle ? (
        <button onClick={() => toggle(sortKey)} aria-label={`Sort by ${label}`}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer',
                   font: 'inherit', color: sort?.key === sortKey ? 'var(--ink)' : 'inherit',
                   padding: '10px 0 6px', background: 'transparent', border: 'none',
                   letterSpacing: 'inherit', textTransform: 'inherit' }}>
          {label}
          <span style={{ display: 'flex', opacity: sort?.key === sortKey ? 1 : 0.28 }}>
            <Icon name="chevron" size={11} motion="none"
                  style={{ transform: sort?.key === sortKey && sort.dir === 'asc' ? 'rotate(-90deg)' : 'rotate(90deg)' }} />
          </span>
        </button>
      ) : (
        <span style={{ display: 'inline-block', padding: '10px 0 6px' }}>{label}</span>
      )}

      {filter && filters && kind === 'pick' && (
        <Select ariaLabel={`Filter by ${label}`} value={f.text ?? ''}
                onChange={(v) => set({ text: v })}
                options={[{ value: '', label: 'any' },
                          ...filters.choicesFor(filter).map((c) => ({ value: c, label: c }))]} />
      )}

      {filter && filters && kind === 'text' && (
        <input value={f.text ?? ''} aria-label={`Filter by ${label}`} placeholder="any"
               onChange={(e) => set({ text: e.target.value })} style={small} />
      )}

      {/* An amount is a range with two ends, not a list of every figure in the column. */}
      {filter && filters && kind === 'amount' && (
        <span style={{ display: 'flex', gap: 4 }}>
          <input value={f.min ?? ''} aria-label={`Least ${label}`} placeholder="from"
                 inputMode="decimal" style={{ ...small, width: '50%' }}
                 onChange={(e) => set({ min: e.target.value === '' ? undefined : Number(e.target.value) })} />
          <input value={f.max ?? ''} aria-label={`Most ${label}`} placeholder="to"
                 inputMode="decimal" style={{ ...small, width: '50%' }}
                 onChange={(e) => set({ max: e.target.value === '' ? undefined : Number(e.target.value) })} />
        </span>
      )}

      {/* A date range is two calendars, because typing one is what a calendar is for. */}
      {filter && filters && kind === 'date' && (
        <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <DateField value={f.from ?? ''} ariaLabel={`${label} from`}
                     onChange={(v) => set({ from: v || undefined })} />
          <DateField value={f.to ?? ''} ariaLabel={`${label} to`} min={f.from}
                     onChange={(v) => set({ to: v || undefined })} />
        </span>
      )}
    </th>
  );
}

/** The search box every list of records gets. */
export function Search({ value, onChange, placeholder, label }: {
  value: string; onChange: (v: string) => void; placeholder: string; label: string;
}) {
  return (
    <span style={{ position: 'relative', display: 'flex', flex: 1, minWidth: 180 }}>
      <span style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)',
                     display: 'flex', color: 'var(--faint)', pointerEvents: 'none' }}>
        <Icon name="search" size={14} motion="none" />
      </span>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={label}
             style={{ flex: 1, paddingLeft: 33 }} />
      {value && (
        <button onClick={() => onChange('')} aria-label="Clear the search"
          style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                   display: 'flex', padding: 3, cursor: 'pointer', color: 'var(--faint)',
                   background: 'transparent', border: 'none' }}>
          <Icon name="close" size={13} motion="none" />
        </button>
      )}
    </span>
  );
}
