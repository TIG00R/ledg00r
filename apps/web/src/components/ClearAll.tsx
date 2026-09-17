import { useState } from 'react';
import { Icon } from './Icon';
import { ConfirmModal } from './Confirm';
import { useLive } from '../Live';

/**
 * Emptying a whole log.
 *
 * Removing one record is a correction and reads like one: the movement behind it is reversed
 * and the log keeps both rows. This is the other gesture — everything in this table should be
 * gone — and it erases, because a clear that left two hundred reversals behind would not have
 * cleared anything.
 *
 * Which is why it is written once, here, rather than per screen: the two are easily confused,
 * the difference is the whole point, and the sentence that explains it should be the same
 * sentence everywhere it is read. The button says how many rows it is about to take, and the
 * dialog says it again with what they are, because a count is the one thing that tells you
 * whether you are looking at the table you think you are.
 */
export function ClearAll({ log, what, count, onDone, label = 'Clear all', capability, input }: {
  /** which log, as `records.clear` names it */
  log?: string;
  /** what it holds, in a phrase: 'every expense recorded, and the movements behind them' */
  what: string;
  /** how many rows are about to go; nothing is offered when there are none */
  count: number;
  onDone?: () => void;
  label?: string;
  /** for the one that clears every log at once */
  capability?: string;
  input?: unknown;
}) {
  const { run, running } = useLive();
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const cap = capability ?? 'records.clear';
  const busy = running === cap;

  if (count === 0) return null;

  return (
    <>
      <button className="btn quiet sm" onClick={() => setAsking(true)} disabled={busy}
              aria-label={`${label} — ${count} row${count === 1 ? '' : 's'}`}
              style={{ color: 'var(--negative)', whiteSpace: 'nowrap',
                       borderColor: 'color-mix(in srgb, var(--negative) 30%, transparent)' }}>
        <Icon name="trash" size={13} motion="none" />
        {busy ? 'Clearing…' : `${label} · ${count}`}
      </button>

      {problem && (
        <span style={{ fontSize: 12, color: 'var(--negative)', marginLeft: 8 }}>{problem}</span>
      )}

      <ConfirmModal open={asking} onClose={() => setAsking(false)}
        title={`Clear all ${count} row${count === 1 ? '' : 's'}?`}
        confirmLabel="Clear them"
        body={`This erases ${what}. It is not a correction and nothing is reversed — the rows are gone, and the balances fall back to what their accounts opened with. There is no undo.`}
        onConfirm={async () => {
          setProblem(null);
          const res = await run(cap, input ?? { log, confirm: true });
          if (res.ok) onDone?.();
          else setProblem(res.message ?? 'Nothing was cleared.');
        }} />
    </>
  );
}
