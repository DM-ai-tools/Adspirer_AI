# Comparison report + evidence-based strategy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Meta period-over-period COMPARISON report (14 sections, 0–13), rewrite the account and lead strategy writers to the 12-section evidence-based STRATEGY format, and apply the shared analysis rules (labels, IDs, measurement breaks) to audit, comparison and strategy.

**Architecture:** Same pipeline as the audit: `provider.getAuditSnapshot` → code-computed evidence text → writer framework prompt → chat reply → existing markdown-to-PDF/Word export. All new figures (KPI statuses, driver bridge, funnel, entity splits, CMP IDs) are computed in a new `src/lib/comparison/` module. Strategy gets a new inputs block (prior findings from chat, business-profile gaps, platform notes, app capabilities) and new frameworks.

**Tech Stack:** Next.js (repo version — read `node_modules/next/dist/docs/` before touching routes), TypeScript, vitest (`npm test`), Meta Graph via `MetaGraphClient`, demo mode via `src/lib/demo/store.ts` + `src/lib/adspirer/mock-provider.ts`.

**Spec:** `docs/superpowers/specs/2026-11-17-comparison-strategy-reports-design.md` (read it first; Appendix A is the source prompt and fixes headings and rules).

## Global Constraints

- No UI changes: no new buttons, pages, routes, form fields or DB migrations.
- Comparison is reached from chat only (LLM-routed intent `comparison`); an audit that also asks to compare stays `audit`, and audits must not load the new comparison-only data.
- Visible audit finding IDs are `AUD-001`, `AUD-002`… (three digits); comparison `CMP-###` numbered by code; strategy actions `STR-###`; strategy's own findings when no qualifying audit `SF-###`.
- Strategy action plan layout: short table `ID | Action | Owner | Type | Timing | Effort`, then one card per action with Evidence, Expected impact + confidence, Dependency, Success metric, Rollback (+ before → after and Guardrail for Type A).
- Missing business details are asked in chat (Assumptions / Questions for the client), never saved.
- Only the account strategy (`ACCOUNT_STRATEGY_FRAMEWORK`) and lead strategy (`LEAD_STRATEGY_FRAMEWORK`) change; category `STRATEGY_FRAMEWORK` stays. No "queue STR-###"; queue parser untouched.
- The writer never calculates: every number it may quote is in the evidence. No sentences in narrow table cells (printed reports).
- Thresholds: materiality ±5%; low volume = under 30 results in either window (result metrics), under 1,000 impressions in either window (rate metrics), under 5% of spend (entity / breakdown rows).
- Labels: `[Observed]`, `[Likely]`, `[Hypothesis]`; "Meta-reported"; "Low volume - not a trend"; "MEASUREMENT BREAK"; Type A/B/C; Owner ∈ App | Media buyer | Client | Developer | Creative | Sales; Timing ∈ Now 0-7d | Next 8-30d | Later 31-90d.
- Work on branch `comparison-strategy` off `main`. Commit after each task with the Co-Authored-By line from the session.

## Review Focus

1. **Account with zero delivery in the previous window** (new account / paused last month): every Δ% must read "n/a (no previous delivery)", not Infinity/NaN, and status must be "Low volume". → test in Task 4.
2. **Lead account with leads but no link clicks / LPV** (instant forms): funnel must show "Not available" steps, never 0% conversion. → test in Task 6.
3. **Comparison asked over unequal windows** ("1–20 Oct vs September"): section 0 must state unequal lengths and every KPI row must carry per-day values. → test in Task 4.
4. **Chat with an audit for a different period than the strategy** — strategy must not cite its AUD IDs and must say why. → test in Task 11.
5. **Comparison part failed to load** (e.g. previous ad insights rate-limited): evidence lists it as failed; the matching section says "failed to load", others still render. → test in Task 3 and Task 7.

---

### Task 1: Shared analysis rules, business type, measurement breaks

**Files:**
- Create: `src/lib/analysis/shared-rules.ts`
- Create: `src/lib/analysis/measurement.ts`
- Test: `tests/analysis-shared.test.ts`

**Interfaces:**
- Produces:
  - `export const SHARED_ANALYSIS_RULES: string` — shared rules 1–9 from spec Appendix A, phrased for this app (evidence instead of "input JSON"; ID schemes as in Global Constraints).
  - `export type BusinessType = "ecom" | "leadgen" | "hybrid"`
  - `export function businessTypeOf(snapshot: MetaAuditSnapshot, businessModel: string | undefined): BusinessType`
  - `export type MeasurementBreak = { date: string; window: "current" | "previous"; what: string; objectName: string | null; eventType: string }`
  - `export function measurementBreaks(snapshot: MetaAuditSnapshot): MeasurementBreak[]`
  - `export function measurementCaveats(snapshot: MetaAuditSnapshot): string[]`
  - `export function renderMeasurementEvidence(snapshot: MetaAuditSnapshot): string` — heading `### Measurement settings`: attribution windows in use, optimisation events, breaks, caveats, and the fixed limitation line "Meta's activity history may not record every attribution or dataset edit, and earlier ad set attribution settings can't be recovered."

