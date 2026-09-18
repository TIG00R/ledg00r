import { useState } from 'react';
import { Charity } from './Charity';
import { Zakat } from './Zakat';
import { GivingLog } from './GivingLog';
import { Segmented } from '../components/Segmented';
import { useModules } from '../Modules';

type Tab = 'zakat' | 'sadaqat' | 'all';

/**
 * Zakat and sadaqat are one subject seen twice — an obligation, and giving that is not
 * owed. Keeping them on one screen is what lets the third view exist: every outgoing gift
 * in one list, with which kind it was.
 *
 * Switching the module off takes away the obligation, not the giving. What is left is the
 * charity: what was given, and the log of everything given — so the tab that was sadaqat is
 * simply charity, because with nothing to tell it apart from there is no distinction left to
 * draw.
 */
export function Giving() {
  const { enabled } = useModules();
  const zakatOn = enabled.giving !== false;
  const [tab, setTab] = useState<Tab>('zakat');
  // The zakat tab is gone with the module, so a screen opened on it — or left on it when the
  // module was switched off — shows the giving instead of nothing at all.
  const shown: Tab = !zakatOn && tab === 'zakat' ? 'sadaqat' : tab;
  return (
    <>
      <div style={{ padding: '16px 24px 0', maxWidth: 1440, margin: '0 auto', width: '100%' }}>
        <Segmented<Tab> value={shown} onChange={setTab}
          ariaLabel={zakatOn ? 'Zakat or sadaqat' : 'What was given'}
          options={[
            ...(zakatOn
              ? [{ id: 'zakat' as const, label: 'Zakat', icon: 'zakat' as const, tone: 'var(--zakat)' }]
              : []),
            { id: 'sadaqat', label: zakatOn ? 'Sadaqat' : 'Charity', icon: 'hands', tone: 'var(--sadaqat)' },
            { id: 'all', label: 'Everything given', icon: 'charity' },
          ]} />
      </div>
      {shown === 'zakat' ? <Zakat /> : shown === 'sadaqat' ? <Charity /> : <GivingLog />}
    </>
  );
}
