# Commerce Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read Meta Commerce Manager catalogues (diagnostics, products, feeds, product sets, pixel matching), use them as evidence in the workspace chat and the Meta audit (especially for learning-limited ad sets), show them on a new Commerce page, and queue catalogue fixes through approvals.

**Architecture:** A pure catalogue data layer (`src/lib/meta/catalog/`) takes an injected graph client and returns a typed `CatalogSnapshot`; a deterministic findings engine turns it into `CatalogFinding[]`. One service resolves a client's catalogues and caches snapshots; the chat read tools, the audit, and the `/api/commerce` routes all call that service. Fixes are new execute tools on the existing approval path.

**Tech Stack:** Next.js 16 (App Router, read `node_modules/next/dist/docs/` before route work; route files export only handlers), TypeScript, zod, Vitest 4, Meta Graph API via `MetaGraphClient`, AI SDK tools.

**Spec:** `docs/superpowers/specs/2026-11-04-commerce-manager-design.md`

## Global Constraints

- Every catalogue read goes through `MetaGraphClient` (`src/lib/meta/graph-client.ts`) with the API version from `getMetaGraphVersion()`.
- Never read every product to count: counts come from `/{catalog}/diagnostics`, product-set `product_count`, and filtered `/products` queries. Product lists page on demand.
- A client sees only catalogues reached through its own mapped ad accounts' ad sets (`promoted_object.product_set_id` → `/{product_set}?fields=product_catalog`). Business-owned catalogues are never added.
- A missing `catalog_management` permission is a typed state (`missing_permission`) shown with a reconnect action, never an empty page or a crash.
- Every write is an execute tool behind an approval; product-set filter and feed refresh are risk `high`.
- Source-synced product data (Shopify etc.) is never edited.
- Findings carry the numbers that triggered them; the LLM explains, it does not invent findings.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A catalogue with 287,361 products (During Days Catalogue-2026): the snapshot must finish in one bounded set of calls with no full product scan. Pinned in Task 1 (`never pages /products for counts`).
2. A catalogue with no feeds (Shopify-synced, e.g. "During Days - Shopify Product Catalog"): no "feed broken" finding. Pinned in Task 2.
3. Token without `catalog_management` (Graph error code 100/200 "not been approved" or "permission"): page, tools and audit all report `missing_permission`. Pinned in Tasks 1, 4, 5.
4. Learning-limited ad set whose catalogue is healthy: the audit must say the catalogue is not the cause. Pinned in Task 2 (`learningLink` healthy branch) and Task 5.
5. Pixel events matching a different catalogue (`total_content_ids_matched_other_catalogs` > 0): its own finding. Pinned in Task 2.

---

### Task 1: Catalogue snapshot (data layer)

**Files:**
- Create: `src/lib/meta/catalog/types.ts`, `src/lib/meta/catalog/snapshot.ts`, `src/lib/meta/catalog/errors.ts`
- Test: `tests/catalog-snapshot.test.ts`

