import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/observability/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { resetConfigCache } from "@/lib/config";
import { logger } from "@/lib/observability/logger";
import { encryptToken } from "@/lib/security/token-vault";
import {
  LIVE_DEFAULT_LIMIT,
  LIVE_MAX_LIMIT,
  LiveShopifyError,
  SHOPIFY_MAX_QUERY_COST,
  escapeShopifySearch,
  liveFindProducts,
  liveLookupVariants,
  productsQueryCost,
  variantsQueryCost,
} from "@/lib/shopify/live";
import { MOCK_SHOP } from "@/lib/shopify/mock";
import { getConnection, saveConnection } from "@/lib/shopify/store";

const CLIENT = "client_clicktrends";
const SHOP = "duringdays.myshopify.com";
const TOKEN = "shpat_SECRET_TOKEN_123";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Body = { query: string; variables: Record<string, unknown> };

const productNode = (o: {
  title: string;
  vendor?: string;
  count?: number;
  min?: string;
  max?: string;
  variants?: Array<{ q: number | null; policy?: "DENY" | "CONTINUE"; tracked?: boolean }>;
}) => ({
  title: o.title,
  handle: o.title.toLowerCase().replace(/\s+/g, "-"),
  vendor: o.vendor ?? "Nordic Woodworks",
  productType: "Bar Stool",
  status: "ACTIVE",
  variantsCount: { count: o.count ?? (o.variants ?? []).length },
  priceRangeV2: { minVariantPrice: { amount: o.min ?? "149.0" }, maxVariantPrice: { amount: o.max ?? "159.00" } },
  variants: {
    nodes: (o.variants ?? []).map((v) => ({
      inventoryQuantity: v.q,
      inventoryPolicy: v.policy ?? "DENY",
      inventoryItem: { tracked: v.tracked ?? true },
    })),
  },
});

const productsReply = (nodes: unknown[], hasNextPage = false) =>
  json({ data: { products: { pageInfo: { hasNextPage }, nodes } } });

const variantNode = (o: {
  sku: string | null;
  price?: string;
  cost?: string | null;
  q?: number | null;
  policy?: "DENY" | "CONTINUE";
  tracked?: boolean;
  withCost?: boolean;
}) => ({
  title: "Oak / 65cm",
  sku: o.sku,
  price: o.price ?? "149.00",
  inventoryQuantity: o.q === undefined ? 5 : o.q,
  inventoryPolicy: o.policy ?? "DENY",
  product: { title: "Oak Counter Stool", vendor: "Nordic Woodworks" },
  inventoryItem:
    o.withCost === false
      ? { tracked: o.tracked ?? true }
      : { tracked: o.tracked ?? true, unitCost: o.cost === null ? null : { amount: o.cost ?? "62.00" } },
});

const variantsReply = (nodes: unknown[], hasNextPage = false) =>
  json({ data: { productVariants: { pageInfo: { hasNextPage }, nodes } } });

/** Routes by operation name; records every GraphQL body sent. */
function installFetch(routes: {
  collections?: () => Response | Promise<Response>;
  products?: () => Response | Promise<Response>;
  variants?: (body: Body) => Response | Promise<Response>;
}) {
  const bodies: Body[] = [];
  const fn = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Body;
    bodies.push(body);
    if (body.query.includes("LiveCollections") && routes.collections) return routes.collections();
    if (body.query.includes("LiveProducts") && routes.products) return routes.products();
    if (body.query.includes("LiveVariants") && routes.variants) return routes.variants(body);
    return json({ errors: [{ message: "unexpected", extensions: { code: "UNEXPECTED" } }] });
  });
  vi.stubGlobal("fetch", fn);
  return { fn, bodies };
}

async function connect() {
  await saveConnection({
    clientId: CLIENT,
    shopDomain: SHOP,
    shopName: "During Days",
    currency: "GBP",
    scopes: ["read_products", "read_inventory", "read_orders"],
    accessTokenEncrypted: encryptToken(TOKEN),
    connectedBy: "u1",
  });
}

const warnCalls = () => vi.mocked(logger.warn).mock.calls as Array<[string, Record<string, unknown>?]>;

/**
 * Filter names that sit outside quotes in a Shopify search string. A backslash escapes the
 * next character, and a double quote opens or closes a phrase.
 */
