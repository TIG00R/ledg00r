import { useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { useLive } from '../Live';

/**
 * Adding a record where the records are.
 *
 * A form beside the table asks you to look in one place and read the result in another, and
 * to keep a mental note of which row you were comparing against. A row at the top of the
 * table does not: the fields sit under the headings that name them, and what you are adding
 * appears where it will live.
 *
 * Add opens the row, Cancel closes it, and nothing else happens in between.
 */
export function AddRow({ columns, fields, label, capability, build, valid, onDone, span }: {
  /** how many columns the table has, so the open row spans all of them */
  columns: number;
  /** one cell per column; the first is usually the date */
  fields: (draft: Record<string, any>, set: (patch: Record<string, any>) => void) => ReactNode[];
  label: string;
  capability: string;
  build: (draft: Record<string, any>) => unknown;
  valid: (draft: Record<string, any>) => boolean;
  onDone?: () => void;
  /** what the draft starts as */
  span?: Record<string, any>;
}) {
  const { run, running } = useLive();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, any>>(span ?? {});
  const [problem, setProblem] = useState<string | null>(null);

  const close = () => { setOpen(false); setDraft(span ?? {}); setProblem(null); };

  if (!open) {
    return (
      <tr>
        <td colSpan={columns} style={{ padding: '10px 0' }}>
          <button className="btn ghost" onClick={() => setOpen(true)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12,
                     padding: '7px 13px' }}>
            <Icon name="plus" size={14} /> {label}
          </button>
        </td>
      </tr>
    );
  }

  const cells = fields(draft, (patch) => setDraft({ ...draft, ...patch }));

  return (
    <>
      <tr style={{ background: 'color-mix(in srgb, var(--positive) 6%, transparent)' }}>
        {cells.map((cell, i) => (
          <td key={i} style={{ padding: '10px 18px 10px 0', verticalAlign: 'middle' }}>{cell}</td>
        ))}
        <td style={{ textAlign: 'right', padding: '10px 0', whiteSpace: 'nowrap' }}>
          <button className="btn add sm" disabled={!valid(draft) || !!running}
            style={{ marginRight: 6 }}
            onClick={async () => {
              setProblem(null);
              const res = await run(capability, build(draft));
              if (res.ok) { close(); onDone?.(); }
              else setProblem(res.message ?? 'That was not recorded.');
            }}>
            <Icon name="plus" size={13} motion="none" /> {running ? 'Adding…' : 'Add'}
          </button>
          <button className="btn ghost sm" onClick={close}>
            <Icon name="close" size={13} motion="none" /> Cancel
          </button>
        </td>
      </tr>
      {problem && (
        <tr>
          <td colSpan={columns + 1} style={{ padding: '0 0 10px' }}>
            <span style={{ fontSize: 12, color: 'var(--negative)' }}>{problem}</span>
          </td>
        </tr>
      )}
    </>
  );
}
