import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import type {
  AvailabilityKind,
  RegionInfo,
  RequestOutcome,
  StoreInfo,
  UnknownReasonKind,
  WatchedProduct,
} from '../shared/types.js';

export const MAX_PARTS_PER_REQUEST = 8;
export const MAX_PICKUPS_PER_SESSION = 24;
export const MAX_SESSION_AGE_MS = 45 * 60_000;
const MIN_REQUEST_SPACING_MS = 500;
const REQUEST_TIMEOUT_MS = 18_000;
export const COOLDOWN_LADDER_MS = [
  20 * 60_000,  // Level 1: 20m uninterrupted edge penalty recovery
  30 * 60_000,  // Level 2: 30m
  45 * 60_000,  // Level 3: 45m
  60 * 60_000,  // Level 4+: 60m
];

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
const SEC_CH_UA = '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"';

export interface ParsedPartAvailability {
  status: AvailabilityKind;
  unknownReason?: UnknownReasonKind;
  unknownDetail?: string;
  pickupQuote?: string;
  storePickupProductTitle?: string;
}

export interface DiscoveredStore extends StoreInfo {
  distance?: string;
}

export interface ParsedPickupEnvelope {
  ok: boolean;
  envelopeError?: {
    reason: UnknownReasonKind;
    detail: string;
    outcome: RequestOutcome;
  };
  stores: DiscoveredStore[];
  byStoreAndPart: Map<string, ParsedPartAvailability>;
  coveredStoreIds: Set<string>;
}

export class TokenBucketPacer {
  public readonly capacity: number;
  public readonly refillEveryMs: number;
  private tokens: number;
  private lastRefillMs: number;

  constructor(capacity = 15, refillEveryMs = 120_000, now = Date.now()) {
    this.capacity = capacity;
    this.refillEveryMs = refillEveryMs;
    this.tokens = capacity;
    this.lastRefillMs = now;
  }

  public refill(now = Date.now()): void {
    if (now <= this.lastRefillMs) return;
    const elapsed = now - this.lastRefillMs;
    const gained = elapsed / this.refillEveryMs;
    this.tokens = Math.min(this.capacity, this.tokens + gained);
    this.lastRefillMs = now;
  }

  public getAvailableTokens(now = Date.now()): number {
    this.refill(now);
    return Math.floor(this.tokens * 10) / 10;
  }

  public tryConsume(count = 1, now = Date.now()): boolean {
    this.refill(now);
    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }

  public forceConsume(count = 1, now = Date.now()): void {
    this.refill(now);
    this.tokens = Math.max(0, this.tokens - count);
  }

  public waitMsForTokens(needed = 1, now = Date.now()): number {
    this.refill(now);
    if (this.tokens >= needed) return 0;
    const deficit = needed - this.tokens;
    return Math.ceil(deficit * this.refillEveryMs);
  }
}

export class BlockTracker {
  private level = 0;
  private cooldownUntilMs: number | null = null;
  private probeInFlight = false;

  public getLevel(): number {
    return this.level;
  }

  public getCooldownUntilMs(now = Date.now()): number | null {
    if (this.cooldownUntilMs !== null && now < this.cooldownUntilMs) {
      return this.cooldownUntilMs;
    }
    return null;
  }

  public isCoolingDown(now = Date.now()): boolean {
    return this.getCooldownUntilMs(now) !== null;
  }

  /**
   * Returns true if we have previously cooled down (level > 0), the cooldown window
   * has expired, and we should send a single probe request before resuming full fan-out.
   */
  public needsRecoveryProbe(now = Date.now()): boolean {
    return this.level > 0 && !this.isCoolingDown(now);
  }

  public beginProbe(): void {
    this.probeInFlight = true;
  }

