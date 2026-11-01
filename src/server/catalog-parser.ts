import type { CatalogProduct, Category } from '../shared/types.js';

export interface ConfigVariant {
  part: string;
  group: string;
  memory?: string;
  storage?: string;
}

const MODEL_TOKENS: Record<string, string> = {
  pro: 'Pro',
  max: 'Max',
  plus: 'Plus',
  mini: 'mini',
  air: 'Air',
  duo: 'Duo',
  se: 'SE',
  ultra: 'Ultra',
};

const SLUG_LABELS: Record<string, string> = {
  iphone: 'iPhone',
  ipad: 'iPad',
  imac: 'iMac',
  macbook: 'MacBook',
  mac: 'Mac',
  apple: 'Apple',
  watch: 'Watch',
  airpods: 'AirPods',
  homepod: 'HomePod',
  vision: 'Vision',
  air: 'Air',
  pro: 'Pro',
  max: 'Max',
  mini: 'mini',
  se: 'SE',
  ultra: 'Ultra',
  studio: 'Studio',
  xdr: 'XDR',
  hermes: 'Hermès',
};

const HTML_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  rsquo: '\u2019',
  lsquo: '\u2018',
  rdquo: '\u201d',
  ldquo: '\u201c',
  ndash: '\u2013',
  mdash: '\u2014',
  trade: '\u2122',
  reg: '\u00ae',
  copy: '\u00a9',
};

const DIMENSION_ORDER: Record<string, number> = {
  dimensionScreensize: 10,
  dimensionCaseSize: 20,
  dimensionCaseMaterial: 30,
  dimensionChip: 40,
  dimensionCapacity: 60,
  dimensionConnection: 70,
  dimensionFinish: 80,
  dimensionColor: 90,
};

export function buyPathForCategory(category: Category): string {
  return `buy-${category}`;
}

export function looksLikeApplePartNumber(value: string): boolean {
  const s = value.trim();
  return /^[A-Z0-9]{4,12}\/[A-Z0-9]{1,4}$/.test(s);
}

export function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z0-9]+);/g, (full, code: string) => {
    if (code.startsWith('#x') || code.startsWith('#X')) {
      const cp = Number.parseInt(code.slice(2), 16);
      return Number.isFinite(cp) && cp > 0 ? String.fromCodePoint(cp) : full;
    }
    if (code.startsWith('#')) {
      const cp = Number.parseInt(code.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 ? String.fromCodePoint(cp) : full;
    }
    return HTML_ENTITIES[code] ?? HTML_ENTITIES[code.toLowerCase()] ?? full;
  });
}

/**
 * Strips Apple's promotional badges, subheadings, and HTML markup from option labels,
 * returning the primary human-readable title line.
 */
