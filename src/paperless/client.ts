/**
 * Paperless-ngx API client.
 *
 * Handles uploading documents, managing tags and correspondents.
 * Supports Cloudflare Access tunnel authentication.
 */

import fs from "fs";
import path from "path";
import { type Config } from "../config.js";

/** Headers needed for every Paperless API request */
function buildHeaders(config: Config): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Token ${config.paperless.apiToken}`,
    Accept: "application/json",
  };

  // Add Cloudflare Access headers if configured
  if (config.paperless.cfAccessClientId && config.paperless.cfAccessClientSecret) {
    headers["CF-Access-Client-Id"] = config.paperless.cfAccessClientId;
    headers["CF-Access-Client-Secret"] = config.paperless.cfAccessClientSecret;
  }

  return headers;
}

/** Make a GET request to the Paperless API */
async function apiGet(config: Config, endpoint: string): Promise<any> {
  const url = `${config.paperless.url}${endpoint}`;
  const resp = await fetch(url, { headers: buildHeaders(config) });

  if (!resp.ok) {
    throw new Error(`Paperless API GET ${endpoint} failed: ${resp.status} ${resp.statusText}`);
  }

  return resp.json();
}

/** Make a POST request with JSON body */
async function apiPost(config: Config, endpoint: string, body: any): Promise<any> {
  const url = `${config.paperless.url}${endpoint}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { ...buildHeaders(config), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Paperless API POST ${endpoint} failed: ${resp.status} ${resp.statusText} ${text}`);
  }

  return resp.json();
}

/**
 * Get or create a tag by name.
 * Returns the tag ID.
 */
export async function getOrCreateTag(config: Config, tagName: string): Promise<number> {
  // Search existing tags
  const data = await apiGet(config, `/api/tags/?name__iexact=${encodeURIComponent(tagName)}`);

  if (data.results && data.results.length > 0) {
    return data.results[0].id;
  }

  // Create new tag
  console.log(`  Creating tag "${tagName}" in Paperless...`);
  const created = await apiPost(config, "/api/tags/", { name: tagName });
  return created.id;
}

/**
 * Get or create a correspondent by name.
 * Returns the correspondent ID.
 */
export async function getOrCreateCorrespondent(config: Config, name: string): Promise<number> {
  const data = await apiGet(config, `/api/correspondents/?name__iexact=${encodeURIComponent(name)}`);

  if (data.results && data.results.length > 0) {
    return data.results[0].id;
  }

  console.log(`  Creating correspondent "${name}" in Paperless...`);
  const created = await apiPost(config, "/api/correspondents/", { name });
  return created.id;
}

/**
 * Get or create a document type by name.
 * Returns the document type ID.
 */
export async function getOrCreateDocumentType(config: Config, name: string): Promise<number> {
  const data = await apiGet(config, `/api/document_types/?name__iexact=${encodeURIComponent(name)}`);

  if (data.results && data.results.length > 0) {
    return data.results[0].id;
  }

  console.log(`  Creating document type "${name}" in Paperless...`);
  const created = await apiPost(config, "/api/document_types/", { name });
  return created.id;
}

/**
 * Search for a document by order ID.
 * First searches for the order ID in the title (wildcard match),
 * then falls back to searching the full document content.
 * Returns the document ID if found, null otherwise.
 */
export async function findDocumentByOrderId(config: Config, orderId: string): Promise<number | null> {
  // Paperless full-text search tokenizes "303-0755476-5623501" into several
  // terms and matches documents containing any of them. So we search for a
  // phrase and then verify client-side that the full order ID really occurs
  // in the title or content of the hit.
  const contains = (doc: any) =>
    String(doc.title ?? "").includes(orderId) || String(doc.content ?? "").includes(orderId);

  const queries = [`title:*${orderId}*`, `"${orderId}"`];
  for (const query of queries) {
    const data = await apiGet(
      config,
      `/api/documents/?page_size=25&query=${encodeURIComponent(query)}`
    );
    const hit = (data.results ?? []).find(contains);
    if (hit) return hit.id;
  }

  return null;
}

/**
 * Build the URL to view a document in Paperless-ngx.
 */
export function buildDocumentUrl(config: Config, documentId: number): string {
  return `${config.paperless.url}/documents/${documentId}/details`;
}

/**
 * Upload a PDF document to Paperless-ngx.
 *
 * Uses the POST /api/documents/post_document/ endpoint which accepts
 * multipart form data.
 *
 * @returns The task ID for tracking the upload processing
 */
export async function uploadDocument(
  config: Config,
  filePath: string,
  options: {
    title: string;
    correspondent?: number;
    documentType?: number;
    tags?: number[];
    created?: string; // ISO date string
  }
): Promise<string> {
  const url = `${config.paperless.url}/api/documents/post_document/`;
  const headers = buildHeaders(config);
  // Remove Content-Type -- fetch will set it with the boundary for multipart
  delete headers["Accept"];

  // Build multipart form data
  const form = new FormData();
  const fileBuffer = fs.readFileSync(filePath);
  const blob = new Blob([fileBuffer], { type: "application/pdf" });
  form.append("document", blob, path.basename(filePath));
  form.append("title", options.title);

  if (options.correspondent) {
    form.append("correspondent", options.correspondent.toString());
  }
  if (options.documentType) {
    form.append("document_type", options.documentType.toString());
  }
  if (options.tags) {
    for (const tagId of options.tags) {
      form.append("tags", tagId.toString());
    }
  }
  if (options.created) {
    form.append("created", options.created);
  }

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: form,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Upload failed: ${resp.status} ${resp.statusText} ${text}`);
  }

  // Returns a task ID like "abc-123-def"
  const taskId = await resp.text();
  return taskId.replace(/"/g, "").trim();
}

/**
 * Check the status of an upload task.
 */
export async function getTaskStatus(
  config: Config,
  taskId: string
): Promise<{ status: string; result?: string }> {
  const data = await apiGet(config, `/api/tasks/?task_id=${taskId}`);

  if (data.results && data.results.length > 0) {
    return {
      status: data.results[0].status,
      result: data.results[0].result,
    };
  }

  return { status: "UNKNOWN" };
}
