# Goal-driven strategy: gap analysis and roadmap

19 October 2026 · source: [strategy call with Karthik, 16 Oct](2026-10-16-karthik-strategy-call.md)

## Where the portal is today

The portal is good at **Level 1**, grading what's already running on Meta. It has almost nothing for Levels 2 and 3, the goal-driven plan.

**What's solid and reusable**

- **Audit engine.** About 35 scored checks across tracking, structure, bidding, audiences, creative and funnel (`src/lib/audit/checkpoints.ts`). Each check is graded A–F and compared with the previous period.
- **Per-client goals.** `target_roas`, `gross_margin_pct`, `average_value_cents`, daily and monthly caps, and break-even ROAS/CPA (`src/lib/clients/goals.ts`). These are stored per account, not per category.
- **Services list.** Each client has `client_services` (name, landing page, keywords, priority). This is the natural home for categories.
- **Ad destinations.** Meta ads already come back with destination URLs and UTMs (`src/lib/meta/extract-creative-destination.ts`).
- **Creating on Meta.** Execute tools create campaigns, ad sets and ads (image or video), but each one needs its own approval.
- **Competitors.** Meta Ad Library briefs via SociaVault give themes and creative patterns. They are qualitative only.
- **Documents.** Uploads accept PDF, DOCX, XLSX and CSV. The text is flattened into the prompt up to 24k characters.

**What's missing**