- [ ] **Step 1: Write failing tests** in `tests/analysis-shared.test.ts`:
  - `businessTypeOf(snap, "ecommerce")` → `"ecom"`; `"lead_gen" | "local_service" | "b2b"` → `"leadgen"`.
  - With `businessModel` undefined: totals with purchases only → `"ecom"`; leads only → `"leadgen"`; both purchases and leads where each objective group has ≥ 10% of spend → `"hybrid"`.
  - `measurementBreaks` flags an `AuditChange` with `eventType` matching `/attribution|promoted_object|optimization_goal|pixel|dataset|conversion/i` or `detail` containing `attribution_spec`; assigns `window: "previous"` when `localDate` is inside `previousPeriod`.
  - `measurementCaveats` returns one caveat when two active ad sets in the same campaign objective have different `attributionWindows`.
  - `renderMeasurementEvidence` always contains the limitation line.
- [ ] **Step 2: Run** `npx vitest run tests/analysis-shared.test.ts` — expect FAIL (module not found).
- [ ] **Step 3: Implement** both files. Group objectives by `campaign.objective` (OUTCOME_SALES, OUTCOME_LEADS, …).
- [ ] **Step 4: Run** the test — expect PASS.
- [ ] **Step 5: Commit** `feat(analysis): shared rules, business type and measurement breaks`.

### Task 2: Audit IDs → AUD-###, labels, shared rules in the audit writer

**Files:**
- Modify: `src/lib/agent/meta-audit-framework.ts` (every `R1`, `R#`, `(fixes R1)`, "see R1" → `AUD-001` forms; risk card heading `### AUD-001 · 🔴 Critical — …`; Evidence bullet starts with `[Observed]`, `[Likely]` or `[Hypothesis]`; append `SHARED_ANALYSIS_RULES`)
- Modify: `src/lib/agent/adspirer-agent.ts:2818` (writer line "numbered R1, R2…" → "numbered AUD-001, AUD-002…"); add `renderMeasurementEvidence(snapshot)` to the audit sections after `renderChangesEvidence`
- Modify: `src/lib/reports/present.ts:83,176` (`RISK` regex accepts `R\d+` and `(AUD|CMP|SF)-\d{3}`; tag keeps the ID as written, e.g. `AUD-001 · Critical`). Add `STR-\d{3}` action headings (`### STR-001. …` or `### STR-001 · …`) as action cards with tag `STR-001`.
- Modify tests: `tests/audit-report-tables-and-layout.test.ts`, `tests/audit-changes.test.ts`, `tests/audit-presentation-and-changes.test.ts` — keep the R1 cases (old chats still export) and add AUD-001 / STR-001 cases.

**Interfaces:**
- Consumes: `SHARED_ANALYSIS_RULES`, `renderMeasurementEvidence` (Task 1).

- [ ] **Step 1: Failing tests:** `presentBlocks(parseMarkdownToBlocks("### AUD-003 · 🟠 High — Learning limited on 4 ad sets\n- **Evidence:** …"))` yields a card `{ tone: "high", tag: "AUD-003 · High", title: "Learning limited on 4 ad sets" }`; `### STR-002. Pause Broad 30-65` yields `{ tone: "action", tag: "STR-002" }`; `META_AUDIT_FRAMEWORK` contains `AUD-001` and `[Observed]` and does not match `/\bR[1-9]\b/`.
- [ ] **Step 2: Run** the three test files — expect the new cases to FAIL.
- [ ] **Step 3: Implement** the edits above.
- [ ] **Step 4: Run** `npm test` — expect all PASS (fix any test that asserted old wording, only where the change is the intended ID switch).
- [ ] **Step 5: Commit** `feat(audit): AUD-### finding IDs, evidence labels and measurement settings`.

### Task 3: Comparison-only data in the snapshot

**Files:**
- Modify: `src/lib/audit/meta-audit-data.ts` (types near 52–110, 149–170, 236–290; options at 516; fetch list at ~840–905; assembly at ~1195–1255; demo snapshot at 1436+)
- Modify: `src/lib/adspirer/mock-provider.ts:351` (pass the option through to the demo snapshot)
- Test: `tests/comparison-snapshot.test.ts`

