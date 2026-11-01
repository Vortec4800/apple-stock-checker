# Apple Stock Checker

A self-hosted, single-container web application for monitoring Apple Retail Store pickup availability and area store stock counts, built for local LAN deployment on **Unraid / Docker** with **Pushover** notifications.

## Key Capabilities

- **Checks As Often As Safely Allowed:**
  - Queries Apple's `/shop/retail/pickup-message` endpoint with session cookie warmup (`/shop/bag`).
  - **Area Location Batching:** Batches up to **8 SKUs** per request using your ZIP/postal code (`location=<zip>`), checking nearby Apple Stores in a single HTTP request (~35–45s cadence without hitting Apple's per-IP burst ceiling).
  - **Rate-Budget & Cooldown Protection:** Built-in 20-token per-IP token bucket (`TokenBucketPacer`), `Retry-After` header support, and escalating single-probe HTTP 541 edge cooldown (`5m → 10m → 20m → 30m`).
- **All 7 Apple Product Families + Live Apple.com Refresh:**
  - Pre-seeded catalog generated directly from Apple.com across **iPhone, iPad, Mac (including upgraded memory/SSD retail configs), Apple Watch (with automatic companion band SKU injection), AirPods, HomePod, and Apple Vision Pro**, plus store directories across **26 regions** (defaulting to **United States**).
  - One-click **Refresh Live from Apple** scrapes `/shop/buy-*` pages so new launch-day SKUs appear immediately without rebuilding the container.
  - Also supports arbitrary **Custom / BTO Part Numbers**.
- **Strict 3-State Inventory & Restock Duration History:**
  - Distinguishes `in_stock`, `out_of_stock`, and `unknown` (`not_yet_checked`, `pickup_not_open`, `blocked`, `rate_limited`, `schema_drift`, `network_error`).
  - Transient errors or HTTP 541 blocks never falsely close an active restock or re-spam initial Pushover alerts.
  - Records every restock in SQLite with **Area Store Count** (`2 / 5 stores in stock`), pickup quote, `FirstSeen`, `SoldOutAt`, and exact **Restock Duration**.
- **Pushover Alerts via Docker Environment Variables:**
  - Reads `PUSHOVER_USER_KEY`, `PUSHOVER_API_TOKEN`, and optional `PUSHOVER_DEVICE` directly from container environment variables (never stored in SQLite).
  - Supports separate Normal vs. Favorite ★ priority & sound settings, one-shot or repeat reminders, consolidated multi-store alerts, direct **Buy on Apple.com** links, and a **Send Test Notification** button.
- **Zero Auth Overhead:** Designed for trusted local LAN hosting on Unraid.

---

## Deploying on Unraid

### Option A: Docker Compose (Unraid Compose Manager)

1. Copy this repository to your Unraid server (for example `/mnt/user/appdata/apple-stock-checker-src`).
2. Create a `.env` file alongside `docker-compose.yml`:
   ```ini
   PUSHOVER_USER_KEY=your_user_key
   PUSHOVER_API_TOKEN=your_app_token
   PUSHOVER_DEVICE=
   TZ=UTC
   ```
3. Build and start the container:
   ```bash
   docker compose up -d --build
   ```
4. Open `http://<YOUR_UNRAID_IP>:8080` in your browser.

### Option B: Unraid Native Docker Tab (`unraid-template.xml`)

1. Build the image on your Unraid host:
   ```bash
   docker build -t apple-stock-checker:latest .
   ```
2. Copy `unraid-template.xml` to your Unraid flash drive templates folder:
   ```bash
   cp unraid-template.xml /boot/config/plugins/dockerMan/templates-user/my-apple-stock-checker.xml
   ```
3. In the Unraid WebGUI, go to **Docker → Add Container → Select a template → `apple-stock-checker`**, enter your `PUSHOVER_USER_KEY` and `PUSHOVER_API_TOKEN`, verify `/mnt/user/appdata/apple-stock-checker` is mapped to `/data`, and click **Apply**.

---

## Environment Variables

| Variable | Required | Default | Description |
| :--- | :---: | :--- | :--- |
| `PUSHOVER_USER_KEY` | Yes (for alerts) | — | Your Pushover User Key |
| `PUSHOVER_API_TOKEN` | Yes (for alerts) | — | Your Pushover Application API Token |
| `PUSHOVER_DEVICE` | No | *(all devices)* | Optional target device name |
| `PORT` | No | `8080` | HTTP port for Web UI + REST/SSE API |
| `DB_PATH` | No | `/data/apple-stock.db` | Path to persistent SQLite database |
| `TZ` | No | `UTC` | Container timezone |

---

## Local Development & Testing

Requires **Node.js 24+** (uses Node 24's built-in `node:sqlite`, matching the `node:24-alpine` container image).

```bash
# Install dependencies
npm install

# Run automated test suite
npm test

# Build client SPA + backend server
npm run build

# Regenerate bundled seed catalogs directly from Apple.com (optional)
npm run seed

# Start production server locally on http://localhost:8080
DB_PATH=./data/apple-stock.db npm start
```

---

## License

Released under the [MIT License](./LICENSE).