function unquotedFilters(search: string): string[] {
  const names: string[] = [];
  let inQuote = false;
  let word = "";
  for (let i = 0; i < search.length; i += 1) {
    const ch = search[i];
    if (ch === "\\") {
      i += 1;
      word = "";
      continue;
    }
    if (ch === '"') {
      inQuote = !inQuote;
      word = "";
      continue;
    }
    if (inQuote) continue;
    if (ch === ":") {
      if (word) names.push(word);
      word = "";
    } else if (/[A-Za-z0-9_]/.test(ch)) word += ch;
    else word = "";
  }
  expect(inQuote, `unbalanced quotes in ${search}`).toBe(false);
  return names;
}

/** Words outside quotes that Shopify reads as operators. */
function unquotedOperators(search: string): string[] {
  const outside = search.replace(/\\./g, "").replace(/"[^"]*"/g, " ");
  return outside.split(/\s+/).filter((w) => ["OR", "AND", "NOT"].includes(w) || w.startsWith("-") || w.includes("("));
}

/**
 * Independent cost estimate of a GraphQL document, from Shopify's documented rules
 * (shopify.dev rate limits: scalar 0, enum 0, object 1, connection sized by `first`;
 * Shopify Engineering: a connection costs two plus the objects it returns). `nodes` inside a
 * connection is multiplied by `first`; other selections (pageInfo) count once.
 */
function estimateCost(document: string, variables: Record<string, unknown>): number {
  const body = document.slice(document.indexOf("{"));
  const tokens = body.match(/\$?[A-Za-z_][A-Za-z0-9_]*|[{}():]|"(?:\\.|[^"\\])*"|-?\d+/g) ?? [];
  let i = 0;
  type Field = { name: string; first: number | null; children: Field[] | null };
  function parseSelection(): Field[] {
    const out: Field[] = [];
    expect(tokens[i++]).toBe("{");
    while (tokens[i] !== "}") {
      const name = tokens[i++];
      let first: number | null = null;
      if (tokens[i] === "(") {
        i += 1;
        while (tokens[i] !== ")") {
          const arg = tokens[i++];
          expect(tokens[i++]).toBe(":");
          const value = tokens[i++];
          if (arg === "first") first = value.startsWith("$") ? Number(variables[value.slice(1)]) : Number(value);
        }
        i += 1;
      }
      const children = tokens[i] === "{" ? parseSelection() : null;
      out.push({ name, first, children });
    }
    i += 1;
    return out;
  }
  const cost = (f: Field, multiplier: number): number => {
    if (!f.children) return 0;
    if (f.first !== null) {
      return multiplier * (2 + f.children.reduce((s, c) => s + (c.name === "nodes" ? f.first! * selCost(c) : cost(c, 1)), 0));
    }
    return multiplier * selCost(f);
  };
  const selCost = (f: Field): number => 1 + (f.children ?? []).reduce((s, c) => s + cost(c, 1), 0);
  const root = parseSelection();
  return root.reduce((s, f) => s + cost(f, 1), 0);
}

beforeEach(() => {
  vi.mocked(logger.warn).mockClear();
  vi.stubEnv("DEMO_MODE", "false");
  resetConfigCache();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetConfigCache();
});

