# Google connections and cross-channel plan: design

19 October 2026 · follows the [goal-driven strategy roadmap](../../strategy/2026-10-19-goal-driven-strategy-roadmap.md) (Phase 3, brought forward) · spec of record: [Karthik strategy call](../../strategy/2026-10-16-karthik-strategy-call.md)

## Why

Karthik's test question is about DuringDays bar stools. A container costs $20k and needs $40k in sales: how do we spend $4k and get $40k back using **Google Ads and Meta together**? And what has gone into bar stools so far, what did it return, and what was the best category in the last 30 days?

Today the tool sees Meta only. It can't:

- reconcile revenue against GA4, which Karthik wants as the source of truth;
- see Google Ads spend and returns;
- plan a split between the two channels.

This project gives the tool read-only Google data and a cross-channel plan, so it can answer both parts of the question.

## Goals

1. **Connect Google once.** An admin connects the Dotmappers agency Google login under Connections. The tool lists every:
   - **GA4 property** the login can read;
   - **Google Ads account** under the Dotmappers manager (MCC) account;
   - **Search Console site** the login can read.

   The admin maps each one to a client, the same way Meta ad accounts are mapped.
2. **GA4 as the source of truth for revenue.** For a client with a mapped GA4 property, category revenue comes from GA4:
   - **Item method:** revenue by product category, when GA4 records purchase items.
   - **Landing-page method:** revenue by landing page, matched to categories like Meta ads are matched today.

   The report says which method it used. It also shows the gap between Meta-reported revenue and GA4 revenue for traffic from Facebook/Instagram.
3. **Google Ads performance.** For a mapped Google Ads account, show:
   - spend, conversions, conversion value and ROAS by campaign and campaign type;
   - spend and value by landing page, matched to categories;
   - whether a Merchant Center (product feed) link exists, which Shopping and Performance Max need.
4. **Search Console demand.** For a mapped site: clicks, impressions and top queries for each category's landing pages. This shows how much search demand exists for a category.
5. **A cross-channel plan.** The strategy report recommends a budget split between Meta and Google per category and in total, with projections, as part of Level 3. The Google part is labelled a recommendation for whoever runs the Google Ads account.
6. **Karthik's question works end to end.** "How do we spend $4k and get $40k back on bar stools using Google Ads and Meta together?" produces a three-level strategy:
   - the total budget becomes a daily budget over a stated period;
   - GA4-reconciled per-category figures;
   - a Meta/Google split for the bar stools category.

   "How much has gone into bar stools, what did it return, best category in the last 30 days" answers with both channels and GA4 revenue.

## Non-goals

- Creating, editing, pausing or otherwise changing anything on Google: no Google campaign creation and no Google approvals. **The tool only changes Meta.**
- Merchant Center API access. A feed link is only detected through the Google Ads API.
- Amazon, SKU, inventory or supplier data, and web-sourced benchmarks (Phase 4).
- Plan approval and execution, the one-category test runner, and plan-vs-actual tracking (Phase 2).
- Per-operator Google logins. Google is one agency-wide connection.

## Anti-goals (would be a failure even if it works)

- Any code path that can send a mutate request to Google.
- Refresh tokens stored unencrypted, written to logs, or sent to the browser.
- Presenting a landing-page estimate as exact product sales, or mixing GA4 and platform-reported revenue without saying which is which.
- A client's Google data appearing for another client. Mapping is per client, and the API routes check client access.
- Breaking DEMO_MODE or the existing Meta flows.

## Constraints

- **Credentials are set by Rithin as environment variables.** Code must run without them (Google simply shows as not configured):
  - `GOOGLE_OAUTH_CLIENT_ID`
  - `GOOGLE_OAUTH_CLIENT_SECRET`
  - `GOOGLE_ADS_DEVELOPER_TOKEN` (approved for Standard access)
  - `GOOGLE_ADS_LOGIN_CUSTOMER_ID` (the Dotmappers MCC id, digits only)
  - `GOOGLE_ADS_API_VERSION` (optional; defaults to the current Google Ads API version, which the builder checks at build time)

  Add them to `src/lib/config.ts` (schema, raw env, `hasGoogle` flag) and `.env.example`.
- **Redirect URI** is `${APP_URL}/api/auth/google/callback`. Document in `.env.example` that it must be added to the Google Cloud OAuth client.
- **OAuth scopes:** `openid`, `email`, `https://www.googleapis.com/auth/analytics.readonly`, `https://www.googleapis.com/auth/webmasters.readonly`, `https://www.googleapis.com/auth/adwords`.
  - Request with `access_type=offline` and `prompt=consent`, so a refresh token is issued.
  - Google Ads has no read-only scope, so read-only is enforced in code: the Google Ads client only exposes query (search) methods, and a test asserts that no mutate path exists.
