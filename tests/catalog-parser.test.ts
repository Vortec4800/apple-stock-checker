import { describe, expect, it } from 'vitest';
import {
  extractWatchCompanionPart,
  familyDisplayName,
  parseBuyPageHtml,
  parseMacConfigSlug,
  plainTextFromAppleHtml,
} from '../src/server/catalog-parser.js';

describe('Apple Buy Page & Catalog Parser', () => {
  it('strips promotional badges and explainer subheadings cleanly from HTML labels', () => {
    expect(
      plainTextFromAppleHtml(
        '<span class="badge badge-no-scrim">New</span>\n<div>Aluminum</div>\n<span class="form-label-small">Available with GPS</span>'
      )
    ).toBe('Aluminum');

    expect(
      plainTextFromAppleHtml(
        '10&nbsp;core CPU, 8&nbsp;core GPU <div class="as-subheading">Fast chip</div>'
      )
    ).toBe('10 core CPU, 8 core GPU');
  });

  it('formats Apple familyType identifiers into human-readable model names', () => {
    expect(familyDisplayName('iphone18promax')).toBe('iPhone 18 Pro Max');
    expect(familyDisplayName('iphoneduo')).toBe('iPhone Duo');
    expect(familyDisplayName('iphone17e')).toBe('iPhone 17e');
    expect(familyDisplayName('ipadpro11_m5_2025')).toBe('iPad Pro 11');
    expect(familyDisplayName('macbookair')).toBeNull();
  });

  it('ignores analytics string false-positives and extracts real productSelectionData + Watch companion band', () => {
    const html = `
      <script>
        var analytics = "metric_productSelectionData_loaded";
        var legacy_productSelectionData = {"products": []};
        window.PRODUCT_SELECTION_BOOTSTRAP = {
          productSelectionData: {
            "products": [
              {
                "part": "MJFN4LS/A",
                "dimensions": {
                  "watch_cases-dimensionCaseSize": "42mm",
                  "watch_cases-dimensionCaseMaterial": "aluminum",
                  "watch_cases-dimensionConnection": "gps",
                  "watch_cases-dimensionColor": "space_gray"
                }
              }
            ],
            "displayValues": {
              "watch_cases-dimensionCaseSize": { "42mm": { "header": "42mm" } },
              "watch_cases-dimensionCaseMaterial": { "aluminum": { "header": "Aluminum" } },
              "watch_cases-dimensionConnection": { "gps": { "header": "GPS" } },
              "watch_cases-dimensionColor": { "space_gray": { "text": "Space Gray" } }
            }
          }
        };
        window.bandSelectionBootstrap = {"bands": [{"part": "MJVK4AM/A"}]};
      </script>
    `;

    expect(extractWatchCompanionPart(html)).toBe('MJVK4AM/A');
    const products = parseBuyPageHtml(html, {
      category: 'watch',
      slug: 'apple-watch',
      baseUrl: 'https://www.apple.com',
    });

    expect(products).toHaveLength(1);
    expect(products[0]?.partNumber).toBe('MJFN4LS/A');
    expect(products[0]?.companionPart).toBe('MJVK4AM/A');
    expect(products[0]?.title).toBe('Apple Watch 42mm Aluminum GPS Space Gray');
  });

  it('rejects non-SKU iPad product line codes on `part` while keeping valid `partNumber`', () => {
    const html = `
      <script>
        window.PRODUCT_SELECTION_BOOTSTRAP = {
          "productSelectionData": {
            "products": [
              { "part": "IPADPRO11_WI_2025", "familyType": "ipadpro11_m5_2025" },
              { "partNumber": "MDWK4LL/A", "part": "IPADPRO11_WI_2025", "familyType": "ipadpro11_m5_2025", "dimensionCapacity": "256gb" }
            ]
          }
        };
      </script>
    `;
    const products = parseBuyPageHtml(html, {
      category: 'ipad',
      slug: 'ipad-pro',
      baseUrl: 'https://www.apple.com',
    });
    expect(products).toHaveLength(1);
    expect(products[0]?.partNumber).toBe('MDWK4LL/A');
    expect(products[0]?.title).toBe('iPad Pro 11 256GB');
  });

  it('parses Mac upgraded configuration URL slugs into group, memory, and storage', () => {
    const parsed = parseMacConfigSlug(
      '13-inch-silver-apple-m4-chip-with-10-core-cpu-and-10-core-gpu-24gb-memory-1tb-storage'
    );
    expect(parsed).toEqual({
      group: '13-inch-silver-apple-m4-chip-with-10-core-cpu-and-10-core-gpu',
      memory: '24GB',
      storage: '1TB',
    });
  });
});
