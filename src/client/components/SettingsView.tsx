import React, { useEffect, useState } from 'react';
import { Bell, CheckCircle2, Loader2, Save, Send, ShieldAlert } from 'lucide-react';
import type {
  AppSettings,
  AppStateSnapshot,
  PushoverPriority,
} from '../../shared/types.js';
import { api } from '../api.js';

interface SettingsViewProps {
  snapshot: AppStateSnapshot;
  onSnapshotUpdated: (snap: AppStateSnapshot) => void;
}

type ColorSchemeChoice = 'system' | 'light' | 'dark';

const PUSHOVER_SOUNDS = [
  'pushover',
  'bike',
  'bugle',
  'cashregister',
  'classical',
  'cosmic',
  'falling',
  'gamelan',
  'incoming',
  'intermission',
  'magic',
  'mechanical',
  'pianobar',
  'siren',
  'spacealarm',
  'tugboat',
  'alien',
  'climb',
  'persistent',
  'echo',
  'updown',
  'vibrate',
  'none',
];

function readStoredScheme(): ColorSchemeChoice {
  try {
    const val = localStorage.getItem('color-scheme');
    if (val === 'light' || val === 'dark') return val;
  } catch {
    // Ignore storage block
  }
  return 'system';
}

function applyColorSchemeChoice(choice: ColorSchemeChoice): void {
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) {
    meta.setAttribute('content', choice === 'system' ? 'light dark' : choice);
  }
  try {
    if (choice === 'system') {
      localStorage.removeItem('color-scheme');
    } else {
      localStorage.setItem('color-scheme', choice);
    }
  } catch {
    // Theme still applies to <meta> even if localStorage is blocked
  }
}

