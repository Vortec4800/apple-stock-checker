import { EventEmitter } from 'node:events';
import {
  type AppSettings,
  type AppStateSnapshot,
  type DashboardStats,
  type ProductSummary,
  type StoreInfo,
  type WatchedProduct,
  type WatcherHealth,
} from '../shared/types.js';
import {
  AppleRetailClient,
  buildPartBatches,
  type ParsedPartAvailability,
} from './apple-client.js';
import type { CatalogService } from './catalog-service.js';
import {
  type AppDatabase,
  type StoredTargetRecord,
  toPublicTargetState,
} from './db.js';
import type { PushoverService } from './pushover.js';

export interface CycleTargetObservation {
  store: StoreInfo;
  product: WatchedProduct;
  availability: ParsedPartAvailability;
}

interface PendingNotification {
  kind: 'restock' | 'repeat';
  product: WatchedProduct;
  stores: Array<{ store: StoreInfo; quote: string }>;
  areaInStockCount: number;
  areaTotalStores: number;
}

/**
 * Pure state-transition processor for a batch of `(product, store)` observations in one check cycle.
 * Exported so unit tests can verify restock duration & transient-unknown behavior deterministically.
 */
export function applyCycleObservations(params: {
  db: AppDatabase;
  settings: AppSettings;
  watchedStores: StoreInfo[];
  watchedProducts: WatchedProduct[];
  observations: CycleTargetObservation[];
  now: number;
}): PendingNotification[] {
  const { db, settings, watchedStores, watchedProducts, observations, now } = params;
  const totalAreaStores = watchedStores.length;

  // Group observations by product so we know the exact area store count after updating states
  const byPart = new Map<string, CycleTargetObservation[]>();
  for (const obs of observations) {
    const list = byPart.get(obs.product.partNumber) ?? [];
    list.push(obs);
    byPart.set(obs.product.partNumber, list);
  }

  const allRecords = db.getAllTargetRecords();
  const notifications: PendingNotification[] = [];

  for (const product of watchedProducts) {
    const prodObs = byPart.get(product.partNumber);
    if (!prodObs || prodObs.length === 0) continue;

    const newlyRestockedStores: Array<{ store: StoreInfo; quote: string; recordKey: string }> = [];
    const repeatAlertStores: Array<{ store: StoreInfo; quote: string; recordKey: string }> = [];
    const newlyOpenedEventIds: number[] = [];
    const existingOpenEventIds: Array<{ eventId: number; quote: string }> = [];

    for (const { store, availability } of prodObs) {
      const key = `${product.partNumber}::${store.id}`;
      const prev = allRecords.get(key);
      const prevStatus = prev?.status ?? 'unknown';

      if (availability.status === 'in_stock') {
        const isNewRestock = !prev || prev.activeRestockEventId === null;
        if (isNewRestock) {
          const eventId = db.openRestockEvent({
            partNumber: product.partNumber,
            productTitle: product.title,
            storeId: store.id,
            storeName: store.name,
            storeCity: store.city,
            quote: availability.pickupQuote || 'Available for Pickup',
            areaInStockCount: 1,
            areaTotalStores: totalAreaStores,
            firstSeenMs: now,
          });
          newlyOpenedEventIds.push(eventId);

          const updated: StoredTargetRecord = {
            partNumber: product.partNumber,
            storeId: store.id,
            status: 'in_stock',
            pickupQuote: availability.pickupQuote,
            storePickupProductTitle: availability.storePickupProductTitle,
            lastCheckedMs: now,
            lastStatusChangeMs: prevStatus === 'in_stock' ? prev?.lastStatusChangeMs ?? now : now,
            inStockSinceMs: now,
            activeRestockEventId: eventId,
            alertsSentCount: 1,
            lastAlertSentMs: now,
          };
          allRecords.set(key, updated);
          db.upsertTargetRecord(updated);
          newlyRestockedStores.push({
            store,
            quote: availability.pickupQuote || 'Available Today',
            recordKey: key,
          });
        } else {
          // Already had an open restock (either stayed in_stock or recovered from transient unknown!)
          const eventId = prev.activeRestockEventId!;
          existingOpenEventIds.push({
            eventId,
            quote: availability.pickupQuote || prev.pickupQuote || '',
          });

          let alertsSent = prev.alertsSentCount;
          let lastAlertMs = prev.lastAlertSentMs;
          const repeatDue =
            settings.alertRepeatMode === 'repeat_while_in_stock' &&
            alertsSent < settings.maxAlertsPerRestock &&
            now - (lastAlertMs ?? prev.inStockSinceMs ?? now) >=
              settings.repeatIntervalMinutes * 60_000;

          if (repeatDue) {
            alertsSent += 1;
            lastAlertMs = now;
            repeatAlertStores.push({
              store,
              quote: availability.pickupQuote || 'Available Today',
              recordKey: key,
            });
          }

          const updated: StoredTargetRecord = {
            partNumber: product.partNumber,
            storeId: store.id,
            status: 'in_stock',
            pickupQuote: availability.pickupQuote ?? prev.pickupQuote,
            storePickupProductTitle:
              availability.storePickupProductTitle ?? prev.storePickupProductTitle,
            lastCheckedMs: now,
            lastStatusChangeMs: prevStatus === 'in_stock' ? prev.lastStatusChangeMs : now,
            inStockSinceMs: prev.inStockSinceMs ?? now,
            activeRestockEventId: eventId,
            alertsSentCount: alertsSent,
            lastAlertSentMs: lastAlertMs,
          };
          allRecords.set(key, updated);
          db.upsertTargetRecord(updated);
        }
      } else if (availability.status === 'out_of_stock') {
        // Explicit out_of_stock closes any active restock event and records exact duration!
        if (prev?.activeRestockEventId !== null && prev?.activeRestockEventId !== undefined) {
          db.closeRestockEvent(prev.activeRestockEventId, now);
        }
        const updated: StoredTargetRecord = {
          partNumber: product.partNumber,
          storeId: store.id,
          status: 'out_of_stock',
          pickupQuote: availability.pickupQuote,
          storePickupProductTitle:
            availability.storePickupProductTitle ?? prev?.storePickupProductTitle,
          lastCheckedMs: now,
          lastStatusChangeMs:
            prevStatus === 'out_of_stock' ? prev?.lastStatusChangeMs ?? now : now,
          inStockSinceMs: null,
          activeRestockEventId: null,
          alertsSentCount: 0,
          lastAlertSentMs: null,
        };
        allRecords.set(key, updated);
        db.upsertTargetRecord(updated);
      } else {
        // CRITICAL INVARIANT: `unknown` (network error, HTTP 541 block, rate limit, schema drift)
        // NEVER closes an active restock or clears alert counters!
        const updated: StoredTargetRecord = {
          partNumber: product.partNumber,
          storeId: store.id,
          status: 'unknown',
          unknownReason: availability.unknownReason ?? 'network_error',
          unknownDetail: availability.unknownDetail ?? 'Unable to verify availability',
          pickupQuote: prev?.pickupQuote,
          storePickupProductTitle: prev?.storePickupProductTitle,
          lastCheckedMs: now,
          lastStatusChangeMs: prevStatus === 'unknown' ? prev?.lastStatusChangeMs ?? now : now,
          inStockSinceMs: prev?.inStockSinceMs ?? null,
          activeRestockEventId: prev?.activeRestockEventId ?? null,
          alertsSentCount: prev?.alertsSentCount ?? 0,
          lastAlertSentMs: prev?.lastAlertSentMs ?? null,
        };
        allRecords.set(key, updated);
        db.upsertTargetRecord(updated);
      }
    }

    // Compute total watched stores currently in_stock for this product
    let areaInStockCount = 0;
    for (const st of watchedStores) {
      const rec = allRecords.get(`${product.partNumber}::${st.id}`);
      if (rec?.status === 'in_stock') {
        areaInStockCount++;
      }
    }

    for (const eid of newlyOpenedEventIds) {
      db.updateRestockEventPeak(eid, areaInStockCount, totalAreaStores);
    }
    for (const { eventId, quote } of existingOpenEventIds) {
      db.updateRestockEventPeak(eventId, areaInStockCount, totalAreaStores, quote);
    }

    if (newlyRestockedStores.length > 0) {
      notifications.push({
        kind: 'restock',
        product,
        stores: newlyRestockedStores.map((s) => ({ store: s.store, quote: s.quote })),
        areaInStockCount,
        areaTotalStores: totalAreaStores,
      });
    } else if (repeatAlertStores.length > 0) {
      notifications.push({
        kind: 'repeat',
        product,
        stores: repeatAlertStores.map((s) => ({ store: s.store, quote: s.quote })),
        areaInStockCount,
        areaTotalStores: totalAreaStores,
      });
    }
  }

  return notifications;
}

