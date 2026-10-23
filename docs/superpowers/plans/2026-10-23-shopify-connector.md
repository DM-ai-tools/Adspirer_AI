# Shopify Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect a client's Shopify store read-only (token paste), sync its catalogue, stock and recent sales into Supabase, and give the workspace chat assistant free read access to that data next to GA4 and Meta.

**Architecture:** A per-client `shopify_connection` row (service-role only, token encrypted with the token vault) plus synced tables for collections, products and variants (sales aggregated per variant, no customer data). A small read-only GraphQL client with a mutation guard drives a bulk-operation sync. Three registry `diagnose` tools read the synced tables, are added to the writer's tool set only when the client has a synced store, and every result states the sync age. Same shape as the Google connection (`src/lib/google/assets.ts`, `google-connect-card.tsx`, `/api/admin/google/*`).

**Tech Stack:** Next.js (read `node_modules/next/dist/docs/` before any route handler), Supabase, zod, Vitest, plain `fetch`.

**Spec:** `docs/superpowers/specs/2026-10-20-shopify-benchmarks-capacity-design.md` (goals 1 and 4, calls 1a, 2, 3 and 8). **Deltas from the spec, agreed with Rithin on 2026-10-23:**
- Slice only: connector, sync, status UI and chat tools. Not built here: capacity check, benchmarks, margin feeding the plan, collection→category mapping, `margin_source`, `benchmark_industry`.
- Connect is token paste (spec call 1a) with a `shpat_` token for `duringdays.myshopify.com`. The Dev Dashboard client ID/secret and OAuth (call 1b) are not used.
- Chat tools are broader than the spec's 25 rows / 4 steps: up to 100 rows per call, available on every writer-tool turn when the client has a synced store (spec call 8's per-intent split is dropped).

## Global Constraints

- Read-only: the Shopify client sends only GraphQL `query` operations plus the `bulkOperationRunQuery` mutation. No other mutation, ever. A test asserts this.
- Windows are **30 and 60 days** (`read_orders` returns 60 days only; no `read_all_orders`).
- Scopes expected: `read_products`, `read_inventory`, `read_orders`.
- Money is integer cents; Shopify's decimal strings are converted with string maths, not float multiplication.
- No customer personal data stored or logged: no names, emails, addresses, phones. The orders query must not select any `customer`, `email`, `phone`, `shippingAddress` or `billingAddress` field (a test checks the query text).
- The access token is encrypted with `src/lib/security/token-vault.ts`, lives in a service-role-only table (no grants to `anon`/`authenticated`), and never appears in a response, log line, error message or the browser.
- Store address must be `<name>.myshopify.com` (lowercase, no scheme/path) or is rejected before any request is made (blocks SSRF).
- Stock: `inventory_quantity` is the available total across locations; `null` means untracked or sells at zero stock (policy `CONTINUE`), which is "unlimited", never 0. Negative quantities become 0.
- Every path works in DEMO_MODE (mock Shopify data for ClickTrends; connect makes no network call) and with Supabase.
- Migration is idempotent, number `00013`.
- HTTP follows `src/lib/google/http.ts`: timeout 25 s, 3 attempts, retry 429/5xx and network errors, log status and code only.
- Chat reads synced tables only; Shopify is called only by connect/sync. Every tool result carries `synced_at` and `synced_ago` (e.g. "3 hours ago"), and a note when older than 72 hours.
- Stage explicit paths; run `npx tsc --noEmit` and `npx vitest run` before each commit. Never `git add -A` (the working tree has unrelated untracked files).
- `SHOPIFY_API_VERSION` env, default = latest stable version found on shopify.dev at build time (verify; do not guess).

## Review Focus

1. **Store address abuse.** `https://evil.com`, `duringdays.myshopify.com.evil.com`, `DuringDays.MyShopify.com/admin`, empty string: only the clean form is accepted (normalised to lowercase, scheme/path stripped); anything not ending exactly in `.myshopify.com` is refused with no request sent. (Task 2)
2. **Sync fails midway.** Shopify throttles, the bulk operation fails or expires, or the token is revoked: the previously synced data stays, status becomes `error` with a plain message, and a revoked token says to reconnect. (Task 5)
3. **Orders with no variant.** Deleted products and custom line items have no variant: they are skipped and counted in the sync summary, never crash the sync. (Task 3)
4. **Missing cost / untracked stock.** A variant with no cost has `cost_cents = null` (not 0); untracked stock is `null` (not 0). Tools must not report these as zero cost or out of stock. (Tasks 3 and 8)
5. **Stale or absent data in chat.** No store connected: tools are not offered and the prompt line says Shopify isn't connected. Connected but never synced, or older than 72 h: the result says so rather than presenting numbers as current. (Task 9)

