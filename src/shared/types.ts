export type Category =
  | 'iphone'
  | 'ipad'
  | 'mac'
  | 'watch'
  | 'airpods'
  | 'homepod'
  | 'vision';

export const CATEGORY_LABELS: Record<Category, string> = {
  iphone: 'iPhone',
  ipad: 'iPad',
  mac: 'Mac',
  watch: 'Apple Watch',
  airpods: 'AirPods',
  homepod: 'HomePod',
  vision: 'Apple Vision Pro',
};

export const ALL_CATEGORIES: Category[] = [
  'iphone',
  'ipad',
  'mac',
  'watch',
  'airpods',
  'homepod',
  'vision',
];

export interface RegionFamily {
  category: Category;
  slug: string;
}

export interface RegionInfo {
  locale: string;
  shortcode: string;
  name: string;
  baseUrl: string;
  postalPlaceholder: string;
  families: RegionFamily[];
}

export interface StoreInfo {
  id: string;
  name: string;
  slug: string;
  city: string;
  state: string;
  stateCode: string;
  postalCode: string;
  address1: string;
  telephone: string;
  distance?: string;
}

export interface CatalogProduct {
  partNumber: string;
  title: string;
  category: Category;
  family: string;
  familyLabel: string;
  pageSlug: string;
  capacity: string;
  color: string;
  companionPart?: string;
  buyUrl: string;
}

export type AvailabilityKind = 'in_stock' | 'out_of_stock' | 'unknown';

export type UnknownReasonKind =
  | 'not_yet_checked'
  | 'pickup_not_open'
  | 'blocked'
  | 'rate_limited'
  | 'schema_drift'
  | 'apple_error'
  | 'network_error';

export interface TargetState {
  partNumber: string;
  storeId: string;
  storeName: string;
  storeCity: string;
  status: AvailabilityKind;
  unknownReason?: UnknownReasonKind;
  unknownDetail?: string;
  pickupQuote?: string;
  storePickupProductTitle?: string;
  lastCheckedMs: number | null;
  lastStatusChangeMs: number | null;
  inStockSinceMs: number | null;
}

export interface WatchedProduct {
  partNumber: string;
  title: string;
  category: Category;
  familyLabel: string;
  capacity: string;
  color: string;
  companionPart?: string;
  buyUrl: string;
  favorite: boolean;
  addedAtMs: number;
}

export interface ProductSummary {
  product: WatchedProduct;
  inStockStoreCount: number;
  totalWatchedStores: number;
  outOfStockStoreCount: number;
  unknownStoreCount: number;
  activeRestockSinceMs: number | null;
  storeStates: TargetState[];
}

export interface RestockEvent {
  id: number;
  partNumber: string;
  productTitle: string;
  storeId: string;
  storeName: string;
  storeCity: string;
  quote: string;
  areaInStockCount: number;
  areaTotalStores: number;
  firstSeenMs: number;
  soldOutMs: number | null;
  durationMs: number | null;
}

export interface NotificationLog {
  id: number;
  createdAtMs: number;
  kind: 'restock' | 'repeat' | 'test';
  partNumber: string | null;
  productTitle: string;
  storeName: string;
  message: string;
  priority: number;
  success: boolean;
  errorDetail: string | null;
}

export type RequestOutcome =
  | 'ok'
  | 'blocked_541'
  | 'rate_limited'
  | 'apple_error'
  | 'schema_drift'
  | 'network_error';

export interface RequestLog {
  id: number;
  createdAtMs: number;
  endpoint: string;
  routeLabel: string;
  httpStatus: number | null;
  durationMs: number;
  partsCount: number;
  outcome: RequestOutcome;
  detail: string | null;
}

export type PushoverPriority = -1 | 0 | 1 | 2;

export interface AppSettings {
  locale: string;
  pickupLocation: string;
  useLocationBatching: boolean;
  pollIntervalSeconds: number;
  adaptivePacing: boolean;
  jitterPercent: number;
  alertRepeatMode: 'once_per_restock' | 'repeat_while_in_stock';
  repeatIntervalMinutes: number;
  maxAlertsPerRestock: number;
  minAlertGapSeconds: number;
  normalPriority: PushoverPriority;
  normalSound: string;
  favoritePriority: PushoverPriority;
  favoriteSound: string;
  proxies: string[];
}

export const DEFAULT_SETTINGS: AppSettings = {
  locale: 'en_US',
  pickupLocation: '',
  useLocationBatching: true,
  pollIntervalSeconds: 120,
  adaptivePacing: true,
  jitterPercent: 15,
  alertRepeatMode: 'once_per_restock',
  repeatIntervalMinutes: 5,
  maxAlertsPerRestock: 3,
  minAlertGapSeconds: 5,
  normalPriority: 0,
  normalSound: 'pushover',
  favoritePriority: 1,
  favoriteSound: 'persistent',
  proxies: [],
};

export interface PushoverEnvStatus {
  configured: boolean;
  hasUserKey: boolean;
  hasApiToken: boolean;
  maskedUserKey: string | null;
  maskedApiToken: string | null;
  device: string | null;
}

export interface WatcherHealth {
  running: boolean;
  checkingNow: boolean;
  lastCheckStartedMs: number | null;
  lastCheckFinishedMs: number | null;
  nextCheckAtMs: number | null;
  effectiveIntervalMs: number;
  consecutiveFailures: number;
  healthState: 'healthy' | 'cooldown_541' | 'degraded' | 'idle';
  healthMessage: string | null;
  budgetAvailableTokens: number;
  budgetCapacity: number;
  cooldownUntilMs: number | null;
  cooldownLevel: number;
}

export interface DashboardStats {
  watchedProductsCount: number;
  watchedStoresCount: number;
  inStockProductsCount: number;
  inStockPairsCount: number;
  totalRestocksFound: number;
  totalNotificationsSent: number;
}

export interface AppStateSnapshot {
  settings: AppSettings;
  pushover: PushoverEnvStatus;
  watcher: WatcherHealth;
  watchedStores: StoreInfo[];
  productSummaries: ProductSummary[];
  stats: DashboardStats;
  serverTimeMs: number;
}
