/**
 * The mark.
 *
 * One file, used as it is. The artwork is black line art on transparent, so on a dark page
 * it is inverted in CSS rather than redrawn — see `.brand-logo` in tokens.css.
 */

export const LOGO_SRC = '/logo.png';

export function BrandMark({ size = 28, alt = 'Ledg00r' }: {
  size?: number;
  /** empty for a mark sitting beside the wordmark, where the name is already read out */
  alt?: string;
}) {
  return (
    <img
      className="brand-logo"
      src={LOGO_SRC}
      alt={alt}
      width={size}
      height={size}
      style={{ width: size, height: size, objectFit: 'contain', display: 'block', flex: 'none' }}
    />
  );
}
