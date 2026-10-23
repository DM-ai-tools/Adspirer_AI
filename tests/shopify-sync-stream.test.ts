import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/observability/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { resetConfigCache } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { logger } from "@/lib/observability/logger";
import { getConnection, loadCatalog } from "@/lib/shopify/store";
import { MAX_BULK_OBJECTS, connectShopify, syncShopify } from "@/lib/shopify/sync";

const CLIENT = "client_clicktrends";
const SHOP = "duringdays.myshopify.com";
const TOKEN = "shpat_SECRET_TOKEN_123";
const NOW = new Date("2026-10-23T12:00:00.000Z");

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Line = Record<string, unknown>;

/** A lazily generated catalogue: each product followed by its variants. */
function* catalogLines(products: number, variantsPer: number): Generator<Line> {
  for (let p = 0; p < products; p += 1) {
    const pid = `gid://shopify/Product/${p}`;
    yield { id: pid, title: `P${p}`, handle: `p-${p}`, vendor: "V", productType: "T", status: "ACTIVE" };
    if (p % 10 === 0) yield { id: "gid://shopify/Collection/1", handle: "c", title: "C", __parentId: pid };
    for (let v = 0; v < variantsPer; v += 1) {
      yield {
        id: `gid://shopify/ProductVariant/${p}-${v}`,
        __parentId: pid,
        title: `V${v}`,
        sku: null,
        price: "10.00",
        inventoryPolicy: "DENY",
        inventoryQuantity: 1,
        inventoryItem: { tracked: true, unitCost: null },
      };
    }
  }
}

function* orderLines(): Generator<Line> {
  yield { id: "gid://shopify/Order/1", createdAt: "2026-10-20T10:00:00Z", cancelledAt: null, test: false };
  yield {
    id: "gid://shopify/LineItem/1",
    __parentId: "gid://shopify/Order/1",
    quantity: 2,
    variant: { id: "gid://shopify/ProductVariant/0-0" },
    discountedTotalSet: { shopMoney: { amount: "21.00" } },
  };
}

/**
 * A streamed body, `linesPerChunk` JSON lines per pull, generated on demand. `onChunk` runs
 * before each chunk is handed over. Whole-body readers throw.
 */
function streamed(lines: Iterable<Line>, linesPerChunk: number, onChunk?: (n: number) => void | Promise<void>) {
  const it = lines[Symbol.iterator]();
  const enc = new TextEncoder();
  let n = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        let text = "";
        for (let k = 0; k < linesPerChunk; k += 1) {
          const next = it.next();
          if (next.done) break;
          text += `${JSON.stringify(next.value)}\n`;
        }
        if (!text) {
          controller.close();
          return;
        }
        n += 1;
        await onChunk?.(n);
        controller.enqueue(enc.encode(text));
      },
    },
    { highWaterMark: 0 },
  );
  const res = new Response(body);
  const forbid = () => {
    throw new Error("whole-body read");
  };
  Object.assign(res, { text: vi.fn(forbid), json: vi.fn(forbid), arrayBuffer: vi.fn(forbid), blob: vi.fn(forbid) });
  return res;
}

type Opts = {
  catalog?: () => Response;
  orders?: () => Response;
  objectCount?: (kind: string) => string;
};

function installFetch(o: Opts = {}) {
  const downloads: string[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("https://files.example/")) {
      const kind = url.endsWith("catalog") ? "catalog" : "orders";
      downloads.push(kind);
      if (kind === "catalog") return o.catalog?.() ?? streamed(catalogLines(2, 2), 3);
      return o.orders?.() ?? streamed(orderLines(), 1);
    }
    const body = JSON.parse(String(init?.body));
    const q: string = body.query;
    if (q.includes("currentAppInstallation")) {
      return json({
        data: {
          shop: { name: "During Days", currencyCode: "GBP" },
          currentAppInstallation: {
            accessScopes: ["read_products", "read_inventory", "read_orders"].map((handle) => ({ handle })),
          },
        },
      });
    }
    if (q.includes("StartBulk")) {
      const kind = String(body.variables.query).includes("orders(") ? "orders" : "catalog";
      return json({
        data: { bulkOperationRunQuery: { bulkOperation: { id: `gid://shopify/BulkOperation/${kind}`, status: "CREATED" }, userErrors: [] } },
      });
    }
    if (q.includes("PollBulk")) {
      const kind = String(body.variables.id).endsWith("orders") ? "orders" : "catalog";
      return json({
        data: {
          node: {
            id: body.variables.id,
            status: "COMPLETED",
            errorCode: null,
            objectCount: o.objectCount?.(kind) ?? "7",
            url: `https://files.example/${kind}`,
          },
        },
      });
    }
    return json({ data: {} });
  });
  vi.stubGlobal("fetch", fn);
  return { fn, downloads };
}