/**
 * Applies additive-only timing jitter so `baseIntervalMs` serves as a strict minimum floor
 * and random jitter only adds `[0, +jitterPercent%]` on top of the floor.
 */
export function computeAdditiveJitterDelayMs(
  baseIntervalMs: number,
  jitterPercent: number,
  randomFn: () => number = Math.random
): number {
  const floorMs = Math.max(10_000, Math.round(baseIntervalMs));
  const jitterRatio = Math.max(0, jitterPercent) / 100;
  const clampedRand = Math.min(1, Math.max(0, randomFn()));
  return Math.round(floorMs * (1 + clampedRand * jitterRatio));
}

export class WatcherEngine extends EventEmitter {
  private readonly db: AppDatabase;
  private readonly catalog: CatalogService;
  private readonly appleClient: AppleRetailClient;
  private readonly pushover: PushoverService;

  private running = false;
  private disposed = false;
  private checkingNow = false;
  private timer: NodeJS.Timeout | null = null;
  private lastCheckStartedMs: number | null = null;
  private lastCheckFinishedMs: number | null = null;
  private nextCheckAtMs: number | null = null;
  private effectiveIntervalMs = 120_000;
  private consecutiveFailures = 0;
  private lastErrorSummary: string | null = null;
  private lastGlobalAlertSentMs = 0;

