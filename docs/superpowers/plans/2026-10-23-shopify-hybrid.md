# Shopify Hybrid (live lookups + synced sales) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the full-catalogue Shopify sync (its bulk result for duringdays.myshopify.com exceeds 512 MB) with live read-only Shopify lookups for products, SKUs, stock, price, cost and vendor, plus a small nightly sales sync (per-variant units and revenue, last 30 and 60 days) that keeps the chat's sales answers fast.

**Architecture:** The connection, token vault, read-only GraphQL client, admin routes and card from the connector plan stay. The sync shrinks to one orders bulk read (streamed, aggregated per variant with the product title, SKU, vendor and product type taken from the order lines) written to a new `shopify_sales` table. Three chat tools change: `shopify_products` and `shopify_variants` call Shopify live (targeted, capped GraphQL `query` operations through the same read-only client); `shopify_sales` reads the synced sales table. The catalogue tables from migration 00013 stay in place, unused.

**Tech Stack:** Next.js, Supabase, zod, Vitest, plain `fetch`, Shopify Admin GraphQL (version `2026-10`).

**Builds on:** `docs/superpowers/plans/2026-10-23-shopify-connector.md` (merged) and branch `shopify-stream-bulk` (streaming download `streamJsonl` and incremental builders `createCatalogBuilder` / `createSalesAggregator` in `src/lib/shopify/parse.ts`, MAX_BULK_OBJECTS cap, bulk read logging). This plan starts from that branch's head.

## Global Constraints

- Read-only: the Shopify client sends only GraphQL `query` operations plus the `bulkOperationRunQuery` mutation (orders read). The existing mutation guard stays; live lookups use plain `query` operations only.
- Windows are 30 and 60 days (`read_orders` returns 60 days only). Sales are line revenue after product and code discounts, before order-level discounts, shipping and tax, gross of refunds, cancelled and test orders excluded, rolling from the sync time. Every sales result says so and states `synced_ago`.
- No customer personal data stored or logged: the orders query selects no `customer`, `email`, `phone`, `shippingAddress` or `billingAddress` field (a test checks the query text), and the sales table has no such columns.
- The access token never appears in a response, log line, status, tool result, prompt or browser. Live calls decrypt it per call inside the server only. Errors returned to the model are fixed, plain text: never Shopify's raw body.
- Money is integer cents in storage; tool output is major units rounded to 2 dp, converted without float drift.
- Stock rules: `inventory_quantity` null (untracked, or policy `CONTINUE`) means unlimited, never 0 and never summed as stock. Missing cost is null, never 0.
- Live lookups never exceed Shopify's per-query cost limit (check `extensions.cost` on a sample query in tests/doc review) and are capped: at most 25 products or variants per call (default 10), at most 2 Shopify requests per tool call. A THROTTLED reply is retried by the client; a persistent throttle returns a plain "Shopify is busy" error to the model.
- Search text from the model is escaped before it goes into a Shopify search string (quotes, backslashes, colons, parentheses) so it cannot add filters or break the query.
- Tool inputs use zod enums for sort/group fields, trimmed strings capped at 200 characters, and no client id or shop domain argument (the client is always `ctx.clientId`).
- Every data path works in DEMO_MODE (mock live results and mock sales for ClickTrends; no network) and with Supabase. Migration `00014` is idempotent. Stage explicit paths only; run `npx tsc --noEmit`, `npx eslint` on changed files (0 errors) and `npx vitest run` before each commit.
- Chat tools are added only when the client has a Shopify connection (existing behaviour). When the connection exists but sales were never synced, `shopify_sales` says so plainly; the live tools still work.

## Review Focus

