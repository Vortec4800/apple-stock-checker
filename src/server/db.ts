import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type AppSettings,
  type AvailabilityKind,
  type CatalogProduct,
  type Category,
  DEFAULT_SETTINGS,
  type NotificationLog,
  type RequestLog,
  type RequestOutcome,
  type RestockEvent,
  type StoreInfo,
  type TargetState,
  type UnknownReasonKind,
  type WatchedProduct,
} from '../shared/types.js';

export interface StoredTargetRecord {
  partNumber: string;
  storeId: string;
  status: AvailabilityKind;
  unknownReason?: UnknownReasonKind;
  unknownDetail?: string;
  pickupQuote?: string;
  storePickupProductTitle?: string;
  lastCheckedMs: number | null;
  lastStatusChangeMs: number | null;
  inStockSinceMs: number | null;
  activeRestockEventId: number | null;
  alertsSentCount: number;
  lastAlertSentMs: number | null;
}

export class AppDatabase {
  public readonly db: DatabaseSync;
  public readonly dbPath: string;
  private closed = false;

  constructor(dbPath?: string) {
    const resolved =
      dbPath ||
      process.env.DB_PATH ||
      path.resolve(process.cwd(), 'data', 'apple-stock.db');
    if (resolved !== ':memory:') {
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
    }
    this.dbPath = resolved;
    this.db = new DatabaseSync(resolved);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS watched_stores (
        id TEXT PRIMARY KEY,
        locale TEXT NOT NULL,
        name TEXT NOT NULL,
        slug TEXT NOT NULL DEFAULT '',
        city TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT '',
        state_code TEXT NOT NULL DEFAULT '',
        postal_code TEXT NOT NULL DEFAULT '',
        address1 TEXT NOT NULL DEFAULT '',
        telephone TEXT NOT NULL DEFAULT '',
        added_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS watched_products (
        part_number TEXT PRIMARY KEY,
        locale TEXT NOT NULL,
        title TEXT NOT NULL,
        category TEXT NOT NULL,
        family_label TEXT NOT NULL DEFAULT '',
        capacity TEXT NOT NULL DEFAULT '',
        color TEXT NOT NULL DEFAULT '',
        companion_part TEXT,
        buy_url TEXT NOT NULL DEFAULT '',
        favorite INTEGER NOT NULL DEFAULT 0,
        added_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS target_states (
        part_number TEXT NOT NULL,
        store_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unknown',
        unknown_reason TEXT,
        unknown_detail TEXT,
        pickup_quote TEXT,
        store_pickup_product_title TEXT,
        last_checked_ms INTEGER,
        last_status_change_ms INTEGER,
        in_stock_since_ms INTEGER,
        active_restock_event_id INTEGER,
        alerts_sent_count INTEGER NOT NULL DEFAULT 0,
        last_alert_sent_ms INTEGER,
        PRIMARY KEY (part_number, store_id)
      );

      CREATE TABLE IF NOT EXISTS restock_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        part_number TEXT NOT NULL,
        product_title TEXT NOT NULL,
        store_id TEXT NOT NULL,
        store_name TEXT NOT NULL,
        store_city TEXT NOT NULL DEFAULT '',
        quote TEXT NOT NULL DEFAULT '',
        area_in_stock_count INTEGER NOT NULL DEFAULT 1,
        area_total_stores INTEGER NOT NULL DEFAULT 1,
        first_seen_ms INTEGER NOT NULL,
        sold_out_ms INTEGER,
        duration_ms INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_restock_events_first_seen
        ON restock_events (first_seen_ms DESC);

      CREATE TABLE IF NOT EXISTS notification_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at_ms INTEGER NOT NULL,
        kind TEXT NOT NULL,
        part_number TEXT,
        product_title TEXT NOT NULL,
        store_name TEXT NOT NULL,
        message TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        success INTEGER NOT NULL DEFAULT 1,
        error_detail TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_notification_logs_created
        ON notification_logs (created_at_ms DESC);

      CREATE TABLE IF NOT EXISTS request_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at_ms INTEGER NOT NULL,
        endpoint TEXT NOT NULL,
        route_label TEXT NOT NULL DEFAULT 'direct',
        http_status INTEGER,
        duration_ms INTEGER NOT NULL,
        parts_count INTEGER NOT NULL DEFAULT 0,
        outcome TEXT NOT NULL,
        detail TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_request_logs_created
        ON request_logs (created_at_ms DESC);

      CREATE TABLE IF NOT EXISTS online_catalog_pages (
        locale TEXT NOT NULL,
        category TEXT NOT NULL,
        page_slug TEXT NOT NULL,
        products_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (locale, category, page_slug)
      );

      CREATE TABLE IF NOT EXISTS online_stores_cache (
        locale TEXT PRIMARY KEY,
        stores_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
    `);
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  public getSettings(): AppSettings {
    const row = this.db
      .prepare('SELECT value FROM kv_settings WHERE key = ?')
      .get('app_settings') as { value: string } | undefined;
    if (!row) return { ...DEFAULT_SETTINGS };
    try {
      const parsed = JSON.parse(row.value) as Partial<AppSettings>;
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        proxies: Array.isArray(parsed.proxies)
          ? parsed.proxies.map((p) => String(p).trim()).filter(Boolean)
          : [],
      };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  public saveSettings(patch: Partial<AppSettings>): AppSettings {
    const current = this.getSettings();
    const numOr = (val: unknown, fallback: number): number => {
      const n = Number(val);
      return Number.isFinite(n) ? n : fallback;
    };
    const merged: AppSettings = {
      ...current,
      ...patch,
      pollIntervalSeconds: Math.max(
        15,
        Math.min(3600, numOr(patch.pollIntervalSeconds, current.pollIntervalSeconds))
      ),
      jitterPercent: Math.max(
        0,
        Math.min(50, numOr(patch.jitterPercent, current.jitterPercent))
      ),
      repeatIntervalMinutes: Math.max(
        1,
        Math.min(180, numOr(patch.repeatIntervalMinutes, current.repeatIntervalMinutes))
      ),
      maxAlertsPerRestock: Math.max(
        1,
        Math.min(50, numOr(patch.maxAlertsPerRestock, current.maxAlertsPerRestock))
      ),
      minAlertGapSeconds: Math.max(
        0,
        Math.min(300, numOr(patch.minAlertGapSeconds, current.minAlertGapSeconds))
      ),
      proxies: Array.isArray(patch.proxies)
        ? patch.proxies.map((p) => String(p).trim()).filter(Boolean)
        : current.proxies,
    };

    this.db
      .prepare(
        'INSERT INTO kv_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run('app_settings', JSON.stringify(merged));
    return merged;
  }

  public getWatcherRunningPreference(): boolean {
    const row = this.db
      .prepare('SELECT value FROM kv_settings WHERE key = ?')
      .get('watcher_running') as { value: string } | undefined;
    return row ? row.value === 'true' : false;
  }

  public setWatcherRunningPreference(running: boolean): void {
    this.db
      .prepare(
        'INSERT INTO kv_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run('watcher_running', running ? 'true' : 'false');
  }

  public getWatchedStores(locale?: string): StoreInfo[] {
    const activeLocale = locale ?? this.getSettings().locale;
    const rows = this.db
      .prepare(
        `SELECT id, name, slug, city, state, state_code, postal_code, address1, telephone
         FROM watched_stores
         WHERE locale = ?
         ORDER BY state ASC, city ASC, name ASC`
      )
      .all(activeLocale) as Array<{
      id: string;
      name: string;
      slug: string;
      city: string;
      state: string;
      state_code: string;
      postal_code: string;
      address1: string;
      telephone: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      city: r.city,
      state: r.state,
      stateCode: r.state_code,
      postalCode: r.postal_code,
      address1: r.address1,
      telephone: r.telephone,
    }));
  }

  public setWatchedStores(locale: string, stores: StoreInfo[]): StoreInfo[] {
    const validStores = stores.filter((s) => s && typeof s.id === 'string' && s.id.trim());
    const now = Date.now();
    this.db.exec('BEGIN');
    try {
      const keepIds = new Set(validStores.map((s) => s.id));
      const existing = this.getWatchedStores(locale);
      for (const old of existing) {
        if (!keepIds.has(old.id)) {
          this.db.prepare('DELETE FROM watched_stores WHERE id = ? AND locale = ?').run(old.id, locale);
          this.db.prepare('DELETE FROM target_states WHERE store_id = ?').run(old.id);
        }
      }

      const upsert = this.db.prepare(`
        INSERT INTO watched_stores
          (id, locale, name, slug, city, state, state_code, postal_code, address1, telephone, added_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          locale = excluded.locale,
          name = excluded.name,
          slug = excluded.slug,
          city = excluded.city,
          state = excluded.state,
          state_code = excluded.state_code,
          postal_code = excluded.postal_code,
          address1 = excluded.address1,
          telephone = excluded.telephone
      `);

      for (const s of validStores) {
        upsert.run(
          s.id.trim(),
          locale,
          s.name || s.id,
          s.slug || '',
          s.city || '',
          s.state || '',
          s.stateCode || '',
          s.postalCode || '',
          s.address1 || '',
          s.telephone || '',
          now
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.getWatchedStores(locale);
  }

  public getWatchedProducts(locale?: string): WatchedProduct[] {
    const activeLocale = locale ?? this.getSettings().locale;
    const rows = this.db
      .prepare(
        `SELECT part_number, title, category, family_label, capacity, color, companion_part, buy_url, favorite, added_at_ms
         FROM watched_products
         WHERE locale = ?
         ORDER BY favorite DESC, added_at_ms ASC`
      )
      .all(activeLocale) as Array<{
      part_number: string;
      title: string;
      category: Category;
      family_label: string;
      capacity: string;
      color: string;
      companion_part: string | null;
      buy_url: string;
      favorite: number;
      added_at_ms: number;
    }>;

    return rows.map((r) => ({
      partNumber: r.part_number,
      title: r.title,
      category: r.category,
      familyLabel: r.family_label,
      capacity: r.capacity,
      color: r.color,
      ...(r.companion_part ? { companionPart: r.companion_part } : {}),
      buyUrl: r.buy_url,
      favorite: Boolean(r.favorite),
      addedAtMs: r.added_at_ms,
    }));
  }

  public addWatchedProducts(
    locale: string,
    items: Array<Omit<WatchedProduct, 'addedAtMs'>>
  ): WatchedProduct[] {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO watched_products
        (part_number, locale, title, category, family_label, capacity, color, companion_part, buy_url, favorite, added_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(part_number) DO UPDATE SET
        locale = excluded.locale,
        title = excluded.title,
        category = excluded.category,
        family_label = excluded.family_label,
        capacity = excluded.capacity,
        color = excluded.color,
        companion_part = COALESCE(excluded.companion_part, watched_products.companion_part),
        buy_url = excluded.buy_url
    `);

    this.db.exec('BEGIN');
    try {
      for (const item of items) {
        stmt.run(
          item.partNumber.trim().toUpperCase(),
          locale,
          item.title.trim(),
          item.category,
          item.familyLabel || '',
          item.capacity || '',
          item.color || '',
          item.companionPart || null,
          item.buyUrl || '',
          item.favorite ? 1 : 0,
          now
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.getWatchedProducts(locale);
  }

  public toggleFavoriteProduct(partNumber: string, favorite: boolean): void {
    this.db
      .prepare('UPDATE watched_products SET favorite = ? WHERE part_number = ?')
      .run(favorite ? 1 : 0, partNumber);
  }

  public removeWatchedProduct(partNumber: string): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM watched_products WHERE part_number = ?').run(partNumber);
      this.db.prepare('DELETE FROM target_states WHERE part_number = ?').run(partNumber);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  public getTargetRecord(partNumber: string, storeId: string): StoredTargetRecord | null {
    const row = this.db
      .prepare(
        `SELECT part_number, store_id, status, unknown_reason, unknown_detail,
                pickup_quote, store_pickup_product_title, last_checked_ms,
                last_status_change_ms, in_stock_since_ms, active_restock_event_id,
                alerts_sent_count, last_alert_sent_ms
         FROM target_states
         WHERE part_number = ? AND store_id = ?`
      )
      .get(partNumber, storeId) as
      | {
          part_number: string;
          store_id: string;
          status: AvailabilityKind;
          unknown_reason: UnknownReasonKind | null;
          unknown_detail: string | null;
          pickup_quote: string | null;
          store_pickup_product_title: string | null;
          last_checked_ms: number | null;
          last_status_change_ms: number | null;
          in_stock_since_ms: number | null;
          active_restock_event_id: number | null;
          alerts_sent_count: number;
          last_alert_sent_ms: number | null;
        }
      | undefined;

    if (!row) return null;
    return {
      partNumber: row.part_number,
      storeId: row.store_id,
      status: row.status,
      ...(row.unknown_reason ? { unknownReason: row.unknown_reason } : {}),
      ...(row.unknown_detail ? { unknownDetail: row.unknown_detail } : {}),
      ...(row.pickup_quote ? { pickupQuote: row.pickup_quote } : {}),
      ...(row.store_pickup_product_title
        ? { storePickupProductTitle: row.store_pickup_product_title }
        : {}),
      lastCheckedMs: row.last_checked_ms,
      lastStatusChangeMs: row.last_status_change_ms,
      inStockSinceMs: row.in_stock_since_ms,
      activeRestockEventId: row.active_restock_event_id,
      alertsSentCount: row.alerts_sent_count,
      lastAlertSentMs: row.last_alert_sent_ms,
    };
  }

  public getAllTargetRecords(): Map<string, StoredTargetRecord> {
    const rows = this.db
      .prepare(
        `SELECT part_number, store_id, status, unknown_reason, unknown_detail,
                pickup_quote, store_pickup_product_title, last_checked_ms,
                last_status_change_ms, in_stock_since_ms, active_restock_event_id,
                alerts_sent_count, last_alert_sent_ms
         FROM target_states`
      )
      .all() as Array<{
      part_number: string;
      store_id: string;
      status: AvailabilityKind;
      unknown_reason: UnknownReasonKind | null;
      unknown_detail: string | null;
      pickup_quote: string | null;
      store_pickup_product_title: string | null;
      last_checked_ms: number | null;
      last_status_change_ms: number | null;
      in_stock_since_ms: number | null;
      active_restock_event_id: number | null;
      alerts_sent_count: number;
      last_alert_sent_ms: number | null;
    }>;

    const map = new Map<string, StoredTargetRecord>();
    for (const r of rows) {
      map.set(`${r.part_number}::${r.store_id}`, {
        partNumber: r.part_number,
        storeId: r.store_id,
        status: r.status,
        ...(r.unknown_reason ? { unknownReason: r.unknown_reason } : {}),
        ...(r.unknown_detail ? { unknownDetail: r.unknown_detail } : {}),
        ...(r.pickup_quote ? { pickupQuote: r.pickup_quote } : {}),
        ...(r.store_pickup_product_title
          ? { storePickupProductTitle: r.store_pickup_product_title }
          : {}),
        lastCheckedMs: r.last_checked_ms,
        lastStatusChangeMs: r.last_status_change_ms,
        inStockSinceMs: r.in_stock_since_ms,
        activeRestockEventId: r.active_restock_event_id,
        alertsSentCount: r.alerts_sent_count,
        lastAlertSentMs: r.last_alert_sent_ms,
      });
    }
    return map;
  }

  public upsertTargetRecord(rec: StoredTargetRecord): void {
    this.db
      .prepare(
        `INSERT INTO target_states (
           part_number, store_id, status, unknown_reason, unknown_detail,
           pickup_quote, store_pickup_product_title, last_checked_ms,
           last_status_change_ms, in_stock_since_ms, active_restock_event_id,
           alerts_sent_count, last_alert_sent_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(part_number, store_id) DO UPDATE SET
           status = excluded.status,
           unknown_reason = excluded.unknown_reason,
           unknown_detail = excluded.unknown_detail,
           pickup_quote = excluded.pickup_quote,
           store_pickup_product_title = excluded.store_pickup_product_title,
           last_checked_ms = excluded.last_checked_ms,
           last_status_change_ms = excluded.last_status_change_ms,
           in_stock_since_ms = excluded.in_stock_since_ms,
           active_restock_event_id = excluded.active_restock_event_id,
           alerts_sent_count = excluded.alerts_sent_count,
           last_alert_sent_ms = excluded.last_alert_sent_ms`
      )
      .run(
        rec.partNumber,
        rec.storeId,
        rec.status,
        rec.unknownReason ?? null,
        rec.unknownDetail ?? null,
        rec.pickupQuote ?? null,
        rec.storePickupProductTitle ?? null,
        rec.lastCheckedMs,
        rec.lastStatusChangeMs,
        rec.inStockSinceMs,
        rec.activeRestockEventId,
        rec.alertsSentCount,
        rec.lastAlertSentMs
      );
  }

  public openRestockEvent(input: {
    partNumber: string;
    productTitle: string;
    storeId: string;
    storeName: string;
    storeCity: string;
    quote: string;
    areaInStockCount: number;
    areaTotalStores: number;
    firstSeenMs: number;
  }): number {
    const res = this.db
      .prepare(
        `INSERT INTO restock_events
          (part_number, product_title, store_id, store_name, store_city, quote, area_in_stock_count, area_total_stores, first_seen_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.partNumber,
        input.productTitle,
        input.storeId,
        input.storeName,
        input.storeCity,
        input.quote,
        input.areaInStockCount,
        input.areaTotalStores,
        input.firstSeenMs
      );
    this.pruneTable('restock_events', 2000);
    return Number(res.lastInsertRowid);
  }

  public updateRestockEventPeak(
    eventId: number,
    areaInStockCount: number,
    areaTotalStores: number,
    quote?: string
  ): void {
    this.db
      .prepare(
        `UPDATE restock_events
         SET area_in_stock_count = MAX(area_in_stock_count, ?),
             area_total_stores = ?,
             quote = CASE WHEN ? != '' THEN ? ELSE quote END
         WHERE id = ?`
      )
      .run(areaInStockCount, areaTotalStores, quote || '', quote || '', eventId);
  }

  public closeRestockEvent(eventId: number, soldOutMs: number): void {
    this.db
      .prepare(
        `UPDATE restock_events
         SET sold_out_ms = ?,
             duration_ms = MAX(0, ? - first_seen_ms)
         WHERE id = ? AND sold_out_ms IS NULL`
      )
      .run(soldOutMs, soldOutMs, eventId);
  }

  public getRestockEvents(limit = 200): RestockEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, part_number, product_title, store_id, store_name, store_city,
                quote, area_in_stock_count, area_total_stores, first_seen_ms, sold_out_ms, duration_ms
         FROM restock_events
         ORDER BY first_seen_ms DESC
         LIMIT ?`
      )
      .all(limit) as Array<{
      id: number;
      part_number: string;
      product_title: string;
      store_id: string;
      store_name: string;
      store_city: string;
      quote: string;
      area_in_stock_count: number;
      area_total_stores: number;
      first_seen_ms: number;
      sold_out_ms: number | null;
      duration_ms: number | null;
    }>;

    return rows.map((r) => ({
      id: r.id,
      partNumber: r.part_number,
      productTitle: r.product_title,
      storeId: r.store_id,
      storeName: r.store_name,
      storeCity: r.store_city,
      quote: r.quote,
      areaInStockCount: r.area_in_stock_count,
      areaTotalStores: r.area_total_stores,
      firstSeenMs: r.first_seen_ms,
      soldOutMs: r.sold_out_ms,
      durationMs: r.duration_ms,
    }));
  }

  public countRestockEvents(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS cnt FROM restock_events').get() as {
      cnt: number;
    };
    return Number(row?.cnt || 0);
  }

  public insertNotificationLog(entry: {
    createdAtMs: number;
    kind: 'restock' | 'repeat' | 'test';
    partNumber: string | null;
    productTitle: string;
    storeName: string;
    message: string;
    priority: number;
    success: boolean;
    errorDetail: string | null;
  }): number {
    const res = this.db
      .prepare(
        `INSERT INTO notification_logs
          (created_at_ms, kind, part_number, product_title, store_name, message, priority, success, error_detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.createdAtMs,
        entry.kind,
        entry.partNumber,
        entry.productTitle,
        entry.storeName,
        entry.message,
        entry.priority,
        entry.success ? 1 : 0,
        entry.errorDetail
      );
    this.pruneTable('notification_logs', 1000);
    return Number(res.lastInsertRowid);
  }

  public getNotificationLogs(limit = 200): NotificationLog[] {
    const rows = this.db
      .prepare(
        `SELECT id, created_at_ms, kind, part_number, product_title, store_name,
                message, priority, success, error_detail
         FROM notification_logs
         ORDER BY created_at_ms DESC
         LIMIT ?`
      )
      .all(limit) as Array<{
      id: number;
      created_at_ms: number;
      kind: 'restock' | 'repeat' | 'test';
      part_number: string | null;
      product_title: string;
      store_name: string;
      message: string;
      priority: number;
      success: number;
      error_detail: string | null;
    }>;

    return rows.map((r) => ({
      id: r.id,
      createdAtMs: r.created_at_ms,
      kind: r.kind,
      partNumber: r.part_number,
      productTitle: r.product_title,
      storeName: r.store_name,
      message: r.message,
      priority: r.priority,
      success: Boolean(r.success),
      errorDetail: r.error_detail,
    }));
  }

  public countSuccessfulNotifications(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS cnt FROM notification_logs WHERE success = 1')
      .get() as { cnt: number };
    return Number(row?.cnt || 0);
  }

  public insertRequestLog(entry: {
    createdAtMs: number;
    endpoint: string;
    routeLabel: string;
    httpStatus: number | null;
    durationMs: number;
    partsCount: number;
    outcome: RequestOutcome;
    detail: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO request_logs
          (created_at_ms, endpoint, route_label, http_status, duration_ms, parts_count, outcome, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.createdAtMs,
        entry.endpoint,
        entry.routeLabel,
        entry.httpStatus,
        entry.durationMs,
        entry.partsCount,
        entry.outcome,
        entry.detail
      );
    this.pruneTable('request_logs', 400);
  }

  public getRequestLogs(limit = 150): RequestLog[] {
    const rows = this.db
      .prepare(
        `SELECT id, created_at_ms, endpoint, route_label, http_status, duration_ms, parts_count, outcome, detail
         FROM request_logs
         ORDER BY created_at_ms DESC
         LIMIT ?`
      )
      .all(limit) as Array<{
      id: number;
      created_at_ms: number;
      endpoint: string;
      route_label: string;
      http_status: number | null;
      duration_ms: number;
      parts_count: number;
      outcome: RequestOutcome;
      detail: string | null;
    }>;

    return rows.map((r) => ({
      id: r.id,
      createdAtMs: r.created_at_ms,
      endpoint: r.endpoint,
      routeLabel: r.route_label,
      httpStatus: r.http_status,
      durationMs: r.duration_ms,
      partsCount: r.parts_count,
      outcome: r.outcome,
      detail: r.detail,
    }));
  }

  public saveOnlineCatalogPage(
    locale: string,
    category: Category,
    pageSlug: string,
    products: CatalogProduct[]
  ): void {
    this.db
      .prepare(
        `INSERT INTO online_catalog_pages (locale, category, page_slug, products_json, updated_at_ms)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(locale, category, page_slug) DO UPDATE SET
           products_json = excluded.products_json,
           updated_at_ms = excluded.updated_at_ms`
      )
      .run(locale, category, pageSlug, JSON.stringify(products), Date.now());
  }

  public getOnlineCatalogPages(
    locale: string
  ): Map<string, { products: CatalogProduct[]; updatedAtMs: number }> {
    const rows = this.db
      .prepare(
        `SELECT category, page_slug, products_json, updated_at_ms
         FROM online_catalog_pages
         WHERE locale = ?`
      )
      .all(locale) as Array<{
      category: Category;
      page_slug: string;
      products_json: string;
      updated_at_ms: number;
    }>;

    const map = new Map<string, { products: CatalogProduct[]; updatedAtMs: number }>();
    for (const r of rows) {
      try {
        map.set(`${r.category}::${r.page_slug}`, {
          products: JSON.parse(r.products_json) as CatalogProduct[],
          updatedAtMs: r.updated_at_ms,
        });
      } catch {
        // Ignore corrupt cache row
      }
    }
    return map;
  }

  public saveOnlineStoresCache(locale: string, stores: StoreInfo[]): void {
    this.db
      .prepare(
        `INSERT INTO online_stores_cache (locale, stores_json, updated_at_ms)
         VALUES (?, ?, ?)
         ON CONFLICT(locale) DO UPDATE SET
           stores_json = excluded.stores_json,
           updated_at_ms = excluded.updated_at_ms`
      )
      .run(locale, JSON.stringify(stores), Date.now());
  }

  public getOnlineStoresCache(locale: string): StoreInfo[] | null {
    const row = this.db
      .prepare('SELECT stores_json FROM online_stores_cache WHERE locale = ?')
      .get(locale) as { stores_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.stores_json) as StoreInfo[];
    } catch {
      return null;
    }
  }

  public clearHistory(): void {
    this.db.exec('DELETE FROM restock_events; DELETE FROM notification_logs; DELETE FROM request_logs;');
  }

  private pruneTable(table: 'restock_events' | 'notification_logs' | 'request_logs', keep: number): void {
    this.db
      .prepare(
        `DELETE FROM ${table}
         WHERE id NOT IN (SELECT id FROM ${table} ORDER BY id DESC LIMIT ?)`
      )
      .run(keep);
  }
}

export function toPublicTargetState(
  store: StoreInfo,
  partNumber: string,
  rec: StoredTargetRecord | undefined
): TargetState {
  if (!rec) {
    return {
      partNumber,
      storeId: store.id,
      storeName: store.name,
      storeCity: store.city,
      status: 'unknown',
      unknownReason: 'not_yet_checked',
      unknownDetail: 'Waiting for first check cycle',
      lastCheckedMs: null,
      lastStatusChangeMs: null,
      inStockSinceMs: null,
    };
  }
  return {
    partNumber,
    storeId: store.id,
    storeName: store.name,
    storeCity: store.city,
    status: rec.status,
    ...(rec.unknownReason ? { unknownReason: rec.unknownReason } : {}),
    ...(rec.unknownDetail ? { unknownDetail: rec.unknownDetail } : {}),
    ...(rec.pickupQuote ? { pickupQuote: rec.pickupQuote } : {}),
    ...(rec.storePickupProductTitle
      ? { storePickupProductTitle: rec.storePickupProductTitle }
      : {}),
    lastCheckedMs: rec.lastCheckedMs,
    lastStatusChangeMs: rec.lastStatusChangeMs,
    inStockSinceMs: rec.inStockSinceMs,
  };
}