**Interfaces:**
- Produces:
  - `type CatalogGraph = Pick<MetaGraphClient, "get">`
  - `class CatalogAccessError extends Error { reason: "missing_permission" | "not_found" }` and `catalogAccessReason(error: unknown): "missing_permission" | "not_found" | null` (MetaGraphError code 100 or 200 with message matching `/not been approved|permission/i` → `missing_permission`; code 803 or "does not exist" → `not_found`).
  - `type CatalogDiagnostic = { type: string; severity: string; title: string; errorCode: number | null; affectedItems: number; children: Array<{ type: string; description: string; affectedItems: number }> }`
  - `type CatalogProductSet = { id: string; name: string; filter: string | null; productCount: number; inStockCount: number | null }`
  - `type CatalogFeed = { id: string; name: string; productCount: number; scheduleUrl: string | null; scheduleInterval: string | null; lastUpload: { endTime: string | null; errorCount: number; warningCount: number } | null }`
  - `type CatalogEventMatch = { event: string; pixelId: string | null; matched: number; unmatched: number; matchedOtherCatalogs: number }` (summed over the days returned)
  - `type CatalogSnapshot = { id: string; name: string; vertical: string | null; productCount: number; diagnostics: CatalogDiagnostic[]; productSets: CatalogProductSet[]; feeds: CatalogFeed[]; events: CatalogEventMatch[]; pixelIds: string[]; outOfStockCount: number | null; warnings: string[]; fetchedAt: string }`
  - `fetchCatalogSnapshot(graph: CatalogGraph, catalogId: string, opts?: { productSetIds?: string[] }): Promise<CatalogSnapshot>`
  - `listCatalogProducts(graph, catalogId, opts: { issue?: "out_of_stock" | "rejected" | "any_error"; after?: string; limit?: number }): Promise<{ products: Array<{ id: string; retailerId: string; name: string | null; availability: string | null; reviewStatus: string | null; visibility: string | null; url: string | null; imageUrl: string | null; price: string | null; errors: Array<{ type: string; priority: string; title: string }> }>; next: string | null }>`

- [ ] **Step 1: Write the failing tests** in `tests/catalog-snapshot.test.ts` with a fake `get` (pattern: `tests/account-dashboard.test.ts`) answering by path, using the shapes from the 2026-11-04 live check:
  - `builds the snapshot from diagnostics, sets, feeds and event stats`: catalogue `1316306267021132` with diagnostics `[{type:"DA_VISIBILITY_ISSUES",severity:"MUST_FIX",number_of_affected_items:56743,diagnostics:[{type:"PRODUCT_OUT_OF_STOCK",number_of_affected_items:55311,…}]}]` → `outOfStockCount === 55311`, `diagnostics[0].affectedItems === 56743`; a product set with `filter` string keeps it; event_stats rows for ViewContent on two days sum `matched`.
  - `in-stock count per used product set`: with `productSetIds: ["1290781623112463"]`, the set's `inStockCount` comes from one `/{set}/products` call with `filter={"availability":{"eq":"in stock"}}` and `summary=true` (read `summary.total_count`); sets not listed keep `inStockCount: null`.
  - `never pages /products for counts`: assert no request path ends in `/{catalogId}/products`.
  - `a failing part becomes a warning`: feeds call throws → `feeds: []`, a warning mentioning "feeds", rest intact.
  - `missing permission is typed`: the first `/{catalog}` call throws `new MetaGraphError("(#100) This application has not been approved to use this api", 100, 400)` → rejects with `CatalogAccessError` reason `missing_permission`.
  - `listCatalogProducts` with `issue: "out_of_stock"` sends `filter={"availability":{"eq":"out of stock"}}` and returns `next` from `paging.cursors.after` only when `paging.next` exists.
