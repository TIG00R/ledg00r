import { hijriTextOfIso } from '@ledger/engine';

/**
 * A date, with the lunar date under it.
 *
 * Zakat is reckoned in the lunar year and everything else in this ledger is not, so any date
 * that bears on zakat has to be readable in both without the reader converting anything. The
 * lunar line is smaller and dimmer because it is the second answer to the same question, not
 * a second question.
 */
export function DateText({ value, size = 13, hijri = true, style, prefix, empty = '—' }: {
  /** yyyy-mm-dd */
  value: string | null | undefined;
  size?: number;
  hijri?: boolean;
  style?: React.CSSProperties;
  prefix?: string;
  empty?: string;
}) {
  if (!value) return <span style={{ fontSize: size, color: 'var(--faint)', ...style }}>{empty}</span>;
  const gregorian = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T12:00:00`).toLocaleDateString('en-GB',
        { day: 'numeric', month: 'short', year: 'numeric' })
    : value;
  const lunar = hijri ? hijriTextOfIso(value) : null;
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', lineHeight: 1.25, ...style }}>
      <span className="mono" style={{ fontSize: size }}>
        {prefix ? `${prefix} ` : ''}{gregorian}
      </span>
      {lunar && (
        <span style={{ fontSize: Math.max(9, size - 3), color: 'var(--faint)' }}>
          {lunar} AH
        </span>
      )}
    </span>
  );
}

/** The lunar date alone, for places that already print the ordinary one. */
export function HijriUnder({ value, size = 10 }: { value: string | null | undefined; size?: number }) {
  const lunar = hijriTextOfIso(value ?? null);
  if (!lunar) return null;
  return <span style={{ display: 'block', fontSize: size, color: 'var(--faint)' }}>{lunar} AH</span>;
}