  public recordBlocked(now = Date.now(), retryAfterMs?: number): number {
    // Do not multi-escalate if concurrent requests in the same burst fail while already cooling down
    if (this.cooldownUntilMs !== null && now < this.cooldownUntilMs && !this.probeInFlight) {
      return this.cooldownUntilMs;
    }
    this.probeInFlight = false;
    this.level = Math.min(this.level + 1, COOLDOWN_LADDER_MS.length);
    const ladderDuration =
      COOLDOWN_LADDER_MS[Math.min(this.level - 1, COOLDOWN_LADDER_MS.length - 1)]!;
    const duration = retryAfterMs ? Math.max(ladderDuration, retryAfterMs) : ladderDuration;
    this.cooldownUntilMs = now + duration;
    return this.cooldownUntilMs;
  }

  public recordRateLimited(now = Date.now(), retryAfterMs?: number): number {
    const duration = retryAfterMs && retryAfterMs > 0 ? retryAfterMs : 60_000;
    const until = now + duration;
    if (this.cooldownUntilMs === null || until > this.cooldownUntilMs) {
      this.cooldownUntilMs = until;
    }
    this.probeInFlight = false;
    return this.cooldownUntilMs;
  }

  public recordSuccess(): void {
    this.level = 0;
    this.cooldownUntilMs = null;
    this.probeInFlight = false;
  }
}

export function parseRetryAfterMs(headerVal: string | null, now = Date.now()): number | undefined {
  if (!headerVal) return undefined;
  const trimmed = headerVal.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) {
    const secs = Number.parseInt(trimmed, 10);
    return Math.min(3600_000, Math.max(1_000, secs * 1000));
  }
  const parsedDate = Date.parse(trimmed);
  if (!Number.isNaN(parsedDate) && parsedDate > now) {
    return Math.min(3600_000, parsedDate - now);
  }
  return undefined;
}

export function acceptLanguageForLocale(locale: string): string {
  const normalized = locale.replace('_', '-');
  const lang = normalized.split('-')[0] || 'en';
  return `${normalized},${lang};q=0.9,en;q=0.8`;
}

/**
 * Packs watched products into batches of at most `MAX_PARTS_PER_REQUEST` (8) Apple SKUs,
 * automatically injecting each Apple Watch's `companionPart` band SKU into the same batch
 * without treating the companion band as a separate watched item.
 */
export interface PartBatch {
  watchedParts: string[];
  queryParts: string[];
  refererUrl: string;
}

export function buildPartBatches(
  products: WatchedProduct[],
  defaultRefererUrl: string
): PartBatch[] {
  const batches: PartBatch[] = [];
  let currentWatched: string[] = [];
  let currentQuerySet = new Set<string>();
  let currentReferer = defaultRefererUrl;

  for (const prod of products) {
    const part = prod.partNumber.trim();
    if (!part) continue;
    const companion = prod.companionPart?.trim();
    const neededNew =
      (currentQuerySet.has(part) ? 0 : 1) +
      (companion && companion !== part && !currentQuerySet.has(companion) ? 1 : 0);

    if (currentQuerySet.size > 0 && currentQuerySet.size + neededNew > MAX_PARTS_PER_REQUEST) {
      batches.push({
        watchedParts: currentWatched,
        queryParts: Array.from(currentQuerySet),
        refererUrl: currentReferer,
      });
      currentWatched = [];
      currentQuerySet = new Set<string>();
      currentReferer = defaultRefererUrl;
    }

    if (currentWatched.length === 0 && prod.buyUrl) {
      currentReferer = prod.buyUrl;
    }
    currentWatched.push(part);
    currentQuerySet.add(part);
    if (companion) {
      currentQuerySet.add(companion);
    }
  }

  if (currentWatched.length > 0) {
    batches.push({
      watchedParts: currentWatched,
      queryParts: Array.from(currentQuerySet),
      refererUrl: currentReferer,
    });
  }

  return batches;
}