---

## File Structure

- Create `supabase/migrations/00013_shopify_connection.sql`: tables and RLS.
- Create `src/lib/shopify/types.ts`: row types and constants.
- Create `src/lib/shopify/domain.ts`: store address normalisation and money-to-cents helper.
- Create `src/lib/shopify/client.ts`: read-only GraphQL client with mutation guard, bulk operation start/poll/download.
- Create `src/lib/shopify/parse.ts`: pure JSONL → rows (catalogue and sales aggregation).
- Create `src/lib/shopify/mock.ts`: demo data for ClickTrends.
- Create `src/lib/shopify/store.ts`: persistence (demo store and Supabase): connection, catalogue replace, reads.
- Create `src/lib/shopify/sync.ts`: `connectShopify`, `syncShopify`, `disconnectShopify`, `getShopifyStatus`.
- Create `src/lib/shopify/query.ts`: pure read functions behind the chat tools.
- Create `src/lib/tools/diagnose/shopify-tools.ts`: the three registry tools.
- Create `src/app/api/admin/shopify/{connect,sync,disconnect,status}/route.ts` and `src/app/api/cron/shopify-sync/route.ts`.
- Create `src/components/connections/shopify-connect-card.tsx`.
- Modify: `src/lib/demo/store.ts` (shopify collections), `src/lib/config.ts`, `.env.example`, `src/lib/tools/policy.ts`, `src/lib/tools/display-labels.ts`, `src/lib/tools/diagnose/index.ts` (import the new file), `src/lib/agent/diagnose-tools-ai.ts`, `src/lib/agent/context-builder.ts`, `src/lib/agent/prompts-v2.ts`, `src/app/(app)/admin/connections/connections-client.tsx`.
- Tests: `tests/shopify-*.test.ts` (one per task as named below).

---

### Task 1: Schema, types, config and demo store

**Files:**
- Create: `supabase/migrations/00013_shopify_connection.sql`, `src/lib/shopify/types.ts`
- Modify: `src/lib/demo/store.ts`, `src/lib/config.ts`, `.env.example`
- Test: `tests/shopify-migration.test.ts` (model on `tests/google-migration.test.ts`)

**Interfaces:**
- Produces (`types.ts`):
  - `ShopifyConnection = { id; client_id; shop_domain; shop_name: string|null; currency: string|null; access_token_encrypted: string; scopes: string[]; connected_by: string|null; connected_at; last_sync_at: string|null; last_sync_status: "never"|"running"|"ok"|"error"; last_sync_error: string|null; last_sync_counts: ShopifySyncCounts|null; created_at; updated_at }`
  - `ShopifySyncCounts = { collections: number; products: number; variants: number; orders: number; skipped_line_items: number }`
  - `ShopifyCollection = { client_id; gid; handle; title; products_count: number }`
  - `ShopifyProduct = { client_id; gid; title; handle; vendor: string; product_type: string; status: "ACTIVE"|"DRAFT"|"ARCHIVED"; collection_gids: string[] }`
  - `ShopifyVariant = { client_id; gid; product_gid; title; sku: string|null; price_cents: number; cost_cents: number|null; inventory_quantity: number|null; units_30d: number; revenue_30d_cents: number; units_60d: number; revenue_60d_cents: number }`
  - `SHOPIFY_STALE_HOURS = 72`

