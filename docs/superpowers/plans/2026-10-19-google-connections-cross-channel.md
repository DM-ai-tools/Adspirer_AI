# Google Connections and Cross-Channel Plan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect one agency Google login with read-only access to GA4, Google Ads and Search Console, map those assets per client, and use them to answer Karthik's bar stool question. The tool reconciles revenue against GA4, shows Google spend and search demand, and the strategy recommends a Meta/Google budget split. It only ever changes Meta.

**Architecture:**
- **`src/lib/google/`** holds the Google integration:
  - plain-fetch clients for OAuth, Google Ads (query-only), GA4 Data/Admin and Search Console;
  - asset sync and mapping, stored in two new tables;
  - a `GoogleDataProvider` with live and mock implementations;
  - a per-turn `ChannelSnapshot`.
- **The strategy module gains:**
  - a shared category matcher;
  - `channels.ts`, which merges Meta attribution, GA4 and Google Ads per category;
  - a small Google capability list;
  - a channel-aware, category-scopable plan engine.
- **The brief** learns total budgets ("spend $4k and get $40k back").
- **Render and the agent** add the GA4/Google evidence and the split.
- **The Connections page** gets a Google card.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, zod 4, Supabase plus the DEMO_MODE in-memory store, plain `fetch`, and Vitest. No new dependencies.

**Spec:**
- Design: [`docs/superpowers/specs/2026-10-19-google-connections-cross-channel-design.md`](../specs/2026-10-19-google-connections-cross-channel-design.md), including its "Calls made after the builder check" section.
- Call notes: [`docs/strategy/2026-10-16-karthik-strategy-call.md`](../../strategy/2026-10-16-karthik-strategy-call.md).

## Global Constraints

- **Read-only on Google.** No code path may call a Google mutate endpoint. The Google Ads client exposes only `searchGaql` and `listAccessibleCustomers`. Nothing under `src/` contains `:mutate`, `/mutate` or `customers/{id}/campaigns` write calls.
- **Environment variables.** Code runs without them; Google then shows "not configured".
  - `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_ADS_DEVELOPER_TOKEN`
  - `GOOGLE_ADS_LOGIN_CUSTOMER_ID` (digits only; the preferred manager)
  - `GOOGLE_ADS_API_VERSION` (optional)
  - `hasGoogle` = client id and secret both set; `hasGoogleAds` = `hasGoogle` and developer token set.
- **Redirect URI** is `${APP_URL}/api/auth/google/callback`.
- **Scopes:** `openid email https://www.googleapis.com/auth/analytics.readonly https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/adwords`, requested with `access_type=offline&prompt=consent&include_granted_scopes=true`.
- **Tokens.**
  - The refresh token is encrypted with `encryptToken` / `decryptToken` from `src/lib/security/token-vault.ts`.
  - Access tokens live only in memory.
  - No token appears in logs, URLs, API responses or the browser.
- **Admin only.** Every Google connect, disconnect, sync and map route calls `assertAdmin`. Reads of a client's mapped assets call `assertClientAccess`.
- **Money and units.**
  - Money is integer cents. Google Ads micros convert at the edge: `cents = Math.round(micros / 10_000)`. GA4 currency units convert as `Math.round(value * 100)`.
  - ROAS is a plain multiple rounded to 2 decimals; margins are percent.
- **Currencies are never mixed.** If a client's GA4, Google Ads and Meta currencies differ, there are no combined totals, combined ROAS or channel split, and the report says why.
- **DEMO_MODE works end to end** through the mock Google provider and the demo store. ClickTrends (ecommerce, Bar stools and Sofas) gets a granted demo Meta account with ecommerce ads and mapped demo Google assets.
- **Migration** is `supabase/migrations/00012_google_connections.sql`, idempotent.
- **HTTP calls** follow `src/lib/meta/graph-client.ts`:
  - 25s `AbortSignal.timeout`;
  - up to 3 retries with backoff and jitter on 429/5xx/network errors;
  - Bearer header;
  - a typed `GoogleApiError { status, code, message }`;
  - non-JSON error bodies tolerated.
- **Engineering rules.**
  - Read `node_modules/next/dist/docs/` before writing route handlers (AGENTS.md).
  - `npm run typecheck` and the full `npm test` pass before every commit; never run them concurrently.
  - Stage explicit paths; never `git add -A`. The tree has untracked user files and `.playwright-mcp/`.
  - Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - Files are UTF-8.
  - Never start a dev server or kill processes you didn't start.
- **Plain user-facing copy.** "Category" for ecommerce clients, "service" otherwise. Any Google recommendation is labelled "recommendation for the Google Ads account — this tool doesn't change Google".

## Review Focus

1. **Google says no refresh token** (re-consent without `prompt=consent`, or an app already authorised). The callback stores nothing and redirects with `google_error=no_refresh_token` and a plain fix. Test in Task 3.
2. **The refresh token is revoked** (`invalid_grant`). `getGoogleAccessToken` throws `GoogleReconnectRequired`, status reports `needsReconnect: true`, and the strategy evidence shows "Google needs reconnecting" rather than silently dropping Google. Tests in Tasks 2 and 13.
3. **GA4 has no purchase items.** The method falls back to landing pages. If that returns nothing too, the method is `"none"`, and GA4 counts as not available for the plan, which uses platform-reported figures and says so. Tests in Tasks 5 and 9.
4. **A client whose Meta, GA4 and Google Ads currencies differ** (for example AUD Meta, USD GA4). There are no combined figures and no split, and a reason line appears. Tests in Tasks 9 and 11.
5. **One Google part fails** (Ads quota error) while GA4 works. The snapshot keeps GA4, adds a warning, and the evidence prints it. Tests in Tasks 7 and 13.

---

### Task 1: Config, migration and Google types

**Files:**
- Modify: `src/lib/config.ts` (zod `envSchema` ~L13-57, `readRawEnv` ~L70-105, `AppConfig` ~L59-68, flags ~L129-133)
- Modify: `.env.example` (new `# --- Google (read-only: GA4, Google Ads, Search Console) ---` block)
- Create: `supabase/migrations/00012_google_connections.sql`
- Create: `src/lib/google/types.ts`
- Test: `tests/google-config.test.ts`