export function parsePickupResponse(
  httpStatus: number,
  rawBody: string
): ParsedPickupEnvelope {
  const empty: ParsedPickupEnvelope = {
    ok: false,
    stores: [],
    byStoreAndPart: new Map(),
    coveredStoreIds: new Set(),
  };

  if (httpStatus === 541 || httpStatus === 403) {
    return {
      ...empty,
      envelopeError: {
        reason: 'blocked',
        detail: `Apple edge returned HTTP ${httpStatus} (temporary anti-bot block)`,
        outcome: 'blocked_541',
      },
    };
  }

  if (httpStatus === 429 || httpStatus === 503) {
    return {
      ...empty,
      envelopeError: {
        reason: 'rate_limited',
        detail: `Apple rate-limited request (HTTP ${httpStatus})`,
        outcome: 'rate_limited',
      },
    };
  }

  if (httpStatus < 200 || httpStatus >= 300) {
    return {
      ...empty,
      envelopeError: {
        reason: 'network_error',
        detail: `Unexpected HTTP status ${httpStatus}`,
        outcome: 'network_error',
      },
    };
  }

  const trimmed = rawBody.trim();
  if (!trimmed || trimmed.startsWith('<')) {
    return {
      ...empty,
      envelopeError: {
        reason: 'blocked',
        detail: 'HTTP 200 returned HTML/empty challenge instead of JSON',
        outcome: 'blocked_541',
      },
    };
  }

  let json: Record<string, unknown>;
  try {
    json = JSON.parse(trimmed) as Record<string, unknown>;
  } catch (err) {
    return {
      ...empty,
      envelopeError: {
        reason: 'schema_drift',
        detail: `Invalid JSON response: ${(err as Error).message}`,
        outcome: 'schema_drift',
      },
    };
  }

  const head = json.head as Record<string, unknown> | undefined;
  if (head && head.status !== undefined && head.status !== null) {
    const headStatus = String(head.status).trim();
    if (headStatus !== '200') {
      return {
        ...empty,
        envelopeError: {
          reason: 'apple_error',
          detail: `Apple envelope head.status = ${headStatus}`,
          outcome: 'apple_error',
        },
      };
    }
  }

  const body =
    json.body && typeof json.body === 'object'
      ? (json.body as Record<string, unknown>)
      : json;

  const pickupMessage =
    body.content &&
    typeof body.content === 'object' &&
    (body.content as Record<string, unknown>).pickupMessage &&
    typeof (body.content as Record<string, unknown>).pickupMessage === 'object'
      ? ((body.content as Record<string, unknown>).pickupMessage as Record<string, unknown>)
      : body;

  const errorMessage = pickupMessage.errorMessage ?? body.errorMessage;
  if (typeof errorMessage === 'string' && errorMessage.trim()) {
    return {
      ...empty,
      envelopeError: {
        reason: 'apple_error',
        detail: errorMessage.trim(),
        outcome: 'apple_error',
      },
    };
  }

  const rawStores = pickupMessage.stores;
  if (!Array.isArray(rawStores)) {
    return {
      ...empty,
      envelopeError: {
        reason: 'schema_drift',
        detail: 'Missing `body.stores` array in Apple pickup response',
        outcome: 'schema_drift',
      },
    };
  }

  const stores: DiscoveredStore[] = [];
  const coveredStoreIds = new Set<string>();
  const byStoreAndPart = new Map<string, ParsedPartAvailability>();

  for (const s of rawStores) {
    if (!s || typeof s !== 'object') continue;
    const storeObj = s as Record<string, unknown>;
    const storeId = String(storeObj.storeNumber ?? storeObj.id ?? '').trim();
    if (!storeId) continue;
    coveredStoreIds.add(storeId);

    const addr =
      storeObj.address && typeof storeObj.address === 'object'
        ? (storeObj.address as Record<string, unknown>)
        : {};

    stores.push({
      id: storeId,
      name: String(storeObj.storeName ?? storeObj.name ?? storeId).trim(),
      slug: String(storeObj.storeSlug ?? '').trim(),
      city: String(storeObj.city ?? addr.city ?? '').trim(),
      state: String(storeObj.state ?? addr.stateName ?? '').trim(),
      stateCode: String(storeObj.state ?? addr.stateCode ?? '').trim(),
      postalCode: String(addr.postalCode ?? storeObj.postalCode ?? '').trim(),
      address1: String(addr.address ?? addr.address2 ?? '').trim(),
      telephone: String(addr.phone ?? storeObj.phoneNumber ?? '').trim(),
      ...(typeof storeObj.storeDistanceWithUnit === 'string' && storeObj.storeDistanceWithUnit
        ? { distance: storeObj.storeDistanceWithUnit }
        : {}),
    });

    const partsAvail = storeObj.partsAvailability;
    if (!partsAvail || typeof partsAvail !== 'object') continue;

    for (const [rawPartKey, rawEntry] of Object.entries(
      partsAvail as Record<string, unknown>
    )) {
      if (!rawEntry || typeof rawEntry !== 'object') continue;
      const entry = rawEntry as Record<string, unknown>;
      const partKey = String(entry.partNumber ?? rawPartKey).trim().toUpperCase();
      const pickupDisplay =
        typeof entry.pickupDisplay === 'string' ? entry.pickupDisplay.trim().toLowerCase() : '';

      const msgTypes =
        entry.messageTypes && typeof entry.messageTypes === 'object'
          ? (entry.messageTypes as Record<string, unknown>)
          : undefined;
      const regularMsg =
        msgTypes?.regular && typeof msgTypes.regular === 'object'
          ? (msgTypes.regular as Record<string, unknown>)
          : undefined;

      const quote = String(
        entry.pickupSearchQuote ??
          regularMsg?.storePickupQuote ??
          entry.storePickupQuote ??
          ''
      ).trim();

      const productTitle = String(
        regularMsg?.storePickupProductTitle ?? entry.storePickupProductTitle ?? ''
      ).trim();

      let parsed: ParsedPartAvailability;
      if (pickupDisplay === 'available') {
        parsed = {
          status: 'in_stock',
          pickupQuote: quote || 'Available for Pickup',
          ...(productTitle ? { storePickupProductTitle: productTitle } : {}),
        };
      } else if (pickupDisplay === 'unavailable' || pickupDisplay === 'ineligible') {
        parsed = {
          status: 'out_of_stock',
          pickupQuote: quote || 'Currently unavailable',
          ...(productTitle ? { storePickupProductTitle: productTitle } : {}),
        };
      } else if (pickupDisplay === 'default') {
        parsed = {
          status: 'unknown',
          unknownReason: 'pickup_not_open',
          unknownDetail:
            'In-store pickup has not opened yet for this model (pickupDisplay = default)',
          ...(quote ? { pickupQuote: quote } : {}),
        };
      } else {
        parsed = {
          status: 'unknown',
          unknownReason: 'schema_drift',
          unknownDetail: `Unrecognized pickupDisplay="${pickupDisplay}"`,
        };
      }

      byStoreAndPart.set(`${storeId}::${partKey}`, parsed);
    }
  }

  return {
    ok: true,
    stores,
    byStoreAndPart,
    coveredStoreIds,
  };
}