- [ ] **Step 1: Write the failing test.** `shopify-migration.test.ts` asserts the SQL file: creates `shopify_connection`, `shopify_collections`, `shopify_products`, `shopify_variants` with `create table if not exists`; `shopify_connection` has `revoke all ... from anon, authenticated` and no select policy; the three data tables have a select policy using `has_client_access(client_id)`; and no column name contains `email`, `phone`, `address` or `customer`.
- [ ] **Step 2: Run** `npx vitest run tests/shopify-migration.test.ts`. Expected: FAIL (file missing).
- [ ] **Step 3: Write the migration** following `00012_google_connections.sql` conventions (idempotent, `set_updated_at` trigger, service-role grants). `shopify_connection.client_id` is `unique references clients(id) on delete cascade`. Data tables: primary key `(client_id, gid)`, `client_id references clients(id) on delete cascade`, plus `synced_run uuid not null` on each (used to drop rows missing from the latest sync). Products carry `collection_gids text[] not null default '{}'`. Index `shopify_variants (client_id, product_gid)`.
- [ ] **Step 4: Add `src/lib/shopify/types.ts`, a `shopifyConnections: ShopifyConnection[]`, `shopifyCollections`, `shopifyProducts`, `shopifyVariants` arrays to the demo store (empty by default), `SHOPIFY_API_VERSION` to the config schema (optional string), and the same name with a comment to `.env.example`.** Also `SHOPIFY_CRON` is not needed: the cron route reuses `CRON_SECRET`.
- [ ] **Step 5: Run** the test and `npx tsc --noEmit`. Expected: PASS, no type errors.
- [ ] **Step 6: Commit** `feat(shopify): schema, types and config`.

### Task 2: Store address, money and the read-only GraphQL client

**Files:**
- Create: `src/lib/shopify/domain.ts`, `src/lib/shopify/client.ts`
- Test: `tests/shopify-client.test.ts`

**Interfaces:**
- Produces (`domain.ts`): `normalizeShopDomain(input: string): string | null` (null when not exactly `<label>.myshopify.com` after trimming, lowercasing and stripping `https://` and any path/query; label `[a-z0-9][a-z0-9-]*`); `toCents(decimal: string | number | null | undefined): number | null` (string maths: `"19.99"`→1999, `"1,234.5"` is invalid→null, `"0"`→0).
- Produces (`client.ts`): `class ShopifyApiError extends Error { status: number; code: string | null }`; `shopifyGraphql<T>(shop: string, token: string, query: string, variables?: object): Promise<T>` (returns `data`; throws `ShopifyApiError` on HTTP error, GraphQL `errors`, or `THROTTLED` after retries); `SHOPIFY_READ_ONLY_MUTATIONS = ["bulkOperationRunQuery"]`; `startBulkQuery(shop, token, innerQuery): Promise<string>` (returns operation gid; throws a clear error if one is already running); `waitForBulkQuery(shop, token, gid, opts?: { intervalMs?: number; timeoutMs?: number }): Promise<{ url: string | null; objectCount: number }>` (null url = empty result); `downloadJsonl(url: string): Promise<Array<Record<string, unknown>>>`.
- Endpoint: `https://${shop}/admin/api/${version}/graphql.json`, header `X-Shopify-Access-Token`. Token only in the header.

- [ ] **Step 1: Write the failing tests** (fake `fetch`): `normalizeShopDomain("https://DuringDays.myshopify.com/admin")` → `"duringdays.myshopify.com"`; `"duringdays.myshopify.com.evil.com"`, `"evil.com"`, `""`, `"a b.myshopify.com"` → `null`; `toCents("19.99")`=1999, `toCents("0.1")`=10, `toCents("abc")`=null; `shopifyGraphql` with a document starting `mutation { productDelete ... }` rejects with `ShopifyApiError` code `READ_ONLY` and `fetch` is never called; a `mutation` of `bulkOperationRunQuery` is allowed; a 429 then 200 resolves; a `THROTTLED` error body retries; the token never appears in a thrown error message or in `logger.warn` arguments; `waitForBulkQuery` resolves on `COMPLETED`, throws on `FAILED`/`EXPIRED` with Shopify's `errorCode` in the message, and times out cleanly.
- [ ] **Step 2: Run** `npx vitest run tests/shopify-client.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both files. Mutation guard: parse the operation keyword; if `mutation`, every top-level field must be in `SHOPIFY_READ_ONLY_MUTATIONS`. Retry/log pattern copied from `src/lib/google/http.ts`.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shopify): read-only GraphQL client`.

### Task 3: Bulk queries and JSONL parsing

**Files:**
- Create: `src/lib/shopify/parse.ts`
- Test: `tests/shopify-parse.test.ts`

