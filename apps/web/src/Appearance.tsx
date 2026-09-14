import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { IconName } from './components/Icon';

/** Everything about how the app looks that should be the user's choice, not the app's. */

export type AssetKey = 'cash' | 'gold' | 'realestate' | 'car' | 'stocks';

export interface AssetStyle { icon: IconName; color: string; label: string }
export interface CurrencyStyle { color: string; symbol: string }

export interface Appearance {
  assets: Record<AssetKey, AssetStyle>;
  currencies: Record<string, CurrencyStyle>;
  institutions: Record<string, string>;
  /** 8, 12, 16, 20 by default — a single step scales the whole set */
  radiusScale: number;
  density: 'comfortable' | 'compact';
}

export const DEFAULT_APPEARANCE: Appearance = {
  assets: {
    cash:       { icon: 'banknote', color: 'var(--cash)',     label: 'Cash' },
    gold:       { icon: 'gold',     color: 'var(--gold)',     label: 'Gold' },
    realestate: { icon: 'realestate', color: 'var(--negative)', label: 'Real estate' },
    car:        { icon: 'car',      color: 'var(--car)',      label: 'Car' },
    stocks:     { icon: 'stocks',   color: 'var(--stocks)',  label: 'Stocks' },
  },
  currencies: {
    USD: { color: '#3F7D4F', symbol: '$' },
    EGP: { color: '#A07A33', symbol: 'E£' },
    GBP: { color: '#6B4E9E', symbol: '£' },
    EUR: { color: '#2B5FA5', symbol: '€' },
  },
  // The demonstration ledger's banks. A real one carries its own colour on the institution
  // itself, which is what the accounts screen reads; this is only what the demo opens with.
  institutions: {
    nile: '#0F7B5F', delta: '#1F4FD8', cedar: '#111111',
  },
  radiusScale: 1,
  density: 'comfortable',
};

const Ctx = createContext<{
  appearance: Appearance;
  set: (patch: Partial<Appearance>) => void;
  reset: () => void;
} | null>(null);

export function AppearanceProvider({ children }: { children: React.ReactNode }) {
  const [appearance, setAppearance] = useState<Appearance>(() => {
    try {
      const raw = localStorage.getItem('ledger.appearance');
      if (!raw) return DEFAULT_APPEARANCE;
      // A palette override used to be storable, and the panel that could undo one is gone.
      // Anything stored under that key is dropped so the theme always owns its own colours.
      const { palette, ...rest } = JSON.parse(raw) as Appearance & { palette?: unknown };
      return { ...DEFAULT_APPEARANCE, ...rest };
    } catch { return DEFAULT_APPEARANCE; }
  });

  useEffect(() => {
    const root = document.documentElement;
    // Colour belongs to the theme. Strip any override a previous build left behind.
    for (const key of ['accent', 'accent-ink', 'positive', 'negative', 'gold', 'cash', 'car', 'stocks']) {
      root.style.removeProperty(`--${key}`);
    }
    root.style.setProperty('--r-sm', `${8 * appearance.radiusScale}px`);
    root.style.setProperty('--r-card', `${12 * appearance.radiusScale}px`);
    root.style.setProperty('--r-panel', `${16 * appearance.radiusScale}px`);
    root.style.setProperty('--r-modal', `${20 * appearance.radiusScale}px`);
    root.dataset.density = appearance.density;
    try { localStorage.setItem('ledger.appearance', JSON.stringify(appearance)); } catch { /* private mode */ }
  }, [appearance]);

  const value = useMemo(() => ({
    appearance,
    set: (patch: Partial<Appearance>) => setAppearance((a) => ({ ...a, ...patch })),
    reset: () => setAppearance(DEFAULT_APPEARANCE),
  }), [appearance]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAppearance() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAppearance outside AppearanceProvider');
  return ctx;
}

/** How a given asset class should be drawn, wherever it appears. */
export function useAsset(key: AssetKey): AssetStyle {
  return useAppearance().appearance.assets[key];
}

export function useCurrencyStyle(code: string): CurrencyStyle {
  return useAppearance().appearance.currencies[code] ?? { color: 'var(--muted)', symbol: code };
}
