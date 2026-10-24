import { getConfig } from "@/lib/config";
import { logger } from "@/lib/observability/logger";
import { decryptToken } from "@/lib/security/token-vault";
import { ShopifyApiError, shopifyGraphql, type ShopifyGraphqlOptions } from "./client";
import { toCents } from "./domain";
import { MOCK_SHOP, mockLiveCatalog } from "./mock";
import { getConnection } from "./store";

/**
 * Live, read-only Shopify lookups for the chat (Admin GraphQL `query` operations through the
 * read-only client). Each call resolves the client's connection and decrypts the token itself,
 * sends at most 2 requests, and stays under Shopify's single-query cost limit by construction.
 * Money out is major units rounded to 2 dp; unknown cost and unlimited stock are null, never 0.
 * Errors are LiveShopifyError with fixed text; the connection's status is never changed here.
 */

export const LIVE_SOURCE = "Shopify (live)";
export const LIVE_DEFAULT_LIMIT = 10;
export const LIVE_MAX_LIMIT = 25;
/** "A single query may not exceed a cost of 1,000 points, regardless of plan limits." (shopify.dev) */
export const SHOPIFY_MAX_QUERY_COST = 1000;
/** Headroom under the hard limit for anything Shopify costs above the documented rules. */
const COST_BUDGET = 900;
const MAX_VARIANTS_PER_PRODUCT = 25;
const COLLECTION_CANDIDATES = 5;
const MAX_TEXT = 200;
/**
 * Per-request limits for live calls: 2 attempts of 10 s (plus about 1 s of backoff) keep a
 * tool call of at most 2 requests near 45 s, well inside a chat request. The sync keeps the
 * client defaults (3 attempts of 25 s).
 */
export const LIVE_REQUEST: Required<ShopifyGraphqlOptions> = { attempts: 2, timeoutMs: 10_000 };

export type LiveShopifyErrorCode = "NOT_CONNECTED" | "RECONNECT" | "BUSY" | "UNREACHABLE" | "ACCESS_DENIED" | "FAILED";

const ERROR_TEXT: Record<LiveShopifyErrorCode, string> = {
  NOT_CONNECTED: "No Shopify store is connected for this client.",
  RECONNECT: "Shopify rejected the store's access token. Reconnect the store.",
  BUSY: "Shopify is busy right now. Try again in a minute.",
  UNREACHABLE: "Couldn't reach Shopify. Try again shortly.",
  ACCESS_DENIED:
    "Shopify refused access to the store's products. Reconnect the store with read_products and read_inventory access.",
  FAILED: "The Shopify lookup failed. Try again.",
};

/** A live lookup failure. The message is fixed text, safe to show to the model and the user. */
export class LiveShopifyError extends Error {
  readonly code: LiveShopifyErrorCode;
  constructor(code: LiveShopifyErrorCode) {
    super(ERROR_TEXT[code]);
    this.name = "LiveShopifyError";
    this.code = code;
  }
}

export type LiveMeta = {
  source: typeof LIVE_SOURCE;
  fetched_at: string;
  currency: string | null;
  /** True when Shopify has more matches than were returned. */
  has_more: boolean;
  note: string;
};

export type LiveProductRow = {
  title: string;
  vendor: string;
  product_type: string;
  status: string;
  handle: string;
  /** The product's full variant count. */
  variants: number;
  /** Variants actually read for stock (fewer than `variants` when the product has many). */
  variants_read: number;
  /** Sum over tracked, DENY-policy variants read; null if none of them is. */
  stock_units: number | null;
  untracked_variants: number;
  price_min: number | null;
  price_max: number | null;
};

export type LiveVariantRow = {
  product: string;
  variant: string;
  sku: string | null;
  vendor: string;
  price: number | null;
  cost: number | null;
  margin_pct: number | null;
  /** null = untracked or sells when out of stock (unlimited), never 0. */
  stock: number | null;
};

export type LiveProductsResult = LiveMeta & { rows: LiveProductRow[] };
export type LiveVariantsResult = LiveMeta & { rows: LiveVariantRow[] };

export type LiveProductStatus = "ACTIVE" | "DRAFT" | "ARCHIVED" | "UNLISTED";
export type LiveProductSort = "best_selling" | "title" | "inventory" | "updated";

export type LiveFindProductsArgs = {
  search?: string;
  vendor?: string;
  product_type?: string;
  collection?: string;
  status?: LiveProductStatus;
  sort_by?: LiveProductSort;
  desc?: boolean;
  limit?: number;
};

export type LiveLookupVariantsArgs = { sku?: string; search?: string; vendor?: string; limit?: number };