**Interfaces:**
- Produces:
  - `AuditSnapshotOptions.comparisonDetail?: boolean` (default false; implies `compare: true`).
  - `AuditAd.previousPerformance?: PeriodPerformance | null`
  - `export type BreakdownDimension = "age_gender" | "placement" | "country" | "device"`
  - `export type BreakdownRow = { key: string; performance: PeriodPerformance }` (key: `"25-34 · female"`, `"instagram · feed"`, `"AU"`, `"mobile_app"`)
  - `MetaAuditSnapshot.comparisonBreakdowns?: Array<{ dimension: BreakdownDimension; current: BreakdownRow[] | null; previous: BreakdownRow[] | null }>` (null = failed to load)
  - `MetaAuditSnapshot.comparisonFailures` union gains `"ads" | "breakdowns"`.
- Graph calls (only when `comparisonDetail`): previous-window ad insights (`level: "ad"`, same fields as current); for both windows account-level insights with `breakdowns` = `"age,gender"`, `"publisher_platform,platform_position"`, `"country"`, `"impression_device"`. Reuse the existing current-window age/gender and placement-position results rather than fetching them twice. All via `settle(...)` in the same `Promise.all`.

- [ ] **Step 1: Failing tests** with a fake graph (follow `tests/audit-compare.test.ts` usage of `fetchMetaAuditSnapshot`): (a) without `comparisonDetail`, no call has `breakdowns: "country"` or `"impression_device"` and no previous `level: "ad"` call is made; (b) with it, ads carry `previousPerformance` and `comparisonBreakdowns` has 4 dimensions × both windows; (c) when the previous `country` call throws, that entry has `previous: null`, `comparisonFailures` includes `"breakdowns"`, and `warnings` names it; (d) `demoMetaAuditSnapshot` with the option returns ads with `previousPerformance` and all 4 dimensions.
- [ ] **Step 2: Run** `npx vitest run tests/comparison-snapshot.test.ts` — FAIL.
- [ ] **Step 3: Implement.** `withoutComparison` must also drop `previousPerformance` from ads and delete `comparisonBreakdowns`.
- [ ] **Step 4: Run** the new test and `tests/audit-compare.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(comparison): ad-level and breakdown data for both windows`.

### Task 4: Windows, thresholds and KPI scorecard

**Files:**
- Create: `src/lib/comparison/thresholds.ts`, `src/lib/comparison/kpis.ts`
- Test: `tests/comparison-kpis.test.ts`

**Interfaces:**
- Produces:
  - `export const COMPARISON_THRESHOLDS = { materialityPct: 5, minResults: 30, minImpressions: 1000, minSpendShare: 0.05 } as const`
  - `export type Windows = { current: { since: string; until: string; days: number }; previous: { since: string; until: string; days: number }; equalLength: boolean; maturity: { immature: boolean; immatureFrom: string | null; reason: string | null } }`
  - `export function windowsOf(snap: MetaAuditSnapshot, today: string): Windows` — immature when `until` is within the longest click window in use (7 days for `7d_click`, 1 for `1d_click`) of `today`; `immatureFrom` = first day inside that lag.
  - `export type KpiStatus = "Improved" | "Declined" | "Stable" | "Low volume"`
  - `export type KpiRow = { metric: string; current: number | null; previous: number | null; delta: number | null; deltaPct: number | null; perDayCurrent: number | null; perDayPrevious: number | null; status: KpiStatus; lowVolume: boolean; higherIsBetter: boolean | null; measurementBreak: boolean }`
  - `export function kpiRows(snap: MetaAuditSnapshot, windows: Windows, type: BusinessType, breaks: MeasurementBreak[]): KpiRow[]`
- Metrics by type: all — spend, impressions, reach, frequency, CPM, link clicks, link CTR, cost per link click, LPV; ecom adds purchases, purchase value, ROAS, cost per purchase, AOV, add to cart, initiate checkout; leadgen adds leads, CPL; hybrid adds both. Derived ratios come from the totals (AOV = purchase value ÷ purchases, etc.).
  Status rule, in order: `"Low volume"` when the row's low-volume test fails; `"Stable"` when |Δ%| ≤ 5; else by direction. Higher is better: impressions, reach, link clicks, LPV, link CTR, results, purchases, leads, add to cart, initiate checkout, purchase value, ROAS, AOV. Lower is better: CPM, cost per link click, cost per result / purchase / lead, frequency. Spend is the one neutral metric (`higherIsBetter: null`): a rise is `"Improved"` when the primary result count rose by at least as much in %, else `"Declined"`; a fall is `"Improved"` when results fell by less in %, else `"Declined"`.
  Reach/frequency only from `snap.totals` / `previousTotals` and only when `reachSummed` is not set.
  `deltaPct` is null when previous is 0 or null.