1. **Live query cost and abuse.** A model asking for 100 variants of a 500-variant product, or a search string like `a" OR vendor:x`: results stay capped, the search string cannot inject filters, and a query that would exceed Shopify's cost limit is avoided by construction. (Tasks 3, 4)
2. **Sales keyed by variant when the variant was deleted.** Order lines whose variant or product is gone have no `variant.id`: they still count under a synthetic key (product title + SKU) only if the product id exists, otherwise they are skipped and counted, never crash. (Task 1)
3. **Live data vs synced data disagreement.** A tool answer mixing live stock with 60-day sales labels each source and its age; the prompt tells the model to say which number came from where. (Task 4)
4. **Shopify unreachable or token revoked at question time.** The live tools return a plain "couldn't reach Shopify / reconnect the store" error, never a stack or raw body, and never mark the connection as failed. (Tasks 3, 4)
5. **Existing synced data from the old catalogue sync.** None exists in production (the first sync failed); but any `shopify_collections/products/variants` rows must not be read by the new tools or break the card counts. (Task 2)

---

## File Structure

- Create `supabase/migrations/00014_shopify_sales.sql`: `shopify_sales` table, RLS like 00013.
- Modify `src/lib/shopify/types.ts`: `ShopifySalesRow`; `ShopifySyncCounts` becomes `{ orders; sales_variants; skipped_line_items }` (old fields optional/removed, status and card updated).
- Modify `src/lib/shopify/parse.ts`: new `ORDERS_BULK_QUERY` fields, sales aggregator emits `ShopifySalesRow[]`; remove `CATALOG_BULK_QUERY` and the catalogue builder.
- Modify `src/lib/shopify/store.ts`, `mock.ts`: sales persistence (`replaceSales`, `loadSales`) replacing catalogue persistence; demo data.
- Modify `src/lib/shopify/sync.ts`: orders-only sync.
- Create `src/lib/shopify/live.ts`: live read-only lookups (`liveFindProducts`, `liveLookupVariants`, `liveListCollections`).
- Modify `src/lib/shopify/query.ts`: replace catalogue queries with `querySales`; keep the freshness/notes helpers.
- Modify `src/lib/tools/diagnose/shopify-tools.ts`, `src/lib/agent/prompts-v2.ts`, `src/lib/agent/context-builder.ts`, `src/components/connections/shopify-connect-card.tsx` and the tests under `tests/shopify-*.test.ts`.

---

### Task 1: Sales schema, orders query, aggregation

**Files:**
- Create: `supabase/migrations/00014_shopify_sales.sql`
- Modify: `src/lib/shopify/types.ts`, `src/lib/shopify/parse.ts`
- Test: `tests/shopify-migration.test.ts` (add 00014 cases), `tests/shopify-parse.test.ts`

**Interfaces:**
- Produces:
  - `ShopifySalesRow = { client_id: string; variant_key: string; variant_gid: string | null; product_gid: string | null; product_title: string; variant_title: string | null; sku: string | null; vendor: string; product_type: string; units_30d: number; revenue_30d_cents: number; units_60d: number; revenue_60d_cents: number }` (`variant_key` = variant gid, else `product:<product gid>:<sku or title>`).
  - `ORDERS_BULK_QUERY(sinceIso: string): string` selecting per line item: `quantity`, `title`, `variantTitle`, `sku`, `vendor`, `variant { id }`, `product { id productType }` (non-connection objects) and `discountedTotalSet(withCodeDiscounts: true) { shopMoney { amount } }`; no customer fields.
  - `createSalesAggregator(now: Date): { push(line): void; finish(): { rows: Omit<ShopifySalesRow, "client_id">[]; orders: number; skippedLineItems: number } }` (the existing builder from branch `shopify-stream-bulk`, extended to carry the product metadata; keep the order-window and cancelled/test rules).
- Migration: `shopify_sales` with primary key `(client_id, variant_key)`, `synced_run uuid not null`, bigint cents, no PII columns, select policy `has_client_access(client_id)`, service-role writes, idempotent.