**Interfaces:**
- Produces: `AppConfig` gains `hasGoogle: boolean` and `hasGoogleAds: boolean`, plus `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_LOGIN_CUSTOMER_ID` and `GOOGLE_ADS_API_VERSION` (all `string | undefined`).
- Produces in `src/lib/google/types.ts`:

```ts
export type GoogleAssetKind = "ga4_property" | "ads_customer" | "gsc_site";
export type GoogleAsset = {
  id: string; kind: GoogleAssetKind; external_id: string; name: string; parent_name: string | null;
  currency: string | null; timezone: string | null; login_customer_id: string | null;
  mapped_client_id: string | null; raw_metadata: Record<string, unknown> | null;
  last_synced_at: string | null; created_at: string; updated_at: string;
};
export type GoogleConnection = {
  id: string; google_email: string | null; scopes: string[]; refresh_token_encrypted: string;
  connected_by: string | null; connected_at: string; last_refreshed_at: string | null;
  created_at: string; updated_at: string;
};
export type DateRange = { since: string; until: string }; // YYYY-MM-DD
export type Ga4Channel = "paid_social" | "paid_search" | "other";
export type Ga4CategoryRevenue = {
  method: "item" | "landing_page" | "none";
  currency: string;
  /** item method: key = itemCategory; landing_page method: key = landing page path. */
  rows: Array<{ key: string; revenueCents: number; purchases: number }>;
  /** Revenue by landing page and channel, used for the per-channel split. */
  byChannel: Array<{ landingPage: string; channel: Ga4Channel; revenueCents: number }>;
};
export type AdsPerformance = {
  customerId: string; currency: string; merchantCenterLinked: boolean;
  campaigns: Array<{ id: string; name: string; type: string; status: string; costCents: number; conversions: number; conversionValueCents: number }>;
  landingPages: Array<{ url: string; costCents: number; conversionValueCents: number }>;
  assetGroups: Array<{ name: string; campaignId: string; costCents: number; conversionValueCents: number }>;
  shoppingCategories: Array<{ productType: string; costCents: number; conversionValueCents: number }>;
};
export type SearchDemand = { siteUrl: string; rows: Array<{ page: string; clicks: number; impressions: number; position: number; topQueries: string[] }> };
export type ChannelSnapshot = {
  mapped: { ga4: boolean; ads: boolean; gsc: boolean };
  ga4: Ga4CategoryRevenue | null; ads: AdsPerformance | null; gsc: SearchDemand | null;
  /** "Google needs reconnecting", "Google Ads: <error>", … one per failed part. */
  warnings: string[];
};
```

**Migration contents:**
- `google_oauth_connection`: the `GoogleConnection` columns. `connected_by` references `public.profiles(id) on delete set null`. RLS on, with one admin policy for all operations (`public.is_admin()`), and the `set_updated_at` trigger.
- `connected_google_assets`: the `GoogleAsset` columns.
  - `kind` uses a check constraint; `mapped_client_id` references `public.clients(id) on delete set null`.
  - `unique (kind, external_id)`, plus `create unique index if not exists connected_google_assets_one_per_client on public.connected_google_assets (kind, mapped_client_id) where mapped_client_id is not null`.
  - RLS mirrors `connected_meta_accounts` (00001 ~L937-950): select when `is_admin()` or `has_client_access(mapped_client_id)`; insert/update/delete admin only. Plus the updated_at trigger.

**Steps:**
- [ ] **Step 1: Write the failing test.** With env stubs and `resetConfigCache()`:
  - no Google vars → `hasGoogle` and `hasGoogleAds` are false;
  - client id + secret → `hasGoogle` true, `hasGoogleAds` false;
  - plus the developer token → both true;
  - `GOOGLE_ADS_LOGIN_CUSTOMER_ID` `"123-456-7890"` comes back from config as `"1234567890"` (dashes stripped).
- [ ] **Step 2:** Run `npx vitest run tests/google-config.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the config, `.env.example` (each var with a one-line comment, plus the redirect URI note), the migration and the types.
- [ ] **Step 4:** Run the test, typecheck and the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `"Google: config, tables and types for a read-only connection"`.

### Task 2: Google HTTP client and agency token service

**Files:**
- Create: `src/lib/google/http.ts`
- Create: `src/lib/google/oauth.ts`
- Modify: `src/lib/demo/store.ts`: add `googleConnection: GoogleConnection | null` (seed `null`) and `googleAssets: GoogleAsset[]` (seed `[]`; Task 6 fills it)
- Test: `tests/google-oauth.test.ts`

**Interfaces:**
- Consumes: `encryptToken` / `decryptToken` (token-vault), config from Task 1.
- Produces:

```ts
// http.ts
export class GoogleApiError extends Error { status: number; code: string | null; }
export async function googleFetch<T>(url: string, init: { method?: "GET" | "POST"; accessToken: string; body?: unknown; headers?: Record<string, string> }): Promise<T>;
// oauth.ts
export const GOOGLE_SCOPES: readonly string[];
export class GoogleReconnectRequired extends Error {}
export function googleAuthUrl(state: string): string;
export async function exchangeGoogleCode(code: string): Promise<{ refreshToken: string | null; accessToken: string; expiresInSec: number; email: string | null; scopes: string[] }>;
export async function saveGoogleConnection(input: { refreshToken: string; email: string | null; scopes: string[]; connectedBy: string | null }): Promise<void>;
export async function loadGoogleConnection(): Promise<GoogleConnection | null>;
export async function deleteGoogleConnection(): Promise<void>;
export async function getGoogleAccessToken(): Promise<string>;   // cached; throws GoogleReconnectRequired
export function resetGoogleTokenCache(): void;
```

- The token endpoint is `https://oauth2.googleapis.com/token` (form-encoded).
- The email comes from `https://openidconnect.googleapis.com/v1/userinfo`.
- The access token is cached until `expires_in - 60` seconds.
- On `invalid_grant`, `getGoogleAccessToken` clears the cache and throws `GoogleReconnectRequired`.
- In DEMO_MODE, `getGoogleAccessToken` returns `"demo-google-token"` when the demo store has a connection.