- [ ] **Step 1: Failing tests:** CPL 40→36 is Improved; ROAS 3.0→2.9 (−3.3%) is Stable; CPA rises 20% with 12 purchases each window → status "Low volume", `lowVolume: true`; previous spend 0 → `deltaPct: null`, status "Low volume" (Review Focus 1); unequal windows (20 vs 30 days) → `equalLength: false` and `perDay*` filled (Review Focus 3); spend +30% with results +40% → Improved, spend +30% with results +5% → Declined; a break on attribution in the current window sets `measurementBreak: true` on result, cost-per-result, ROAS and purchase value rows; `windowsOf` with until = today−3 and 7d_click → immature from until−3+1… (assert exact dates with a fixed `today`).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(comparison): windows, thresholds and KPI scorecard`.

### Task 5: Driver bridge

**Files:**
- Create: `src/lib/comparison/bridge.ts`
- Test: `tests/comparison-bridge.test.ts`

**Interfaces:**
- Produces:
  - `export type BridgeEffect = { driver: "CPM" | "CTR" | "CVR" | "AOV" | "Volume"; value: number; shareOfChangePct: number }`
  - `export type Bridge = { metric: "cost per result" | "results" | "purchase value"; previous: number; current: number; change: number; effects: BridgeEffect[] } | { metric: string; unavailable: string }`
  - `export function bridgesOf(cur: PeriodPerformance, prev: PeriodPerformance, type: BusinessType): Bridge[]`
- Identities: cost per result = CPM ÷ (1000 × CTR × CVR) where CTR = link clicks ÷ impressions, CVR = results ÷ link clicks; results = (spend ÷ CPM × 1000) × CTR × CVR with Volume = spend effect; purchase value = purchases × AOV (ecom/hybrid only).
- Log-share attribution so effects sum exactly to the change:

```ts
// For y = Π x_i (or quotient), effect_i = Δy × ln(x_i,cur / x_i,prev) / ln(y_cur / y_prev)
// (sign of exponent applied for divisors). When y_cur === y_prev, split Δy = 0 and report each
// driver's own % change instead, with shareOfChangePct = 0.
```

  Any zero/missing factor → `{ metric, unavailable: "<which input is missing>" }`.

- [ ] **Step 1: Failing tests:** for a case with CPM 10→12, CTR 1%→1%, CVR 5%→4%: cost-per-result effects sum to `current − previous` within 0.01 and CPM and CVR effects are both positive; link clicks 0 in previous → unavailable mentioning "link clicks"; leadgen gets no purchase-value bridge.
- [ ] **Step 2–4:** run FAIL → implement → run PASS.
- [ ] **Step 5: Commit** `feat(comparison): driver bridge with additive effects`.

### Task 6: Funnel, entities, creative and breakdown shifts

**Files:**
- Create: `src/lib/comparison/funnel.ts`, `src/lib/comparison/entities.ts`, `src/lib/comparison/shifts.ts`
- Test: `tests/comparison-structure.test.ts`

**Interfaces:**
- Produces:
  - `export type FunnelStep = { step: string; current: number | null; previous: number | null; rateCurrent: number | null; ratePrevious: number | null; note: string | null }`
  - `export function funnelsOf(snap: MetaAuditSnapshot, type: BusinessType): Array<{ kind: "ecom" | "leadgen"; steps: FunnelStep[] }>` — ecom: impressions → link clicks → LPV → add to cart → initiate checkout → purchases; leadgen: impressions → link clicks → form opens → leads. A step with no data in either window → values null and `note: "Not available — Meta returned no <step>"`; rate null whenever either side is null (Review Focus 2). Form opens are always "Not available" unless a later Meta field exists (none today).
  - `export type EntityLevel = "campaign" | "ad set" | "ad"`
  - `export type EntityChange = { level: EntityLevel; id: string; name: string; objective: string | null; current: PeriodPerformance | null; previous: PeriodPerformance | null; spendContributionPct: number | null; resultsContributionPct: number | null; lowVolume: boolean }`
  - `export function entitySplit(snap: MetaAuditSnapshot): { likeForLike: EntityChange[]; added: EntityChange[]; stopped: EntityChange[] }` — like-for-like = spend > 0 in both; added = only current; stopped = only previous. Contribution = entity Δ ÷ account Δ × 100 (null when account Δ is 0). Sorted by |spend Δ| desc, capped at 25 per level.
  - `export function creativeChanges(snap: MetaAuditSnapshot): { ads: EntityChange[]; newAdsSpendSharePct: number | null; fatigue: Array<{ adId: string; name: string; frequency7d: number; ctrCurrent: number; ctrPrevious: number }> }` — fatigue when CTR fell ≥ 15% and `frequency7d` ≥ 3.
  - `export type Shift = { dimension: BreakdownDimension; key: string; spendShareCurrentPct: number; spendSharePreviousPct: number; costPerResultCurrent: number | null; costPerResultPrevious: number | null; lowVolume: boolean }`
  - `export function breakdownShifts(snap: MetaAuditSnapshot): { shifts: Shift[]; failed: BreakdownDimension[] }` — top 8 keys per dimension by current spend.

- [ ] **Step 1: Failing tests:** lead snapshot with leads and no link clicks → link-click step null with note, rates null; a campaign present only in the previous window lands in `stopped`; like-for-like contributions sum to ~100% when all entities are like-for-like; ad with CTR 1.2→0.9 and freq 3.4 is flagged fatigue; a dimension whose `previous` is null is in `failed`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(comparison): funnel, entity, creative and breakdown comparisons`.

