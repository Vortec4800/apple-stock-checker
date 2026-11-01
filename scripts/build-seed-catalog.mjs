#!/usr/bin/env node
/**
 * Builds `src/data/regions.json`, `src/data/stores-seed.json`, and `src/data/products-seed.json`
 * directly from Apple's public web endpoints (`/retail/storelist/` and `/shop/buy-*`).
 *
 * Usage:
 *   npm run build:server
 *   node scripts/build-seed-catalog.mjs                # Fetches global stores + en_US products
 *   node scripts/build-seed-catalog.mjs --stores-only  # Refreshes global stores only
 *   node scripts/build-seed-catalog.mjs --locales=en_US,en_CA,en_GB
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buyPathForCategory,
  disambiguateProductTitles,
  extractConfigPagePart,
  extractMacConfigLinks,
  looksLikeApplePartNumber,
  parseBuyPageHtml,
  parseMacConfigSlug,
  plainTextFromAppleHtml,
  slugDisplayName,
} from '../dist/server/server/catalog-parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'src', 'data');

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

const CANDIDATE_FAMILIES = [
  // iPhone
  { category: 'iphone', slug: 'iphone-18-pro' },
  { category: 'iphone', slug: 'iphone-duo' },
  { category: 'iphone', slug: 'iphone-17-pro' },
  { category: 'iphone', slug: 'iphone-17' },
  { category: 'iphone', slug: 'iphone-air' },
  { category: 'iphone', slug: 'iphone-17e' },
  { category: 'iphone', slug: 'iphone-16' },
  { category: 'iphone', slug: 'iphone-16e' },
  // iPad
  { category: 'ipad', slug: 'ipad-pro' },
  { category: 'ipad', slug: 'ipad-air' },
  { category: 'ipad', slug: 'ipad' },
  { category: 'ipad', slug: 'ipad-mini' },
  // Mac
  { category: 'mac', slug: 'macbook-air' },
  { category: 'mac', slug: 'macbook-pro' },
  { category: 'mac', slug: 'macbook-neo' },
  { category: 'mac', slug: 'imac' },
  { category: 'mac', slug: 'mac-mini' },
  { category: 'mac', slug: 'mac-studio' },
  { category: 'mac', slug: 'mac-pro' },
  { category: 'mac', slug: 'studio-display' },
  { category: 'mac', slug: 'studio-display-xdr' },
  // Apple Watch
  { category: 'watch', slug: 'apple-watch' },
  { category: 'watch', slug: 'apple-watch-se' },
  { category: 'watch', slug: 'apple-watch-ultra' },
  { category: 'watch', slug: 'apple-watch-hermes' },
  { category: 'watch', slug: 'apple-watch-hermes-ultra' },
  // AirPods
  { category: 'airpods', slug: 'airpods-pro-3' },
  { category: 'airpods', slug: 'airpods-pro-2' },
  { category: 'airpods', slug: 'airpods-5' },
  { category: 'airpods', slug: 'airpods-4' },
  { category: 'airpods', slug: 'airpods-max-2' },
  { category: 'airpods', slug: 'airpods-max' },
  // HomePod
  { category: 'homepod', slug: 'homepod' },
  { category: 'homepod', slug: 'homepod-mini' },
  // Apple Vision Pro
  { category: 'vision', slug: 'apple-vision-pro' },
];

const NO_HERMES_LOCALES = new Set(['en_IN', 'nl_NL', 'fr_BE', 'de_AT', 'tr_TR']);

const REGIONS = [
  { locale: 'en_US', shortcode: 'us', name: 'United States', baseUrl: 'https://www.apple.com', postalPlaceholder: '90210 or Austin, TX' },
  { locale: 'en_CA', shortcode: 'ca', name: 'Canada', baseUrl: 'https://www.apple.com/ca', postalPlaceholder: 'M5G 2C3 or Toronto' },
  { locale: 'en_GB', shortcode: 'uk', name: 'United Kingdom', baseUrl: 'https://www.apple.com/uk', postalPlaceholder: 'W1B 2EL or London' },
  { locale: 'en_AU', shortcode: 'au', name: 'Australia', baseUrl: 'https://www.apple.com/au', postalPlaceholder: '2000 or Sydney' },
  { locale: 'de_DE', shortcode: 'de', name: 'Germany', baseUrl: 'https://www.apple.com/de', postalPlaceholder: '10119 or Berlin' },
  { locale: 'fr_FR', shortcode: 'fr', name: 'France', baseUrl: 'https://www.apple.com/fr', postalPlaceholder: '75009 or Paris' },
  { locale: 'ja_JP', shortcode: 'jp', name: 'Japan', baseUrl: 'https://www.apple.com/jp', postalPlaceholder: '104-0061 or Tokyo' },
  { locale: 'en_SG', shortcode: 'sg', name: 'Singapore', baseUrl: 'https://www.apple.com/sg', postalPlaceholder: '238857' },
  { locale: 'zh_HK', shortcode: 'hk', name: 'Hong Kong', baseUrl: 'https://www.apple.com/hk-zh', postalPlaceholder: 'Central or Causeway Bay' },
  { locale: 'zh_TW', shortcode: 'tw', name: 'Taiwan', baseUrl: 'https://www.apple.com/tw', postalPlaceholder: '110 or Taipei' },
  { locale: 'zh_CN', shortcode: 'cn', name: 'China Mainland', baseUrl: 'https://www.apple.com.cn', postalPlaceholder: '200001 or Shanghai' },
  { locale: 'ko_KR', shortcode: 'kr', name: 'South Korea', baseUrl: 'https://www.apple.com/kr', postalPlaceholder: '06028 or Seoul' },
  { locale: 'es_MX', shortcode: 'mx', name: 'Mexico', baseUrl: 'https://www.apple.com/mx', postalPlaceholder: '01219 or CDMX' },
  { locale: 'pt_BR', shortcode: 'br', name: 'Brazil', baseUrl: 'https://www.apple.com/br', postalPlaceholder: '04542-000 or São Paulo' },
  { locale: 'it_IT', shortcode: 'it', name: 'Italy', baseUrl: 'https://www.apple.com/it', postalPlaceholder: '20121 or Milan' },
  { locale: 'es_ES', shortcode: 'es', name: 'Spain', baseUrl: 'https://www.apple.com/es', postalPlaceholder: '28013 or Madrid' },
  { locale: 'nl_NL', shortcode: 'nl', name: 'Netherlands', baseUrl: 'https://www.apple.com/nl', postalPlaceholder: '1017 PS or Amsterdam' },
  { locale: 'fr_BE', shortcode: 'be-fr', name: 'Belgium', baseUrl: 'https://www.apple.com/be-fr', postalPlaceholder: '1050 or Brussels' },
  { locale: 'de_AT', shortcode: 'at', name: 'Austria', baseUrl: 'https://www.apple.com/at', postalPlaceholder: '1010 or Vienna' },
  { locale: 'fr_CH', shortcode: 'ch-fr', name: 'Switzerland', baseUrl: 'https://www.apple.com/ch-fr', postalPlaceholder: '8001 or Zurich' },
  { locale: 'sv_SE', shortcode: 'se', name: 'Sweden', baseUrl: 'https://www.apple.com/se', postalPlaceholder: '111 47 or Stockholm' },
  { locale: 'en_AE', shortcode: 'ae', name: 'United Arab Emirates', baseUrl: 'https://www.apple.com/ae', postalPlaceholder: 'Dubai' },
  { locale: 'en_IN', shortcode: 'in', name: 'India', baseUrl: 'https://www.apple.com/in', postalPlaceholder: '400051 or Mumbai' },
  { locale: 'en_MY', shortcode: 'my', name: 'Malaysia', baseUrl: 'https://www.apple.com/my', postalPlaceholder: '55188 or Kuala Lumpur' },
  { locale: 'th_TH', shortcode: 'th', name: 'Thailand', baseUrl: 'https://www.apple.com/th', postalPlaceholder: '10330 or Bangkok' },
  { locale: 'tr_TR', shortcode: 'tr', name: 'Turkey', baseUrl: 'https://www.apple.com/tr', postalPlaceholder: '34340 or Istanbul' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchApplePage(url, accept = 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8') {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': USER_AGENT,
      Accept: accept,
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    return { ok: false, status: res.status, text: '' };
  }
  return { ok: true, status: res.status, text: await res.text() };
}

/**
 * Fallback extractor for accessory/audio pages that embed color/option SKUs in
 * inline JSON blobs (`partNumber` + `color`/`dimensionColor`/`title`) rather than
 * `PRODUCT_SELECTION_BOOTSTRAP`.
 */
