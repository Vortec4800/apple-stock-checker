import React, { useEffect, useMemo, useState } from 'react';
import { Loader2, MapPin, RefreshCw, Search } from 'lucide-react';
import type { AppStateSnapshot, RegionInfo, StoreInfo } from '../../shared/types.js';
import { api } from '../api.js';
import { ModalDialog } from './ModalDialog.js';

interface AreaStoresModalProps {
  open: boolean;
  onClose: () => void;
  snapshot: AppStateSnapshot;
  onSnapshotUpdated: (snap: AppStateSnapshot) => void;
}

export function AreaStoresModal({
  open,
  onClose,
  snapshot,
  onSnapshotUpdated,
}: AreaStoresModalProps): React.ReactElement {
  const [regions, setRegions] = useState<RegionInfo[]>([]);
  const [locale, setLocale] = useState(snapshot.settings.locale);
  const [pickupLocation, setPickupLocation] = useState(snapshot.settings.pickupLocation);
  const [useLocationBatching, setUseLocationBatching] = useState(
    snapshot.settings.useLocationBatching
  );
  const [directoryStores, setDirectoryStores] = useState<StoreInfo[]>([]);
  const [nearbyStores, setNearbyStores] = useState<StoreInfo[] | null>(null);
  const [selectedMap, setSelectedMap] = useState<Map<string, StoreInfo>>(new Map());
  const [filterText, setFilterText] = useState('');
  const [selectedState, setSelectedState] = useState('ALL');
  const [lookingUp, setLookingUp] = useState(false);
  const [refreshingList, setRefreshingList] = useState(false);
  const [saving, setSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLocale(snapshot.settings.locale);
    setPickupLocation(snapshot.settings.pickupLocation);
    setUseLocationBatching(snapshot.settings.useLocationBatching);
    setSelectedMap(new Map(snapshot.watchedStores.map((s) => [s.id, s])));
    setNearbyStores(null);
    setStatusMessage(null);

    void api.getRegions().then((r) => setRegions(r.regions)).catch(() => undefined);
  }, [open, snapshot.settings.locale, snapshot.settings.pickupLocation, snapshot.settings.useLocationBatching, snapshot.watchedStores]);

  useEffect(() => {
    if (!open) return;
    void api
      .getStores(locale)
      .then((res) => {
        setDirectoryStores(res.stores);
        setSelectedState('ALL');
      })
      .catch((err) => setStatusMessage((err as Error).message));
  }, [open, locale]);

  const activeRegion = useMemo(
    () => regions.find((r) => r.locale === locale),
    [regions, locale]
  );

  const statesList = useMemo(() => {
    const s = new Set<string>();
    for (const st of directoryStores) {
      if (st.state) s.add(st.state);
    }
    return Array.from(s).sort((a, b) => a.localeCompare(b));
  }, [directoryStores]);

  const displayedStores = useMemo(() => {
    const source = nearbyStores ?? directoryStores;
    const q = filterText.trim().toLowerCase();
    return source.filter((s) => {
      if (!nearbyStores && selectedState !== 'ALL' && s.state !== selectedState) {
        return false;
      }
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.city.toLowerCase().includes(q) ||
        s.state.toLowerCase().includes(q) ||
        s.postalCode.toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q)
      );
    });
  }, [nearbyStores, directoryStores, filterText, selectedState]);

  const handleLookupZip = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pickupLocation.trim()) return;
    setLookingUp(true);
    setStatusMessage(null);
    try {
      const res = await api.lookupNearbyStores(locale, pickupLocation.trim());
      setNearbyStores(res.stores);
      if (res.warning) {
        setStatusMessage(res.warning);
      } else {
        setStatusMessage(
          `Found ${res.stores.length} Apple Store${res.stores.length === 1 ? '' : 's'} near "${pickupLocation.trim()}". Select the stores in your area below.`
        );
      }
    } catch (err) {
      setStatusMessage((err as Error).message);
    } finally {
      setLookingUp(false);
    }
  };

  const handleRefreshDirectory = async () => {
    setRefreshingList(true);
    setStatusMessage(null);
    try {
      const res = await api.refreshLiveStores(locale);
      setDirectoryStores(res.stores);
      setNearbyStores(null);
      setStatusMessage(`Refreshed ${res.count} retail stores from Apple.com.`);
    } catch (err) {
      setStatusMessage(`Refresh failed: ${(err as Error).message}`);
    } finally {
      setRefreshingList(false);
    }
  };

  const toggleStore = (store: StoreInfo) => {
    setSelectedMap((prev) => {
      const next = new Map(prev);
      if (next.has(store.id)) {
        next.delete(store.id);
      } else {
        next.set(store.id, store);
      }
      return next;
    });
  };

  const selectAllDisplayed = () => {
    setSelectedMap((prev) => {
      const next = new Map(prev);
      for (const s of displayedStores) next.set(s.id, s);
      return next;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const nextSnap = await api.updateArea({
        locale,
        pickupLocation: pickupLocation.trim(),
        useLocationBatching,
        stores: Array.from(selectedMap.values()),
      });
      onSnapshotUpdated(nextSnap);
      onClose();
    } catch (err) {
      setStatusMessage((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalDialog
      open={open}
      title="Area & Apple Retail Stores"
      onClose={onClose}
      footer={
        <>
          <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>
            {selectedMap.size} store{selectedMap.size === 1 ? '' : 's'} selected
          </span>
          <div style={{ display: 'flex', gap: '0.6rem' }}>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={saving}
              onClick={handleSave}
            >
              {saving ? <Loader2 size={16} className="spin" /> : null}
              Save Area &amp; Stores
            </button>
          </div>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.1rem' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
            gap: '0.9rem',
          }}
        >
          <div className="field-group">
            <label htmlFor="region-select" className="field-label">
              Country / Region
            </label>
            <select
              id="region-select"
              className="select"
              value={locale}
              onChange={(e) => {
                setLocale(e.target.value);
                setSelectedMap(new Map());
                setNearbyStores(null);
              }}
            >
              {regions.map((r) => (
                <option key={r.locale} value={r.locale}>
                  {r.name} ({r.locale})
                </option>
              ))}
            </select>
          </div>

          <form onSubmit={handleLookupZip} className="field-group">
            <label htmlFor="zip-lookup-input" className="field-label">
              Area ZIP / Postal Code or City
            </label>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <input
                id="zip-lookup-input"
                type="text"
                className="input"
                autoFocus
                placeholder={activeRegion?.postalPlaceholder || '90210 or City, State'}
                value={pickupLocation}
                onChange={(e) => setPickupLocation(e.target.value)}
              />
              <button
                type="submit"
                className="btn btn-primary"
                disabled={lookingUp || !pickupLocation.trim()}
                style={{ flexShrink: 0 }}
              >
                {lookingUp ? <Loader2 size={15} className="spin" /> : <MapPin size={15} />}
                Find Nearby
              </button>
            </div>
          </form>
        </div>

        <div
          style={{
            padding: '0.75rem 0.95rem',
            borderRadius: '10px',
            background: 'var(--surface-subtle)',
            border: '1px solid var(--border-subtle)',
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '0.75rem',
          }}
        >
          <div>
            <div style={{ fontSize: '0.85rem', fontWeight: 600 }}>
              Batch checks using Area Location / ZIP
            </div>
            <p className="field-hint">
              Checks up to 8 watched products across all nearby stores in a single Apple API request, maximizing check frequency without rate limits.
            </p>
          </div>
          <label className="switch-label">
            Batch by Area
            <input
              type="checkbox"
              {...({ switch: '' } as Record<string, string>)}
              checked={useLocationBatching}
              onChange={(e) => setUseLocationBatching(e.target.checked)}
            />
          </label>
        </div>

        {statusMessage ? (
          <div className="banner banner-warn" style={{ marginBottom: 0 }}>
            <span>{statusMessage}</span>
          </div>
        ) : null}

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '0.6rem',
          }}
        >
          <div style={{ display: 'flex', gap: '0.5rem', flex: '1 1 280px' }}>
            <div style={{ position: 'relative', flex: 1 }}>
              <Search
                size={15}
                style={{
                  position: 'absolute',
                  left: '0.7rem',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  color: 'var(--text-muted)',
                }}
              />
              <input
                type="search"
                className="input"
                style={{ paddingLeft: '2.1rem' }}
                placeholder="Filter stores by name, city, state, or R-code..."
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
              />
            </div>

            {!nearbyStores && statesList.length > 1 ? (
              <select
                className="select"
                style={{ width: 'auto', minWidth: '150px' }}
                aria-label="Filter by state or province"
                value={selectedState}
                onChange={(e) => setSelectedState(e.target.value)}
              >
                <option value="ALL">All States ({directoryStores.length})</option>
                {statesList.map((st) => (
                  <option key={st} value={st}>
                    {st}
                  </option>
                ))}
              </select>
            ) : null}
          </div>

          <div style={{ display: 'flex', gap: '0.45rem', flexWrap: 'wrap' }}>
            {nearbyStores ? (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setNearbyStores(null)}
              >
                Show All {directoryStores.length} Regional Stores
              </button>
            ) : null}
            <button type="button" className="btn btn-sm" onClick={selectAllDisplayed}>
              Select Shown ({displayedStores.length})
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setSelectedMap(new Map())}
            >
              Clear
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={refreshingList}
              onClick={handleRefreshDirectory}
              title="Refresh official store list from Apple.com"
            >
              <RefreshCw size={13} className={refreshingList ? 'spin' : ''} />
              Sync Directory
            </button>
          </div>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(245px, 1fr))',
            gap: '0.55rem',
            maxHeight: '340px',
            overflowY: 'auto',
            padding: '0.2rem',
          }}
        >
          {displayedStores.map((store) => {
            const checked = selectedMap.has(store.id);
            return (
              <label
                key={store.id}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '0.6rem',
                  padding: '0.65rem 0.8rem',
                  borderRadius: '10px',
                  border: `1px solid ${checked ? 'var(--color-accent)' : 'var(--border-subtle)'}`,
                  background: checked ? 'var(--surface-hover)' : 'var(--surface-card)',
                  cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleStore(store)}
                  style={{ marginTop: '0.2rem' }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: '0.4rem',
                      fontWeight: 600,
                      fontSize: '0.86rem',
                    }}
                  >
                    <span>Apple {store.name}</span>
                    {store.distance ? (
                      <span className="badge badge-instock" style={{ fontSize: '0.7rem' }}>
                        {store.distance}
                      </span>
                    ) : (
                      <span className="sku-mono">{store.id}</span>
                    )}
                  </div>
                  <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)' }}>
                    {[store.city, store.stateCode || store.state, store.postalCode]
                      .filter(Boolean)
                      .join(', ')}
                  </div>
                </div>
              </label>
            );
          })}
          {displayedStores.length === 0 ? (
            <div style={{ color: 'var(--text-secondary)', padding: '1rem', fontSize: '0.875rem' }}>
              No stores match the current filter.
            </div>
          ) : null}
        </div>
      </div>
    </ModalDialog>
  );
}