export function plainTextFromAppleHtml(html: string): string {
  if (!html) return '';

  let cleaned = html
    // Remove promotional badges (e.g., "New") and secondary explainer subtitles
    .replace(
      /<([a-zA-Z0-9]+)\b[^>]*\bclass\s*=\s*["'][^"']*(?:\bbadge\b|\bbadge-[a-z0-9-]+|\bform-label-small\b|\bas-subheading\b)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi,
      '\n'
    )
    // Treat block-level tags and explicit line breaks as line separators
    .replace(/<\/?(?:div|p|br|li|ul|ol|section|article|header|footer|h[1-6])\b[^>]*>/gi, '\n')
    // Strip any remaining inline tags
    .replace(/<[^>]+>/g, '');

  cleaned = decodeHtmlEntities(cleaned).replace(/[\u200b-\u200d\u2060\ufeff]/g, '');

  for (const rawLine of cleaned.split(/[\r\n]+/)) {
    const normalized = rawLine.replace(/\s+/g, ' ').trim();
    if (normalized) return normalized;
  }
  return '';
}

export function normalizeCapacity(raw: string): string {
  const m = raw.trim().match(/^(\d+)\s*(tb|gb|mb)$/i);
  if (!m) return raw.trim();
  return `${m[1]}${m[2]!.toUpperCase()}`;
}

export function capacityRank(capacity: string): number {
  const m = capacity.trim().match(/^(\d+)\s*(tb|gb|mb)$/i);
  if (!m) return 0;
  const num = Number.parseInt(m[1]!, 10) || 0;
  const unit = m[2]!.toLowerCase();
  if (unit === 'tb') return num * 1024 * 1024;
  if (unit === 'gb') return num * 1024;
  return num;
}

function titleCaseWord(word: string): string {
  if (!word) return '';
  return word[0]!.toUpperCase() + word.slice(1);
}

/**
 * Formats Apple's compact `familyType` strings (such as `iphone18promax` or `ipadpro11_m5_2025`)
 * into display names (`iPhone 18 Pro Max`, `iPad Pro 11`).
 */
export function familyDisplayName(familyType: string): string | null {
  const base = familyType.trim().toLowerCase().split('_')[0] ?? '';
  const prefixMatch = base.match(/^(iphone|ipad)(.*)$/);
  if (!prefixMatch) return null;

  const brand = prefixMatch[1] === 'iphone' ? 'iPhone' : 'iPad';
  let remainder = prefixMatch[2] ?? '';
  const parts: string[] = [brand];

  const tokenRegex = /\d+e(?=$|pro|max|plus|mini|air|duo|se)|(\d+)|(pro|max|plus|mini|air|duo|se)|([a-z]+)/g;
  for (const match of remainder.matchAll(tokenRegex)) {
    const token = match[0];
    if (!token) continue;
    if (/^\d+e$/.test(token)) {
      parts.push(token);
    } else if (/^\d+$/.test(token)) {
      parts.push(token);
    } else if (MODEL_TOKENS[token]) {
      parts.push(MODEL_TOKENS[token]!);
    } else {
      parts.push(titleCaseWord(token));
    }
  }

  return parts.join(' ');
}

export function slugDisplayName(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((part) => SLUG_LABELS[part.toLowerCase()] ?? titleCaseWord(part.toLowerCase()))
    .join(' ');
}

/**
 * Scans forward from an opening `{` at `openBraceIndex` and returns the slice ending at
 * its matching `}` (properly ignoring braces inside JSON string literals).
 */
export function sliceBalancedJsonObject(source: string, openBraceIndex: number): string | null {
  if (source[openBraceIndex] !== '{') return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = openBraceIndex; i < source.length; i++) {
    const ch = source[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return source.slice(openBraceIndex, i + 1);
      }
    }
  }
  return null;
}

/**
 * Extracts `productSelectionData` JSON from an Apple `/shop/buy-*` HTML document while
 * ignoring analytics/telemetry strings that happen to contain the substring.
 */
