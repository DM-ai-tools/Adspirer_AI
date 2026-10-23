import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/observability/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { resetConfigCache } from "@/lib/config";
import { logger } from "@/lib/observability/logger";
import { ValidationError } from "@/lib/errors";
import { getDemoStore } from "@/lib/demo/store";
import { decryptToken } from "@/lib/security/token-vault";
import { MOCK_SHOP, MOCK_SALES_ORDERS } from "@/lib/shopify/mock";
import { getConnection, loadCatalog, loadSales, setSyncStatus } from "@/lib/shopify/store";
import {
  connectShopify,
  disconnectShopify,
  getShopifyStatus,
  syncAllShopify,
  syncShopify,
} from "@/lib/shopify/sync";

const CLIENT = "client_clicktrends";
const SHOP = "duringdays.myshopify.com";
const TOKEN = "shpat_SECRET_TOKEN_123";
const NOW = new Date("2026-10-23T12:00:00.000Z");

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const SCOPES = ["read_products", "read_inventory", "read_orders"];
const shopReply = (scopes = SCOPES) =>
  json({
    data: {
      shop: { name: "During Days", currencyCode: "GBP" },
      currentAppInstallation: { accessScopes: scopes.map((handle) => ({ handle })) },
    },
  });

const ORDERS_JSONL = [
  { id: "gid://shopify/Order/1", createdAt: "2026-10-20T10:00:00Z", cancelledAt: null, test: false },
  {
    id: "gid://shopify/LineItem/1",
    __parentId: "gid://shopify/Order/1",
    quantity: 2,
    title: "Stool",
    variantTitle: "Oak",
    sku: "S1",
    vendor: "V",
    variant: { id: "gid://shopify/ProductVariant/1" },
    product: { id: "gid://shopify/Product/1", productType: "Bar Stool" },
    discountedTotalSet: { shopMoney: { amount: "21.00" } },
  },
  {
    id: "gid://shopify/LineItem/2",
    __parentId: "gid://shopify/Order/1",
    quantity: 1,
    variant: null,
    discountedTotalSet: { shopMoney: { amount: "5.00" } },
  },
];
const jsonl = (rows: unknown[]) => new Response(rows.map((r) => JSON.stringify(r)).join("\n"));

type Opts = {
  scopes?: string[];
  orders?: unknown[];
  pollStatus?: string;
  pollErrorCode?: string;
  /** Status for the n-th poll (1-based) of a phase; overrides pollStatus. */
  pollStatusFor?: (kind: string, n: number) => string;
  status?: number;
  startReply?: unknown;
  onPoll?: (kind: string) => Promise<void> | void;
  onStart?: (kind: string) => void;
};

/** Routes Shopify calls by content. */
function installFetch(o: Opts = {}) {
  const polls: Record<string, number> = {};
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("https://files.example/")) {
      return jsonl(o.orders ?? ORDERS_JSONL);
    }
    if (o.status) return json({ errors: "nope" }, o.status);
    const body = JSON.parse(String(init?.body));
    const q: string = body.query;
    if (q.includes("currentAppInstallation")) return shopReply(o.scopes);
    if (q.includes("StartBulk")) {
      if (o.startReply) return json(o.startReply);
      const inner: string = body.variables.query;
      // The only bulk operation a sync may start is the orders read.
      const kind = inner.includes("orders(") && !inner.includes("products") ? "orders" : "unexpected";
      o.onStart?.(kind);
      return json({
        data: {
          bulkOperationRunQuery: {
            bulkOperation: { id: `gid://shopify/BulkOperation/${kind}`, status: "CREATED" },
            userErrors: [],
          },
        },
      });
    }
    if (q.includes("PollBulk")) {
      const kind = String(body.variables.id).endsWith("orders") ? "orders" : "unexpected";
      polls[kind] = (polls[kind] ?? 0) + 1;
      await o.onPoll?.(kind);
      return json({
        data: {
          node: {
            id: body.variables.id,
            status: o.pollStatusFor?.(kind, polls[kind]) ?? o.pollStatus ?? "COMPLETED",
            errorCode: o.pollErrorCode ?? null,
            objectCount: "3",
            url: `https://files.example/${kind}`,
          },
        },
      });
    }
    return json({ data: {} });
  });
  vi.stubGlobal("fetch", fn);
  return { fn };
}

