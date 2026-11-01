import React, { useEffect, useMemo, useState } from 'react';
import { Check, Loader2, Plus, RefreshCw, Search, Star } from 'lucide-react';
import {
  ALL_CATEGORIES,
  type AppStateSnapshot,
  type CatalogProduct,
  type Category,
  CATEGORY_LABELS,
} from '../../shared/types.js';
import { api } from '../api.js';
import { ModalDialog } from './ModalDialog.js';

interface ProductBrowserModalProps {
  open: boolean;
  onClose: () => void;
  snapshot: AppStateSnapshot;
  onSnapshotUpdated: (snap: AppStateSnapshot) => void;
}

export function ProductBrowserModal({
  open,
  onClose,
  snapshot,
  onSnapshotUpdated,
}: ProductBrowserModalProps): React.ReactElement {
  const [mode, setMode] = useState<'catalog' | 'custom'>('catalog');
  const [catalog, setCatalog] = useState<CatalogProduct[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshingLive, setRefreshingLive] = useState(false);
  const [activeCategory, setActiveCategory] = useState<Category>('iphone');
  const [selectedFamilies, setSelectedFamilies] = useState<Set<string>>(new Set());
  const [selectedCapacities, setSelectedCapacities] = useState<Set<string>>(new Set());
  const [selectedColors, setSelectedColors] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedParts, setSelectedParts] = useState<Map<string, CatalogProduct>>(new Map());
  const [markFavorite, setMarkFavorite] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  // Custom / BTO form state
  const [customPart, setCustomPart] = useState('');
  const [customTitle, setCustomTitle] = useState('');
  const [customCategory, setCustomCategory] = useState<Category>('mac');
  const [customCompanion, setCustomCompanion] = useState('');

  const watchedPartSet = useMemo(
    () => new Set(snapshot.productSummaries.map((s) => s.product.partNumber.toUpperCase())),
    [snapshot.productSummaries]
  );

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setFeedback(null);
    setSelectedParts(new Map());
    void api
      .getCatalog(snapshot.settings.locale)
      .then((res) => setCatalog(res.products))
      .catch((err) => setFeedback((err as Error).message))
      .finally(() => setLoading(false));
  }, [open, snapshot.settings.locale]);

  const categoryCounts = useMemo(() => {
    const map = new Map<Category, number>();
    for (const c of ALL_CATEGORIES) map.set(c, 0);
    for (const p of catalog) {
      map.set(p.category, (map.get(p.category) ?? 0) + 1);
    }
    return map;
  }, [catalog]);

  const categoryProducts = useMemo(
    () => catalog.filter((p) => p.category === activeCategory),
    [catalog, activeCategory]
  );

  const availableFamilies = useMemo(() => {
    const set = new Set<string>();
    for (const p of categoryProducts) {
      if (p.familyLabel) set.add(p.familyLabel);
    }
    return Array.from(set);
  }, [categoryProducts]);

  const familyFiltered = useMemo(() => {
    if (selectedFamilies.size === 0) return categoryProducts;
    return categoryProducts.filter((p) => selectedFamilies.has(p.familyLabel));
  }, [categoryProducts, selectedFamilies]);

  const availableCapacities = useMemo(() => {
    const set = new Set<string>();
    for (const p of familyFiltered) {
      if (p.capacity) set.add(p.capacity);
    }
    return Array.from(set);
  }, [familyFiltered]);

  const capacityFiltered = useMemo(() => {
    if (selectedCapacities.size === 0) return familyFiltered;
    return familyFiltered.filter((p) => selectedCapacities.has(p.capacity));
  }, [familyFiltered, selectedCapacities]);

  const availableColors = useMemo(() => {
    const set = new Set<string>();
    for (const p of capacityFiltered) {
      if (p.color) set.add(p.color);
    }
    return Array.from(set);
  }, [capacityFiltered]);

  const matchingProducts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return capacityFiltered.filter((p) => {
      if (selectedColors.size > 0 && !selectedColors.has(p.color)) return false;
      if (!q) return true;
      return (
        p.title.toLowerCase().includes(q) ||
        p.partNumber.toLowerCase().includes(q) ||
        p.familyLabel.toLowerCase().includes(q) ||
        p.color.toLowerCase().includes(q)
      );
    });
  }, [capacityFiltered, selectedColors, searchQuery]);

  const handleCategoryChange = (cat: Category) => {
    setActiveCategory(cat);
    setSelectedFamilies(new Set());
    setSelectedCapacities(new Set());
    setSelectedColors(new Set());
  };

  const toggleSetValue = (
    setter: React.Dispatch<React.SetStateAction<Set<string>>>,
    val: string
  ) => {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(val)) next.delete(val);
      else next.add(val);
      return next;
    });
  };

  const toggleProduct = (prod: CatalogProduct) => {
    setSelectedParts((prev) => {
      const next = new Map(prev);
      if (next.has(prod.partNumber)) next.delete(prod.partNumber);
      else next.set(prod.partNumber, prod);
      return next;
    });
  };

  const selectAllMatching = () => {
    setSelectedParts((prev) => {
      const next = new Map(prev);
      for (const p of matchingProducts) {
        if (!watchedPartSet.has(p.partNumber.toUpperCase())) {
          next.set(p.partNumber, p);
        }
      }
      return next;
    });
  };

  const handleRefreshLive = async () => {
    setRefreshingLive(true);
    setFeedback(null);
    try {
      const res = await api.refreshLiveCatalog(snapshot.settings.locale, activeCategory);
      const full = await api.getCatalog(snapshot.settings.locale);
      setCatalog(full.products);
      const warn = res.failures.length > 0 ? ` (${res.failures.length} page warnings)` : '';
      setFeedback(
        `Refreshed ${CATEGORY_LABELS[activeCategory]} live from Apple.com: ${res.productsFound} configurations across ${res.refreshedPages} buy pages${warn}.`
      );
    } catch (err) {
      setFeedback(`Live refresh error: ${(err as Error).message}`);
    } finally {
      setRefreshingLive(false);
    }
  };

  const handleAddSelected = async () => {
    if (mode === 'custom') {
      const part = customPart.trim().toUpperCase();
      if (!part) {
        setFeedback('Enter an Apple Part Number / SKU (for example MJQ34LL/A or Z19E0006D).');
        return;
      }
      setSaving(true);
      try {
        const nextSnap = await api.addToWatchlist([
          {
            partNumber: part,
            title: customTitle.trim() || undefined,
            category: customCategory,
            companionPart: customCompanion.trim() || undefined,
            favorite: markFavorite,
          },
        ]);
        onSnapshotUpdated(nextSnap);
        setCustomPart('');
        setCustomTitle('');
        setCustomCompanion('');
        onClose();
      } catch (err) {
        setFeedback((err as Error).message);
      } finally {
        setSaving(false);
      }
      return;
    }

    if (selectedParts.size === 0) return;
    setSaving(true);
    try {
      const items = Array.from(selectedParts.values()).map((p) => ({
        ...p,
        favorite: markFavorite,
      }));
      const nextSnap = await api.addToWatchlist(items);
      onSnapshotUpdated(nextSnap);
      onClose();
    } catch (err) {
      setFeedback((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalDialog
      open={open}
      title="Add Products & Configurations to Watch"
      onClose={onClose}
      footer={
        <>
          <label className="switch-label">
            <Star size={15} />
            Mark as Priority Favorite
            <input
              type="checkbox"
              {...({ switch: '' } as Record<string, string>)}
              checked={markFavorite}
              onChange={(e) => setMarkFavorite(e.target.checked)}
            />
          </label>
          <div style={{ display: 'flex', gap: '0.6rem' }}>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={saving || (mode === 'catalog' && selectedParts.size === 0)}
              onClick={handleAddSelected}
            >
              {saving ? <Loader2 size={15} className="spin" /> : <Plus size={15} />}
              {mode === 'custom'
                ? 'Add Custom SKU'
                : `Watch ${selectedParts.size} Configuration${selectedParts.size === 1 ? '' : 's'}`}
            </button>
          </div>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.6rem' }}>
          <div className="nav-tabs">
            <button
              type="button"
              className="nav-tab"
              aria-current={mode === 'catalog' ? 'page' : undefined}
              onClick={() => setMode('catalog')}
            >
              Available Catalog ({catalog.length})
            </button>
            <button
              type="button"
              className="nav-tab"
              aria-current={mode === 'custom' ? 'page' : undefined}
              onClick={() => setMode('custom')}
            >
              Custom / BTO Part Number
            </button>
          </div>

          {mode === 'catalog' ? (
            <button
              type="button"
              className="btn btn-sm"
              disabled={refreshingLive}
              onClick={handleRefreshLive}
            >
              <RefreshCw size={14} className={refreshingLive ? 'spin' : ''} />
              Refresh {CATEGORY_LABELS[activeCategory]} Live from Apple
            </button>
          ) : null}
        </div>

        {feedback ? (
          <div className="banner banner-warn" style={{ marginBottom: 0 }}>
            <span>{feedback}</span>
          </div>
        ) : null}

        {mode === 'custom' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
            <p className="field-hint">
              Enter any retail or build-to-order (BTO) Apple part number directly if you want to monitor a custom Mac configuration or newly launched SKU before it appears in buy pages.
            </p>
            <div className="field-group">
              <label htmlFor="custom-part-input" className="field-label">
                Apple Part Number / SKU
              </label>
              <input
                id="custom-part-input"
                type="text"
                className="input"
                autoFocus
                placeholder="e.g. MJQ34LL/A"
                value={customPart}
                onChange={(e) => setCustomPart(e.target.value)}
              />
            </div>
            <div className="field-group">
              <label htmlFor="custom-title-input" className="field-label">
                Display Label (Optional)
              </label>
              <input
                id="custom-title-input"
                type="text"
                className="input"
                placeholder="e.g. MacBook Pro 16 M5 Max 64GB / 2TB"
                value={customTitle}
                onChange={(e) => setCustomTitle(e.target.value)}
              />
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                gap: '0.85rem',
              }}
            >
              <div className="field-group">
                <label htmlFor="custom-cat-select" className="field-label">
                  Product Category
                </label>
                <select
                  id="custom-cat-select"
                  className="select"
                  value={customCategory}
                  onChange={(e) => setCustomCategory(e.target.value as Category)}
                >
                  {ALL_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {CATEGORY_LABELS[c]}
                    </option>
                  ))}
                </select>
              </div>
              {customCategory === 'watch' ? (
                <div className="field-group">
                  <label htmlFor="custom-companion-input" className="field-label">
                    Companion Band Part Number (Optional)
                  </label>
                  <input
                    id="custom-companion-input"
                    type="text"
                    className="input"
                    placeholder="e.g. MJVK4AM/A"
                    value={customCompanion}
                    onChange={(e) => setCustomCompanion(e.target.value)}
                  />
                </div>
              ) : null}
            </div>
          </div>
        ) : (
          <>
            {/* 7 Apple Category Tabs */}
            <div className="chip-row">
              {ALL_CATEGORIES.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  className="chip-btn"
                  aria-pressed={activeCategory === cat}
                  onClick={() => handleCategoryChange(cat)}
                >
                  {CATEGORY_LABELS[cat]} ({categoryCounts.get(cat) ?? 0})
                </button>
              ))}
            </div>

            {/* Cascading Filters: Model Family -> Capacity -> Color */}
            {availableFamilies.length > 1 ? (
              <div className="field-group">
                <span className="field-label">Model</span>
                <div className="chip-row">
                  {availableFamilies.map((fam) => (
                    <button
                      key={fam}
                      type="button"
                      className="chip-btn"
                      aria-pressed={selectedFamilies.has(fam)}
                      onClick={() => toggleSetValue(setSelectedFamilies, fam)}
                    >
                      {fam}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {availableCapacities.length > 1 ? (
              <div className="field-group">
                <span className="field-label">Capacity / Storage</span>
                <div className="chip-row">
                  {availableCapacities.map((cap) => (
                    <button
                      key={cap}
                      type="button"
                      className="chip-btn"
                      aria-pressed={selectedCapacities.has(cap)}
                      onClick={() => toggleSetValue(setSelectedCapacities, cap)}
                    >
                      {cap}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {availableColors.length > 1 ? (
              <div className="field-group">
                <span className="field-label">Finish / Color</span>
                <div className="chip-row">
                  {availableColors.map((col) => (
                    <button
                      key={col}
                      type="button"
                      className="chip-btn"
                      aria-pressed={selectedColors.has(col)}
                      onClick={() => toggleSetValue(setSelectedColors, col)}
                    >
                      {col}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {/* Search & Batch Select Controls */}
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '0.6rem',
              }}
            >
              <div style={{ position: 'relative', flex: '1 1 260px' }}>
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
                  autoFocus
                  style={{ paddingLeft: '2.1rem' }}
                  placeholder="Search configuration, chip, size, or SKU..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              <div style={{ display: 'flex', gap: '0.45rem' }}>
                <button type="button" className="btn btn-sm" onClick={selectAllMatching}>
                  Select Matching ({matchingProducts.length})
                </button>
                {selectedParts.size > 0 ? (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setSelectedParts(new Map())}
                  >
                    Clear Selection ({selectedParts.size})
                  </button>
                ) : null}
              </div>
            </div>

            {/* Product Results List */}
            {loading ? (
              <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
                <Loader2 size={22} className="spin" />
              </div>
            ) : (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.45rem',
                  maxHeight: '300px',
                  overflowY: 'auto',
                  padding: '0.15rem',
                }}
              >
                {matchingProducts.map((prod) => {
                  const alreadyWatched = watchedPartSet.has(prod.partNumber.toUpperCase());
                  const checked = selectedParts.has(prod.partNumber);
                  return (
                    <label
                      key={prod.partNumber}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '0.75rem',
                        padding: '0.6rem 0.85rem',
                        borderRadius: '10px',
                        border: `1px solid ${checked ? 'var(--color-accent)' : 'var(--border-subtle)'}`,
                        background: checked ? 'var(--surface-hover)' : 'var(--surface-card)',
                        cursor: alreadyWatched ? 'default' : 'pointer',
                        opacity: alreadyWatched ? 0.72 : 1,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', minWidth: 0 }}>
                        <input
                          type="checkbox"
                          disabled={alreadyWatched}
                          checked={checked || alreadyWatched}
                          onChange={() => toggleProduct(prod)}
                        />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 600, fontSize: '0.88rem' }}>{prod.title}</div>
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                            {[prod.familyLabel, prod.capacity, prod.color]
                              .filter(Boolean)
                              .join(' · ')}
                          </div>
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', flexShrink: 0 }}>
                        {alreadyWatched ? (
                          <span className="badge badge-instock">
                            <Check size={12} /> Watching
                          </span>
                        ) : null}
                        <span className="sku-mono">{prod.partNumber}</span>
                      </div>
                    </label>
                  );
                })}
                {matchingProducts.length === 0 ? (
                  <div style={{ padding: '1.2rem', color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                    No configurations match your current filter selection.
                  </div>
                ) : null}
              </div>
            )}
          </>
        )}
      </div>
    </ModalDialog>
  );
}
