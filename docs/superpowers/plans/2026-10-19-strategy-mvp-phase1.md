# Goal-driven Strategy MVP (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An operator asks the workspace chat for a strategy with a budget and a target ROAS. They get a three-level report built from Meta data and the client's product categories:
- **Level 1:** where you are, per category.
- **Level 2:** how the target compares with the reference benchmark.
- **Level 3:** a margin-adjusted, per-category plan with structure, creative plan and stretch scenarios.

**Architecture:**
- **Categories.** Product categories reuse `client_services`. A migration adds margin, AOV, URL patterns and source. Categories get Excel/CSV import, a website scan for candidates, and a client-page tab.
- **Strategy engine.** A new pure module, `src/lib/strategy/`:
  1. Attribute ad spend to categories.
  2. Detect unused Meta capabilities.
  3. Compute per-category target ROAS.
  4. Allocate budget 70/20/10 across tiers.
  5. Project revenue.
- **Agent wiring.** A new `strategy` request intent runs the audit snapshot and scorecard, feeds the engine's output to the writer as evidence, and the writer follows a fixed three-level framework. Recommend only: nothing is executed in this phase.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, zod 4, Supabase (and the DEMO_MODE in-memory store), `xlsx`, Firecrawl REST, Vitest.

**Spec:**
- Call notes: [`docs/strategy/2026-10-16-karthik-strategy-call.md`](../../strategy/2026-10-16-karthik-strategy-call.md)
- Gap analysis and phase scope: [`docs/strategy/2026-10-19-goal-driven-strategy-roadmap.md`](../../strategy/2026-10-19-goal-driven-strategy-roadmap.md)

## Global Constraints

- Read the relevant guide in `node_modules/next/dist/docs/` before writing route handlers. This Next.js version has breaking changes (AGENTS.md).
- **Money is integer cents.** Margins are percents 0–100. ROAS is a plain multiple, for example `10` for 10×, rounded to 2 decimals.
- **Two stores.** Every data path works in both `DEMO_MODE` (`getDemoStore()`) and Supabase, following the pattern in `src/app/api/clients/[id]/services/route.ts`.
- **Access checks.** Every API route calls `assertAuthenticated` + `assertClientAccess`. Writes to categories are allowed to anyone with client access, the same as today's services POST.
- **Recommend only.** The strategy intent never queues execute tools or approvals in Phase 1.
- **Never invent numbers.** The writer is told to use only numbers from the evidence. Every assumption the engine uses (decay factor, test discount, benchmark source) is printed in the evidence.
- **Plain user-facing copy.** Say "category", not "service", when `goals.business_model === "ecommerce"`. Say "service" otherwise.
- **Migration naming.** Next migration is `supabase/migrations/00011_strategy_categories.sql`, and it must be idempotent (`add column if not exists`).
- Run `npm run typecheck` and `npm test` before every commit.

## Review Focus

1. **A client with no categories.** The plan still renders. Level 1 shows account totals, the gap view shows capabilities only, and the report says categories are the first thing to add. There must be no crash and no empty table. Test in Task 7.
2. **Ads whose destination URL is missing or carries UTMs or query strings.** URLs are matched on host + path with the query stripped. An ad that matches nothing goes to `unmatched` and is never dropped. Test in Task 4.
3. **A target the account can't plausibly reach, for example 10× against a 1.5× reference.** The reality check verdict is `unrealistic`, and the plan still allocates rather than refusing. Test in Task 7.
4. **Category margin missing for some categories.** Those categories fall back to the account target with `basis: "account_target"`. Mixing them with margin-adjusted ones must not produce NaN. Test in Task 6.
5. **A spreadsheet with messy headers ("Gross Margin %", "AOV ($)"), blank rows, duplicate names, margins written as `0.35` or `35%`.** All of these normalise to the same rows. Test in Task 2.

---

### Task 1: Category fields on `client_services` and an edit route