- [ ] **Step 2: Run** `npx vitest run tests/catalog-snapshot.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** the three files. Parts load in parallel with a local `settle(label, warnings, promise)` like `src/lib/audit/meta-audit-data.ts:294`; only the basics call (`/{catalog}?fields=id,name,vertical,product_count`) is allowed to throw (mapped through `catalogAccessReason`). Feeds: `/{catalog}/product_feeds?fields=id,name,product_count,schedule` then `/{feed}/uploads?fields=end_time,error_count,warning_count&limit=1` for each (cap 10 feeds). Event stats: `/{catalog}/event_stats`; pixel ids from `/{catalog}/external_event_sources`. Verify each field name against the Graph reference for the configured version and drop any the API rejects.
- [ ] **Step 4: Run** the test file → PASS.
- [ ] **Step 5: Commit** `feat(catalog): catalogue snapshot data layer`.

### Task 2: Findings engine and learning-limited link

**Files:**
- Create: `src/lib/meta/catalog/findings.ts`
- Test: `tests/catalog-findings.test.ts`

**Interfaces:**
- Consumes: `CatalogSnapshot` (Task 1).
- Produces:
  - `type CatalogAdSetUse = { adSetId: string; adSetName: string; campaignId: string; accountId: string; productSetId: string; learningStatus: "LEARNING" | "SUCCESS" | "FAIL" | null; effectiveStatus: string; spendCents?: number }`
  - `type CatalogFix = { toolName: "update_product_set_filter"; args: { product_set_id: string; filter: string } } | { toolName: "request_feed_refresh"; args: { feed_id: string } } | { toolName: "pause_adset"; args: { adset_id: string } }`
  - `type CatalogFinding = { id: string; severity: "critical" | "high" | "medium" | "low"; title: string; evidence: string[]; productSetIds: string[]; adSetIds: string[]; howToFix: string; fix: CatalogFix | null }`
  - `type LearningLink = { adSetId: string; productSetId: string; verdict: "likely_contributor" | "healthy"; reasons: string[] }`
  - `evaluateCatalog(snapshot: CatalogSnapshot, uses: CatalogAdSetUse[], thresholds?: Partial<CatalogThresholds>): { findings: CatalogFinding[]; learningLinks: LearningLink[] }`
  - `CATALOG_THRESHOLDS = { minDeliverableItems: 20, outOfStockShareHigh: 0.2, feedStaleHours: 48, matchRateLow: 0.9 }` (exported; document in the file why each value).

- [ ] **Step 1: Write the failing tests**, one per finding id, each asserting `id`, `severity`, and that `evidence` contains the triggering number:
  - `diagnostics_must_fix`: MUST_FIX diagnostic with 56743 affected → severity `high`, evidence contains "56,743".
  - `out_of_stock_in_used_set`: used set with `productCount 287361`, `inStockCount 232015` → share 19.3%, no finding at 0.2 threshold; with `inStockCount 200000` → finding with fix `update_product_set_filter` whose `filter` adds `{"availability":{"eq":"in stock"}}` (and-ed with the existing filter when one exists; a set already filtering availability = in stock gets no fix).
  - `small_product_set`: used set with `inStockCount 4` → `high`, fix `null`, `howToFix` mentions widening the set's filter.
  - `feed_stale` / `feed_upload_errors`: feed with `scheduleUrl` and `lastUpload.endTime` 72h ago → `feed_stale` with fix `request_feed_refresh`; `errorCount 12` → `feed_upload_errors`. A catalogue with `feeds: []` produces **neither** (Review Focus 2).
  - `low_match_rate`: ViewContent matched 4398 / unmatched 10 → no finding; matched 500 / unmatched 300 → finding.
  - `matched_other_catalog`: `matchedOtherCatalogs 2103` vs matched 2295 → finding naming the event (Review Focus 5).
  - `learningLinks`: FAIL ad set on a set with `inStockCount 4` → `likely_contributor` with a reason containing "4"; FAIL ad set on a healthy set (in stock 232015, no stale feed, good match) → `healthy` (Review Focus 4). Non-FAIL ad sets produce no link.
  - Findings are sorted critical → low, then by affected items.
- [ ] **Step 2: Run** `npx vitest run tests/catalog-findings.test.ts` → FAIL.
- [ ] **Step 3: Implement** `evaluateCatalog` as pure functions per check; numbers formatted with `toLocaleString("en-US")`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(catalog): findings and learning-limited link`.

### Task 3: Catalogue discovery and the service