function extractAdditionalBuyPageSkus(html, { category, slug, baseUrl }) {
  const buyUrl = `${baseUrl}/shop/${buyPathForCategory(category)}/${slug}`;
  const familyLabel = slugDisplayName(slug);
  const found = [];
  const seen = new Set();

  // Check `product-locator-meta` or inline radio/color selection JSON objects
  const objRegex = /\{[^{}]{10,900}"(?:partNumber|part|sku)"\s*:\s*"([A-Z0-9]{4,12}\/[A-Z0-9]{1,4})"[^{}]{0,900}\}/g;
  for (const m of html.matchAll(objRegex)) {
    const snippet = m[0];
    const partNumber = m[1];
    if (!partNumber || !looksLikeApplePartNumber(partNumber) || seen.has(partNumber)) continue;

    try {
      const obj = JSON.parse(snippet);
      const rawName = plainTextFromAppleHtml(
        String(obj.productTitle || obj.name || obj.title || obj.label || '')
      );
      const rawColor = plainTextFromAppleHtml(
        String(obj.dimensionColor || obj.color || '')
      );
      const color = rawColor
        ? rawColor[0].toUpperCase() + rawColor.slice(1).replace(/_/g, ' ')
        : '';
      const rawCap = String(obj.dimensionCapacity || obj.capacity || '').trim().toUpperCase();

      let title = rawName || [familyLabel, rawCap, color].filter(Boolean).join(' ');
      if (!title.toLowerCase().includes(familyLabel.toLowerCase())) {
        title = [familyLabel, title].filter(Boolean).join(' ');
      }

      seen.add(partNumber);
      found.push({
        partNumber,
        title,
        category,
        family: slug,
        familyLabel,
        pageSlug: slug,
        capacity: rawCap,
        color,
        buyUrl,
      });
    } catch {
      // Ignore partial non-JSON snippets
    }
  }

  disambiguateProductTitles(found);
  return found;
}

