import React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  ExternalLink,
  HelpCircle,
  MapPin,
  PackagePlus,
  Star,
  Store,
  Trash2,
} from 'lucide-react';
import {
  type AppStateSnapshot,
  CATEGORY_LABELS,
  type TargetState,
} from '../../shared/types.js';
import { api } from '../api.js';

interface DashboardViewProps {
  snapshot: AppStateSnapshot;
  nowMs: number;
  onSnapshotUpdated: (snap: AppStateSnapshot) => void;
  onOpenAreaModal: () => void;
  onOpenProductsModal: () => void;
}

export function formatDurationCompact(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins < 60) return `${mins}m ${secs}s`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hrs}h ${remMins}m`;
}

function describeStoreTileStatus(st: TargetState): {
  label: string;
  sublabel: string;
  tileClass: string;
} {
  if (st.status === 'in_stock') {
    return {
      label: 'In Stock',
      sublabel: st.pickupQuote || 'Available for Pickup',
      tileClass: 'store-status-tile tile-instock',
    };
  }
  if (st.status === 'out_of_stock') {
    return {
      label: 'Out of Stock',
      sublabel: st.pickupQuote || 'Unavailable',
      tileClass: 'store-status-tile',
    };
  }
  switch (st.unknownReason) {
    case 'not_yet_checked':
      return {
        label: 'Pending',
        sublabel: 'Awaiting first check',
        tileClass: 'store-status-tile',
      };
    case 'pickup_not_open':
      return {
        label: 'Not Open Yet',
        sublabel: 'Pre-launch / pickup closed',
        tileClass: 'store-status-tile tile-unknown',
      };
    case 'blocked':
      return {
        label: 'Unknown',
        sublabel: 'HTTP 541 edge cooldown',
        tileClass: 'store-status-tile tile-unknown',
      };
    case 'rate_limited':
      return {
        label: 'Unknown',
        sublabel: 'Rate limited',
        tileClass: 'store-status-tile tile-unknown',
      };
    default:
      return {
        label: 'Unknown',
        sublabel: st.unknownDetail || 'Check error',
        tileClass: 'store-status-tile tile-unknown',
      };
  }
}

export function DashboardView({
  snapshot,
  nowMs,
  onSnapshotUpdated,
  onOpenAreaModal,
  onOpenProductsModal,
}: DashboardViewProps): React.ReactElement {
  const { stats, watcher, settings, productSummaries, watchedStores } = snapshot;

  const handleToggleFavorite = async (partNumber: string, nextFav: boolean) => {
    try {
      const next = await api.toggleFavorite(partNumber, nextFav);
      onSnapshotUpdated(next);
    } catch {
      // Ignore transient UI error
    }
  };

  const handleRemove = async (partNumber: string) => {
    try {
      const next = await api.removeFromWatchlist(partNumber);
      onSnapshotUpdated(next);
    } catch {
      // Ignore transient UI error
    }
  };

  const needsStores = watchedStores.length === 0;
  const needsProducts = productSummaries.length === 0;

  return (
    <div>
      {watcher.healthState === 'cooldown_541' && watcher.healthMessage ? (
        <div className="banner banner-warn">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <AlertTriangle size={18} style={{ flexShrink: 0 }} />
            <span>{watcher.healthMessage}</span>
          </div>
        </div>
      ) : null}

      {watcher.healthState === 'degraded' && watcher.healthMessage ? (
        <div className="banner banner-danger">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <AlertTriangle size={18} style={{ flexShrink: 0 }} />
            <span>
              <strong>Apple Check Degraded:</strong> {watcher.healthMessage}
            </span>
          </div>
        </div>
      ) : null}

      {/* Top Summary Cards */}
      <div className="stats-grid">
        <div
          className={`stat-card ${stats.inStockProductsCount > 0 ? 'highlight-instock' : ''}`}
        >
          <span className="stat-label">Currently In Stock</span>
          <span className="stat-value">
            {stats.inStockProductsCount} / {stats.watchedProductsCount}
          </span>
          <span className="stat-meta">
            {stats.inStockPairsCount} store-product match
            {stats.inStockPairsCount === 1 ? '' : 'es'} available now
          </span>
        </div>

        <div className="stat-card">
          <span className="stat-label">Area Stores Watched</span>
          <span className="stat-value">{stats.watchedStoresCount}</span>
          <span className="stat-meta">
            {settings.pickupLocation
              ? `Area: ${settings.pickupLocation} (${settings.locale})`
              : `Region: ${settings.locale}`}
          </span>
        </div>

        <div className="stat-card">
          <span className="stat-label">Restocks Detected</span>
          <span className="stat-value">{stats.totalRestocksFound}</span>
          <span className="stat-meta">
            {stats.totalNotificationsSent} Pushover alert
            {stats.totalNotificationsSent === 1 ? '' : 's'} delivered
          </span>
        </div>

        <div className="stat-card">
          <span className="stat-label">IP Request Budget</span>
          <span className="stat-value">
            {watcher.budgetAvailableTokens} / {watcher.budgetCapacity}
          </span>
          <span className="stat-meta">
            Effective cadence ~{Math.round(watcher.effectiveIntervalMs / 1000)}s
          </span>
        </div>
      </div>

      {/* Onboarding / Empty State */}
      {needsStores || needsProducts ? (
        <div
          className="product-card"
          style={{
            padding: '1.75rem',
            marginBottom: '1.25rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '1rem',
          }}
        >
          <div>
            <h2 style={{ margin: '0 0 0.35rem', fontSize: '1.15rem' }}>
              Finish Setting Up Your Stock Monitor
            </h2>
            <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
              Select the Apple Retail Stores in your area and pick the product configurations you want to monitor. Once both are set, turn on Auto-Check in the top bar.
            </p>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem' }}>
            <button
              type="button"
              className={`btn ${needsStores ? 'btn-primary' : ''}`}
              onClick={onOpenAreaModal}
            >
              <MapPin size={16} />
              {needsStores
                ? 'Step 1: Select Area & Nearby Stores'
                : `Area Configured (${watchedStores.length} Stores)`}
            </button>
            <button
              type="button"
              className={`btn ${!needsStores && needsProducts ? 'btn-primary' : ''}`}
              onClick={onOpenProductsModal}
            >
              <PackagePlus size={16} />
              {needsProducts
                ? 'Step 2: Choose Products to Watch'
                : `Watching ${productSummaries.length} Products`}
            </button>
          </div>
        </div>
      ) : null}

      {/* Watched Products Cards */}
      {productSummaries.length > 0 ? (
        <div className="product-list">
          {productSummaries.map((summary) => {
            const { product, inStockStoreCount, totalWatchedStores, storeStates } = summary;
            const isInStock = inStockStoreCount > 0;

            return (
              <article
                key={product.partNumber}
                className={`product-card ${isInStock ? 'is-instock' : ''}`}
              >
                <div className="product-card-header">
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                    <div className="product-title-row">
                      <button
                        type="button"
                        className="btn btn-icon"
                        aria-label={
                          product.favorite ? 'Remove favorite priority' : 'Mark as priority favorite'
                        }
                        title={
                          product.favorite
                            ? 'Priority Favorite (uses Favorite Pushover sound/priority)'
                            : 'Click to mark as Priority Favorite'
                        }
                        onClick={() =>
                          handleToggleFavorite(product.partNumber, !product.favorite)
                        }
                        style={{
                          color: product.favorite ? '#f59e0b' : 'var(--text-muted)',
                          borderColor: 'transparent',
                          background: 'transparent',
                          padding: '0.2rem',
                        }}
                      >
                        <Star
                          size={18}
                          fill={product.favorite ? '#f59e0b' : 'none'}
                        />
                      </button>

                      <h3 className="product-title">{product.title}</h3>
                      <span className="sku-mono">{product.partNumber}</span>
                      <span className="badge badge-oos">
                        {CATEGORY_LABELS[product.category]}
                      </span>
                    </div>

                    <div
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        alignItems: 'center',
                        gap: '0.55rem',
                        fontSize: '0.8rem',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      {/* Area Store Stock Count Badge */}
                      <span
                        className={`badge ${
                          isInStock ? 'badge-instock' : 'badge-oos'
                        }`}
                      >
                        {isInStock ? <CheckCircle2 size={13} /> : <Store size={13} />}
                        {inStockStoreCount} / {totalWatchedStores} area store
                        {totalWatchedStores === 1 ? '' : 's'} in stock
                      </span>

                      {isInStock && summary.activeRestockSinceMs ? (
                        <span className="badge badge-instock">
                          <Clock size={12} />
                          In stock for{' '}
                          {formatDurationCompact(nowMs - summary.activeRestockSinceMs)}
                        </span>
                      ) : null}

                      {product.companionPart ? (
                        <span title="Apple Watch companion band SKU queried automatically">
                          Band SKU: <code>{product.companionPart}</code>
                        </span>
                      ) : null}
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    {product.buyUrl ? (
                      <a
                        href={product.buyUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={`btn btn-sm ${isInStock ? 'btn-primary' : ''}`}
                      >
                        Buy on Apple.com
                        <ExternalLink size={13} />
                      </a>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn-sm btn-icon"
                      aria-label={`Remove ${product.title}`}
                      title="Stop watching this configuration"
                      onClick={() => handleRemove(product.partNumber)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>

                {/* Per-Store Availability Breakdown */}
                {storeStates.length > 0 ? (
                  <div className="store-pills-grid">
                    {storeStates.map((st) => {
                      const info = describeStoreTileStatus(st);
                      return (
                        <div key={st.storeId} className={info.tileClass}>
                          <div style={{ minWidth: 0 }}>
                            <div
                              style={{
                                fontWeight: 600,
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                              }}
                            >
                              Apple {st.storeName}
                            </div>
                            <div
                              style={{
                                fontSize: '0.73rem',
                                opacity: 0.85,
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                              }}
                            >
                              {st.storeCity ? `${st.storeCity} · ` : ''}
                              {info.sublabel}
                            </div>
                          </div>
                          <span
                            style={{
                              fontWeight: 700,
                              fontSize: '0.75rem',
                              flexShrink: 0,
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '0.25rem',
                            }}
                          >
                            {st.status === 'unknown' ? <HelpCircle size={13} /> : null}
                            {info.label}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                    No stores selected yet — click &ldquo;Area &amp; Stores&rdquo; above to pick nearby Apple Stores.
                  </div>
                )}
              </article>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