- **Encryption:** refresh tokens use `src/lib/security/token-vault.ts`, not the older `src/lib/meta/token-crypto.ts`.
- **Plain HTTP calls:** follow the `src/lib/meta/graph-client.ts` pattern (retries with backoff, timeouts, token in the `Authorization` header and never in URLs, typed errors). No new SDK dependency.
- **Every data path works in DEMO_MODE** through a mock Google provider with plausible data for the seeded ecommerce demo client, and in Supabase mode. This follows the existing two-store pattern.
- **Next migration** is `supabase/migrations/00012_google_connections.sql`, written to be idempotent.
- **Units:** money is integer cents; Google Ads micros are converted at the edge (÷ 10,000). ROAS is a plain multiple rounded to 2 decimals, and margins are percent.
- Run `npm run typecheck` and `npm test` before every commit. Stage files by explicit path, because the tree holds untracked user files. Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Read `node_modules/next/dist/docs/` before writing route handlers (AGENTS.md).

## Decided

### Connection and storage

- **`google_oauth_connection` table.** One agency-wide row holding:
  - `refresh_token_encrypted`, `google_email`, `scopes text[]`;
  - `connected_by` (→ profiles), `connected_at`, `last_refreshed_at`, plus the timestamps.

  RLS: admins only. Server code uses the service role.
- **Admin-only routes**, following the Meta routes' state-cookie CSRF pattern:
  - `GET /api/auth/google` (start): admin-only.
  - `GET /api/auth/google/callback`: checks the state, exchanges the code, stores the encrypted refresh token, then runs a sync.
  - `GET /api/auth/google/status`
  - `POST /api/auth/google/disconnect`
- **Access tokens** come from the refresh token, are cached in memory until shortly before expiry, and are never persisted. If Google says the grant was revoked (`invalid_grant`), status shows "reconnect".
- **`connected_google_assets` table:**
  - `kind ∈ (ga4_property, ads_customer, gsc_site)`, `external_id`, `name`, `parent_name`;
  - `currency`, `timezone`, `mapped_client_id` (→ clients, `on delete set null`);
  - `raw_metadata jsonb`, `last_synced_at`, plus the timestamps;
  - `login_customer_id` (for Ads assets: the manager account the asset was found through);
  - unique on `(kind, external_id)`, plus a partial unique index on `(kind, mapped_client_id)` where `mapped_client_id` is set.

  RLS matches `connected_meta_accounts`: select needs admin or client access, writes are admin-only.
- **Sync** (on connect and on a "Sync" button) lists:
  - **GA4:** account summaries from the Admin API.
  - **Google Ads:** client accounts under the MCC (`customer_client` query with `login-customer-id`).
  - **Search Console:** the sites list.

  It upserts assets and keeps existing mappings.
- **Mapping** happens in the Connections page through a new "Google" card next to Facebook. Assets are grouped by kind, and each has a client select. API: `POST /api/admin/google/map { assetId, clientId | null }`, admin-only.

### Reading data (src/lib/google/)

- **`provider.ts`** defines a `GoogleDataProvider` interface with a live implementation and a mock one. The live one is chosen when Google is configured and connected; the mock one in DEMO_MODE.
  - `ga4.categoryRevenue(propertyId, range)`:
    - **Item method:** `itemRevenue` / `itemsPurchased` by `itemCategory`.
    - **Landing-page method:** `purchaseRevenue` (or `totalRevenue`) by `landingPagePlusQueryString`.
    - **Per channel:** the same by `sessionSourceMedium` / `sessionDefaultChannelGroup`, so Facebook/Instagram paid and Google CPC can be separated.
    - It reports which method returned data.
  - `ads.performance(customerId, range)`:
    - campaigns with type, status, cost, conversions and conversion value;
    - landing-page cost and value from the landing page views report;
    - whether a Merchant Center link exists.
  - `gsc.pageDemand(siteUrl, range, pathPrefixes)`: clicks, impressions, position and top queries per page.
- **Category matching** reuses the URL and name rules in `src/lib/strategy/category-attribution.ts`. Extract them into a shared matcher rather than copying them.
- **Snapshot.** Results are combined per turn into a `ChannelSnapshot` for the client. Each Google part loads independently: one failing doesn't block the others, and its failure becomes a warning in the evidence, the same pattern as the Meta snapshot.

### Strategy and report changes