**Files:**
- Create: `src/lib/meta/catalog/service.ts`, `src/lib/meta/catalog/demo.ts`
- Modify: `src/lib/meta/provider-v2.ts:175-186` (`promotedConversion` also returns `product_set_id`), `src/lib/audit/meta-audit-data.ts:108-138,752-775` (`AuditAdSet.productSetId?: string`, mapped from `promoted_object.product_set_id`)
- Test: `tests/catalog-service.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces:
  - `discoverClientCatalogs(graph: CatalogGraph, accountIds: string[]): Promise<{ catalogs: Array<{ id: string; name: string; productCount: number }>; uses: CatalogAdSetUse[] }>`: per account `act_{id}/adsets?fields=id,name,campaign_id,effective_status,learning_stage_info,promoted_object&limit=500` (paged, cap 5 pages), ad sets with `promoted_object.product_set_id` → one `/{set}?fields=product_catalog{id,name,product_count}` per distinct set.
  - `type CommerceState = { state: "ok"; catalogs: …; uses: CatalogAdSetUse[] } | { state: "not_connected" | "missing_permission" | "no_ad_account" | "no_catalog"; message: string }`
  - `getClientCommerce(clientId: string): Promise<CommerceState>` (mapped accounts via `loadMappedMetaAccounts(clientId)` filtered `access_status === "granted"`; token via `getUserMetaToken()`; demo data from `demo.ts` when `getConfig().isDemoMode`).
  - `getCatalogReport(clientId: string, catalogId: string): Promise<{ state: "ok"; snapshot: CatalogSnapshot; findings: CatalogFinding[]; learningLinks: LearningLink[]; uses: CatalogAdSetUse[] } | Exclude<CommerceState, { state: "ok" }>>`: refuses a `catalogId` not in the client's discovered catalogues (`state: "no_catalog"`), cached 5 minutes keyed by `${userId}:${catalogId}`.

- [ ] **Step 1: Write the failing tests**: discovery from two accounts sharing one product set yields one catalogue and two uses; ad sets without `product_set_id` ignored; a catalogue id not discovered for the client → `no_catalog`; `CatalogAccessError("missing_permission")` → `state: "missing_permission"` with a message containing "Reconnect Facebook"; demo mode returns the demo fixture without any graph call. Add to `tests/audit-changes.test.ts`-style audit test: an ad set with `promoted_object: { product_set_id: "1290781623112463" }` maps to `productSetId`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Mock `getUserMetaToken` / `loadMappedMetaAccounts` with `vi.mock` in tests.
- [ ] **Step 4: Run** the new test plus `npx vitest run tests/audit tests/meta-provider-mutations.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(catalog): client catalogue discovery and service`.

### Task 4: Chat read tools

**Files:**
- Create: `src/lib/tools/diagnose/catalog-tools.ts`
- Modify: `src/lib/tools/diagnose/index.ts` (import), `src/lib/tools/policy.ts` (four names → `"diagnose"`), `src/lib/tools/display-labels.ts`, `src/lib/agent/diagnose-tools-ai.ts:133-143` (add `CATALOG_TOOLS` when `getClientCommerce(ctx.clientId)` is `ok`; on any error leave them out), `src/lib/agent/prompts-v2.ts` (a short catalogue paragraph next to the Shopify guidance: when to call them, cite numbers, catalogue can explain learning limited)
- Test: `tests/catalog-tools.test.ts`

**Interfaces:**
- Consumes: `getClientCommerce`, `getCatalogReport`, `listCatalogProducts` (Tasks 1, 3).
- Produces tools (all take the client from `ctx`, never from the model):
  - `meta_catalogs()` → catalogues + which ad sets use each.
  - `meta_catalog_health({ catalog_id })` → snapshot summary + findings + learningLinks.
  - `meta_catalog_products({ catalog_id, issue?, after? })` → one page (≤ 50).
  - `meta_catalog_feeds({ catalog_id })` → feeds with last upload.

- [ ] **Step 1: Write the failing tests** (pattern: `tests/shopify-tools.test.ts`): each tool returns the service data; `missing_permission` returns `{ error: true, missing_permission: true, message }`; a `catalog_id` from another client returns the `no_catalog` message; the tool set for a client with no catalogue has none of the four names, with one has all four.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** plus `tests/workspace-data-tools.test.ts tests/meta-account-health.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(catalog): workspace chat catalogue tools`.

### Task 5: Audit evidence and framework

**Files:**
- Modify: `src/lib/audit/render.ts` (new `renderCatalogEvidence(reports: CatalogEvidenceInput[], learningLimited: AuditAdSet[]): string`), `src/lib/agent/adspirer-agent.ts:2596-2598` (after the three pushes: when any audited ad set has `productSetId`, call `getCatalogReport` for its catalogues and push the section; `missing_permission` pushes the warning line), `src/lib/agent/meta-audit-framework.ts` (catalogue lens under the lenses, a "Catalogue (Commerce Manager)" report heading, and the rule: say "catalogue is not the cause" when the link is `healthy`)
- Test: `tests/audit-catalog-evidence.test.ts`

**Interfaces:**
- Consumes: Task 2 types, Task 3 `getCatalogReport`.
- Produces: `type CatalogEvidenceInput = { catalogName: string; catalogId: string; snapshot: CatalogSnapshot; findings: CatalogFinding[]; learningLinks: LearningLink[] } | { catalogId: string; missing: "missing_permission" | "no_catalog"; message: string }`

- [ ] **Step 1: Write the failing tests**: heading `### Catalogue (Commerce Manager) — live Meta data, authoritative`; each finding as a bullet with its evidence numbers; each learning link as "Ad set X (learning limited) → product set Y: likely contributor because …" or "… catalogue looks healthy; look elsewhere"; missing permission renders "Catalogue not read: reconnect Facebook to grant catalogue access"; framework text contains "catalogue is not the cause".
- [ ] **Step 2–4:** run → FAIL, implement, run plus `npx vitest run tests/audit` → PASS.
- [ ] **Step 5: Commit** `feat(audit): Commerce Manager evidence and lens`.