export function extractProductSelectionJson(html: string): Record<string, unknown> | null {
  const bootstrapIdx = html.indexOf('PRODUCT_SELECTION_BOOTSTRAP');
  const searchRegions =
    bootstrapIdx >= 0 ? [html.slice(bootstrapIdx), html] : [html];

  const keyPattern = /(?:^|[{\s,;])["']?productSelectionData["']?\s*:\s*\{/g;

  for (const region of searchRegions) {
    keyPattern.lastIndex = 0;
    for (const match of region.matchAll(keyPattern)) {
      const openIdx = match.index! + match[0].lastIndexOf('{');
      const jsonText = sliceBalancedJsonObject(region, openIdx);
      if (!jsonText) continue;
      try {
        const parsed = JSON.parse(jsonText) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // Continue searching if a non-JSON JS block matched
      }
    }
  }

  return null;
}

/**
 * Extracts a companion Apple Watch band SKU from `bandSelectionBootstrap` so Watch
 * case pickup queries return accurate availability from `/shop/retail/pickup-message`.
 */
export function extractWatchCompanionPart(html: string): string | undefined {
  const markerIdx = html.indexOf('bandSelectionBootstrap');
  if (markerIdx < 0) return undefined;

  const afterMarker = html.slice(markerIdx);
  const assignMatch = afterMarker.match(/bandSelectionBootstrap["']?\s*[:=]\s*\{/);
  if (!assignMatch || assignMatch.index === undefined) return undefined;

  const openBrace = markerIdx + assignMatch.index + assignMatch[0].lastIndexOf('{');
  const block = sliceBalancedJsonObject(html, openBrace) ?? afterMarker.slice(0, 120_000);

  // Prefer Sport Band SKUs if listed, otherwise pick the first valid band SKU in the bootstrap object
  const matches = Array.from(
    block.matchAll(/"([A-Z0-9]{4,12}\/[A-Z0-9]{1,4})"/g),
    (m) => m[1]!
  );
  return matches.find((p) => looksLikeApplePartNumber(p));
}

export function extractMacConfigLinks(html: string, slug: string): string[] {
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`/shop/buy-mac/${escaped}/([a-zA-Z0-9%-]+)`, 'g');
  const links = new Set<string>();

  for (const match of html.matchAll(pattern)) {
    const step = match[1]?.trim();
    if (step && step.includes('-')) {
      links.add(step);
    }
  }
  return Array.from(links);
}

/**
 * Parses a Mac configuration URL tail such as
 * `13-inch-silver-apple-m4-chip-with-10-core-cpu-and-10-core-gpu-24gb-memory-1tb-storage`
 * into its base chassis/chip group plus normalized memory and storage labels.
 */
export function parseMacConfigSlug(
  rawSlug: string
): { group: string; memory?: string; storage: string } | null {
  let decoded = rawSlug;
  try {
    decoded = decodeURIComponent(rawSlug);
  } catch {
    // Keep original if percent-decoding fails
  }

  const parts = decoded.split('-').filter(Boolean);
  let storageIndex = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (/^\d+(?:gb|tb)$/i.test(parts[i]!)) {
      storageIndex = i;
      break;
    }
  }
  if (storageIndex < 0) return null;

  const omitted = new Set<number>([storageIndex]);
  if (storageIndex + 1 < parts.length) {
    omitted.add(storageIndex + 1);
  }

  let memory: string | undefined;
  if (
    storageIndex >= 2 &&
    /^\d+gb$/i.test(parts[storageIndex - 2]!) &&
    !/^\d+(?:gb|tb)$/i.test(parts[storageIndex - 1]!)
  ) {
    memory = normalizeCapacity(parts[storageIndex - 2]!);
    omitted.add(storageIndex - 2);
    omitted.add(storageIndex - 1);
  }

  const group = parts.filter((_, idx) => !omitted.has(idx)).join('-');
  if (!group) return null;

  return {
    group,
    ...(memory ? { memory } : {}),
    storage: normalizeCapacity(parts[storageIndex]!),
  };
}

export function extractConfigPagePart(html: string): string | null {
  const metaMatch = html.match(
    /<script[^>]*id=["']metrics["'][^>]*>([\s\S]*?)<\/script>/i
  );
  if (metaMatch?.[1]) {
    const skuMatch = metaMatch[1].match(/"(?:sku|partNumber)"\s*:\s*"([A-Z0-9]{4,12}\/[A-Z0-9]{1,4})"/);
    if (skuMatch?.[1]) return skuMatch[1];
  }

  const genericMatch = html.match(
    /"(?:partNumber|sku|part)"\s*:\s*"([A-Z0-9]{4,12}\/[A-Z0-9]{1,4})"/
  );
  return genericMatch?.[1] ?? null;
}

interface DimensionAttribute {
  rawKey: string;
  shortName: string;
  value: string;
}

function readDimensions(entry: Record<string, unknown>): DimensionAttribute[] {
  const results: DimensionAttribute[] = [];
  const nested = entry.dimensions;

  const sourceObj =
    nested && typeof nested === 'object' && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : entry;
  const requirePrefix = sourceObj === entry;

  for (const [rawKey, rawVal] of Object.entries(sourceObj)) {
    if (typeof rawVal !== 'string' || !rawVal.trim()) continue;
    if (requirePrefix && (!rawKey.startsWith('dimension') || rawKey === 'dimensionSteporder')) {
      continue;
    }
    const dashDim = rawKey.indexOf('-dimension');
    const shortName = dashDim >= 0 ? rawKey.slice(dashDim + 1) : rawKey;
    results.push({
      rawKey,
      shortName,
      value: rawVal.trim(),
    });
  }

  results.sort(
    (a, b) =>
      (DIMENSION_ORDER[a.shortName] ?? 50) - (DIMENSION_ORDER[b.shortName] ?? 50) ||
      a.rawKey.localeCompare(b.rawKey)
  );
  return results;
}

function resolvePartSku(entry: Record<string, unknown>): string | null {
  for (const key of ['partNumber', 'btrOrFdPartNumber']) {
    const val = entry[key];
    if (typeof val === 'string' && looksLikeApplePartNumber(val)) {
      return val.trim();
    }
  }
  if (typeof entry.part === 'string' && looksLikeApplePartNumber(entry.part)) {
    const nested = entry.dimensions;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const hasAnyDim = Object.values(nested).some(
        (v) => typeof v === 'string' && v.trim().length > 0
      );
      if (hasAnyDim) return entry.part.trim();
    }
  }
  return null;
}

function resolveDimensionLabel(
  selectionRoot: Record<string, unknown>,
  dimKey: string,
  dimValue: string
): string | null {
  for (const tableKey of ['displayValues', 'mainDisplayValues']) {
    const table = selectionRoot[tableKey];
    if (!table || typeof table !== 'object') continue;
    const dimBucket = (table as Record<string, unknown>)[dimKey];
    if (!dimBucket || typeof dimBucket !== 'object') continue;
    const valRecord = (dimBucket as Record<string, unknown>)[dimValue];
    if (!valRecord || typeof valRecord !== 'object') continue;

    for (const labelField of ['value', 'header', 'text']) {
      const candidate = (valRecord as Record<string, unknown>)[labelField];
      if (typeof candidate === 'string') {
        const cleaned = plainTextFromAppleHtml(candidate);
        if (cleaned) return cleaned;
      }
    }
  }
  return null;
}

export function disambiguateProductTitles(products: CatalogProduct[]): void {
  const titleFrequency = new Map<string, number>();
  for (const prod of products) {
    titleFrequency.set(prod.title, (titleFrequency.get(prod.title) ?? 0) + 1);
  }
  for (const prod of products) {
    if ((titleFrequency.get(prod.title) ?? 0) > 1) {
      prod.title = `${prod.title} (${prod.partNumber})`;
    }
  }
}

export function applyMacConfigVariants(
  baseProducts: CatalogProduct[],
  variants?: ConfigVariant[]
): CatalogProduct[] {
  if (!variants || variants.length === 0) return baseProducts;

  const byGroup = new Map<string, ConfigVariant[]>();
  for (const v of variants) {
    if (!v.group || !v.part) continue;
    const list = byGroup.get(v.group) ?? [];
    list.push(v);
    byGroup.set(v.group, list);
  }

  const partToIndex = new Map(baseProducts.map((p, idx) => [p.partNumber, idx]));
  const knownParts = new Set(partToIndex.keys());
  const baseLabelOverride = new Map<number, ConfigVariant>();
  const appendedByAnchor = new Map<number, CatalogProduct[]>();

  const describeSpec = (cfg: ConfigVariant): string =>
    [cfg.memory ? `${cfg.memory} Unified Memory` : '', cfg.storage ? `${cfg.storage} SSD` : '']
      .filter(Boolean)
      .join(' ');

  for (const groupMembers of byGroup.values()) {
    const anchor = groupMembers
      .map((m) => partToIndex.get(m.part))
      .find((idx): idx is number => idx !== undefined);
    if (anchor === undefined) continue;

    const anchorProduct = baseProducts[anchor]!;
    for (const cfg of groupMembers) {
      const existingIdx = partToIndex.get(cfg.part);
      if (existingIdx !== undefined) {
        baseLabelOverride.set(existingIdx, cfg);
      } else if (!knownParts.has(cfg.part)) {
        knownParts.add(cfg.part);
        const extraList = appendedByAnchor.get(anchor) ?? [];
        extraList.push({
          ...anchorProduct,
          partNumber: cfg.part,
          title: [anchorProduct.title, describeSpec(cfg)].filter(Boolean).join(' '),
          capacity: cfg.storage || anchorProduct.capacity,
        });
        appendedByAnchor.set(anchor, extraList);
      }
    }
  }

  const combined: CatalogProduct[] = [];
  baseProducts.forEach((item, idx) => {
    const override = baseLabelOverride.get(idx);
    if (override) {
      combined.push({
        ...item,
        title: [item.title, describeSpec(override)].filter(Boolean).join(' '),
        capacity: item.capacity || override.storage || '',
      });
    } else {
      combined.push({ ...item });
    }

    const children = appendedByAnchor.get(idx);
    if (children) {
      children.sort(
        (a, b) =>
          capacityRank(a.capacity) - capacityRank(b.capacity) || a.title.localeCompare(b.title)
      );
      combined.push(...children);
    }
  });

  disambiguateProductTitles(combined);
  return combined;
}

export function parseProductSelectionObject(
  selectionData: Record<string, unknown>,
  options: {
    category: Category;
    slug: string;
    baseUrl: string;
    companionPart?: string;
    configs?: ConfigVariant[];
  }
): CatalogProduct[] {
  const entries = Array.isArray(selectionData.products) ? selectionData.products : [];
  const distinctByDim = new Map<string, Set<string>>();

  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') continue;
    for (const dim of readDimensions(raw as Record<string, unknown>)) {
      const set = distinctByDim.get(dim.rawKey) ?? new Set<string>();
      set.add(dim.value);
      distinctByDim.set(dim.rawKey, set);
    }
  }

  const seenParts = new Set<string>();
  const buyUrl = `${options.baseUrl}/shop/${buyPathForCategory(options.category)}/${options.slug}`;
  let parsed: CatalogProduct[] = [];

  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const partNumber = resolvePartSku(item);
    if (!partNumber || seenParts.has(partNumber)) continue;
    seenParts.add(partNumber);

    const rawFamily = typeof item.familyType === 'string' ? item.familyType.trim() : '';
    const prettyModel = familyDisplayName(rawFamily);
    const familyLabel = prettyModel ?? slugDisplayName(options.slug);

    const descriptors: string[] = [];
    let capacity = '';
    let color = '';

    for (const dim of readDimensions(item)) {
      if (dim.shortName === 'dimensionScreensize' && prettyModel) continue;

      if (dim.shortName === 'dimensionCapacity') {
        capacity = normalizeCapacity(dim.value);
        if (capacity) descriptors.push(capacity);
        continue;
      }

      let label = resolveDimensionLabel(selectionData, dim.rawKey, dim.value);
      if (!label && (distinctByDim.get(dim.rawKey)?.size ?? 0) > 1 && !/\d/.test(dim.value)) {
        label = titleCaseWord(dim.value.replace(/_/g, ' '));
      }
      if (!label) continue;

      if (dim.shortName === 'dimensionColor' || dim.shortName === 'dimensionFinish') {
        color = color || label;
      }
      descriptors.push(label);
    }

    parsed.push({
      partNumber,
      title: [familyLabel, ...descriptors].filter(Boolean).join(' '),
      category: options.category,
      family: rawFamily || options.slug,
      familyLabel,
      pageSlug: options.slug,
      capacity,
      color,
      ...(options.companionPart ? { companionPart: options.companionPart } : {}),
      buyUrl,
    });
  }

  disambiguateProductTitles(parsed);
  if (options.category === 'mac' && options.configs?.length) {
    parsed = applyMacConfigVariants(parsed, options.configs);
  }
  return parsed;
}

