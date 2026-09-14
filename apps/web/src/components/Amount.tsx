import { useEffect, useState } from 'react';

/**
 * A number field that does not fight you.
 *
 * A controlled `<input type="number">` bound to a number shows `0` when the value is zero,
 * and typing puts your digit after it — so the first thing anyone types becomes `05`, or they
 * delete the zero first every single time. The fix is to keep the text you typed as text, and
 * only turn it into a number for whoever is listening.
 *
 * An empty field is zero to the caller and empty on screen, which is what a person means by
 * clearing it.
 */
export function Amount({ value, onChange, ariaLabel, placeholder, style, readOnly, min }: {
  value: number;
  onChange?: (n: number) => void;
  ariaLabel: string;
  placeholder?: string;
  style?: React.CSSProperties;
  readOnly?: boolean;
  min?: number;
}) {
  const [text, setText] = useState(() => (value === 0 ? '' : String(value)));

  // Follow the value when it changes from outside — a form clearing itself after a save —
  // without overwriting what is being typed.
  useEffect(() => {
    const asTyped = Number(text || 0);
    if (asTyped !== value) setText(value === 0 ? '' : String(value));
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <input
      className="mono"
      inputMode="decimal"
      aria-label={ariaLabel}
      placeholder={placeholder ?? '0'}
      readOnly={readOnly}
      value={text}
      style={style}
      onChange={(e) => {
        const raw = e.target.value;
        // digits, one dot, an optional leading minus — anything else is not an amount
        if (!/^-?\d*\.?\d*$/.test(raw)) return;
        setText(raw);
        const n = raw === '' || raw === '-' ? 0 : Number(raw);
        if (Number.isFinite(n) && (min == null || n >= min)) onChange?.(n);
      }}
      onBlur={() => { if (text === '.' || text === '-') setText(''); }}
    />
  );
}