  constructor(deps: {
    db: AppDatabase;
    catalog: CatalogService;
    appleClient: AppleRetailClient;
    pushover: PushoverService;
  }) {
    super();
    this.db = deps.db;
    this.catalog = deps.catalog;
    this.appleClient = deps.appleClient;
    this.pushover = deps.pushover;

    const settings = this.db.getSettings();
    this.appleClient.configureRoutes(settings.proxies);

    // Resume watcher automatically on container boot if it was previously running
    if (this.db.getWatcherRunningPreference()) {
      this.start();
    }
  }

  public start(): void {
    if (this.running) return;
    this.running = true;
    this.db.setWatcherRunningPreference(true);
    this.emitState();
    void this.runCycleAndSchedule();
  }

  public stop(): void {
    if (this.disposed) return;
    this.running = false;
    this.db.setWatcherRunningPreference(false);
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.nextCheckAtMs = null;
    this.emitState();
  }

  public dispose(): void {
    this.disposed = true;
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.nextCheckAtMs = null;
    this.removeAllListeners();
  }

  public async triggerCheckNow(): Promise<void> {
    if (this.checkingNow) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.executeSingleCycle();
    if (this.running) {
      this.scheduleNext();
    }
    this.emitState();
  }

  public onConfigurationChanged(): void {
    const settings = this.db.getSettings();
    this.appleClient.configureRoutes(settings.proxies);
    if (this.running && !this.checkingNow) {
      if (this.timer) clearTimeout(this.timer);
      this.scheduleNext();
    }
    this.emitState();
  }

  private async runCycleAndSchedule(): Promise<void> {
    if (!this.running) return;
    await this.executeSingleCycle();
    if (this.running) {
      this.scheduleNext();
    }
  }

  private estimateRequestsPerCycle(
    settings: AppSettings,
    stores: StoreInfo[],
    products: WatchedProduct[]
  ): number {
    if (stores.length === 0 || products.length === 0) return 0;
    const batches = buildPartBatches(products, 'https://www.apple.com');
    if (settings.useLocationBatching && settings.pickupLocation.trim()) {
      return batches.length;
    }
    return batches.length * stores.length;
  }