**Interfaces:**
- Consumes: `toCents` (Task 2), row types (Task 1).
- Produces:
  - `CATALOG_BULK_QUERY: string`, `ORDERS_BULK_QUERY(sinceIso: string): string`. Verify field names against shopify.dev for the pinned version. Catalogue selects: collections (id, handle, title, productsCount), products (id, title, handle, vendor, productType, status, collections ids), variants (id, title, sku, price, `inventoryItem { unitCost { amount }, tracked }`, `inventoryPolicy`, `inventoryQuantity`). Orders selects only: order id, `createdAt`, `cancelledAt`, `test`, and line items with `quantity`, `variant { id }`, `discountedTotalSet { shopMoney { amount } }`. Query filter excludes orders older than `sinceIso`.
  - `parseCatalog(clientId, lines): { collections: ShopifyCollection[]; products: ShopifyProduct[]; variants: Omit<ShopifyVariant, "units_30d"|"revenue_30d_cents"|"units_60d"|"revenue_60d_cents">[] }`
  - `aggregateSales(lines, now: Date): { byVariant: Map<string, { units_30d; revenue_30d_cents; units_60d; revenue_60d_cents }>; orders: number; skippedLineItems: number }`
- Bulk JSONL has children after parents with `__parentId`; parse by that.

- [ ] **Step 1: Write the failing tests** with small JSONL fixtures: a product with two variants and two collections gives `collection_gids` of 2 and 2 variants; a variant with null `unitCost` → `cost_cents` null; untracked inventory (`tracked:false`) → `inventory_quantity` null; policy `CONTINUE` → null; quantity -3 → 0; price `"1299.00"` → 129900. Sales: orders 10 and 45 days old fall in 60d only for the 45-day order and both for the 10-day one split correctly (30d includes only the 10-day order); a cancelled order and a `test` order are excluded; a line item with `variant: null` increments `skippedLineItems` and does not throw; two line items for the same variant add up. The two query strings contain none of `customer`, `email`, `phone`, `shippingAddress`, `billingAddress`.
- [ ] **Step 2: Run** `npx vitest run tests/shopify-parse.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the exported constants and functions as specified.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shopify): catalogue and sales parsing`.

### Task 4: Persistence and demo data

**Files:**
- Create: `src/lib/shopify/store.ts`, `src/lib/shopify/mock.ts`
- Modify: `src/lib/demo/store.ts` (seed nothing; arrays already added in Task 1)
- Test: `tests/shopify-store.test.ts` (demo store) and `tests/shopify-store-supabase.test.ts` (model on `tests/google-assets-supabase.test.ts`)