interface RouteSession {
  label: string;
  proxyUrl?: string;
  dispatcher?: Dispatcher;
  cookiesByHost: Map<string, Map<string, string>>;
  warmedLocales: Set<string>;
  sessionStartedAtMs: number;
  sessionPickupCount: number;
  pacer: TokenBucketPacer;
  blocker: BlockTracker;
  lastRequestAtMs: number;
}

export interface RequestLogRecorder {
  (entry: {
    createdAtMs: number;
    endpoint: string;
    routeLabel: string;
    httpStatus: number | null;
    durationMs: number;
    partsCount: number;
    outcome: RequestOutcome;
    detail: string | null;
  }): void;
}

export class AppleRetailClient {
  private routes: RouteSession[] = [];
  private routeCursor = 0;
  private proxiesSignature = '';
  private logRecorder?: RequestLogRecorder;

  constructor(proxies: string[] = [], logRecorder?: RequestLogRecorder) {
    this.logRecorder = logRecorder;
    this.configureRoutes(proxies);
  }

  public configureRoutes(proxies: string[]): void {
    const cleaned = proxies.map((p) => p.trim()).filter(Boolean);
    const sig = cleaned.join('|');
    if (sig === this.proxiesSignature && this.routes.length > 0) return;
    this.proxiesSignature = sig;

    if (cleaned.length === 0) {
      this.routes = [
        {
          label: 'direct',
          cookiesByHost: new Map(),
          warmedLocales: new Set(),
          sessionStartedAtMs: 0,
          sessionPickupCount: 0,
          pacer: new TokenBucketPacer(15, 120_000),
          blocker: new BlockTracker(),
          lastRequestAtMs: 0,
        },
      ];
    } else {
      this.routes = cleaned.map((proxyUrl, idx) => {
        let hostLabel = `proxy-${idx + 1}`;
        try {
          const u = new URL(proxyUrl);
          hostLabel = `proxy:${u.hostname}:${u.port || '80'}`;
        } catch {
          // Keep fallback label
        }
        return {
          label: hostLabel,
          proxyUrl,
          dispatcher: new ProxyAgent(proxyUrl),
          cookiesByHost: new Map(),
          warmedLocales: new Set(),
          sessionStartedAtMs: 0,
          sessionPickupCount: 0,
          pacer: new TokenBucketPacer(15, 120_000),
          blocker: new BlockTracker(),
          lastRequestAtMs: 0,
        };
      });
    }
    this.routeCursor = 0;
  }

