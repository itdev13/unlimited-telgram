import { useCallback, useEffect, useState } from 'react';
import useSso from './hooks/useSso';
import { api } from './api';
import Header from './components/Header';
import SubscriptionBanner from './components/SubscriptionBanner';
import ConnectionsPanel from './components/ConnectionsPanel';
import PlansPanel from './components/PlansPanel';
import WorkflowsPanel from './components/WorkflowsPanel';
import SupportPanel from './components/SupportPanel';
import { Loader, Alert } from './components/Icons';

const TABS = [
  { id: 'connections', label: 'Connections' },
  { id: 'workflows', label: 'Automations' },
  { id: 'plans', label: 'Plans' },
  { id: 'support', label: 'Support' },
];

function Shell({ children }) {
  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 min-h-screen">{children}</div>
  );
}

function LoadingState() {
  return (
    <Shell>
      <div className="flex flex-col items-center justify-center min-h-[420px] gap-4 animate-fade-in">
        <div className="w-14 h-14 rounded-2xl overflow-hidden shadow-[var(--shadow-glow-tg)] ring-1 ring-black/5">
          <img src="/logo.jpg" alt="Telegram Connector" className="w-full h-full object-cover" />
        </div>
        <div className="flex items-center gap-2 text-slate-500">
          <Loader size={18} /> <span className="text-[14px] font-medium">Connecting…</span>
        </div>
      </div>
    </Shell>
  );
}

function ErrorState({ message }) {
  return (
    <Shell>
      <div className="flex flex-col items-center justify-center min-h-[420px] gap-3 text-center animate-fade-in">
        <div className="w-12 h-12 rounded-2xl bg-red-50 text-red-500 flex items-center justify-center"><Alert size={24} /></div>
        <div className="text-[15px] font-semibold text-slate-900">Something went wrong</div>
        <p className="text-[13px] text-slate-500 max-w-xs">{message}</p>
        <button onClick={() => window.location.reload()} className="mt-2 h-10 px-5 rounded-xl bg-slate-900 text-white text-[13px] font-semibold hover:bg-slate-800">
          Refresh
        </button>
      </div>
    </Shell>
  );
}

export default function App() {
  const { user, loading: ssoLoading, error: ssoError, ssoPayload } = useSso();
  const [tab, setTab] = useState('connections');
  const [state, setState] = useState('loading'); // loading | error | ready
  const [errorMsg, setErrorMsg] = useState('');
  const [connections, setConnections] = useState({ bots: [], phones: [] });
  const [sub, setSub] = useState(null);
  const [plans, setPlans] = useState([]);

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const [settings, planList] = await Promise.all([
        api.call('GET', `/settings/${user.locationId}`, ssoPayload),
        api.call('GET', `/subscription/plans/${user.locationId}`, ssoPayload).catch(() => []),
      ]);
      setConnections(settings.connections || { bots: [], phones: [] });
      setSub(settings.subscription || null);
      setPlans(Array.isArray(planList) ? planList : []);
      setState('ready');
    } catch (err) {
      setErrorMsg(err.message || 'Could not load your account.');
      setState('error');
    }
  }, [user, ssoPayload]);

  useEffect(() => {
    if (ssoLoading) return;
    if (ssoError) { setErrorMsg(ssoError); setState('error'); return; }
    if (user) load();
  }, [user, ssoLoading, ssoError, load]);

  if (ssoLoading || state === 'loading') return <LoadingState />;
  if (state === 'error') return <ErrorState message={errorMsg} />;

  const connectedCount =
    (connections.bots || []).filter((b) => b.isActive).length +
    (connections.phones || []).filter((p) => p.isActive).length;
  const plan = sub?.plan || null;
  const entitled = sub ? sub.entitled : true;

  return (
    <Shell>
      <div className="animate-fade-up space-y-6">
        <Header connectedCount={connectedCount} />

        <SubscriptionBanner sub={sub} onViewPlans={() => setTab('plans')} />

        {/* Tabs */}
        <div className="flex items-center gap-1 p-1 bg-slate-100/80 rounded-xl w-fit">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`relative h-9 px-4 rounded-lg text-[13.5px] font-semibold transition-all ${
                tab === t.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Panels */}
        <div key={tab} className="animate-fade-up">
          {tab === 'connections' && (
            <ConnectionsPanel
              locationId={user.locationId}
              ssoPayload={ssoPayload}
              connections={connections}
              plan={plan}
              entitled={entitled}
              onChanged={load}
              onViewPlans={() => setTab('plans')}
            />
          )}
          {tab === 'workflows' && <WorkflowsPanel />}
          {tab === 'plans' && <PlansPanel plans={plans} sub={sub} />}
          {tab === 'support' && <SupportPanel />}
        </div>
      </div>
    </Shell>
  );
}
