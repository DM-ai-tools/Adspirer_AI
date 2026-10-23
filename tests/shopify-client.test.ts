import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const warn = vi.fn();
vi.mock("@/lib/observability/logger", () => ({
  logger: { warn: (...a: unknown[]) => warn(...a), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { resetConfigCache } from "@/lib/config";
import { normalizeShopDomain, toCents } from "@/lib/shopify/domain";
import {
  DEFAULT_SHOPIFY_API_VERSION,
  SHOPIFY_READ_ONLY_MUTATIONS,
  ShopifyApiError,
  downloadJsonl,
  shopifyGraphql,
  startBulkQuery,
  waitForBulkQuery,
} from "@/lib/shopify/client";

const SHOP = "duringdays.myshopify.com";
const TOKEN = "shpat_SECRET_TOKEN_123";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  warn.mockClear();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("SHOPIFY_API_VERSION", "");
  resetConfigCache();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetConfigCache();
});

describe("normalizeShopDomain", () => {
  it("cleans scheme, case and path", () => {
    expect(normalizeShopDomain("https://DuringDays.myshopify.com/admin")).toBe(SHOP);
    expect(normalizeShopDomain("  duringdays.myshopify.com  ")).toBe(SHOP);
    expect(normalizeShopDomain("duringdays.myshopify.com?x=1")).toBe(SHOP);
  });
  it("refuses anything else", () => {
    for (const bad of [
      "duringdays.myshopify.com.evil.com",
      "evil.com",
      "https://evil.com",
      "",
      "a b.myshopify.com",
      ".myshopify.com",
      "-x.myshopify.com",
      "evil.com/duringdays.myshopify.com",
      "user@duringdays.myshopify.com",
      "duringdays.myshopify.com:8080",
      "http://duringdays.myshopify.com",
      "sub.duringdays.myshopify.com",
    ]) {
      expect(normalizeShopDomain(bad), bad).toBeNull();
    }
  });
});

describe("toCents", () => {
  it("uses string maths", () => {
    expect(toCents("19.99")).toBe(1999);
    expect(toCents("0.1")).toBe(10);
    expect(toCents("0")).toBe(0);
    expect(toCents("1.005")).toBe(101);
    expect(toCents("4.35")).toBe(435);
    expect(toCents("1234.5")).toBe(123450);
    expect(toCents(19.99)).toBe(1999);
    expect(toCents("-3.5")).toBe(-350);
  });
  it("rejects invalid input", () => {
    for (const bad of ["abc", "1,234.5", "", "1.2.3", "$5", null, undefined, NaN, Infinity]) {
      expect(toCents(bad as never), String(bad)).toBeNull();
    }
  });
});

describe("shopifyGraphql: store address", () => {
  it.each(["https://evil.com", "duringdays.myshopify.com.evil.com", "", "evil.com"])(
    "refuses %j before any request",
    async (shop) => {
      await expect(shopifyGraphql(shop, TOKEN, "{ shop { name } }")).rejects.toMatchObject({ code: "INVALID_SHOP" });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("posts to the versioned endpoint with the token in the header only", async () => {
    fetchMock.mockResolvedValue(json({ data: { shop: { name: "DD" } } }));
    const data = await shopifyGraphql<{ shop: { name: string } }>("DuringDays.MyShopify.com/admin", TOKEN, "{ shop { name } }");
    expect(data.shop.name).toBe("DD");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://${SHOP}/admin/api/${DEFAULT_SHOPIFY_API_VERSION}/graphql.json`);
    expect(init.headers["X-Shopify-Access-Token"]).toBe(TOKEN);
    expect(String(url)).not.toContain(TOKEN);
    expect(String(init.body)).not.toContain(TOKEN);
  });

  it("honours SHOPIFY_API_VERSION", async () => {
    vi.stubEnv("SHOPIFY_API_VERSION", "2026-07");
    resetConfigCache();
    fetchMock.mockImplementation(async () => json({ data: {} }));
    await shopifyGraphql(SHOP, TOKEN, "{ shop { name } }");
    expect(fetchMock.mock.calls[0][0]).toContain("/admin/api/2026-07/");
  });

  it("default version is a YYYY-MM string", () => {
    expect(DEFAULT_SHOPIFY_API_VERSION).toMatch(/^\d{4}-(01|04|07|10)$/);
  });
});

describe("shopifyGraphql: read-only guard", () => {
  const blocked = [
    "mutation { productDelete(input: { id: \"gid://x\" }) { deletedProductId } }",
    "mutation Foo { orderCancel(orderId: \"x\") { job { id } } }",
    "mutation { bulkOperationRunQuery(query: \"x\") { userErrors { message } } productDelete(input: {}) { deletedProductId } }",
    "mutation { a: productDelete(input: {}) { deletedProductId } }",
    "mutation { x: bulkOperationRunQuery(query: \"q\") { userErrors { message } } y: productDelete(input: {}) { id } }",
    "query { shop { name } } mutation { productDelete(input: {}) { id } }",
    "  # bulkOperationRunQuery\n mutation { productDelete(input: {}) { id } }",
    "mutation { ...F } fragment F on Mutation { productDelete(input: {}) { id } }",
    "subscription { foo }",
    // Quotes inside comments must not pair up and hide real code.
    '# "\nmutation\n# "\n{ productDelete(input: {id: "gid://shopify/Product/1"}) { deletedProductId } }',
    '# """\nmutation\n# """\n{ productDelete(input: {id: "x"}) { deletedProductId } }',
    '{ a(q: """x \\""" y""") { id } }\n# "\nmutation\n# "\n{ productDelete(input: {}) { id } }',
    'query { a(q: """ \\""" """) { id } } mutation { productDelete(input: {}) { id } }',
    'mutation { productDelete(input: {id: "unterminated}) { id } }',
    'query { a(q: "line\nbreak") { id } }',
    'query { a(q: """never closed) { id } }',
    "mutation",
    "",
    "just text",
  ];
  it.each(blocked)("refuses %j without calling fetch", async (doc) => {
    await expect(shopifyGraphql(SHOP, TOKEN, doc)).rejects.toMatchObject({ code: "READ_ONLY" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows queries, including words like mutation in strings and comments", async () => {
    fetchMock.mockImplementation(async () => json({ data: {} }));
    await shopifyGraphql(SHOP, TOKEN, '{ products(first: 1, query: "mutation { productDelete }") { nodes { id } } }');
    await shopifyGraphql(SHOP, TOKEN, "# mutation\nquery Q($id: ID!) { node(id: $id) { id } }", { id: "x" });
    await shopifyGraphql(SHOP, TOKEN, '# say "hi\nquery Q2 { shop { name } } # "bye');
    await shopifyGraphql(SHOP, TOKEN, '{ a(q: """ok \\""" still""") { id } }');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("allows the bulkOperationRunQuery mutation only", async () => {
    expect(SHOPIFY_READ_ONLY_MUTATIONS).toEqual(["bulkOperationRunQuery"]);
    fetchMock.mockImplementation(async () => json({ data: {} }));
    await shopifyGraphql(
      SHOP,
      TOKEN,
      'mutation { bulkOperationRunQuery(query: "{ products { edges { node { id } } } }") { bulkOperation { id } userErrors { message } } }',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("shopifyGraphql: retries and errors", () => {
  it("retries a 429 then succeeds", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(new Response("slow down", { status: 429 })).mockResolvedValueOnce(json({ data: { ok: 1 } }));
    const p = shopifyGraphql(SHOP, TOKEN, "{ shop { name } }");
    await vi.runAllTimersAsync();
    await expect(p).resolves.toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a THROTTLED body then succeeds", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(json({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] }))
      .mockResolvedValueOnce(json({ data: { ok: 2 } }));
    const p = shopifyGraphql(SHOP, TOKEN, "{ shop { name } }");
    await vi.runAllTimersAsync();
    await expect(p).resolves.toEqual({ ok: 2 });
  });

  it("throws after THROTTLED retries run out", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => json({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] }));
    const p = shopifyGraphql(SHOP, TOKEN, "{ shop { name } }");
    const assertion = expect(p).rejects.toMatchObject({ code: "THROTTLED" });
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("401 says reconnect, never contains the token, and logs status and code only", async () => {
    fetchMock.mockResolvedValue(new Response(`bad token ${TOKEN}`, { status: 401 }));
    const err = (await shopifyGraphql(SHOP, TOKEN, "{ shop { name } }").catch((e: ShopifyApiError) => e)) as ShopifyApiError;
    expect(err).toBeInstanceOf(ShopifyApiError);
    expect(err.status).toBe(401);
    expect(err.code).toBe("UNAUTHORIZED");
    expect(err.message).toMatch(/reconnect/i);
    expect(`${err.message} ${err.stack}`).not.toContain(TOKEN);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
    expect(warn).toHaveBeenCalledWith(expect.any(String), { status: 401, code: "UNAUTHORIZED" });
  });

  it("scrubs the token from GraphQL error messages and logs", async () => {
    fetchMock.mockResolvedValue(json({ errors: [{ message: `Invalid ${TOKEN} here`, extensions: { code: "ACCESS_DENIED" } }] }));
    const err = (await shopifyGraphql(SHOP, TOKEN, "{ shop { name } }").catch((e: ShopifyApiError) => e)) as ShopifyApiError;
    expect(err.code).toBe("ACCESS_DENIED");
    expect(err.message).not.toContain(TOKEN);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
  });

  it("network failure message does not contain the token", async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValue(new Error(`connect failed for ${TOKEN}`));
    const p = shopifyGraphql(SHOP, TOKEN, "{ shop { name } }");
    const assertion = p.catch((e: ShopifyApiError) => e);
    await vi.runAllTimersAsync();
    const err = (await assertion) as ShopifyApiError;
    expect(err).toBeInstanceOf(ShopifyApiError);
    expect(`${err.message} ${err.stack}`).not.toContain(TOKEN);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
  });
});

describe("bulk operations", () => {
  it("startBulkQuery returns the gid and passes the inner query as a variable", async () => {
    fetchMock.mockResolvedValue(
      json({ data: { bulkOperationRunQuery: { bulkOperation: { id: "gid://shopify/BulkOperation/1", status: "CREATED" }, userErrors: [] } } }),
    );
    const id = await startBulkQuery(SHOP, TOKEN, "{ products { edges { node { id } } } }");
    expect(id).toBe("gid://shopify/BulkOperation/1");
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body.variables.query).toContain("products");
  });

  it("startBulkQuery reports an already-running operation clearly", async () => {
    fetchMock.mockResolvedValue(
      json({
        data: {
          bulkOperationRunQuery: {
            bulkOperation: null,
            userErrors: [{ field: null, message: "A bulk query operation for this app and shop is already in progress: gid://x.", code: null }],
          },
        },
      }),
    );
    await expect(startBulkQuery(SHOP, TOKEN, "{ x }")).rejects.toMatchObject({ code: "BULK_OPERATION_RUNNING" });
  });

  const node = (n: object) => json({ data: { node: n } });

  it("waitForBulkQuery resolves on COMPLETED after polling", async () => {
    fetchMock
      .mockResolvedValueOnce(node({ status: "RUNNING" }))
      .mockResolvedValueOnce(node({ status: "COMPLETED", url: "https://storage.example/x.jsonl", objectCount: "42" }));
    await expect(waitForBulkQuery(SHOP, TOKEN, "gid://x", { intervalMs: 1, timeoutMs: 1000 })).resolves.toEqual({
      url: "https://storage.example/x.jsonl",
      objectCount: 42,
    });
  });

  it("waitForBulkQuery gives a null url for an empty result", async () => {
    fetchMock.mockResolvedValue(node({ status: "COMPLETED", url: null, objectCount: "0" }));
    await expect(waitForBulkQuery(SHOP, TOKEN, "gid://x", { intervalMs: 1 })).resolves.toEqual({ url: null, objectCount: 0 });
  });

  it.each(["FAILED", "EXPIRED"])("waitForBulkQuery throws on %s with Shopify's errorCode", async (status) => {
    fetchMock.mockResolvedValue(node({ status, errorCode: "ACCESS_DENIED" }));
    const err = (await waitForBulkQuery(SHOP, TOKEN, "gid://x", { intervalMs: 1 }).catch((e: ShopifyApiError) => e)) as ShopifyApiError;
    expect(err).toBeInstanceOf(ShopifyApiError);
    expect(err.message).toContain("ACCESS_DENIED");
    expect(err.code).toBe("ACCESS_DENIED");
  });

  it("waitForBulkQuery times out cleanly", async () => {
    fetchMock.mockImplementation(async () => node({ status: "RUNNING" }));
    await expect(waitForBulkQuery(SHOP, TOKEN, "gid://x", { intervalMs: 5, timeoutMs: 30 })).rejects.toMatchObject({
      code: "BULK_TIMEOUT",
    });
  });

  it("downloadJsonl parses lines and refuses non-https links", async () => {
    fetchMock.mockResolvedValue(new Response('{"id":"a"}\n{"id":"b","__parentId":"a"}\n\n'));
    await expect(downloadJsonl("https://storage.example/x.jsonl")).resolves.toEqual([{ id: "a" }, { id: "b", __parentId: "a" }]);
    expect(fetchMock.mock.calls[0][1].headers).toBeUndefined();
    fetchMock.mockClear();
    await expect(downloadJsonl("http://storage.example/x.jsonl")).rejects.toMatchObject({ code: "INVALID_URL" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