/** Free-text output must be plain words (optionally one trailing `*`): nothing else survives. */
function expectSafeTerms(out: string, input: string) {
  expect(unquotedFilters(out), input).toEqual([]);
  expect(unquotedOperators(out), input).toEqual([]);
  expect(out, input).not.toMatch(/["\\:()'`]/);
  for (const word of out.split(" ").filter(Boolean)) {
    expect(word, input).toMatch(/^[\p{L}\p{N}\p{M}._][\p{L}\p{N}\p{M}._-]*\*?$/u);
    expect(["OR", "AND", "NOT"], input).not.toContain(word.replace(/\*$/, ""));
  }
  expect((out.match(/\*/g) ?? []).length, input).toBeLessThanOrEqual(1);
}

describe("escapeShopifySearch", () => {
  it("sends one AND term per word, with a prefix wildcard on the last word", () => {
    expect(escapeShopifySearch("oak bar stool")).toBe("oak bar stool*");
    expect(escapeShopifySearch("  stool   oak ")).toBe("stool oak*");
    expect(escapeShopifySearch("oak")).toBe("oak*");
  });

  it("drops special characters, connectives and negation instead of escaping them", () => {
    expect(escapeShopifySearch('a" OR vendor:x')).toBe("a vendor x*");
    expect(escapeShopifySearch("sku:123")).toBe("sku 123*");
    expect(escapeShopifySearch("-title:x")).toBe("title x*");
    expect(escapeShopifySearch("(a OR b)")).toBe("a b*");
    expect(escapeShopifySearch("NOT oak AND pine")).toBe("oak pine*");
    expect(escapeShopifySearch("end\\")).toBe("end*");
    expect(escapeShopifySearch("it's `oak` *")).toBe("it s oak*");
    expect(escapeShopifySearch("one\ntwo\" sku:1")).toBe("one two sku 1*");
    expect(escapeShopifySearch("BS-OAK-65 1.5m")).toBe("BS-OAK-65 1.5m*");
  });

  it("keeps unicode letters and drops symbols", () => {
    expect(escapeShopifySearch("Café crème ☕ 北欧")).toBe("Café crème 北欧*");
  });

  it("caps very long input at 8 words of 50 characters", () => {
    const out = escapeShopifySearch(`${"x".repeat(300)} ${Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ")}`);
    const words = out.split(" ");
    expect(words).toHaveLength(8);
    expect(words[0]).toBe("x".repeat(50));
    expect(words[7]).toBe("w6*");
  });

  it("returns an empty string when no searchable word is left", () => {
    expect(escapeShopifySearch('" : () \\ * OR -')).toBe("");
  });

  it("cannot add a filter or an operator", () => {
    for (const evil of [
      'a" OR vendor:x',
      'x" status:draft "',
      "\\\" OR tag:y",
      ") OR (vendor:z",
      "-title:foo",
      "--x",
      "sku:123",
      "(a OR b)",
      "end\\",
      "one\ntwo\" sku:1",
      "a*:b",
      "vendor:'x' `y`",
      "title:>5 created_at:<now",
      "Café ☕ :(",
      "x".repeat(1000),
    ]) {
      expectSafeTerms(escapeShopifySearch(evil), evil);
    }
  });
});

describe("liveFindProducts", () => {
  it("sends one capped products query for a plain search and maps rows in major units", async () => {
    await connect();
    const { bodies } = installFetch({
      products: () =>
        productsReply([
          productNode({
            title: "Oak Counter Stool",
            min: "149.0",
            max: "159.005",
            variants: [{ q: 24 }, { q: -3 }, { q: 0, tracked: false }, { q: 7, policy: "CONTINUE" }],
          }),
        ]),
    });
    const out = await liveFindProducts(CLIENT, { search: "oak bar stool" });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].query).toContain("query LiveProducts");
    expect(bodies[0].query).toMatch(/products\(first: \$first, query: \$query, sortKey: \$sortKey, reverse: \$reverse\)/);
    expect(bodies[0].query).toMatch(/variants\(first: \$variantsFirst\)/);
    expect(bodies[0].variables).toEqual({
      first: LIVE_DEFAULT_LIMIT,
      variantsFirst: 25,
      query: "oak bar stool*",
      sortKey: "RELEVANCE",
      reverse: false,
    });
    expect(out.source).toBe("Shopify (live)");
    expect(out.currency).toBe("GBP");
    expect(Number.isNaN(Date.parse(out.fetched_at))).toBe(false);
    expect(out.rows).toEqual([
      {
        title: "Oak Counter Stool",
        vendor: "Nordic Woodworks",
        product_type: "Bar Stool",
        status: "ACTIVE",
        handle: "oak-counter-stool",
        variants: 4,
        // 24 + 0 (negative clamped); untracked and CONTINUE stay out of the sum.
        stock_units: 24,
        untracked_variants: 2,
        price_min: 149,
        price_max: 159.01,
      },
    ]);
    expect(out.note).toMatch(/untracked/i);
  });

  it("gives null stock_units when no variant is tracked", async () => {
    await connect();
    installFetch({
      products: () =>
        productsReply([productNode({ title: "Corner Sofa", variants: [{ q: 0, tracked: false }, { q: 3, policy: "CONTINUE" }] })]),
    });
    const out = await liveFindProducts(CLIENT, {});
    expect(out.rows[0].stock_units).toBeNull();
    expect(out.rows[0].untracked_variants).toBe(2);
  });

  it("builds filters from vendor, type and status, each value quoted", async () => {
    await connect();
    const { bodies } = installFetch({ products: () => productsReply([]) });
    await liveFindProducts(CLIENT, {
      vendor: 'Nordic" OR vendor:x',
      product_type: "Bar Stool",
      status: "DRAFT",
      sort_by: "title",
    });
    const q = String(bodies[0].variables.query);
    expect(q).toBe('vendor:"Nordic OR vendor x" product_type:"Bar Stool" status:draft');
    expect(unquotedFilters(q)).toEqual(["vendor", "product_type", "status"]);
    expect(unquotedOperators(q)).toEqual([]);
    expect(bodies[0].variables).toMatchObject({ sortKey: "TITLE", reverse: false });
  });

  it("drops (never backslash-escapes) quote, backslash, colon and parentheses inside quoted values", async () => {
    await connect();
    const { bodies } = installFetch({ products: () => productsReply([]) });
    await liveFindProducts(CLIENT, { vendor: "Loft\\", product_type: '(Sofa): "big"', search: "oak" });
    const q = String(bodies[0].variables.query);
    expect(q).toBe('oak* vendor:"Loft" product_type:"Sofa big"');
    expect(q).not.toContain("\\");
    expect(unquotedFilters(q)).toEqual(["vendor", "product_type"]);
    // A value with nothing left is ignored, with a note, rather than sent as an empty phrase.
    const out = await liveFindProducts(CLIENT, { vendor: '":()' });
    expect(bodies[1].variables.query).toBeNull();
    expect(out.note).toMatch(/vendor .* no searchable characters/);
  });

  it("search text with no searchable word is ignored with a note", async () => {
    await connect();
    const { bodies } = installFetch({ products: () => productsReply([]) });
    const out = await liveFindProducts(CLIENT, { search: '" OR ()' });
    expect(bodies[0].variables).toMatchObject({ query: null, sortKey: "TITLE" });
    expect(out.note).toMatch(/search .* no searchable words/);
  });

  it("resolves a collection first, then searches products by collection_id (2 requests)", async () => {
    await connect();
    const { bodies } = installFetch({
      collections: () =>
        json({
          data: {
            collections: {
              nodes: [
                { id: "gid://shopify/Collection/77", title: "Bar stools sale", handle: "bar-stools-sale" },
                { id: "gid://shopify/Collection/123", title: "Bar Stools", handle: "bar-stools" },
              ],
            },
          },
        }),
      products: () => productsReply([productNode({ title: "Oak Counter Stool", variants: [{ q: 2 }] })]),
    });
    const out = await liveFindProducts(CLIENT, { collection: "bar stools", vendor: "Nordic Woodworks" });
    expect(bodies).toHaveLength(2);
    expect(bodies[0].query).toContain("query LiveCollections");
    expect(bodies[0].query).toMatch(/collections\(first: \$first, query: \$query\)/);
    expect(bodies[0].variables).toEqual({ first: 5, query: 'title:"bar stools"' });
    expect(bodies[1].variables.query).toBe('collection_id:123 vendor:"Nordic Woodworks"');
    expect(out.rows).toHaveLength(1);
  });

  it("an unknown collection returns no rows and lists close titles, without a products request", async () => {
    await connect();
    const { bodies } = installFetch({
      collections: () =>
        json({
          data: {
            collections: {
              nodes: [
                { id: "gid://shopify/Collection/77", title: "Bar stools sale", handle: "bar-stools-sale" },
                { id: "gid://shopify/Collection/78", title: "Bar carts", handle: "bar-carts" },
              ],
            },
          },
        }),
      products: () => productsReply([]),
    });
    const out = await liveFindProducts(CLIENT, { collection: "bar" });
    expect(bodies).toHaveLength(1);
    expect(out.rows).toEqual([]);
    expect(out.note).toContain('No collection is titled "bar"');
    expect(out.note).toContain("Bar stools sale");
    expect(out.note).toContain("Bar carts");
  });

  it("clamps the limit to 1..25 and says so, keeping the query under the cost limit", async () => {
    await connect();
    const { bodies } = installFetch({ products: () => productsReply([]) });
    const out = await liveFindProducts(CLIENT, { limit: 500 });
    expect(bodies[0].variables.first).toBe(LIVE_MAX_LIMIT);
    expect(out.note).toMatch(/limit 500 .*25/);
    const cost = estimateCost(bodies[0].query, bodies[0].variables);
    expect(cost).toBeLessThanOrEqual(SHOPIFY_MAX_QUERY_COST);
    expect(cost).toBe(productsQueryCost(25, Number(bodies[0].variables.variantsFirst)));
    await liveFindProducts(CLIENT, { limit: 0 });
    expect(bodies[1].variables.first).toBe(1);
    await liveFindProducts(CLIENT, { limit: Number.NaN });
    expect(bodies[2].variables.first).toBe(LIVE_DEFAULT_LIMIT);
  });

  it("every products query sent for limits 1..25 stays under 1000 points, and 25x25 alone would not", async () => {
    await connect();
    const { bodies } = installFetch({ products: () => productsReply([]) });
    for (let limit = 1; limit <= 25; limit += 1) await liveFindProducts(CLIENT, { limit });
    for (const b of bodies) {
      const cost = estimateCost(b.query, b.variables);
      expect(cost).toBe(productsQueryCost(Number(b.variables.first), Number(b.variables.variantsFirst)));
      expect(cost).toBeLessThanOrEqual(SHOPIFY_MAX_QUERY_COST);
      expect(Number(b.variables.variantsFirst)).toBeGreaterThanOrEqual(1);
      expect(Number(b.variables.variantsFirst)).toBeLessThanOrEqual(25);
    }
    // Why the variants page shrinks at high limits.
    expect(productsQueryCost(25, 25)).toBeGreaterThan(SHOPIFY_MAX_QUERY_COST);
  });

  it("says when a product has more variants than were read, and when more products match", async () => {
    await connect();
    installFetch({
      products: () => productsReply([productNode({ title: "Big Sofa", count: 120, variants: [{ q: 1 }, { q: 2 }] })], true),
    });
    const out = await liveFindProducts(CLIENT, { limit: 25 });
    expect(out.rows[0].variants).toBe(120);
    expect(out.note).toMatch(/showing first \d+ variants/i);
    expect(out.note).toContain("Big Sofa");
    expect(out.note).toMatch(/more products match/i);
  });

  it("maps sort options to Shopify's ProductSortKeys", async () => {
    await connect();
    const { bodies } = installFetch({ products: () => productsReply([]) });
    await liveFindProducts(CLIENT, { sort_by: "inventory" });
    expect(bodies[0].variables).toMatchObject({ sortKey: "INVENTORY_TOTAL", reverse: true });
    await liveFindProducts(CLIENT, { sort_by: "updated", desc: false });
    expect(bodies[1].variables).toMatchObject({ sortKey: "UPDATED_AT", reverse: false });
    await liveFindProducts(CLIENT, { sort_by: "title", desc: true });
    expect(bodies[2].variables).toMatchObject({ sortKey: "TITLE", reverse: true });
    // ProductSortKeys has no BEST_SELLING in 2026-10: never sent, and the note says so.
    const out = await liveFindProducts(CLIENT, { sort_by: "best_selling" });
    expect(bodies[3].variables.sortKey).toBe("TITLE");
    expect(out.note).toMatch(/best.selling/i);
    expect(JSON.stringify(bodies)).not.toContain("BEST_SELLING");
  });

  it("explains an empty result by the filters used, without listing the catalogue", async () => {
    await connect();
    installFetch({ products: () => productsReply([]) });
    const out = await liveFindProducts(CLIENT, { vendor: "Nobody", search: "chair" });
    expect(out.rows).toEqual([]);
    expect(out.note).toContain('search="chair"');
    expect(out.note).toContain('vendor="Nobody"');
    expect(out.note).not.toMatch(/available vendors/i);
  });
});