async function fetchGlobalStores() {
  console.log('Fetching global store directory from apple.com/retail/storelist/...');
  const res = await fetchApplePage('https://www.apple.com/retail/storelist/');
  if (!res.ok) {
    throw new Error(`Failed to fetch Apple store list: HTTP ${res.status}`);
  }

  const nextDataMatch = res.text.match(
    /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i
  );
  if (!nextDataMatch?.[1]) {
    throw new Error('Could not locate __NEXT_DATA__ on apple.com/retail/storelist/');
  }

  const parsed = JSON.parse(nextDataMatch[1]);
  const storeList = parsed?.props?.pageProps?.storeList ?? [];
  const byLocale = {};

  for (const block of storeList) {
    const rawLocale = block.locale === 'en_HK' ? 'zh_HK' : block.locale;
    if (!rawLocale) continue;
    const map = byLocale[rawLocale] ?? new Map();
    for (const stateGroup of block.state ?? []) {
      for (const s of stateGroup.store ?? []) {
        const id = String(s.id ?? '').trim();
        if (!id) continue;
        map.set(id, {
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
    byLocale[rawLocale] = map;
  }

  const out = {};
  for (const [locale, map] of Object.entries(byLocale)) {
    const list = Array.from(map.values());
    list.sort(
      (a, b) =>
        a.state.localeCompare(b.state) ||
        a.city.localeCompare(b.city) ||
        a.name.localeCompare(b.name)
    );
    out[locale] = list;
  }
  return out;
}

async function fetchRegionProducts(region) {
  const products = [];
  const seenParts = new Set();
  const activeFamilies = [];

  for (const fam of CANDIDATE_FAMILIES) {
    if (NO_HERMES_LOCALES.has(region.locale) && fam.slug.includes('hermes')) {
      continue;
    }

    const pageUrl = `${region.baseUrl}/shop/${buyPathForCategory(fam.category)}/${fam.slug}`;
    const res = await fetchApplePage(pageUrl);
    await sleep(220);

    if (!res.ok) {
      continue;
    }

    let macConfigs = undefined;
    if (fam.category === 'mac') {
      const links = extractMacConfigLinks(res.text, fam.slug).slice(0, 14);
      const variants = [];
      for (const link of links) {
        const parsedSlug = parseMacConfigSlug(link);
        if (!parsedSlug) continue;
        const subRes = await fetchApplePage(`${pageUrl}/${link}`);
        await sleep(160);
        if (!subRes.ok) continue;
        const part = extractConfigPagePart(subRes.text);
        if (part) {
          variants.push({
            part,
            group: parsedSlug.group,
            memory: parsedSlug.memory,
            storage: parsedSlug.storage,
          });
        }
      }
      macConfigs = variants;
    }

    let pageProducts = parseBuyPageHtml(res.text, {
      category: fam.category,
      slug: fam.slug,
      baseUrl: region.baseUrl,
      configs: macConfigs,
    });

    if (pageProducts.length === 0) {
      pageProducts = extractAdditionalBuyPageSkus(res.text, {
        category: fam.category,
        slug: fam.slug,
        baseUrl: region.baseUrl,
      });
    }

    if (pageProducts.length > 0) {
      activeFamilies.push(fam);
      for (const p of pageProducts) {
        if (!seenParts.has(p.partNumber)) {
          seenParts.add(p.partNumber);
          products.push(p);
        }
      }
      console.log(`  [${region.locale}] ${fam.category}/${fam.slug}: ${pageProducts.length} SKUs`);
    }
  }

  disambiguateProductTitles(products);
  return { products, activeFamilies };
}

async function main() {
  const storesOnly = process.argv.includes('--stores-only');
  const localesArg = process.argv.find((a) => a.startsWith('--locales='));
  const targetLocales = localesArg
    ? localesArg.slice('--locales='.length).split(',').map((s) => s.trim()).filter(Boolean)
    : ['en_US'];

  fs.mkdirSync(DATA_DIR, { recursive: true });

  const storesByLocale = await fetchGlobalStores();
  fs.writeFileSync(path.join(DATA_DIR, 'stores-seed.json'), JSON.stringify(storesByLocale));

  if (storesOnly) {
    console.log('\nStore directory generation complete:');
    console.log(
      `  Store locales: ${Object.keys(storesByLocale).length} (US stores: ${(storesByLocale.en_US ?? []).length})`
    );
    return;
  }

  const productsByLocale = {};
  let discoveredFamilies = null;

  for (const locale of targetLocales) {
    const region = REGIONS.find((r) => r.locale === locale);
    if (!region) {
      console.warn(`Unknown locale: ${locale}`);
      continue;
    }
    console.log(`Scraping live Apple catalog for ${region.name} (${region.locale})...`);
    const { products, activeFamilies } = await fetchRegionProducts(region);
    productsByLocale[locale] = products;
    if (locale === 'en_US' && activeFamilies.length > 0) {
      discoveredFamilies = activeFamilies;
    }
  }

  const familyList = discoveredFamilies ?? CANDIDATE_FAMILIES;
  const regionsOut = REGIONS.map((r) => ({
    ...r,
    families: NO_HERMES_LOCALES.has(r.locale)
      ? familyList.filter((f) => !f.slug.includes('hermes'))
      : familyList,
  }));

  fs.writeFileSync(path.join(DATA_DIR, 'regions.json'), JSON.stringify(regionsOut, null, 2));
  fs.writeFileSync(path.join(DATA_DIR, 'stores-seed.json'), JSON.stringify(storesByLocale));
  fs.writeFileSync(path.join(DATA_DIR, 'products-seed.json'), JSON.stringify(productsByLocale));

  const usProducts = productsByLocale.en_US ?? [];
  const byCat = {};
  for (const p of usProducts) {
    byCat[p.category] = (byCat[p.category] ?? 0) + 1;
  }

  console.log('\nSeed generation complete:');
  console.log(`  Store locales: ${Object.keys(storesByLocale).length} (US stores: ${(storesByLocale.en_US ?? []).length})`);
  console.log(`  US products:   ${usProducts.length}`, byCat);
}

main().catch((err) => {
  console.error('Seed generation failed:', err);
  process.exit(1);
});
