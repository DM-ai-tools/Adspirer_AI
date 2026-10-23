# Shopify product data, web benchmarks and capacity check: design

20 October 2026 · Phase 4 of the [goal-driven strategy roadmap](../../strategy/2026-10-19-goal-driven-strategy-roadmap.md) (Amazon is deferred) · spec of record: [Karthik strategy call](../../strategy/2026-10-16-karthik-strategy-call.md)

## Why

Karthik wants the tool to know the whole business before it plans: every category, sales, inventory, SKU and supplier data. He also wants each target checked against a benchmark with a named source ("which site the 10x benchmark is based on"), and the website checked before a category is scaled.

The plan currently relies on margins someone typed in and on generic playbook benchmarks, and it can't see stock. DuringDays runs on Shopify, and Dotmappers already has staff/collaborator access to its admin.

## Goals

1. **Connect a client's Shopify store, read-only.**
   - An admin enters the store address (`<store>.myshopify.com`) and an Admin API access token. The token comes from a custom app the Dotmappers staff account creates in that store, with read-only scopes.
   - The tool syncs:
     - collections;
     - products, with vendor and product type;
     - variants, with SKU, price, **cost per item** and **inventory quantity**;
     - sales per variant for the last 30 and 90 days, aggregated from orders.
   - It never changes anything in Shopify.
2. **Shopify feeds the plan.** Collections map to the client's categories.
   - **Margin:** a category's gross margin comes from Shopify (price vs cost per item, weighted by recent revenue) when no margin was entered by hand. A manually entered margin wins. The report says which source each margin came from.
   - **Stock:** units in stock per category, plus sales speed (units per day over the last 30 days).
   - **Sales:** units and revenue per category and per SKU, from Shopify orders.
