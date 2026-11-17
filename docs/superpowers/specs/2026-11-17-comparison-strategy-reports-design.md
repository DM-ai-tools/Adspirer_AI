# Comparison report + evidence-based strategy — design

Date: 2026-11-17 · Status: draft for approval

## Intent

Rithin supplied a two-mode analysis prompt (COMPARISON and STRATEGY, plus shared rules) and wants the
workspace's Meta reporting to follow it. Today a comparison is only an add-on inside the audit, and the
strategy plan neither cites findings nor says who does each action or whether the app can do it. The aim is
reports a client and a Meta specialist can trust: every number from the data, every cause labelled by how
sure we are, every recommendation tied to a finding, and declines reported as plainly as wins.

The source prompt is kept at the end of this doc (Appendix A) and is the spec for headings and rules.

## Decisions already made (by Rithin, 2026-11-17)

1. **Audit finding IDs become AUD-###** in the visible audit report (chat, PDF, Word), replacing R1, R2.
   Every "see R#" pointer becomes "see AUD-###".
2. **Comparison is its own report, started from chat only.** No new button or page. "Compare last 14 days
   with the 14 before" routes to it. Export uses the existing PDF / Word / Markdown pipeline and branding.
3. **Strategy action plan = short table + cards.** A compact table (ID | Action | Owner | Type | Timing |
   Effort), then one card per action holding the remaining fields (Evidence, Expected impact + confidence,
   Dependency, Success metric, Rollback, and for Type A the before → after, guardrail, rollback note).
4. **Missing business details are asked in chat, not saved.** No goals-form changes. Strategy lists what it
   lacks (industry, offer, risk appetite, constraints, assets, owners, CRM lead quality, unit economics not
   in the goals profile) under Assumptions and Questions for the client, and lowers its confidence.

## Goals

- A new **comparison** intent, routed by the LLM classifier (per the standing rule that special requests are
  LLM-routed), producing the 14-section COMPARISON report (sections 0–13), diagnostic only, no action plan.
- The STRATEGY output rewritten to the prompt's 12 sections, citing AUD / CMP finding IDs, with Type A/B/C
  and Owner on every action.
- The SHARED RULES applied to audit, comparison and strategy writers: [Observed] / [Likely] / [Hypothesis]
  labels, "Meta-reported" labels, attribution + conversion events stated, MEASUREMENT BREAK flagging,
  objectives never blended, absolute value beside every %, "Low volume - not a trend" marking,
  business-type emphasis (ecom / leadgen / hybrid).
- Every new figure (driver bridge, statuses, low-volume flags, maturity flag, new/stopped entities, funnel
  rates) is computed in code and handed to the writer as evidence. The writer copies; it never calculates.

## Non-goals

- No UI changes: no new buttons, pages, form fields or tables in the workspace.
- No new external data source for section 11 (External context). It shows what the operator said in chat,
  else "Not available — no external context supplied".
- No database migration. Findings are not stored in a table (see "Finding IDs across reports").
- Google Ads comparison/strategy. Meta only, as today.
- No change to how audits are triggered or to the audit's own section list beyond the ID scheme and the
  shared-rule labels.

## Anti-goals (failure even if it "works")

- The writer inventing or recomputing a number (a % change, a total, a CPA) that isn't in the evidence.
- A comparison that sneaks in a strategy or action plan.
- A recommendation with no finding ID behind it.
- A Type A action for something the app cannot actually execute, or with no guardrail / rollback.
- Comparison triggered when the operator only asked for an audit (the existing "compare only when asked"
  rule and its tests must keep passing).
- Sentences in narrow table cells in printed reports (existing print rule).

## Constraints

- Next.js in this repo has breaking changes; read `node_modules/next/dist/docs/` before touching routes.
- Existing pipeline shape must be kept: data fetch (`provider.getAuditSnapshot`) → code-built evidence text
  → writer framework prompt → reply formatting → export (`src/lib/report/{pdf,docx,md}`).
- Report branding (Traffic Radius logo/colours/Montserrat, black not navy) applies to the comparison export.
- Today's audit "compare" mode stays working for operators who ask for an audit with a comparison; the new
  comparison intent is for when the comparison itself is the deliverable.
- Tests run with vitest; all existing audit / strategy tests must stay green or be updated deliberately.

## How things work today (for the builder)

- Routing: `src/lib/agent/intent-classifier.ts` (LLM) with keyword fallback in `task-plan.ts` /
  `request-brief.ts`. Intents include audit, strategy, custom, followup — no comparison.
