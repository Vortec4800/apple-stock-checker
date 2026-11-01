import { describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/server/db.js';
import { applyCycleObservations } from '../src/server/watcher.js';
import type { StoreInfo, WatchedProduct } from '../src/shared/types.js';

describe('Watcher Trigger & Restock Duration State Machine', () => {
  const stores: StoreInfo[] = [
    {
      id: 'R254',
      name: 'Domain NORTHSIDE',
      slug: 'domainnorthside',
      city: 'Austin',
      state: 'Texas',
      stateCode: 'TX',
      postalCode: '78758',
      address1: '3121 Palm Way',
      telephone: '',
    },
    {
      id: 'R079',
      name: 'Barton Creek',
      slug: 'bartoncreek',
      city: 'Austin',
      state: 'Texas',
      stateCode: 'TX',
      postalCode: '78746',
      address1: '2901 S Capital of Texas Hwy',
      telephone: '',
    },
    {
      id: 'R215',
      name: 'La Cantera',
      slug: 'lacantera',
      city: 'San Antonio',
      state: 'Texas',
      stateCode: 'TX',
      postalCode: '78256',
      address1: '15900 La Cantera Pkwy',
      telephone: '',
    },
  ];

  const product: WatchedProduct = {
    partNumber: 'MJQ34LL/A',
    title: 'iPhone 18 Pro 256GB Black',
    category: 'iphone',
    familyLabel: 'iPhone 18 Pro',
    capacity: '256GB',
    color: 'Black',
    buyUrl: 'https://www.apple.com/shop/buy-iphone/iphone-18-pro',
    favorite: true,
    addedAtMs: 1_000,
  };

  it('tracks area store counts, preserves restocks across transient HTTP 541 unknowns, and records exact duration on sellout', () => {
    const db = new AppDatabase(':memory:');
    db.setWatchedStores('en_US', stores);
    db.addWatchedProducts('en_US', [product]);
    const settings = db.getSettings();

    // Cycle 1 (t = 10_000): 2 of 3 stores come IN STOCK
    const t1 = 10_000;
    const alerts1 = applyCycleObservations({
      db,
      settings,
      watchedStores: stores,
      watchedProducts: [product],
      now: t1,
      observations: [
        {
          store: stores[0]!,
          product,
          availability: { status: 'in_stock', pickupQuote: 'Available Today' },
        },
        {
          store: stores[1]!,
          product,
          availability: { status: 'in_stock', pickupQuote: 'Available Today' },
        },
        {
          store: stores[2]!,
          product,
          availability: { status: 'out_of_stock', pickupQuote: 'Currently unavailable' },
        },
      ],
    });

    // Coalesced into 1 notification covering both newly restocked stores + area count 2/3
    expect(alerts1).toHaveLength(1);
    expect(alerts1[0]?.kind).toBe('restock');
    expect(alerts1[0]?.stores).toHaveLength(2);
    expect(alerts1[0]?.areaInStockCount).toBe(2);
    expect(alerts1[0]?.areaTotalStores).toBe(3);

    const eventsAfter1 = db.getRestockEvents();
    expect(eventsAfter1).toHaveLength(2);
    expect(eventsAfter1[0]?.soldOutMs).toBeNull();
    expect(eventsAfter1[0]?.areaInStockCount).toBe(2);

    // Cycle 2 (t = 50_000): Transient HTTP 541 block (`unknown`) occurs!
    // MUST NOT close open restock events or reset alert state!
    const t2 = 50_000;
    const alerts2 = applyCycleObservations({
      db,
      settings,
      watchedStores: stores,
      watchedProducts: [product],
      now: t2,
      observations: stores.map((st) => ({
        store: st,
        product,
        availability: {
          status: 'unknown',
          unknownReason: 'blocked',
          unknownDetail: 'HTTP 541',
        },
      })),
    });

    expect(alerts2).toHaveLength(0);
    const eventsAfter2 = db.getRestockEvents();
    expect(eventsAfter2).toHaveLength(2);
    expect(eventsAfter2.every((e) => e.soldOutMs === null)).toBe(true);

    // Cycle 3 (t = 400_000): Cooldown recovers and stores 0 & 1 are STILL in stock!
    // Because alertRepeatMode = 'once_per_restock', NO duplicate initial alert should fire!
    const t3 = 400_000;
    const alerts3 = applyCycleObservations({
      db,
      settings,
      watchedStores: stores,
      watchedProducts: [product],
      now: t3,
      observations: [
        {
          store: stores[0]!,
          product,
          availability: { status: 'in_stock', pickupQuote: 'Available Today' },
        },
        {
          store: stores[1]!,
          product,
          availability: { status: 'in_stock', pickupQuote: 'Available Today' },
        },
        {
          store: stores[2]!,
          product,
          availability: { status: 'out_of_stock' },
        },
      ],
    });
    expect(alerts3).toHaveLength(0);
    expect(db.getRestockEvents()).toHaveLength(2);

    // Cycle 4 (t = 490_000 -> 480s = 8m duration): All stores explicitly sell out (`out_of_stock`)
    const t4 = 490_000;
    const alerts4 = applyCycleObservations({
      db,
      settings,
      watchedStores: stores,
      watchedProducts: [product],
      now: t4,
      observations: stores.map((st) => ({
        store: st,
        product,
        availability: { status: 'out_of_stock', pickupQuote: 'Currently unavailable' },
      })),
    });
    expect(alerts4).toHaveLength(0);

    const closedEvents = db.getRestockEvents();
    expect(closedEvents).toHaveLength(2);
    for (const ev of closedEvents) {
      expect(ev.soldOutMs).toBe(t4);
      expect(ev.durationMs).toBe(t4 - t1); // 480,000 ms (8m 0s)
    }

    db.close();
  });
});