const connect = () => connectShopify({ clientId: CLIENT, shopDomain: SHOP, accessToken: TOKEN, connectedBy: "u1" });
const infoCalls = () => vi.mocked(logger.info).mock.calls as Array<[string, Record<string, unknown>?]>;
const warnCalls = () => vi.mocked(logger.warn).mock.calls as Array<[string, Record<string, unknown>?]>;

/** Counts status writes to the connection row (each heartbeat writes last_sync_status once). */
function countRowWrites(): { count: () => number } {
  const row = getDemoStore().shopifyConnections.find((c) => c.client_id === CLIENT)!;
  let value = row.last_sync_status;
  let writes = 0;
  Object.defineProperty(row, "last_sync_status", {
    configurable: true,
    enumerable: true,
    get: () => value,
    set: (v: typeof value) => {
      writes += 1;
      value = v;
    },
  });
  return { count: () => writes };
}

beforeEach(() => {
  vi.mocked(logger.warn).mockClear();
  vi.mocked(logger.info).mockClear();
  vi.stubEnv("DEMO_MODE", "false");
  resetConfigCache();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetConfigCache();
});

describe("syncShopify: streamed bulk results", () => {
  it("consumes a large catalogue stream incrementally and never reads a whole body", async () => {
    const responses: Response[] = [];
    installFetch({
      catalog: () => {
        const r = streamed(catalogLines(20_000, 3), 500);
        responses.push(r);
        return r;
      },
      orders: () => {
        const r = streamed(orderLines(), 1);
        responses.push(r);
        return r;
      },
    });
    await connect();
    const counts = await syncShopify(CLIENT, { now: NOW });
    expect(counts).toEqual({ collections: 1, products: 20_000, variants: 60_000, orders: 1, skipped_line_items: 0 });
    for (const r of responses) {
      expect(r.text).not.toHaveBeenCalled();
      expect(r.json).not.toHaveBeenCalled();
      expect(r.arrayBuffer).not.toHaveBeenCalled();
    }
    const cat = await loadCatalog(CLIENT);
    expect(cat.variants.find((v) => v.gid === "gid://shopify/ProductVariant/0-0")).toMatchObject({
      units_30d: 2,
      revenue_30d_cents: 2100,
    });
    expect(cat.collections[0]).toMatchObject({ products_count: 2000 });
  });

  it("logs counts for each bulk read at info level, with no token or data", async () => {
    installFetch();
    await connect();
    await syncShopify(CLIENT, { now: NOW });
    const reads = infoCalls().filter(([m]) => m === "Shopify bulk read complete").map(([, ctx]) => ctx);
    expect(reads).toHaveLength(2);
    expect(reads[0]).toEqual({
      clientId: CLIENT,
      stage: "catalogue bulk read",
      objectCount: 7,
      bytes: expect.any(Number),
      lines: 7,
      ms: expect.any(Number),
    });
    expect(reads[0]?.bytes).toBeGreaterThan(0);
    expect(reads[1]).toMatchObject({ clientId: CLIENT, stage: "orders bulk read", lines: 2 });
    expect(JSON.stringify(infoCalls())).not.toContain(TOKEN);
    expect(JSON.stringify(infoCalls())).not.toContain("ProductVariant");
  });

  it("refuses a catalogue over MAX_BULK_OBJECTS before downloading anything", async () => {
    installFetch();
    await connect();
    const { downloads, fn } = installFetch({ objectCount: (kind) => (kind === "catalog" ? String(MAX_BULK_OBJECTS + 1) : "1") });
    const message = "This store's catalogue is too large to sync (3,000,001 records). Contact support.";
    await expect(syncShopify(CLIENT, { now: NOW })).rejects.toThrow(message);
    expect(downloads).toEqual([]);
    // No orders bulk operation was started either.
    expect(fn.mock.calls.some((c) => String(c[1]?.body ?? "").includes("orders("))).toBe(false);
    const row = await getConnection(CLIENT);
    expect(row?.last_sync_status).toBe("error");
    expect(row?.last_sync_error).toBe(message);
    const tooLarge = warnCalls().find(([m]) => m === "Shopify bulk result too large")?.[1];
    expect(tooLarge).toEqual({ clientId: CLIENT, stage: "catalogue bulk read", objectCount: MAX_BULK_OBJECTS + 1 });
    const failed = warnCalls().find(([m]) => m === "Shopify sync failed")?.[1];
    expect(failed).toMatchObject({ clientId: CLIENT, stage: "catalogue bulk read", objectCount: MAX_BULK_OBJECTS + 1 });
    expect(JSON.stringify(warnCalls())).not.toContain(TOKEN);
  });

  it("refuses an orders result over MAX_BULK_OBJECTS with its own message", async () => {
    installFetch();
    await connect();
    const { downloads } = installFetch({ objectCount: (kind) => (kind === "orders" ? String(MAX_BULK_OBJECTS + 5) : "7") });
    await expect(syncShopify(CLIENT, { now: NOW })).rejects.toThrow(
      "This store has too many recent orders to sync (3,000,005 records). Contact support.",
    );
    expect(downloads).toEqual(["catalog"]);
  });

  it("maps bad JSON Lines in the stream to the generic message and logs the stage", async () => {
    installFetch();
    await connect();
    installFetch({ catalog: () => new Response('{"id":"gid://shopify/Product/1"}\n{oops\n') });
    await expect(syncShopify(CLIENT, { now: NOW })).rejects.toThrow(
      "The Shopify sync failed. Try again, and reconnect the store if it keeps failing.",
    );
    expect(warnCalls().find(([m]) => m === "Shopify sync failed")?.[1]).toMatchObject({
      stage: "catalogue bulk read",
      code: "BAD_JSONL",
    });
  });

  it("heartbeats while a long download streams, but not on every line", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    installFetch();
    await connect();
    let second: unknown = "not run";
    installFetch({
      // 13 chunks of 1,000 lines, each arriving 2 minutes after the last: a 26-minute download.
      catalog: () =>
        streamed(catalogLines(3_000, 3), 1_000, async (n) => {
          vi.setSystemTime(new Date(Date.now() + 2 * 60_000));
          // Minute 20: the run started 20 minutes ago with no poll since, so only stream
          // heartbeats keep it live.
          if (n === 10 && second === "not run") {
            second = "running";
            second = await syncShopify(CLIENT).catch((e) => e);
          }
        }),
    });
    const writes = countRowWrites();
    await syncShopify(CLIENT, { now: NOW });
    expect(second).toBeInstanceOf(Error);
    expect((second as Error).message).toBe("A sync is already running for this store");
    // ~1 heartbeat per chunk (13) plus the status/poll/phase writes: far fewer than 12,000 lines.
    expect(writes.count()).toBeGreaterThanOrEqual(12);
    expect(writes.count()).toBeLessThan(30);
    expect((await getConnection(CLIENT))?.last_sync_status).toBe("ok");
  });

  it("heartbeat interval is configurable", async () => {
    installFetch();
    await connect();
    installFetch({ catalog: () => streamed(catalogLines(100, 4), 10) });
    const writes = countRowWrites();
    await syncShopify(CLIENT, { now: NOW, heartbeatIntervalMs: 0 });
    // A heartbeat after every line (100 products x 5 lines + 10 collection lines + 2 order lines).
    expect(writes.count()).toBeGreaterThanOrEqual(512);
  });
});