  private computeNextDelayMs(): number {
    const now = Date.now();
    const settings = this.db.getSettings();
    const stores = this.db.getWatchedStores(settings.locale);
    const products = this.db.getWatchedProducts(settings.locale);
    const reqCount = this.estimateRequestsPerCycle(settings, stores, products);

    const health = this.appleClient.getAggregateHealth(now);
    if (health.allCoolingDown && health.cooldownUntilMs !== null) {
      const cooldownJitterMs = 1_000 + Math.round(Math.random() * 4_000);
      const wait = Math.max(5_000, health.cooldownUntilMs - now + cooldownJitterMs);
      this.effectiveIntervalMs = wait;
      return wait;
    }

    let intervalMs = settings.pollIntervalSeconds * 1000;
    if (settings.adaptivePacing && reqCount > 0) {
      const routeCount = Math.max(1, settings.proxies.length || 1);
      // Sustainable token rate (~1 token per 120s per route, staying safely under ~30 req/hr)
      const sustainableFloorMs = Math.ceil((reqCount / routeCount) * 120_000);
      const tokenWaitMs = this.appleClient.recommendedWaitMsForRequests(reqCount, now);
      intervalMs = Math.max(intervalMs, Math.min(sustainableFloorMs, 600_000), tokenWaitMs);
    }

    this.effectiveIntervalMs = intervalMs;
    return computeAdditiveJitterDelayMs(intervalMs, settings.jitterPercent);
  }