  public getAggregateHealth(now = Date.now()): {
    availableTokens: number;
    totalCapacity: number;
    cooldownUntilMs: number | null;
    maxCooldownLevel: number;
    allCoolingDown: boolean;
  } {
    let availableTokens = 0;
    let totalCapacity = 0;
    let earliestCooldown: number | null = null;
    let maxCooldownLevel = 0;
    let unblockedCount = 0;

    for (const r of this.routes) {
      availableTokens += r.pacer.getAvailableTokens(now);
      totalCapacity += r.pacer.capacity;
      maxCooldownLevel = Math.max(maxCooldownLevel, r.blocker.getLevel());
      const cd = r.blocker.getCooldownUntilMs(now);
      if (cd === null) {
        unblockedCount++;
      } else if (earliestCooldown === null || cd < earliestCooldown) {
        earliestCooldown = cd;
      }
    }

    return {
      availableTokens: Math.round(availableTokens * 10) / 10,
      totalCapacity,
      cooldownUntilMs: unblockedCount === 0 ? earliestCooldown : null,
      maxCooldownLevel,
      allCoolingDown: unblockedCount === 0,
    };
  }

  public recommendedWaitMsForRequests(requestCount: number, now = Date.now()): number {
    if (requestCount <= 0 || this.routes.length === 0) return 0;
    const perRoute = Math.ceil(requestCount / this.routes.length);
    const waits = this.routes.map((r) => {
      const cd = r.blocker.getCooldownUntilMs(now);
      const cdWait = cd ? Math.max(0, cd - now) : 0;
      return Math.max(cdWait, r.pacer.waitMsForTokens(Math.min(r.pacer.capacity, perRoute), now));
    });
    return Math.min(...waits);
  }

  private pickRoute(now = Date.now()): RouteSession {
    for (let i = 0; i < this.routes.length; i++) {
      const idx = (this.routeCursor + i) % this.routes.length;
      const candidate = this.routes[idx]!;
      if (!candidate.blocker.isCoolingDown(now)) {
        this.routeCursor = (idx + 1) % this.routes.length;
        return candidate;
      }
    }
    const fallback = this.routes[this.routeCursor % this.routes.length]!;
    this.routeCursor = (this.routeCursor + 1) % this.routes.length;
    return fallback;
  }

