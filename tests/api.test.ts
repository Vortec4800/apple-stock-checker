import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AppleRetailClient } from '../src/server/apple-client.js';
import { AppDatabase } from '../src/server/db.js';
import { buildServer } from '../src/server/index.js';
import { ALL_CATEGORIES, type AppStateSnapshot, type CatalogProduct } from '../src/shared/types.js';

describe('Fastify REST API & Watchlist Integration', () => {
  it('serves all 7 US product families, handles slash-containing SKUs, auto-attaches Watch bands, and computes area counts', async () => {
    process.env.PUSHOVER_USER_KEY = 'u1234567890abcdef';
    process.env.PUSHOVER_API_TOKEN = 'a9876543210fedcba';

    const mockApple = new AppleRetailClient([]);
    vi.spyOn(mockApple, 'fetchPickupBatch').mockImplementation(async (params) => {
      const byStoreAndPart = new Map();
      // Return R216 in_stock and R085 out_of_stock
      for (const part of params.queryParts) {
        byStoreAndPart.set(`R216::${part.toUpperCase()}`, {
          status: 'in_stock',
          pickupQuote: 'Available Today',
        });
        byStoreAndPart.set(`R085::${part.toUpperCase()}`, {
          status: 'out_of_stock',
          pickupQuote: 'Unavailable',
        });
      }
      return {
        ok: true,
        stores: [],
        coveredStoreIds: new Set(['R216', 'R085']),
        byStoreAndPart,
      };
    });

    const built = await buildServer({
      dbPath: ':memory:',
      appleClient: mockApple,
    });
    const { app } = built;

    // 1. Healthcheck
    const healthRes = await app.inject({ method: 'GET', url: '/api/health' });
    expect(healthRes.statusCode).toBe(200);
    expect(healthRes.json().ok).toBe(true);

    // 2. Verify US catalog covers all 7 Apple product categories
    const catRes = await app.inject({ method: 'GET', url: '/api/catalog?locale=en_US' });
    expect(catRes.statusCode).toBe(200);
    const catalogProducts = catRes.json().products as CatalogProduct[];
    expect(catalogProducts.length).toBeGreaterThan(300);
    for (const category of ALL_CATEGORIES) {
      expect(catalogProducts.some((p) => p.category === category)).toBe(true);
    }

    // 3. Configure area & 2 watched stores
    const storesRes = await app.inject({ method: 'GET', url: '/api/stores?locale=en_US' });
    const allStores = storesRes.json().stores as Array<{ id: string; name: string }>;
    const r216 = allStores.find((s) => s.id === 'R216')!;
    const r085 = allStores.find((s) => s.id === 'R085')!;

    const areaRes = await app.inject({
      method: 'PUT',
      url: '/api/area',
      payload: {
        locale: 'en_US',
        pickupLocation: '78758',
        useLocationBatching: true,
        stores: [r216, r085],
      },
    });
    expect(areaRes.statusCode).toBe(200);

    // 4. Add an iPhone SKU with `/` AND an Apple Watch SKU (testing auto companion band lookup)
    const watchItem = catalogProducts.find((p) => p.category === 'watch' && p.companionPart)!;
    const addRes = await app.inject({
      method: 'POST',
      url: '/api/watchlist',
      payload: {
        items: [
          { partNumber: 'MJQ34LL/A', favorite: false },
          { partNumber: watchItem.partNumber, favorite: true },
        ],
      },
    });
    expect(addRes.statusCode).toBe(200);
    const snapAfterAdd = addRes.json() as AppStateSnapshot;
    expect(snapAfterAdd.stats.watchedProductsCount).toBe(2);
    expect(snapAfterAdd.pushover.configured).toBe(true);
    expect(snapAfterAdd.pushover.maskedUserKey).toBe('u12…cdef');

    // 5. Toggle favorite on slash SKU & set minAlertGapSeconds to 0 for instant multi-item test alerts
    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/api/watchlist',
      payload: { partNumber: 'MJQ34LL/A', favorite: true },
    });
    expect(patchRes.statusCode).toBe(200);

    const settingsRes = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { minAlertGapSeconds: 0 },
    });
    expect(settingsRes.statusCode).toBe(200);

    // 6. Trigger Check Now (avoiding outbound Pushover HTTP by stubbing pushover.send)
    vi.spyOn(built.pushover, 'send').mockResolvedValue({ success: true });

    const checkRes = await app.inject({ method: 'POST', url: '/api/watcher/check-now' });
    expect(checkRes.statusCode).toBe(200);
    const snapAfterCheck = checkRes.json() as AppStateSnapshot;

    expect(snapAfterCheck.stats.inStockProductsCount).toBe(2);
    const iphoneSummary = snapAfterCheck.productSummaries.find(
      (s) => s.product.partNumber === 'MJQ34LL/A'
    )!;
    expect(iphoneSummary.inStockStoreCount).toBe(1);
    expect(iphoneSummary.totalWatchedStores).toBe(2);

    // Verify Watch companion band was included in the batched Apple pickup call!
    expect(mockApple.fetchPickupBatch).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(mockApple.fetchPickupBatch).mock.calls[0]?.[0];
    expect(callArgs?.queryParts).toContain(watchItem.companionPart);

    // 7. Delete SKU via query parameter
    const delRes = await app.inject({
      method: 'DELETE',
      url: '/api/watchlist?partNumber=MJQ34LL%2FA',
    });
    expect(delRes.statusCode).toBe(200);
    expect((delRes.json() as AppStateSnapshot).stats.watchedProductsCount).toBe(1);

    await app.close();
  });

  it('closes immediately even while an /api/events SSE stream is open and preserves running preference', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-sse-'));
    const dbFile = path.join(tmpDir, 'test.db');

    try {
      const built = await buildServer({ dbPath: dbFile });
      const { app, watcher } = built;
      await app.ready();

      watcher.start();

      // Open a streaming SSE response without ending it from the client side
      const sseRes = await app.inject({
        method: 'GET',
        url: '/api/events',
        payloadAsStream: true,
      });
      expect(sseRes.statusCode).toBe(200);
      const stream = sseRes.stream();
      const firstChunk = await new Promise<string>((resolve, reject) => {
        stream.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8')));
        stream.once('error', reject);
      });
      expect(firstChunk).toContain('event: state');

      const closeStart = Date.now();
      await app.close();
      const closeElapsedMs = Date.now() - closeStart;

      expect(closeElapsedMs).toBeLessThan(1_000);

      // Reopen DB and verify graceful shutdown preserved watcher_running = true
      const reopenedDb = new AppDatabase(dbFile);
      expect(reopenedDb.getWatcherRunningPreference()).toBe(true);
      reopenedDb.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