**Steps:**
- [ ] **Step 1: Write the failing tests** (fetch mocked):
  - `googleAuthUrl("s1")` contains `access_type=offline`, `prompt=consent`, every scope, `state=s1`, and the redirect URI from `APP_URL`;
  - `exchangeGoogleCode` posts `grant_type=authorization_code` and returns the refresh token and email;
  - `saveGoogleConnection` stores an encrypted token (the stored value is not the plain token, and `decryptToken` round-trips it);
  - `getGoogleAccessToken` refreshes once and serves the second call from cache (fetch called once);
  - a mocked `400 {"error":"invalid_grant"}` throws `GoogleReconnectRequired`;
  - `googleFetch` retries a 503 then succeeds, makes no retry on 400, and puts the token only in the `Authorization` header (the URL has no token);
  - a non-JSON 500 body gives a `GoogleApiError` with status 500.
- [ ] **Step 2:** Run `npx vitest run tests/google-oauth.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Storage follows the two-store pattern: the demo store field, or the Supabase `google_oauth_connection` table, with a single row upserted by deleting any existing row first.
- [ ] **Step 4:** Run the tests, typecheck and the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `"Google: HTTP client and agency token service"`.

### Task 3: OAuth routes (admin only)

**Files:**
- Create: `src/app/api/auth/google/route.ts` (GET start)
- Create: `src/app/api/auth/google/callback/route.ts`
- Create: `src/app/api/auth/google/status/route.ts` (GET)
- Create: `src/app/api/auth/google/disconnect/route.ts` (POST)
- Create: `src/lib/google/assets.ts`, holding only the `syncGoogleAssets` stub; Task 6 fills it in
- Test: `tests/google-auth-routes.test.ts`

**Interfaces:**
- Consumes: Task 2 functions, and `syncGoogleAssets` from Task 6, imported lazily. Task 6 lands after this, so until then the callback calls a `syncGoogleAssets` stub exported from `src/lib/google/assets.ts` that returns `{ ga4: 0, ads: 0, gsc: 0 }`. Task 6 replaces the body.
- Produces:
  - start: redirects to `googleAuthUrl(state)`. State is 16 random bytes in the httpOnly, sameSite=lax cookie `google_oauth_state` (maxAge 600). Admin only; returns 503 `{ error: "Google is not configured" }` when `!hasGoogle`.
  - callback: on success redirects to `/admin/connections?google_connected=1&google_assets=<n>`; otherwise to `/admin/connections?google_error=<code>`, where code is one of `state_mismatch`, `denied`, `no_refresh_token`, `exchange_failed` or `not_admin`.
  - status: `{ configured: boolean; adsConfigured: boolean; connected: boolean; email: string | null; needsReconnect: boolean; connectedAt: string | null }`. Admins only.
  - disconnect: deletes the connection; asset mappings are kept. Returns `{ ok: true }`.

**Steps:**
- [ ] **Step 1: Write the failing tests:**
  - start as a non-admin → 403;
  - start unconfigured → 503;
  - start as admin → 307/302 to `accounts.google.com`, with the cookie set;
  - callback with a mismatched state → redirect with `google_error=state_mismatch` and nothing saved;
  - callback where the token response has no `refresh_token` → `google_error=no_refresh_token` and nothing saved (**Review Focus #1**);
  - a good callback → connection saved and redirect with `google_connected=1`;
  - status after connect → `connected: true`, with the email, and no token field anywhere in the JSON;
  - disconnect → `connected: false`.
- [ ] **Step 2:** Run `npx vitest run tests/google-auth-routes.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement, mirroring `src/app/api/auth/meta/route.ts` and `callback/route.ts` (state cookie, redirects, the `withApiHandler` style where it fits).
- [ ] **Step 4:** Run the tests, typecheck and the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `"Google: admin-only connect, callback, status and disconnect"`.

### Task 4: Google Ads client (query only)

**Files:**
- Create: `src/lib/google/ads.ts`
- Test: `tests/google-ads-client.test.ts`

**Interfaces:**
- Consumes: `googleFetch`, `getGoogleAccessToken`, and config (developer token, login customer id, API version).
- Produces:

```ts
export const DEFAULT_GOOGLE_ADS_API_VERSION: string; // the current version from Google's release notes at build time
export async function listAccessibleCustomers(): Promise<string[]>;          // ids, digits only
export async function searchGaql<T = Record<string, unknown>>(customerId: string, query: string, loginCustomerId: string | null): Promise<T[]>; // follows nextPageToken
export async function discoverAdsAccounts(): Promise<Array<{ customerId: string; name: string; currency: string; timezone: string; loginCustomerId: string | null; manager: boolean; parentName: string | null }>>;
export async function fetchAdsPerformance(customerId: string, loginCustomerId: string | null, range: DateRange): Promise<AdsPerformance>;
```

- **Base URL:** `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION ?? DEFAULT}`.
- **Headers:** `developer-token`, and `login-customer-id` when it's non-null.
- **`discoverAdsAccounts`** combines:
  - `listAccessibleCustomers`;
  - for each accessible manager (`customer.manager = TRUE`), the `customer_client` rows at level ≤ 2, non-manager, not hidden.

  It de-duplicates by customer id. Each account records the manager it was found through as `loginCustomerId`, preferring `GOOGLE_ADS_LOGIN_CUSTOMER_ID` when that manager can reach the account.
- **`fetchAdsPerformance`** runs four GAQL queries over the range, verified against Google's current field reference:
  - campaigns, with `advertising_channel_type`, status and metrics;
  - landing pages (`landing_page_view`, `expanded_landing_page_view` or the current equivalent);
  - asset groups (`asset_group` metrics);
  - Shopping product types (`shopping_performance_view` by `segments.product_type_l1`, with `l2` when present).

  `merchantCenterLinked` comes from the current Merchant Center link resource. If that query fails, it's false, with no throw.

**Steps:**
- [ ] **Step 1: Write the failing tests** (fetch mocked with GAQL-shaped JSON):
  - `searchGaql` posts to `…/customers/123/googleAds:search` with the `developer-token` and `login-customer-id` headers and follows `nextPageToken`;
  - micros convert to cents (`cost_micros: 12_340_000` → 1234);
  - `discoverAdsAccounts` returns a directly accessible account plus a child under a manager, without duplicates;
  - **read-only guard:** read `src/lib/google/ads.ts` as text and assert it contains no `mutate`, and every URL the mock saw ends in `googleAds:search` or `customers:listAccessibleCustomers`;
  - a failing Merchant Center link query gives `merchantCenterLinked: false`.