### Task 6: Commerce API routes

**Files:**
- Create: `src/app/api/commerce/route.ts` (GET `?clientId=` → `getClientCommerce`), `src/app/api/commerce/[catalogId]/route.ts` (GET `?clientId=` → `getCatalogReport`), `src/app/api/commerce/[catalogId]/products/route.ts` (GET `?clientId=&issue=&after=` → `listCatalogProducts`, only after the same client check), `src/app/api/commerce/fixes/route.ts` (POST `{ clientId, catalogId, findingId }` → re-evaluates the report, takes that finding's `fix`, calls `createPendingApproval({ clientId, toolName, proposedArgs: fix.args, rationale })`, returns the approval id)
- Test: `tests/commerce-routes.test.ts`

**Interfaces:**
- Consumes: Task 3 service, `createPendingApproval` (`src/lib/approvals/service.ts:121`), auth as in `src/app/api/dashboard/meta/route.ts:42-135` (`getCurrentUser` → `assertClientAccess`).
- Produces: JSON bodies equal to the service return values; fixes route returns `{ approvalId }` or 400 `{ error }` when the finding has no executable fix.

- [ ] **Step 1: Write the failing tests**: unauthenticated → 401; another client's catalogue → `no_catalog`; fixes route builds the approval from the server-side finding (a client-supplied filter in the body is ignored) and its `rationale` lists every affected ad set name plus "Ad sets in ad accounts not mapped to this client also use this product set and would change too." for product-set and feed fixes.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(commerce): API routes`.

### Task 7: Catalogue fix execute tools

**Files:**
- Modify: `src/lib/tools/policy.ts`, `src/lib/tools/execute/schemas.ts` (+ `EXECUTE_TOOL_SCHEMAS`), `src/lib/tools/execute/index.ts`, `src/lib/approvals/validate-args.ts` (executable tool list at :399), `src/lib/approvals/executor.ts` (`dispatchToProvider` cases + `buildExecutionResult` proof), `src/lib/approvals/risk.ts` (both tools `high`), `src/lib/adspirer/provider.ts`, `src/lib/meta/provider-v2.ts`, `src/lib/adspirer/mock-provider.ts`, `src/lib/tools/display-labels.ts`
- Test: `tests/catalog-fix-tools.test.ts`

**Interfaces:**
- Produces provider methods:
  - `updateProductSetFilter({ product_set_id: string; filter: string }): Promise<{ product_set_id: string; before_filter: string | null; after_filter: string; product_count_after: number | null }>`: reads the set, POSTs `/{product_set_id}` with `filter`, reads back.
  - `requestFeedRefresh({ feed_id: string }): Promise<{ feed_id: string; upload_session_id: string | null }>`: reads `schedule.url`, POSTs `/{feed_id}/uploads` with `url`; refuses with "This feed has no schedule URL to re-fetch" when none.
  - Permission errors in both are rethrown as `CatalogAccessError("missing_permission")` whose message is: "The approver's Facebook connection cannot manage this catalogue: reconnect Facebook, or have someone with access approve." Nothing is sent before the read succeeds.
- The item availability/visibility tool from the spec is **deferred**: no catalogue seen in the live check is safely editable (Shopify-synced or feed-sourced, both overwrite), so v1 does not offer it.

- [ ] **Step 1: Write the failing tests** (pattern: `tests/adset-edit-tools.test.ts`, `tests/meta-provider-mutations.test.ts`): schema rejects a non-JSON `filter`; `assessRisk` returns `high` for both; executor dispatches with exact args; provider read-before-write (a GET 100 error → `CatalogAccessError`, no POST made); proof contains before/after filter.
- [ ] **Step 2–4:** FAIL → implement → PASS, then the whole suite `npx vitest run` → all PASS.
- [ ] **Step 5: Commit** `feat(catalog): product-set filter and feed refresh fixes via approvals`.

### Task 8: Commerce page and nav

**Files:**
- Create: `src/app/(app)/commerce/page.tsx`, `src/components/commerce/commerce-overview.tsx`, `src/components/commerce/products-table.tsx`, `src/components/commerce/feeds-list.tsx`, `src/components/commerce/product-sets-list.tsx`
- Modify: `src/components/layout/app-sidebar.tsx:34-42` (`{ href: "/commerce", label: "Commerce", icon: ShoppingBag }` after Creatives)
- Test: `tests/commerce-page.test.tsx` only if the repo already renders components in tests; otherwise cover through Task 6 and verify in the browser.

**Interfaces:**
- Consumes: Task 6 routes; `useApp()` (`src/components/layout/app-provider.tsx:219`) for the selected client.

- [ ] **Step 1: Build** the page: catalogue picker (from GET `/api/commerce`), tabs Overview / Products / Feeds / Product sets / Pixel matching as in the spec. Overview: health cards (products, out of stock, rejected from diagnostics, feed status, match rate) then Suggestions sorted as returned, each with evidence bullets, "How to fix", and "Queue fix" (POST `/api/commerce/fixes`, toast with a link to Approvals) when `fix` is set. Product sets: product count, in-stock count, ad sets using it with a learning badge. States: `missing_permission` / `not_connected` → reconnect button to `/api/auth/meta?returnTo=/commerce`; `no_catalog`; loading; warnings banner. An "Ask in Workspace" link to `/workspace?clientId=…` with a prefilled question naming the catalogue.
- [ ] **Step 2: Verify** with the run skill / browser against the dev server: nav item shows, picker lists the client's catalogues, a Queue fix creates an approval visible in Approvals.
- [ ] **Step 3: Commit** `feat(commerce): Commerce page`.

### Task 9: Live read-only verification

- [ ] **Step 1:** With `.env.local` loaded (`node --env-file=.env.local node_modules/vitest/vitest.mjs run <temp test>`), run `fetchCatalogSnapshot` + `evaluateCatalog` against During Days Catalogue-2026 (`1316306267021132`) and During Days - Shopify Product Catalog (`1448125966367759`); write results to the scratchpad, never print tokens; delete the temp test. Expected: completes in under 60 s, `outOfStockCount` ≈ diagnostics' 55,311, a `matched_other_catalog` finding on the Shopify catalogue, no feed finding on it.
- [ ] **Step 2:** `npx tsc --noEmit` clean and `npx vitest run` all pass.
- [ ] **Step 3:** Report to the operator; merge and push only when asked.