### Task 7: CMP findings and the comparison evidence renderer

**Files:**
- Create: `src/lib/comparison/findings.ts`, `src/lib/comparison/render.ts`
- Test: `tests/comparison-render.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 4, 5, 6.
- Produces:
  - `export type ComparisonFinding = { id: string; title: string; evidence: string; kind: "decline" | "win" | "measurement" | "structure" | "tracking"; bucket: "Investigate" | "Fix tracking" | "Creative" | "Audience" | "Budget" | "Hold" }`
  - `export function comparisonFindings(input: ComparisonInput): ComparisonFinding[]` — fixed order: measurement breaks, tracking checkpoint fails, Declined KPIs (by |Δ%| desc), largest bridge effect, stopped entities with ≥ 5% previous spend, fatigue flags, Improved KPIs. IDs `CMP-001…` in that order; same input → same IDs.
  - `export type ComparisonInput = { snapshot: MetaAuditSnapshot; today: string; businessModel?: string; scorecard: AuditScorecard; userContext: string | null }`
  - `export function buildComparison(input: ComparisonInput): { windows: Windows; type: BusinessType; kpis: KpiRow[]; bridges: Bridge[]; funnels: ReturnType<typeof funnelsOf>; entities: ReturnType<typeof entitySplit>; creative: ReturnType<typeof creativeChanges>; shifts: ReturnType<typeof breakdownShifts>; breaks: MeasurementBreak[]; caveats: string[]; findings: ComparisonFinding[] }`
  - `export function renderComparisonEvidence(input: ComparisonInput): string` — starts with `### Comparison evidence — <account name>`; sub-blocks `#### Windows`, `#### Settings` (attribution, events, business type), `#### KPI scorecard` (pre-formatted markdown table `Metric | Current | Previous | Δ | Δ% | Status`, money via `moneyFor`, "n/a" for null, "Low volume - not a trend" note), `#### Bridge`, `#### Funnel`, `#### Entities` (like-for-like, then New, then Stopped), `#### Creative`, `#### Breakdown shifts`, `#### Changes` (reuse `renderChangesEvidence`), `#### Tracking` (reuse `renderScorecardEvidence` T-lines + `renderMeasurementEvidence`), `#### User context` ("none supplied" when null), `#### Failed to load` (from `comparisonFailures` / `warnings`, Review Focus 5), `#### Findings` (one line per CMP finding: `CMP-001 | <kind> | <title> | <evidence> | <bucket>`), `#### Thresholds`.