3. **Capacity check before scaling.** For each funded category the plan checks:
   - **Stock:** is there enough to cover the units the plan projects over its period? (Projected revenue ÷ the category's average selling price.) If not, the category's budget is capped to what stock supports, with a flag such as "~40 in stock, plan projects ~120 sales over 30 days: restock first or cap budget". The freed budget is redistributed with the plan's existing rules.
   - **Landing page:** does the category landing page load, and is it fast enough? This uses the existing page checks and PageSpeed.
   - **Range:** fewer than 3 active products is flagged as thin.

   Failures are flagged in the evidence. Categories are never silently dropped.
4. **Product lookup in chat.**
   - When a client has Shopify connected, the workspace assistant gets read-only lookup tools over the synced data: top products by units or revenue (optionally for one category), SKU lookup, and vendor/supplier summary.
   - Rows are capped, and every result states the sync time and age, for example "Shopify data synced 3 hours ago".
5. **Benchmarks from the web.**
   - An admin can click "Research benchmarks" for an industry. The tool runs web searches (Firecrawl search), reads the top sources and extracts figures: Meta ROAS, Google ROAS, conversion rate, CPA.
   - Each figure is stored with its source URL, page title, retrieval date and the **verbatim quote** it came from.
   - An admin approves or rejects each figure. Approved figures are **shared by every client in that industry**.
   - Level 2's reality check uses approved figures and cites them, e.g. "10× vs 4.2× typical for furniture ecommerce (source: <title>, retrieved 20 Oct 2026)". With none approved, it keeps today's generic numbers, labelled generic.

## Non-goals

- Writing to Shopify (products, prices, inventory, orders, discounts, anything).
- Live Shopify calls on each chat message. Chat reads the synced tables; Shopify is only called by sync.
- A Shopify App Store listing. A Dev Dashboard app with custom distribution is in scope; see call 1 below.
- Amazon data of any kind.
- Plan approval and execution (Phase 2).
- Scraping any site's terms-restricted data. Benchmark research only reads pages returned by web search, through Firecrawl.

## Anti-goals (would be a failure even if it works)

- **Storing customer personal data.** No customer names, emails, addresses or phone numbers are stored or logged. Order data is kept only as per-variant aggregates (units, revenue).
- **Leaking tokens.** Shopify tokens must never be stored unencrypted, logged, sent to the browser, or readable by browser sessions; the token table is service-role only, like `google_oauth_connection`.
- **Unsourced benchmarks.** A benchmark figure without a source URL, a date and a quote containing the number is never stored. Pending or rejected figures are never used by a plan.
- **Silently changing margins.** The plan must say whether each margin is manual or from Shopify.
- **Breaking DEMO_MODE or the existing Meta/Google flows.** Clients without Shopify or approved benchmarks keep today's output.

## Constraints

- **Shopify Admin GraphQL API**, at a version pinned in config: `SHOPIFY_API_VERSION`, defaulting to the current stable version, which the builder checks at build time.
  - Scopes: `read_products`, `read_inventory`, `read_orders`.
  - Large catalogues sync with **bulk operations** (`bulkOperationRunQuery`, then the JSONL download). Read-only means GraphQL `query` operations plus the bulk-query mutation Shopify requires to start a bulk read. No other mutations are allowed.
  - A test asserts the Shopify client sends no mutation other than `bulkOperationRunQuery`.
- **Per-store token**, encrypted with `src/lib/security/token-vault.ts`, in a service-role-only table. Admin-only connect, sync, disconnect and map routes.
- **Web search** uses Firecrawl's search endpoint with the existing `FIRECRAWL_API_KEY`. Extraction uses the existing LLM pattern (`src/lib/brand/analyze-url.ts`). When Firecrawl isn't configured, "Research benchmarks" says so and does nothing.
- **Same engineering rules as before:**
  - money is integer cents; margins are percent; ROAS is a plain multiple;
  - every data path works in DEMO_MODE (mock Shopify data for ClickTrends' Bar stools and Sofas, and seeded approved demo benchmarks for its industry) and in Supabase;
  - migrations are idempotent, next number `00013`;
  - plain-fetch HTTP with retries and timeouts (the `graph-client.ts` / `google/http.ts` pattern);
  - read `node_modules/next/dist/docs/` before route handlers;
  - stage explicit paths; typecheck and full test suite before each commit.
- **Sync triggers:** on connect, a "Sync now" button, and `POST /api/cron/shopify-sync` with `CRON_SECRET` (the existing Railway cron pattern) for a nightly run.

## Decided

- **Collections → categories:** a collection maps to a category when the category's landing URL path is `/collections/<handle>`, or its name matches the collection title (the shared category matcher). An admin can also link a collection to a category by hand in the Categories tab. Unmapped collections are listed as "not mapped to a category".
- **Supplier** is Shopify's product `vendor` field.
- **Shopify-derived category margin:** (Σ revenue − Σ cost) ÷ Σ revenue over the category's variants sold in the last 90 days. Variants with no cost per item are left out and counted ("margin based on N of M products; M−N have no cost set"). With no sales, fall back to the price-weighted average across active variants.
- **Average selling price** for the capacity check = 90-day revenue ÷ units for the category, or the mean active variant price when there are no sales.
- **Benchmarks are shared per industry.** Industry is a normalised lowercase string from the client's `industry` field. Several approved figures for the same metric and industry use the median, and every source is cited.
- **Lookup tools** are `diagnose`-class, registered in the tool registry, and added to the writer only when the client has a Shopify store connected and synced. Hard caps: at most 25 rows; date windows 30 or 90 days only.

### Calls made after the builder check (Claude's calls, flagged for Rithin to check)

1. **How the tool gets Shopify access.** Since 1 Jan 2026, Shopify no longer allows new custom apps to be created in the store admin. Legacy ones keep working. New apps are made in Shopify's Dev Dashboard. The tool supports two ways to connect:
   - **(a) Paste an existing legacy custom-app Admin API token.** This only works if one already exists for the store.
   - **(b) Connect with Shopify,** using one Dotmappers Dev Dashboard app with custom distribution. The admin enters the store address, approves the install, and the tool receives a non-expiring offline token through the authorization-code grant.
   - Option (b) needs `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET`, set by Rithin. The callback route is `/api/auth/shopify/callback`, with HMAC and state validation.
   - This replaces the "custom-app token only" non-goal. A Partner app listing is still out of scope.
2. **Order windows are 30 and 60 days,** not 90. `read_orders` only returns the last 60 days, and `read_all_orders` needs Shopify's approval. The margin weighting, average selling price and lookup windows use 60 days.
3. **What counts as stock.**
   - Untracked variants, or variants that can sell at zero stock (inventory policy `CONTINUE`), count as **unlimited**. The stock check skips them, with a note such as "N products sell without stock limits".
   - Negative quantities count as 0.
   - Quantity is the variant's available total across all locations.
   - If the last sync is older than 72 hours, the stock check is skipped with a note that stock data is stale.
4. **Each product counts in exactly one category.** Among the categories its collections map to, it goes to the most specific one (the collection with the fewest products). Ties go to higher category priority, then name.
   - Collections holding more than 50% of all products ("All", "Sale") are ignored unless linked to a category by hand.
   - A category can link several collections.
5. **The reality check uses approved benchmarks when they exist.**
   - Meta-only plan: the approved Meta ROAS median.
   - Cross-channel plan: Meta and Google ROAS weighted by the plan's channel split.
   - The cited benchmark becomes the reference on its own. The account's own ROAS stays as a separate reference line.
   - The approved Meta ROAS also replaces the generic 1.5× prospecting fallback for test returns.
   - CPA and conversion rate are listed as references only.
6. **Benchmark industry is a new client field.** `benchmark_industry` is normalised lowercase text. Its select offers existing benchmark industries plus "new", and it defaults from `industry`. The demo ClickTrends gets `"furniture ecommerce"`, while its `industry` stays as it is so other demo outputs don't change.
7. **Budget freed by stock caps.**
   - It's redistributed once, by the existing weights, to funded categories that aren't capped.
   - Whatever can't be absorbed is left unallocated, and the plan says so ("$X/day unallocated: stock limits"). This includes the case where a scoped plan's only category is capped.
   - Stretch scenarios apply the same caps.
8. **When chat gets the Shopify lookup tools.**
   - General, budget and strategy turns get **only** the Shopify lookup tools (at most 4 tool steps), when the client has a synced store.
   - Audit turns get them alongside the existing Meta tools.
   - Clients without Shopify are unchanged.
9. **Where each margin comes from.**
   - A new `margin_source` on categories: `manual | import | shopify`.
   - Manual and imported margins win over Shopify's, and Shopify fills only blanks.
   - Shopify-derived margins count as known category margins for the account's reference margin.
   - There is no Shopify account-level margin.
10. **Shopify sales are evidence only.** They're shown next to GA4 and Meta figures, but tiers, weights and the revenue basis keep using the existing GA4/platform rules, since GA4 is the source of truth.

## Left to the builder

- Exact GraphQL queries, the bulk-operation polling approach and the current API version. Verify against shopify.dev.
- Table shapes beyond what's stated, as long as no customer data is stored and tokens are service-role only.
- Firecrawl search request shape and result count (5–10 sources per research run), and the LLM extraction prompt. It must require a verbatim quote containing the number, and code checks that the quote contains it.
- UI layout for the Shopify card (client Settings or the Categories tab) and the Benchmarks review list (an admin page), following existing styles.
- File boundaries, with one responsibility per file.
