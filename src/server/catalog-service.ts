import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CatalogProduct,
  Category,
  RegionInfo,
  StoreInfo,
} from '../shared/types.js';
import type { AppleRetailClient } from './apple-client.js';
import {
  buyPathForCategory,
  type ConfigVariant,
  disambiguateProductTitles,
  extractConfigPagePart,
  extractMacConfigLinks,
  parseBuyPageHtml,
  parseMacConfigSlug,
} from './catalog-parser.js';
import type { AppDatabase } from './db.js';

function resolveDataDir(): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), 'src', 'data'),
    path.resolve(__dirname, '..', 'data'),
    path.resolve(__dirname, '..', '..', 'src', 'data'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'regions.json'))) {
      return dir;
    }
  }
  return candidates[0]!;
}

export class CatalogService {
  private readonly regions: RegionInfo[];
  private readonly seedStoresByLocale: Record<string, StoreInfo[]>;
  private readonly seedProductsByLocale: Record<string, CatalogProduct[]>;
  private readonly db: AppDatabase;
  private readonly appleClient: AppleRetailClient;

  constructor(db: AppDatabase, appleClient: AppleRetailClient) {
    this.db = db;
    this.appleClient = appleClient;
    const dataDir = resolveDataDir();
    this.regions = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'regions.json'), 'utf8')
    ) as RegionInfo[];
    this.seedStoresByLocale = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'stores-seed.json'), 'utf8')
    ) as Record<string, StoreInfo[]>;
    this.seedProductsByLocale = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'products-seed.json'), 'utf8')
    ) as Record<string, CatalogProduct[]>;
  }

  public getRegions(): RegionInfo[] {
    return this.regions;
  }

  public getRegion(locale: string): RegionInfo {
    return (
      this.regions.find((r) => r.locale === locale) ??
      this.regions.find((r) => r.locale === 'en_US') ??
      this.regions[0]!
    );
  }

  public getStores(locale: string): StoreInfo[] {
    const online = this.db.getOnlineStoresCache(locale);
    if (online && online.length > 0) return online;
    return this.seedStoresByLocale[locale] ?? [];
  }

  public getStoreById(locale: string, storeId: string): StoreInfo | undefined {
    return this.getStores(locale).find((s) => s.id === storeId);
  }

  /**
   * Merges online-refreshed buy pages over seed buy pages at page granularity
   * (`category::pageSlug`), ensuring a failed page refresh never wipes out existing models.
   */
  public getProducts(locale: string, category?: Category): CatalogProduct[] {
    const seedList = this.seedProductsByLocale[locale] ?? [];
    const onlinePages = this.db.getOnlineCatalogPages(locale);

    if (onlinePages.size === 0) {
      return category ? seedList.filter((p) => p.category === category) : seedList;
    }

    const merged: CatalogProduct[] = [];
    const seenParts = new Set<string>();
    const replacedPages = new Set<string>(onlinePages.keys());

    // Prefer fresh online pages first so newly refreshed metadata wins deduplication
    for (const [pageKey, entry] of onlinePages.entries()) {
      const [cat] = pageKey.split('::');
      if (category && cat !== category) continue;
      for (const prod of entry.products) {
        if (!seenParts.has(prod.partNumber)) {
          seenParts.add(prod.partNumber);
          merged.push({ ...prod });
        }
      }
    }

    for (const prod of seedList) {
      if (category && prod.category !== category) continue;
      const pageKey = `${prod.category}::${prod.pageSlug}`;
      if (replacedPages.has(pageKey)) continue;
      if (!seenParts.has(prod.partNumber)) {
        seenParts.add(prod.partNumber);
        merged.push({ ...prod });
      }
    }

    disambiguateProductTitles(merged);
    return merged;
  }

  public findProductByPart(locale: string, partNumber: string): CatalogProduct | undefined {
    const upper = partNumber.trim().toUpperCase();
    return this.getProducts(locale).find((p) => p.partNumber.toUpperCase() === upper);
  }

  /**
   * Queries Apple's live `/shop/retail/pickup-message?location=<zip>` endpoint using
   * a valid regional SKU so the user gets exact nearby Apple Stores ordered by distance.
   */
  public async lookupNearbyStores(
    locale: string,
    locationQuery: string
  ): Promise<{ stores: StoreInfo[]; warning?: string }> {
    const region = this.getRegion(locale);
    const catalog = this.getProducts(locale);
    const probeProduct =
      catalog.find((p) => p.category === 'iphone') ??
      catalog[0];

    const probePart = probeProduct?.partNumber ?? 'MFHP4LL/A';
    const refererUrl = probeProduct?.buyUrl ?? `${region.baseUrl}/shop/buy-iphone`;

    const res = await this.appleClient.fetchPickupBatch({
      region,
      queryParts: [probePart],
      location: locationQuery.trim(),
      refererUrl,
    });

    const directory = new Map(this.getStores(locale).map((s) => [s.id, s]));

    if (!res.ok) {
      // Fallback to local postal/city/state substring matching if Apple temporarily blocks or user is offline
      const q = locationQuery.trim().toLowerCase();
      const localMatches = this.getStores(locale).filter(
        (s) =>
          s.postalCode.toLowerCase().startsWith(q) ||
          s.city.toLowerCase().includes(q) ||
          s.state.toLowerCase().includes(q) ||
          s.stateCode.toLowerCase() === q ||
          s.name.toLowerCase().includes(q)
      );
      return {
        stores: localMatches,
        warning: `Live Apple nearby lookup unavailable (${res.envelopeError?.detail ?? 'error'}); showing matching stores from local directory.`,
      };
    }

    const enriched: StoreInfo[] = res.stores.map((live) => {
      const known = directory.get(live.id);
      return {
        id: live.id,
        name: live.name || known?.name || live.id,
        slug: live.slug || known?.slug || '',
        city: live.city || known?.city || '',
        state: live.state || known?.state || '',
        stateCode: live.stateCode || known?.stateCode || '',
        postalCode: live.postalCode || known?.postalCode || '',
        address1: live.address1 || known?.address1 || '',
        telephone: live.telephone || known?.telephone || '',
        ...(live.distance ? { distance: live.distance } : {}),
      };
    });

    return { stores: enriched };
  }

  /**
   * Refreshes product configurations directly from Apple's live `/shop/buy-*` pages
   * for a given region (optionally scoped to a single category to conserve requests).
   */
  public async refreshLiveCatalog(
    locale: string,
    category?: Category
  ): Promise<{
    refreshedPages: number;
    productsFound: number;
    failures: string[];
  }> {
    const region = this.getRegion(locale);
    const families = category
      ? region.families.filter((f) => f.category === category)
      : region.families;

    let refreshedPages = 0;
    let productsFound = 0;
    const failures: string[] = [];

    for (const fam of families) {
      const pageUrl = `${region.baseUrl}/shop/${buyPathForCategory(fam.category)}/${fam.slug}`;
      try {
        const html = await this.appleClient.fetchHtmlPage(region, pageUrl);
        let macConfigs: ConfigVariant[] | undefined;

        if (fam.category === 'mac') {
          const links = extractMacConfigLinks(html, fam.slug).slice(0, 12);
          const collected: ConfigVariant[] = [];
          for (const link of links) {
            const parsedSlug = parseMacConfigSlug(link);
            if (!parsedSlug) continue;
            try {
              const subHtml = await this.appleClient.fetchHtmlPage(
                region,
                `${pageUrl}/${link}`
              );
              const part = extractConfigPagePart(subHtml);
              if (part) {
                collected.push({
                  part,
                  group: parsedSlug.group,
                  memory: parsedSlug.memory,
                  storage: parsedSlug.storage,
                });
              }
            } catch {
              // Individual Mac sub-config failure shouldn't fail the family page
            }
          }
          macConfigs = collected;
        }

        const parsedProducts = parseBuyPageHtml(html, {
          category: fam.category,
          slug: fam.slug,
          baseUrl: region.baseUrl,
          configs: macConfigs,
        });

        if (parsedProducts.length === 0) {
          failures.push(`${fam.slug}: no purchasable SKUs found on page`);
          continue;
        }

        this.db.saveOnlineCatalogPage(locale, fam.category, fam.slug, parsedProducts);
        refreshedPages++;
        productsFound += parsedProducts.length;
      } catch (err) {
        failures.push(`${fam.slug}: ${(err as Error).message}`);
      }
    }

    return { refreshedPages, productsFound, failures };
  }

  public async refreshLiveStores(locale: string): Promise<{ count: number }> {
    const region = this.getRegion(locale);
    const url = 'https://www.apple.com/retail/storelist/';
    const html = await this.appleClient.fetchHtmlPage(region, url);
    const nextDataMatch = html.match(
      /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i
    );
    if (!nextDataMatch?.[1]) {
      throw new Error('Could not find __NEXT_DATA__ store directory on apple.com/retail/storelist');
    }

    const parsed = JSON.parse(nextDataMatch[1]) as {
      props?: {
        pageProps?: {
          storeList?: Array<{
            locale?: string;
            state?: Array<{
              name?: string;
              store?: Array<{
                id?: string;
                name?: string;
                slug?: string;
                telephone?: string;
                address?: {
                  address1?: string;
                  city?: string;
                  stateName?: string;
                  stateCode?: string;
                  postalCode?: string;
                };
              }>;
            }>;
          }>;
        };
      };
    };

    const targetLocale = locale === 'zh_HK' ? 'en_HK' : locale;
    const storeList = parsed.props?.pageProps?.storeList ?? [];
    const matchingBlocks = storeList.filter(
      (b) => b.locale === locale || b.locale === targetLocale
    );
    const blocksToScan = matchingBlocks.length > 0 ? matchingBlocks : storeList;

    const list: StoreInfo[] = [];
    const seen = new Set<string>();
    for (const localeBlock of blocksToScan) {
      for (const stateGroup of localeBlock.state ?? []) {
        for (const s of stateGroup.store ?? []) {
          const id = String(s.id ?? '').trim();
          if (!id || seen.has(id)) continue;
          seen.add(id);
          list.push({
            id,
            name: String(s.name ?? id).trim(),
            slug: String(s.slug ?? '').trim(),
            city: String(s.address?.city ?? '').trim(),
            state: String(s.address?.stateName ?? stateGroup.name ?? '').trim(),
            stateCode: String(s.address?.stateCode ?? '').trim(),
            postalCode: String(s.address?.postalCode ?? '').trim(),
            address1: String(s.address?.address1 ?? '').trim(),
            telephone: String(s.telephone ?? '').trim(),
          });
        }
      }
    }

    if (list.length > 0) {
      list.sort(
        (a, b) =>
          a.state.localeCompare(b.state) ||
          a.city.localeCompare(b.city) ||
          a.name.localeCompare(b.name)
      );
      this.db.saveOnlineStoresCache(locale, list);
    }
    return { count: list.length };
  }
}
