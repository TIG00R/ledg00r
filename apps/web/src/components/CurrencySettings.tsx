import { useCallback, useEffect, useState } from 'react';
import { Amount } from './Amount';
import { Panel, Field } from './UI';
import { Manager } from './Manager';
import { Icon } from './Icon';
import { useApp } from '../AppState';
import { useLive } from '../Live';
import { ledger } from '../api';

/**
 * The currencies this ledger knows.
 *
 * One list, configured here and offered everywhere afterwards — an account, an income source,
 * a record all pick from it. That is the point of configuring it first: adding a currency here
 * is how it reaches every dropdown in the application, rather than each screen carrying its
 * own guess at what is reasonable.
 *
 * The code never changes once records name it. Everything else about it can.
 */
export function CurrencySettings() {
  const { currencies, data } = useApp();
  const { run } = useLive();

  return (
    <>
      <Rates />
      <TheList currencies={currencies} data={data} run={run} />
    </>
  );
}

/**
 * What a unit is worth, as at when you said so.
 *
 * Every figure this ledger reports in your own currency rests on these numbers. They can be
 * fetched from a source chosen under Prices, and they can be typed in here — a rate recorded
 * by hand outranks nothing and is outranked by nothing, it is simply the latest one taken.
 * Each carries the moment it was recorded, because a rate without a date is a rate nobody can
 * judge, and a stale one is shown as stale rather than presented as though it were live.
 */
function Rates() {
  const { currencies, display } = useApp();
  const { run, live, version } = useLive();
  const [rates, setRates] = useState<Record<string, number>>({});
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [at, setAt] = useState<string | undefined>();
  const [draft, setDraft] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    if (!live) return;
    (ledger as any)['market.read']({})
      .then((m: any) => { setRates(m.fxRates ?? {}); setPrices(m.prices ?? {}); setAt(m.updatedAt); })
      .catch(() => undefined);
  }, [live]);
  useEffect(load, [load, version]);

  const save = async (key: string, value: number) => {
    await run('market.record', { key, value, source: 'set by hand' });
    setDraft((d) => ({ ...d, [key]: '' }));
    load();
  };

  const age = at ? Math.floor((Date.now() - new Date(at).getTime()) / 86_400_000) : null;

  const row = (key: string, label: string, sub: string, current: number | undefined, unit: string) => (
    <div key={key} style={{
      display: 'grid', gridTemplateColumns: 'minmax(0,1.3fr) 130px 150px auto', gap: 14,
      alignItems: 'end', padding: '13px 15px', borderRadius: 'var(--r-card)',
      background: 'var(--raised)', border: '1px solid var(--hairline)',
    }}>
      <div>
        <div style={{ fontSize: 14, fontWeight: 500 }}>{label}</div>
        <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 2 }}>{sub}</div>
      </div>
      <div>
        <div className="ov">In force</div>
        <div className="mono" style={{ fontSize: 15, marginTop: 4 }}>
          {current != null ? current.toLocaleString(undefined, { maximumFractionDigits: 4 }) : '—'}
        </div>
      </div>
      <Field label={`New ${unit}`}>
        <Amount value={Number(draft[key] ?? 0)} ariaLabel={`New ${label}`}
                onChange={(n) => setDraft({ ...draft, [key]: n ? String(n) : '' })}
                placeholder={current != null ? String(current) : ''} />
      </Field>
      <button className="btn go" disabled={!(Number(draft[key]) > 0)}
              onClick={() => save(key, Number(draft[key]))}>
        <Icon name="check" size={14} motion="none" /> Record
      </button>
    </div>
  );

  return (
    <Panel title="Rates and prices"
           hint={`What a unit of each thing is worth in ${display}. Every total rests on these — fetch them from a source under Prices, or set one here and it stands until something newer arrives.`}>
      {age != null && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16,
          padding: '11px 13px', borderRadius: 'var(--r-card)', fontSize: 12, lineHeight: 1.45,
          background: `color-mix(in srgb, var(--${age > 7 ? 'gold' : 'positive'}) 8%, transparent)`,
          border: `1px solid color-mix(in srgb, var(--${age > 7 ? 'gold' : 'positive'}) 26%, transparent)`,
          color: 'var(--muted)',
        }}>
          <Icon name={age > 7 ? 'warn' : 'check'} size={15}
                color={`var(--${age > 7 ? 'gold' : 'positive'})`} motion="none" />
          {age === 0 ? 'Last recorded today.'
            : `Last recorded ${age} day${age === 1 ? '' : 's'} ago.${age > 7 ? ' Every figure in this ledger is that old.' : ''}`}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {currencies.filter((c) => c.code !== 'EGP').map((c) =>
          row(`${c.code}_EGP`, `${c.code} · ${c.name}`, `one ${c.code} in EGP`, rates[c.code], 'rate'))}
        <div style={{ height: 1, background: 'var(--hairline)', margin: '4px 0' }} />
        {row('gold_24k_g', 'Gold · 24 carat', 'one gram in EGP, at the dealer\'s buy price', prices.gold_g, 'price')}
        {row('silver_g', 'Silver', 'one gram in EGP', prices.silver_g, 'price')}
        {row('gold_oz_usd', 'Gold · troy ounce', 'the world price, in USD', undefined, 'price')}
      </div>
    </Panel>
  );
}

