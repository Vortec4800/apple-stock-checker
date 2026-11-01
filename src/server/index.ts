import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type {
  AppSettings,
  AppStateSnapshot,
  Category,
  PushoverPriority,
  StoreInfo,
  WatchedProduct,
} from '../shared/types.js';
import { AppleRetailClient } from './apple-client.js';
import { buyPathForCategory } from './catalog-parser.js';
import { CatalogService } from './catalog-service.js';
import { AppDatabase } from './db.js';
import { PushoverService } from './pushover.js';
import { WatcherEngine } from './watcher.js';

export interface ServerBuildOptions {
  dbPath?: string;
  appleClient?: AppleRetailClient;
  logger?: boolean;
}

export interface BuiltAppServer {
  app: FastifyInstance;
  db: AppDatabase;
  catalog: CatalogService;
  appleClient: AppleRetailClient;
  pushover: PushoverService;
  watcher: WatcherEngine;
}

function resolveClientDistDir(): string | null {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), 'dist', 'client'),
    path.resolve(__dirname, '..', '..', 'client'),
    path.resolve(__dirname, '..', 'client'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) {
      return dir;
    }
  }
  return null;
}

export async function buildServer(options: ServerBuildOptions = {}): Promise<BuiltAppServer> {
  const app = Fastify({
    logger: options.logger ?? false,
  });

  const db = new AppDatabase(options.dbPath);
  const initialSettings = db.getSettings();
  const appleClient =
    options.appleClient ??
    new AppleRetailClient(initialSettings.proxies, (entry) => {
      db.insertRequestLog(entry);
    });
  const catalog = new CatalogService(db, appleClient);
  const pushover = new PushoverService(db);
  const watcher = new WatcherEngine({
    db,
    catalog,
    appleClient,
    pushover,
  });

  const sseDisconnectors = new Set<() => void>();

  app.addHook('preClose', async () => {
    watcher.dispose();
    for (const disconnect of sseDisconnectors) {
      disconnect();
    }
    sseDisconnectors.clear();
    app.server.closeIdleConnections?.();
    app.server.closeAllConnections?.();
  });

  app.addHook('onClose', async () => {
    watcher.dispose();
    db.close();
  });

  // Healthcheck for Docker & Unraid
  app.get('/api/health', async () => {
    const health = watcher.getWatcherHealth();
    return {
      ok: true,
      running: health.running,
      healthState: health.healthState,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: Date.now(),
    };
  });

  // Full application state snapshot
  app.get('/api/state', async () => {
    return watcher.getSnapshot();
  });

  // Real-time Server-Sent Events stream
  app.get('/api/events', (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const sendSnapshot = (snap: AppStateSnapshot) => {
      if (!reply.raw.writableEnded && !reply.raw.destroyed) {
        reply.raw.write(`event: state\ndata: ${JSON.stringify(snap)}\n\n`);
      }
    };

    sendSnapshot(watcher.getSnapshot());
    watcher.on('state', sendSnapshot);

    const heartbeat = setInterval(() => {
      if (!reply.raw.writableEnded && !reply.raw.destroyed) {
        reply.raw.write(': heartbeat\n\n');
      }
    }, 20_000);
    heartbeat.unref();

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      sseDisconnectors.delete(cleanup);
      clearInterval(heartbeat);
      watcher.off('state', sendSnapshot);
      if (!reply.raw.writableEnded && !reply.raw.destroyed) {
        reply.raw.end();
      }
    };

    sseDisconnectors.add(cleanup);
    req.raw.on('close', cleanup);
  });

  // Watcher controls
  app.post('/api/watcher/start', async () => {
    watcher.start();
    return watcher.getSnapshot();
  });

  app.post('/api/watcher/stop', async () => {
    watcher.stop();
    return watcher.getSnapshot();
  });

  app.post('/api/watcher/check-now', async () => {
    await watcher.triggerCheckNow();
    return watcher.getSnapshot();
  });

  // Regions & Stores
  app.get('/api/regions', async () => {
    return { regions: catalog.getRegions() };
  });

  app.get<{ Querystring: { locale?: string } }>('/api/stores', async (req) => {
    const locale = req.query.locale || db.getSettings().locale;
    return {
      locale,
      stores: catalog.getStores(locale),
    };
  });

  app.post<{ Body: { locale?: string; query: string } }>('/api/stores/lookup', async (req, reply) => {
    const query = (req.body?.query ?? '').trim();
    if (!query) {
      return reply.code(400).send({ error: 'Search location or ZIP code is required' });
    }
    const locale = req.body?.locale || db.getSettings().locale;
    return catalog.lookupNearbyStores(locale, query);
  });

  app.post<{ Body: { locale?: string } }>('/api/stores/refresh-live', async (req) => {
    const locale = req.body?.locale || db.getSettings().locale;
    const result = await catalog.refreshLiveStores(locale);
    return {
      ...result,
      stores: catalog.getStores(locale),
    };
  });

  app.put<{
    Body: {
      locale?: string;
      pickupLocation?: string;
      useLocationBatching?: boolean;
      stores?: StoreInfo[];
    };
  }>('/api/area', async (req) => {
    const body = req.body ?? {};
    const settingsPatch: Partial<AppSettings> = {};
    if (typeof body.locale === 'string' && body.locale.trim()) {
      settingsPatch.locale = body.locale.trim();
    }
    if (typeof body.pickupLocation === 'string') {
      settingsPatch.pickupLocation = body.pickupLocation.trim();
    }
    if (typeof body.useLocationBatching === 'boolean') {
      settingsPatch.useLocationBatching = body.useLocationBatching;
    }
    const updatedSettings = db.saveSettings(settingsPatch);
    if (Array.isArray(body.stores)) {
      db.setWatchedStores(updatedSettings.locale, body.stores);
    }
    watcher.onConfigurationChanged();
    return watcher.getSnapshot();
  });

  // Product Catalog & Live Refresh
  app.get<{ Querystring: { locale?: string; category?: Category } }>(
    '/api/catalog',
    async (req) => {
      const locale = req.query.locale || db.getSettings().locale;
      const products = catalog.getProducts(locale, req.query.category);
      return { locale, products };
    }
  );

  app.post<{ Body: { locale?: string; category?: Category } }>(
    '/api/catalog/refresh',
    async (req) => {
      const locale = req.body?.locale || db.getSettings().locale;
      const res = await catalog.refreshLiveCatalog(locale, req.body?.category);
      return {
        ...res,
        products: catalog.getProducts(locale, req.body?.category),
      };
    }
  );

  // Watchlist Management (uses body/query for partNumber so slashes in SKUs like MJQ34LL/A never break routing)
  app.post<{
    Body: {
      items: Array<{
        partNumber: string;
        title?: string;
        category?: Category;
        familyLabel?: string;
        capacity?: string;
        color?: string;
        companionPart?: string;
        buyUrl?: string;
        favorite?: boolean;
      }>;
    };
  }>('/api/watchlist', async (req, reply) => {
    const rawItems = req.body?.items;
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      return reply.code(400).send({ error: 'At least one product item is required' });
    }

    const settings = db.getSettings();
    const region = catalog.getRegion(settings.locale);

    const normalized: Array<Omit<WatchedProduct, 'addedAtMs'>> = [];
    for (const raw of rawItems) {
      const partNumber = String(raw.partNumber ?? '').trim().toUpperCase();
      if (!partNumber) continue;

      const known = catalog.findProductByPart(settings.locale, partNumber);
      const category: Category = raw.category ?? known?.category ?? 'mac';
      const title = (raw.title?.trim() || known?.title || `Custom Configuration (${partNumber})`);
      const buyUrl =
        raw.buyUrl?.trim() ||
        known?.buyUrl ||
        `${region.baseUrl}/shop/${buyPathForCategory(category)}`;

      normalized.push({
        partNumber,
        title,
        category,
        familyLabel: raw.familyLabel?.trim() || known?.familyLabel || 'Custom / BTO',
        capacity: raw.capacity?.trim() || known?.capacity || '',
        color: raw.color?.trim() || known?.color || '',
        companionPart: raw.companionPart?.trim() || known?.companionPart,
        buyUrl,
        favorite: Boolean(raw.favorite),
      });
    }

    if (normalized.length === 0) {
      return reply.code(400).send({ error: 'No valid part numbers provided' });
    }

    db.addWatchedProducts(settings.locale, normalized);
    watcher.onConfigurationChanged();
    return watcher.getSnapshot();
  });

  app.patch<{ Body: { partNumber: string; favorite: boolean } }>(
    '/api/watchlist',
    async (req, reply) => {
      const partNumber = String(req.body?.partNumber ?? '').trim().toUpperCase();
      if (!partNumber) {
        return reply.code(400).send({ error: 'partNumber is required' });
      }
      db.toggleFavoriteProduct(partNumber, Boolean(req.body?.favorite));
      watcher.onConfigurationChanged();
      return watcher.getSnapshot();
    }
  );

  app.delete<{ Querystring: { partNumber?: string } }>(
    '/api/watchlist',
    async (req, reply) => {
      const partNumber = String(req.query.partNumber ?? '').trim().toUpperCase();
      if (!partNumber) {
        return reply.code(400).send({ error: 'partNumber query parameter is required' });
      }
      db.removeWatchedProduct(partNumber);
      watcher.onConfigurationChanged();
      return watcher.getSnapshot();
    }
  );

  // Settings & Pushover Test
  app.put<{ Body: Partial<AppSettings> }>('/api/settings', async (req) => {
    db.saveSettings(req.body ?? {});
    watcher.onConfigurationChanged();
    return watcher.getSnapshot();
  });

  app.post<{ Body: { priority?: PushoverPriority; sound?: string } }>(
    '/api/pushover/test',
    async (req) => {
      const settings = db.getSettings();
      const priority = req.body?.priority ?? settings.normalPriority;
      const sound = req.body?.sound ?? settings.normalSound;
      const res = await pushover.sendTest(priority, sound);
      return {
        ...res,
        snapshot: watcher.getSnapshot(),
      };
    }
  );

  // History & Diagnostics
  app.get<{ Querystring: { limit?: string } }>('/api/history/restocks', async (req) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    return { events: db.getRestockEvents(limit) };
  });

  app.get<{ Querystring: { limit?: string } }>('/api/history/notifications', async (req) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    return { logs: db.getNotificationLogs(limit) };
  });

  app.get<{ Querystring: { limit?: string } }>('/api/diagnostics/requests', async (req) => {
    const limit = Math.min(400, Math.max(1, Number(req.query.limit) || 150));
    return { logs: db.getRequestLogs(limit) };
  });

  app.delete('/api/history', async () => {
    db.clearHistory();
    return watcher.getSnapshot();
  });

  // Serve built React SPA when present
  const clientDist = resolveClientDistDir();
  if (clientDist) {
    await app.register(fastifyStatic, {
      root: clientDist,
      prefix: '/',
      wildcard: false,
    });

    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        reply.code(404).send({ error: 'API endpoint not found' });
        return;
      }
      return reply.sendFile('index.html');
    });
  }

  return {
    app,
    db,
    catalog,
    appleClient,
    pushover,
    watcher,
  };
}

// Start HTTP server when invoked directly
const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const port = Number(process.env.PORT || 8080);
  const host = process.env.HOST || '0.0.0.0';

  buildServer({ logger: true })
    .then(async ({ app }) => {
      let shuttingDown = false;
      const shutdown = async (signal: string) => {
        if (shuttingDown) {
          process.exit(130);
        }
        shuttingDown = true;
        console.log(`\nReceived ${signal}, shutting down...`);
        const forceTimer = setTimeout(() => {
          process.exit(1);
        }, 2_000);
        forceTimer.unref();

        try {
          await app.close();
        } catch {
          // Ignore errors during shutdown
        }
        process.exit(0);
      };
      process.on('SIGINT', () => void shutdown('SIGINT'));
      process.on('SIGTERM', () => void shutdown('SIGTERM'));

      await app.listen({ port, host });
      console.log(`Apple Stock Checker listening on http://${host}:${port}`);
    })
    .catch((err) => {
      console.error('Failed to start server:', err);
      process.exit(1);
    });
}