- [ ] **Step 2:** Run `npx vitest run tests/google-ads-client.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Check the API version and field names against developers.google.com/google-ads/api before coding, and record what you checked in the report.
- [ ] **Step 4:** Run the tests, typecheck and the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `"Google Ads: read-only query client and account discovery"`.

### Task 5: GA4 and Search Console clients

**Files:**
- Create: `src/lib/google/ga4.ts`
- Create: `src/lib/google/gsc.ts`
- Test: `tests/google-ga4-gsc.test.ts`

**Interfaces:**
- Produces:

```ts
// ga4.ts
export async function listGa4Properties(): Promise<Array<{ propertyId: string; name: string; accountName: string; currency: string | null; timezone: string | null }>>;
export async function fetchGa4CategoryRevenue(propertyId: string, range: DateRange): Promise<Ga4CategoryRevenue>;
export function ga4ChannelOf(channelGroup: string): Ga4Channel; // "Paid Social" → paid_social; "Paid Search" | "Paid Shopping" | "Cross-network" | "Paid Other" with source google → paid_search; else other
// gsc.ts
export async function listGscSites(): Promise<Array<{ siteUrl: string; permissionLevel: string }>>;
export async function fetchSearchDemand(siteUrl: string, range: DateRange): Promise<SearchDemand>;
```

- **Properties:** Admin API `GET https://analyticsadmin.googleapis.com/v1beta/accountSummaries` (paged), then `GET v1beta/properties/{id}` for currency and time zone.
- **`fetchGa4CategoryRevenue`** calls the Data API `POST https://analyticsdata.googleapis.com/v1beta/properties/{id}:runReport`:
  1. Item report: `itemCategory` dimension, `itemRevenue` and `itemsPurchased` metrics.
  2. If that has no revenue rows, the landing-page report: `landingPagePlusQueryString` with `purchaseRevenue` (or `totalRevenue`) and `ecommercePurchases`.
  3. `byChannel` from `landingPagePlusQueryString` + `sessionDefaultChannelGroup` + `sessionSource` with revenue.

  Strip query strings from landing pages. If both revenue reports are empty, `method` is `"none"` and `rows` is `[]`.
- **`fetchSearchDemand`** calls `POST https://www.googleapis.com/webmasters/v3/sites/{encodeURIComponent(siteUrl)}/searchAnalytics/query` twice:
  1. dimensions `["page"]`, rowLimit 1000;
  2. `["page","query"]`, rowLimit 5000, giving up to 5 top queries per page by clicks.