export function SettingsView({
  snapshot,
  onSnapshotUpdated,
}: SettingsViewProps): React.ReactElement {
  const [form, setForm] = useState<AppSettings>(snapshot.settings);
  const [proxiesText, setProxiesText] = useState(snapshot.settings.proxies.join('\n'));
  const [saving, setSaving] = useState(false);
  const [testingPushover, setTestingPushover] = useState(false);
  const [banner, setBanner] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // Tri-state color scheme setting (Modern Web Guidance: dark-mode-toggle)
  const [schemeChoice, setSchemeChoice] = useState<ColorSchemeChoice>(() =>
    readStoredScheme()
  );
  const [osPrefersDark, setOsPrefersDark] = useState<boolean>(() =>
    typeof window !== 'undefined'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : false
  );

  useEffect(() => {
    setForm(snapshot.settings);
    setProxiesText(snapshot.settings.proxies.join('\n'));
  }, [snapshot.settings]);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onMqChange = (e: MediaQueryListEvent) => {
      // Update OS display hint ONLY; never clear stored override when OS matches
      setOsPrefersDark(e.matches);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'color-scheme' || e.key === null) {
        const next = readStoredScheme();
        setSchemeChoice(next);
        const meta = document.querySelector('meta[name="color-scheme"]');
        if (meta) {
          meta.setAttribute('content', next === 'system' ? 'light dark' : next);
        }
      }
    };
    mq.addEventListener('change', onMqChange);
    window.addEventListener('storage', onStorage);
    return () => {
      mq.removeEventListener('change', onMqChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const handleSchemeChange = (choice: ColorSchemeChoice) => {
    setSchemeChoice(choice);
    applyColorSchemeChoice(choice);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setBanner(null);
    try {
      const proxies = proxiesText
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      const next = await api.updateSettings({
        ...form,
        proxies,
      });
      onSnapshotUpdated(next);
      setBanner({ kind: 'ok', text: 'Settings saved and applied immediately.' });
    } catch (err) {
      setBanner({ kind: 'err', text: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const handleTestPushover = async () => {
    setTestingPushover(true);
    setBanner(null);
    try {
      const res = await api.sendTestPushover(form.normalPriority, form.normalSound);
      onSnapshotUpdated(res.snapshot);
      if (res.success) {
        setBanner({
          kind: 'ok',
          text: 'Test Pushover notification delivered! Check your device.',
        });
      } else {
        setBanner({
          kind: 'err',
          text: res.error || 'Pushover test failed',
        });
      }
    } catch (err) {
      setBanner({ kind: 'err', text: (err as Error).message });
    } finally {
      setTestingPushover(false);
    }
  };

  const { pushover } = snapshot;

  return (
    <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: '1.1rem' }}>
      {banner ? (
        <div className={`banner ${banner.kind === 'ok' ? 'banner-warn' : 'banner-danger'}`}>
          <span>{banner.text}</span>
        </div>
      ) : null}

      <div className="settings-grid">
        {/* Card 1: Pushover Environment Credentials & Sounds */}
        <section className="settings-card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h3>Pushover Notifications (Docker Env)</h3>
            {pushover.configured ? (
              <span className="badge badge-instock">
                <CheckCircle2 size={13} /> Configured
              </span>
            ) : (
              <span className="badge badge-warn">
                <ShieldAlert size={13} /> Env Vars Missing
              </span>
            )}
          </div>

          <div
            style={{
              padding: '0.75rem 0.9rem',
              borderRadius: '10px',
              background: 'var(--surface-subtle)',
              border: '1px solid var(--border-subtle)',
              fontSize: '0.82rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.3rem',
            }}
          >
            <div>
              <strong>PUSHOVER_USER_KEY:</strong>{' '}
              <code>{pushover.maskedUserKey ?? 'Not set'}</code>
            </div>
            <div>
              <strong>PUSHOVER_API_TOKEN:</strong>{' '}
              <code>{pushover.maskedApiToken ?? 'Not set'}</code>
            </div>
            <div>
              <strong>PUSHOVER_DEVICE:</strong>{' '}
              <code>{pushover.device ?? 'All devices (optional)'}</code>
            </div>
            <p className="field-hint" style={{ marginTop: '0.25rem' }}>
              API keys are read strictly from container environment variables on your Unraid server and are never stored in SQLite.
            </p>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '0.75rem',
            }}
          >
            <div className="field-group">
              <label htmlFor="normal-priority" className="field-label">
                Standard Priority
              </label>
              <select
                id="normal-priority"
                className="select"
                value={form.normalPriority}
                onChange={(e) =>
                  setForm({
                    ...form,
                    normalPriority: Number(e.target.value) as PushoverPriority,
                  })
                }
              >
                <option value={-1}>Quiet (-1)</option>
                <option value={0}>Normal (0)</option>
                <option value={1}>High / Bypass Quiet Hours (1)</option>
                <option value={2}>Emergency Repeat (2)</option>
              </select>
            </div>

            <div className="field-group">
              <label htmlFor="normal-sound" className="field-label">
                Standard Sound
              </label>
              <select
                id="normal-sound"
                className="select"
                value={form.normalSound}
                onChange={(e) => setForm({ ...form, normalSound: e.target.value })}
              >
                {PUSHOVER_SOUNDS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>

            <div className="field-group">
              <label htmlFor="fav-priority" className="field-label">
                Favorite ★ Priority
              </label>
              <select
                id="fav-priority"
                className="select"
                value={form.favoritePriority}
                onChange={(e) =>
                  setForm({
                    ...form,
                    favoritePriority: Number(e.target.value) as PushoverPriority,
                  })
                }
              >
                <option value={-1}>Quiet (-1)</option>
                <option value={0}>Normal (0)</option>
                <option value={1}>High / Bypass Quiet Hours (1)</option>
                <option value={2}>Emergency Repeat (2)</option>
              </select>
            </div>

            <div className="field-group">
              <label htmlFor="fav-sound" className="field-label">
                Favorite ★ Sound
              </label>
              <select
                id="fav-sound"
                className="select"
                value={form.favoriteSound}
                onChange={(e) => setForm({ ...form, favoriteSound: e.target.value })}
              >
                {PUSHOVER_SOUNDS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <button
              type="button"
              className="btn"
              disabled={testingPushover}
              onClick={handleTestPushover}
            >
              {testingPushover ? <Loader2 size={15} className="spin" /> : <Send size={15} />}
              Send Test Pushover Notification
            </button>
          </div>
        </section>

        {/* Card 2: Polling Frequency & Rate-Limit Pacing */}
        <section className="settings-card">
          <h3>Checking Frequency &amp; Anti-Ban Pacing</h3>

          <div className="field-group">
            <label htmlFor="poll-interval" className="field-label">
              Target Check Floor (Seconds)
            </label>
            <input
              id="poll-interval"
              type="number"
              min={15}
              max={3600}
              className="input"
              value={form.pollIntervalSeconds}
              onChange={(e) =>
                setForm({
                  ...form,
                  pollIntervalSeconds: Number(e.target.value) || 35,
                })
              }
            />
            <p className="field-hint">
              With Area ZIP batching enabled, up to 8 watched SKUs across all nearby stores take only 1 HTTP request, safely checking every ~35–45 seconds.
            </p>
          </div>

          <div
            style={{
              padding: '0.75rem 0.9rem',
              borderRadius: '10px',
              background: 'var(--surface-subtle)',
              border: '1px solid var(--border-subtle)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '0.75rem',
            }}
          >
            <div>
              <div style={{ fontSize: '0.85rem', fontWeight: 600 }}>
                Adaptive IP Token-Bucket Pacing (Recommended)
              </div>
              <p className="field-hint">
                Automatically paces large watchlists so your home IP stays below Apple&apos;s HTTP 541 edge block threshold.
              </p>
            </div>
            <label className="switch-label">
              Auto-Pace
              <input
                type="checkbox"
                {...({ switch: '' } as Record<string, string>)}
                checked={form.adaptivePacing}
                onChange={(e) =>
                  setForm({ ...form, adaptivePacing: e.target.checked })
                }
              />
            </label>
          </div>

          <div className="field-group">
            <label htmlFor="jitter-pct" className="field-label">
              Random Timing Jitter (%)
            </label>
            <input
              id="jitter-pct"
              type="number"
              min={0}
              max={50}
              className="input"
              value={form.jitterPercent}
              onChange={(e) =>
                setForm({ ...form, jitterPercent: Number(e.target.value) || 0 })
              }
            />
          </div>
        </section>

        {/* Card 3: Alert Cadence */}
        <section className="settings-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
            <Bell size={17} />
            <h3>Alert Repeat Rules</h3>
          </div>

          <div className="field-group">
            <label htmlFor="repeat-mode" className="field-label">
              When Stock Is Found
            </label>
            <select
              id="repeat-mode"
              className="select"
              value={form.alertRepeatMode}
              onChange={(e) =>
                setForm({
                  ...form,
                  alertRepeatMode: e.target.value as AppSettings['alertRepeatMode'],
                })
              }
            >
              <option value="once_per_restock">
                Alert once per restock (re-arms only after selling out)
              </option>
              <option value="repeat_while_in_stock">
                Repeat reminders while still in stock
              </option>
            </select>
          </div>

          {form.alertRepeatMode === 'repeat_while_in_stock' ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
              <div className="field-group">
                <label htmlFor="repeat-mins" className="field-label">
                  Repeat Every (Minutes)
                </label>
                <input
                  id="repeat-mins"
                  type="number"
                  min={1}
                  max={180}
                  className="input"
                  value={form.repeatIntervalMinutes}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      repeatIntervalMinutes: Number(e.target.value) || 5,
                    })
                  }
                />
              </div>
              <div className="field-group">
                <label htmlFor="max-alerts" className="field-label">
                  Max Alerts per Restock
                </label>
                <input
                  id="max-alerts"
                  type="number"
                  min={1}
                  max={50}
                  className="input"
                  value={form.maxAlertsPerRestock}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      maxAlertsPerRestock: Number(e.target.value) || 3,
                    })
                  }
                />
              </div>
            </div>
          ) : null}

          <div className="field-group">
            <label htmlFor="min-gap" className="field-label">
              Minimum Gap Between Pushover Messages (Seconds)
            </label>
            <input
              id="min-gap"
              type="number"
              min={0}
              max={300}
              className="input"
              value={form.minAlertGapSeconds}
              onChange={(e) =>
                setForm({
                  ...form,
                  minAlertGapSeconds: Number(e.target.value) || 0,
                })
              }
            />
          </div>
        </section>

        {/* Card 4: Appearance & Advanced Outbound Proxies */}
        <section className="settings-card">
          <h3>Appearance &amp; Advanced Network</h3>

          <div className="field-group">
            <span className="field-label">Color Scheme</span>
            <div className="chip-row" role="group" aria-label="Color scheme">
              <button
                type="button"
                className="chip-btn"
                aria-pressed={schemeChoice === 'system'}
                onClick={() => handleSchemeChange('system')}
              >
                System (Currently {osPrefersDark ? 'dark' : 'light'})
              </button>
              <button
                type="button"
                className="chip-btn"
                aria-pressed={schemeChoice === 'light'}
                onClick={() => handleSchemeChange('light')}
              >
                Light
              </button>
              <button
                type="button"
                className="chip-btn"
                aria-pressed={schemeChoice === 'dark'}
                onClick={() => handleSchemeChange('dark')}
              >
                Dark
              </button>
            </div>
          </div>

          <div className="field-group">
            <label htmlFor="proxies-textarea" className="field-label">
              Optional Outbound HTTP/HTTPS Proxies (One URL per line)
            </label>
            <textarea
              id="proxies-textarea"
              className="textarea"
              placeholder="http://user:pass@proxy-host:8080"
              value={proxiesText}
              onChange={(e) => setProxiesText(e.target.value)}
            />
            <p className="field-hint">
              Leave blank to use your Unraid server&apos;s direct connection. Each proxy gets its own independent cookie jar and 20-request token bucket.
            </p>
          </div>
        </section>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? <Loader2 size={16} className="spin" /> : <Save size={16} />}
          Save Settings
        </button>
      </div>
    </form>
  );
}
