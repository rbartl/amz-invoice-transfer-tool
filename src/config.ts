/**
 * Configuration module.
 *
 * Loads settings from a .env file and exports them as a typed object.
 */

import dotenv from "dotenv";
import path from "path";

dotenv.config();

/** Describes all configuration values our app needs */
export interface Config {
  /** Amazon domain to use (amazon.de, amazon.com, etc.) */
  amazonDomain: string;
  /** Directory where invoice PDFs are saved */
  downloadDir: string;
  /** Paperless-ngx settings */
  paperless: {
    url: string;
    apiToken: string;
    /** Cloudflare Access service token (for tunneled instances) */
    cfAccessClientId: string | undefined;
    cfAccessClientSecret: string | undefined;
  };
}

/** Build and export the config object */
export function loadConfig(): Config {
  return {
    amazonDomain: process.env["AMAZON_DOMAIN"] || "amazon.de",
    downloadDir: path.resolve(process.env["DOWNLOAD_DIR"] || "./invoices"),
    paperless: {
      url: process.env["PAPERLESS_URL"] || "",
      apiToken: process.env["PAPERLESS_API_TOKEN"] || "",
      cfAccessClientId: process.env["CF_ACCESS_CLIENT_ID"] || undefined,
      cfAccessClientSecret: process.env["CF_ACCESS_CLIENT_SECRET"] || undefined,
    },
  };
}