describe("liveLookupVariants", () => {
  it("looks up a SKU, keeps exact matches only, and maps cost, margin and stock", async () => {
    await connect();
    const { bodies } = installFetch({
      variants: () =>
        variantsReply([
          variantNode({ sku: "BS-OAK-65", price: "19.99", cost: "8.33", q: 4 }),
          variantNode({ sku: "BS-OAK-650", price: "21.00", cost: "9.00", q: 1 }),
        ]),
    });
    const out = await liveLookupVariants(CLIENT, { sku: "BS-OAK-65" });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].query).toContain("query LiveVariants");
    expect(bodies[0].query).toMatch(/productVariants\(first: \$first, query: \$query\)/);
    expect(bodies[0].query).toContain("unitCost");
    expect(bodies[0].variables).toEqual({ first: LIVE_MAX_LIMIT, query: 'sku:"BS-OAK-65"' });
    expect(out.rows).toEqual([
      {
        product: "Oak Counter Stool",
        variant: "Oak / 65cm",
        sku: "BS-OAK-65",
        vendor: "Nordic Woodworks",
        price: 19.99,
        cost: 8.33,
        margin_pct: 58.33,
        stock: 4,
      },
    ]);
    expect(out.source).toBe("Shopify (live)");
    expect(out.currency).toBe("GBP");
    expect(out.note).toMatch(/exact/i);
  });

  it("says which SKUs were close when none matches exactly", async () => {
    await connect();
    installFetch({ variants: () => variantsReply([variantNode({ sku: "BS-OAK-650" })]) });
    const out = await liveLookupVariants(CLIENT, { sku: "BS-OAK-65" });
    expect(out.rows).toEqual([]);
    expect(out.note).toContain('No variant has the exact SKU "BS-OAK-65" (ignoring case)');
    expect(out.note).toContain("BS-OAK-650");
  });

  it("matches the SKU trimmed and ignoring case, and returns every case variant with a note", async () => {
    await connect();
    const { bodies } = installFetch({
      variants: () =>
        variantsReply([
          variantNode({ sku: "BS-OAK-65", q: 1 }),
          variantNode({ sku: " bs-oak-65 ", q: 2 }),
          variantNode({ sku: "BS-OAK-650", q: 3 }),
        ]),
    });
    const out = await liveLookupVariants(CLIENT, { sku: "  Bs-Oak-65 " });
    expect(bodies[0].variables).toEqual({ first: 25, query: 'sku:"Bs-Oak-65"' });
    expect(out.rows.map((r) => [r.sku, r.stock])).toEqual([
      ["BS-OAK-65", 1],
      [" bs-oak-65 ", 2],
    ]);
    expect(out.note).toMatch(/ignoring case/);
    expect(out.note).toMatch(/different letter case \(BS-OAK-65, bs-oak-65\)/);
  });

  it("a hostile SKU stays one quoted sku value", async () => {
    await connect();
    const { bodies } = installFetch({ variants: () => variantsReply([]) });
    await liveLookupVariants(CLIENT, { sku: 'A1" OR vendor:(x)\\' });
    const q = String(bodies[0].variables.query);
    expect(q).toBe('sku:"A1 OR vendor x"');
    expect(unquotedFilters(q)).toEqual(["sku"]);
    expect(unquotedOperators(q)).toEqual([]);
  });

  it("null unitCost gives null cost and margin; untracked/CONTINUE stock is null, negative is 0", async () => {
    await connect();
    installFetch({
      variants: () =>
        variantsReply([
          variantNode({ sku: "A", cost: null, q: 3 }),
          variantNode({ sku: "B", q: 9, tracked: false }),
          variantNode({ sku: "C", q: 9, policy: "CONTINUE" }),
          variantNode({ sku: "D", q: -4 }),
          variantNode({ sku: "E", q: null }),
        ]),
    });
    const out = await liveLookupVariants(CLIENT, { search: "stool", vendor: "Nordic Woodworks", limit: 5 });
    expect(out.rows.map((r) => [r.sku, r.cost, r.margin_pct, r.stock])).toEqual([
      ["A", null, null, 3],
      ["B", 62, 58.39, null],
      ["C", 62, 58.39, null],
      ["D", 62, 58.39, 0],
      ["E", 62, 58.39, null],
    ]);
  });

  it("sends search and vendor as quoted values and clamps the limit", async () => {
    await connect();
    const { bodies } = installFetch({ variants: () => variantsReply([]) });
    const out = await liveLookupVariants(CLIENT, { search: 'oak") OR sku:(x', vendor: "Loft Living", limit: 99 });
    expect(bodies[0].variables).toEqual({ first: 25, query: 'oak sku x* vendor:"Loft Living"' });
    expect(unquotedFilters(String(bodies[0].variables.query))).toEqual(["vendor"]);
    expect(out.note).toMatch(/limit 99 .*25/);
    expect(estimateCost(bodies[0].query, bodies[0].variables)).toBe(variantsQueryCost(25, true));
    expect(variantsQueryCost(25, true)).toBeLessThanOrEqual(SHOPIFY_MAX_QUERY_COST);
  });

  it("retries once without unitCost when cost access is denied, and marks cost unavailable", async () => {
    await connect();
    const before = await getConnection(CLIENT);
    const { bodies } = installFetch({
      variants: (body) =>
        body.query.includes("unitCost")
          ? json({
              data: null,
              errors: [
                {
                  message: "Access denied for unitCost field.",
                  path: ["productVariants", "nodes", 0, "inventoryItem", "unitCost"],
                  extensions: { code: "ACCESS_DENIED" },
                },
              ],
            })
          : variantsReply([variantNode({ sku: "A", q: 2, withCost: false })]),
    });
    const out = await liveLookupVariants(CLIENT, { sku: "A" });
    expect(bodies).toHaveLength(2);
    expect(bodies[1].query).not.toContain("unitCost");
    expect(bodies[1].variables).toEqual(bodies[0].variables);
    expect(out.rows).toEqual([
      expect.objectContaining({ sku: "A", cost: null, margin_pct: null, stock: 2 }),
    ]);
    expect(out.note).toContain("not available (no permission)");
    const after = await getConnection(CLIENT);
    expect(after?.last_sync_status).toBe(before?.last_sync_status);
    expect(after?.last_sync_error).toBe(before?.last_sync_error);
  });
});