  private getCookieHeader(route: RouteSession, url: URL): string | undefined {
    const jar = route.cookiesByHost.get(url.hostname);
    if (!jar || jar.size === 0) return undefined;
    return Array.from(jar.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  private storeResponseCookies(
    route: RouteSession,
    url: URL,
    setCookies: string[]
  ): void {
    if (!setCookies.length) return;
    const jar = route.cookiesByHost.get(url.hostname) ?? new Map<string, string>();
    for (const raw of setCookies) {
      const parts = raw.split(';').map((p) => p.trim());
      const firstPair = parts[0];
      if (!firstPair) continue;
      const eq = firstPair.indexOf('=');
      if (eq <= 0) continue;
      const name = firstPair.slice(0, eq).trim();
      const val = firstPair.slice(eq + 1).trim();
      if (!name) continue;
      const isExpired = parts.slice(1).some((attr) => /^max-age\s*=\s*0$/i.test(attr));
      if (!val || val === '""' || isExpired) {
        jar.delete(name);
      } else {
        jar.set(name, val);
      }
    }
    route.cookiesByHost.set(url.hostname, jar);
  }

  private async enforceMinSpacing(route: RouteSession): Promise<void> {
    const now = Date.now();
    const additiveJitterMs = Math.round(Math.random() * 450);
    const wait = route.lastRequestAtMs + MIN_REQUEST_SPACING_MS + additiveJitterMs - now;
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    route.lastRequestAtMs = Date.now();
  }

  private buildNavigationHeaders(region: RegionInfo, referer?: string): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': CHROME_UA,
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': acceptLanguageForLocale(region.locale),
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      'sec-ch-ua': SEC_CH_UA,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': referer ? 'same-origin' : 'none',
      'sec-fetch-user': '?1',
      'upgrade-insecure-requests': '1',
    };
    if (referer) headers.Referer = referer;
    return headers;
  }

  private buildPickupHeaders(region: RegionInfo, refererUrl: string): Record<string, string> {
    return {
      'User-Agent': CHROME_UA,
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'Accept-Language': acceptLanguageForLocale(region.locale),
      'X-Requested-With': 'XMLHttpRequest',
      Referer: refererUrl,
      'sec-ch-ua': SEC_CH_UA,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
    };
  }

