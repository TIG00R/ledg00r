import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';

/**
 * The question every removal asks.
 *
 * It is a modal over the page rather than a note beside the button. A removal is the one
 * gesture in this application that cannot be taken back from the screen it was made on, and
 * a panel tucked under a small icon was answerable — dismissed, even — without being read.
 * Over the page it has to be answered: Escape and the backdrop keep, the button removes, and
 * focus starts on Keep so a stray Return does nothing.
 */
export function ConfirmModal({ open, title, body, confirmLabel = 'Remove', onConfirm, onClose,
                              alternative, choices, choiceLabel }: {
  open: boolean;
  title: ReactNode;
  body?: ReactNode;
  confirmLabel?: string;
  /**
   * What the button does, given the answer picked below it.
   *
   * Absent when the thing cannot be removed at all; then the dialog only explains. With
   * `choices` it is handed the value that was chosen, and it is not reachable until one has
   * been.
   */
  onConfirm?: (choice?: string) => void;
  onClose: () => void;
  /** offered instead of removal — archiving, most often */
  alternative?: { label: string; onPick: () => void };
  /**
   * The answers a removal needs before it can be made, where there is more than one.
   *
   * Two buttons that both removed — one reversing the money, one leaving it — were a choice
   * made by aiming: they sat side by side, said different things, and the more dangerous of
   * them was the one styled to be pressed. Asked as a group under one button instead, the
   * answer has to be given before the button exists to press, and which answer was given is
   * on screen while it is pressed.
   */
  choices?: Array<{ value: string; label: string; hint?: string }>;
  /** what the group is asking, over the options */
  choiceLabel?: string;
}) {
  const keep = useRef<HTMLButtonElement>(null);
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', esc, true);
    // the page behind must not scroll under the question
    const had = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    keep.current?.focus();
    return () => { document.removeEventListener('keydown', esc, true); document.body.style.overflow = had; };
  }, [open, onClose]);

  // A question asked again starts unanswered. Carrying the last answer over would mean a
  // second removal could be finished in one press, which is the thing the group exists to
  // prevent.
  useEffect(() => { if (!open) setPicked(null); }, [open]);

  if (!open) return null;

  /** nothing to press until the group has been answered */
  const blockedByChoice = !!choices?.length && picked === null;

  return createPortal((
    <div role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 900, display: 'flex',
        alignItems: 'center', justifyContent: 'center', padding: 20,
        background: 'color-mix(in srgb, #000 46%, transparent)',
        backdropFilter: 'blur(2px)',
      }}>
      <div role="alertdialog" aria-modal="true" aria-label={typeof title === 'string' ? title : 'Confirm'}
        style={{
          width: 'min(420px, 100%)', padding: 22, borderRadius: 'var(--r-card)',
          background: 'var(--surface)', border: '1px solid var(--hairline-strong)',
          boxShadow: 'var(--shadow-lg)',
        }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
                         width: 34, height: 34, borderRadius: 10, flex: '0 0 34px',
                         background: `color-mix(in srgb, var(--${onConfirm ? 'negative' : 'gold'}) 13%, transparent)` }}>
            <Icon name={onConfirm ? 'trash' : 'warn'} size={16}
                  color={`var(--${onConfirm ? 'negative' : 'gold'})`} motion="none" />
          </span>
          <div style={{ minWidth: 0 }}>
            <p style={{ margin: 0, fontSize: 14, fontWeight: 600, lineHeight: 1.4 }}>{title}</p>
            {body && (
              <p style={{ margin: '6px 0 0', fontSize: 12, lineHeight: 1.55, color: 'var(--muted)' }}>{body}</p>
            )}
          </div>
        </div>

        {onConfirm && !!choices?.length && (
          <div role="radiogroup" aria-label={choiceLabel ?? 'What this removal should do'}
               style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 7 }}>
            <p className="ov" style={{ margin: 0 }}>{choiceLabel ?? 'Choose one to continue'}</p>
            {choices.map((c) => {
              const on = picked === c.value;
              return (
                <button key={c.value} type="button" role="radio" aria-checked={on}
                        onClick={() => setPicked(c.value)}
                        style={{
                          display: 'flex', alignItems: 'flex-start', gap: 9, width: '100%',
                          padding: '9px 11px', textAlign: 'left', cursor: 'pointer',
                          font: 'inherit', fontSize: 13, color: 'var(--ink)',
                          borderRadius: 'var(--r-sm)',
                          border: `1px solid ${on ? 'var(--accent)' : 'var(--control-border)'}`,
                          background: on
                            ? 'color-mix(in srgb, var(--accent) 10%, var(--control))'
                            : 'var(--control)',
                        }}>
                  {/* the tick itself: a box that is empty until this is the answer */}
                  <span aria-hidden="true" style={{
                    flex: '0 0 16px', width: 16, height: 16, marginTop: 1, borderRadius: 5,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    border: `1px solid ${on ? 'var(--accent)' : 'var(--control-border)'}`,
                    background: on ? 'var(--accent)' : 'transparent',
                  }}>
                    {on && <Icon name="check" size={11} color="var(--accent-ink)" motion="none" />}
                  </span>
                  <span style={{ minWidth: 0 }}>
                    {/* the answer is one line, like every other label in the application; the
                        sentence under it is prose and wraps as prose */}
                    <span style={{ display: 'block', whiteSpace: 'nowrap', overflow: 'hidden',
                                   textOverflow: 'ellipsis' }}>{c.label}</span>
                    {c.hint && (
                      <span style={{ display: 'block', marginTop: 2, fontSize: 11.5,
                                     lineHeight: 1.5, color: 'var(--muted)' }}>{c.hint}</span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        <div style={{ display: 'flex', gap: 9, marginTop: 20, justifyContent: 'flex-end' }}>
          <button ref={keep} className="btn ghost" onClick={onClose}
                  style={{ padding: '8px 14px', fontSize: 13 }}>
            {onConfirm ? 'Keep' : 'Close'}
          </button>
          {alternative && (
            <button className="btn add" onClick={() => { alternative.onPick(); onClose(); }}
                    style={{ padding: '8px 14px', fontSize: 13 }}>
              <Icon name="download" size={13} motion="none" /> {alternative.label}
            </button>
          )}
          {onConfirm && (
            <button className="btn danger" disabled={blockedByChoice}
                    title={blockedByChoice ? 'Choose what should happen to the money first' : undefined}
                    onClick={() => { onConfirm(picked ?? undefined); onClose(); }}
                    style={{ padding: '8px 14px', fontSize: 13 }}>
              <Icon name="trash" size={13} motion="none" /> {confirmLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  ), document.body);
}

/**
 * Deleting asks first.
 *
 * The trigger is the small button on the row; the question itself is the modal above, so a
 * removal cannot be started and finished without reading what it removes. `blocked` covers
 * the case the ledger cares about most: a thing with movements against it cannot be removed,
 * because that would rewrite what already happened. The button still exists, and it explains
 * itself — offering to archive instead, where archiving is the honest answer.
 */
export function ConfirmDelete({ what, onConfirm, blocked, size = 15, onArchive, className }: {
  what: string;
  onConfirm?: () => void;
  /** a reason, when the thing cannot be deleted at all */
  blocked?: string;
  size?: number;
  /**
   * Offered beside deletion, where archiving is a real answer.
   *
   * Shown whether or not the thing is blocked. Most of the time the screen cannot know in
   * advance whether a row has records behind it — that is the ledger's question, not the
   * interface's — so offering the gentler answer next to the permanent one is better than
   * letting someone press the permanent one, be refused, and have nowhere to go.
   */
  onArchive?: () => void;
  /** extra classes on the trigger — `rt-hint`, to keep it hidden until the row is pointed at */
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button ref={trigger} className={`btn quiet${className ? ` ${className}` : ''}`} style={{ padding: 6, border: 'none' }}
              aria-label={`Remove ${what}`} aria-haspopup="dialog" aria-expanded={open}
              onClick={() => setOpen(true)}>
        <Icon name="close" size={size} />
      </button>
      <ConfirmModal open={open}
        onClose={() => { setOpen(false); trigger.current?.focus(); }}
        title={blocked ? `${what} cannot be removed` : `Remove ${what}?`}
        body={blocked ?? 'This cannot be undone from here.'}
        onConfirm={blocked ? undefined : onConfirm}
        alternative={onArchive ? { label: 'Archive instead', onPick: onArchive } : undefined} />
    </>
  );
}

/** A panel that closes on Escape and on a click outside it. Used by the inline pickers. */
export function Dismissable({ onClose, children, label }: {
  onClose: () => void; children: ReactNode; label: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [onClose]);
  return <div ref={box} role="group" aria-label={label}>{children}</div>;
}