describe("errors", () => {
  it("not connected: fixed text, no request", async () => {
    const { fn } = installFetch({});
    const err = await liveFindProducts(CLIENT, {}).catch((e) => e);
    expect(err).toBeInstanceOf(LiveShopifyError);
    expect(err).toMatchObject({ name: "LiveShopifyError", code: "NOT_CONNECTED" });
    expect(err.message).toMatch(/no shopify store is connected/i);
    expect(fn).not.toHaveBeenCalled();
  });

  it("401: reconnect text, token absent, logs clientId/status/code only, connection untouched", async () => {
    await connect();
    const before = await getConnection(CLIENT);
    installFetch({ variants: () => json({ errors: `Invalid API key or access token ${TOKEN}` }, 401) });
    const err = await liveLookupVariants(CLIENT, { sku: "X" }).catch((e) => e);
    expect(err).toBeInstanceOf(LiveShopifyError);
    expect(err.code).toBe("RECONNECT");
    expect(err.message).toMatch(/reconnect the store/i);
    expect(err.message).not.toContain(TOKEN);
    expect(JSON.stringify(err)).not.toContain(TOKEN);
    const log = warnCalls().find(([m]) => m === "Shopify live lookup failed")?.[1];
    expect(log).toEqual({ clientId: CLIENT, status: 401, code: "UNAUTHORIZED" });
    expect(JSON.stringify(warnCalls())).not.toContain(TOKEN);
    const after = await getConnection(CLIENT);
    expect(after?.last_sync_status).toBe(before?.last_sync_status);
    expect(after?.updated_at).toBe(before?.updated_at);
  });

  it("THROTTLED then success: the client retries and the call succeeds", async () => {
    await connect();
    vi.useFakeTimers();
    let n = 0;
    installFetch({
      products: () =>
        ++n === 1
          ? json({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] })
          : productsReply([productNode({ title: "Stool", variants: [{ q: 1 }] })]),
    });
    const p = liveFindProducts(CLIENT, {});
    await vi.runAllTimersAsync();
    const out = await p;
    expect(out.rows).toHaveLength(1);
    expect(n).toBe(2);
  });

  it("persistent throttle: busy text", async () => {
    await connect();
    vi.useFakeTimers();
    installFetch({ products: () => json({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] }) });
    const p = liveFindProducts(CLIENT, {}).catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await p;
    expect(err).toBeInstanceOf(LiveShopifyError);
    expect(err.code).toBe("BUSY");
    expect(err.message).toMatch(/shopify is busy/i);
  });

  it("network failure: unreachable text without the token", async () => {
    await connect();
    vi.useFakeTimers();
    const fn = vi.fn(async () => {
      throw new Error(`connect ECONNREFUSED ${TOKEN}`);
    });
    vi.stubGlobal("fetch", fn);
    const p = liveLookupVariants(CLIENT, {}).catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await p;
    expect(err).toBeInstanceOf(LiveShopifyError);
    expect(err.code).toBe("UNREACHABLE");
    expect(err.message).toMatch(/couldn't reach shopify/i);
    expect(err.message).not.toContain(TOKEN);
    expect(JSON.stringify(warnCalls())).not.toContain(TOKEN);
    expect(warnCalls().find(([m]) => m === "Shopify live lookup failed")?.[1]).toEqual({
      clientId: CLIENT,
      status: 0,
      code: null,
    });
  });

  it("a raw Shopify error body is never passed through", async () => {
    await connect();
    installFetch({
      products: () => json({ errors: [{ message: `Field 'bogus' doesn't exist ${TOKEN}`, extensions: { code: "undefinedField" } }] }),
    });
    const err = await liveFindProducts(CLIENT, {}).catch((e) => e);
    expect(err).toBeInstanceOf(LiveShopifyError);
    expect(err.code).toBe("FAILED");
    expect(err.message).not.toContain("bogus");
    expect(err.message).not.toContain(TOKEN);
  });
});