  private async ensureSessionWarm(route: RouteSession, region: RegionInfo): Promise<void> {
    const now = Date.now();
    const sessionExpired =
      route.sessionPickupCount >= MAX_PICKUPS_PER_SESSION ||
      (route.sessionStartedAtMs > 0 && now - route.sessionStartedAtMs >= MAX_SESSION_AGE_MS);

    if (route.warmedLocales.has(region.locale) && !sessionExpired) return;

    const isRotation = route.warmedLocales.has(region.locale) && sessionExpired;
    if (isRotation) {
      route.warmedLocales.delete(region.locale);
      route.cookiesByHost.clear();
      route.sessionPickupCount = 0;
      route.sessionStartedAtMs = 0;
    }

    const bagUrl = new URL(`${region.baseUrl}/shop/bag`);
    await this.enforceMinSpacing(route);

    const started = Date.now();
    try {
      const headers = this.buildNavigationHeaders(region, `${region.baseUrl}/`);
      const cookie = this.getCookieHeader(route, bagUrl);
      if (cookie) headers.Cookie = cookie;

      const resp = await undiciFetch(bagUrl.toString(), {
        method: 'GET',
        headers,
        dispatcher: route.dispatcher,
        redirect: 'follow',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      const setCookies =
        typeof resp.headers.getSetCookie === 'function' ? resp.headers.getSetCookie() : [];
      this.storeResponseCookies(route, bagUrl, setCookies);
      // Drain body cleanly
      await resp.arrayBuffer().catch(() => undefined);

      if (resp.status >= 200 && resp.status < 400) {
        route.warmedLocales.add(region.locale);
        route.sessionStartedAtMs = Date.now();
        route.sessionPickupCount = 0;
      } else if (resp.status === 541 || resp.status === 403) {
        const retryAfterMs = parseRetryAfterMs(resp.headers.get('retry-after'));
        route.blocker.recordBlocked(Date.now(), retryAfterMs);
      }
      this.logRecorder?.({
        createdAtMs: started,
        endpoint: '/shop/bag (warmup)',
        routeLabel: route.label,
        httpStatus: resp.status,
        durationMs: Date.now() - started,
        partsCount: 0,
        outcome: resp.status === 541 || resp.status === 403 ? 'blocked_541' : 'ok',
        detail: isRotation
          ? `Proactive session rotation (${setCookies.length} cookies set)`
          : `Session cookie warmup (${setCookies.length} cookies set)`,
      });
    } catch (err) {
      this.logRecorder?.({
        createdAtMs: started,
        endpoint: '/shop/bag (warmup)',
        routeLabel: route.label,
        httpStatus: null,
        durationMs: Date.now() - started,
        partsCount: 0,
        outcome: 'network_error',
        detail: `Warmup failed: ${(err as Error).message}`,
      });
    }
  }

  public async fetchPickupBatch(params: {
    region: RegionInfo;
    queryParts: string[];
    location?: string;
    storeId?: string;
    searchNearby?: boolean;
    refererUrl: string;
  }): Promise<ParsedPickupEnvelope> {
    const route = this.pickRoute();
    const now = Date.now();
    const activeCooldown = route.blocker.getCooldownUntilMs(now);
    if (activeCooldown !== null) {
      const secsLeft = Math.ceil((activeCooldown - now) / 1000);
      return {
        ok: false,
        stores: [],
        byStoreAndPart: new Map(),
        coveredStoreIds: new Set(),
        envelopeError: {
          reason: 'blocked',
          detail: `Cooling down after HTTP 541 block (${secsLeft}s remaining)`,
          outcome: 'blocked_541',
        },
      };
    }

    const isProbe = route.blocker.needsRecoveryProbe(now);
    if (isProbe) {
      route.blocker.beginProbe();
    }

    await this.ensureSessionWarm(route, params.region);

    const postWarmupCooldown = route.blocker.getCooldownUntilMs(Date.now());
    if (postWarmupCooldown !== null) {
      const secsLeft = Math.ceil((postWarmupCooldown - Date.now()) / 1000);
      return {
        ok: false,
        stores: [],
        byStoreAndPart: new Map(),
        coveredStoreIds: new Set(),
        envelopeError: {
          reason: 'blocked',
          detail: `Warmup blocked by HTTP 541 (${secsLeft}s cooldown)`,
          outcome: 'blocked_541',
        },
      };
    }

    await this.enforceMinSpacing(route);
    route.pacer.forceConsume(1, Date.now());

    const url = new URL(`${params.region.baseUrl}/shop/retail/pickup-message`);
    url.searchParams.set('pl', 'true');
    url.searchParams.set('mts.0', 'regular');
    params.queryParts.forEach((part, idx) => {
      url.searchParams.set(`parts.${idx}`, part);
    });
    if (params.location) {
      url.searchParams.set('location', params.location);
    } else if (params.storeId) {
      url.searchParams.set('store', params.storeId);
      if (params.searchNearby) {
        url.searchParams.set('searchNearby', 'true');
      }
    }

    const started = Date.now();
    const endpointDesc = params.location
      ? `/shop/retail/pickup-message?location=${params.location}`
      : `/shop/retail/pickup-message?store=${params.storeId}`;

    try {
      const headers = this.buildPickupHeaders(params.region, params.refererUrl);
      const cookie = this.getCookieHeader(route, url);
      if (cookie) headers.Cookie = cookie;

      const resp = await undiciFetch(url.toString(), {
        method: 'GET',
        headers,
        dispatcher: route.dispatcher,
        redirect: 'follow',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      const setCookies =
        typeof resp.headers.getSetCookie === 'function' ? resp.headers.getSetCookie() : [];
      this.storeResponseCookies(route, url, setCookies);

      const rawText = await resp.text();
      const durationMs = Date.now() - started;
      const retryAfterMs = parseRetryAfterMs(resp.headers.get('retry-after'));
      const parsed = parsePickupResponse(resp.status, rawText);

      if (parsed.ok) {
        route.sessionPickupCount += 1;
        route.blocker.recordSuccess();
        this.logRecorder?.({
          createdAtMs: started,
          endpoint: endpointDesc,
          routeLabel: route.label,
          httpStatus: resp.status,
          durationMs,
          partsCount: params.queryParts.length,
          outcome: 'ok',
          detail: `${parsed.coveredStoreIds.size} stores returned`,
        });
      } else {
        const errInfo = parsed.envelopeError!;
        if (errInfo.outcome === 'blocked_541') {
          route.warmedLocales.delete(params.region.locale);
          route.cookiesByHost.delete(url.hostname);
          route.sessionPickupCount = 0;
          route.sessionStartedAtMs = 0;
          route.blocker.recordBlocked(Date.now(), retryAfterMs);
        } else if (errInfo.outcome === 'rate_limited') {
          route.blocker.recordRateLimited(Date.now(), retryAfterMs);
        }
        this.logRecorder?.({
          createdAtMs: started,
          endpoint: endpointDesc,
          routeLabel: route.label,
          httpStatus: resp.status,
          durationMs,
          partsCount: params.queryParts.length,
          outcome: errInfo.outcome,
          detail: errInfo.detail,
        });
      }

      return parsed;
    } catch (err) {
      const durationMs = Date.now() - started;
      const message = (err as Error).message || 'Network transport failure';
      this.logRecorder?.({
        createdAtMs: started,
        endpoint: endpointDesc,
        routeLabel: route.label,
        httpStatus: null,
        durationMs,
        partsCount: params.queryParts.length,
        outcome: 'network_error',
        detail: message,
      });
      return {
        ok: false,
        stores: [],
        byStoreAndPart: new Map(),
        coveredStoreIds: new Set(),
        envelopeError: {
          reason: 'network_error',
          detail: message,
          outcome: 'network_error',
        },
      };
    }
  }

  public async fetchHtmlPage(region: RegionInfo, pageUrl: string): Promise<string> {
    const route = this.pickRoute();
    await this.enforceMinSpacing(route);
    const parsedUrl = new URL(pageUrl);
    const headers = this.buildNavigationHeaders(region, `${region.baseUrl}/`);
    const cookie = this.getCookieHeader(route, parsedUrl);
    if (cookie) headers.Cookie = cookie;

    const started = Date.now();
    const resp = await undiciFetch(pageUrl, {
      method: 'GET',
      headers,
      dispatcher: route.dispatcher,
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    });

    const setCookies =
      typeof resp.headers.getSetCookie === 'function' ? resp.headers.getSetCookie() : [];
    this.storeResponseCookies(route, parsedUrl, setCookies);
    const text = await resp.text();

    this.logRecorder?.({
      createdAtMs: started,
      endpoint: parsedUrl.pathname,
      routeLabel: route.label,
      httpStatus: resp.status,
      durationMs: Date.now() - started,
      partsCount: 0,
      outcome: resp.status === 541 || resp.status === 403 ? 'blocked_541' : resp.ok ? 'ok' : 'network_error',
      detail: `Catalog/Store page fetch (${text.length} chars)`,
    });

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} fetching ${pageUrl}`);
    }
    return text;
  }
}