// ---------------------------------------------------------------------------------------------
// Search text

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** Trimmed, control characters replaced by spaces, capped; empty becomes undefined. */
function cleanText(text: string | undefined): string | undefined {
  if (typeof text !== "string") return undefined;
  const out = text.replace(CONTROL_CHARS, " ").trim().slice(0, MAX_TEXT);
  return out || undefined;
}

const MAX_SEARCH_TOKENS = 8;
const MAX_TOKEN_CHARS = 50;
/** Anything but letters, digits, combining marks and the inner punctuation `- . _` splits words. */
const NOT_WORD_CHAR = /[^\p{L}\p{N}\p{M}._-]+/gu;
const CONNECTIVES = new Set(["OR", "AND", "NOT"]);

/**
 * The words of free search text, safe to send unquoted. Every character outside letters,
 * digits, combining marks and `- . _` becomes a separator (so `" \ : ( ) * '` and backticks never
 * survive), a leading `-` (negation) is stripped, bare connectives OR/AND/NOT are dropped, words
 * without a letter or digit are dropped, and at most 8 words of 50 characters are kept.
 */
function searchTokens(text: string): string[] {
  return String(text)
    .replace(NOT_WORD_CHAR, " ")
    .split(" ")
    .map((w) => w.replace(/^-+/, "").slice(0, MAX_TOKEN_CHARS))
    .filter((w) => /[\p{L}\p{N}]/u.test(w) && !CONNECTIVES.has(w))
    .slice(0, MAX_SEARCH_TOKENS);
}

/**
 * Free search text as Shopify search terms: one unquoted word per term, joined by spaces
 * ("When a connective is not specified between two terms, AND is implied"), with `*` on the last
 * word for a prefix match (search syntax: "`query=norm*` matches terms beginning with norm").
 * No character that ends a phrase, starts a field filter, groups terms or negates can survive,
 * so the text cannot add a filter or an operator. Returns "" when no searchable word is left.
 */
export function escapeShopifySearch(text: string): string {
  const tokens = searchTokens(text);
  return tokens.map((t, i) => (i === tokens.length - 1 ? `${t}*` : t)).join(" ");
}

/**
 * One quoted filter value (vendor, product type, SKU, collection title). The characters that
 * could end the phrase, escape, start a filter or group terms (`" \ : ( )`) are replaced with
 * spaces rather than backslash-escaped, since Shopify does not document escapes inside quotes.
 * Returns null when nothing is left.
 */
