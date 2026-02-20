# Amazon Invoice Transfer Tool

Downloads invoices from Amazon Business and uploads them to Paperless-ngx.

## Setup

```bash
# Install dependencies
npm install

# Install Playwright browser (first time only)
npx playwright install chromium

# Copy and edit config
cp .env.example .env
```

Edit `.env`:

```
# Amazon
AMAZON_DOMAIN=amazon.de
DOWNLOAD_DIR=./invoices

# Paperless-ngx
PAPERLESS_URL=https://pl.company.com
PAPERLESS_API_TOKEN=your-api-token-here

# Cloudflare Access (only if Paperless is behind a CF tunnel)
CF_ACCESS_CLIENT_ID=
CF_ACCESS_CLIENT_SECRET=
```

No Amazon credentials are stored -- you log in manually in the browser window.

## Usage

### Download invoices from Amazon

```bash
# Download all invoices since a date
npx tsx src/cli.ts download --since 2025-01-01

# Download invoices in a specific date range
npx tsx src/cli.ts download --since 2024-01-01 --until 2024-12-31
```

A Chromium window opens. Log in to your Amazon Business account, and the tool takes over -- navigating order history and downloading each invoice PDF.

### Upload invoices to Paperless-ngx

```bash
npx tsx src/cli.ts upload
```

Uploads all downloaded invoices that haven't been synced to Paperless yet. Each document is uploaded with:
- **Tag:** `amazon`
- **Correspondent:** `Amazon`
- **Document type:** `Rechnung`
- **Created date:** set to the Amazon order date

Already-uploaded invoices are skipped automatically.

### Check status

```bash
npx tsx src/cli.ts status
```

Shows downloaded invoices, upload status, and when the tool last ran.

## How it works

1. **Download:** Opens a Chromium browser, navigates to Amazon sign-in (you log in manually), then scans order history for the specified date range. For each order, it fetches the invoice PDF via the "Rechnung" popover.
2. **Upload:** Connects to the Paperless-ngx REST API (with Cloudflare Access support) and uploads each invoice PDF with metadata.
3. **State tracking:** `invoices/state.json` tracks which invoices have been downloaded and uploaded, so re-runs only process new invoices.

## Notes

- After logging in once, the browser session is persisted in `invoices/.browser-profile/` so future runs skip the login
- The tool saves state after each invoice, so you can safely interrupt and resume
- Some orders have multiple invoices (e.g. split shipments) -- all are downloaded
