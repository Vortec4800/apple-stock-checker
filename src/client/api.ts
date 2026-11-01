import type {
  AppSettings,
  AppStateSnapshot,
  CatalogProduct,
  Category,
  NotificationLog,
  PushoverPriority,
  RegionInfo,
  RequestLog,
  RestockEvent,
  StoreInfo,
} from '../shared/types.js';

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    ...(init?.headers as Record<string, string> | undefined),
  };

  const resp = await fetch(url, {
    ...init,
    headers,
  });

  if (!resp.ok) {
    let errText = `HTTP ${resp.status}`;
    try {
      const data = (await resp.json()) as { error?: string };
      if (data.error) errText = data.error;
    } catch {
      // Ignore non-JSON error body
    }
    throw new Error(errText);
  }

  return (await resp.json()) as T;
}

export const api = {
  getState: () => requestJson<AppStateSnapshot>('/api/state'),

  startWatcher: () =>
    requestJson<AppStateSnapshot>('/api/watcher/start', { method: 'POST' }),

  stopWatcher: () =>
    requestJson<AppStateSnapshot>('/api/watcher/stop', { method: 'POST' }),

  checkNow: () =>
    requestJson<AppStateSnapshot>('/api/watcher/check-now', { method: 'POST' }),

  getRegions: () => requestJson<{ regions: RegionInfo[] }>('/api/regions'),

  getStores: (locale: string) =>
    requestJson<{ locale: string; stores: StoreInfo[] }>(
      `/api/stores?locale=${encodeURIComponent(locale)}`
    ),

  lookupNearbyStores: (locale: string, query: string) =>
    requestJson<{ stores: StoreInfo[]; warning?: string }>('/api/stores/lookup', {
      method: 'POST',
      body: JSON.stringify({ locale, query }),
    }),

  refreshLiveStores: (locale: string) =>
    requestJson<{ count: number; stores: StoreInfo[] }>('/api/stores/refresh-live', {
      method: 'POST',
      body: JSON.stringify({ locale }),
    }),

  updateArea: (payload: {
    locale?: string;
    pickupLocation?: string;
    useLocationBatching?: boolean;
    stores?: StoreInfo[];
  }) =>
    requestJson<AppStateSnapshot>('/api/area', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),

  getCatalog: (locale: string, category?: Category) => {
    const params = new URLSearchParams({ locale });
    if (category) params.set('category', category);
    return requestJson<{ locale: string; products: CatalogProduct[] }>(
      `/api/catalog?${params.toString()}`
    );
  },

  refreshLiveCatalog: (locale: string, category?: Category) =>
    requestJson<{
      refreshedPages: number;
      productsFound: number;
      failures: string[];
      products: CatalogProduct[];
    }>('/api/catalog/refresh', {
      method: 'POST',
      body: JSON.stringify({ locale, category }),
    }),

  addToWatchlist: (
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
    }>
  ) =>
    requestJson<AppStateSnapshot>('/api/watchlist', {
      method: 'POST',
      body: JSON.stringify({ items }),
    }),

  toggleFavorite: (partNumber: string, favorite: boolean) =>
    requestJson<AppStateSnapshot>('/api/watchlist', {
      method: 'PATCH',
      body: JSON.stringify({ partNumber, favorite }),
    }),

  removeFromWatchlist: (partNumber: string) =>
    requestJson<AppStateSnapshot>(
      `/api/watchlist?partNumber=${encodeURIComponent(partNumber)}`,
      { method: 'DELETE' }
    ),

  updateSettings: (patch: Partial<AppSettings>) =>
    requestJson<AppStateSnapshot>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),

  sendTestPushover: (priority?: PushoverPriority, sound?: string) =>
    requestJson<{ success: boolean; error?: string; snapshot: AppStateSnapshot }>(
      '/api/pushover/test',
      {
        method: 'POST',
        body: JSON.stringify({ priority, sound }),
      }
    ),

  getRestockHistory: (limit = 200) =>
    requestJson<{ events: RestockEvent[] }>(`/api/history/restocks?limit=${limit}`),

  getNotificationHistory: (limit = 200) =>
    requestJson<{ logs: NotificationLog[] }>(`/api/history/notifications?limit=${limit}`),

  getRequestDiagnostics: (limit = 150) =>
    requestJson<{ logs: RequestLog[] }>(`/api/diagnostics/requests?limit=${limit}`),

  clearHistory: () =>
    requestJson<AppStateSnapshot>('/api/history', { method: 'DELETE' }),
};
