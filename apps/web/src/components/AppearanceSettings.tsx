import { useAppearance, type AssetKey } from '../Appearance';
import { Select, opts } from './Select';
import { useApp } from '../AppState';
import { Icon, ICON_FAMILY, type IconName } from './Icon';
import { Field } from './UI';

/** The family a given subject picks from — cars for the car, metal for the metal. */
const FAMILY_OF: Record<AssetKey, keyof typeof ICON_FAMILY> = {
  cash: 'cash', gold: 'gold', realestate: 'realestate', car: 'car', stocks: 'stocks',
  other: 'assets',
};

export function AppearanceSettings() {
  const { appearance: a, set, reset } = useAppearance();
  const { theme, toggleTheme } = useApp();

  const setAsset = (key: AssetKey, patch: Partial<(typeof a.assets)[AssetKey]>) =>
    set({ assets: { ...a.assets, [key]: { ...a.assets[key], ...patch } } });

  return (
    <>
      <section className="panel" style={{ padding: 24 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Theme</h2>
          <button className="btn ghost" style={{ marginLeft: 'auto' }} onClick={reset}>Reset appearance</button>
        </div>
        <p style={{ margin: '4px 0 18px', fontSize: 12, color: 'var(--faint)', maxWidth: 760, lineHeight: 1.5 }}>
          The chrome stays neutral in both. Colour belongs to the data — an asset class, a
          currency, the sign of a number — never to a button.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 16px',
                      borderRadius: 'var(--r-card)', background: 'var(--raised)', border: '1px solid var(--hairline)' }}>
          <Icon name={theme === 'dark' ? 'moon' : 'sun'} size={17} color="var(--muted)" />
          <div style={{ flex: 1, fontSize: 13 }}>Currently {theme}</div>
          <button className="btn ghost" onClick={toggleTheme}>Switch to {theme === 'dark' ? 'light' : 'dark'}</button>
        </div>
      </section>

      <section className="panel" style={{ padding: 24 }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Icons</h2>
        <p style={{ margin: '4px 0 20px', fontSize: 12, color: 'var(--faint)', maxWidth: 760, lineHeight: 1.5 }}>
          The mark used for each thing you own, wherever it appears. What is offered for a
          subject is a set of that subject — choosing the car's mark means choosing between
          vehicles, not scrolling a list that happens to contain one.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {(Object.keys(a.assets) as AssetKey[]).map((key) => {
            const s = a.assets[key];
            const family = ICON_FAMILY[FAMILY_OF[key]] ?? [];
            return (
              <div key={key} style={{
                display: 'grid', gridTemplateColumns: '52px minmax(130px, 190px) 1fr', gap: 16, alignItems: 'center',
                padding: '14px 16px', borderRadius: 'var(--r-card)',
                background: 'var(--raised)', border: '1px solid var(--hairline)',
              }}>
                <span style={{ width: 44, height: 44, borderRadius: 11, display: 'flex', alignItems: 'center',
                               justifyContent: 'center', background: `color-mix(in srgb, ${s.color} 14%, transparent)` }}>
                  <Icon name={s.icon} size={22} color={s.color} />
                </span>
                <input value={s.label} aria-label={`${key} name`}
                       onChange={(e) => setAsset(key, { label: e.target.value })} />
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {family.map((ic) => (
                    <button key={ic} aria-label={`${s.label} mark ${ic}`} onClick={() => setAsset(key, { icon: ic })}
                      style={{ width: 40, height: 40, borderRadius: 10, cursor: 'pointer',
                               display: 'flex', alignItems: 'center', justifyContent: 'center',
                               background: s.icon === ic ? `color-mix(in srgb, ${s.color} 15%, transparent)` : 'var(--surface)',
                               border: `1px solid ${s.icon === ic ? s.color : 'var(--hairline)'}` }}>
                      <Icon name={ic} size={19} color={s.icon === ic ? s.color : 'var(--faint)'} />
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        <p style={{ margin: '18px 0 0', fontSize: 12, color: 'var(--faint)' }}>
          Currency marks and bank marks are set where they live — on the Accounts screen, in edit mode.
          Destination marks are set on Expenses, the same way.
        </p>
      </section>

      <section className="panel" style={{ padding: 24 }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Shape and density</h2>
        <p style={{ margin: '4px 0 20px', fontSize: 12, color: 'var(--faint)', maxWidth: 760 }}>
          One step changes every corner at once, keeping the ratio between buttons, cards,
          panels and modals.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 20 }}>
          <Field label={`Corner roundness — ${a.radiusScale.toFixed(2)}×`}
                 hint={`buttons ${Math.round(8 * a.radiusScale)}px · cards ${Math.round(12 * a.radiusScale)}px · panels ${Math.round(16 * a.radiusScale)}px`}>
            <input type="range" min={0} max={2} step={0.25} value={a.radiusScale}
                   aria-label="Corner roundness"
                   onChange={(e) => set({ radiusScale: Number(e.target.value) })} />
          </Field>
          <Field label="Density" hint="compact tightens padding and table rows across every screen">
            <Select ariaLabel="Density" value={a.density} onChange={(v) => set({ density: v as 'comfortable' | 'compact' })}
                    options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]} />
          </Field>
        </div>
      </section>
    </>
  );
}