**Files:**
- Create: `supabase/migrations/00011_strategy_categories.sql`
- Modify: `src/types/database.ts:241-253` (`ClientService`)
- Modify: `src/app/api/clients/[id]/services/route.ts` (accept new fields on POST)
- Create: `src/app/api/clients/[id]/services/[serviceId]/route.ts` (PATCH, DELETE)
- Modify: `src/lib/demo/store.ts:362` (seed one ecommerce-style demo client's categories with margins)
- Test: `tests/strategy-categories-api.test.ts`

**Interfaces:**
- Produces: `ClientService` gains these fields:

  ```ts
  gross_margin_pct?: number | null;
  average_order_value_cents?: number | null;
  url_patterns?: string[] | null;
  source?: "manual" | "import" | "site_scan" | null;
  ```

- Produces: `PATCH /api/clients/:id/services/:serviceId` with a partial body of the create schema plus the four fields, returning `{ service }`.
- Produces: `DELETE /api/clients/:id/services/:serviceId` returning `{ ok: true }`.

- [ ] **Step 1: Write the failing test.** Call the route handlers directly in DEMO_MODE, the way `tests/team-routes.test.ts` does.
  - POST with `gross_margin_pct: 40, average_order_value_cents: 18900, url_patterns: ["/collections/bar-stools"]` stores them.
  - PATCH `{ gross_margin_pct: 55 }` updates only that field.
  - PATCH `{ gross_margin_pct: 140 }` returns 400.
  - DELETE removes the row.
  - A user without client access gets 403.
- [ ] **Step 2:** Run `npx vitest run tests/strategy-categories-api.test.ts`. Expected: FAIL (route module not found).
- [ ] **Step 3: Write the migration.** Add the four columns with checks:
  - `gross_margin_pct numeric check (gross_margin_pct between 0 and 100)`
  - `average_order_value_cents integer check (>= 0)`
  - `url_patterns text[]`
  - `source text check (source in ('manual','import','site_scan'))`

  Also add a unique index on `(client_id, lower(name))`.
- [ ] **Step 4: Update the routes.** Put the shared zod fields in the create schema: margin `z.number().min(0).max(100)`, AOV `z.number().int().min(0)`, patterns an array of at most 20 strings, each at most 200 characters. The PATCH schema is `createSchema.partial().strict()`. Map to both stores.
- [ ] **Step 5:** Run the test, `npm run typecheck`. Expected: PASS.
- [ ] **Step 6:** Commit: `git commit -m "Categories: margin, AOV and URL patterns on client services"`.

### Task 2: Excel/CSV category import

**Files:**
- Create: `src/lib/clients/category-import.ts`
- Create: `src/app/api/clients/[id]/services/import/route.ts`
- Test: `tests/category-import.test.ts`

**Interfaces:**
- Consumes: `ClientService` fields from Task 1.
- Produces:

  ```ts
  export type CategoryImportRow = {
    name: string;
    landing_page_url: string | null;
    gross_margin_pct: number | null;
    average_order_value_cents: number | null;
    priority: number;
  };
  export function parseCategorySheet(data: ArrayBuffer, fileName: string): { rows: CategoryImportRow[]; errors: string[] };
  ```

- Produces: `POST /api/clients/:id/services/import` (multipart `file`, optional `mode: "merge" | "replace"`, default `merge`), returning `{ created: number; updated: number; errors: string[] }`.
  - `merge` upserts by case-insensitive name.
  - `replace` deactivates (`is_active=false`) categories that aren't in the file. It never deletes them.

- [ ] **Step 1: Write the failing tests.** Build sheets in memory with `XLSX.utils.aoa_to_sheet`.
  - Headers `["Category", "Landing page", "Gross Margin %", "AOV ($)", "Priority"]` with row `["Bar Stools", "https://shop.example/collections/bar-stools", "35%", "189.00", 2]` → `{ name: "Bar Stools", gross_margin_pct: 35, average_order_value_cents: 18900, priority: 2 }`.
  - A margin of `0.35` → `35`. A margin of `35` → `35`.
  - Blank rows are skipped. A duplicate name keeps the first row and adds an error mentioning `"Bar Stools"`.
  - A missing name column gives `rows: []` and an error naming the accepted headers.
  - A CSV file with the same content parses identically.
  - More than 1,000 rows truncates to 1,000 with an error.
- [ ] **Step 2:** Run `npx vitest run tests/category-import.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `parseCategorySheet`.**
  - Read the first sheet only, with `XLSX.read(data)` and `sheet_to_json(..., { header: 1 })`.
  - Match headers case-insensitively after stripping non-letters. Aliases:
    - name ← category, product line, collection, name, service
    - url ← landing page, url, link, landing_page_url
    - margin ← gross margin, margin, gross_margin_pct
    - aov ← aov, average order value, avg order value
    - priority ← priority
  - A margin of 1 or less is a fraction. AOV is in major units.
- [ ] **Step 4: Implement the import route.** Size limit 5 MB. Rows are written with `source: "import"`.
- [ ] **Step 5:** Run the tests and typecheck. Expected: PASS.
- [ ] **Step 6:** Commit: `git commit -m "Categories: import from Excel or CSV"`.

### Task 3: Website scan for category candidates

**Files:**
- Create: `src/lib/scraping/site-map.ts`
- Create: `src/app/api/clients/[id]/services/discover/route.ts`
- Test: `tests/site-category-discovery.test.ts`

**Interfaces:**
- Produces:

  ```ts
  export type CategoryCandidate = { name: string; landing_page_url: string; alreadyAdded: boolean };
  export async function mapSiteUrls(siteUrl: string, opts?: { limit?: number }): Promise<string[]>;
  export function discoverCategoryCandidates(urls: string[], siteUrl: string, existing: ClientService[]): CategoryCandidate[];
  ```

- Produces: `GET /api/clients/:id/services/discover`, returning `{ candidates: CategoryCandidate[]; source: "firecrawl" | "unavailable" }`. It uses the client's `website_url`. It returns `source: "unavailable"` with an empty list when `FIRECRAWL_API_KEY` is unset, and never throws.

- [ ] **Step 1: Write the failing tests** for `discoverCategoryCandidates` (pure).
  - These URLs become candidates "Bar Stools" and "Dining Chairs":
    - `/collections/bar-stools`
    - `/collections/bar-stools?page=2`
    - `/product-category/dining-chairs/`
  - These URLs are excluded:
    - `/products/oak-stool`
    - `/blogs/news/x`
    - `/cart`
    - URLs on other hosts
  - A candidate whose path matches an existing service's `landing_page_url` has `alreadyAdded: true`.
  - The output is capped at 1,000 and sorted by name.
- [ ] **Step 2:** Run `npx vitest run tests/site-category-discovery.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `mapSiteUrls` calls Firecrawl `POST https://api.firecrawl.dev/v1/map` with `{ url, limit: opts.limit ?? 5000 }` and the same auth header as `src/lib/scraping/firecrawl.ts`. It returns `links`.
  - Category path markers: `/collections/`, `/category/`, `/categories/`, `/product-category/`, `/c/`, `/shop/`, `/department/`.
  - Name: the segment after the marker. Turn dashes into spaces, then title-case it.
- [ ] **Step 4:** Run the tests and typecheck. Expected: PASS.
- [ ] **Step 5:** Commit: `git commit -m "Categories: propose categories found on the client's website"`.

### Task 4: Spend and return per category

**Files:**
- Create: `src/lib/strategy/categories.ts`
- Create: `src/lib/strategy/category-attribution.ts`
- Modify: `src/lib/audit/meta-audit-data.ts:344` and the ad mapping near `:538`. Add `object_story_spec` to the creative fields, and set `linkUrl` from `extractCreativeDestination(creative).landing_page_url` when `link_url` is empty.
- Test: `tests/strategy-category-attribution.test.ts`

**Interfaces:**
- Consumes: `MetaAuditSnapshot` / `AuditAd` (`src/lib/audit/meta-audit-data.ts`), `ClientService` (Task 1).
- Produces:

  ```ts
  export type StrategyCategory = {
    id: string; name: string; landingPageUrl: string | null; urlPatterns: string[];
    keywords: string[]; grossMarginPct: number | null; averageOrderValueCents: number | null; priority: number;
  };
  export function categoriesFromServices(services: ClientService[]): StrategyCategory[]; // active only

  export type CategoryPerformance = {
    categoryId: string; spendCents: number; purchaseValueCents: number; roas: number | null;
    results: number; adIds: string[]; matchedBy: "url" | "name" | "mixed";
  };
  export type CategoryAttribution = {
    byCategory: CategoryPerformance[];          // every category, zero-spend ones included
    unmatched: { spendCents: number; adIds: string[] };
    coveragePct: number;                        // matched spend ÷ total ad spend × 100, 0 when no spend
  };
  export function attributeSpendToCategories(snapshot: MetaAuditSnapshot, categories: StrategyCategory[]): CategoryAttribution;
  ```

- [ ] **Step 1: Write the failing tests.** Start from `demoMetaAuditSnapshot("act_1", "Demo")` and override `ads` with the destinations below.
  - An ad with `linkUrl` `https://shop.example/collections/bar-stools?utm_source=fb` goes to Bar Stools, `matchedBy: "url"`.
  - When two categories match, the longest URL-path match wins: `/collections/stools` vs `/collections/stools/bar`.
  - An ad with no URL but campaign name `"Bar Stools | Sales | Broad"` matches by name.
  - An ad matching nothing goes to `unmatched`.
  - `purchaseValueCents = round(roas × spendCents)` when ROAS is present, otherwise 0. Category `roas = purchaseValue ÷ spend`, or null when spend is 0.
  - `coveragePct` is correct.
  - A category with zero spend is still listed.
- [ ] **Step 2:** Run `npx vitest run tests/strategy-category-attribution.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - URL matching compares lowercase host + path with the trailing slash and query removed, using a prefix match on the category URL path or a substring match on any `urlPatterns` entry.
  - Name matching uses whole-word, case-insensitive matches of the category name or keywords against the ad name, then the ad set name, then the campaign name.
  - Ad performance comes from `AuditAd.performance`.
- [ ] **Step 4: Fix the snapshot destinations.** Add `object_story_spec` to the fields at `:344` and set the fallback `linkUrl`. Run `npx vitest run tests/extract-creative-destination.test.ts tests/audit-checkpoints.test.ts` to confirm nothing regressed.
- [ ] **Step 5:** Run all new and touched tests and typecheck. Expected: PASS.
- [ ] **Step 6:** Commit: `git commit -m "Strategy: attribute Meta spend and revenue to product categories"`.

### Task 5: Meta capability catalogue and gap detection

**Files:**
- Create: `src/lib/strategy/meta-capabilities.ts`
- Test: `tests/strategy-meta-capabilities.test.ts`

**Interfaces:**
- Consumes: `MetaAuditSnapshot`, `BUSINESS_MODELS` (`src/lib/clients/goals.ts:12`).
- Produces:

  ```ts
  export type CapabilityState = "in_use" | "not_used" | "unknown";
  export type MetaCapability = {
    id: MetaCapabilityId; label: string; why: string;
    businessModels: ReadonlyArray<(typeof BUSINESS_MODELS)[number]> | "all";
    detect(snapshot: MetaAuditSnapshot): CapabilityState;
  };
  export const META_CAPABILITIES: readonly MetaCapability[];
  export type CapabilityStatus = { id: MetaCapabilityId; label: string; why: string; state: CapabilityState };
  export function detectCapabilityGaps(snapshot: MetaAuditSnapshot, businessModel: string | undefined): CapabilityStatus[];
  ```

  `MetaCapabilityId` is the union of the `id` column below, exported from this file.

  Only active or recently spending entities count: status `ACTIVE`, or `performance.spendCents > 0`.

  | `id` | Models | `in_use` when |
  | --- | --- | --- |
  | `advantage_plus_sales` | ecommerce | any campaign has `advantagePlus` and objective `OUTCOME_SALES` |
  | `catalog_ads` | ecommerce | any campaign has objective `PRODUCT_CATALOG_SALES`, or any ad has format `DYNAMIC`. Otherwise `unknown` (no catalog data until Phase 3) |
  | `website_retargeting` | all | any ad set includes an audience with subtype `WEBSITE` |
  | `lookalike_audiences` | all | any ad set includes a `LOOKALIKE` audience |
  | `broad_advantage_audience` | all | any ad set has `advantageAudience === true` |
  | `video_creative` | all | any ad has format `VIDEO` |
  | `dynamic_creative` | all | any ad has format `DYNAMIC` |
  | `instant_forms` | lead_gen, local_service, b2b | any ad set has `optimizationGoal === "LEAD_GENERATION"` |
  | `automatic_placements` | all | any ad set has an empty `publisherPlatforms` |
  | `cost_or_roas_controls` | all | any campaign or ad set has `bidStrategy` `COST_CAP` or `LOWEST_COST_WITH_MIN_ROAS` |

- [ ] **Step 1: Write the failing tests.**
  - On the demo snapshot, `website_retargeting` and `lookalike_audiences` are `in_use`. The demo has `WEBSITE` and `LOOKALIKE` audiences, and you must assert they are included in an ad set.
  - Removing all `VIDEO` ads makes `video_creative` `not_used`.
  - `detectCapabilityGaps(snapshot, "lead_gen")` excludes `advantage_plus_sales` and `catalog_ads`.
  - `detectCapabilityGaps(snapshot, undefined)` returns only the `"all"` models.
  - Paused, zero-spend entities don't count as `in_use`.
- [ ] **Step 2:** Run `npx vitest run tests/strategy-meta-capabilities.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the catalogue per the table. Each `why` is one plain sentence saying what it adds toward a ROAS goal.
- [ ] **Step 4:** Run the tests and typecheck. Expected: PASS.
- [ ] **Step 5:** Commit: `git commit -m "Strategy: catalogue of Meta capabilities and what the account isn't using"`.

### Task 6: Margin-adjusted target ROAS per category

**Files:**
- Create: `src/lib/strategy/targets.ts`
- Test: `tests/strategy-targets.test.ts`

**Interfaces:**
- Produces:

  ```ts
  export function categoryTargetRoas(input: {
    accountTargetRoas: number; accountMarginPct: number | null; categoryMarginPct: number | null;
  }): { targetRoas: number; breakEvenRoas: number | null; basis: "margin_adjusted" | "account_target" };
  export function referenceMarginPct(goalsMarginPct: number | null | undefined, categories: StrategyCategory[]): number | null;
  ```

  **Rule.** Keep the account's profit per ad dollar the same in every category:

  T_c = T × m_account ÷ m_category

  Round to 2 decimals. `breakEvenRoas = 1 ÷ m_category`. When either margin is null or 0, use `targetRoas = T` and `basis: "account_target"`; in that case `breakEvenRoas` is `1 ÷ m_category` when only the account margin is missing, otherwise null.

  `referenceMarginPct` returns the goals margin when it's set. Otherwise it returns the plain mean of the category margins that are known, or null if there are none.

- [ ] **Step 1: Write the failing tests.**
  - T=10, m_a=30, m_c=60 → 5, `margin_adjusted`, break-even 1.67.
  - T=10, m_a=30, m_c=15 → 20.
  - m_c null → 10, `account_target`, break-even null.
  - m_a null with m_c=40 → 10, `account_target`, break-even 2.5.
  - `referenceMarginPct(null, [40, null, 20])` → 30.
  - `referenceMarginPct(undefined, [])` → null.
  - No output is NaN for any combination of nulls and zeros. Loop over a matrix of inputs to check.
- [ ] **Step 2:** Run `npx vitest run tests/strategy-targets.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `git commit -m "Strategy: margin-adjusted target ROAS per category"`.

### Task 7: The plan engine

**Files:**
- Create: `src/lib/strategy/plan.ts`
- Test: `tests/strategy-plan.test.ts`

**Interfaces:**
- Consumes: Task 4 `attributeSpendToCategories`, Task 5 `detectCapabilityGaps`, Task 6 `categoryTargetRoas` / `referenceMarginPct`, `BENCHMARKS` (`src/lib/audit/checkpoints.ts:80`), `AuditScorecard`, `ResolvedGoals`.
- Produces:

  ```ts
  export type StrategyBrief = { dailyBudgetCents: number; targetRoas: number; stretchTargets: number[] };
  export type AllocationTier = "proven" | "promising" | "test" | "hold";
  export type CategoryAllocation = {
    categoryId: string; name: string; tier: AllocationTier; targetRoas: number; targetBasis: "margin_adjusted" | "account_target";
    observedRoas: number | null; observedSpendCents: number; dailyBudgetCents: number; projectedDailyRevenueCents: number;
    structure: MetaCapabilityId[];
  };
  export type PlanProjection = { dailySpendCents: number; dailyRevenueCents: number; blendedRoas: number | null; meetsTarget: boolean };
  export type StrategyPlan = {
    brief: StrategyBrief;
    baseline: { score: number; grade: string; periodDays: number; spendCents: number; roas: number | null;
                categoriesTotal: number; categoriesWithSpend: number; coveragePct: number };
    benchmark: { references: Array<{ metric: string; value: string; source: string }>;
                 realityCheck: { targetRoas: number; referenceRoas: number; multiple: number; verdict: "within" | "stretch" | "unrealistic" } };
    allocations: CategoryAllocation[];
    gaps: { capabilities: CapabilityStatus[]; untouchedCategoryIds: string[] };
    projection: PlanProjection;
    scenarios: Array<{ targetRoas: number; projection: PlanProjection; tierCounts: Record<AllocationTier, number> }>;
    assumptions: string[];
  };
  export const PLAN_CONSTANTS: { split: { proven: 0.7; promising: 0.2; test: 0.1 }; minTestDailyCents: 2000; scaleDecay: 0.85; testDiscount: 0.7; minSpendForVerdictCents: 5000 };
  export function buildStrategyPlan(input: {
    snapshot: MetaAuditSnapshot; scorecard: Pick<AuditScorecard, "score" | "grade">;
    categories: StrategyCategory[]; goals: ResolvedGoals; brief: StrategyBrief;
  }): StrategyPlan;
  ```

**Rules the tests pin down.** Each rule is a single decision.

1. **Tier**, using the category target from Task 6:
   - No spend at or above `minSpendForVerdictCents` → `test`.
   - `observedRoas ≥ target` → `proven`.
   - `observedRoas ≥ breakEven`, or `≥ 0.5 × target` when break-even is null → `promising`.
   - Anything else → `hold`.
2. **Split the budget** 70/20/10 across proven, promising and test.
   - If a bucket is empty, its share moves to the next non-empty bucket in the order proven → promising → test, falling back to the first non-empty one.
   - `hold` gets 0.
   - Within proven and promising, split in proportion to `purchaseValueCents`.
   - Within test, take categories by `priority` descending, then name. Fund `floor(testBudget ÷ minTestDailyCents)` of them equally. The rest get 0 and stay `test`.
3. **Projection per allocation:**
   - proven and promising: `budget × observedRoas × scaleDecay`
   - test: `budget × (accountRoas ?? BENCHMARKS.prospectingRoas) × testDiscount`

   `meetsTarget` is true when blended ROAS ≥ `brief.targetRoas`.
4. **Reality check:**
   - `referenceRoas` = max of `BENCHMARKS.retargetingRoas` and the account's observed ROAS.
   - `multiple` = target ÷ reference.
   - Verdict: ≤ 1.2 `within`, ≤ 2.5 `stretch`, otherwise `unrealistic`.
   - Every reference carries `source: "Internal paid-social playbook (generic, not industry-specific)"` or `"This account, last N days"`.
5. **Structure per tier**, kept only when relevant to the business model:
   - proven: `advantage_plus_sales`, `catalog_ads`, `website_retargeting`, `cost_or_roas_controls`
   - promising: `cost_or_roas_controls`, `video_creative`, `website_retargeting`
   - test: `broad_advantage_audience`, `automatic_placements`, `dynamic_creative`
   - hold: `[]`
6. **Scenarios.** Re-run the tiering and projection for each stretch target, sorted ascending and de-duplicated against the main target.
7. **Assumptions.** List every constant used, as a plain sentence. For example: "Scaled budgets assumed to return 85% of current ROAS."

- [ ] **Step 1: Write the failing tests** using the demo snapshot plus hand-built categories.
  - Tiering hits all four tiers.
  - The split sums to `dailyBudgetCents` within ±1 cent per allocation for rounding.
  - With no proven categories, promising gets 90% and test gets 10%.
  - A $100/day test bucket at a $20 minimum funds the top 5 by priority.
  - A projection with known numbers comes out exactly right.
  - Target 10 with an account ROAS of 2 → `unrealistic`, `multiple: 3.33`.
  - Stretch `[15, 12, 10]` with target 10 → scenarios for 12 and 15 only.
  - **Review Focus #1:** zero categories → `allocations: []`, `projection.dailySpendCents: 0`, the baseline is filled from account totals, and nothing throws.
  - **Review Focus #3:** an unrealistic target still allocates the full budget.
- [ ] **Step 2:** Run `npx vitest run tests/strategy-plan.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `buildStrategyPlan` per the rules. It stays pure, with no I/O.
- [ ] **Step 4:** Run the tests and typecheck. Expected: PASS.
- [ ] **Step 5:** Commit: `git commit -m "Strategy: plan engine with per-category targets, 70/20/10 budget split and stretch scenarios"`.

### Task 8: Strategy intent and brief in the chat

**Files:**
- Create: `src/lib/agent/strategy-brief.ts`
- Modify: `src/lib/agent/task-plan.ts`
  - `RequestIntent` (:19): add `"strategy"`.
  - `REPORT_INTENTS` (:45): add `"strategy"`.
  - `detectRequestIntent` (:85): add a strategy branch before the audit check.
  - `detectRequestIntentWithHistory` (:209): continue the strategy brief.
  - `planTaskSteps` (:303): add the `strategy` steps.
- Test: `tests/strategy-brief.test.ts`, plus new cases in `tests/audit-brief.test.ts` and whichever existing test covers `detectRequestIntent` (find it with `grep -l detectRequestIntent tests`).

**Interfaces:**
- Consumes: `StrategyBrief` (Task 7), `ResolvedGoals`.
- Produces:

  ```ts
  export function parseStrategyBrief(text: string, defaults: { goals: ResolvedGoals; currentDailySpendCents: number | null }):
    { brief: StrategyBrief | null; missing: Array<"budget" | "target_roas">; usedDefaults: Array<"budget" | "target_roas"> };
  export function buildStrategyClarifyingQuestion(missing: Array<"budget" | "target_roas">): string;
  export function looksLikeStrategyBriefReply(text: string): boolean;
  ```

  **Parsing rules:**
  - ROAS values are numbers followed by `x`, `×` or preceded by "roas (of)". The first is the target. The rest are stretch targets, sorted and de-duplicated.
  - Budgets accept `$1,200/day`, `1200 per day`, `$30k a day`, `$36k/month` (daily = monthly ÷ 30.4, rounded).
  - Defaults when a value isn't in the text:
    - target → `goals.target_roas`
    - budget → `goals.daily_account_cap_cents`, then `currentDailySpendCents`
  - Each default used goes in `usedDefaults` so the writer can say so.
  - **"$A to get $B back"** sets the target to B ÷ A, so "$4k to get $40k back" gives 10. It does not set the budget, because A is a total, not a daily amount. The budget comes from the text or the defaults, otherwise it's asked for.

  **Strategy steps:** queued, research, `clarify_brief` "Confirm budget & target ROAS", `fetch_overview`, `pull_insights` "Pull spend & return by category", `build_plan` "Build the plan", `write_report` "Write strategy", complete.

- [ ] **Step 1: Write the failing tests.**
  - `"Plan to hit 10x ROAS on $1,200/day, stretch 12x and 15x"` → `{ dailyBudgetCents: 120000, targetRoas: 10, stretchTargets: [12, 15] }`.
  - `"$36k/month at a roas of 8"` → 118421 cents, target 8.
  - A text with no numbers and empty goals → `brief: null`, `missing: ["budget","target_roas"]`.
  - A text with no numbers and goals with `target_roas: 6` → target 6, `usedDefaults: ["target_roas"]`.
  - `detectRequestIntent` returns `"strategy"` for "how do I get 10x roas", "build a strategy for $4k to get $40k back" and "what's the plan to reach a 12x target".
  - It still returns `"audit"` for "audit the account" and `"optimize"` for "optimize budgets".
  - `planTaskSteps("…", "strategy")` ids are in the order listed above.
- [ ] **Step 2:** Run `npx vitest run tests/strategy-brief.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
  - Strategy regex: `strategy`, `game plan`, `plan to (hit|reach|get)`, `target roas`, `\d+(\.\d+)?\s*[x×]\s*roas`, `roas of \d`, `stretch target`, and the "$A to get $B back" form, where the implied target is B ÷ A.
  - Explicit "audit" wording still wins when no strategy words are present.
- [ ] **Step 4:** Run `npm test`. The whole suite must pass, because intent routing is shared.
- [ ] **Step 5:** Commit: `git commit -m "Workspace: strategy intent with a budget and target-ROAS brief"`.

### Task 9: Evidence, framework and agent wiring for the three-level report

**Files:**
- Create: `src/lib/strategy/render.ts`
- Create: `src/lib/agent/strategy-framework.ts`
- Modify: `src/lib/agent/adspirer-agent.ts`:
  - `gatherDiagnoseEvidence` (:1363): add a strategy branch next to the audit branch at :1558. It reuses the snapshot and scorecard code at :2036-2066.
  - Writer status labels (:505-610): add strategy labels.
  - Mock agent (:909): add a canned strategy reply in DEMO_MODE.
- Test: `tests/strategy-render.test.ts`, `tests/strategy-agent.test.ts`

**Interfaces:**
- Consumes: everything above, plus `ensureClientServices(clientId)` (`src/lib/clients/ensure-services.ts`), `clientGoals` (`adspirer-agent.ts:10`) and the competitor brief highlights already in the client context.
- Produces:

  ```ts
  export function renderStrategyEvidence(plan: StrategyPlan, attribution: CategoryAttribution, opts: { currency: string; categoryWord: "category" | "service" }): string;
  export const STRATEGY_FRAMEWORK: string;
  ```

  **Evidence sections**, in order:
  1. `### Strategy inputs`. Includes any defaults used.
  2. `### Level 1: spend & return by category`. A table of category, spend, revenue, ROAS, tier and match type, then unmatched spend and coverage %. If there are more than 40 categories, show the top 25 by spend and then a count line.
  3. `### Untouched categories`
  4. `### Meta capabilities: in use / not used / unknown`
  5. `### Level 2: reality check`. Includes the reference sources.
  6. `### Level 3: allocation`. A table plus the structure per tier.
  7. `### Stretch scenarios`
  8. `### Assumptions`

  **`STRATEGY_FRAMEWORK` report headings**, in order:
  1. Bottom line: can this budget hit this target, and what's the honest gap.
  2. Level 1: where you are.
  3. Level 2: how it compares (name the reference). Show two routes side by side:
     - **External:** what competitors run, from the competitor brief highlights already in context.
     - **Internal:** the client's own categories and assets that aren't being advertised.
  4. Level 3: the plan (allocation table, campaign structure per tier, a creative plan of at least 3 new concepts a month per funded category built from competitor patterns, what to track weekly).
  5. Stretch scenarios.
  6. What would make this plan better. List the missing data: margins not set, categories not loaded, low coverage, no GA4 or catalog yet.
  7. One next step: a single category to test, with a daily budget and duration.

  **Writer rules:** use only numbers from the evidence. Don't queue or execute anything. Use the category word chosen above.

- [ ] **Step 1: Write the failing tests.**
  - `renderStrategyEvidence` with the Task 7 fixture contains every section heading in order.
  - It prints `Unmatched spend` and the coverage %.
  - It truncates 60 categories to 25 rows plus `…and 35 more`.
  - It prints every assumption.
  - With zero categories, it prints `No categories loaded yet` instead of the tables.
  - **`tests/strategy-agent.test.ts` in DEMO_MODE:** calling `runAdspirerAgent` with request `"Plan to hit 10x ROAS on $500/day"` for the seeded client returns a reply containing `"Level 1"`, `"Level 2"` and `"Level 3"`. Its tool calls include `audit_checkpoints` and `strategy_plan`, and contain no execute tool names. Copy the call shape from `tests/audit-phase3.test.ts`.
- [ ] **Step 2:** Run `npx vitest run tests/strategy-render.test.ts tests/strategy-agent.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the render and framework modules.** In the agent branch:
  1. Resolve the brief. If anything is missing, return the clarifying question and stop, the same way the audit brief does.
  2. Load the snapshot and scorecard, then the categories, attribution and plan.
  3. Push the evidence and `STRATEGY_FRAMEWORK`.
  4. Record a `strategy_plan` tool call whose rationale is `"Strategy plan: target {T}x, {n} categories, verdict {v}"`.
- [ ] **Step 4:** Run `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit: `git commit -m "Workspace: three-level strategy report from the plan engine"`.

### Task 10: Categories tab on the client page

**Files:**
- Create: `src/lib/clients/category-form.ts` (pure form logic; the panel calls it)
- Create: `src/components/clients/categories-panel.tsx`
- Modify: `src/app/(app)/clients/[id]/page.tsx:171-178`. Add a `categories` tab after Overview, labelled "Categories" for ecommerce and "Services" otherwise.
- Test: `tests/category-form.test.ts`. Vitest runs `tests/**/*.test.ts` in a `node` environment with no DOM, so the component itself is checked by hand in Step 4.

**Interfaces:**
- Consumes: the Task 1–3 routes.
- Produces:

  ```ts
  export type CategoryFormField = "name" | "landing_page_url" | "gross_margin_pct" | "average_order_value" | "priority";
  export function categoryPatchFromEdit(field: CategoryFormField, raw: string):
    { ok: true; patch: Record<string, unknown> } | { ok: false; error: string };
  ```

  The AOV entered in major units becomes `average_order_value_cents`. A blank margin becomes `null`.
- Produces: `<CategoriesPanel clientId={string} categoryWord={"category" | "service"} />`.

**What the panel does:**
- **Table:** name, landing page, margin %, AOV, priority, source. Cells are edited inline, and saving calls PATCH.
- **Delete:** a confirm, then DELETE.
- **"Import from Excel/CSV":** a file input with a merge/replace choice. Replace says it deactivates rather than deletes. A toast reports the created/updated/errors counts.
- **"Scan website":** calls discover and lists candidates with checkboxes, already-added ones disabled. "Add selected" POSTs each one with `source: "site_scan"`.
- **Empty state:** "Add your categories so strategies can plan per category."

- [ ] **Step 1: Write the failing tests** for `categoryPatchFromEdit`.
  - `("gross_margin_pct", "55")` → `{ ok: true, patch: { gross_margin_pct: 55 } }`.
  - `"35%"` → 35.
  - `"140"` → `ok: false` with an error mentioning 0–100.
  - `("gross_margin_pct", "")` → patch `{ gross_margin_pct: null }`.
  - `("average_order_value", "189.50")` → `{ average_order_value_cents: 18950 }`.
  - `("landing_page_url", "not a url")` → `ok: false`.
  - `("name", "  ")` → `ok: false`.
- [ ] **Step 2:** Run `npx vitest run tests/category-form.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Build `categoryPatchFromEdit`, then the panel. The panel uses the existing `src/components/ui` primitives and `sonner` toasts, matching `goals-profile-form.tsx` styling. A failed `categoryPatchFromEdit` shows its error inline and sends nothing.
- [ ] **Step 4:** Run `npm test` and `npm run typecheck`, then check by hand in `npm run dev` (DEMO_MODE):
  1. Rows load.
  2. Editing a margin saves it.
  3. Typing 140 shows the error.
  4. Import a 3-row sheet.
  5. "Scan website" lists candidates, with already-added ones disabled. This needs `FIRECRAWL_API_KEY`; otherwise the panel shows that the scan is unavailable.
  6. The empty state shows for a client with no categories.
  7. Ask the workspace "Plan to hit 10x ROAS on $500/day".

  The reply shows the three levels.
- [ ] **Step 5:** Commit: `git commit -m "Clients: categories tab with import and website scan"`.

---

## Out of scope for Phase 1 (see roadmap)

- Batch approval and execution of a plan, the one-category test runner, and plan-vs-actual tracking: Phase 2.
- PDF/Word strategy template. Phase 1 relies on the existing Markdown download of the chat reply: Phase 2.
- GA4, Search Console, Google Ads, Meta catalog and the cross-channel bar stool question: Phase 3.
- Sales, inventory, SKU and supplier tables, the retrieval tools, external benchmarks and Amazon: Phase 4.
