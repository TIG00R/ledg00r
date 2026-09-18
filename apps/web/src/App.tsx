import { useEffect, useState } from 'react';
import { AppProvider } from './AppState';
import { LiveProvider } from './Live';
import { AppearanceProvider } from './Appearance';
import { ModulesProvider, useModules } from './Modules';
import { NAV, Sidebar, TopBar, useViewport } from './components/Shell';
import { SETTINGS_VIEWS } from './screens/Settings';
import { Portfolio } from './screens/Portfolio';
import { Dashboards } from './screens/Dashboards';
import { Accounts } from './screens/Accounts';
import { Income } from './screens/Income';
import { Flow } from './screens/Flow';
import { Assets } from './screens/AssetsView';
import { Metals } from './screens/Metals';
import { Stocks } from './screens/Stocks';
import { ExpensesAndBudgets } from './screens/Expenses';
import { Giving } from './screens/Giving';
import { Settings } from './screens/Settings';
import { Assistant } from './screens/Assistant';
import { Debts } from './screens/Debts';
import { Calendar } from './screens/Calendar';
import { Logs } from './screens/Logs';

/**
 * The screen lives in the URL.
 *
 * Reloading a finance app and being thrown back to the overview is a small thing that
 * happens every day, and the browser's own back button is the control people reach for
 * first. A hash keeps both working without a router or a server that knows the routes.
 */
function useHashScreen(): [string, (id: string) => void] {
  // #/budgets used to name its own screen; it now names half of the combined one, so a
  // bookmark or a calendar link built on the old address still lands where it always did.
  const read = () => {
    const id = window.location.hash.replace(/^#\/?/, '') || 'portfolio';
    return id === 'budgets' ? 'expenses' : id;
  };
  const [screen, setScreen] = useState(read);
  useEffect(() => {
    const onHash = () => setScreen(read());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const go = (id: string) => {
    if (id === read()) return;
    window.location.hash = `/${id}`;
  };
  return [screen, go];
}

function Frame() {
  const { isScreenOn } = useModules();
  const [screen, setScreen] = useHashScreen();
  const active = isScreenOn(screen) ? screen : 'portfolio';
  const setActive = setScreen;

  // a screen switched off in the modules settings must not stay in the address bar
  useEffect(() => { if (active !== screen) setScreen(active); }, [active, screen, setScreen]);
  const [collapsed, setCollapsed] = useState(false);
  /**
   * The sidebar answers to the window as well as to the button.
   *
   * There is no width at which 224 pixels of navigation and a working screen both fit in a
   * phone, so below the point where they stop fitting the sidebar becomes something you open
   * — and between the two it keeps its icons and drops its words rather than eating the page.
   */
  const { rail, mobile } = useViewport();
  const [drawer, setDrawer] = useState(false);
  useEffect(() => { if (!mobile) setDrawer(false); }, [mobile]);
  const [, force] = useState(0);
  const title = NAV.find((n) => n.id === active)?.label
    ?? SETTINGS_VIEWS.find((v) => v.id === active)?.label
    ?? 'Ledger';

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <Sidebar active={active} onNavigate={setActive} collapsed={collapsed || rail}
               onToggle={() => setCollapsed((c) => !c)}
               overlay={mobile} open={drawer} onClose={() => setDrawer(false)} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <TopBar title={title} screen={active} onRefresh={() => force((n) => n + 1)} onNavigate={setActive}
                onMenu={mobile ? () => setDrawer(true) : undefined} />
        {active === 'portfolio' && <Portfolio onNavigate={setActive} />}
        {active === 'dashboards' && <Dashboards />}
        {active === 'accounts' && <Accounts />}
        {active === 'income' && <Income />}
        {active === 'flow' && <Flow />}
        {active === 'realestate' && <Assets />}
        {active === 'gold' && <Metals />}
        {active === 'stocks' && <Stocks />}
        {active === 'expenses' && <ExpensesAndBudgets />}
        {active === 'giving' && <Giving />}
        {active === 'debts' && <Debts />}
        {active === 'calendar' && <Calendar />}
        {active === 'logs' && <Logs />}
        {active === 'assistant' && <Assistant />}
        {active.startsWith('settings') && <Settings view={active} onNavigate={setActive} />}
      </div>
    </div>
  );
}

export function App() {
  return (
    <ModulesProvider>
      <AppearanceProvider>
        <LiveProvider><AppProvider><Frame /></AppProvider></LiveProvider>
      </AppearanceProvider>
    </ModulesProvider>
  );
}