- [ ] **Step 1: Write failing tests:** the migration test asserts `shopify_sales` columns, PK, policy and no PII-named columns; parse tests: two lines of the same variant add up per window; a line with no variant but a product id and SKU gets the synthetic key; a line with neither is skipped and counted; vendor/product type/title/sku come through; cancelled and test orders excluded; 30-day boundary inclusive; the query text still contains none of `customer`, `email`, `phone`, `shippingAddress`, `billingAddress` and contains `withCodeDiscounts: true`.
- [ ] **Step 2: Run** `npx vitest run tests/shopify-parse.test.ts tests/shopify-migration.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the migration, types, query and aggregator. Verify field availability (`LineItem.title`, `variantTitle`, `sku`, `vendor`, `product`, `Product.productType`) and the bulk nesting rules against shopify.dev 2026-10 (orders → lineItems is 1 connection, depth 1; the `product` and `variant` objects are not connections).
- [ ] **Step 4: Run** the tests and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shopify): sales schema and per-variant sales aggregation`.

### Task 2: Orders-only sync, sales persistence, card counts

**Files:**
- Modify: `src/lib/shopify/store.ts`, `src/lib/shopify/mock.ts`, `src/lib/shopify/sync.ts`, `src/lib/shopify/types.ts`, `src/components/connections/shopify-connect-card.tsx`, `src/lib/demo/store.ts` (add `shopifySales`; bump `DEMO_STORE_VERSION`)
- Test: `tests/shopify-store.test.ts`, `tests/shopify-store-supabase.test.ts`, `tests/shopify-store-paging.test.ts`, `tests/shopify-sync.test.ts`, `tests/shopify-routes.test.ts`

