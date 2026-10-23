import { getConfig } from "@/lib/config";
import { AppError, ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { logger } from "@/lib/observability/logger";
import { decryptToken, encryptToken } from "@/lib/security/token-vault";
import {
  ShopifyApiError,
  shopifyGraphql,
  startBulkQuery,
  streamJsonl,
  waitForBulkQuery,
} from "./client";
import { normalizeShopDomain } from "./domain";
import { ShopifyUpstreamError } from "./sync-errors";
import { MOCK_SHOP, mockShopifyCatalog } from "./mock";
import { CATALOG_BULK_QUERY, ORDERS_BULK_QUERY, createCatalogBuilder, createSalesAggregator } from "./parse";
import {
  deleteConnection,
  getConnection,
  listConnectedClientIds,
  replaceCatalog,
  saveConnection,
  setSyncStatus,
} from "./store";
import type { ShopifyCatalog } from "./store";
import type { ShopifySyncCounts, ShopifyVariant } from "./types";

/** Read-only connector: connect (token paste), sync, disconnect and status. */

export const REQUIRED_SCOPES = ["read_products", "read_inventory", "read_orders"] as const;
const RECONNECT_MESSAGE = "Shopify rejected the token: reconnect the store";
const BUSY_MESSAGE = "Shopify is busy, try again in a few minutes";
const GENERIC_SYNC_MESSAGE = "The Shopify sync failed. Try again, and reconnect the store if it keeps failing.";
const NO_PRODUCTS_MESSAGE = "Shopify returned no products; keeping the existing data";
const ALREADY_RUNNING_MESSAGE = "A sync is already running for this store";
const ACCESS_DENIED_MESSAGE =
  "Shopify refused access to the store's orders or products. Check the app's read_products, read_inventory and read_orders access and its protected customer data settings.";
/** A "running" status older than this is a crashed run and may be restarted. */
const STALE_RUNNING_MS = 15 * 60_000;
const DAY_MS = 24 * 3600 * 1000;
/** While a bulk result streams, heartbeat at most this often (well inside STALE_RUNNING_MS). */
const STREAM_HEARTBEAT_MS = 60_000;
/**
 * Largest bulk result (Shopify's objectCount) the sync will download. Every catalogue row is
 * held in memory until it is saved, so a bigger store is refused before the download starts.
 */
export const MAX_BULK_OBJECTS = 3_000_000;
const CATALOGUE_STAGE = "catalogue bulk read";
const ORDERS_STAGE = "orders bulk read";

function tooLargeMessage(stage: string, objectCount: number): string {
  const n = objectCount.toLocaleString("en-US");
  return stage === ORDERS_STAGE
    ? `This store has too many recent orders to sync (${n} records). Contact support.`
    : `This store's catalogue is too large to sync (${n} records). Contact support.`;
}

/** An error whose message is fixed text, safe to store and show. */
class SyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncError";
  }
}

function isDemo(): boolean {
  return getConfig().isDemoMode;
}

/**
 * Fields for a failure log line: the client, Shopify's status and code, and Shopify's
 * validation text (userErrors / GraphQL errors with field paths, bulk errorCode) already
 * redacted in client.ts. Never the token or a response body; no customer data.
 */
function failureLog(
  clientId: string,
  error: unknown,
  message: string,
  extra: { stage?: string; token?: string; objectCount?: number | null } = {},
): Record<string, unknown> {
  return {
    clientId,
    message,
    ...(extra.stage ? { stage: extra.stage } : {}),
    ...(extra.objectCount != null ? { objectCount: extra.objectCount } : {}),
    status: error instanceof ShopifyApiError ? error.status : null,
    code: error instanceof ShopifyApiError ? error.code : null,
    detail: error instanceof ShopifyApiError ? error.detail : plainErrorText(error, extra.token),
    error: error instanceof Error ? error.name : typeof error,
  };
}

/**
 * The text of an error that did not come from Shopify (a database or parsing failure), for the
 * log only: capped, with the token removed. It is never stored or returned to a client.
 */