/**
 * Extracts single-SKU or non-bootstrap product entries (common on AirPods, HomePod,
 * and accessory buy pages) from `<script id="metrics" type="application/json">` or JSON-LD.
 */
export function extractFallbackMetricsProducts(
  html: string,
  options: {
    category: Category;
    slug: string;
    baseUrl: string;
  }
): CatalogProduct[] {
  const results: CatalogProduct[] = [];
  const seen = new Set<string>();
  const buyUrl = `${options.baseUrl}/shop/${buyPathForCategory(options.category)}/${options.slug}`;
  const defaultFamily = slugDisplayName(options.slug);

  const metricsScript = html.match(
    /<script[^>]*id=["']metrics["'][^>]*>([\s\S]*?)<\/script>/i
  );
  if (metricsScript?.[1]) {
    try {
      const json = JSON.parse(metricsScript[1]) as {
        data?: {
          products?: Array<{
            sku?: string;
            partNumber?: string;
            name?: string;
          }>;
        };
      };
      for (const p of json.data?.products ?? []) {
        const sku = (p.partNumber ?? p.sku ?? '').trim();
        if (!looksLikeApplePartNumber(sku) || seen.has(sku)) continue;
        seen.add(sku);
        const title = plainTextFromAppleHtml(p.name ?? '') || defaultFamily;
        results.push({
          partNumber: sku,
          title,
          category: options.category,
          family: options.slug,
          familyLabel: defaultFamily,
          pageSlug: options.slug,
          capacity: '',
          color: '',
          buyUrl,
        });
      }
    } catch {
      // Fall through to JSON-LD check
    }
  }

  if (results.length === 0) {
    for (const ldMatch of html.matchAll(
      /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    )) {
      try {
        const ld = JSON.parse(ldMatch[1]!) as {
          name?: string;
          sku?: string;
          offers?: Array<{ sku?: string; name?: string }> | { sku?: string };
        };
        const offers = Array.isArray(ld.offers)
          ? ld.offers
          : ld.offers
            ? [ld.offers]
            : [];
        const baseName = plainTextFromAppleHtml(ld.name ?? '') || defaultFamily;
        for (const offer of offers) {
          const sku = (offer.sku ?? ld.sku ?? '').trim();
          if (!looksLikeApplePartNumber(sku) || seen.has(sku)) continue;
          seen.add(sku);
          const offerTitle =
            'name' in offer && typeof offer.name === 'string'
              ? plainTextFromAppleHtml(offer.name)
              : '';
          results.push({
            partNumber: sku,
            title: offerTitle || baseName,
            category: options.category,
            family: options.slug,
            familyLabel: defaultFamily,
            pageSlug: options.slug,
            capacity: '',
            color: '',
            buyUrl,
          });
        }
      } catch {
        // Ignore malformed JSON-LD blocks
      }
    }
  }

  disambiguateProductTitles(results);
  return results;
}

export function parseBuyPageHtml(
  html: string,
  options: {
    category: Category;
    slug: string;
    baseUrl: string;
    configs?: ConfigVariant[];
  }
): CatalogProduct[] {
  const companionPart =
    options.category === 'watch' ? extractWatchCompanionPart(html) : undefined;

  const selectionJson = extractProductSelectionJson(html);
  if (selectionJson) {
    const products = parseProductSelectionObject(selectionJson, {
      ...options,
      companionPart,
    });
    if (products.length > 0) return products;
  }

  return extractFallbackMetricsProducts(html, options);
}