function quoteShopifyValue(text: string): string | null {
  const clean = String(text).replace(CONTROL_CHARS, " ").replace(/[\\":()]/g, " ").replace(/\s+/g, " ").trim();
  return clean ? `"${clean}"` : null;
}

// ---------------------------------------------------------------------------------------------
// Limits and cost

function clampLimit(limit: number | undefined, notes: string[]): number {
  if (limit === undefined || typeof limit !== "number" || !Number.isFinite(limit)) return LIVE_DEFAULT_LIMIT;
  const n = Math.min(LIVE_MAX_LIMIT, Math.max(1, Math.floor(limit)));
  if (n !== limit) notes.push(`Requested limit ${limit} was capped to ${n} (allowed 1 to ${LIVE_MAX_LIMIT}).`);
  return n;
}

/**
 * Requested cost of PRODUCTS_QUERY under Shopify's documented rules (scalar/enum 0, object 1,
 * connection = 2 + the objects it returns, nested selections multiplied by `first`):
 * products 2 + pageInfo 1 + first x (product 1 + variantsCount 1 + priceRangeV2 3 +
 * variants (2 + variantsFirst x (variant 1 + inventoryItem 1))).
 */
export function productsQueryCost(first: number, variantsFirst: number): number {
  return 3 + first * (7 + 2 * variantsFirst);
}

/** Requested cost of the variants query: 2 + pageInfo 1 + first x (variant, product, inventoryItem[, unitCost]). */
export function variantsQueryCost(first: number, withCost: boolean): number {
  return 3 + first * (withCost ? 4 : 3);
}

/** Largest variants page (<= 25) that keeps the products query inside the cost budget. */
function variantsPageFor(first: number): number {
  let v = MAX_VARIANTS_PER_PRODUCT;
  while (v > 1 && productsQueryCost(first, v) > COST_BUDGET) v -= 1;
  return v;
}

// ---------------------------------------------------------------------------------------------
// GraphQL documents (query operations only)

const COLLECTIONS_QUERY = `query LiveCollections($first: Int!, $query: String!) {
  collections(first: $first, query: $query) {
    nodes { id title handle }
  }
}`;

const PRODUCTS_QUERY = `query LiveProducts($first: Int!, $variantsFirst: Int!, $query: String, $sortKey: ProductSortKeys!, $reverse: Boolean!) {
  products(first: $first, query: $query, sortKey: $sortKey, reverse: $reverse) {
    pageInfo { hasNextPage }
    nodes {
      title
      handle
      vendor
      productType
      status
      variantsCount { count }
      priceRangeV2 { minVariantPrice { amount } maxVariantPrice { amount } }
      variants(first: $variantsFirst) {
        nodes { inventoryQuantity inventoryPolicy inventoryItem { tracked } }
      }
    }
  }
}`;

const variantsQuery = (withCost: boolean) => `query LiveVariants($first: Int!, $query: String, $sortKey: ProductVariantSortKeys!) {
  productVariants(first: $first, query: $query, sortKey: $sortKey) {
    pageInfo { hasNextPage }
    nodes {
      title
      sku
      price
      inventoryQuantity
      inventoryPolicy
      product { title vendor }
      inventoryItem { tracked${withCost ? " unitCost { amount }" : ""} }
    }
  }
}`;

type Money = { amount?: string | null } | null | undefined;

type ProductsData = {
  products: {
    pageInfo: { hasNextPage: boolean };
    nodes: Array<{
      title: string;
      handle: string;
      vendor: string;
      productType: string;
      status: string;
      variantsCount: { count: number } | null;
      priceRangeV2: { minVariantPrice: Money; maxVariantPrice: Money } | null;
      variants: {
        nodes: Array<{ inventoryQuantity: number | null; inventoryPolicy: string; inventoryItem: { tracked: boolean } | null }>;
      };
    }>;
  };
};

type VariantsData = {
  productVariants: {
    pageInfo: { hasNextPage: boolean };
    nodes: Array<{
      title: string;
      sku: string | null;
      price: string | null;
      inventoryQuantity: number | null;
      inventoryPolicy: string;
      product: { title: string; vendor: string } | null;
      inventoryItem: { tracked: boolean; unitCost?: Money } | null;
    }>;
  };
};

type CollectionsData = { collections: { nodes: Array<{ id: string; title: string; handle: string }> } };

// ---------------------------------------------------------------------------------------------
// Value rules

const major = (cents: number | null): number | null => (cents === null ? null : Math.round(cents) / 100);
const moneyOf = (m: Money): number | null => major(toCents(m?.amount ?? null));

/** Stock for one variant: untracked or CONTINUE (sells when out of stock) is unlimited (null). */
function stockOf(tracked: boolean | undefined, policy: string, quantity: number | null): number | null {
  if (tracked === false || policy === "CONTINUE") return null;
  if (typeof quantity !== "number" || !Number.isFinite(quantity)) return null;
  return Math.max(0, quantity);
}

function marginPct(priceCents: number | null, costCents: number | null): number | null {
  if (priceCents === null || costCents === null || priceCents <= 0) return null;
  // Integer cents in, one rounding out: (price - cost) / price as a percentage, 2 dp.
  return Math.round(((priceCents - costCents) * 10_000) / priceCents) / 100;
}

const STOCK_NOTE =
  "stock null means untracked or sold when out of stock (unlimited), never 0; stock_units sums tracked variants only.";
const COST_NOTE = "cost null means no cost recorded in Shopify.";
const COST_DENIED_NOTE =
  "cost: not available (no permission): the app's token may not view product costs, so cost and margin_pct are null.";

function meta(currency: string | null, hasMore: boolean, notes: string[]): LiveMeta {
  return {
    source: LIVE_SOURCE,
    fetched_at: new Date().toISOString(),
    currency,
    has_more: hasMore,
    note: ["Live from Shopify at the time of the request (not synced data).", ...notes].join(" "),
  };
}

function filtersUsed(pairs: Array<[string, string | undefined]>): string {
  return pairs
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}="${v}"`)
    .join(", ");
}

function emptyNote(kind: "products" | "variants", used: string): string {
  return used
    ? `No ${kind} matched ${used}. Vendor, type and collection names must match the store's spelling.`
    : `Shopify returned no ${kind}.`;
}

function unknownCollectionNote(wanted: string, close: string[]): string {
  return close.length
    ? `No collection is titled "${wanted}". Close collection titles: ${close.join(", ")}.`
    : `No collection is titled "${wanted}", and none has a similar title.`;
}

/** Adds `field:"value"`; a value with nothing searchable left is ignored and noted. */
function addValue(terms: string[], notes: string[], field: string, value: string | undefined): void {
  if (!value) return;
  const quoted = quoteShopifyValue(value);
  if (quoted) terms.push(`${field}:${quoted}`);
  else notes.push(`${field} "${value}" has no searchable characters and was ignored.`);
}

/** Adds the free-text terms; true when any were added. */
function addSearch(terms: string[], notes: string[], search: string | undefined): boolean {
  if (!search) return false;
  const text = escapeShopifySearch(search);
  if (text) terms.push(text);
  else notes.push(`search "${search}" has no searchable words and was ignored.`);
  return Boolean(text);
}

/**
 * Notes when text was given but none of it is searchable (and nothing else narrows the
 * lookup): each ignored value is named, and nothing is looked up, rather than returning an
 * unfiltered first page as if it matched.
 */
function nothingSearchableNotes(
  kind: "products" | "variants",
  search: string | undefined,
  values: Array<[string, string | undefined]>,
  notes: string[],
): void {
  addSearch([], notes, search);
  for (const [field, value] of values) addValue([], notes, field, value);
  notes.push(`None of the text given has searchable characters, so no ${kind} were looked up. Use letters or digits.`);
}

/** True when text was given, none of it survives sanitising, and no other filter applies. */
function nothingSearchable(search: string | undefined, values: Array<string | undefined>, otherFilter: boolean): boolean {
  if (otherFilter || (!search && values.every((v) => !v))) return false;
  if (search && escapeShopifySearch(search)) return false;
  return values.every((v) => !v || quoteShopifyValue(v) === null);
}

/** Characters a quoted filter value cannot carry: quoteShopifyValue sends them as spaces. */
const UNSENDABLE_CHARS = /[\\":()]/;

/**
 * Rows whose SKU equals `sku` after trimming, ignoring case (all of them when several differ
 * only by case, with a note).
 */
function exactSkuMatches<T extends { sku: string | null }>(rows: T[], sku: string, notes: string[]): T[] {
  const want = sku.trim().toLowerCase();
  const exact = rows.filter((r) => (r.sku ?? "").trim().toLowerCase() === want);
  const spellings = [...new Set(exact.map((r) => (r.sku ?? "").trim()))];
  if (spellings.length > 1) {
    notes.push(`Several variants have this SKU in different letter case (${spellings.join(", ")}); all are shown.`);
  }
  return exact;
}

/**
 * What a SKU lookup can honestly say. Shopify does not document `sku:` as an exact match, so
 * the variants it returned (`checked`, at most 25) are only candidates and `more` (Shopify's
 * hasNextPage) means others were not checked. "No variant has the exact SKU" is said only
 * when Shopify returned every candidate and the SKU was sent unchanged.
 */
function skuNotes(sku: string, checked: number, exactCount: number, more: boolean, notes: string[]): void {
  const changed = UNSENDABLE_CHARS.test(sku);
  if (changed) {
    notes.push(
      `The SKU "${sku}" contains characters Shopify's search cannot take (: ( ) " \\), so they were sent as spaces.`,
    );
  }
  if (exactCount > 0) {
    if (more) {
      notes.push(
        `Shopify has more than ${checked} candidates for this SKU and only the first ${checked} were checked, so other variants with this exact SKU may exist.`,
      );
    }
    return;
  }
  if (more) {
    notes.push(
      `No variant with the exact SKU "${sku}" is among the first ${checked} Shopify matches for this SKU; it may still exist, so try the product name.`,
    );
  } else if (changed) {
    notes.push(
      `None of the ${checked} variants Shopify returned for the changed value has the exact SKU "${sku}"; it may still exist, so try the product name.`,
    );
  } else {
    notes.push(`No variant has the exact SKU "${sku}" (ignoring case).`);
  }
}

const SORT_KEYS: Record<Exclude<LiveProductSort, "best_selling">, string> = {
  title: "TITLE",
  inventory: "INVENTORY_TOTAL",
  updated: "UPDATED_AT",
};
const STATUSES: LiveProductStatus[] = ["ACTIVE", "DRAFT", "ARCHIVED", "UNLISTED"];

/** sortKey, reverse and notes for a products search. ProductSortKeys has no BEST_SELLING. */
function chooseSort(args: LiveFindProductsArgs, hasSearch: boolean, notes: string[]): { sortKey: string; reverse: boolean } {
  let sortBy: string | undefined = args.sort_by;
  if (sortBy === "best_selling") {
    notes.push(
      "Shopify's product search cannot sort by best selling (no BEST_SELLING sort key), so this list is by title; use the synced sales for best sellers.",
    );
    sortBy = "title";
  } else if (sortBy !== undefined && !(sortBy in SORT_KEYS)) {
    notes.push(`Unknown sort_by '${sortBy}', sorted by title.`);
    sortBy = "title";
  }
  if (sortBy === undefined) return { sortKey: hasSearch ? "RELEVANCE" : "TITLE", reverse: args.desc ?? false };
  const sortKey = SORT_KEYS[sortBy as keyof typeof SORT_KEYS];
  if (sortKey === "INVENTORY_TOTAL") {
    notes.push("Sorted by Shopify's total inventory, which can include untracked variants.");
  }
  return { sortKey, reverse: args.desc ?? (sortKey === "INVENTORY_TOTAL" || sortKey === "UPDATED_AT") };
}

// ---------------------------------------------------------------------------------------------
// Connection, errors

function isDemo(): boolean {
  return getConfig().isDemoMode;
}

function classify(error: unknown): LiveShopifyErrorCode {
  if (error instanceof LiveShopifyError) return error.code;
  if (!(error instanceof ShopifyApiError)) return "FAILED";
  if (error.status === 401 || error.status === 403 || error.code === "UNAUTHORIZED") return "RECONNECT";
  if (error.status === 429 || error.code === "THROTTLED") return "BUSY";
  if (error.code === "ACCESS_DENIED") return "ACCESS_DENIED";
  if ((error.status === 0 && error.code === null) || error.status >= 500) return "UNREACHABLE";
  return "FAILED";
}

/** Logs clientId, status and code only (never the token, a body or Shopify's text). */
function logFailure(clientId: string, error: unknown): void {
  logger.warn("Shopify live lookup failed", {
    clientId,
    status: error instanceof ShopifyApiError ? error.status : null,
    code: error instanceof ShopifyApiError ? error.code : error instanceof LiveShopifyError ? error.code : null,
  });
}

function fail(clientId: string, error: unknown): never {
  if (error instanceof LiveShopifyError && error.code === "NOT_CONNECTED") throw error;
  logFailure(clientId, error);
  throw new LiveShopifyError(classify(error));
}

type Live = { shop: string; token: string; currency: string | null };

async function openConnection(clientId: string): Promise<Live> {
  let connection;
  try {
    connection = await getConnection(clientId);
  } catch {
    logger.warn("Shopify live lookup failed", { clientId, status: null, code: "CONNECTION_READ" });
    throw new LiveShopifyError("FAILED");
  }
  if (!connection) throw new LiveShopifyError("NOT_CONNECTED");
  let token: string;
  try {
    token = decryptToken(connection.access_token_encrypted);
  } catch {
    // The stored token cannot be read: only a reconnect fixes that.
    logger.warn("Shopify live lookup failed", { clientId, status: null, code: "TOKEN_UNREADABLE" });
    throw new LiveShopifyError("RECONNECT");
  }
  return { shop: connection.shop_domain, token, currency: connection.currency };
}

async function demoCurrency(clientId: string): Promise<string> {
  try {
    return (await getConnection(clientId))?.currency ?? MOCK_SHOP.currency;
  } catch {
    return MOCK_SHOP.currency;
  }
}

// ---------------------------------------------------------------------------------------------
// Products

function productRow(p: ProductsData["products"]["nodes"][number]): LiveProductRow {
  const variants = p.variants?.nodes ?? [];
  let stock: number | null = null;
  let untracked = 0;
  for (const v of variants) {
    const s = stockOf(v.inventoryItem?.tracked, v.inventoryPolicy, v.inventoryQuantity);
    if (s === null) untracked += 1;
    else stock = (stock ?? 0) + s;
  }
  return {
    title: p.title,
    vendor: p.vendor,
    product_type: p.productType,
    status: p.status,
    handle: p.handle,
    variants: p.variantsCount?.count ?? variants.length,
    variants_read: variants.length,
    stock_units: stock,
    untracked_variants: untracked,
    price_min: moneyOf(p.priceRangeV2?.minVariantPrice),
    price_max: moneyOf(p.priceRangeV2?.maxVariantPrice),
  };
}

function productNotes(rows: LiveProductRow[], notes: string[]): void {
  if (rows.some((r) => r.untracked_variants > 0 || r.stock_units === null)) notes.push(STOCK_NOTE);
  const truncated = rows.filter((r) => r.variants > r.variants_read);
  if (truncated.length) {
    const read = Math.max(...truncated.map((r) => r.variants_read));
    const names = truncated.slice(0, 5).map((r) => r.title);
    notes.push(
      `Showing first ${read} variants for ${names.join(", ")}${truncated.length > 5 ? " and others" : ""}: stock_units and untracked_variants cover only the variants_read variants; variants is the full count.`,
    );
  }
}

/**
 * Products matching the filters, live from Shopify. `collection` is resolved by title first
 * (collections(first: 5)); an unknown title returns no rows and lists close titles.
 */
export async function liveFindProducts(clientId: string, args: LiveFindProductsArgs): Promise<LiveProductsResult> {
  const notes: string[] = [];
  const first = clampLimit(args.limit, notes);
  const search = cleanText(args.search);
  const vendor = cleanText(args.vendor);
  const productType = cleanText(args.product_type);
  const collection = cleanText(args.collection);
  let status: LiveProductStatus | undefined;
  if (args.status !== undefined) {
    if (STATUSES.includes(args.status)) status = args.status;
    else notes.push(`Unknown status '${String(args.status)}' was ignored.`);
  }
  const used = filtersUsed([
    ["search", search],
    ["vendor", vendor],
    ["product_type", productType],
    ["collection", collection],
    ["status", status],
  ]);

  const blank = nothingSearchable(search, [vendor, productType], Boolean(collection || status));
  const blankResult = (currency: string | null): LiveProductsResult => {
    nothingSearchableNotes("products", search, [["vendor", vendor], ["product_type", productType]], notes);
    return { ...meta(currency, false, notes), rows: [] };
  };

  if (isDemo()) {
    if (blank) return blankResult(await demoCurrency(clientId));
    return demoProducts(clientId, {
      first,
      search,
      vendor: demoValue(notes, "vendor", vendor),
      productType: demoValue(notes, "product_type", productType),
      collection,
      status,
      args,
      notes,
      used,
    });
  }

  const live = await openConnection(clientId);
  if (blank) return blankResult(live.currency);
  try {
    const terms: string[] = [];
    if (collection) {
      const title = quoteShopifyValue(collection);
      if (!title) {
        notes.push(unknownCollectionNote(collection, []));
        return { ...meta(live.currency, false, notes), rows: [] };
      }
      const data = await shopifyGraphql<CollectionsData>(
        live.shop,
        live.token,
        COLLECTIONS_QUERY,
        { first: COLLECTION_CANDIDATES, query: `title:${title}` },
        LIVE_REQUEST,
      );
      const candidates = data.collections?.nodes ?? [];
      const wanted = collection.toLowerCase();
      const hit = candidates.find((c) => c.title.toLowerCase() === wanted || c.handle.toLowerCase() === wanted);
      const numericId = hit ? /^gid:\/\/shopify\/Collection\/(\d+)$/.exec(hit.id)?.[1] : undefined;
      if (!numericId) {
        notes.push(unknownCollectionNote(collection, candidates.map((c) => c.title)));
        return { ...meta(live.currency, false, notes), rows: [] };
      }
      terms.push(`collection_id:${numericId}`);
    }
    const hasSearch = addSearch(terms, notes, search);
    addValue(terms, notes, "vendor", vendor);
    addValue(terms, notes, "product_type", productType);
    if (status) terms.push(`status:${status.toLowerCase()}`);

    const { sortKey, reverse } = chooseSort(args, hasSearch, notes);
    const variantsFirst = variantsPageFor(first);
    const data = await shopifyGraphql<ProductsData>(
      live.shop,
      live.token,
      PRODUCTS_QUERY,
      { first, variantsFirst, query: terms.length ? terms.join(" ") : null, sortKey, reverse },
      LIVE_REQUEST,
    );
    const nodes = data.products?.nodes ?? [];
    const hasMore = Boolean(data.products?.pageInfo?.hasNextPage);
    const rows = nodes.map(productRow);
    productNotes(rows, notes);
    if (hasMore) notes.push(`More products match; showing the first ${rows.length}. Narrow the filters to see others.`);
    if (rows.length === 0) notes.push(emptyNote("products", used));
    return { ...meta(live.currency, hasMore, notes), rows };
  } catch (error) {
    fail(clientId, error);
  }
}

// ---------------------------------------------------------------------------------------------
// Variants

function variantRow(v: VariantsData["productVariants"]["nodes"][number], withCost: boolean): LiveVariantRow {
  const priceCents = toCents(v.price);
  const costCents = withCost ? toCents(v.inventoryItem?.unitCost?.amount ?? null) : null;
  return {
    product: v.product?.title ?? "",
    variant: v.title,
    sku: v.sku,
    vendor: v.product?.vendor ?? "",
    price: major(priceCents),
    cost: major(costCents),
    margin_pct: marginPct(priceCents, costCents),
    stock: stockOf(v.inventoryItem?.tracked, v.inventoryPolicy, v.inventoryQuantity),
  };
}

const SKU_EXACT_NOTE =
  "Shopify's sku: search filter is not documented as an exact match, so only variants whose SKU equals the requested SKU (trimmed, ignoring case) are shown.";

/**
 * Variants by exact SKU, or by search text / vendor, live from Shopify. Shopify documents the
 * `sku:` filter only as "Filter by the product variant sku field" (not as exact), so a SKU
 * lookup reads up to 25 candidates (sortKey RELEVANCE, which ProductVariantSortKeys has in
 * 2026-10) and keeps SKUs equal after trimming, ignoring case. has_more keeps Shopify's
 * hasNextPage for those candidates, and the notes never claim a SKU is absent when only some
 * candidates were checked or the SKU had to be changed before sending.
 */
export async function liveLookupVariants(clientId: string, args: LiveLookupVariantsArgs): Promise<LiveVariantsResult> {
  const notes: string[] = [];
  const limit = clampLimit(args.limit, notes);
  const sku = cleanText(args.sku);
  const search = cleanText(args.search);
  const vendor = cleanText(args.vendor);
  const used = filtersUsed([
    ["sku", sku],
    ["search", search],
    ["vendor", vendor],
  ]);
  // A SKU with nothing sendable left is ignored (with a note), not matched against.
  const skuUsed = sku && quoteShopifyValue(sku) ? sku : undefined;
  const blank = nothingSearchable(search, [sku, vendor], false);
  const blankResult = (currency: string | null): LiveVariantsResult => {
    nothingSearchableNotes("variants", search, [["sku", sku], ["vendor", vendor]], notes);
    return { ...meta(currency, false, notes), rows: [] };
  };

  if (isDemo()) {
    if (blank) return blankResult(await demoCurrency(clientId));
    if (sku && !skuUsed) addValue([], notes, "sku", sku);
    return demoVariants(clientId, { limit, sku: skuUsed, search, vendor: demoValue(notes, "vendor", vendor), notes, used });
  }

  const live = await openConnection(clientId);
  if (blank) return blankResult(live.currency);
  const terms: string[] = [];
  addValue(terms, notes, "sku", sku);
  addSearch(terms, notes, search);
  addValue(terms, notes, "vendor", vendor);
  const variables = {
    first: skuUsed ? LIVE_MAX_LIMIT : limit,
    query: terms.length ? terms.join(" ") : null,
    // RELEVANCE needs a search query (always there for a SKU); ID is Shopify's default order.
    sortKey: skuUsed ? "RELEVANCE" : "ID",
  };

  let withCost = true;
  let data: VariantsData;
  try {
    try {
      data = await shopifyGraphql<VariantsData>(live.shop, live.token, variantsQuery(true), variables, LIVE_REQUEST);
    } catch (error) {
      // No permission to view product costs: answer without cost rather than fail the call.
      if (!(error instanceof ShopifyApiError) || error.code !== "ACCESS_DENIED") throw error;
      logFailure(clientId, error);
      withCost = false;
      data = await shopifyGraphql<VariantsData>(live.shop, live.token, variantsQuery(false), variables, LIVE_REQUEST);
    }
  } catch (error) {
    fail(clientId, error);
  }

  const nodes = data.productVariants?.nodes ?? [];
  // Shopify's own hasNextPage: for a SKU lookup, more candidates exist than were checked.
  const shopifyHasMore = Boolean(data.productVariants?.pageInfo?.hasNextPage);
  let hasMore = shopifyHasMore;
  let rows = nodes.map((v) => variantRow(v, withCost));
  if (skuUsed) {
    notes.push(SKU_EXACT_NOTE);
    const exact = exactSkuMatches(rows, skuUsed, notes);
    skuNotes(skuUsed, rows.length, exact.length, shopifyHasMore, notes);
    if (exact.length === 0 && rows.length > 0) {
      const close = [...new Set(rows.map((r) => r.sku).filter((s): s is string => !!s))].slice(0, 5);
      notes.push(`Close SKUs: ${close.join(", ")}.`);
    }
    hasMore = shopifyHasMore || exact.length > limit;
    rows = exact.slice(0, limit);
    if (exact.length > limit) notes.push(`More variants have this SKU; showing the first ${rows.length}.`);
  } else {
    if (rows.length === 0) notes.push(emptyNote("variants", used));
    if (hasMore) notes.push(`More variants match; showing the first ${rows.length}. Narrow the filters to see others.`);
  }
  if (rows.some((r) => r.stock === null)) notes.push(STOCK_NOTE);
  notes.push(withCost ? COST_NOTE : COST_DENIED_NOTE);
  return { ...meta(live.currency, hasMore, notes), rows };
}

// ---------------------------------------------------------------------------------------------
// Demo mode: ClickTrends mock catalogue, no network.

const lc = (s: string | null | undefined) => (s ?? "").toLowerCase();

/** A filter value the live path would send, else undefined with the same "ignored" note. */
function demoValue(notes: string[], field: string, value: string | undefined): string | undefined {
  if (value && !quoteShopifyValue(value)) {
    addValue([], notes, field, value);
    return undefined;
  }
  return value;
}

/** The same words the live search would send (and the same note when none is left). */
function demoSearchTokens(search: string | undefined, notes: string[]): string[] {
  addSearch([], notes, search);
  return search ? searchTokens(search).map(lc) : [];
}

/** Every word appears in one of the fields (AND of words, like the live search). */
function demoSearchMatch(fields: Array<string | null | undefined>, tokens: string[]): boolean {
  const text = lc(fields.filter(Boolean).join(" "));
  return tokens.every((t) => text.includes(t));
}

async function demoProducts(
  clientId: string,
  o: {
    first: number;
    search?: string;
    vendor?: string;
    productType?: string;
    collection?: string;
    status?: LiveProductStatus;
    args: LiveFindProductsArgs;
    notes: string[];
    used: string;
  },
): Promise<LiveProductsResult> {
  const currency = await demoCurrency(clientId);
  const { collections, products, variants } = mockLiveCatalog();
  let list = products;
  if (o.collection) {
    const hit = collections.find((c) => lc(c.title) === lc(o.collection) || lc(c.handle) === lc(o.collection));
    if (!hit) {
      o.notes.push(unknownCollectionNote(o.collection, collections.map((c) => c.title)));
      return { ...meta(currency, false, o.notes), rows: [] };
    }
    list = list.filter((p) => p.collection_gids.includes(hit.gid));
  }
  const tokens = demoSearchTokens(o.search, o.notes);
  list = list.filter((p) => demoSearchMatch([p.title, p.vendor, p.product_type, p.handle], tokens));
  if (o.vendor) list = list.filter((p) => lc(p.vendor) === lc(o.vendor));
  if (o.productType) list = list.filter((p) => lc(p.product_type) === lc(o.productType));
  if (o.status) list = list.filter((p) => p.status === o.status);

  const rows = list.map((p): LiveProductRow => {
    const vs = variants.filter((v) => v.product_gid === p.gid);
    const tracked = vs.filter((v) => v.inventory_quantity !== null);
    const prices = vs.map((v) => v.price_cents);
    return {
      title: p.title,
      vendor: p.vendor,
      product_type: p.product_type,
      status: p.status,
      handle: p.handle,
      variants: vs.length,
      variants_read: vs.length,
      stock_units: tracked.length ? tracked.reduce((s, v) => s + Math.max(0, v.inventory_quantity ?? 0), 0) : null,
      untracked_variants: vs.length - tracked.length,
      price_min: prices.length ? major(Math.min(...prices)) : null,
      price_max: prices.length ? major(Math.max(...prices)) : null,
    };
  });
  const { sortKey, reverse } = chooseSort(o.args, tokens.length > 0, o.notes);
  if (sortKey === "INVENTORY_TOTAL") rows.sort((a, b) => (a.stock_units ?? 0) - (b.stock_units ?? 0));
  else if (sortKey !== "RELEVANCE") rows.sort((a, b) => a.title.localeCompare(b.title));
  if (reverse) rows.reverse();
  const shown = rows.slice(0, o.first);
  const hasMore = rows.length > shown.length;
  productNotes(shown, o.notes);
  if (hasMore) o.notes.push(`More products match; showing the first ${shown.length}. Narrow the filters to see others.`);
  if (shown.length === 0) o.notes.push(emptyNote("products", o.used));
  return { ...meta(currency, hasMore, o.notes), rows: shown };
}

async function demoVariants(
  clientId: string,
  o: { limit: number; sku?: string; search?: string; vendor?: string; notes: string[]; used: string },
): Promise<LiveVariantsResult> {
  const currency = await demoCurrency(clientId);
  const { products, variants } = mockLiveCatalog();
  const byGid = new Map(products.map((p) => [p.gid, p]));
  const tokens = demoSearchTokens(o.search, o.notes);
  let matches = variants
    .map((v) => ({ v, p: byGid.get(v.product_gid) }))
    .filter(({ v, p }) => {
      if (!p) return false;
      if (o.vendor && lc(p.vendor) !== lc(o.vendor)) return false;
      return demoSearchMatch([p.title, p.vendor, v.title, v.sku], tokens);
    })
    .map(
      ({ v, p }): LiveVariantRow => ({
        product: p!.title,
        variant: v.title,
        sku: v.sku,
        vendor: p!.vendor,
        price: major(v.price_cents),
        cost: major(v.cost_cents),
        margin_pct: marginPct(v.price_cents, v.cost_cents),
        stock: v.inventory_quantity === null ? null : Math.max(0, v.inventory_quantity),
      }),
    );
  if (o.sku) {
    const candidates = matches.length;
    matches = exactSkuMatches(matches, o.sku, o.notes);
    skuNotes(o.sku, candidates, matches.length, false, o.notes);
  }
  const rows = matches.slice(0, o.limit);
  const hasMore = matches.length > rows.length;
  if (!o.sku && rows.length === 0) o.notes.push(emptyNote("variants", o.used));
  if (hasMore) o.notes.push(`More variants match; showing the first ${rows.length}. Narrow the filters to see others.`);
  if (rows.some((r) => r.stock === null)) o.notes.push(STOCK_NOTE);
  o.notes.push(COST_NOTE);
  return { ...meta(currency, hasMore, o.notes), rows };
}