function TheList({ currencies, data, run }: {
  currencies: ReturnType<typeof useApp>['currencies'];
  data: ReturnType<typeof useApp>['data'];
  run: ReturnType<typeof useLive>['run'];
}) {

  const heldIn = (code: string) =>
    data.nodes.filter((n) => n.kind === 'cash' && n.currency === code).length;

  return (
    <Panel title="Currencies"
           hint="What this ledger can hold. Every control that asks for a currency offers exactly this list, so adding one here is how it appears throughout.">
      <Manager
        markFamily="cash"
        addLabel="Add a currency"
        fields={[
          { key: 'code', label: 'Code', width: '90px', placeholder: 'SAR' },
          { key: 'name', label: 'Name', placeholder: 'Saudi riyal' },
          { key: 'symbol', label: 'Symbol', width: '90px', placeholder: '﷼' },
          { key: 'minorUnits', label: 'Decimals', kind: 'select', width: '120px',
            options: [
              { value: '0', label: 'None', hint: 'the yen' },
              { value: '2', label: 'Two', hint: 'most currencies' },
              { value: '3', label: 'Three', hint: 'the dinars' },
            ] },
          { key: 'colour', label: 'Colour', kind: 'colour', width: '64px' },
        ]}
        rows={currencies.map((c) => ({
          id: c.code,
          mark: c.mark,
          colour: c.color,
          values: {
            code: c.code, name: c.name, symbol: c.symbol,
            minorUnits: String(c.minorUnits), colour: c.color,
          },
          blocked: heldIn(c.code) > 0
            ? `${heldIn(c.code)} account${heldIn(c.code) === 1 ? ' is' : 's are'} held in ${c.code}. Archive those first — a balance without its unit means nothing.`
            : undefined,
          trailing: (
            <span style={{ fontSize: 11, color: 'var(--faint)', whiteSpace: 'nowrap' }}>
              {heldIn(c.code) ? `${heldIn(c.code)} account${heldIn(c.code) === 1 ? '' : 's'}` : 'unused'}
            </span>
          ),
        }))}
        onSave={(code, patch) => run('currency.update', {
          code,
          name: patch.name as string | undefined,
          symbol: patch.symbol as string | undefined,
          minorUnits: patch.minorUnits != null ? Number(patch.minorUnits) : undefined,
          color: patch.colour as string | undefined,
          mark: patch.mark as string | undefined,
        })}
        onAdd={(d) => run('currency.add', {
          code: String(d.code ?? '').toUpperCase(),
          name: d.name as string,
          symbol: (d.symbol as string) || String(d.code ?? '').toUpperCase(),
          minorUnits: d.minorUnits != null ? Number(d.minorUnits) : 2,
          color: (d.colour as string) || '#8A8578',
          mark: d.mark as string | undefined,
        })}
        onDelete={(code) => run('currency.remove', { code })}
        onArchive={(code) => run('currency.update', { code, archived: true })}
      />
      {/* Adding a currency by hand means knowing its code, its symbol and how many decimals
          it has. Most of the time it is one of a handful, so those are offered ready-made. */}
      {KNOWN.filter((k) => !currencies.some((c) => c.code === k.code)).length > 0 && (
        <div style={{ marginTop: 20, paddingTop: 18, borderTop: '1px solid var(--hairline)' }}>
          <div className="ov" style={{ marginBottom: 10 }}>Add a common one</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {KNOWN.filter((k) => !currencies.some((c) => c.code === k.code)).map((k) => (
              <button key={k.code} className="btn ghost"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12,
                         padding: '8px 13px' }}
                onClick={() => run('currency.add', k)}>
                <span className="mono public" style={{ color: k.color, fontWeight: 600 }}>{k.symbol}</span>
                {k.code}
                <span style={{ color: 'var(--faint)' }}>{k.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <p style={{ margin: '18px 0 0', fontSize: 12, color: 'var(--faint)', lineHeight: 1.55 }}>
        A code cannot be changed once records name it — they would be left pointing at nothing.
        Everything else about a currency can, including its mark: choose an icon, or upload the
        note itself. The change reaches every screen at once.
      </p>
    </Panel>
  );
}

/**
 * Currencies worth offering ready-made.
 *
 * Not a complete list — a complete list would be a search box, and this is a personal ledger
 * whose owner holds a handful. These are the ones nearby or widely held, with the decimals
 * each actually uses: three for the Gulf dinars, none for the yen.
 */
const KNOWN = [
  { code: 'EGP', name: 'Egyptian pound', symbol: 'E£', minorUnits: 2, color: '#B37E00' },
  { code: 'USD', name: 'US dollar', symbol: '$', minorUnits: 2, color: '#3F7D4F' },
  { code: 'GBP', name: 'Pound sterling', symbol: '£', minorUnits: 2, color: '#6B4E9E' },
  { code: 'EUR', name: 'Euro', symbol: '€', minorUnits: 2, color: '#0086A8' },
  { code: 'SAR', name: 'Saudi riyal', symbol: '﷼', minorUnits: 2, color: '#0B7A3B' },
  { code: 'AED', name: 'UAE dirham', symbol: 'د.إ', minorUnits: 2, color: '#8A6D3B' },
  { code: 'KWD', name: 'Kuwaiti dinar', symbol: 'د.ك', minorUnits: 3, color: '#1D6F8C' },
  { code: 'QAR', name: 'Qatari riyal', symbol: 'ر.ق', minorUnits: 2, color: '#7A1E46' },
  { code: 'CHF', name: 'Swiss franc', symbol: 'Fr', minorUnits: 2, color: '#C0392B' },
  { code: 'JPY', name: 'Japanese yen', symbol: '¥', minorUnits: 0, color: '#B03A5B' },
  { code: 'TRY', name: 'Turkish lira', symbol: '₺', minorUnits: 2, color: '#C0392B' },
  { code: 'CNY', name: 'Chinese yuan', symbol: '¥', minorUnits: 2, color: '#A93226' },
];
