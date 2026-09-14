import { useState } from 'react';
import { Charity } from './Charity';
import { Zakat } from './Zakat';
import { GivingLog } from './GivingLog';
import { Segmented } from '../components/Segmented';

type Tab = 'zakat' | 'sadaqat' | 'all';

/**
 * Zakat and sadaqat are one subject seen twice — an obligation, and giving that is not
 * owed. Keeping them on one screen is what lets the third view exist: every outgoing gift
 * in one list, with which kind it was.
 */
export function Giving() {
  const [tab, setTab] = useState<Tab>('zakat');
  return (
    <>
      <div style={{ padding: '16px 24px 0', maxWidth: 1440, margin: '0 auto', width: '100%' }}>
        <Segmented<Tab> value={tab} onChange={setTab} ariaLabel="Zakat or sadaqat"
          options={[
            { id: 'zakat', label: 'Zakat', icon: 'zakat', tone: 'var(--zakat)' },
            { id: 'sadaqat', label: 'Sadaqat', icon: 'hands', tone: 'var(--sadaqat)' },
            { id: 'all', label: 'Everything given', icon: 'charity' },
          ]} />
      </div>
      {tab === 'zakat' ? <Zakat /> : tab === 'sadaqat' ? <Charity /> : <GivingLog />}
    </>
  );
}
