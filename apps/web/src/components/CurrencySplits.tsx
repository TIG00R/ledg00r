import { money, type CurrencySplit } from '@ledger/engine';
import { useApp } from '../AppState';

const HUE: Record<string, string> = {
  USD: '#3F7D4F', EGP: '#A07A33', GBP: '#6B4E9E', EUR: '#2B5FA5', SAR: '#0F6B3C', AED: '#8C3B48',
};

/** A total in one currency hides that it was earned or spent in several. This does not. */
export function CurrencySplits({ label, splits, totalEgp, compact }: {
  label: string; splits: CurrencySplit[]; totalEgp: number; compact?: boolean;
}) {
  const { dm } = useApp();
  if (splits.length === 0) {
    return (
      <div>
        <div className="ov">{label}</div>
        <div style={{ fontSize: 12, color: 'var(--faint)', marginTop: 4 }}>nothing recorded</div>
      </div>
    );
  }
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span className="ov">{label}</span>
        <span className="mono" style={{ marginLeft: 'auto', fontSize: 14, fontWeight: 500 }}>{dm(totalEgp)}</span>
      </div>
      {!compact && (
        <div style={{ display: 'flex', height: 6, borderRadius: 999, overflow: 'hidden', gap: 2, margin: '8px 0' }}>
          {splits.map((s) => (
            <div key={s.currency} style={{ width: `${(s.egp / totalEgp) * 100}%`, background: HUE[s.currency] ?? 'var(--muted)' }} />
          ))}
        </div>
      )}
      <ul style={{ listStyle: 'none', margin: compact ? '6px 0 0' : 0, padding: 0,
                   display: 'flex', gap: compact ? 12 : 14, flexWrap: 'wrap' }}>
        {splits.map((s) => (
          <li key={s.currency} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: HUE[s.currency] ?? 'var(--muted)' }} />
            <span className="mono">{money(s.amount, s.currency, s.currency === 'EGP' ? 0 : 2)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