| Need from the call | Status | Why |
| --- | --- | --- |
| Budget + target ROAS → full plan | Missing | The audit brief asks only for scope and dates. No plan model exists. |
| Gap view (what the account isn't doing) | Missing | Only one check touches this: F1 "no retargeting". |
| Category list and per-category margin | Partial | Services exist, but there's no margin or AOV per service and no Excel import. |
| Spend and return per category ("bar stools") | Missing | Nothing groups ads by landing page or category. |
| Reading the website for untouched categories | Missing | Firecrawl scrapes one page. It doesn't map the site. |
| Stretch targets / re-plan | Missing | |
| Benchmarks (Level 2) | Partial | One hardcoded generic table (prospecting ROAS 1.5×, retargeting 3×). No industry or competitor numbers. |
| Approving a whole plan and executing it | Partial | Single-action approvals only. No batch, no dependencies, no catalog ads. |
| GA4, Search Console, Google Ads | Missing | The Adspirer MCP backend was removed in `399ba40`. Today the app talks to the Meta Graph API only. |
| Catalog / product sets, Amazon, SKU, inventory, supplier data | Missing | |
| Retrieval loop with guardrails | Partial | Context is stuffed into the prompt every turn. No retrieval over structured business data. |

**Bugs found along the way**

- **Competitor brief inserts don't match the schema.** `src/lib/competitors/service.ts` writes `client_service_id`, `raw_research` and a non-UUID `id`, but the table has `service_id` and `source_metadata`. Live Supabase inserts will fail.
- **The chat doesn't know the client's goals.** The client's goals (target ROAS, margin) are only passed to the audit and to approvals, not to the general chat context. If you ask "what's our target ROAS?" in chat, the agent doesn't know.
- **Two client columns are never read.** `standing_instructions` and `business_description` are stored but unused.

## Roadmap

Five phases. Phase 1 alone answers most of Karthik's ask on Meta data. Phases 3 and 4 are the big data-connection pieces, and Phase 3 needs a decision first (see "Decisions needed").

### Phase 0: quick fixes and the non-code follow-ups (this week)

- Fix the competitor brief insert mismatch.
- Add goals and margin to the general agent context, and read `standing_instructions`.
- **Framework doc.** Write the shared framework and strategy principles as one standalone doc. The strategy prompt in Phase 1 is its first consumer.
- **Per-tool status sheet.** Start one with a row per tool (Creative Studio, SEO, Google Ads, Adspirer, Marketing in a Box) and columns *built in / working / missing* against each principle. This doc is the Adspirer row.
- **Google Ads connection.** Raise it with Subhashini and Ashraf. This repo has no Google Ads connection at all, so the failure is in the Google Ads tool or the Adspirer MCP account, not here.

### Phase 1: strategy MVP on Meta data (detailed plan ready)

Plan: [`docs/superpowers/plans/2026-10-19-strategy-mvp-phase1.md`](../superpowers/plans/2026-10-19-strategy-mvp-phase1.md)

- **Categories as stored context.** Margin and AOV on each category. Excel/CSV import. Website scan that proposes categories the site has but the ads don't.
- **Spend and return per category.** Ads are matched to categories by landing page, then by name. This answers "how much has gone into bar stools, what did it return, and what was the best category in the last 30 days" from Meta-reported revenue.
- **Gap view.** A catalogue of Meta campaign types and features, each marked in use, not used or unknown, plus categories with no spend.
- **Plan engine.**
  - Inputs: budget, target ROAS and stretch targets.
  - Margin-adjusted target ROAS per category.
  - Budget split 70/20/10 across proven, promising and test categories.
  - Projected revenue, and a reality check against the reference benchmark with the source named.
- **Three-level report in chat.** Level 1 is where you are, Level 2 is how it compares, and Level 3 is the plan: allocation, campaign structure, creative plan and what to track. It ends with one recommended test: a category plus a budget.

**Covers these items from the call:** goal inputs, gap view, both planning directions, stretch targets, margin-based ROAS, structure and creative plan (recommend only), three levels, the external (competitor) and internal (own categories) routes side by side, benchmark reference, persistent category list, category-level reporting (Meta side), and the bar stool spend-and-return follow-up.

### Phase 2: approve and run the plan

- **Plan approval.** Approve a whole plan as one group, with an execution order (campaign → ad set → ad) and per-item edit or skip. The single-action executor is reused.
- **One-category test.** Pick a category, set a budget and duration, create the structure, and snapshot the plan as the baseline.
- **Tracking.** The existing monitoring job compares plan against actual per category, and alerts when a test misses its target.
- **Re-plan.** Show what changes when the target moves, for example 10× to 12×.
- **Exports.** A PDF and Word template for the strategy report.

### Phase 3: connections, with GA4 as the source of truth

- GA4 and Google Search Console become default connections per client.
- Revenue per landing page and per item from GA4 is reconciled against Meta-reported revenue.
- Google Ads read access gives a cross-channel plan, which answers the bar stool question ($4k → $40k across Google and Meta).
- Meta catalog and product-set performance feed catalog ads into the plan and the gap view.

### Phase 4: deep business context and the retrieval loop

- **Structured uploads.** Sales, inventory, SKU and supplier data, and the product feed, go into typed tables rather than flattened prompt text.
- **Retrieval tools.** The agent queries this data on demand, with row and size limits, provenance, and staleness flags. This is the "retrieve → add to context → re-run" loop with guardrails.
- **External sources.** Industry benchmarks with a named reference site, competitor spend estimates, and Amazon best-seller data.
- **Website capacity check.** Page speed, stock levels and traffic headroom before scaling a category.

### Phase 5: one framework across tools

- Move the Phase 0 framework doc into a shared package or prompt module that every Dotmappers tool imports.
- Keep the per-tool status sheet current before every meeting with Karthik.

## Decisions (Rithin, 19 Oct 2026)

1. **GA4, Search Console and Google Ads: build direct Google integrations.** No third-party dependency, so the Adspirer MCP is not coming back. Phase 3 needs:
   - a Google OAuth app per environment;
   - the GA4 Data API, Search Console API and Google Ads API (the last needs a developer token);
   - a `connected_google_accounts` table mapped to clients, like `connected_meta_accounts`.

   Amazon data in Phase 4 will need its own route (direct API or a scraped best-seller source).
2. **Benchmarks for Level 2: sourced from the web.** Each benchmark is researched per industry, stored with its source URL and the date it was retrieved, and cited in the report. Phase 1 keeps the internal playbook numbers, labelled as generic, and the web-sourced table replaces them in Phase 4.
3. **10× realism: agreed.** The plan reports a 10× target as unrealistic when it's far above the reference, and still builds the plan.

## Follow-ups for Karthik, and when each can be answered

| Follow-up | Earliest phase |
| --- | --- |
| Three-level strategy from this discussion | Phase 1 |
| How much has gone into bar stools and what it returned; best category in the last 30 days (Meta-reported) | Phase 1, once categories are loaded |
| Same, reconciled to GA4 | Phase 3 |
| Bar stools: $4k → $40k using Google Ads and Meta together | Phase 3, which needs Google Ads data |
| Test one category with a set budget | Phase 1 recommends the test, Phase 2 runs it |