- **New `src/lib/strategy/channels.ts`** builds per-category, per-channel performance. For each category it holds `{ meta, google }`, each with:
  - `spendCents`;
  - `platformRevenueCents` (what Meta or Google Ads reports);
  - `ga4RevenueCents` (GA4 revenue attributed to that channel's traffic, when GA4 is mapped);
  - `roas` (GA4-based when available, otherwise platform-based, with a `basis` flag).

  It also holds `searchDemand` from Search Console.
- **Channel split rule** (recommendation only):
  - Within each funded category, split the category's daily budget by each channel's observed ROAS share.
  - Any channel with no spend history but evidence of demand gets at least 20% as a test: Google with Search Console impressions > 0 for the category, Meta when the category has a landing page.
  - With no Google Ads account mapped, Meta gets 100%, and the report says Google wasn't considered.
  - Every constant is printed in the plan's assumptions, as the existing engine already does.
- **Plan output.** `buildStrategyPlan` takes the optional channel data and adds `channelSplit` to each allocation and to the total. Without channel data, the plan is unchanged.
- **Report.**
  - **Level 1:** columns for GA4 revenue and Google spend/ROAS when present, plus the attribution method.
  - **Level 2:** GA4 vs Meta-reported revenue for paid social; Search Console demand per category.
  - **Level 3:** a Meta/Google split table, with Google labelled "recommendation for the Google Ads account; this tool doesn't change Google".
  - **Category spend questions** (general/budget evidence) gain the same GA4 and Google columns.
- **Total budgets in the brief.**
  - "$4k to get $40k back" sets a **total budget of $4k** and a target of 10×.
  - The daily budget is the total ÷ a period: the period stated in the message ("over 30 days", "this month"), or 30 days by default, printed as an assumption.
  - "$X over N days/weeks" is also accepted.
  - This changes the Phase 1 rule that the A-to-B form never sets the budget.

### UI

- **Connections page:** a Google card with:
  - Connect / Reconnect / Disconnect;
  - the connected email;
  - three asset lists, each with a client select;
  - a Sync button;
  - "not configured" when the environment variables are missing.
- **Client page:** a small "Google data" line in Overview listing the mapped GA4 property, Ads account and Search Console site, or "Not mapped — map under Connections".

### Calls made after the builder check (Claude's calls, flagged for Rithin to check)

1. **Plans scoped to named categories.** When the request names categories ("…on bar stools"), the plan covers only those categories. The whole budget goes to them, with no cross-category 70/20/10 split, and they get their own reality check and projection. A request that names no category keeps the whole-account plan. Karthik's container question is about bar stools money, not the whole account.
2. **GA4 drives the plan when it's mapped.**
   - Tier, budget weighting, projections, the account ROAS in the reality check and "meets target" all use combined Meta + Google spend against GA4 revenue.
   - Without GA4, they use the platforms' own reported revenue.
   - The report always names the basis, and shows Meta-reported vs GA4 side by side so a GA4 drop is visible rather than hidden.
   - A category with no Meta spend but proven Google ROAS counts as proven.
   - After the split, projected revenue is recomputed per channel: channel share × channel ROAS × decay.
   - The brief's budget is one combined budget for both channels.
3. **Google Ads account discovery covers both setups.**
   - The sync takes `listAccessibleCustomers`, plus the `customer_client` children of every accessible manager account, including sub-managers.
   - Each Ads asset stores the `login_customer_id` it was found through, and queries send that id.
   - `GOOGLE_ADS_LOGIN_CUSTOMER_ID` becomes the preferred manager, not the only one.
   - This also helps diagnose the "isn't connecting" report from the call.
4. **Google spend is matched to categories in three steps**, using the shared matcher, in order:
   1. landing page;
   2. campaign or asset-group name;
   3. Shopping product type / category rows (`shopping_performance_view`).

   Spend matched by none of these is shown as unmatched, never dropped.
5. **The Google recommendation names campaign types, kept small.** A Google capability list:
   - Search, when Search Console shows demand;
   - Shopping and Performance Max, only when a Merchant Center link exists, otherwise flagged as "needs a product feed";
   - Demand Gen.

   Each is marked in use / not used, as `meta-capabilities.ts` does. Level 3 lists one or two Google campaign types per funded category next to its Google budget.
6. **One asset of each kind per client.** A partial unique index on `(kind, mapped_client_id)` enforces it, and mapping a second asset replaces the first.
7. **Currencies are never mixed.**
   - If a client's GA4 property, Google Ads account and Meta account use different currencies, the report shows each channel in its own currency.
   - It skips combined totals, ROAS and the channel split, and says why.
   - No currency conversion is done.
8. **"Best category" ranks by GA4 revenue when GA4 is mapped,** then by combined ROAS. Without GA4, it ranks by combined platform-reported revenue. The evidence names the ranking key.
9. **Brief wording.** "Spend $4k and get $40k back", "$4k to get $40k", "spend $4k to make $40k" and "$4k for $40k in sales" are all recognised as the total-budget form.

## Left to the builder

- Exact GA4 dimension and metric names, and their compatibility. Verify against the GA4 Data API docs: item-scoped and session-scoped dimensions can't always be combined. If per-channel item revenue isn't possible, use landing-page revenue per channel and say so in the evidence.
- The current Google Ads API version and GAQL field names (`landing_page_view`, `customer_client`, the Merchant Center link resource). Verify against Google's current docs at build time.
- Mock data shapes for DEMO_MODE, as long as the seeded ecommerce demo client (ClickTrends, with Bar stools and Sofas) gets a granted demo Meta account and mapped demo Google assets, so the whole flow can be shown in demo mode.
- File boundaries inside `src/lib/google/`, with one responsibility per file.
- Exact copy, following the repo's tone: plain, short, no jargon.