**Steps:**
- [ ] **Step 1: Write the failing tests** (fetch mocked):
  - item rows convert to cents and set `method: "item"`;
  - an empty item report falls back to `"landing_page"`;
  - empty reports give `"none"` (**Review Focus #3**);
  - `ga4ChannelOf` maps each listed group;
  - `byChannel` strips query strings;
  - GSC: pages with clicks/impressions/position and top 5 queries sorted by clicks;
  - a `sc-domain:` site URL is percent-encoded in the path;
  - properties come back paged with their currency.
- [ ] **Step 2:** Run `npx vitest run tests/google-ga4-gsc.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement, verifying the GA4 dimension/metric names and their compatibility against the GA4 Data API schema docs. Record any substitution in the report.
- [ ] **Step 4:** Run the tests, typecheck and the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `"Google: GA4 revenue and Search Console demand clients"`.

### Task 6: Asset sync, mapping, routes and the demo seed

**Files:**
- Create: `src/lib/google/assets.ts` (replaces the Task 3 stub)
- Create: `src/app/api/admin/google/assets/route.ts` (GET list)
- Create: `src/app/api/admin/google/sync/route.ts` (POST)
- Create: `src/app/api/admin/google/map/route.ts` (POST)
- Modify: `src/lib/demo/store.ts`:
  - the ClickTrends `connectedMetaAccounts` entry gets `access_status: "granted"`;
  - ClickTrends' `goals_profile` gets `{ business_model: "ecommerce", target_roas: 4, gross_margin_pct: 45 }`;
  - three demo `googleAssets` mapped to ClickTrends: GA4 property `properties/demo-ga4`, Ads customer `1112223334`, site `https://clicktrends.example/`. All AUD to match its Meta currency (check the seed's currency and use it).
- Modify: `src/lib/audit/meta-audit-data.ts`: `demoMetaAuditSnapshot` returns an ecommerce variant for the ClickTrends demo Meta account id, with ads linking to `/collections/bar-stools` and `/collections/sofas`, with purchase ROAS. The dental variant stays for the others.
- Test: `tests/google-assets.test.ts`

**Interfaces:**
- Produces:

```ts
export async function syncGoogleAssets(): Promise<{ ga4: number; ads: number; gsc: number; warnings: string[] }>;
export async function listGoogleAssets(): Promise<GoogleAsset[]>;
export async function mapGoogleAsset(assetId: string, clientId: string | null): Promise<GoogleAsset>; // replaces any asset of the same kind mapped to that client
export async function clientGoogleAssets(clientId: string): Promise<{ ga4: GoogleAsset | null; ads: GoogleAsset | null; gsc: GoogleAsset | null }>;
```

- **Sync** upserts by `(kind, external_id)` and keeps `mapped_client_id`. Each part (GA4, Ads, GSC) is independent: a failure becomes a warning. Ads is skipped with a warning when `!hasGoogleAds`.
- **Routes** are all admin only. `map` takes the body `{ assetId: string, clientId: string | null }` and returns `{ asset }`.

**Steps:**
- [ ] **Step 1: Write the failing tests** (DEMO_MODE, with the Task 4/5 clients mocked through `vi.mock`):
  - sync upserts all three kinds and a second sync keeps a mapping;
  - Ads failing still syncs GA4 and GSC, with a warning;
  - mapping a second GA4 property to ClickTrends unmaps the first;
  - `clientGoogleAssets(clickTrendsId)` returns all three from the seed;
  - routes: a non-admin gets 403 on sync, map and assets; map returns the updated asset;
  - the ClickTrends demo snapshot has ads whose `linkUrl` contains `/collections/bar-stools` with non-null ROAS, and the Modern Dental snapshot is unchanged.
- [ ] **Step 2:** Run `npx vitest run tests/google-assets.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests, typecheck and the full suite. Existing demo-snapshot tests must stay green. Expected: PASS.
- [ ] **Step 5:** Commit `"Google: asset sync, per-client mapping and the ecommerce demo client"`.

### Task 7: Data provider, mock and channel snapshot

**Files:**
- Create: `src/lib/google/provider.ts`
- Create: `src/lib/google/mock-provider.ts`
- Create: `src/lib/google/snapshot.ts`
- Test: `tests/google-snapshot.test.ts`

**Interfaces:**
- Produces:

```ts
export interface GoogleDataProvider {
  ga4CategoryRevenue(propertyId: string, range: DateRange): Promise<Ga4CategoryRevenue>;
  adsPerformance(customerId: string, loginCustomerId: string | null, range: DateRange): Promise<AdsPerformance>;
  searchDemand(siteUrl: string, range: DateRange): Promise<SearchDemand>;
}
export function getGoogleDataProvider(): GoogleDataProvider; // mock in DEMO_MODE / !hasSupabase, live otherwise
export async function loadChannelSnapshot(clientId: string, range: DateRange): Promise<ChannelSnapshot>;
```

- **Mock data** for the demo assets: GA4 item rows for "Bar Stools" and "Sofas", landing-page `byChannel` rows for `/collections/bar-stools` and `/collections/sofas` split across paid_social and paid_search, Ads campaigns (one Search, one Performance Max), landing pages, a Shopping product type "Bar Stools", `merchantCenterLinked: true`, and GSC rows with impressions and queries for both paths.
- **`loadChannelSnapshot`:**
  - reads `clientGoogleAssets`;
  - for each mapped part, calls the provider inside its own try/catch;
  - `GoogleReconnectRequired` gives one warning, "Google needs reconnecting — an admin can reconnect under Connections", and skips every part;
  - another error gives `"<GA4|Google Ads|Search Console>: <message>"`.

**Steps:**
- [ ] **Step 1: Write the failing tests:**
  - DEMO ClickTrends → all three parts present and `mapped` all true;
  - a client with no assets → all null, `mapped` all false, no warnings;
  - provider `adsPerformance` throws → `ads: null`, GA4 still present, one "Google Ads:" warning (**Review Focus #5**);
  - `GoogleReconnectRequired` → the reconnect warning and all parts null (**Review Focus #2**).
- [ ] **Step 2:** Run `npx vitest run tests/google-snapshot.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests, typecheck and the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `"Google: data provider, demo data and per-turn channel snapshot"`.

### Task 8: Shared category matcher

**Files:**
- Create: `src/lib/strategy/category-match.ts`
- Modify: `src/lib/strategy/category-attribution.ts`: use the shared matcher, keeping behaviour identical (`normalizeUrl` ~L24, `urlScore` ~L35, `escapeRegExp` ~L51, `nameScore` ~L57, `matchAd` ~L70)
- Modify: `src/lib/strategy/categories.ts`: reuse its `escapeRegExp` or name matching from the shared module where they duplicate it
- Test: `tests/strategy-category-match.test.ts`

**Interfaces:**
- Produces:

```ts
export function normalizeUrl(raw: string): string | null;
export function matchCategoryByUrl(url: string, categories: StrategyCategory[]): StrategyCategory | null;   // longest path / pattern wins
export function matchCategoryByName(texts: Array<string | null | undefined>, categories: StrategyCategory[]): StrategyCategory | null; // first text with a hit decides; longest term wins
export function matchCategoryByLabel(label: string, categories: StrategyCategory[]): StrategyCategory | null; // exact case-insensitive name/keyword, then whole-word name match (GA4 itemCategory, Shopping product type)
```

**Steps:**
- [ ] **Step 1: Write the failing tests:**
  - URL: www/port/query are ignored and the longest path wins;
  - name precedence;
  - labels: "Bar Stools" and "bar stools" both match the "Bar stools" category; "Home > Bar Stools" matches by whole word;
  - "Stool" does not match "Stoolery".
- [ ] **Step 2:** Run `npx vitest run tests/strategy-category-match.test.ts tests/strategy-category-attribution.test.ts`. Expected: the new file FAILS and the attribution tests pass.
- [ ] **Step 3:** Implement and refactor. The attribution tests must not change.
- [ ] **Step 4:** Run both files, typecheck and the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `"Strategy: one category matcher shared by Meta and Google"`.

### Task 9: Channel performance per category

**Files:**
- Create: `src/lib/strategy/channels.ts`
- Test: `tests/strategy-channels.test.ts`

**Interfaces:**
- Consumes: Task 8 matcher, `CategoryAttribution` (Meta), `ChannelSnapshot`.
- Produces:

```ts
export type ChannelFigures = { spendCents: number; platformRevenueCents: number; ga4RevenueCents: number | null; roas: number | null; basis: "ga4" | "platform" | "none" };
export type CategoryChannels = {
  categoryId: string; meta: ChannelFigures; google: ChannelFigures;
  /** GA4 revenue for the category across all channels (item or landing-page method), null when GA4 is unavailable. */
  ga4TotalRevenueCents: number | null;
  searchImpressions: number; searchClicks: number; topQueries: string[];
};
export type ChannelPerformance = {
  byCategory: CategoryChannels[];
  ga4Method: "item" | "landing_page" | "none"; ga4Available: boolean; googleAdsMapped: boolean;
  /** Set when currencies differ: no combined figures may be used. */
  currencyMismatch: string | null;
  googleUnmatchedSpendCents: number;
  /** Paid-social check: what Meta reports vs what GA4 credits to paid social. */
  metaVsGa4: { metaReportedCents: number; ga4PaidSocialCents: number } | null;
  /** The snapshot's Google Ads data, passed through for campaign-type detection (Task 11). */
  ads: AdsPerformance | null;
  warnings: string[];
};
export function buildChannelPerformance(input: { categories: StrategyCategory[]; metaAttribution: CategoryAttribution; metaCurrency: string; snapshot: ChannelSnapshot }): ChannelPerformance;
```

**Rules:**
- **Meta figures:** spend and platform revenue come from `metaAttribution`.
- **Google spend and value per category:**
  1. Landing pages are matched by URL.
  2. Campaigns and asset groups whose own spend isn't already covered by a matched landing page are matched by name. Count each campaign's cost once: prefer asset-group rows for Performance Max, campaign rows otherwise.
  3. Shopping product types are matched by label.

  Anything unmatched adds to `googleUnmatchedSpendCents`. Never double-count a campaign's cost in two categories.
- **GA4 per category:** item method by `matchCategoryByLabel` on the `rows`; landing-page method by `matchCategoryByUrl`. Per channel, the category's GA4 revenue is split by that category's `byChannel` shares (paid_social → meta, paid_search → google). When there's no `byChannel` data for it, `ga4RevenueCents` is null for both channels.
- **ROAS** per channel = (GA4 channel revenue if not null, else platform revenue) ÷ spend. `basis` follows the source; ROAS is null when spend is 0.
- **Currency:** compare `metaCurrency`, GA4 currency and Ads currency (only those present). If they differ, `currencyMismatch` = "Meta reports in AUD, GA4 in USD: figures are shown per channel and not combined."
- **Search Console:** GSC rows are matched to categories by URL, summing clicks and impressions and merging top queries (max 5).

**Steps:**
- [ ] **Step 1: Write the failing tests** using the Task 7 mock snapshot plus hand-built cases:
  - bar stools gets Google spend from its landing page plus the Shopping "Bar Stools" product type, without double-counting;
  - Performance Max asset-group spend matched by name;
  - an unmatched campaign adds to `googleUnmatchedSpendCents`;
  - the item method sets `ga4TotalRevenueCents` and splits by `byChannel` shares;
  - the landing-page method works the same way;
  - `method "none"` → `ga4Available: false`, basis `platform` (**Review Focus #3**);
  - AUD Meta with USD GA4 → `currencyMismatch` set (**Review Focus #4**);
  - Search Console impressions summed per category;
  - `metaVsGa4` computed when GA4 is available.
- [ ] **Step 2:** Run `npx vitest run tests/strategy-channels.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement as a pure function with no I/O.
- [ ] **Step 4:** Run the tests, typecheck and the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `"Strategy: per-category Meta, Google and GA4 figures"`.

### Task 10: Google capability list

**Files:**
- Create: `src/lib/strategy/google-capabilities.ts`
- Test: `tests/strategy-google-capabilities.test.ts`

**Interfaces:**
- Produces:

```ts
export type GoogleCapabilityId = "google_search" | "google_shopping" | "google_pmax" | "google_demand_gen";
export type GoogleCapabilityStatus = { id: GoogleCapabilityId; label: string; why: string; state: "in_use" | "not_used" | "needs_feed" | "unknown" };
export function detectGoogleCapabilities(ads: AdsPerformance | null): GoogleCapabilityStatus[];
export function recommendGoogleCampaignTypes(input: { tier: "proven" | "promising" | "test" | "hold"; merchantCenterLinked: boolean; searchImpressions: number }): GoogleCapabilityId[];
```

**Rules:**
- **In use** means a campaign with spend of that type: `SEARCH`, `SHOPPING`, `PERFORMANCE_MAX` or `DEMAND_GEN`.
- Shopping and Performance Max are `needs_feed` when `!merchantCenterLinked` and not in use.
- `ads === null` → every capability `unknown`.
- **Recommendation:**
  - `hold` → `[]`;
  - feed linked: proven → `["google_pmax"]`, promising and test → `["google_shopping"]`;
  - add `"google_search"` when `searchImpressions > 0`;
  - no feed → `["google_search"]` only when there's demand, otherwise `[]`.

**Steps:**
- [ ] **Step 1: Write the failing tests** covering each rule above.
- [ ] **Step 2:** Run `npx vitest run tests/strategy-google-capabilities.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Each `why` is one plain sentence.
- [ ] **Step 4:** Run the tests, typecheck and the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `"Strategy: Google campaign types the plan can recommend"`.

### Task 11: Channel-aware, category-scoped plan engine

**Files:**
- Modify: `src/lib/strategy/plan.ts` (types ~L9-45, `PLAN_CONSTANTS` ~L47, `buildStrategyPlan` ~L96 and its `run`)
- Test: `tests/strategy-plan-channels.test.ts`. Existing `tests/strategy-plan.test.ts` must pass unchanged.

**Interfaces:**
- Consumes: `ChannelPerformance` (Task 9) and Task 10's functions.
- Produces:
  - `StrategyBrief` gains `totalBudgetCents?: number | null` and `periodDays?: number | null`. `dailyBudgetCents` stays the engine input; Task 12 fills it from total ÷ period.
  - `buildStrategyPlan` input gains `channels?: ChannelPerformance` and `scopeCategoryIds?: string[]`.
  - `CategoryAllocation` gains:

    ```ts
    channelSplit: { metaCents: number; googleCents: number; metaProjectedCents: number; googleProjectedCents: number; basis: "ga4" | "platform" } | null;
    googleCampaignTypes: GoogleCapabilityId[];
    ```
  - `StrategyPlan` gains:

    ```ts
    revenueBasis: "ga4" | "platform";
    channelTotals: { metaCents: number; googleCents: number } | null;
    channelNote: string | null; // why there is no split, e.g. "No Google Ads account mapped: Google wasn't considered."
    scope: { categoryIds: string[]; names: string[] } | null;
    googleCapabilities: GoogleCapabilityStatus[] | null;
    ```
  - `PLAN_CONSTANTS` gains `minChannelTestShare: 0.2`.

**Rules:**
1. **Without `channels`, or with `channels.currencyMismatch`,** behaviour is exactly as today:
   - `channelSplit` is null, `googleCampaignTypes` is `[]`, `revenueBasis` is `"platform"`.
   - `channelNote` explains the mismatch or the missing Google data.
2. **With `channels`:**
   - A category's observed spend is Meta spend + Google spend. Its observed revenue is `ga4TotalRevenueCents` when GA4 is available and not null, else Meta + Google platform revenue.
   - `observedRoas` = revenue ÷ spend. That revenue is the tier and weight input in place of Meta `purchaseValueCents`.
   - The account ROAS in the reality check uses the same combined basis.
   - `revenueBasis` is `"ga4"` when GA4 is available.
3. **Channel split** within each funded category:
   - Weights are each channel's ROAS where it has spend.
   - A channel with no spend gets `minChannelTestShare` when it has demand: Google with `searchImpressions > 0` and a Google Ads account mapped; Meta when the category has a landing page. The other channel's share is reduced to fit.
   - No Google Ads account mapped → Meta 100%.
   - Neither channel has data → Meta 100%.
   - Use largest-remainder cents so `metaCents + googleCents` equals the allocation.
4. **Projected revenue per channel** = channel cents × channel ROAS × `scaleDecay`. A channel without ROAS uses the account ROAS (or the benchmark) × `testDiscount`. The allocation's projection is the sum.
5. **Scoped plans (`scopeCategoryIds` non-empty):**
   - Only those categories get allocations.
   - The whole budget is split across them by revenue weight (equally when all are 0), with no 70/20/10 tiers.
   - Tier labels are still computed and shown. A `hold` category in scope is still funded, with the assumption "<name> is below break-even; funded because the plan was asked for it."
   - `gaps.untouchedCategoryIds` stays account-wide.
   - `scope` lists the ids and names.
6. **Google campaign types:** `googleCampaignTypes` = `recommendGoogleCampaignTypes({ tier, merchantCenterLinked: channels.ads?.merchantCenterLinked ?? false, searchImpressions })` for each allocation with `googleCents > 0`. `googleCapabilities` = `detectGoogleCapabilities(channels.ads)` when Google Ads is mapped, else null.
7. **Assumptions** gain a line for:
   - the revenue basis;
   - the channel split rule, including the 20% test share;
   - the scope;
   - the currency or no-Google note.

**Steps:**
- [ ] **Step 1: Write the failing tests:**
  - With channels from the Task 7 mock (ClickTrends):
    - bar stools gets a split with both channels > 0, and `metaCents + googleCents === dailyBudgetCents` for the allocation;
    - `revenueBasis: "ga4"`;
    - the tier uses GA4 revenue (a case where Meta-reported ROAS ≥ target but GA4 ROAS < target lands in `promising`, not `proven`);
    - a category with only Google spend and strong ROAS is `proven`.
  - No Google spend but impressions → Google gets 20%.
  - No Ads mapped → Meta 100%, with the `channelNote`.
  - A currency mismatch → `channelSplit` null and `channelNote` set (**Review Focus #4**).
  - Scoped to bar stools at $133/day:
    - one allocation of 13300 cents with no tier split;
    - a `hold` bar stools still funded, with the assumption line.
  - `googleCampaignTypes` with the feed linked: proven → `["google_pmax", "google_search"]`.
  - Every case passes through `buildStrategyPlan` without `channels` and still matches the existing `tests/strategy-plan.test.ts` expectations.
- [ ] **Step 2:** Run `npx vitest run tests/strategy-plan-channels.test.ts tests/strategy-plan.test.ts`. Expected: the new file FAILS and the old file passes.
- [ ] **Step 3:** Implement, keeping `run()` the single path for the main plan and the scenarios.
- [ ] **Step 4:** Run both files, typecheck and the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `"Strategy: cross-channel split, GA4 basis and category-scoped plans"`.

### Task 12: Total budgets, category scope and routing in the brief

**Files:**
- Modify: `src/lib/agent/strategy-brief.ts` (`BUDGET_RE` ~L12, `A_TO_B_RE` ~L26, `statedBrief` ~L76, `completeBrief` ~L87)
- Modify: `src/lib/agent/task-plan.ts` (`STRATEGY_GOAL` money-back alternative)
- Modify: `src/lib/strategy/categories.ts`: add `scopeCategoriesFromRequest`
- Test: `tests/strategy-brief-total-budget.test.ts`. Existing `tests/strategy-brief.test.ts` must stay green, except its one A-to-B case: "derives the target from '$A to get $B back' but not the budget" changes to expect `totalBudgetCents: 400000`, `periodDays: 30` and `dailyBudgetCents: 13333`. That's a design change, recorded in the commit message.

**Interfaces:**
- Produces:
  - `parseStrategyBrief` and `resolveStrategyBrief` results' `brief` carries `totalBudgetCents` and `periodDays`, and `usedDefaults` can include `"period"`.
  - In `categories.ts`: `export function scopeCategoriesFromRequest(request: string, categories: StrategyCategory[]): StrategyCategory[]` (whole-word name or keyword matches, de-duplicated, in category order).

**Rules:**
- **Total-budget forms:**
  - "spend $A and get $B back", "$A to get $B (back)", "spend $A to make $B", "$A for $B in sales" → total A, target B ÷ A;
  - "$A over N days|weeks|months" and "$A this month" → total A with that period.
- **Period:** a stated period wins. Otherwise 30 days, recorded in `usedDefaults` as `"period"`, and the writer says so.
- `dailyBudgetCents = Math.round(total / periodDays)`. An explicit daily budget in the same message wins over a total.
- **Routing:** each total-budget form routes `detectRequestIntent` to `"strategy"`, under the same suppression rules as today.

**Steps:**
- [ ] **Step 1: Write the failing tests:**
  - "How do we spend $4k and get $40k back on bar stools using Google Ads and Meta?" →
    - `{ totalBudgetCents: 400000, periodDays: 30, dailyBudgetCents: 13333, targetRoas: 10 }`, with `usedDefaults` containing `"period"`;
    - `detectRequestIntent` → `"strategy"`;
    - `scopeCategoriesFromRequest` → the Bar stools category.
  - "$4k over 2 weeks to get $40k" → `periodDays: 14`, daily 28571.
  - "$6k this month at 8x" → `periodDays: 30`, target 8.
  - "$500/day, and we have $4k to get $40k back" → daily 50000 wins and the target is 10.
  - "Which campaigns are under 2x ROAS?" still isn't strategy.
- [ ] **Step 2:** Run `npx vitest run tests/strategy-brief-total-budget.test.ts tests/strategy-brief.test.ts`. Expected: the new file FAILS.
- [ ] **Step 3:** Implement, and update the one old A-to-B expectation as stated.
- [ ] **Step 4:** Run both files, typecheck and the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `"Workspace: total budgets and category-scoped strategy asks"`.

### Task 13: Evidence, framework and agent wiring

**Files:**
- Modify: `src/lib/strategy/render.ts` (`renderStrategyEvidence` ~L155, `renderCategorySpendEvidence` ~L122, `spendTable` ~L83)
- Modify: `src/lib/agent/strategy-framework.ts`
- Modify: `src/lib/agent/adspirer-agent.ts`:
  - the strategy branch (~L2326-2400): load `loadChannelSnapshot(clientId, snapshot.period)`, then `buildChannelPerformance`, then pass `channels` and `scopeCategoryIds` to `buildStrategyPlan` and `channels` to render;
  - the category-spend branch (~L2412-2440): the same snapshot and `channels` passed to `renderCategorySpendEvidence`.
- Test: `tests/strategy-render-channels.test.ts`, `tests/strategy-agent-google.test.ts`

**Interfaces:**
- Produces:
  - `renderStrategyEvidence(plan, attribution, opts)` and `renderCategorySpendEvidence(attribution, categories, opts)` take an optional `opts.channels?: ChannelPerformance` and `opts.channelWarnings?: string[]`.
  - Without them, the output is byte-identical to today, and the existing render tests stay green.

**New evidence when channels are present:**
- **Level 1 table:** columns Meta spend, Google spend, GA4 revenue (or "—"), combined ROAS and basis. A line names the GA4 method ("GA4 product categories" / "GA4 landing pages — an estimate, not exact product sales"), and Google unmatched spend is shown.
- **`### Level 2: GA4 vs platform-reported`:** Meta-reported revenue vs GA4 paid-social revenue, and the difference in %.
- **`### Search demand`:** impressions, clicks and top queries per category, top 10 by impressions.
- **`### Level 3: channel split`:** per funded category, Meta budget, Google budget, the projection per channel and the Google campaign types. Then totals, then the line "Google budget is a recommendation for the Google Ads account — this tool doesn't change Google."
- **`### Google campaign types`:** in use / not used / needs a product feed.
- **Scoped plan:** a `### Scope` line naming the categories.
- **Channel notes and warnings** print near the top: currency mismatch, no Google mapped, "Google needs reconnecting", part failures.
- **Category-spend evidence** gains the same Level 1 columns, plus `Ranked by: GA4 revenue` (or `combined platform revenue` without GA4), with the best category first.

**Framework (`strategy-framework.ts`):**
- Level 1 uses GA4 figures when present and names the method.
- Level 2 includes the GA4 vs Meta gap and search demand.
- Level 3 includes the channel split with the Google recommendation label.
- Never claim the tool will change Google.

**Steps:**
- [ ] **Step 1: Write the failing tests:**
  - **Render:**
    - each new section appears in order with channels;
    - the output is identical without channels (snapshot of the existing fixture);
    - the landing-page method prints the estimate wording;
    - the reconnect warning prints (**Review Focus #2**);
    - a part-failure warning prints (**Review Focus #5**);
    - a mismatch prints the reason and no split table.
  - **Agent (DEMO_MODE, ClickTrends)**, request "How do we spend $4k and get $40k back on bar stools using Google Ads and Meta together?":
    - the reply evidence contains Level 1, 2 and 3, "channel split", a Google budget for Bar stools, the recommendation label and "30 days";
    - tool calls contain no execute tool;
    - the request "How much has gone into bar stools, what did it return, and what was the best category in the last 30 days?" contains GA4 revenue and "Ranked by: GA4 revenue".
- [ ] **Step 2:** Run `npx vitest run tests/strategy-render-channels.test.ts tests/strategy-agent-google.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests, typecheck and the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `"Workspace: GA4-reconciled, cross-channel strategy evidence"`.

### Task 14: Connections UI and client overview

**Files:**
- Create: `src/lib/google/assets-view.ts` (pure helpers)
- Create: `src/components/connections/google-connect-card.tsx`
- Modify: `src/app/(app)/admin/connections/connections-client.tsx` (add the card after the Facebook card ~L214-229, and handle the `google_connected` / `google_error` query params with toasts like `src/lib/meta/oauth-return.ts`)
- Create: `src/app/api/v2/clients/[clientId]/google-assets/route.ts` (GET; `assertClientAccess`; returns `{ ga4, ads, gsc }`, each `{ name, external_id } | null`)
- Modify: `src/app/(app)/clients/[id]/page.tsx` (Overview: a "Google data" line)
- Test: `tests/google-assets-view.test.ts`, plus route tests in the same file

**Interfaces:**
- Produces:

```ts
export function groupGoogleAssets(assets: GoogleAsset[]): Record<GoogleAssetKind, GoogleAsset[]>; // sorted by name
export function googleErrorMessage(code: string): string; // plain copy for each callback error code from Task 3
export function googleAssetsSummary(a: { ga4: { name: string } | null; ads: { name: string } | null; gsc: { name: string } | null }): string; // "GA4: X · Google Ads: Y · Search Console: Z" or "Not mapped — map under Connections"
```

**The card shows:**
- "Not configured" with the env var names, when `!configured`;
- Connect, or Reconnect when `needsReconnect`;
- the connected email and Disconnect (with a confirm);
- Sync, then a toast with the counts and warnings;
- three lists (GA4 properties, Google Ads accounts, Search Console sites), each row with a client select that calls the map route and shows the API error inline on failure.

**Steps:**
- [ ] **Step 1: Write the failing tests** for the three helpers. The `google-assets` route returns the demo ClickTrends assets for a user with access, 403 without, and never includes `raw_metadata`.
- [ ] **Step 2:** Run `npx vitest run tests/google-assets-view.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the helpers, route and UI, matching the existing card and `text-muted` styling.
- [ ] **Step 4:** Run the tests, typecheck, eslint on the touched files and the full suite. Expected: PASS. UI is checked by reading the code; there's no dev server.
- [ ] **Step 5:** Commit `"Connections: Google card and the client's Google data line"`.

---

## Out of scope

- Creating or changing anything on Google.
- Merchant Center API access.
- Plan approval and execution, the one-category test run, and plan-vs-actual tracking (Phase 2).
- SKU, inventory or supplier data, Amazon, and web-sourced benchmarks (Phase 4).
- Per-operator Google logins.
