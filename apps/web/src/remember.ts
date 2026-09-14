import { useEffect, useState } from 'react';

/**
 * What the interface remembers between visits.
 *
 * Reloading a finance application and being put back at the top of the overview, in reading
 * mode, is a small thing that happens all day: the figures are checked against a bank in
 * another window, and every trip back costs the place you were in. The screen itself is in
 * the address, so it survives on its own; the section inside it and whether you were editing
 * did not, and they do now.
 *
 * Storage can refuse — a private window, a browser told to keep no site data — so every read
 * and write is guarded and the stated default stands in. Nothing here is worth an error.
 */
const KEY = (name: string) => `ledg00r.${name}`;

export function recall(name: string): string | null {
  try {
    return window.localStorage.getItem(KEY(name));
  } catch {
    return null;
  }
}

export function remember(name: string, value: string): void {
  try {
    window.localStorage.setItem(KEY(name), value);
  } catch {
    /* a browser that keeps nothing is not an error, it just forgets */
  }
}

/**
 * State that comes back after a reload.
 *
 * `valid` guards what was stored: a section that no longer exists, or a mode that was renamed,
 * must not strand the screen on something it cannot draw.
 */
export function useRemembered(name: string, fallback: string, valid?: (v: string) => boolean): [string, (v: string) => void] {
  const [value, setValue] = useState(() => {
    const held = recall(name);
    return held !== null && (!valid || valid(held)) ? held : fallback;
  });

  // a fallback that changes — a screen with different sections — must not keep a stale answer
  useEffect(() => {
    if (valid && !valid(value)) setValue(fallback);
  }, [fallback, valid, value]);

  return [value, (v: string) => { setValue(v); remember(name, v); }];
}
