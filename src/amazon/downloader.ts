/**
 * Amazon Business invoice downloader.
 *
 * Navigates the order history page, iterates through orders in a date range,
 * and downloads the invoice PDF for each order.
 *
 * The user logs in manually in the browser window -- no credentials stored.
 */

import { type Page, type BrowserContext } from "playwright";
import { type Config } from "../config.js";
import fs from "fs";
import path from "path";

/** Represents a downloaded invoice */
export interface InvoiceRecord {
  orderId: string;
  orderDate: string; // date text as shown on Amazon
  filename: string;
  downloadedAt: string; // ISO timestamp
  uploadedToPaperless?: boolean; // true once uploaded to Paperless-ngx
  paperlessUrl?: string; // URL to the document in Paperless-ngx
}

/** State file tracking which invoices have already been downloaded */
export interface SyncState {
  lastRun: string | null;
  invoices: InvoiceRecord[];
}

const STATE_FILE = "state.json";

/** Load the sync state from disk, or create a fresh one */
export function loadState(downloadDir: string): SyncState {
  const statePath = path.join(downloadDir, STATE_FILE);
  if (fs.existsSync(statePath)) {
    const raw = fs.readFileSync(statePath, "utf-8");
    return JSON.parse(raw) as SyncState;
  }
  return { lastRun: null, invoices: [] };
}

/** Save the sync state to disk */
export function saveState(downloadDir: string, state: SyncState): void {
  const statePath = path.join(downloadDir, STATE_FILE);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
}

/**
 * Wait for the user to log in manually.
 *
 * Opens Amazon's sign-in page and waits until the user has completed login.
 * We detect a successful login by checking for elements that only appear
 * when logged in (e.g. the account name in the nav bar).
 */
export async function waitForManualLogin(
  page: Page,
  baseUrl: string
): Promise<void> {
  // Navigate to order history -- if not logged in, Amazon will redirect to sign-in
  // and then back to order history after login.
  await page.goto(`${baseUrl}/gp/your-account/order-history`, {
    waitUntil: "load",
  });

  // Check if we landed on a sign-in page or the actual order history.
  // Sign-in pages have /ap/signin in the URL path.
  const currentUrl = page.url();
  const isSignInPage =
    currentUrl.includes("/ap/signin") || currentUrl.includes("/ap/register");

  if (!isSignInPage) {
    console.log("Already logged in! Starting invoice download...");
    return;
  }

  console.log();
  console.log("==> Please log in to Amazon in the browser window.");
  console.log("    The tool will continue automatically once you're logged in.");
  console.log();

  // Wait until the URL no longer contains /ap/signin (i.e., the user finished logging in).
  // We give the user up to 5 minutes to complete login + 2FA.
  try {
    await page.waitForURL(
      (url) => !url.pathname.includes("/ap/signin") && !url.pathname.includes("/ap/register"),
      { timeout: 300_000 } // 5 minutes
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("closed")) {
      throw new Error("Browser was closed before login completed.");
    }
    throw new Error("Login timed out. Please try again.");
  }

  // Wait for the page to settle after redirect
  await page.waitForTimeout(2000);
  console.log("Login detected! Starting invoice download...");
}

/**
 * Get the list of years we need to scan based on the date range.
 * Amazon's order history is filtered by year, so if the range spans
 * 2024-2025, we need to check both years.
 */
function getYearsInRange(since: Date, until: Date): number[] {
  const years: number[] = [];
  for (let y = since.getFullYear(); y <= until.getFullYear(); y++) {
    years.push(y);
  }
  return years;
}

/**
 * Parse a date string from Amazon's order page.
 * Amazon uses locale-specific date formats, e.g.:
 *   German: "15. Januar 2025" or "15. Jänner 2025" (Austrian)
 *   English: "January 15, 2025"
 */
export function parseOrderDate(dateStr: string): Date | null {
  // Month name -> month index (0-based) for German and English
  const months: Record<string, number> = {
    // German (including Austrian variants)
    januar: 0, jänner: 0, februar: 1, feber: 1, märz: 2,
    april: 3, mai: 4, juni: 5, juli: 6, august: 7,
    september: 8, oktober: 9, november: 10, dezember: 11,
    // English
    january: 0, february: 1, march: 2,
    may: 4, june: 5, july: 6,
    october: 9, december: 11,
    // "april", "august", "september", "november" are the same in both languages
  };

  // Try German format: "15. Januar 2025"
  // Use [\p{L}]+ (Unicode letter class) to match month names with umlauts (e.g. "März")
  const deMatch = dateStr.match(/(\d{1,2})\.\s*([\p{L}]+)\s+(\d{4})/u);
  if (deMatch) {
    const day = parseInt(deMatch[1]!, 10);
    const monthName = deMatch[2]!.toLowerCase();
    const year = parseInt(deMatch[3]!, 10);
    const month = months[monthName];
    if (month !== undefined) {
      return new Date(year, month, day);
    }
  }

  // Try English format: "January 15, 2025"
  const enMatch = dateStr.match(/([\p{L}]+)\s+(\d{1,2}),?\s+(\d{4})/u);
  if (enMatch) {
    const monthName = enMatch[1]!.toLowerCase();
    const day = parseInt(enMatch[2]!, 10);
    const year = parseInt(enMatch[3]!, 10);
    const month = months[monthName];
    if (month !== undefined) {
      return new Date(year, month, day);
    }
  }

  // Try ISO format: "2025-01-15"
  const isoMatch = dateStr.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return new Date(
      parseInt(isoMatch[1]!, 10),
      parseInt(isoMatch[2]!, 10) - 1,
      parseInt(isoMatch[3]!, 10)
    );
  }

  return null;
}

