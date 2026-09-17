/**
 * The Ledg00r brand.
 *
 * Four pictures, cropped out of the finished branding artwork: the logo for the application's
 * own identity, the mascot for the assistant's. Each exists once per theme, because the drawing
 * itself is drawn in one ink or the other — a light drawing meant for a dark page, and a dark
 * drawing meant for a light one — and neither reads on the page it was not drawn for.
 *
 * The ground the artwork was rendered on has been cut away, so each file is the drawing alone
 * on transparency and sits on whatever colour the page happens to be rather than carrying a
 * rectangle of its own. That is the only change made to the artwork: there is no filter, no
 * inversion and no mask here, and no movement of any kind. The only decision either component
 * makes is which of the four files to point at.
 */
import { useEffect, useState } from 'react';

const DIR = '/brand/ledg00r';

/**
 * Which theme the page is dressed in.
 *
 * The application's own theme setting writes `data-theme` onto the document, so this is that
 * setting and not a second one — read off the document rather than out of the React context
 * because the navigation is rendered on its own in places, and a picture of a logo should
 * not be the thing that demands a provider around it.
 */
function useTheme(): 'light' | 'dark' {
  const read = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  const [theme, setTheme] = useState<'light' | 'dark'>(read);
  useEffect(() => {
    const watch = new MutationObserver(() => setTheme(read()));
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    setTheme(read());
    return () => watch.disconnect();
  }, []);
  return theme;
}

/**
 * Both files of a pair are the same size, so the one that replaces the other on a change of
 * theme occupies exactly the space it was given and nothing on the page moves.
 */
const LOGO = { w: 670, h: 266 };
const MASCOT = { w: 330, h: 330 };

/**
 * The application.
 *
 * Mascot and wordmark together, as one picture. It is not assembled here out of a mark and a
 * piece of text: the `00` is drawn as part of the word, and typesetting it would lose that.
 */
export function Ledg00rLogo({ width = 150 }: { width?: number }) {
  const theme = useTheme();
  return (
    <img
      src={`${DIR}/ledg00r-logo-${theme === 'dark' ? 'dark' : 'light'}.png`}
      alt="Ledg00r"
      width={width}
      height={Math.round(width * LOGO.h / LOGO.w)}
      style={{ width, height: Math.round(width * LOGO.h / LOGO.w), display: 'block', flex: 'none' }}
    />
  );
}

/**
 * The assistant.
 *
 * Wherever this appears, what is being said is Ledg00r's. It has no other job: it is not a
 * decoration for an empty panel or a heading, and putting it on one would cost it the only
 * thing it means.
 */
export function Ledg00rMascot({ size = 28, alt = 'Ledg00r' }: {
  size?: number;
  /** empty beside a name already written out, where the picture repeats what is read */
  alt?: string;
}) {
  const theme = useTheme();
  return (
    <img
      src={`${DIR}/ledg00r-mascot-${theme === 'dark' ? 'dark' : 'light'}.png`}
      alt={alt}
      width={size}
      height={size}
      style={{ width: size, height: size, display: 'block', flex: 'none' }}
    />
  );
}

export const LEDG00R_ART = { LOGO, MASCOT };