**Interfaces:**
- Produces (`store.ts`; each picks the demo store when `getConfig().isDemoMode || !hasSupabase`, else `createAdminClient()`):
  - `getConnection(clientId): Promise<ShopifyConnection | null>`
  - `saveConnection(input: { clientId; shopDomain; shopName; currency; scopes; accessTokenEncrypted; connectedBy }): Promise<ShopifyConnection>` (upsert on `client_id`)
  - `setSyncStatus(clientId, patch: { status: "running"|"ok"|"error"; error?: string|null; counts?: ShopifySyncCounts }): Promise<void>` (`ok` also sets `last_sync_at`)
  - `replaceCatalog(clientId, data: { collections; products; variants (with sales merged) }): Promise<void>`: upserts in chunks of 500 tagged with a new `synced_run`, then deletes that client's rows with a different `synced_run`. Nothing is deleted if an upsert throws.
  - `loadCatalog(clientId): Promise<{ collections; products; variants }>`
  - `deleteConnection(clientId): Promise<void>` (also deletes the client's synced rows)
- Produces (`mock.ts`): `mockShopifyCatalog(clientId: string)`: ClickTrends demo with collections "Bar stools" and "Sofas", about 6 products, mixed stock (one untracked, one at 0, one with no cost), vendors, and sales numbers. `MOCK_SHOP = { domain: "clicktrends-demo.myshopify.com", name: "ClickTrends", currency: "USD" }`.

- [ ] **Step 1: Write the failing tests.** Demo: save then get returns the row without needing a plaintext token; `replaceCatalog` twice with the second set missing a product removes it; a throwing upsert (Supabase fake) leaves old rows (no delete issued); `deleteConnection` removes synced rows. Assert `loadCatalog` for another client is unaffected.
- [ ] **Step 2: Run** both files. Expected: FAIL.
- [ ] **Step 3: Implement** `store.ts` and `mock.ts`.
- [ ] **Step 4: Run** the tests and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shopify): persistence and demo data`.

### Task 5: Connect, sync, disconnect, status

**Files:**
- Create: `src/lib/shopify/sync.ts`
- Test: `tests/shopify-sync.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces:
  - `connectShopify(input: { clientId: string; shopDomain: string; accessToken: string; connectedBy: string }): Promise<{ shopName: string; currency: string }>`: normalises the domain (throws `ValidationError` from `@/lib/errors` when invalid), requires the token to start `shpat_`, runs a `shop { name currencyCode }` query plus `currentAppInstallation { accessScopes { handle } }`, rejects with a plain message when any of the three scopes is missing, encrypts and saves. In demo mode no request is made and `MOCK_SHOP` is used.
  - `syncShopify(clientId: string, opts?: { now?: Date }): Promise<ShopifySyncCounts>`: sets status `running`, decrypts the token, runs the catalogue bulk query and the orders bulk query (sequentially: Shopify allows one at a time), parses, merges sales into variants (no sales → zeros), `replaceCatalog`, sets `ok`. On any failure sets `error` with a plain message (401/403 → "Shopify rejected the token: reconnect the store"; throttled/bulk busy → "Shopify is busy, try again in a few minutes"), leaves old data, rethrows. Demo mode uses `mockShopifyCatalog`.
  - `disconnectShopify(clientId): Promise<void>`
  - `getShopifyStatus(clientId): Promise<{ connected: boolean; shop_domain: string|null; shop_name: string|null; currency: string|null; last_sync_at: string|null; last_sync_status: string; last_sync_error: string|null; counts: ShopifySyncCounts|null }>`: never returns the token or ciphertext.
  - `syncAllShopify(): Promise<{ synced: number; failed: number }>` for cron (one failure doesn't stop the rest).

- [ ] **Step 1: Write the failing tests** (fake `fetch` through the client): connect rejects `evil.com` before any fetch; rejects a token not starting `shpat_`; rejects missing `read_orders`; saves ciphertext that is not the plaintext and decrypts back; sync happy path stores merged variants with sales; sync with a bulk `FAILED` keeps the previous catalogue and sets `last_sync_status` `error`; a 401 maps to the reconnect message; `getShopifyStatus` JSON contains neither the token nor `access_token_encrypted`; skipped line items are counted in `counts`.
- [ ] **Step 2: Run** `npx vitest run tests/shopify-sync.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `sync.ts`.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shopify): connect, sync and status`.

### Task 6: Admin and cron routes

**Files:**
- Create: `src/app/api/admin/shopify/connect/route.ts`, `.../sync/route.ts`, `.../disconnect/route.ts`, `.../status/route.ts`, `src/app/api/cron/shopify-sync/route.ts`
- Test: `tests/shopify-routes.test.ts` (model on `tests/google-auth-routes.test.ts`)

**Interfaces:**
- Consumes: `connectShopify`, `syncShopify`, `disconnectShopify`, `getShopifyStatus`, `syncAllShopify`.
- Produces: `POST /api/admin/shopify/connect` body `{ clientId, shopDomain, accessToken }` → `{ shopName, currency }`; `POST .../sync` body `{ clientId }` → counts (`export const maxDuration = 800`); `POST .../disconnect` body `{ clientId }`; `GET .../status?clientId=` → status. All admin-only with the `withApiHandler`/`assertAdmin` pattern from `src/app/api/admin/google/*`. `POST /api/cron/shopify-sync` is a copy of the monitoring cron's `CRON_SECRET` Bearer check running `syncAllShopify`.
- Read the Next docs under `node_modules/next/dist/docs/` for the route handler conventions before writing these.

- [ ] **Step 1: Write the failing tests:** non-admin → 403 on all four; unauthenticated → 401; bad body → 400 with the token not echoed in the response; the connect response and the status response never contain the submitted token; cron without or with a wrong secret → 401, with the right secret → 200 and `syncAllShopify` called; cron with `CRON_SECRET` unset → 401.
- [ ] **Step 2: Run** `npx vitest run tests/shopify-routes.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the five routes.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shopify): admin and cron routes`.

### Task 7: Connections card

**Files:**
- Create: `src/components/connections/shopify-connect-card.tsx`
- Modify: `src/app/(app)/admin/connections/connections-client.tsx` (render it after `GoogleConnectCard`)
- Test: `tests/shopify-card.test.ts` only if the repo has a component-test pattern for the Google card; otherwise verify in the browser (Step 4).

**Interfaces:**
- Consumes: the routes from Task 6, `apiFetch`/`formatRelative` from `src/lib/api-client.ts`, `Client` type.
- Produces: `ShopifyConnectCard({ clients }: { clients: Client[] })`. Per client row: status badge (Not connected / Syncing / Synced <relative> / Error with message), and actions. Connect opens a small form: store address (prefilled `.myshopify.com` hint) and a password-type token field; after connect succeeds the card immediately calls sync, shows a toast with the counts, and clears the token from state. "Sync now" and "Disconnect" (with confirm). Text explains the token needs read-only `read_products`, `read_inventory`, `read_orders`. Follow the Google card's styles and toast usage.

- [ ] **Step 1: Build the card** following `google-connect-card.tsx`.
- [ ] **Step 2: Run** `npx tsc --noEmit` and `npx eslint` on the two files. Expected: clean.
- [ ] **Step 3: Run the app in DEMO_MODE** (use the `run` skill), open Admin → Connections, connect ClickTrends with any `*.myshopify.com` and a `shpat_test` token, confirm status shows synced with mock counts, then Sync now, then Disconnect.
- [ ] **Step 4: Commit** `feat(shopify): connections card`.

### Task 8: Read queries over the synced data

**Files:**
- Create: `src/lib/shopify/query.ts`
- Test: `tests/shopify-query.test.ts`

**Interfaces:**
- Consumes: `loadCatalog`, `getConnection` (Task 4).
- Produces (all return `{ synced_at: string|null; synced_ago: string|null; stale: boolean; currency: string|null; note?: string; ... }`, money in major units rounded to 2 dp, `null` for unknown):
  - `queryProducts(clientId, args: { search?: string; collection?: string; vendor?: string; product_type?: string; status?: "ACTIVE"|"DRAFT"|"ARCHIVED"; sort_by?: "units_30d"|"revenue_30d"|"units_60d"|"revenue_60d"|"stock"|"title"; desc?: boolean; limit?: number }): { rows: Array<{ title; vendor; product_type; status; collections: string[]; variants: number; stock_units: number|null; untracked_variants: number; price_min; price_max; units_30d; revenue_30d; units_60d; revenue_60d }>; total_matches: number }` (limit default 25, max 100; `collection` matches collection title or handle case-insensitively)
  - `queryVariants(clientId, args: { sku?: string; search?: string; collection?: string; vendor?: string; sort_by?: "units_30d"|"revenue_30d"|"stock"|"price"; desc?: boolean; limit?: number })`: rows `{ product; variant; sku; vendor; price; cost; margin_pct: number|null; stock: number|null; units_30d; revenue_30d; units_60d; revenue_60d }`; `sku` is an exact case-insensitive match.
  - `summarizeCatalog(clientId, args: { group_by: "vendor"|"product_type"|"collection" })`: rows `{ group; products; variants; stock_units; units_30d; revenue_30d; units_60d; revenue_60d; margin_pct: number|null }` where `margin_pct` = (Σ revenue − Σ cost×units) ÷ Σ revenue over variants that have a cost and sales, plus `cost_coverage` text like "cost known for 12 of 15 variants sold". A product in several collections counts in each when grouping by collection (say so in `note`).
  - Each result says "Sales are gross of refunds and exclude cancelled and test orders; windows are the last 30 and 60 days."
  - Not connected → `{ connected: false, message }`; connected, never synced → `{ connected: true, synced_at: null, message: "…not synced yet" }`; older than `SHOPIFY_STALE_HOURS` → `stale: true` with a note.

- [ ] **Step 1: Write the failing tests** on a seeded demo catalogue: sort and limit (limit 500 is clamped to 100); `sku` lookup is exact and case-insensitive; a variant with null cost has `cost` and `margin_pct` null (not 0); a null-stock variant is counted in `untracked_variants` and not added into `stock_units`; margin and `cost_coverage` computed correctly in `summarizeCatalog`; an unknown collection returns zero rows and a note listing the available collection titles; `synced_ago` reads "3 hours ago" for a sync 3 h before a fixed `now`; 80 h old → `stale` true.
- [ ] **Step 2: Run** `npx vitest run tests/shopify-query.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `query.ts` (accept an optional `now: Date` for tests).
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shopify): read queries for chat`.

### Task 9: Chat tools and wiring

**Files:**
- Create: `src/lib/tools/diagnose/shopify-tools.ts`
- Modify: `src/lib/tools/diagnose/index.ts` (import it), `src/lib/tools/policy.ts` (the three names → `"diagnose"`), `src/lib/tools/display-labels.ts` (labels and progress labels: "Shopify products", "Shopify variants / SKUs", "Shopify summary"; "Reading Shopify…"), `src/lib/agent/diagnose-tools-ai.ts`, `src/lib/agent/context-builder.ts`, `src/lib/agent/prompts-v2.ts`
- Test: `tests/shopify-tools.test.ts` (model on `tests/workspace-data-tools.test.ts`)

**Interfaces:**
- Consumes: `queryProducts`, `queryVariants`, `summarizeCatalog` (Task 8).
- Produces: registry tools `shopify_products`, `shopify_variants`, `shopify_summary` (zod schemas mirroring the query args; the client is always `ctx.clientId`, never an argument). Each follows the data-tools convention: errors come back as `{ error: true, source: "Shopify", message }`, never thrown.
- In `diagnose-tools-ai.ts`: add `SHOPIFY_TOOLS = ["shopify_products","shopify_variants","shopify_summary"]`; `buildWorkspaceReadToolSet(ctx)` stays synchronous, so add `export async function buildWorkspaceReadToolSetForClient(ctx): Promise<ToolSet>` that returns the base set plus the Shopify tools when `getConnection(ctx.clientId)` exists, and make the writer call it. Find the writer call site with `grep -rn buildWorkspaceReadToolSet src` and switch it. `workspaceReadToolNames` is unchanged for the base list.
- `context-builder.ts`: in the "Connected data" block add one line: `Shopify: <shop name> (<domain>), last synced <ago>` or `Shopify: not connected`.
- `prompts-v2.ts` data-tools section: add the Shopify tools to the list; tell the model to use Shopify for SKUs, stock, vendors, cost, collections and Shopify-recorded sales, to cross-check GA4 and Meta figures against it (state the source of each number and say when sources disagree, with the likely reason, e.g. GA4 attribution vs order data), to quote `synced_ago`, and to never say Shopify data is unavailable when Connected data shows it connected.

- [ ] **Step 1: Write the failing tests:** all three are `diagnose` class with labels; the tool set for a client with no connection lacks them, and for a connected client includes them; `shopify_products` for ClickTrends returns rows with `synced_ago`; calling with `limit: 500` is rejected or clamped to 100; a thrown query error becomes `{ error: true, source: "Shopify" }`; the system prompt and context-builder output mention Shopify (connected and not connected cases); the three tools exist in `workspaceReadToolNames()` only via the Shopify path, so existing tests that snapshot the base allowlist still pass.
- [ ] **Step 2: Run** `npx vitest run tests/shopify-tools.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the tools file and the wiring edits above.
- [ ] **Step 4: Run** `npx vitest run tests/shopify-tools.test.ts tests/workspace-data-tools.test.ts`. Expected: PASS (existing Google/Meta tool tests unchanged).
- [ ] **Step 5: Commit** `feat(shopify): chat tools and prompt wiring`.

### Task 10: Docs, full verification, live check

**Files:**
- Modify: `.env.example` (comment on `SHOPIFY_API_VERSION`, no secrets), `README.md` (a short "Shopify connection" note if the README documents Google).

- [ ] **Step 1: Run** `npx tsc --noEmit`, `npx eslint src tests`, `npx vitest run`. Expected: all green.
- [ ] **Step 2: Apply migration `00013`** to the Supabase project (Rithin's decision on when; check how `00012` was applied) and confirm the four tables exist.
- [ ] **Step 3: Live connect** on the real DuringDays client: Rithin enters `duringdays.myshopify.com` and the `shpat_` token in the Connections card himself (the token is never pasted in chat). Confirm status "Synced", counts plausible against the Shopify admin (collections, products, a spot-checked SKU's stock and price).
- [ ] **Step 4: Chat check** in the DuringDays workspace: "top 10 products by units sold in the last 30 days", "stock and cost for SKU <real sku>", "revenue by vendor, and compare with GA4 best sellers". Confirm each cites Shopify, states the sync age, and cross-checks GA4/Meta where asked.
- [ ] **Step 5: Add the nightly cron** (`POST /api/cron/shopify-sync` with the `CRON_SECRET` bearer, same Railway pattern as monitoring) once the live sync is confirmed.
- [ ] **Step 6: Commit** `docs(shopify): env and readme`. Merge to `main` only when Rithin asks.