- Audit: `adspirer-agent.ts` gathers a `MetaAuditSnapshot` (`src/lib/audit/meta-audit-data.ts`) with
  `previousPerformance` on campaigns / ad sets / ads when compare is on; `src/lib/audit/render.ts` turns it
  into evidence ("Totals vs previous period", daily averages when lengths differ); `checkpoints.ts` scores
  setup; `breakdowns.ts` and `performance-tables.ts` build splits; `meta-audit-framework.ts` is the writer
  method with the 10-section report and R# risk cards.
- Comparison ranges: `parseComparisonRanges` / `asksForComparison` in `natural-dates.ts` / `audit-brief.ts`
  already parse "A vs B" and "vs previous period".
- Changes in period: `AuditChange` + `AuditChangeContext` (activity history, per-day series around edits).
- Strategy: `account-strategy-framework.ts` (target proposal → plan), engine in
  `src/lib/strategy/account-strategy.ts` + `account-strategy-render.ts`, brief in `account-strategy-brief.ts`.
  Goals/guardrails from `src/lib/clients/goals.ts` (business_model, target CPA/ROAS, margin, attribution,
  budget caps, policy). Executable actions are described in `optimization-capabilities.ts` and
  `src/lib/strategy/meta-capabilities.ts`; queued actions go to Approvals.

## Approaches considered

**Comparison**

- A. *Extend the audit's compare mode* — swap the audit layout for the comparison layout when compare is on.
  Cheap, but mixes two deliverables in one flow and breaks the "audit only compares when asked, and stays an
  audit" behaviour and its tests.
- B. *New comparison intent reusing the audit's data fetch* (**chosen**). New evidence builder + writer
  framework + export; shares the snapshot, change history, breakdowns and checkpoints. Clean separation, most
  reuse.
- C. *Fully separate data pipeline* — rejected: duplicates the snapshot fetch and its fixes (lead
  double-count, legacy activity types).

**Strategy**

- A. *Rewrite the plan framework to the 12 sections, keep the target-proposal step* (**chosen**). When no
  goal is given the existing proposal step still asks for one (this matches the prompt's "don't guess" rule);
  the plan then uses the new format.
- B. *Drop the target step and always write the full plan with assumptions* — rejected: loses the proposal
  flow that was live-checked, and the prompt prefers asking over guessing.

**Finding IDs across reports**

- A. *Read IDs from the chat* (**chosen, builder's-call level**): strategy and comparison look back in the
  conversation for the latest audit / comparison reply, extract AUD-### / CMP-### cards (ID, title, evidence
  line) with a parser, and pass them as `audit_findings` / `comparison_findings`. No migration.
- B. *Store findings in a table per client* — rejected for now (migration, and Rithin chose not to save data
  for this feature). Can follow later.

**Which earlier report counts (settled):** the latest audit and the latest comparison in the conversation,
each used only when its period overlaps the strategy's data period and its scope (whole account vs named
campaigns) covers the strategy's scope. A report that doesn't qualify is ignored, and the strategy header
says so ("audit of 1–15 Oct not used: different period").

**ID stability (settled):** AUD-### keeps being numbered by the audit writer, as R# is today; building the
risk list in code is out of scope. IDs are therefore stable *within a conversation*: strategy cites the IDs
of the exact reply it read. CMP-### are numbered by code. When strategy has no qualifying audit, it numbers
its own checkpoint/engine findings **SF-###** ("strategy finding"), never AUD-###, so an ID can't mean two
different things. The header says which source the findings came from.

## Design

### 1. Shared rules

- A `SHARED_ANALYSIS_RULES` text block (new file, e.g. `src/lib/agent/shared-analysis-rules.ts`) holding
  shared rules 1–9 from Appendix A, adapted to this app's voice. Included by the audit, comparison and
  strategy frameworks.
- Business type: `ecom` / `leadgen` / `hybrid` worked out in code from `goals.business_model` (ecommerce →
  ecom; lead_gen, local_service, b2b → leadgen) and else from the data (purchases only → ecom, leads only →
  leadgen, both with material spend → hybrid). Passed in the evidence header.
- Attribution + conversion events: from the snapshot's ad set `attributionWindows` and optimisation goals;
  stated in every report header.
- **Measurement break** detection in code, best-effort (settled): an `AuditChange` inside either window
  that edits attribution spec, optimisation event / promoted object, or pixel/dataset settings. Listed in the
  evidence; affected metrics carry "MEASUREMENT BREAK" and the writer must not call their change a
  performance change. Meta's activity history may not log every such edit and earlier ad set attribution
  settings can't be recovered, so section 0 / 10 always states this limitation. Ad sets running different
  attribution windows in the same objective are flagged as a **measurement caveat** (not a break).