- [ ] **Step 1: Failing tests** using `demoMetaAuditSnapshot` with `comparisonDetail`: output contains every `####` heading above; a KPI with null previous prints "n/a"; running `comparisonFindings` twice yields identical IDs; a snapshot with `comparisonFailures: ["ads"]` prints "ads: failed to load" under Failed to load; no number in the scorecard table differs from `kpiRows` output (assert by formatting a row).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(comparison): CMP findings and evidence renderer`.

### Task 8: Comparison writer framework

**Files:**
- Create: `src/lib/agent/comparison-framework.ts`
- Test: `tests/comparison-framework.test.ts`

**Interfaces:**
- Produces: `export const COMPARISON_FRAMEWORK: string` and `export const COMPARISON_TITLE = "Meta Ads Comparison Report"`.
- Content: title line `# Meta Ads Comparison Report — <account name>`; the 14 headings exactly as spec Appendix A, as `## 0. Report header and data integrity` … `## 13. Appendix`; COMPARISON rules from Appendix A; `SHARED_ANALYSIS_RULES`; diagnostic only (no action plan, no "we recommend"); section 2 table is the evidence's KPI table with a ≤ 8-word Note column; section 12 table `ID | Finding | Evidence | Confidence | Impact | Next-step bucket` with ≤ 8 words per text cell and a card per finding below for anything longer; copy CMP IDs from evidence, never invent; section 11 only from "User context"; existing voice rules (bullets, no paragraphs over two sentences, plain words).
- [ ] **Step 1: Failing test:** the framework contains each of the 14 headings in order (regex over indexes), contains "CMP-", "MEASUREMENT BREAK", "Low volume - not a trend", "[Hypothesis]", and does not contain "Action plan".
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(comparison): writer framework`.

### Task 9: Routing for `comparison`

**Files:**
- Modify: `src/lib/agent/task-plan.ts:23-42` (add `"comparison"` to `RequestIntent`), `detectRequestIntent` (keyword fallback), step list near 554 (new `case "comparison"` with steps `fetch_overview` "Load both periods", `pull_insights` "Compare performance", `build_plan` "Work out what drove the change", `write_report` "Write comparison", `complete`)
- Modify: `src/lib/agent/intent-classifier.ts` (`INTENT_GUIDE.comparison`; amend `audit` and `custom` guides so an audit-with-compare stays audit and a single metric "vs" question stays custom/general)
- Modify: `src/lib/agent/request-brief.ts` (any exhaustive intent lists / normalisation)
- Modify: `src/lib/agent/task-runner.ts:521-538` (complete steps through `build_plan` when `gathered.comparisonBuilt`, else fail them)
- Test: `tests/comparison-routing.test.ts`

**Interfaces:**
- Produces: `RequestIntent` includes `"comparison"`; `gatherDiagnoseEvidence` result gains `comparisonBuilt?: boolean` (set in Task 10).
- Fallback rule: comparison when `asksForComparison(text)` (from `audit-brief.ts`) and the text has report/compare-as-deliverable wording (`/\b(?:compare|comparison|period[- ]over[- ]period|vs\.?|versus|week[- ]over[- ]week|month[- ]over[- ]month)\b/`) and no audit wording (`/\baudit|health check|full review\b/`).

- [ ] **Step 1: Failing tests** (keyword fallback via `detectRequestIntent`, and `buildClassifierPrompt`/`INTENT_GUIDE` text checks): "compare last 14 days with the 14 days before" → comparison; "month over month report for October vs September" → comparison; "audit the account for last 30 days and compare with the previous period" → audit; "what was CPL last week vs the week before?" → not comparison; existing `tests/audit-compare-only-when-asked.test.ts` still passes.
- [ ] **Step 2–4:** FAIL → implement → PASS; run `npm test` for intent regressions.
- [ ] **Step 5: Commit** `feat(comparison): route period comparisons to their own report`.

### Task 10: Agent wiring and export for the comparison

**Files:**
- Modify: `src/lib/agent/adspirer-agent.ts` — new branch beside the strategy branch (~2879): `if (accountId && intent === "comparison")`: resolve ranges with `resolveAuditBrief`/`parseComparisonRanges` (default previous equal-length window; default current = last 14 days when none given), scope to named campaigns like the audit does, call `getAuditSnapshot(accountId, { since, until, days, compare: true, comparisonDetail: true, compareSince?, compareUntil?, campaignIds? })`, `evaluateCheckpoints`, push `renderComparisonEvidence(...)` then `["### Comparison framework (write the report with these headings)", COMPARISON_FRAMEWORK].join("\n")`, set `comparisonBuilt = true`, push toolCall `{ name: "comparison_report", … }`; on failure push `### Comparison unavailable` with the reason. `userContext` = the request text minus date phrases when it mentions promo / sale / stock / launch / holiday / price, else null. Writer rules block (~940): for `comparison`, start with the title line, diagnostic only, no tools unless a figure is missing. Progress label "Writing comparison…". Demo-mode summary (like the strategy demo path at ~1443): when intent is comparison and no reportDraft, return the evidence verbatim.
- Modify: `src/lib/report/from-markdown.ts` (title/account-name detection also matches `Meta Ads Comparison Report — <name>`; `reportType` = "Meta Ads Comparison Report" for it) and wherever export decides "full audit markdown" so a comparison exports through the generic branded path, not the audit schema.
- Test: `tests/comparison-agent.test.ts` (pattern: `tests/strategy-agent.test.ts`)

