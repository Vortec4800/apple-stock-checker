import React, { useEffect, useState } from 'react';
import {
  Activity,
  History,
  LayoutDashboard,
  Loader2,
  MapPin,
  PackagePlus,
  RefreshCw,
  Settings,
} from 'lucide-react';
import type { AppStateSnapshot } from '../shared/types.js';
import { api } from './api.js';
import { AreaStoresModal } from './components/AreaStoresModal.js';
import { DashboardView } from './components/DashboardView.js';
import { HistoryDiagnosticsView } from './components/HistoryDiagnosticsView.js';
import { ProductBrowserModal } from './components/ProductBrowserModal.js';
import { SettingsView } from './components/SettingsView.js';

type ActiveTab = 'dashboard' | 'history' | 'settings';

export function App(): React.ReactElement {
  const [snapshot, setSnapshot] = useState<AppStateSnapshot | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>('dashboard');
  const [areaModalOpen, setAreaModalOpen] = useState(false);
  const [productsModalOpen, setProductsModalOpen] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [busyCheckNow, setBusyCheckNow] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const applySnapshot = (snap: AppStateSnapshot) => {
    setSnapshot(snap);
    setClockOffsetMs(snap.serverTimeMs - Date.now());
    setLoadError(null);
  };

  useEffect(() => {
    void api
      .getState()
      .then(applySnapshot)
      .catch((err) => setLoadError((err as Error).message));

    const es = new EventSource('/api/events');
    const onStateEvent = (ev: MessageEvent) => {
      try {
        const parsed = JSON.parse(ev.data as string) as AppStateSnapshot;
        applySnapshot(parsed);
      } catch {
        // Ignore malformed SSE payload
      }
    };
    es.addEventListener('state', onStateEvent);
    return () => {
      es.removeEventListener('state', onStateEvent);
      es.close();
    };
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => {
      setNowMs(Date.now() + clockOffsetMs);
    }, 1000);
    return () => window.clearInterval(id);
  }, [clockOffsetMs]);

  const handleToggleWatcher = async (nextRunning: boolean) => {
    try {
      const snap = nextRunning ? await api.startWatcher() : await api.stopWatcher();
      applySnapshot(snap);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  };

  const handleCheckNow = async () => {
    setBusyCheckNow(true);
    try {
      const snap = await api.checkNow();
      applySnapshot(snap);
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      setBusyCheckNow(false);
    }
  };

  if (!snapshot) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          padding: '2rem',
          textAlign: 'center',
        }}
      >
        {loadError ? (
          <div style={{ maxWidth: '420px' }}>
            <h2 style={{ marginTop: 0 }}>Unable to reach Apple Stock Checker server</h2>
            <p style={{ color: 'var(--text-secondary)' }}>{loadError}</p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => window.location.reload()}
            >
              Retry Connection
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
            <Loader2 size={22} className="spin" />
            <span>Loading Apple Stock Checker…</span>
          </div>
        )}
      </div>
    );
  }

  const { watcher, stats, settings, watchedStores } = snapshot;

  let statusSubtitle = 'Watcher paused';
  if (watcher.checkingNow || busyCheckNow) {
    statusSubtitle = 'Checking Apple Retail inventory…';
  } else if (watcher.running && watcher.nextCheckAtMs !== null) {
    const secs = Math.max(0, Math.ceil((watcher.nextCheckAtMs - nowMs) / 1000));
    statusSubtitle =
      watcher.healthState === 'cooldown_541'
        ? `Edge cooldown — probing in ${secs}s`
        : `Next check in ${secs}s`;
  } else if (watcher.running) {
    statusSubtitle = 'Running';
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand-row">
            <div className="brand-logo" aria-hidden="true">
              <Activity size={19} />
            </div>
            <div>
              <h1 className="brand-title">Apple Stock Checker</h1>
              <p className="brand-subtitle">{statusSubtitle}</p>
            </div>
          </div>

          <nav className="nav-tabs" aria-label="Primary navigation">
            <button
              type="button"
              className="nav-tab"
              aria-current={activeTab === 'dashboard' ? 'page' : undefined}
              onClick={() => setActiveTab('dashboard')}
            >
              <LayoutDashboard size={15} />
              Dashboard
              {stats.inStockProductsCount > 0 ? (
                <span className="badge badge-instock" style={{ padding: '0.05rem 0.45rem' }}>
                  {stats.inStockProductsCount}
                </span>
              ) : null}
            </button>
            <button
              type="button"
              className="nav-tab"
              aria-current={activeTab === 'history' ? 'page' : undefined}
              onClick={() => setActiveTab('history')}
            >
              <History size={15} />
              History &amp; Logs
            </button>
            <button
              type="button"
              className="nav-tab"
              aria-current={activeTab === 'settings' ? 'page' : undefined}
              onClick={() => setActiveTab('settings')}
            >
              <Settings size={15} />
              Settings
            </button>
          </nav>

          <div className="controls-cluster">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setAreaModalOpen(true)}
            >
              <MapPin size={14} />
              Area &amp; Stores ({watchedStores.length}
              {settings.pickupLocation ? ` · ${settings.pickupLocation}` : ''})
            </button>

            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setProductsModalOpen(true)}
            >
              <PackagePlus size={14} />
              Add Products
            </button>

            <button
              type="button"
              className="btn btn-sm"
              disabled={
                watcher.checkingNow ||
                busyCheckNow ||
                watchedStores.length === 0 ||
                stats.watchedProductsCount === 0
              }
              onClick={handleCheckNow}
            >
              <RefreshCw
                size={14}
                className={watcher.checkingNow || busyCheckNow ? 'spin' : ''}
              />
              Check Now
            </button>

            <label className="switch-label" style={{ paddingLeft: '0.25rem' }}>
              Auto-Check
              <input
                type="checkbox"
                {...({ switch: '' } as Record<string, string>)}
                checked={watcher.running}
                onChange={(e) => void handleToggleWatcher(e.target.checked)}
              />
            </label>
          </div>
        </div>
      </header>

      <main>
        {activeTab === 'dashboard' ? (
          <DashboardView
            snapshot={snapshot}
            nowMs={nowMs}
            onSnapshotUpdated={applySnapshot}
            onOpenAreaModal={() => setAreaModalOpen(true)}
            onOpenProductsModal={() => setProductsModalOpen(true)}
          />
        ) : null}

        {activeTab === 'history' ? (
          <HistoryDiagnosticsView
            nowMs={nowMs}
            onSnapshotUpdated={applySnapshot}
          />
        ) : null}

        {activeTab === 'settings' ? (
          <SettingsView
            snapshot={snapshot}
            onSnapshotUpdated={applySnapshot}
          />
        ) : null}
      </main>

      <AreaStoresModal
        open={areaModalOpen}
        onClose={() => setAreaModalOpen(false)}
        snapshot={snapshot}
        onSnapshotUpdated={applySnapshot}
      />

      <ProductBrowserModal
        open={productsModalOpen}
        onClose={() => setProductsModalOpen(false)}
        snapshot={snapshot}
        onSnapshotUpdated={applySnapshot}
      />
    </div>
  );
}