  private scheduleNext(): void {
    if (!this.running || this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    const delayMs = this.computeNextDelayMs();
    this.nextCheckAtMs = Date.now() + delayMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runCycleAndSchedule();
    }, delayMs);
    this.timer.unref?.();
    this.emitState();
  }

  private async executeSingleCycle(): Promise<void> {
    if (this.checkingNow || this.disposed) return;
    const settings = this.db.getSettings();
    this.appleClient.configureRoutes(settings.proxies);
    const region = this.catalog.getRegion(settings.locale);
    const watchedStores = this.db.getWatchedStores(settings.locale);
    const watchedProducts = this.db.getWatchedProducts(settings.locale);

    // Ensure Apple Watch watched items get companionPart attached from catalog if missing
    for (const wp of watchedProducts) {
      if (wp.category === 'watch' && !wp.companionPart) {
        const catProd = this.catalog.findProductByPart(settings.locale, wp.partNumber);
        if (catProd?.companionPart) {
          wp.companionPart = catProd.companionPart;
        }
      }
    }

    if (watchedStores.length === 0 || watchedProducts.length === 0) {
      this.lastErrorSummary = null;
      this.emitState();
      return;
    }

    this.checkingNow = true;
    this.lastCheckStartedMs = Date.now();
    this.nextCheckAtMs = null;
    this.emitState();

    try {
      const defaultReferer = `${region.baseUrl}/shop/buy-iphone`;
      const batches = buildPartBatches(watchedProducts, defaultReferer);
      const productByPart = new Map(
        watchedProducts.map((p) => [p.partNumber.toUpperCase(), p])
      );

      const observations: CycleTargetObservation[] = [];
      let cycleHadSuccess = false;
      let cycleFirstFailure: string | null = null;

      // Single-probe protection: if recovering from HTTP 541, run first batch first;
      // if it fails with 541 again, abort remaining batches immediately!
      for (const batch of batches) {
        if (this.disposed) break;
        const uncoveredStores = new Map(watchedStores.map((s) => [s.id, s]));

        if (settings.useLocationBatching && settings.pickupLocation.trim()) {
          const locRes = await this.appleClient.fetchPickupBatch({
            region,
            queryParts: batch.queryParts,
            location: settings.pickupLocation.trim(),
            refererUrl: batch.refererUrl,
          });

          if (locRes.ok) {
            cycleHadSuccess = true;
            for (const store of watchedStores) {
              if (!locRes.coveredStoreIds.has(store.id)) continue;
              uncoveredStores.delete(store.id);
              for (const rawPart of batch.watchedParts) {
                const upper = rawPart.toUpperCase();
                const prod = productByPart.get(upper);
                if (!prod) continue;
                const avail = locRes.byStoreAndPart.get(`${store.id}::${upper}`) ?? {
                  status: 'unknown',
                  unknownReason: 'pickup_not_open',
                  unknownDetail: 'Part omitted from store availability map',
                };
                observations.push({ store, product: prod, availability: avail });
              }
            }
          } else {
            const err = locRes.envelopeError!;
            cycleFirstFailure = cycleFirstFailure ?? err.detail;
            for (const store of watchedStores) {
              uncoveredStores.delete(store.id);
              for (const rawPart of batch.watchedParts) {
                const prod = productByPart.get(rawPart.toUpperCase());
                if (!prod) continue;
                observations.push({
                  store,
                  product: prod,
                  availability: {
                    status: 'unknown',
                    unknownReason: err.reason,
                    unknownDetail: err.detail,
                  },
                });
              }
            }
            if (err.outcome === 'blocked_541' || err.outcome === 'rate_limited') {
              break;
            }
          }
        }

        // Fallback per-store queries for any watched store not covered by the location query
        for (const store of uncoveredStores.values()) {
          if (this.disposed) break;
          const storeRes = await this.appleClient.fetchPickupBatch({
            region,
            queryParts: batch.queryParts,
            storeId: store.id,
            refererUrl: batch.refererUrl,
          });

          if (storeRes.ok) {
            cycleHadSuccess = true;
            for (const rawPart of batch.watchedParts) {
              const upper = rawPart.toUpperCase();
              const prod = productByPart.get(upper);
              if (!prod) continue;
              const avail = storeRes.byStoreAndPart.get(`${store.id}::${upper}`) ?? {
                status: 'unknown',
                unknownReason: 'pickup_not_open',
                unknownDetail: 'Part omitted from store availability map',
              };
              observations.push({ store, product: prod, availability: avail });
            }
          } else {
            const err = storeRes.envelopeError!;
            cycleFirstFailure = cycleFirstFailure ?? err.detail;
            for (const rawPart of batch.watchedParts) {
              const prod = productByPart.get(rawPart.toUpperCase());
              if (!prod) continue;
              observations.push({
                store,
                product: prod,
                availability: {
                  status: 'unknown',
                  unknownReason: err.reason,
                  unknownDetail: err.detail,
                },
              });
            }
            if (err.outcome === 'blocked_541' || err.outcome === 'rate_limited') {
              break;
            }
          }
        }
      }

      if (this.disposed) return;

      const now = Date.now();
      const pendingAlerts = applyCycleObservations({
        db: this.db,
        settings,
        watchedStores,
        watchedProducts,
        observations,
        now,
      });

      if (cycleHadSuccess) {
        this.consecutiveFailures = 0;
        this.lastErrorSummary = cycleFirstFailure;
      } else if (cycleFirstFailure) {
        this.consecutiveFailures += 1;
        this.lastErrorSummary = cycleFirstFailure;
      }

      await this.dispatchAlerts(pendingAlerts, settings);
    } finally {
      this.checkingNow = false;
      this.lastCheckFinishedMs = Date.now();
      this.emitState();
    }
  }

  private async dispatchAlerts(
    alerts: PendingNotification[],
    settings: AppSettings
  ): Promise<void> {
    for (const item of alerts) {
      const gapMs = settings.minAlertGapSeconds * 1000;
      const wait = this.lastGlobalAlertSentMs + gapMs - Date.now();
      if (wait > 0) {
        await new Promise((r) => setTimeout(r, Math.min(wait, 5_000)));
      }

      const isFav = item.product.favorite;
      const priority = isFav ? settings.favoritePriority : settings.normalPriority;
      const sound = isFav ? settings.favoriteSound : settings.normalSound;

      const storeNames = item.stores
        .map((s) => `Apple ${s.store.name}${s.store.city ? ` (${s.store.city})` : ''} — ${s.quote}`)
        .join('\n');

      const prefix = item.kind === 'repeat' ? 'Still In Stock' : isFav ? '⭐ Favorite In Stock' : 'In Stock';
      const title = `${prefix}: ${item.product.title}`;
      const message = [
        `Area Count: ${item.areaInStockCount} / ${item.areaTotalStores} watched stores in stock`,
        `Part: ${item.product.partNumber}`,
        storeNames,
      ].join('\n');

      await this.pushover.send({
        kind: item.kind,
        partNumber: item.product.partNumber,
        productTitle: item.product.title,
        storeName: item.stores.map((s) => `Apple ${s.store.name}`).join(', '),
        title,
        message,
        buyUrl: item.product.buyUrl,
        priority,
        sound,
      });
      this.lastGlobalAlertSentMs = Date.now();
    }
  }

  public getWatcherHealth(now = Date.now()): WatcherHealth {
    const agg = this.appleClient.getAggregateHealth(now);
    let healthState: WatcherHealth['healthState'] = 'idle';
    let healthMessage: string | null = null;

    if (agg.allCoolingDown && agg.cooldownUntilMs !== null) {
      healthState = 'cooldown_541';
      const mins = Math.max(1, Math.ceil((agg.cooldownUntilMs - now) / 60_000));
      healthMessage = `Apple HTTP 541 edge cooldown active (Level ${agg.maxCooldownLevel}) — probing automatically in ~${mins} min. Existing in-stock states are preserved.`;
    } else if (this.consecutiveFailures >= 3) {
      healthState = 'degraded';
      healthMessage =
        this.lastErrorSummary ||
        `${this.consecutiveFailures} consecutive check cycles failed`;
    } else if (this.running || this.lastCheckFinishedMs !== null) {
      healthState = 'healthy';
      healthMessage = this.lastErrorSummary;
    }

    return {
      running: this.running,
      checkingNow: this.checkingNow,
      lastCheckStartedMs: this.lastCheckStartedMs,
      lastCheckFinishedMs: this.lastCheckFinishedMs,
      nextCheckAtMs: this.nextCheckAtMs,
      effectiveIntervalMs: this.effectiveIntervalMs,
      consecutiveFailures: this.consecutiveFailures,
      healthState,
      healthMessage,
      budgetAvailableTokens: agg.availableTokens,
      budgetCapacity: agg.totalCapacity,
      cooldownUntilMs: agg.cooldownUntilMs,
      cooldownLevel: agg.maxCooldownLevel,
    };
  }

  public getSnapshot(): AppStateSnapshot {
    const now = Date.now();
    const settings = this.db.getSettings();
    const watchedStores = this.db.getWatchedStores(settings.locale);
    const watchedProducts = this.db.getWatchedProducts(settings.locale);
    const allRecords = this.db.getAllTargetRecords();

    let inStockProductsCount = 0;
    let inStockPairsCount = 0;

    const productSummaries: ProductSummary[] = watchedProducts.map((product) => {
      let inStockStoreCount = 0;
      let outOfStockStoreCount = 0;
      let unknownStoreCount = 0;
      let earliestInStockMs: number | null = null;

      const storeStates = watchedStores.map((store) => {
        const rec = allRecords.get(`${product.partNumber}::${store.id}`);
        const pub = toPublicTargetState(store, product.partNumber, rec);
        if (pub.status === 'in_stock') {
          inStockStoreCount++;
          inStockPairsCount++;
          if (
            pub.inStockSinceMs !== null &&
            (earliestInStockMs === null || pub.inStockSinceMs < earliestInStockMs)
          ) {
            earliestInStockMs = pub.inStockSinceMs;
          }
        } else if (pub.status === 'out_of_stock') {
          outOfStockStoreCount++;
        } else {
          unknownStoreCount++;
        }
        return pub;
      });

      // Pin in-stock stores first inside each product card as well
      storeStates.sort((a, b) => {
        const rank = (s: string) => (s === 'in_stock' ? 0 : s === 'out_of_stock' ? 1 : 2);
        return rank(a.status) - rank(b.status) || a.storeName.localeCompare(b.storeName);
      });

      if (inStockStoreCount > 0) {
        inStockProductsCount++;
      }

      return {
        product,
        inStockStoreCount,
        totalWatchedStores: watchedStores.length,
        outOfStockStoreCount,
        unknownStoreCount,
        activeRestockSinceMs: earliestInStockMs,
        storeStates,
      };
    });

    // Sort: 1) In Stock products at top, 2) Favorites next, 3) Higher store count, 4) Added order
    productSummaries.sort((a, b) => {
      const aIn = a.inStockStoreCount > 0 ? 1 : 0;
      const bIn = b.inStockStoreCount > 0 ? 1 : 0;
      if (aIn !== bIn) return bIn - aIn;
      if (a.inStockStoreCount !== b.inStockStoreCount) {
        return b.inStockStoreCount - a.inStockStoreCount;
      }
      if (a.product.favorite !== b.product.favorite) {
        return a.product.favorite ? -1 : 1;
      }
      return a.product.addedAtMs - b.product.addedAtMs;
    });

    const stats: DashboardStats = {
      watchedProductsCount: watchedProducts.length,
      watchedStoresCount: watchedStores.length,
      inStockProductsCount,
      inStockPairsCount,
      totalRestocksFound: this.db.countRestockEvents(),
      totalNotificationsSent: this.db.countSuccessfulNotifications(),
    };

    return {
      settings,
      pushover: this.pushover.getEnvStatus(),
      watcher: this.getWatcherHealth(now),
      watchedStores,
      productSummaries,
      stats,
      serverTimeMs: now,
    };
  }

  private emitState(): void {
    if (this.disposed) return;
    this.emit('state', this.getSnapshot());
  }
}