- [ ] **Step 1: Failing tests (DEMO_MODE):** `gatherDiagnoseEvidence({ clientId: "client_modern_dental", request: "compare last 14 days with the 14 before", intent: "comparison" })` → evidence contains "### Comparison evidence —" and "### Comparison framework", `comparisonBuilt === true`, toolCalls include `comparison_report`, no execute tools; an audit request with compare does **not** call `getAuditSnapshot` with `comparisonDetail` (spy on the mock provider); markdown starting `# Meta Ads Comparison Report — Modern Dental` exports (via the same function the export tests use) with title "Meta Ads Comparison Report" and keeps the `## 12. Findings and implications` heading.
- [ ] **Step 2–4:** FAIL → implement → PASS; `npm test`.
- [ ] **Step 5: Commit** `feat(comparison): gather evidence, write and export the comparison report`.

### Task 11: Prior findings from the chat

**Files:**
- Create: `src/lib/analysis/prior-findings.ts`
- Test: `tests/prior-findings.test.ts`

**Interfaces:**
- Produces:
  - `export type PriorFinding = { id: string; title: string; evidence: string | null; source: "audit" | "comparison" }`
  - `export type PriorReports = { findings: PriorFinding[]; used: string[]; ignored: string[] }` (`used`/`ignored` are one-line human reasons, e.g. `"audit of 2026-10-01 → 2026-10-15 not used: different period"`)
  - `export function priorFindings(history: AgentHistoryMessage[], period: { dateStart: string; dateStop: string }, scope: { campaignIds?: string[] } ): PriorReports`
- Rules: latest assistant message matching `/^#\s*Meta Ads Account Audit\b/m` and latest matching `/^#\s*Meta Ads Comparison Report\b/m`; period from the `**Period:**` line (audit, as `strategyPeriod` does) or the section-0 "Current:" line (comparison); used only when it overlaps `period`; a campaign-scoped report is used only when the strategy is scoped to a subset of those campaigns (whole-account strategy ignores a campaign-scoped audit). Audit IDs from `### AUD-\d{3}` headings (title after the em dash, evidence from the `**Evidence:**` bullet); comparison IDs from the section-12 table rows starting `CMP-\d{3}`. Old audits with `R\d+` headings → ignored with reason "uses the old R# numbering".
- [ ] **Step 1: Failing tests:** overlapping audit → its AUD findings returned, `used` names it; audit for a non-overlapping period → no findings, `ignored` says "different period" (Review Focus 4); both audit and comparison → both sets; campaign-scoped audit + whole-account strategy → ignored.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(strategy): read audit and comparison findings from the chat`.

### Task 12: Strategy inputs block

**Files:**
- Create: `src/lib/strategy/strategy-inputs.ts`, `src/lib/strategy/platform-notes.ts`
- Test: `tests/strategy-inputs.test.ts`

**Interfaces:**
- Consumes: `priorFindings` (Task 11), `CAPABILITIES` (`src/lib/agent/optimization-capabilities.ts`), `AuditScorecard`, `ResolvedGoals`, `businessTypeOf`, `measurementBreaks`.
- Produces:
  - `export const PLATFORM_NOTES_VERSION = "2026-11"`; `export const PLATFORM_NOTES: string[]` — learning needs ~50 optimisation events a week per ad set; budget steps of 20–30% every 3–4 days; a bigger jump or an edit to targeting/creative/optimisation resets learning; Advantage+ sales/leads campaigns are Meta's default build; view-through attribution inflates reported results; frequency limits from goals policy.
  - `export type AppAction = { capabilityId: string; label: string; tool: string; guardrail: string }` and `export function appActions(goals: ResolvedGoals): AppAction[]` — every `CAPABILITIES` entry with `owner === "app"` and a `tool` and no `queuedFrom`; guardrail text from `goals.max_budget_change_pct`, `daily_account_cap_cents`, `monthly_cap_cents`.
  - `export function ownFindings(scorecard: AuditScorecard): PriorFinding[]` — failed checkpoints, most severe first, IDs `SF-001…`, `source: "audit"` replaced by a new literal `"strategy"` (extend `PriorFinding.source` union).
  - `export function profileGaps(goals: ResolvedGoals, request: string, history: AgentHistoryMessage[]): string[]` — always lists industry, offer, risk appetite, constraints, creative assets, owners, CRM lead quality unless the chat text mentions them (simple keyword check per item); plus goal/timeframe/budget/margin when missing from goals and chat.
  - `export function renderStrategyInputsEvidence(input: { snapshot: MetaAuditSnapshot; goals: ResolvedGoals; scorecard: AuditScorecard; request: string; history: AgentHistoryMessage[]; period: { dateStart: string; dateStop: string }; scope?: { campaignIds?: string[] } }): string` — heading `### Strategy inputs (findings, profile, platform notes, app capabilities)` with sub-blocks: Business type; Findings (prior used/ignored lines, then one line per finding `ID — title — evidence`; when none qualify, the SF findings with the line "No audit or comparison in this chat covers this period; findings below come from this strategy's own checks (SF-###)"); Profile known; Profile missing (for Assumptions / Questions for the client); Measurement (breaks + caveats); Platform notes (with version); App capabilities (Type A list with guardrails).