function plainErrorText(error: unknown, token = ""): string | null {
  if (!(error instanceof Error) || !error.message) return null;
  const text = token ? error.message.split(token).join("[redacted]") : error.message;
  return text.slice(0, 300);
}

/**
 * Fixed, plain text for a failure. Shopify's own error text and response bodies are never
 * passed through: only the status and code are looked at.
 */
function safeMessage(error: unknown): string {
  if (error instanceof SyncError) return error.message;
  if (error instanceof ShopifyApiError) {
    // A bulk operation that fails for missing access reports errorCode ACCESS_DENIED with HTTP 200.
    if (error.code === "ACCESS_DENIED") return ACCESS_DENIED_MESSAGE;
    if (error.status === 401 || error.status === 403 || error.code === "UNAUTHORIZED") return RECONNECT_MESSAGE;
    if (error.status === 429 || error.code === "THROTTLED" || error.code === "BULK_OPERATION_RUNNING") {
      return BUSY_MESSAGE;
    }
    // Status 0 (no HTTP exchange) and 404 messages are fixed text written in client.ts.
    if (error.status === 0 || error.status === 404) return error.message;
  }
  return GENERIC_SYNC_MESSAGE;
}

export async function connectShopify(input: {
  clientId: string;
  shopDomain: string;
  accessToken: string;
  connectedBy: string;
}): Promise<{ shopName: string; currency: string }> {
  const host = normalizeShopDomain(input.shopDomain);
  if (!host) {
    throw new ValidationError("That is not a valid Shopify store address (expected name.myshopify.com).");
  }

  if (isDemo()) {
    // No network in demo mode: the mock shop stands in.
    await saveConnection({
      clientId: input.clientId,
      shopDomain: MOCK_SHOP.domain,
      shopName: MOCK_SHOP.name,
      currency: MOCK_SHOP.currency,
      scopes: [...REQUIRED_SCOPES],
      accessTokenEncrypted: encryptToken(input.accessToken || "demo-token"),
      connectedBy: input.connectedBy,
    });
    return { shopName: MOCK_SHOP.name, currency: MOCK_SHOP.currency };
  }

  const token = input.accessToken.trim();
  if (!token.startsWith("shpat_")) {
    throw new ValidationError("That is not a Shopify Admin API access token (it should start with shpat_).");
  }

  let data: {
    shop: { name: string; currencyCode: string };
    currentAppInstallation: { accessScopes: Array<{ handle: string }> };
  };
  try {
    data = await shopifyGraphql(
      host,
      token,
      "{ shop { name currencyCode } currentAppInstallation { accessScopes { handle } } }",
    );
  } catch (error) {
    const message = safeMessage(error);
    logger.warn("Shopify connect failed", failureLog(input.clientId, error, message));
    throw new ValidationError(
      message === GENERIC_SYNC_MESSAGE ? "Shopify could not verify the store. Try again." : message,
    );
  }

  const granted = (data.currentAppInstallation?.accessScopes ?? []).map((s) => s.handle);
  // A write scope also grants read access to the same resource.
  const missing = REQUIRED_SCOPES.filter((s) => !granted.includes(s) && !granted.includes(s.replace(/^read_/, "write_")));
  if (missing.length) {
    throw new ValidationError(
      `The token is missing Shopify permissions: ${missing.join(", ")}. Add them to the app and copy the new token.`,
    );
  }

  const shopName = data.shop?.name ?? host;
  const currency = data.shop?.currencyCode ?? "USD";
  await saveConnection({
    clientId: input.clientId,
    shopDomain: host,
    shopName,
    currency,
    scopes: granted,
    accessTokenEncrypted: encryptToken(token),
    connectedBy: input.connectedBy,
  });
  return { shopName, currency };
}

/**
 * Runs one bulk query and streams its result into `push` one line at a time: the file is never
 * held whole, and no array of its lines is built. Refuses (before downloading) a result over
 * MAX_BULK_OBJECTS. Heartbeats at most every `heartbeatMs` while the result streams, so a long
 * download is not mistaken for a crashed run. Logs counts only (no data) when done.
 */
