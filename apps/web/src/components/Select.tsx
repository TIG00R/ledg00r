import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';

export interface Option { value: string; label: string; hint?: string }

/** how far the list sits from its trigger, how close it may come to the window edge */
const GAP = 6;
const EDGE = 8;
const MAX_LIST = 268;
/** a list narrower than this cannot hold an option and the line under it */
const MIN_LIST = 176;

/**
 * The application's own dropdown.
 *
 * A native select paints its list with the operating system's palette, which on the dark
 * theme means a white sheet dropped over a dark page, in a different type at a different
 * size. This one is part of the app: same surface, same type, same corner radius, and it
 * can show a second line per option where that helps — an account's bank, a category's
 * meaning.
 *
 * Keyboard behaviour matches what people expect of a listbox: up and down move, Enter and
 * Space choose, Escape closes, Home and End jump, and focus returns to the trigger.
 *
 * The list is drawn into the body rather than beside the trigger. An absolutely positioned
 * list is clipped by the nearest ancestor that hides its overflow — the institution card on
 * the accounts screen does exactly that, to keep its rows inside its rounded corners — and a
 * clipped dropdown reads as a panel embedded in the card rather than one floating over it.
 * Drawn into the body it is measured against the viewport, follows the trigger while the
 * page scrolls, and opens upwards when there is more room above than below.
 */