**Interfaces:**
- Consumes: `createSalesAggregator`, `ORDERS_BULK_QUERY`, `streamJsonl`, `ShopifySalesRow` (Task 1).
- Produces:
  - `replaceSales(clientId: string, rows: Omit<ShopifySalesRow, "client_id">[]): Promise<void>` (chunked upsert tagged with a fresh `synced_run`, then delete the client's rows with another run; nothing deleted if an upsert throws) and `loadSales(clientId): Promise<ShopifySalesRow[]>` (paged by `.order("variant_key").range(...)` past the 1000-row cap).
  - `syncShopify(clientId, opts?)`: sets running, streams the orders bulk read into the aggregator (heartbeat while streaming, stage `"orders bulk read"`), `replaceSales`, status ok with `ShopifySyncCounts = { orders; sales_variants; skipped_line_items }`. No catalogue read, no catalogue writes, no empty-products rule (an empty orders result is a valid "no sales" sync). `MAX_BULK_OBJECTS` check stays for the orders operation.
  - `mockShopifySales(clientId)` for ClickTrends in demo mode.
  - `deleteConnection` and the store-switch reset also clear `shopify_sales` for the client.
- The card shows counts as "N sold variants from M orders (last 60 days)" and says the catalogue is read live.

- [ ] **Step 1: Write failing tests:** `replaceSales` replace-then-delete semantics, failed upsert keeps old rows, paging past 1000 rows via a capped fake, deleteConnection and domain-change reset clear sales; `syncShopify` happy path writes sales and counts and issues exactly one bulk operation (assert the fetch calls: no catalogue query), an empty orders result succeeds with 0 sales variants, failure keeps old sales and stores fixed text, heartbeats during streaming, stage names in the failure log; routes tests updated for the new counts shape; the status response still has no token or ciphertext.
- [ ] **Step 2: Run** the listed test files. Expected: FAIL.
- [ ] **Step 3: Implement** the persistence, sync and card changes; remove the now-unused catalogue persistence (`replaceCatalog`, `loadCatalog`, catalogue demo data) and `parseCatalog`/`createCatalogBuilder`/`CATALOG_BULK_QUERY` along with their tests. The 00013 catalogue tables remain in the database untouched.
- [ ] **Step 4: Run** `npx tsc --noEmit`, `npx eslint` on changed files and the Shopify tests. Expected: PASS, 0 errors. Check the card in the browser in DEMO_MODE (connect, counts text, sync, disconnect) as in the connector plan Task 7.
- [ ] **Step 5: Commit** `feat(shopify): orders-only sales sync`.

### Task 3: Live read-only Shopify lookups

**Files:**
- Create: `src/lib/shopify/live.ts`
- Test: `tests/shopify-live.test.ts`

**Interfaces:**
- Consumes: `shopifyGraphql`, `getConnection`, `decryptToken`, `ShopifyApiError`.
- Produces (all take `clientId` and resolve the connection and token themselves; none take a shop or token argument):
  - `liveFindProducts(clientId, args: { search?: string; vendor?: string; product_type?: string; collection?: string; status?: "ACTIVE"|"DRAFT"|"ARCHIVED"|"UNLISTED"; sort_by?: "best_selling"|"title"|"inventory"|"updated"; desc?: boolean; limit?: number }): Promise<LiveProductsResult>` using the `products(first:, query:, sortKey:, reverse:)` connection with nested `variants`. `collection` is resolved first through `collections(first: 5, query: "title:…")` and used as `collection_id:` in the product search; an unknown collection returns no rows and a note listing close collection titles.
  - `liveLookupVariants(clientId, args: { sku?: string; search?: string; vendor?: string; limit?: number }): Promise<LiveVariantsResult>` using `productVariants(first:, query:)`; `sku` is an exact match (verify the filter semantics in the docs and say in the result when Shopify's `sku:` filter is a prefix or partial match).
  - `escapeShopifySearch(text: string): string` quoting/escaping so user text cannot add filters.
  - Result rows (major units): product `{ title; vendor; product_type; status; handle; variants: n; stock_units: number | null; untracked_variants: number; price_min; price_max }` and variant `{ product; variant; sku; vendor; price; cost; margin_pct; stock }` with null cost/stock rules; every result carries `source: "Shopify (live)"`, `fetched_at`, `currency`, and a `note` for caps (limit clamp 1..25, default 10), unknown filters and empty results (which filters were used, available vendors/types are NOT listed because that needs the catalogue).
  - Errors: `LiveShopifyError` with fixed text (not connected; token rejected → reconnect; Shopify busy; Shopify unreachable; access to cost denied → cost shown as unavailable rather than failing the whole call). Never marks the connection failed, never logs the token; failures log clientId, status and code only.
- Cost control: the queries request at most 25 products × 25 variants and no more than the documented 1000-point single-query limit (compute from the connection sizes and assert it in a test); a result with more variants than requested says "showing first N variants".

- [ ] **Step 1: Write failing tests** with a fake `fetch`: the exact GraphQL document sent for a plain search and for a collection filter (assert `query:` strings and `first:` values); `escapeShopifySearch('a" OR vendor:x')` cannot produce an extra filter; limit 500 is clamped to 25; a null `unitCost` gives cost and margin null; untracked stock stays null and is not summed; 401 → reconnect text; THROTTLED then success retries (via the client); persistent throttle → busy text; network failure → unreachable text; the token appears in no thrown message or log call; connection missing → not-connected text; demo mode returns mock rows with no fetch.
- [ ] **Step 2: Run** `npx vitest run tests/shopify-live.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `live.ts`. Verify against shopify.dev 2026-10: `products` search syntax (`sku`, `vendor`, `product_type`, `status`, `collection_id`, title wildcard), `sortKey` values (`BEST_SELLING`, `INVENTORY_TOTAL`, `TITLE`, `UPDATED_AT`), `productVariants` query filters, `collections(query:)`, and cost accounting (`extensions.cost`). Record sources in the commit body.
- [ ] **Step 4: Run** the tests, `npx tsc --noEmit`, eslint. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shopify): live read-only product and variant lookups`.

### Task 4: Chat tools, prompt and context

**Files:**
- Modify: `src/lib/shopify/query.ts` (replace catalogue queries with `querySales`), `src/lib/tools/diagnose/shopify-tools.ts`, `src/lib/tools/policy.ts`, `src/lib/tools/display-labels.ts`, `src/lib/agent/diagnose-tools-ai.ts` (tool names), `src/lib/agent/prompts-v2.ts`, `src/lib/agent/context-builder.ts`
- Test: `tests/shopify-query.test.ts`, `tests/shopify-tools.test.ts`

**Interfaces:**
- Consumes: `liveFindProducts`, `liveLookupVariants` (Task 3), `loadSales`, `getConnection` (Task 2).
- Produces:
  - `querySales(clientId, args: { search?: string; vendor?: string; product_type?: string; sku?: string; group_by?: "variant"|"product"|"vendor"|"product_type"; window?: 30|60; sort_by?: "units"|"revenue"; desc?: boolean; limit?: number }, now?: Date)`: rows `{ group; vendor; product_type; sku; units; revenue; units_other_window… }` aggregated from `shopify_sales` with limit default 25 max 100; plus `synced_at`, `synced_ago`, `stale`, the exact sales-definition note, a note when never synced / stale / the latest sync failed, and the "collection filter is not available for sales; use shopify_products with collection" note.
  - Registry tools (diagnose class): `shopify_products` (live; args of `liveFindProducts`), `shopify_variants` (live; args of `liveLookupVariants`), `shopify_sales` (synced; args of `querySales`). The old `shopify_summary` is removed. Errors come back as `{ error: true, source: "Shopify", message }` with fixed text.
- Prompt (Data tools section): `shopify_products` and `shopify_variants` read Shopify live (current stock, price, cost, vendor); `shopify_sales` reads last-30/60-day sales synced nightly (state its age); use them to cross-check GA4 and Meta (name the source and age of each number; when Shopify and GA4 disagree say so with the likely reason); never say Shopify is unavailable when Connected data shows it connected; when not connected say an admin can connect it under Admin → Connections.
- Context line: `Shopify: <shop name> (<domain>), catalogue read live, sales synced <ago>` / `…sales not synced yet` / `…latest sales sync failed` / `Shopify: not connected`.

- [ ] **Step 1: Write failing tests:** the three tools are diagnose class with labels, offered only for a connected client, `shopify_summary` gone; `shopify_products` tool calls the live layer with `ctx.clientId` (spy) and never a client argument (zod strips it); `querySales` grouping by vendor sums correctly, sku match is exact, sort/limit clamp, notes for never-synced, stale (>72 h), failed latest sync, collection-filter note; money rounding 1999 cents → 19.99; live errors become `{ error: true, source: "Shopify" }`; prompt and context mention live vs synced in both connected and not-connected cases; existing workspace tool tests still pass.
- [ ] **Step 2: Run** `npx vitest run tests/shopify-query.test.ts tests/shopify-tools.test.ts tests/workspace-data-tools.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the tools, query layer and prompt/context changes; delete the replaced catalogue query code and its tests.
- [ ] **Step 4: Run** the tests, `npx tsc --noEmit`, eslint on changed files, then the full `npx vitest run`. Expected: all pass, 0 lint errors.
- [ ] **Step 5: Commit** `feat(shopify): live lookup tools and synced sales tool`.

### Task 5: Verification

- [ ] **Step 1: Run** `npx tsc --noEmit`, eslint on every changed file and the full `npx vitest run`. Expected: all green.
- [ ] **Step 2 (Rithin):** apply migration `00014`, redeploy, **Sync now** for During Days (the orders-only sync), confirm counts; ask in chat: "stock and price for SKU <real sku>", "top 10 products by units in the last 30 days", "revenue by vendor, compared with GA4 best sellers".
- [ ] **Step 3: Commit** nothing further; merge to `main` only when Rithin asks.