async function readBulk(input: {
  clientId: string;
  host: string;
  token: string;
  query: string;
  stage: string;
  poll: { intervalMs?: number; onPoll: () => Promise<void> };
  heartbeatMs: number;
  push: (line: Record<string, unknown>) => void;
  onObjectCount: (n: number) => void;
}): Promise<void> {
  const { clientId, stage } = input;
  const op = await startBulkQuery(input.host, input.token, input.query);
  const done = await waitForBulkQuery(input.host, input.token, op, input.poll);
  input.onObjectCount(done.objectCount);
  if (done.objectCount > MAX_BULK_OBJECTS) {
    logger.warn("Shopify bulk result too large", { clientId, stage, objectCount: done.objectCount });
    throw new SyncError(tooLargeMessage(stage, done.objectCount));
  }
  const started = Date.now();
  const stats = { bytes: 0, lines: 0 };
  if (done.url) {
    let lastBeat = Date.now();
    for await (const line of streamJsonl(done.url, { stats })) {
      input.push(line);
      if (Date.now() - lastBeat >= input.heartbeatMs) {
        await heartbeat(clientId);
        lastBeat = Date.now();
      }
    }
  }
  logger.info("Shopify bulk read complete", {
    clientId,
    stage,
    objectCount: done.objectCount,
    bytes: stats.bytes,
    lines: stats.lines,
    ms: Date.now() - started,
  });
}

/**
 * Bumps updated_at so the running-sync guard sees the run is alive. Sent before every
 * bulk poll and between phases, so a long healthy run never looks stale (15 minutes).
 */
async function heartbeat(clientId: string): Promise<void> {
  await setSyncStatus(clientId, { status: "running" });
}