export function Select({ value, options, onChange, ariaLabel, style, disabled }: {
  value: string;
  options: Option[];
  onChange?: (v: string) => void;
  ariaLabel: string;
  style?: React.CSSProperties;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(() => Math.max(0, options.findIndex((o) => o.value === value)));
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const list = useRef<HTMLUListElement>(null);
  /**
   * What the trigger shows, when nothing offered matches what is held.
   *
   * An empty value showing the first option is a starting point nobody has chosen yet — every
   * blank draft in this application relies on exactly that, and it is what "does not choose it"
   * means in the comments beside those drafts. A row being corrected is a different case: it
   * already names something real, by id, and if that id is missing from what is offered — the
   * option list was drawn too narrow, or the thing it names has since been archived — showing
   * the first option in its place is not a starting point, it is a different answer wearing the
   * one that was actually recorded. Saving without noticing would rewrite the record to name
   * whatever happened to be listed first.
   *
   * So only a genuinely empty value falls back to the first option. Anything else that fails to
   * match says so instead of guessing.
   */
  const chosen = options.find((o) => o.value === value) ?? (value ? undefined : options[0]);
  /** a real value that named nothing offered, rather than a draft that has simply not chosen yet */
  const unresolved = !chosen && !!value;
  /** where the list sits in the viewport, and how tall it is allowed to be there */
  const [box, setBox] = useState<{ left: number; width: number; top?: number; bottom?: number; maxHeight: number }>(
    { left: 0, width: 0, top: 0, maxHeight: MAX_LIST },
  );

  const place = useCallback(() => {
    const t = trigger.current?.getBoundingClientRect();
    if (!t) return;
    const below = window.innerHeight - t.bottom - GAP - EDGE;
    const above = t.top - GAP - EDGE;
    // downwards unless the room is genuinely better upwards
    const up = below < Math.min(MAX_LIST, options.length * 40) && above > below;

    /**
     * Which edge the list hangs from.
     *
     * A list is wider than the control that opens it — the second line under an option sees to
     * that — so it grows sideways, and a narrow picker near the right of a row grew straight
     * over whatever sat beside it, which in a table being edited is Save. Past the middle of
     * the window it hangs from its right edge instead and grows the other way, into the row it
     * came from rather than over the buttons that end it.
     */
    const width = Math.max(t.width, MIN_LIST);
    const fromRight = t.left + t.width > window.innerWidth * 0.55;
    const left = fromRight
      ? Math.max(EDGE, t.right - width)
      : Math.max(EDGE, Math.min(t.left, window.innerWidth - width - EDGE));

    setBox({
      left,
      width,
      ...(up ? { bottom: window.innerHeight - t.top + GAP } : { top: t.bottom + GAP }),
      maxHeight: Math.max(120, Math.min(MAX_LIST, up ? above : below)),
    });
  }, [options.length]);

  useLayoutEffect(() => { if (open) place(); }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      // the list is no longer inside the trigger's subtree, so it is asked separately
      if (!root.current?.contains(t) && !list.current?.contains(t)) setOpen(false);
    };
    // capture, so a scroll inside any container moves the list with its trigger
    const follow = () => place();
    document.addEventListener('mousedown', away);
    window.addEventListener('scroll', follow, true);
    window.addEventListener('resize', follow);
    return () => {
      document.removeEventListener('mousedown', away);
      window.removeEventListener('scroll', follow, true);
      window.removeEventListener('resize', follow);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    (list.current?.children[active] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const choose = (i: number) => {
    const o = options[i];
    if (!o) return;
    onChange?.(o.value);
    setOpen(false);
    trigger.current?.focus();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault(); setOpen(true); return;
    }
    if (!open) return;
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); trigger.current?.focus(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(options.length - 1, i + 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    if (e.key === 'End') { e.preventDefault(); setActive(options.length - 1); }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(active); }
  };

  return (
    <div ref={root} style={{ position: 'relative', ...style }}>
      <button ref={trigger} type="button" disabled={disabled}
        aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel} aria-controls={listId}
        onClick={() => { setOpen((o) => !o); setActive(Math.max(0, options.findIndex((o2) => o2.value === value))); }}
        onKeyDown={onKey}
        aria-invalid={unresolved || undefined}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 10, cursor: disabled ? 'not-allowed' : 'pointer',
          padding: '9px 11px', fontSize: 14, textAlign: 'left',
          borderRadius: 'var(--r-sm)',
          // open is the same signal as focus: the border brightens, nothing is added around it.
          // Unresolved is a third state, and it stays visible even while open — the point is to
          // be seen before anyone saves, not to be replaced by the ordinary focus ring.
          border: `1px solid ${unresolved ? 'var(--negative)' : open ? 'var(--focus-edge)' : 'var(--control-border)'}`,
          boxShadow: open && !unresolved ? '0 0 0 1px var(--focus-edge) inset' : 'none',
          transition: 'border-color 140ms var(--ease), box-shadow 140ms var(--ease)',
          background: 'var(--control)', color: 'var(--ink)', opacity: disabled ? 0.55 : 1,
        }}>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                       color: unresolved ? 'var(--negative)' : undefined }}>
          {unresolved ? 'Not offered here' : chosen?.label ?? ''}
        </span>
        <span style={{ display: 'flex', color: 'var(--faint)', transform: open ? 'rotate(-90deg)' : 'rotate(-90deg) scaleX(-1)',
                       transition: 'transform 180ms var(--ease)' }}>
          <Icon name="chevron" size={14} motion="none" />
        </span>
      </button>

      {open && createPortal((
        <ul ref={list} role="listbox" id={listId} aria-label={ariaLabel} tabIndex={-1}
          onKeyDown={onKey}
          style={{
            position: 'fixed', zIndex: 400, left: box.left, top: box.top, bottom: box.bottom,
            width: box.width, maxHeight: box.maxHeight,
            overflowY: 'auto', listStyle: 'none', margin: 0, padding: 5,
            borderRadius: 'var(--r-card)', border: '1px solid var(--hairline-strong)',
            background: 'var(--surface)', boxShadow: 'var(--shadow-lg)',
          }}>
          {options.map((o, i) => {
            const on = o.value === value;
            return (
              <li key={o.value} role="option" aria-selected={on}
                onMouseEnter={() => setActive(i)} onClick={() => choose(i)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 9, cursor: 'pointer',
                  padding: '8px 10px', borderRadius: 'calc(var(--r-sm) * 0.85)',
                  background: i === active ? 'var(--control-hover)' : 'transparent',
                  color: on ? 'var(--ink)' : 'var(--muted)',
                }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 13, display: 'block', whiteSpace: 'nowrap',
                                 overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.label}</span>
                  {o.hint && (
                    <span style={{ fontSize: 11, color: 'var(--faint)', display: 'block',
                                   whiteSpace: 'normal', lineHeight: 1.35 }}>{o.hint}</span>
                  )}
                </span>
                {on && <Icon name="check" size={14} color="var(--accent)" motion="none" />}
              </li>
            );
          })}
        </ul>
      ), document.body)}
    </div>
  );
}

/** Convenience for the common case of plain string choices. */
export const opts = (xs: string[]): Option[] => xs.map((x) => ({ value: x, label: x }));