- Objectives never blended: totals per objective group (sales / leads / traffic / awareness / engagement /
  messaging), and the account-level result line only when one objective dominates (>~90% of spend); else
  per-objective lines.
- **Audit report** changes are limited to: R# → AUD-### (headings, index, pointers, export renderers and
  any parser that reads risk cards), the [Observed]/[Likely]/[Hypothesis] tag on each risk's cause, and
  "Meta-reported" labels (already mostly present).

### 2. Comparison mode

**Routing.** Add `comparison` to `INTENT_GUIDE`: the operator wants periods compared as the deliverable
("compare this month with last month", "how did last week do vs the week before", "period over period
report"). An audit that also asks to compare stays `audit`. A single-metric "vs" question stays
`general`/`custom`. Keyword fallback mirrors this. Periods come from the existing range parsers; when only one
range is given, the previous window of equal length.

**Data fetch (builder's call, settled).** Today the snapshot has previous-period figures only for totals,
campaigns and ad sets, and breakdowns (age/gender, placement) only for the current window; country and
device aren't fetched. The comparison needs ad-level previous figures and placement, age, gender, country
and device for both windows. These extra fetches run **only on the comparison path**, behind an option on
`getAuditSnapshot` (e.g. `comparisonDetail: true`), so audits keep their current speed and API load. They
run in parallel with the existing per-call error handling, and a failed part is reported as "failed to load"
in section 0, not dropped. Expect a comparison to take somewhat longer than a compared audit.

**Evidence (all computed in code)** — new `src/lib/comparison/` module, fed by that snapshot fetch:

- *windows*: dates, day counts, equal-length flag; when unequal, per-day figures alongside totals.
- *maturity_flag*: true when the current window ends within the attribution lag (≤ 7 days ago for a 7-day
  click window, ≤ 1 day for 1-day click); names the immature days.
- *kpis*: per metric current, previous, Δ, Δ%, status, low_volume flag. Status is direction-aware (lower
  CPA/CPM/CPL = Improved; higher ROAS/CTR/CVR = Improved), **Stable** within the materiality threshold,
  **Low volume** below the volume threshold.
- *thresholds* (defaults, in one constants object, overridable from goals policy later): materiality ±5%;
  low volume under 30 results in either window for result-based metrics, under 1,000 impressions for rate
  metrics, under 5% of spend for an entity row.
- *bridge*: decomposition of the change in the primary cost metric and in results:
  results = impressions × CTR × CVR; cost per result = CPM ÷ (1000 × CTR × CVR); revenue = purchases × AOV.
  Use log-share attribution so the effects add exactly to the total change, and report each effect in
  absolute units and % of the total change. Volume effect (spend change) reported separately.
- *funnel*: ecom — impressions → link clicks → LPV → add to cart → initiate checkout → purchase, with step
  rates both windows. leadgen — impressions → link clicks → (form opens when Meta returns them, else "Not
  available") → leads. Hybrid gets both, separated.
- *entities*: campaign / ad set / ad rows matched by id; like-for-like table (both windows delivered),
  separate **new** (no previous delivery) and **stopped** (no current delivery) table; contribution of each
  like-for-like entity to the total change in spend and results.
- *creative*: per-ad current vs previous for ads in both windows (ad-level previous figures are new, see
  Data fetch); new creatives and their share of spend;
  fatigue signals (frequency up and CTR down) as flags only.
- *breakdowns*: placement, age, gender, country, device for both windows, with share-of-spend shift and
  cost-per-result change; low-volume rows marked.
- *change_log*: `AuditChange` list for both windows with existing per-change context.
- *tracking_health*: checkpoint T-codes for the current window plus pixel/event stats; measurement breaks.
- *user_context*: anything the operator said in the request (promos, stock, seasonality) — the only source
  for section 11.
- Reach and frequency only at account level from Meta's own account row, never summed.
- Findings get **CMP-###** IDs, numbered by code from the computed statuses/flags in a fixed order so a
  re-run on the same data gives the same IDs; the writer uses those IDs and may not invent new ones.

**Writer.** New `COMPARISON_FRAMEWORK` with exactly the 14 headings (0–13) of Appendix A, the shared rules,
existing voice/print rules (no sentences in table cells; the KPI scorecard and finding table are the only
wide tables and their Note / Finding cells stay ≤ 8 words; longer text goes in cards below). Section 12's
"Next-step bucket" is one of: Investigate · Fix tracking · Creative · Audience · Budget · Hold — buckets
only, no actions (strategy turns them into actions).

**Export.** Comparison replies export through the existing report pipeline with the existing branding;
the md/pdf/docx renderers get a comparison template or a generic path that preserves its headings and tables.

### 3. Strategy mode

**Scope (Rithin, 2026-11-17):** the **account strategy** (`ACCOUNT_STRATEGY_FRAMEWORK`,
`account-strategy*.ts`) and the **lead/service strategy** (`LEAD_STRATEGY_FRAMEWORK`, `lead-plan.ts`,
`lead-render.ts`) both move to the 12-section format. The **category strategy** (`STRATEGY_FRAMEWORK`,
`plan.ts`, `render.ts`) stays as it is. **Queuing by STR ID is out of scope:** strategy stays advice only, and
Type A cards say the change can be queued by asking to optimise, as today. The queue parser is not touched.

- Keep the target proposal step as is (it is the "Questions for the client" for the goal). Once a target is
  set, the plan framework writes the 12 sections of Appendix A.
- **Inputs assembled in code**: business_profile from goals (+ what the operator said in chat; missing items
  listed explicitly), audit_findings / comparison_findings (from chat, else own numbered findings),
  tracking_status (checkpoints), platform_notes (a versioned constant in code, e.g.
  `PLATFORM_NOTES_VERSION = "2026-11"`, holding the rules the frameworks already use: learning needs ~50
  events/week, 20–30% budget steps every 3–4 days, Advantage+ defaults, etc.), app_capabilities (from
  `meta-capabilities.ts` / `optimization-capabilities.ts`, each with its guardrail).
- **Type A** only when the action maps to a listed capability; the evidence gives the exact current value so
  the writer can state before → after; guardrail comes from goals policy (max_budget_change_pct, caps);
  rollback note is the inverse change. Type A actions can be queued to Approvals through the existing
  optimize/queue flow after the operator says so — strategy itself never queues.
- **Owner** values: App | Media buyer | Client | Developer | Creative | Sales.
- Expected impact: a range only when the engine has a projection; else "Impact uncertain". Confidence
  labels High / Medium / Low, lowered when inputs are missing.
- Layout per decision 3: section 6 is the short table + one card per action. Sections 7–12 follow
  Appendix A; leadgen optimises for cost per qualified lead only when CRM data is supplied in chat.
- Existing strategy behaviours to keep: lead accounts never mention ROAS; scale-mode targets; budget steps
  with dates; "nothing in Meta is changed" line.

### 4. Testing

- Unit tests (vitest) for: business-type inference, measurement-break detection, direction-aware status +
  thresholds, bridge decomposition (effects sum to total), maturity flag, new/stopped entity split, CMP ID
  stability, AUD-### extraction from a chat reply, Type A mapping only for listed capabilities.
- Intent tests: comparison vs audit-with-compare vs general "vs" question.
- Framework snapshot tests for headings (14 comparison, 12 strategy) and AUD-### in the audit format.
- Update existing tests that assert R# in audit output.
- Live check on one ecom and one leadgen account before merge (mock data first via demo store).

## Left to the builder

- Exact file split inside `src/lib/comparison/`, and whether the comparison evidence renderer reuses
  `render.ts` helpers or wraps them.
- Exact log-share formula details and rounding, as long as effects sum to the total.
- How the export pipeline detects a comparison reply (heading match vs message metadata).
- Wording of the shared-rule block, keeping the existing voice rules.
- Progress labels shown while the comparison runs.

## Appendix A — source prompt (as supplied)

```
ROLE
You are the Meta Ads analysis engine inside [App Name]. You work in one of two modes,
set by MODE in the input. Follow only the section for the active mode, plus the
SHARED RULES.

MODE: {{COMPARISON | STRATEGY}}

SHARED RULES (apply to both modes)
1. Use only values supplied in the input JSON. Never calculate, estimate or invent
   numbers. If a value is missing, write "Not available" and say why.
2. Label platform data "Meta-reported". Do not call it revenue or profit unless the
   user supplied actual revenue.
3. Label every explanation: [Observed] (the data shows it), [Likely] (indirect evidence)
   or [Hypothesis] (needs testing). Never state a cause as fact unless it is Observed.
4. State the attribution setting and conversion events used. If an attribution or
   measurement change falls inside either comparison window, flag a MEASUREMENT BREAK
   and do not present the affected change as a performance change.
5. Do not blend different campaign objectives into one metric.
6. Show absolute values next to every percentage. Mark low-volume metrics
   "Low volume - not a trend".
7. Tone: neutral, specific, professional. Report declines as clearly as wins.
8. Adapt emphasis to business_type:
   - ecom: Purchases, purchase value, ROAS, CPA, AOV; funnel through add to cart and checkout.
   - leadgen: Leads, CPL, cost per qualified lead if CRM data exists; funnel through form
     open to form submit; warn if CPL improved while lead quality declined.
   - hybrid: produce both, separated.
9. Findings carry stable IDs shared across reports: AUD-### (audit), CMP-### (comparison),
   STR-### (strategy actions).

IF MODE = COMPARISON
Write a factual period-over-period report. This is diagnostic. Do NOT write a strategy
or action plan.
INPUTS: business_type, windows, settings, kpis (current, previous, deltas, status,
low_volume_flag), bridge (volume, efficiency, CPM, CTR, CVR, AOV effects), funnel,
entities (with new/stopped flags), creative, breakdowns, change_log, tracking_health,
user_context, thresholds.
RULES
- Windows must be equal length. If not, say so in Section 0 and use per-day figures.
- If maturity_flag is true, flag the last days of the current window as immature.
- Status is direction-aware: Improved, Declined, Stable (within materiality threshold),
  or Low volume.
- Never sum reach or frequency across entities. Use the supplied account-level values.
- Compare like-for-like entities only. New and stopped entities go in a separate table.
OUTPUT (exactly these headings, in order)
0. Report header and data integrity
1. Executive summary (verdict; top 3 wins; top 3 declines; main cause; top 3 priorities)
2. KPI scorecard (Metric | Current | Previous | Δ | Δ% | Status | Note)
3. Driver analysis
4. Funnel comparison
5. Campaign / ad set / ad contribution
6. Creative comparison
7. Audience, placement, geo, device and demographic shifts
8. Delivery and cost diagnostics
9. Changes made during the period
10. Tracking and data quality
11. External context
12. Findings and implications (ID | Finding | Evidence | Confidence | Impact | Next-step bucket)
13. Appendix (definitions, formulas, methodology, limitations)

IF MODE = STRATEGY
Produce a prioritised, evidence-based strategy. Do not restate the full reports.
INPUTS: business_profile (type, industry, geo, offer, goal, timeframe, budget, unit
economics, CRM or quality feedback, constraints, assets, risk appetite, owners),
audit_findings, comparison_findings, tracking_status, platform_notes (versioned by the
app), app_capabilities (actions the app can execute, with guardrails).
RULES
- Every recommendation cites at least one finding ID. No orphan advice.
- Expected impact is a directional range with a confidence label, never a guarantee.
  If the data can't support a range, write "Impact uncertain".
- If a required input is missing (goal, budget, unit economics, constraints), do not
  guess. List it under "Assumptions" and "Questions for the client" and lower the
  stated confidence.
- Respect constraints and risk appetite. Don't recommend what the budget or assets
  can't support.
- Account for platform_notes. If advice conflicts with them, explain why or drop it.
- Prefer fewer, high-impact actions, ordered by impact and effort.
- leadgen: optimise for cost per qualified lead where CRM data exists, not CPL alone.
  ecom: anchor targets to break-even and target ROAS where margin is supplied.
- Every action gets a Type and an Owner:
  Type A = app can execute after user approval (only if listed in app_capabilities)
  Type B = app prepares, a human applies
  Type C = external
  Owner = App | Media buyer | Client | Developer | Creative | Sales
- For Type A actions, give the exact before → after change, a guardrail, and a rollback note.
OUTPUT (exactly these headings, in order)
1. Strategy header (goal, window, inputs used, assumptions, overall confidence)
2. Situation summary (max 6 lines)
3. Diagnosis (3-5 constraints, each with finding IDs)
4. Targets and guardrails
5. Strategic pillars
6. Action plan (ID | Action | Evidence | Expected impact + confidence | Effort | Owner |
   Type | Dependency | Timing: Now 0-7d / Next 8-30d / Later 31-90d | Success metric | Rollback)
7. Budget plan (current vs proposed, scaling rules)
8. Creative plan (angles, formats, hooks, volume per cycle, brief for the creative team)
9. Testing roadmap (hypothesis | variable | metric | min spend and duration | decision rule)
10. Measurement and review cadence, re-plan triggers
11. Risks and dependencies
12. Client checklist (decisions, approvals, data needed)
```