- [ ] **Step 1: Failing tests:** with no prior reports, findings are SF-### and none start with AUD; `appActions` contains the budget/pause tools and excludes `queuedFrom: "commerce_page"` entries; `profileGaps` drops "risk appetite" when the request says "we're risk-averse"; rendered block contains `PLATFORM_NOTES_VERSION`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(strategy): findings, profile gaps, platform notes and app actions as evidence`.

### Task 13: 12-section strategy frameworks and wiring

**Files:**
- Modify: `src/lib/agent/account-strategy-framework.ts` — keep `VOICE` and `STRATEGY_TARGET_PROPOSAL_FRAMEWORK` (add: list missing profile items as "Questions for the client" in one short bullet list); replace `ACCOUNT_STRATEGY_FRAMEWORK` format with the 12 headings of spec Appendix A (`## 1. Strategy header` … `## 12. Client checklist`), STRATEGY rules from Appendix A, `SHARED_ANALYSIS_RULES`, and the existing "How to build the plan" content kept where it doesn't conflict (scale climbs, order of moves, budget steps). Section 6 layout per Global Constraints; action IDs `STR-001…`; each action cites ≥ 1 finding ID from "Strategy inputs"; Type A only for actions in "App capabilities", with before → after (current value from evidence), guardrail, rollback; Type A card ends "Can be queued to Approvals by asking to optimise."; impact as a range from the engine's projection, else "Impact uncertain"; confidence High/Medium/Low lowered for each missing profile item.
- Modify: `src/lib/agent/strategy-framework.ts` — `LEAD_STRATEGY_FRAMEWORK` to the same 12 headings, keeping its lead-specific rules (no ROAS/revenue, "service" wording, budget cases, campaign allocation table goes in section 7 Budget plan, competitor routes in section 5 or 8); CPL vs cost per qualified lead rule. `STRATEGY_FRAMEWORK` unchanged.
- Modify: `src/lib/agent/adspirer-agent.ts` ~2965–3030 — in the account path (plan and proposal stages) and the lead path, push `renderStrategyInputsEvidence(...)` before the framework section, using `strategyPeriod`'s range and the request's matched campaigns as scope.
- Modify tests that assert old plan headings (`tests/strategy-writer.test.ts`, `tests/account-strategy.test.ts`, `tests/lead-strategy.test.ts` if they check framework text).
- Test: `tests/strategy-12-sections.test.ts`

- [ ] **Step 1: Failing tests:** `ACCOUNT_STRATEGY_FRAMEWORK` and `LEAD_STRATEGY_FRAMEWORK` each contain the 12 headings in order, "STR-", "Type A", "Impact uncertain", "Questions for the client", and the short-table header `ID | Action | Owner | Type | Timing | Effort`; `LEAD_STRATEGY_FRAMEWORK` still forbids ROAS; `STRATEGY_FRAMEWORK` text is unchanged (compare to a snapshot string taken before editing); DEMO `gatherDiagnoseEvidence` for an account strategy with a target and for a lead strategy both contain "### Strategy inputs (findings".
- [ ] **Step 2–4:** FAIL → implement → PASS; `npm test`.
- [ ] **Step 5: Commit** `feat(strategy): 12-section evidence-based strategy for account and lead plans`.

### Task 14: Full check

- [ ] **Step 1:** `npm test` — all pass. `npx tsc --noEmit` — no errors. `npx eslint src tests` — no new errors.
- [ ] **Step 2:** Run the app in demo mode (`run` skill) and in the workspace chat send: "compare last 14 days with the 14 before", then "give me a strategy to $40 per lead in 45 days" for a lead client and "strategy to 4x ROAS in 60 days" for a sales client. Confirm: comparison has the 14 headings, CMP IDs, no action plan; strategies have 12 headings, STR IDs citing CMP/AUD/SF; PDF and Word export of the comparison and a strategy render the tables and cards.
- [ ] **Step 3:** Record in memory that live Meta checks (one ecom, one leadgen account) are still pending before merge; do not merge to `main` without Rithin's go-ahead.