/**
 * Download all invoices within the specified date range.
 *
 * Strategy:
 * 1. Go to order history for each relevant year
 * 2. Collect all order links on each page (handle pagination)
 * 3. For each order, check if date is in range
 * 4. Visit the order detail and download the invoice PDF
 * 5. Save to local directory with a meaningful filename
 */
export async function downloadInvoices(
  page: Page,
  context: BrowserContext,
  config: Config,
  since: Date,
  until: Date
): Promise<InvoiceRecord[]> {
  const baseUrl = `https://www.${config.amazonDomain}`;
  const downloadDir = config.downloadDir;
  const state = loadState(downloadDir);
  const downloadedOrderIds = new Set(state.invoices.map((i) => i.orderId));
  const newInvoices: InvoiceRecord[] = [];

  // Ensure download directory exists
  fs.mkdirSync(downloadDir, { recursive: true });

  const years = getYearsInRange(since, until);
  console.log(`\nScanning orders for year(s): ${years.join(", ")}`);
  console.log(
    `Date range: ${since.toISOString().slice(0, 10)} to ${until.toISOString().slice(0, 10)}`
  );

  for (const year of years) {
    console.log(`\n--- Year ${year} ---`);

    let pageNum = 0;
    let hasMore = true;

    while (hasMore) {
      if (pageNum === 0) {
        // First page: navigate to order history and select the year from the dropdown.
        // Amazon Business uses a JS dropdown (#timeFilterDropdown) -- URL params are ignored.
        const orderHistoryUrl = `${baseUrl}/gp/your-account/order-history`;
        console.log(`Loading order history...`);
        await page.goto(orderHistoryUrl, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(2000);

        // Select the year in the time filter dropdown
        const dropdown = page.locator("#timeFilterDropdown");
        const currentValue = await dropdown.inputValue();
        if (currentValue !== String(year)) {
          console.log(`  Selecting year ${year} from filter...`);
          await dropdown.selectOption(String(year));
          // Wait for the page to reload with filtered results
          await page.waitForTimeout(3000);
        }
      } else {
        // Subsequent pages: click the "Next" pagination link
        const nextLink = page.locator(
          '.a-pagination .a-last:not(.a-disabled) a'
        );
        if (await nextLink.isVisible().catch(() => false)) {
          console.log(`  Loading page ${pageNum + 1}...`);
          await nextLink.click();
          await page.waitForTimeout(2000);
        } else {
          hasMore = false;
          break;
        }
      }

      // Find all order cards on the page.
      // Amazon Business wraps each order in a div with id="orderCard" containing
      // an order-details link. We use the link to reliably identify real order cards.
      const orderCards = page.locator('[id="orderCard"]:has(a[href*="order-details?orderID="])');
      const cardCount = await orderCards.count();

      if (cardCount === 0) {
        console.log("  No orders found on this page.");
        hasMore = false;
        break;
      }

      console.log(`  Found ${cardCount} orders on this page.`);

      // Collect order info from all cards first
      const ordersOnPage: { orderId: string; dateStr: string }[] = [];

      for (let i = 0; i < cardCount; i++) {
        const card = orderCards.nth(i);

        // Extract order ID from the order details link URL
        // Pattern: /your-orders/order-details?orderID=303-8439252-6893952
        const detailLink = card.locator('a[href*="order-details?orderID="]');
        const href = await detailLink.first().getAttribute("href").catch(() => null);
        let orderId: string | null = null;
        if (href) {
          const match = href.match(/orderID=([0-9-]+)/);
          if (match) orderId = match[1]!;
        }

        if (!orderId) {
          // Fallback: try the #orderIdField text content
          const orderIdField = card.locator("#orderIdField");
          const text = await orderIdField.textContent().catch(() => null);
          if (text) {
            const match = text.match(/(\d{3}-\d{7}-\d{7})/);
            if (match) orderId = match[1]!;
          }
        }

        if (!orderId) {
          console.log(`  Skipping order card ${i} -- could not find order ID`);
          continue;
        }

        // Extract order date
        // Structure: <div class="a-row a-color-secondary">Bestellung aufgegeben</div>
        //            <div class="a-row a-size-base">5. Februar 2026</div>
        const header = card.locator(".a-color-offset-background");
        const dateDiv = header.locator(".a-column").first().locator(".a-size-base");
        const dateStr = await dateDiv.textContent().catch(() => null);

        ordersOnPage.push({
          orderId,
          dateStr: dateStr?.trim() || "",
        });
      }

      // Process each order
      for (const order of ordersOnPage) {
        // Check if already downloaded
        if (downloadedOrderIds.has(order.orderId)) {
          console.log(`  [skip] ${order.orderId} -- already downloaded`);
          continue;
        }

        // Check date range
        const orderDate = parseOrderDate(order.dateStr);
        if (!orderDate) {
          console.log(
            `  [skip] ${order.orderId} (${order.dateStr}) -- could not parse date`
          );
          continue;
        }
        if (orderDate < since || orderDate > until) {
          console.log(
            `  [skip] ${order.orderId} (${order.dateStr}) -- outside date range`
          );
          continue;
        }

        // Download invoice PDF(s) for this order.
        // Some orders have multiple invoices (e.g. split shipments).
        console.log(`  [download] ${order.orderId} (${order.dateStr})...`);
        const invoices = await downloadOrderInvoices(
          page,
          baseUrl,
          order.orderId,
          order.dateStr,
          downloadDir
        );

        if (invoices.length > 0) {
          newInvoices.push(...invoices);
          downloadedOrderIds.add(order.orderId);
          // Save state after each successful download (crash-safe)
          state.invoices.push(...invoices);
          state.lastRun = new Date().toISOString();
          saveState(downloadDir, state);
          for (const inv of invoices) {
            console.log(`    -> Saved: ${inv.filename}`);
          }
        } else {
          console.log(`    No invoice PDF found for this order.`);
        }
      }

      // Check for pagination -- if there's a "next" link, we'll click it on the next iteration
      const nextButton = page.locator('.a-pagination .a-last:not(.a-disabled) a');
      hasMore = await nextButton.isVisible().catch(() => false);
      pageNum++;
    }
  }

  console.log(`\nDone! Downloaded ${newInvoices.length} new invoice(s).`);
  return newInvoices;
}

/**
 * Download invoice PDF(s) for a single order.
 *
 * Strategy:
 * 1. Click the "Rechnung" button on the order card to open the invoice popover
 * 2. Wait for the popover to load (it's fetched via AJAX)
 * 3. Find all links to actual invoice PDFs (/documents/download/...)
 * 4. Download each PDF directly
 *
 * Some orders have multiple invoices (e.g. split shipments), so this
 * returns an array of InvoiceRecords.
 */
async function downloadOrderInvoices(
  page: Page,
  baseUrl: string,
  orderId: string,
  dateStr: string,
  downloadDir: string
): Promise<InvoiceRecord[]> {
  const results: InvoiceRecord[] = [];

  try {
    // Fetch the invoice popover HTML via the same AJAX URL Amazon uses.
    // This avoids having to click the button and deal with popover UI timing.
    const popoverUrl = `${baseUrl}/your-orders/invoice/popover?orderId=${orderId}`;
    const popoverHtml = await page.evaluate(async (url: string) => {
      const resp = await fetch(url, { credentials: "include" });
      if (!resp.ok) return null;
      return resp.text();
    }, popoverUrl);

    if (!popoverHtml) {
      console.log(`    Could not fetch invoice popover for ${orderId}`);
      return results;
    }

    // Parse the popover HTML to find invoice PDF download links.
    // Pattern: /documents/download/{uuid}/invoice.pdf
    const pdfLinkRegex = /href="(\/documents\/download\/[^"]+)"/g;
    const pdfLinks: string[] = [];
    let match;
    while ((match = pdfLinkRegex.exec(popoverHtml)) !== null) {
      pdfLinks.push(match[1]!);
    }

    if (pdfLinks.length === 0) {
      console.log(`    No invoice PDF links found in popover for ${orderId}`);
      return results;
    }

    // Download each invoice PDF
    for (let i = 0; i < pdfLinks.length; i++) {
      const pdfPath = pdfLinks[i]!;
      const pdfUrl = `${baseUrl}${pdfPath}`;

      // Download the PDF binary via the browser's fetch (to keep the session cookies)
      const pdfBase64 = await page.evaluate(async (url: string) => {
        const resp = await fetch(url, { credentials: "include" });
        if (!resp.ok) return null;
        const buffer = await resp.arrayBuffer();
        // Convert to base64 so we can pass it back to Node
        const bytes = new Uint8Array(buffer);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]!);
        }
        return btoa(binary);
      }, pdfUrl);

      if (!pdfBase64) {
        console.log(`    Failed to download PDF from ${pdfPath}`);
        continue;
      }

      // Format date as YYYY-MM-DD for the filename
      const parsedDate = parseOrderDate(dateStr);
      const dateSlug = parsedDate
        ? parsedDate.toISOString().slice(0, 10)
        : dateStr.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-");
      const suffix = pdfLinks.length > 1 ? `_${i + 1}` : "";
      const filename = `amazon_${orderId}_${dateSlug}${suffix}.pdf`;
      const filePath = path.join(downloadDir, filename);

      fs.writeFileSync(filePath, Buffer.from(pdfBase64, "base64"));

      results.push({
        orderId,
        orderDate: dateStr,
        filename,
        downloadedAt: new Date().toISOString(),
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`    Error downloading invoice for ${orderId}: ${message}`);
  }

  return results;
}
