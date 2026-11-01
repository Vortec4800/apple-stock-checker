import { describe, expect, it } from 'vitest';
import {
  BlockTracker,
  buildPartBatches,
  parsePickupResponse,
  parseRetryAfterMs,
  TokenBucketPacer,
} from '../src/server/apple-client.js';
import type { WatchedProduct } from '../src/shared/types.js';

describe('Apple Retail Pickup Response Parser & Anti-Ban Pacer', () => {
  it('parses available, unavailable, and pre-launch default pickupDisplay states accurately', () => {
    const sample = JSON.stringify({
      head: { status: '200' },
      body: {
        stores: [
          {
            storeNumber: 'R254',
            storeName: 'Domain NORTHSIDE',
            city: 'Austin',
            state: 'TX',
            storeDistanceWithUnit: '4.1 mi',
            partsAvailability: {
              'MJQ34LL/A': {
                partNumber: 'MJQ34LL/A',
                pickupDisplay: 'available',
                pickupSearchQuote: 'Available Today',
                messageTypes: {
                  regular: {
                    storePickupProductTitle: 'iPhone 18 Pro 256GB Black',
                  },
                },
              },
              'MDWK4LL/A': {
                partNumber: 'MDWK4LL/A',
                pickupDisplay: 'unavailable',
                pickupSearchQuote: 'Currently unavailable',
              },
              'MJD04LL/A': {
                partNumber: 'MJD04LL/A',
                pickupDisplay: 'default',
                pickupSearchQuote: 'Check back later',
              },
            },
          },
        ],
      },
    });

    const parsed = parsePickupResponse(200, sample);
    expect(parsed.ok).toBe(true);
    expect(parsed.coveredStoreIds.has('R254')).toBe(true);
    expect(parsed.stores[0]?.distance).toBe('4.1 mi');

    const inStock = parsed.byStoreAndPart.get('R254::MJQ34LL/A');
    expect(inStock?.status).toBe('in_stock');
    expect(inStock?.pickupQuote).toBe('Available Today');

    const oos = parsed.byStoreAndPart.get('R254::MDWK4LL/A');
    expect(oos?.status).toBe('out_of_stock');

    const preLaunch = parsed.byStoreAndPart.get('R254::MJD04LL/A');
    expect(preLaunch?.status).toBe('unknown');
    expect(preLaunch?.unknownReason).toBe('pickup_not_open');
  });

  it('never misclassifies HTTP 541, 403, or HTML 200 block pages as out_of_stock', () => {
    const r541 = parsePickupResponse(541, '<html>Edge Block</html>');
    expect(r541.ok).toBe(false);
    expect(r541.envelopeError?.reason).toBe('blocked');
    expect(r541.envelopeError?.outcome).toBe('blocked_541');

    const html200 = parsePickupResponse(200, '<!DOCTYPE html><html><body>Access Denied</body></html>');
    expect(html200.ok).toBe(false);
    expect(html200.envelopeError?.reason).toBe('blocked');

    const r429 = parsePickupResponse(429, '{}');
    expect(r429.ok).toBe(false);
    expect(r429.envelopeError?.reason).toBe('rate_limited');
  });

  it('packs watched SKUs into <= 8 query parts and injects shared Watch companion bands cleanly', () => {
    const watches: WatchedProduct[] = Array.from({ length: 7 }, (_, i) => ({
      partNumber: `MJF${i}4LS/A`,
      title: `Apple Watch Variant ${i}`,
      category: 'watch',
      familyLabel: 'Apple Watch',
      capacity: '',
      color: 'Black',
      companionPart: 'MJVK4AM/A',
      buyUrl: 'https://www.apple.com/shop/buy-watch/apple-watch',
      favorite: false,
      addedAtMs: 1000 + i,
    }));

    // 7 watches sharing 1 companion band = 8 total queryParts -> fits in 1 single batch!
    const batches = buildPartBatches(watches, 'https://www.apple.com');
    expect(batches).toHaveLength(1);
    expect(batches[0]?.watchedParts).toHaveLength(7);
    expect(batches[0]?.queryParts).toHaveLength(8);
    expect(batches[0]?.queryParts).toContain('MJVK4AM/A');
    expect(batches[0]?.watchedParts).not.toContain('MJVK4AM/A');

    // Adding an 8th watch overflows neatly into a 2nd batch
    const eightWatches = [
      ...watches,
      {
        ...watches[0]!,
        partNumber: 'MJFX4LS/A',
      },
    ];
    const twoBatches = buildPartBatches(eightWatches, 'https://www.apple.com');
    expect(twoBatches).toHaveLength(2);
    expect(twoBatches[0]?.queryParts.length).toBeLessThanOrEqual(8);
    expect(twoBatches[1]?.queryParts).toEqual(['MJFX4LS/A', 'MJVK4AM/A']);
  });

  it('escalates BlockTracker only on failed probes and resets cleanly on 200', () => {
    const tracker = new BlockTracker();
    const t0 = 1_000_000;

    // First 541 -> Level 1 (5 minutes)
    const until1 = tracker.recordBlocked(t0);
    expect(tracker.getLevel()).toBe(1);
    expect(until1 - t0).toBe(5 * 60_000);

    // Concurrent in-flight request failing 200ms later MUST NOT double-escalate level!
    const untilConcurrent = tracker.recordBlocked(t0 + 200);
    expect(tracker.getLevel()).toBe(1);
    expect(untilConcurrent).toBe(until1);

    // After 5m expires, probe runs and fails -> escalates to Level 2 (10 minutes)
    const tProbe = until1 + 1_000;
    expect(tracker.needsRecoveryProbe(tProbe)).toBe(true);
    tracker.beginProbe();
    const until2 = tracker.recordBlocked(tProbe);
    expect(tracker.getLevel()).toBe(2);
    expect(until2 - tProbe).toBe(10 * 60_000);

    // Subsequent successful probe resets level to 0 immediately
    tracker.recordSuccess();
    expect(tracker.getLevel()).toBe(0);
    expect(tracker.isCoolingDown(tProbe + 2_000)).toBe(false);
  });

  it('refills TokenBucketPacer over time and parses Retry-After headers', () => {
    const pacer = new TokenBucketPacer(20, 45_000, 0);
    expect(pacer.getAvailableTokens(0)).toBe(20);
    pacer.forceConsume(20, 0);
    expect(pacer.getAvailableTokens(0)).toBe(0);
    expect(pacer.waitMsForTokens(2, 0)).toBe(90_000);
    expect(pacer.getAvailableTokens(90_000)).toBe(2);

    expect(parseRetryAfterMs('120', 1000)).toBe(120_000);
  });
});
