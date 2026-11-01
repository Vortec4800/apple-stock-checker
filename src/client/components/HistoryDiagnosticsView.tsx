import React, { useCallback, useEffect, useId, useState } from 'react';
import { RefreshCw, Trash2 } from 'lucide-react';
import type {
  AppStateSnapshot,
  NotificationLog,
  RequestLog,
  RestockEvent,
} from '../../shared/types.js';
import { api } from '../api.js';
import { formatDurationCompact } from './DashboardView.js';

interface HistoryDiagnosticsViewProps {
  nowMs: number;
  onSnapshotUpdated: (snap: AppStateSnapshot) => void;
}

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function HistoryDiagnosticsView({
  nowMs,
  onSnapshotUpdated,
}: HistoryDiagnosticsViewProps): React.ReactElement {
  const [subTab, setSubTab] = useState<'restocks' | 'notifications' | 'requests'>('restocks');
  const [restocks, setRestocks] = useState<RestockEvent[]>([]);
  const [notifications, setNotifications] = useState<NotificationLog[]>([]);
  const [requests, setRequests] = useState<RequestLog[]>([]);
  const [loading, setLoading] = useState(false);

  const restockCaptionId = useId();
  const notifCaptionId = useId();
  const reqCaptionId = useId();

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [r, n, q] = await Promise.all([
        api.getRestockHistory(200),
        api.getNotificationHistory(200),
        api.getRequestDiagnostics(150),
      ]);
      setRestocks(r.events);
      setNotifications(n.logs);
      setRequests(q.logs);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const handleClear = async () => {
    if (!window.confirm('Clear all restock, notification, and HTTP diagnostic logs?')) {
      return;
    }
    const snap = await api.clearHistory();
    onSnapshotUpdated(snap);
    await loadAll();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '0.75rem',
        }}
      >
        <div className="nav-tabs">
          <button
            type="button"
            className="nav-tab"
            aria-current={subTab === 'restocks' ? 'page' : undefined}
            onClick={() => setSubTab('restocks')}
          >
            Restock History ({restocks.length})
          </button>
          <button
            type="button"
            className="nav-tab"
            aria-current={subTab === 'notifications' ? 'page' : undefined}
            onClick={() => setSubTab('notifications')}
          >
            Pushover Log ({notifications.length})
          </button>
          <button
            type="button"
            className="nav-tab"
            aria-current={subTab === 'requests' ? 'page' : undefined}
            onClick={() => setSubTab('requests')}
          >
            Apple API Health ({requests.length})
          </button>
        </div>

        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button type="button" className="btn btn-sm" onClick={() => void loadAll()}>
            <RefreshCw size={14} className={loading ? 'spin' : ''} />
            Refresh
          </button>
          <button type="button" className="btn btn-sm btn-danger" onClick={handleClear}>
            <Trash2 size={14} />
            Clear History
          </button>
        </div>
      </div>

      {subTab === 'restocks' ? (
        <div
          tabIndex={0}
          role="region"
          aria-labelledby={restockCaptionId}
          className="table-wrapper"
        >
          <table
            className="data-table"
            style={
              {
                '--label-2': '"Store"',
                '--label-3': '"Area Count"',
                '--label-4': '"Pickup Quote"',
                '--label-5': '"First Seen"',
                '--label-6': '"Restock Duration"',
              } as React.CSSProperties
            }
          >
            <caption id={restockCaptionId}>
              Detected In-Store Restock Events &amp; Sellout Durations
            </caption>
            <thead>
              <tr>
                <th scope="col">Product</th>
                <th scope="col">Store</th>
                <th scope="col">Area Count</th>
                <th scope="col">Pickup Quote</th>
                <th scope="col">First Seen</th>
                <th scope="col">Restock Duration</th>
              </tr>
            </thead>
            <tbody>
              {restocks.length === 0 ? (
                <tr>
                  <th scope="row">No restock events recorded yet</th>
                  <td>—</td>
                  <td>—</td>
                  <td>—</td>
                  <td>—</td>
                  <td>—</td>
                </tr>
              ) : (
                restocks.map((ev) => {
                  const isActive = ev.soldOutMs === null;
                  const durMs = isActive
                    ? Math.max(0, nowMs - ev.firstSeenMs)
                    : ev.durationMs ?? 0;

                  return (
                    <tr key={ev.id}>
                      <th scope="row">
                        <div>{ev.productTitle}</div>
                        <span className="sku-mono">{ev.partNumber}</span>
                      </th>
                      <td>
                        Apple {ev.storeName}
                        {ev.storeCity ? ` (${ev.storeCity})` : ''}
                      </td>
                      <td>
                        <span className="badge badge-instock">
                          {ev.areaInStockCount} / {ev.areaTotalStores} stores
                        </span>
                      </td>
                      <td>{ev.quote || 'Available'}</td>
                      <td>{formatTimestamp(ev.firstSeenMs)}</td>
                      <td>
                        {isActive ? (
                          <span className="badge badge-instock">
                            Active ({formatDurationCompact(durMs)})
                          </span>
                        ) : (
                          <span>Lasted {formatDurationCompact(durMs)}</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      ) : null}

      {subTab === 'notifications' ? (
        <div
          tabIndex={0}
          role="region"
          aria-labelledby={notifCaptionId}
          className="table-wrapper"
        >
          <table
            className="data-table"
            style={
              {
                '--label-2': '"Type"',
                '--label-3': '"Store"',
                '--label-4': '"Priority"',
                '--label-5': '"Sent At"',
                '--label-6': '"Status"',
              } as React.CSSProperties
            }
          >
            <caption id={notifCaptionId}>Pushover Notification Delivery History</caption>
            <thead>
              <tr>
                <th scope="col">Product / Alert</th>
                <th scope="col">Type</th>
                <th scope="col">Store</th>
                <th scope="col">Priority</th>
                <th scope="col">Sent At</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {notifications.length === 0 ? (
                <tr>
                  <th scope="row">No notifications sent yet</th>
                  <td>—</td>
                  <td>—</td>
                  <td>—</td>
                  <td>—</td>
                  <td>—</td>
                </tr>
              ) : (
                notifications.map((log) => (
                  <tr key={log.id}>
                    <th scope="row">
                      <div>{log.productTitle}</div>
                      {log.partNumber ? (
                        <span className="sku-mono">{log.partNumber}</span>
                      ) : null}
                    </th>
                    <td>{log.kind.toUpperCase()}</td>
                    <td>{log.storeName}</td>
                    <td>{log.priority}</td>
                    <td>{formatTimestamp(log.createdAtMs)}</td>
                    <td>
                      {log.success ? (
                        <span className="badge badge-instock">Delivered</span>
                      ) : (
                        <span
                          className="badge badge-danger"
                          title={log.errorDetail || ''}
                        >
                          Failed: {log.errorDetail || 'Error'}
                        </span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : null}

      {subTab === 'requests' ? (
        <div
          tabIndex={0}
          role="region"
          aria-labelledby={reqCaptionId}
          className="table-wrapper"
        >
          <table
            className="data-table"
            style={
              {
                '--label-2': '"Route"',
                '--label-3': '"HTTP"',
                '--label-4': '"Latency"',
                '--label-5': '"Outcome"',
                '--label-6': '"Time"',
              } as React.CSSProperties
            }
          >
            <caption id={reqCaptionId}>
              Recent Outbound Apple Retail API Requests
            </caption>
            <thead>
              <tr>
                <th scope="col">Endpoint</th>
                <th scope="col">Route</th>
                <th scope="col">HTTP</th>
                <th scope="col">Latency</th>
                <th scope="col">Outcome</th>
                <th scope="col">Time</th>
              </tr>
            </thead>
            <tbody>
              {requests.length === 0 ? (
                <tr>
                  <th scope="row">No Apple API requests logged yet</th>
                  <td>—</td>
                  <td>—</td>
                  <td>—</td>
                  <td>—</td>
                  <td>—</td>
                </tr>
              ) : (
                requests.map((req) => (
                  <tr key={req.id}>
                    <th scope="row">
                      <div style={{ wordBreak: 'break-all' }}>{req.endpoint}</div>
                      {req.partsCount > 0 ? (
                        <span className="sku-mono">{req.partsCount} parts batched</span>
                      ) : null}
                    </th>
                    <td>{req.routeLabel}</td>
                    <td>{req.httpStatus ?? 'ERR'}</td>
                    <td>{req.durationMs} ms</td>
                    <td>
                      <span
                        className={`badge ${
                          req.outcome === 'ok'
                            ? 'badge-instock'
                            : req.outcome === 'blocked_541' || req.outcome === 'rate_limited'
                              ? 'badge-warn'
                              : 'badge-danger'
                        }`}
                      >
                        {req.outcome}
                      </span>
                      {req.detail ? (
                        <div
                          style={{
                            fontSize: '0.74rem',
                            color: 'var(--text-secondary)',
                            marginTop: '0.2rem',
                          }}
                        >
                          {req.detail}
                        </div>
                      ) : null}
                    </td>
                    <td>{formatTimestamp(req.createdAtMs)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
