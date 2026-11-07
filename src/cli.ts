/**
 * CLI entry point.
 *
 * Usage:
 *   npx tsx src/cli.ts download --since 2025-01-01
 *   npx tsx src/cli.ts download --since 2025-01-01 --until 2025-06-30
 *   npx tsx src/cli.ts status
 */

import fs from "fs";
import path from "path";
import { Command } from "commander";
import { chromium } from "playwright";
import { loadConfig } from "./config.js";
import {
  downloadInvoices,
  waitForManualLogin,
  loadState,
  saveState,
  parseOrderDate,
} from "./amazon/downloader.js";
import {
  getOrCreateTag,
  getOrCreateCorrespondent,
  getOrCreateDocumentType,
  uploadDocument,
  findDocumentByOrderId,
  buildDocumentUrl,
} from "./paperless/client.js";

const program = new Command();

program
  .name("amz-invoice-tool")
  .description("Download invoices from Amazon Business and sync them locally")
  .version("1.0.0");

/**
 * "download" command -- opens a browser, lets you log in,
 * then downloads invoices for the given date range.
 */
program
  .command("download")
  .description("Download invoices from Amazon Business for a date range")
  .requiredOption(
    "--since <date>",
    "Start date (YYYY-MM-DD). Download invoices from this date onwards."
  )
  .option(
    "--until <date>",
    "End date (YYYY-MM-DD). Defaults to today.",
    new Date().toISOString().slice(0, 10)
  )
  .action(async (options: { since: string; until: string }) => {
    const since = new Date(options.since);
    const until = new Date(options.until);

    if (isNaN(since.getTime())) {
      console.error(`Invalid --since date: ${options.since}. Use YYYY-MM-DD format.`);
      process.exit(1);
    }
    if (isNaN(until.getTime())) {
      console.error(`Invalid --until date: ${options.until}. Use YYYY-MM-DD format.`);
      process.exit(1);
    }
    if (since > until) {
      console.error("--since date must be before --until date.");
      process.exit(1);
    }

    const config = loadConfig();
    const baseUrl = `https://www.${config.amazonDomain}`;

    console.log("Amazon Invoice Download Tool");
    console.log("============================");
    console.log(`Domain:    ${config.amazonDomain}`);
    console.log(`Download:  ${config.downloadDir}`);
    console.log(`Range:     ${options.since} to ${options.until}`);
    console.log();

    // Launch Chromium with a persistent profile so cookies/sessions survive
    // between runs. After you log in once, Amazon should remember you.
    const userDataDir = path.join(config.downloadDir, ".browser-profile");
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      locale: "de-DE",
      executablePath: process.env.CHROMIUM_PATH || undefined,
    });

    const page = context.pages()[0] || (await context.newPage());

    try {
      // Step 1: Let the user log in
      await waitForManualLogin(page, baseUrl);

      // Step 2: Download invoices
      const invoices = await downloadInvoices(page, context, config, since, until);

      // Summary
      console.log("\n============================");
      console.log(`Downloaded ${invoices.length} new invoice(s).`);
      if (invoices.length > 0) {
        console.log("Files saved to:", config.downloadDir);
        for (const inv of invoices) {
          console.log(`  - ${inv.filename} (${inv.orderDate})`);
        }
      }
    } catch (err) {
      console.error("\nError:", err instanceof Error ? err.message : err);
      process.exit(1);
    } finally {
      await context.close();
    }
  });

/**
 * "upload" command -- uploads downloaded invoices to Paperless-ngx.
 * Only uploads invoices that haven't been uploaded yet.
 */
