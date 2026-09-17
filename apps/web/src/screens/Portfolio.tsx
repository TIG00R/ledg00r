import { useApp, market } from '../AppState';
import { money, splitByCurrency } from '@ledger/engine';
import { Pie } from '../components/Pie';
import { Icon } from '../components/Icon';
import { useAppearance, type AssetKey } from '../Appearance';
import { MarketPanel, UpcomingPanel } from '../components/Shell';
import { CurrencySplits } from '../components/CurrencySplits';

export function Portfolio({ onNavigate }: { onNavigate: (id: string) => void }) {
  const { data, values: v, dm, display } = useApp();
  const { appearance } = useAppearance();
  const style = (k: AssetKey) => appearance.assets[k];
  const a = v.accrual;

  /**
   * The piles, and only the piles that hold something.
   *
   * Every category used to be drawn whether or not anything was in it, so a ledger with one
   * car in it still showed Real estate, Gold and Stocks at nothing — five headings standing
   * in for holdings nobody had entered. What is drawn now is what is held; a thing that is
   * none of the named kinds lands in "Other", which is a pile rather than a silence:
   * before it existed such a thing counted towards the total and appeared in no line at all.
   *
   * Money lent out is one of the named kinds. It is owned — a debt owed to you is wealth you
   * happen not to be holding — but it is not a chattel, and reading it as one drew a loan to
   * a friend in the pile with the machines.
   */
  const slices = ([
    ['cash', v.cash], ['realestate', v.re], ['gold', v.gold], ['car', v.car],
    ['stocks', v.stocks], ['debt', v.debt], ['other', v.other],
  ] as Array<[AssetKey, number]>)
    .filter(([, value]) => value !== 0)
    .map(([key, value]) => ({
      key, value, label: style(key).label, color: style(key).color,
    }));

  const incomeSplit = splitByCurrency(
    data.incomeSources.filter((s) => s.scheduled && s.amount != null),
    (s) => ({ amount: s.amount as number, currency: s.currency }), market);
  // What was given, in the currency it was given in. Read through the older `egp`/`usd`
  // pair, a gift in pounds sterling was counted as Egyptian pounds; the service records the
  // currency, and only a dataset with no service behind it falls back to the pair.
  const charitySplit = splitByCurrency(data.charity,
    (c) => (c.currency ? { amount: c.amount ?? c.egp, currency: c.currency }
          : c.usd != null ? { amount: c.usd, currency: 'USD' }
          : { amount: c.egp, currency: 'EGP' }), market);
  const expenseSplit = splitByCurrency(data.expenses,
    (e) => ({ amount: e.amount, currency: e.currency }), market);

  return (
    <main style={{ padding: 24, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 300px',
                   gap: 20, alignItems: 'start', maxWidth: 1440, margin: '0 auto', width: '100%' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20, minWidth: 0 }}>

        {/* The overview is one chart and its legend. The strip that used to sit here said the
            same thing as the ring further down the page, and the list under that said it a
            third time — so the shares are drawn once, as a pie, with the figures beneath it. */}
        <section className="panel" style={{ padding: '32px 28px' }}>
          <div style={{ textAlign: 'center' }}>
            <div className="ov">Total net worth</div>
            <div className="mono" style={{ fontSize: 46, fontWeight: 500, letterSpacing: '-0.03em',
                                           margin: '10px 0 6px', lineHeight: 1 }}>
              {dm(v.total)}
            </div>
            {/* No rate is not a rate of zero: until one has been recorded there is nothing
                to convert at, and the line says nothing rather than saying NaN. */}
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>
              {v.rate > 0
                ? display === 'EGP'
                  ? `≈ ${money(v.total / v.rate, 'USD')} at ${v.rate.toFixed(4)}`
                  : `${money(v.total, 'EGP')} at ${v.rate.toFixed(4)}`
                : 'no rate recorded yet'}
            </div>
          </div>

          {slices.length === 0 ? (
            <p style={{ margin: '26px 0 4px', textAlign: 'center', fontSize: 13,
                        color: 'var(--faint)' }}>
              Nothing is held yet. What you add under Accounts, Assets, Gold and Stocks is
              what this splits.
            </p>
          ) : (
          <div style={{ display: 'flex', justifyContent: 'center', margin: '26px 0 22px' }}>
            <Pie slices={slices} size={236} format={(n) => dm(n)}
                 caption={<span style={{ fontSize: 12, color: 'var(--faint)' }}>
                   Point at a slice to name it
                 </span>} />
          </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 16 }}>
            {slices.map((s) => (
              <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                <span style={{
                  width: 34, height: 34, borderRadius: 9, flex: '0 0 34px',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: `color-mix(in srgb, ${s.color} 15%, transparent)`,
                }}>
                  <Icon name={style(s.key).icon} color={s.color} size={18} />
                </span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>{s.label}</div>
                  <div className="mono" style={{ fontSize: 15, fontWeight: 500 }}>{dm(s.value)}</div>
                  <div style={{ fontSize: 11, color: 'var(--faint)' }}>
                    {/* nothing is not 0% of nothing; a ledger holding nothing has no shares */}
                    {v.total > 0 ? `${((s.value / v.total) * 100).toFixed(1)}%` : '—'}
                    {s.key === 'gold' ? ` · ${a.goldGrams.toFixed(1)} g` : ''}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="panel" style={{ padding: 24 }}>
          <h2 style={{ margin: '0 0 6px', fontSize: 15, fontWeight: 600 }}>By the currency it was in</h2>
          <p style={{ margin: '0 0 18px', fontSize: 12, color: 'var(--faint)' }}>
            What was actually paid or received, before any conversion.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16 }}>
            <CurrencySplits label="Scheduled income, monthly" splits={incomeSplit.splits} totalEgp={incomeSplit.totalEgp} />
            <CurrencySplits label="Charity, all time" splits={charitySplit.splits} totalEgp={charitySplit.totalEgp} />
            <CurrencySplits label="Expenses, all time" splits={expenseSplit.splits} totalEgp={expenseSplit.totalEgp} />
          </div>
        </section>
      </div>

      <aside style={{ display: 'flex', flexDirection: 'column', gap: 20, position: 'sticky', top: 82 }}>
        <MarketPanel />
        <UpcomingPanel onNavigate={onNavigate} />
      </aside>
    </main>
  );
}
