import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/observability/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { resetConfigCache } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { logger } from "@/lib/observability/logger";
import { getConnection, loadSales } from "@/lib/shopify/store";
import { MAX_BULK_OBJECTS, connectShopify, syncShopify } from "@/lib/shopify/sync";

const CLIENT = "client_clicktrends";
const SHOP = "duringdays.myshopify.com";
const TOKEN = "shpat_SECRET_TOKEN_123";
const NOW = new Date("2026-10-23T12:00:00.000Z");

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Line = Record<string, unknown>;

/** Lazily generated orders, each with two line items over `variants` distinct variants. */
function* orderLines(orders: number, variants = 300): Generator<Line> {
  for (let o = 0; o < orders; o += 1) {
    yield { id: `gid://shopify/Order/${o}`, createdAt: "2026-10-20T10:00:00Z", cancelledAt: null, test: false };
    for (let k = 0; k < 2; k += 1) {
      yield {
        id: `gid://shopify/LineItem/${o}-${k}`,
        __parentId: `gid://shopify/Order/${o}`,
        quantity: 1,
        title: "T",
        variant: { id: `gid://shopify/ProductVariant/${(o * 2 + k) % variants}` },
        product: { id: "gid://shopify/Product/1", productType: "" },
        discountedTotalSet: { shopMoney: { amount: "10.00" } },
      };
    }
  }
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
  orders?: () => Response;
  objectCount?: () => string;
};

function installFetch(o: Opts = {}) {
  const downloads: string[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("https://files.example/")) {
      downloads.push(url);
      return o.orders?.() ?? streamed(orderLines(1), 1);
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
      return json({
        data: {
          bulkOperationRunQuery: {
            bulkOperation: { id: "gid://shopify/BulkOperation/orders", status: "CREATED" },
            userErrors: [],
          },
        },
      });
    }
    if (q.includes("PollBulk")) {
      return json({
        data: {
          node: {
            id: body.variables.id,
            status: "COMPLETED",
            errorCode: null,
            objectCount: o.objectCount?.() ?? "3",
            url: "https://files.example/orders",
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

describe("syncShopify: streamed orders result", () => {
  it("consumes a large orders stream incrementally and never reads a whole body", async () => {
    const responses: Response[] = [];
    installFetch({
      orders: () => {
        const r = streamed(orderLines(20_000, 1_200), 500);
        responses.push(r);
        return r;
      },
    });
    await connect();
    const counts = await syncShopify(CLIENT, { now: NOW });
    expect(counts).toEqual({ orders: 20_000, sales_variants: 1_200, skipped_line_items: 0 });
    for (const r of responses) {
      expect(r.text).not.toHaveBeenCalled();
      expect(r.json).not.toHaveBeenCalled();
      expect(r.arrayBuffer).not.toHaveBeenCalled();
    }
    const sales = await loadSales(CLIENT);
    expect(sales).toHaveLength(1_200);
    expect(sales.reduce((n, r) => n + r.units_60d, 0)).toBe(40_000);
  });

  it("logs counts for the orders bulk read at info level, with no token or data", async () => {
    installFetch();
    await connect();
    await syncShopify(CLIENT, { now: NOW });
    const reads = infoCalls()
      .filter(([m]) => m === "Shopify bulk read complete")
      .map(([, ctx]) => ctx);
    expect(reads).toHaveLength(1);
    expect(reads[0]).toEqual({
      clientId: CLIENT,
      stage: "orders bulk read",
      objectCount: 3,
      bytes: expect.any(Number),
      lines: 3,
      ms: expect.any(Number),
    });
    expect(JSON.stringify(infoCalls())).not.toContain(TOKEN);
    expect(JSON.stringify(infoCalls())).not.toContain("ProductVariant");
  });

  it("refuses an orders result over MAX_BULK_OBJECTS before downloading, and keeps old sales", async () => {
    installFetch();
    await connect();
    await syncShopify(CLIENT, { now: NOW });
    const { downloads } = installFetch({ objectCount: () => String(MAX_BULK_OBJECTS + 5) });
    const message = "This store has too many recent orders to sync (3,000,005 records). Contact support.";
    await expect(syncShopify(CLIENT, { now: NOW })).rejects.toThrow(message);
    expect(downloads).toEqual([]);
    const row = await getConnection(CLIENT);
    expect(row?.last_sync_status).toBe("error");
    expect(row?.last_sync_error).toBe(message);
    expect(await loadSales(CLIENT)).toHaveLength(2);
    const tooLarge = warnCalls().find(([m]) => m === "Shopify bulk result too large")?.[1];
    expect(tooLarge).toEqual({ clientId: CLIENT, stage: "orders bulk read", objectCount: MAX_BULK_OBJECTS + 5 });
    const failed = warnCalls().find(([m]) => m === "Shopify sync failed")?.[1];
    expect(failed).toMatchObject({ clientId: CLIENT, stage: "orders bulk read", objectCount: MAX_BULK_OBJECTS + 5 });
    expect(JSON.stringify(warnCalls())).not.toContain(TOKEN);
  });

  it("maps bad JSON Lines in the stream to the generic message and logs the stage", async () => {
    installFetch();
    await connect();
    installFetch({ orders: () => new Response('{"id":"gid://shopify/Order/1"}\n{oops\n') });
    await expect(syncShopify(CLIENT, { now: NOW })).rejects.toThrow(
      "The Shopify sync failed. Try again, and reconnect the store if it keeps failing.",
    );
    expect(warnCalls().find(([m]) => m === "Shopify sync failed")?.[1]).toMatchObject({
      stage: "orders bulk read",
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
      orders: () =>
        streamed(orderLines(4_000), 1_000, async (n) => {
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
    // ~1 heartbeat per chunk (13) plus the status/poll/save writes: far fewer than 12,000 lines.
    expect(writes.count()).toBeGreaterThanOrEqual(12);
    expect(writes.count()).toBeLessThan(30);
    expect((await getConnection(CLIENT))?.last_sync_status).toBe("ok");
  });

  it("heartbeat interval is configurable", async () => {
    installFetch();
    await connect();
    installFetch({ orders: () => streamed(orderLines(100), 10) });
    const writes = countRowWrites();
    await syncShopify(CLIENT, { now: NOW, heartbeatIntervalMs: 0 });
    // A heartbeat after every one of the 300 lines.
    expect(writes.count()).toBeGreaterThanOrEqual(300);
  });

  it("heartbeats between save chunks: 3 chunks of sales write 2 more heartbeats than 1 chunk", async () => {
    installFetch();
    await connect();
    const run = async (orders: number, variants: number) => {
      installFetch({ orders: () => streamed(orderLines(orders, variants), 1_000) });
      const writes = countRowWrites();
      await syncShopify(CLIENT, { now: NOW, heartbeatIntervalMs: 3_600_000 });
      return writes.count();
    };
    const small = await run(2, 3);
    // Stream heartbeats are off (huge interval); only the save chunks differ.
    const large = await run(601, 1_201);
    expect(large - small).toBe(2);
  });
});