export async function syncShopify(
  clientId: string,
  opts: { now?: Date; pollIntervalMs?: number; heartbeatIntervalMs?: number } = {},
): Promise<ShopifySyncCounts> {
  const now = opts.now ?? new Date();
  const connection = await getConnection(clientId);
  if (!connection) throw new NotFoundError("This client has no Shopify store connected.");

  // Overlapping syncs delete each other's rows, so refuse while a recent run is in flight.
  // Thrown before status is touched so the running sync's status is left alone.
  if (connection.last_sync_status === "running") {
    const age = now.getTime() - Date.parse(connection.updated_at);
    if (!(age >= STALE_RUNNING_MS)) throw new ConflictError(ALREADY_RUNNING_MESSAGE);
  }

  await setSyncStatus(clientId, { status: "running" });
  // Which phase was running when a failure happened, for the log (never shown to users).
  let stage = "starting";
  let token = "";
  // Shopify's objectCount for the bulk read in progress, for the failure log.
  let objectCount: number | null = null;
  try {
    let catalog: ShopifyCatalog;
    let orders = 0;
    let skipped = 0;

    if (isDemo()) {
      catalog = mockShopifyCatalog(clientId);
    } else {
      stage = "reading the token";
      token = decryptToken(connection.access_token_encrypted);
      const host = connection.shop_domain;
      const poll = { intervalMs: opts.pollIntervalMs, onPoll: () => heartbeat(clientId) };
      const read = { clientId, host, token, poll, heartbeatMs: opts.heartbeatIntervalMs ?? STREAM_HEARTBEAT_MS };
      const onObjectCount = (n: number) => {
        objectCount = n;
      };
      // Each result is folded into its builder as it streams in.
      const catalogBuilder = createCatalogBuilder(clientId);
      const salesAggregator = createSalesAggregator(now);
      // Run one after the other (older API versions allow one bulk query per shop at a time).
      stage = CATALOGUE_STAGE;
      await readBulk({ ...read, query: CATALOG_BULK_QUERY, stage, push: catalogBuilder.push, onObjectCount });
      await heartbeat(clientId);
      const since = new Date(now.getTime() - 60 * DAY_MS).toISOString();
      stage = ORDERS_STAGE;
      objectCount = null;
      await readBulk({ ...read, query: ORDERS_BULK_QUERY(since), stage, push: salesAggregator.push, onObjectCount });
      await heartbeat(clientId);

      stage = "parsing";
      objectCount = null;
      const parsed = catalogBuilder.finish();
      const sales = salesAggregator.finish();
      orders = sales.orders;
      skipped = sales.skippedLineItems;
      // Sales are merged into the parsed rows in place: no second copy of every variant.
      const variants = parsed.variants as ShopifyVariant[];
      for (const v of variants) {
        const s = sales.byVariant.get(v.gid);
        v.units_30d = s?.units_30d ?? 0;
        v.revenue_30d_cents = s?.revenue_30d_cents ?? 0;
        v.units_60d = s?.units_60d ?? 0;
        v.revenue_60d_cents = s?.revenue_60d_cents ?? 0;
      }
      catalog = { collections: parsed.collections, products: parsed.products, variants };
    }

    // replaceCatalog with nothing deletes everything, so an empty read is a failure when
    // the last good sync had products. With no previous good sync (a new or empty store)
    // it is accepted and recorded as 0 products.
    if (catalog.products.length === 0 && (connection.last_sync_counts?.products ?? 0) > 0) {
      throw new SyncError(NO_PRODUCTS_MESSAGE);
    }

    stage = "saving";
    await heartbeat(clientId);
    await replaceCatalog(clientId, catalog);
    const counts: ShopifySyncCounts = {
      collections: catalog.collections.length,
      products: catalog.products.length,
      variants: catalog.variants.length,
      orders,
      skipped_line_items: skipped,
    };
    await setSyncStatus(clientId, { status: "ok", counts });
    return counts;
  } catch (error) {
    const message = safeMessage(error);
    logger.warn("Shopify sync failed", failureLog(clientId, error, message, { stage, token, objectCount }));
    try {
      await setSyncStatus(clientId, { status: "error", error: message });
    } catch {
      // The original failure matters more than a failed status write.
    }
    // Rethrow fixed text only, never the original error (it may carry Shopify text).
    throw new ShopifyUpstreamError(message);
  }
}

export async function disconnectShopify(clientId: string): Promise<void> {
  await deleteConnection(clientId);
}

export async function getShopifyStatus(clientId: string): Promise<{
  connected: boolean;
  shop_domain: string | null;
  shop_name: string | null;
  currency: string | null;
  last_sync_at: string | null;
  last_sync_status: string;
  last_sync_error: string | null;
  counts: ShopifySyncCounts | null;
}> {
  const c = await getConnection(clientId);
  if (!c) {
    return {
      connected: false,
      shop_domain: null,
      shop_name: null,
      currency: null,
      last_sync_at: null,
      last_sync_status: "never",
      last_sync_error: null,
      counts: null,
    };
  }
  return {
    connected: true,
    shop_domain: c.shop_domain,
    shop_name: c.shop_name,
    currency: c.currency,
    last_sync_at: c.last_sync_at,
    last_sync_status: c.last_sync_status,
    last_sync_error: c.last_sync_error,
    counts: c.last_sync_counts ? { ...c.last_sync_counts } : null,
  };
}

/** Cron entry point: one store failing never stops the rest. */
export async function syncAllShopify(): Promise<{ synced: number; failed: number }> {
  let synced = 0;
  let failed = 0;
  for (const clientId of await listConnectedClientIds()) {
    try {
      await syncShopify(clientId);
      synced += 1;
    } catch (error) {
      failed += 1;
      // AppError messages here are fixed text (ShopifyUpstreamError, NotFound, Conflict).
      logger.warn("Shopify scheduled sync failed", {
        clientId,
        message: error instanceof AppError ? error.message : "unexpected error",
        error: error instanceof Error ? error.name : typeof error,
      });
    }
  }
  return { synced, failed };
}