const warnCalls = () => vi.mocked(logger.warn).mock.calls as Array<[string, Record<string, unknown>?]>;

beforeEach(() => {
  vi.mocked(logger.warn).mockClear();
  vi.stubEnv("DEMO_MODE", "false");
  resetConfigCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetConfigCache();
});

const connect = () =>
  connectShopify({ clientId: CLIENT, shopDomain: SHOP, accessToken: TOKEN, connectedBy: "u1" });

describe("connectShopify", () => {
  it("rejects a bad store address before any request", async () => {
    const { fn } = installFetch();
    await expect(
      connectShopify({ clientId: CLIENT, shopDomain: "https://evil.com", accessToken: TOKEN, connectedBy: "u1" }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("rejects a token that does not start shpat_", async () => {
    const { fn } = installFetch();
    await expect(
      connectShopify({ clientId: CLIENT, shopDomain: SHOP, accessToken: "abc123", connectedBy: "u1" }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("rejects a missing scope with a plain message", async () => {
    installFetch({ scopes: ["read_products", "read_inventory"] });
    await expect(connect()).rejects.toThrow(/read_orders/);
    expect(await getConnection(CLIENT)).toBeNull();
  });

  it("accepts write scopes as covering the matching read scopes", async () => {
    installFetch({ scopes: ["write_products", "write_inventory", "read_orders"] });
    await expect(connect()).resolves.toEqual({ shopName: "During Days", currency: "GBP" });
  });

  it("saves ciphertext that decrypts back to the token", async () => {
    installFetch();
    const out = await connect();
    expect(out).toEqual({ shopName: "During Days", currency: "GBP" });
    const row = await getConnection(CLIENT);
    expect(row?.access_token_encrypted).not.toContain(TOKEN);
    expect(decryptToken(row!.access_token_encrypted)).toBe(TOKEN);
    expect(row?.shop_domain).toBe(SHOP);
    expect(row?.scopes).toEqual(expect.arrayContaining(SCOPES));
  });

  it("maps a 401 to the reconnect message without leaking the token", async () => {
    installFetch({ status: 401 });
    const err = await connect().catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(String(err.message)).toContain("Shopify rejected the token: reconnect the store");
    expect(String(err.message)).not.toContain(TOKEN);
  });

  it("makes no request in demo mode and uses the mock shop", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    resetConfigCache();
    const { fn } = installFetch();
    const out = await connectShopify({
      clientId: CLIENT,
      shopDomain: MOCK_SHOP.domain,
      accessToken: "shpat_demo",
      connectedBy: "u1",
    });
    expect(out).toEqual({ shopName: MOCK_SHOP.name, currency: MOCK_SHOP.currency });
    expect(fn).not.toHaveBeenCalled();
    expect((await getConnection(CLIENT))?.shop_domain).toBe(MOCK_SHOP.domain);
  });
});

describe("syncShopify", () => {
  it("writes per-variant sales and counts, with exactly one bulk operation and no catalogue query", async () => {
    installFetch();
    await connect();
    const { fn } = installFetch();
    const counts = await syncShopify(CLIENT, { now: NOW });
    expect(counts).toEqual({ orders: 1, sales_variants: 1, skipped_line_items: 1 });
    const sales = await loadSales(CLIENT);
    expect(sales).toEqual([
      {
        client_id: CLIENT,
        variant_key: "gid://shopify/ProductVariant/1",
        variant_gid: "gid://shopify/ProductVariant/1",
        product_gid: "gid://shopify/Product/1",
        product_title: "Stool",
        variant_title: "Oak",
        sku: "S1",
        vendor: "V",
        product_type: "Bar Stool",
        units_30d: 2,
        revenue_30d_cents: 2100,
        units_60d: 2,
        revenue_60d_cents: 2100,
      },
    ]);
    const graphql = fn.mock.calls
      .filter((c) => !String(c[0]).startsWith("https://files.example/"))
      .map((c) => JSON.parse(String(c[1]?.body)));
    const starts = graphql.filter((b) => b.query.includes("StartBulk"));
    expect(starts).toHaveLength(1);
    expect(starts[0].variables.query).toContain("orders(");
    expect(JSON.stringify(graphql)).not.toMatch(/products\s*[({]|ProductVariant\s*\{|collections/);
    // One orders download, nothing else.
    expect(fn.mock.calls.filter((c) => String(c[0]).startsWith("https://files.example/"))).toHaveLength(1);
    const row = await getConnection(CLIENT);
    expect(row?.last_sync_status).toBe("ok");
    expect(row?.last_sync_counts).toEqual({ orders: 1, sales_variants: 1, skipped_line_items: 1 });
    // No catalogue rows are written.
    const cat = await loadCatalog(CLIENT);
    expect(cat.products).toHaveLength(0);
    expect(cat.variants).toHaveLength(0);
  });

  it("an empty orders result is a valid sync with 0 sales variants, and clears old sales", async () => {
    installFetch();
    await connect();
    await syncShopify(CLIENT, { now: NOW });
    expect(await loadSales(CLIENT)).toHaveLength(1);
    installFetch({ orders: [] });
    await expect(syncShopify(CLIENT, { now: NOW })).resolves.toEqual({
      orders: 0,
      sales_variants: 0,
      skipped_line_items: 0,
    });
    expect(await loadSales(CLIENT)).toEqual([]);
    const row = await getConnection(CLIENT);
    expect(row?.last_sync_status).toBe("ok");
    expect(row?.last_sync_at).toBeTruthy();
  });

  it("asks for the 60-day window as a UTC ISO string", async () => {
    const { fn } = installFetch();
    await connect();
    await syncShopify(CLIENT, { now: NOW });
    const bodies = fn.mock.calls
      .map((c) => (c[1]?.body ? JSON.parse(String(c[1].body)) : null))
      .filter(Boolean);
    const orders = bodies.find((b) => b.variables?.query?.includes("orders("));
    expect(orders.variables.query).toContain(`created_at:>='2026-08-24T12:00:00.000Z'`);
  });

  it("keeps the previous sales when a bulk operation FAILED", async () => {
    installFetch();
    await connect();
    await syncShopify(CLIENT, { now: NOW });
    installFetch({ pollStatus: "FAILED" });
    await expect(syncShopify(CLIENT, { now: NOW })).rejects.toThrow();
    const row = await getConnection(CLIENT);
    expect(row?.last_sync_status).toBe("error");
    expect(row?.last_sync_error).toBeTruthy();
    expect(row?.last_sync_error).not.toContain(TOKEN);
    expect(await loadSales(CLIENT)).toHaveLength(1);
  });

  it("maps a 401 to the reconnect message", async () => {
    installFetch();
    await connect();
    installFetch({ status: 401 });
    await expect(syncShopify(CLIENT, { now: NOW })).rejects.toThrow("Shopify rejected the token: reconnect the store");
    expect((await getConnection(CLIENT))?.last_sync_error).toBe("Shopify rejected the token: reconnect the store");
  });

  it("maps a busy bulk slot to the busy message", async () => {
    installFetch();
    await connect();
    installFetch({
      startReply: {
        data: {
          bulkOperationRunQuery: {
            bulkOperation: null,
            userErrors: [{ message: "A bulk operation is already in progress", code: "OPERATION_IN_PROGRESS" }],
          },
        },
      },
    });
    await expect(syncShopify(CLIENT, { now: NOW })).rejects.toThrow("Shopify is busy, try again in a few minutes");
    expect((await getConnection(CLIENT))?.last_sync_error).toBe("Shopify is busy, try again in a few minutes");
  });

  it("maps a bulk operation ACCESS_DENIED (HTTP 200) to the access message", async () => {
    installFetch();
    await connect();
    installFetch({ pollStatus: "FAILED", pollErrorCode: "ACCESS_DENIED" });
    const access =
      "Shopify refused access to the store's orders or products. Check the app's read_products, read_inventory and read_orders access and its protected customer data settings.";
    await expect(syncShopify(CLIENT, { now: NOW })).rejects.toThrow(access);
    expect((await getConnection(CLIENT))?.last_sync_error).toBe(access);
    const log = warnCalls().find(([m]) => m === "Shopify sync failed")?.[1];
    expect(log).toMatchObject({ clientId: CLIENT, code: "ACCESS_DENIED", detail: "bulk operation FAILED, errorCode ACCESS_DENIED" });
  });

  it("logs the client and Shopify's userErrors (redacted), but stores only fixed text", async () => {
    installFetch();
    await connect();
    installFetch({
      startReply: {
        data: {
          bulkOperationRunQuery: {
            bulkOperation: null,
            userErrors: [{ field: ["query"], message: `Bulk queries cannot contain more than 1 top-level field ${TOKEN}`, code: "INVALID" }],
          },
        },
      },
    });
    await expect(syncShopify(CLIENT, { now: NOW })).rejects.toThrow();
    const stored = (await getConnection(CLIENT))?.last_sync_error ?? "";
    expect(stored).not.toContain("top-level");
    expect(stored).not.toContain(TOKEN);
    const log = warnCalls().find(([m]) => m === "Shopify sync failed")?.[1];
    expect(log).toMatchObject({ clientId: CLIENT, status: 200, code: "INVALID" });
    expect(String(log?.detail)).toContain("query: Bulk queries cannot contain more than 1 top-level field");
    expect(JSON.stringify(warnCalls())).not.toContain(TOKEN);
  });

  it("logs the stage and the text of a non-Shopify failure (token redacted), but stores only fixed text", async () => {
    installFetch();
    await connect();
    installFetch();
    // A failure that did not come from Shopify, thrown while the sales are being saved.
    const store = getDemoStore();
    const original = store.shopifySales;
    Object.defineProperty(store, "shopifySales", {
      configurable: true,
      get: () => original,
      set: () => {
        throw new Error(`column "price_cents" is broken ${TOKEN}`);
      },
    });
    try {
      await expect(syncShopify(CLIENT, { now: NOW })).rejects.toThrow(
        "The Shopify sync failed. Try again, and reconnect the store if it keeps failing.",
      );
    } finally {
      Object.defineProperty(store, "shopifySales", { configurable: true, writable: true, value: original });
    }
    const log = warnCalls().find(([m]) => m === "Shopify sync failed")?.[1];
    expect(log).toMatchObject({ clientId: CLIENT, stage: "saving", status: null, code: null });
    expect(String(log?.detail)).toContain('column "price_cents" is broken [redacted]');
    expect(JSON.stringify(warnCalls())).not.toContain(TOKEN);
    expect((await getConnection(CLIENT))?.last_sync_error).toBe(
      "The Shopify sync failed. Try again, and reconnect the store if it keeps failing.",
    );
  });

  it("never stores raw Shopify error text", async () => {
    installFetch();
    await connect();
    installFetch({
      startReply: { errors: [{ message: `weird raw body ${TOKEN}`, extensions: { code: "SOMETHING" } }] },
    });
    await expect(syncShopify(CLIENT, { now: NOW })).rejects.toThrow();
    const err = (await getConnection(CLIENT))?.last_sync_error ?? "";
    expect(err).toBeTruthy();
    expect(err).not.toContain("weird raw body");
    expect(err).not.toContain(TOKEN);
  });

  it("refuses to start while a recent sync is running, without touching its status", async () => {
    installFetch();
    await connect();
    await setSyncStatus(CLIENT, { status: "running" });
    const { fn } = installFetch();
    await expect(syncShopify(CLIENT)).rejects.toThrow("A sync is already running for this store");
    expect(fn).not.toHaveBeenCalled();
    expect((await getConnection(CLIENT))?.last_sync_status).toBe("running");
  });

  it("restarts a stale running sync (older than 15 minutes)", async () => {
    installFetch();
    await connect();
    await setSyncStatus(CLIENT, { status: "running" });
    getDemoStore().shopifyConnections[0].updated_at = new Date(Date.now() - 16 * 60_000).toISOString();
    await expect(syncShopify(CLIENT)).resolves.toBeDefined();
  });

  it("heartbeats before saving so a slow poll phase does not look stale", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-23T12:00:00.000Z"));
      installFetch();
      await connect();
      const { fn } = installFetch({
        onPoll: async () => {
          vi.setSystemTime(new Date(Date.now() + 9 * 60_000));
        },
      });
      await syncShopify(CLIENT);
      // One start, one poll and one download: the sync makes no other Shopify request.
      expect(fn).toHaveBeenCalledTimes(3);
      expect((await getConnection(CLIENT))?.last_sync_status).toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  });

  it("heartbeats on every bulk poll so a long orders phase is still refused at minute 17", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-23T12:00:00.000Z"));
      installFetch();
      await connect();
      let second: unknown = "not run";
      const heartbeatAtPoll: boolean[] = [];
      // A slow start (8 minutes), then polls 3 minutes apart: by the 3rd poll the run is 17
      // minutes old. Without poll heartbeats the last one would be at minute 0 (stale).
      installFetch({
        onStart: (kind) => {
          if (kind === "orders") vi.setSystemTime(new Date(Date.now() + 8 * 60_000));
        },
        pollStatusFor: (kind, n) => (kind === "orders" && n < 4 ? "RUNNING" : "COMPLETED"),
        onPoll: async (kind) => {
          if (kind !== "orders") return;
          // The heartbeat was written just before this poll.
          heartbeatAtPoll.push(getDemoStore().shopifyConnections[0].updated_at === new Date().toISOString());
          vi.setSystemTime(new Date(Date.now() + 3 * 60_000));
          if (heartbeatAtPoll.length === 3) second = await syncShopify(CLIENT).catch((e) => e);
        },
      });
      await syncShopify(CLIENT, { pollIntervalMs: 1 });
      expect(heartbeatAtPoll).toEqual([true, true, true, true]);
      expect(second).toBeInstanceOf(Error);
      expect((second as Error).message).toBe("A sync is already running for this store");
      expect((await getConnection(CLIENT))?.last_sync_status).toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  });

  it("demo mode syncs the mock sales with no network and no catalogue writes", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    resetConfigCache();
    const { fn } = installFetch();
    await connectShopify({
      clientId: CLIENT,
      shopDomain: MOCK_SHOP.domain,
      accessToken: "shpat_demo",
      connectedBy: "u1",
    });
    const counts = await syncShopify(CLIENT);
    expect(fn).not.toHaveBeenCalled();
    expect(counts).toEqual({ orders: MOCK_SALES_ORDERS, sales_variants: 8, skipped_line_items: 0 });
    expect(await loadSales(CLIENT)).toHaveLength(8);
    expect((await loadCatalog(CLIENT)).products).toHaveLength(0);
    expect((await getConnection(CLIENT))?.last_sync_counts).toEqual(counts);
  });

  it("fails clearly when the store is not connected", async () => {
    await expect(syncShopify(CLIENT)).rejects.toThrow(/no Shopify store/i);
  });
});

describe("getShopifyStatus / disconnect / syncAll", () => {
  it("never exposes the token or ciphertext", async () => {
    installFetch();
    await connect();
    await syncShopify(CLIENT, { now: NOW });
    const row = await getConnection(CLIENT);
    const status = await getShopifyStatus(CLIENT);
    const text = JSON.stringify(status);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("access_token_encrypted");
    expect(text).not.toContain(row!.access_token_encrypted);
    expect(status).toMatchObject({
      connected: true,
      shop_domain: SHOP,
      shop_name: "During Days",
      currency: "GBP",
      last_sync_status: "ok",
    });
    expect(status.counts).toEqual({ orders: 1, sales_variants: 1, skipped_line_items: 1 });
  });

  it("reports not connected", async () => {
    expect(await getShopifyStatus(CLIENT)).toMatchObject({
      connected: false,
      shop_domain: null,
      last_sync_status: "never",
      counts: null,
    });
  });

  it("disconnect removes the connection and data", async () => {
    installFetch();
    await connect();
    await syncShopify(CLIENT, { now: NOW });
    await disconnectShopify(CLIENT);
    expect(await getConnection(CLIENT)).toBeNull();
    expect(await loadSales(CLIENT)).toHaveLength(0);
  });

  it("syncAll continues past a failing store", async () => {
    installFetch();
    await connect();
    await connectShopify({ clientId: "client_b", shopDomain: SHOP, accessToken: TOKEN, connectedBy: "u1" });
    getDemoStore().shopifyConnections.find((c) => c.client_id === "client_b")!.access_token_encrypted = "garbage";
    const result = await syncAllShopify();
    expect(result).toEqual({ synced: 1, failed: 1 });
    const log = warnCalls().find(([m]) => m === "Shopify scheduled sync failed")?.[1];
    expect(log).toMatchObject({
      clientId: "client_b",
      message: "The Shopify sync failed. Try again, and reconnect the store if it keeps failing.",
    });
    expect(warnCalls().find(([m]) => m === "Shopify sync failed")?.[1]).toMatchObject({ clientId: "client_b" });
  });
});