program
  .command("upload")
  .description("Upload downloaded invoices to Paperless-ngx")
  .action(async () => {
    const config = loadConfig();

    if (!config.paperless.url || !config.paperless.apiToken) {
      console.error("Missing PAPERLESS_URL or PAPERLESS_API_TOKEN in .env");
      process.exit(1);
    }

    const state = loadState(config.downloadDir);
    const pending = state.invoices.filter((inv) => !inv.uploadedToPaperless);
    const missingUrls = state.invoices.filter(
      (inv) => inv.uploadedToPaperless && !inv.paperlessUrl
    );

    console.log("Paperless Upload");
    console.log("================");
    console.log(`Paperless:  ${config.paperless.url}`);
    console.log(`Invoices:   ${state.invoices.length} total, ${pending.length} to upload, ${missingUrls.length} missing URLs`);
    console.log();

    // Find URLs for invoices that were uploaded but don't have URLs stored
    if (missingUrls.length > 0) {
      console.log("Finding URLs for previously uploaded invoices...");
      for (const inv of missingUrls) {
        try {
          const docId = await findDocumentByOrderId(config, inv.orderId);
          if (docId) {
            inv.paperlessUrl = buildDocumentUrl(config, docId);
            saveState(config.downloadDir, state);
            console.log(`  [found] ${inv.orderId} -> ${inv.paperlessUrl}`);
          } else {
            console.log(`  [not found] ${inv.orderId} -- document not in Paperless`);
          }
        } catch (err) {
          console.log(`  [error] ${inv.orderId}: ${err instanceof Error ? err.message : err}`);
        }
      }
      console.log();
    }

    if (pending.length === 0) {
      console.log("Nothing to upload. All invoices are already in Paperless.");
      return;
    }

    // Get or create the tag and correspondent for Amazon invoices
    console.log("Setting up Paperless metadata...");
    const tagId = await getOrCreateTag(config, "amazon");
    const correspondentId = await getOrCreateCorrespondent(config, "Amazon");
    const docTypeId = await getOrCreateDocumentType(config, "Rechnung");
    console.log(`  Tag "amazon": id=${tagId}`);
    console.log(`  Correspondent "Amazon": id=${correspondentId}`);
    console.log(`  Document type "Rechnung": id=${docTypeId}`);
    console.log();

    let uploaded = 0;
    let skipped = 0;

    for (const inv of pending) {
      const filePath = path.join(config.downloadDir, inv.filename);

      // Check if file exists locally
      if (!fs.existsSync(filePath)) {
        console.log(`  [skip] ${inv.filename} -- file not found locally`);
        skipped++;
        continue;
      }

      // Check if already in Paperless (e.g. manually uploaded before)
      // Searches by order ID in title (wildcard) and document content
      const existingDocId = await findDocumentByOrderId(config, inv.orderId);
      if (existingDocId) {
        inv.paperlessUrl = buildDocumentUrl(config, existingDocId);
        console.log(`  [skip] ${inv.orderId} -- already in Paperless (${inv.paperlessUrl})`);
        inv.uploadedToPaperless = true;
        saveState(config.downloadDir, state);
        skipped++;
        continue;
      }

      // Use order ID as title for easy searching and dedup
      const title = `Amazon Rechnung ${inv.orderId}`;

      console.log(`  [upload] ${inv.orderId} (${inv.orderDate})...`);

      try {
        // Convert German date "5. Februar 2026" to ISO format for Paperless
        const parsedDate = parseOrderDate(inv.orderDate);
        const isoDate = parsedDate
          ? parsedDate.toISOString()
          : undefined;

        const taskId = await uploadDocument(config, filePath, {
          title,
          correspondent: correspondentId,
          documentType: docTypeId,
          tags: [tagId],
          created: isoDate,
        });

        inv.uploadedToPaperless = true;
        console.log(`    -> Uploaded (task: ${taskId})`);

        // Wait briefly for Paperless to process, then find the document URL
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const newDocId = await findDocumentByOrderId(config, inv.orderId);
        if (newDocId) {
          inv.paperlessUrl = buildDocumentUrl(config, newDocId);
          console.log(`    -> URL: ${inv.paperlessUrl}`);
        }

        saveState(config.downloadDir, state);
        uploaded++;
      } catch (err) {
        console.log(
          `    Error: ${err instanceof Error ? err.message : err}`
        );
      }
    }

    console.log();
    console.log("================");
    console.log(`Uploaded: ${uploaded}, Skipped: ${skipped}`);
  });

/**
 * "status" command -- show what's been downloaded so far.
 */
program
  .command("status")
  .description("Show download status and previously synced invoices")
  .action(() => {
    const config = loadConfig();
    const state = loadState(config.downloadDir);

    console.log("Sync Status");
    console.log("===========");
    console.log(`Download dir: ${config.downloadDir}`);
    console.log(`Last run:     ${state.lastRun || "never"}`);
    console.log(`Invoices:     ${state.invoices.length}`);

    if (state.invoices.length > 0) {
      console.log("\nDownloaded invoices:");
      for (const inv of state.invoices) {
        const paperlessStatus = inv.paperlessUrl
          ? inv.paperlessUrl
          : inv.uploadedToPaperless
            ? "(uploaded, URL unknown)"
            : "(not uploaded)";
        console.log(`  ${inv.orderId}  ${inv.orderDate}  ${paperlessStatus}`);
      }
    }
  });

program.parse();