describe("demo mode", () => {
  beforeEach(() => {
    vi.stubEnv("DEMO_MODE", "true");
    resetConfigCache();
  });

  it("returns mock products with no fetch", async () => {
    const { fn } = installFetch({});
    const out = await liveFindProducts(CLIENT, { collection: "Bar stools", sort_by: "title" });
    expect(fn).not.toHaveBeenCalled();
    expect(out.source).toBe("Shopify (live)");
    expect(out.currency).toBe(MOCK_SHOP.currency);
    expect(out.rows.map((r) => r.title)).toEqual(["Industrial Iron Stool", "Oak Counter Stool", "Walnut Swivel Stool"]);
    expect(out.rows[1]).toMatchObject({ stock_units: 33, untracked_variants: 0, price_min: 149, price_max: 159 });
    // Same results on a second call.
    expect((await liveFindProducts(CLIENT, { collection: "Bar stools", sort_by: "title" })).rows).toEqual(out.rows);
  });

  it("returns mock variants with no fetch, null stock and cost kept null", async () => {
    const { fn } = installFetch({});
    const sku = await liveLookupVariants(CLIENT, { sku: "BS-WAL-01" });
    expect(fn).not.toHaveBeenCalled();
    expect(sku.rows).toEqual([
      {
        product: "Walnut Swivel Stool",
        variant: "Walnut",
        sku: "BS-WAL-01",
        vendor: "Nordic Woodworks",
        price: 189,
        cost: null,
        margin_pct: null,
        stock: 14,
      },
    ]);
    const corner = await liveLookupVariants(CLIENT, { sku: "SF-CORNER-1" });
    expect(corner.rows[0].stock).toBeNull();
  });

  it("matches the same way as the live path: SKU ignoring case, words ANDed with a prefix", async () => {
    const { fn } = installFetch({});
    const sku = await liveLookupVariants(CLIENT, { sku: " bs-wal-01 " });
    expect(sku.rows.map((r) => r.sku)).toEqual(["BS-WAL-01"]);
    const none = await liveLookupVariants(CLIENT, { sku: "bs-wal-0" });
    expect(none.rows).toEqual([]);
    expect(none.note).toContain('No variant has the exact SKU "bs-wal-0" (ignoring case)');
    // Word order does not matter; the last word is a prefix.
    const words = await liveFindProducts(CLIENT, { search: "stool oak" });
    expect(words.rows.map((r) => r.title)).toEqual(["Oak Counter Stool"]);
    const prefix = await liveFindProducts(CLIENT, { search: "swiv" });
    expect(prefix.rows.map((r) => r.title)).toEqual(["Walnut Swivel Stool"]);
    const hostile = await liveFindProducts(CLIENT, { search: 'oak" OR vendor:x' });
    expect(hostile.rows).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it("an unknown demo collection lists the mock collection titles", async () => {
    const out = await liveFindProducts(CLIENT, { collection: "Chairs" });
    expect(out.rows).toEqual([]);
    expect(out.note).toContain("Bar stools");
  });
});
