# Optimization Pipeline Design

## Intent

Optimization is the most important thing the workspace assistant does. An operator who types an optimization request in the workspace chat must get: (1) an answer built from **live** Meta data for exactly the scope and period they asked about, (2) steps worded the way a Meta specialist would say them, each marked with **who can do it** (this app, someone in Ads Manager, a developer, the landing page owner, the client), (3) only what they asked for, nothing bolted on, and (4) when they ask for changes to be queued, **only the changes they asked for** in Approvals, so that approving never applies something they did not want.

## Review of today's pipeline (verified by reading code on 2026-10-28)

| Requirement | Gap | Where |
|---|---|---|
| Writer can read Meta freely | Prompt tells the model to use `optimize_meta_budget`, `optimize_meta_placements`, `detect_meta_creative_fatigue`, but they are not on its read allowlist; pixel/CAPI/learning data exists only in the audit snapshot with no tool | `diagnose-tools-ai.ts:17`, `prompts.ts:172` |
| Each message analysed for context | Classifier returns one label only; no scope, period, focus, act-vs-analyse, or which proposals to queue. Regex runs first and a regex still gates queueing | `intent-classifier.ts`, `task-runner.ts:264,567,867` |
| Expert wording + who does what | `Checkpoint` has fix/impact but no owner; the app-vs-developer split is one prompt line in the follow-up path only | `checkpoints.ts:35`, `adspirer-agent.ts:860` |
| Only what was asked | Optimize pre-step always builds budget + fatigue + reactivate + new ad set + 14-day checkpoints + ad picker. A queue request queues **every** pre-built proposal | `adspirer-agent.ts:3442-3590`, `task-runner.ts:867-875` |
| Knows what it can do | Only 13 execute tools; nothing edits placements, bids, schedule, audience exclusions. Capability knowledge is scattered prompt text | `policy.ts:44-61` |
| Live data, scoped | Windows hard-coded (7 / 7v7 / 14 days); only an ad-id substring narrows scope; follow-ups fetch no data | `adspirer-agent.ts:3453,3463`, `task-runner.ts:418` |

## Goals

1. **Request brief.** Every message is turned into a validated structured brief: intent, analyse vs act, focus areas, scope mentions, period, and a queue selection. Dates are resolved by code, never by the model.
2. **Live, scoped, demand-driven evidence.** Optimization evidence is fetched live per turn for the brief's scope and period and only for the brief's focus areas. The writer gets the optimize read tools and a new account-health tool.
3. **Capability and owner map** as the single source of truth (what each recommendation type is, who does it, which tool does it). The prompt block and the "who does what" table are generated from it.
4. **Queue exactly what was asked.** Proposals carry reference numbers; the queue step selects by reference, focus, or named entity; nothing is queued unless the brief is `act`; the reply's "queued / not queued" block is written by code, so it is always true.
5. **Four new in-app actions**: change an ad set's placements, bid strategy and cap, schedule, and audience exclusions. They go through the same Approvals gate, validation, drift check, risk scoring, change log and rollback as the existing 13.
6. **Verification**: unit and integration tests for each piece, a phrasing eval set, full suite and typecheck green.

## Non-goals

- No new data sources (Google stays read-only; no TikTok/LinkedIn).
- No auto-applying anything: Approvals remain mandatory for every Meta change.
- No editing of existing ad creative or copy in place (Meta creatives are immutable; "replace the creative" stays create-new-ad + pause-old).
- No campaign-level bid strategy edit for campaign-budget (CBO) campaigns; the app refuses it with a plain message and tags it "Ads Manager".
- No change to the audit flow, the campaign builder, creative generation or Shopify tools beyond what this design lists.

## Anti-goals (a failure even if it technically works)

- Queueing any change the operator did not ask for, or more changes than they named.
- A reply claiming something was queued, applied or verified when it was not.
- Falling back silently to a wider scope than the operator named (an unmatched campaign name must be reported, not widened to the account).
- A recommendation tagged "can be done in the app" that the app cannot actually do.
- Using numbers from earlier replies as if they were current.

## Constraints (carried from the codebase)

- Changes reach Meta only through Approvals; campaigns are created PAUSED; the policy gate fails closed (`policy.ts`); execute tool args are validated by `prepareApprovalArgs` at proposal, edit and execution time.
- The executor re-reads live state before writing and refuses on drift (`live-state.ts`); rollback is built from the change log's before-state.
- Vendor names (Adspirer, Graph API, MCP, OpenAI, Anthropic) never reach the operator (`client-facing.ts`).
- Next.js is a modified version (see `AGENTS.md`): this work touches `src/lib` and tests only, no route or page changes.
- Files in the working tree use CRLF; git normalises to LF. Do not rewrite whole files to change line endings.
- Meta Graph is the only write target. The four new tools are tested against a fake Graph client; they have **not** been run against live Meta in this work (see Verification).

## Design decisions (the implementer must follow these; marked *call* where I decided)

### D1. Request brief — `src/lib/agent/request-brief.ts`

```ts
type Focus = "budget" | "bids" | "placements" | "audiences" | "creative" | "schedule"
           | "tracking" | "structure" | "reactivation" | "landing_page";
type RequestBrief = {
  intent: RequestIntent;
  mode: "analyse" | "act";           // act = the operator asked for changes to be made or queued
  focus: Focus[];                    // empty = no specific area named
  scope: { mentions: string[] };     // campaign / ad set / ad names or ids exactly as typed; empty = whole account
  period: { since: string; until: string; label: string; explicit: boolean } | null;
  queue: { requested: boolean; all: boolean; refs: number[]; focus: Focus[]; entities: string[] };
  optimizationAsk: boolean;          // wants optimization steps/advice (drives live fetch for follow-ups)
  source: "model" | "rules";
};
```

- The existing classifier call is extended (same model, same history window) to return this JSON; parsed and validated with zod. Invalid or timed-out output falls back to a rules brief built from the existing `detectRequestIntentWithHistory`, `parseDateRangeFromText`, `wantsQueueApprovals`, plus focus keyword rules. *call:* timeout raised from 5s to 8s and output budget from 40 to 400 tokens because the JSON is larger.
- `period` is filled by code from the message text (`parseDateRangeFromText`); the model only reports whether a period was stated. When none is stated: inherit the period already in the conversation (previous brief's explicit period, or the audit's date range line); else the **last 7 completed days** (`explicit: false`, and the reply states it). *call.*
- `scope.mentions` are resolved against live campaigns / ad sets / ads (`matchCampaignsByHints` for campaigns, id or exact/contains name match for ad sets and ads). Mentions that match nothing are reported and **no widening** happens.
- `mode` is `act` only when the message asks to change, queue, apply, send, pause, resume, set, exclude, or similar. Questions and "what should I optimise" are `analyse`.
- A `followup` with `optimizationAsk` is re-routed to the optimize evidence path in analyse mode, with scope and period inherited from the conversation. A `followup` without it (explain finding 3, summarise) stays data-free as today.

### D2. Live, scoped, demand-driven evidence — `src/lib/agent/optimize-evidence.ts`

Replaces `buildFullOptimizeProposals` as the entry point of the optimize pre-step. It receives `{provider, accountId, brief, currency}` and:

1. Resolves `period` and `scope`.
2. Fetches only the sections the brief's focus needs (empty focus = the core set: budget + creative + tracking signals):
   - budget → `optimizeBudget` with `since/until` (new option, takes precedence over `lookback_days`) restricted to the scope; proposals `update_adset_budget`, `update_campaign_budget`, `pause_adset`.
   - creative → `detectCreativeFatigue` anchored on the period end (7-day weekly rule, said in the output) restricted to scope; proposals `pause_ad`.
   - placements → `meta_insights` breakdown `publisher_platform,platform_position` for the period and scope; rule-based proposals `update_adset_placements` only when a placement has ≥ 2× the ad set's average cost per result **and** spend ≥ 10% of the ad set's spend, or spend ≥ max(10, daily budget) with zero results, while the ad set has converting placements.
   - bids → read the ad set's current bid strategy/cap; no automatic proposal (bid changes need an operator-stated target); evidence only.
   - audiences, schedule → evidence only (exclusion overlap data is not available from Graph insights); changes only when the operator states them.
   - tracking → checkpoint scorecard for the period (T-codes), including the existing "hold increases on silent tracking" rule.
   - reactivation → paused campaigns with results in the last 90 days (today's rule), only when the focus says so.
   - structure → new broad ad set proposal (today's rule), only when the focus says so.
3. Numbers every offered proposal `#1..#n` in a stable order (focus order, then spend at stake descending) and returns them with their focus and entity ids.
4. Builds `optimizeAppendix`: a code-generated markdown "Who does what" table (ref, step, evidence, owner, tool, queueable) appended to the reply by the task runner (same pattern as the audit appendix), so owner tags and refs are never model-written.

The default fixed bundle is removed. `getAuditSnapshot` is called with the brief's `since/until`, not `{days: 14}`.

### D3. Capability and owner map — `src/lib/agent/optimization-capabilities.ts`

```ts
type ActionOwner = "app" | "ads_manager" | "developer" | "landing_page" | "client";
type Capability = { id: string; label: string; focus: Focus; owner: ActionOwner; tool?: string; note: string; checkpointIds?: string[] };
```

- One entry per recommendation type. `owner: "app"` entries name an execute `tool` that **must exist in `getPolicyMap()` as `execute`** (a unit test enforces it). Examples: budget, pause/resume, bid strategy/cap (non-CBO), placements, audience exclusions, schedule, new ad set / ad / campaign, generate ad copy and images are `app`; pixel / Conversions API / event deduplication / customer-information parameters are `developer`; page speed, message match, form friction are `landing_page`; CBO campaign bid strategy, attribution window on an existing ad set, domain verification are `ads_manager`; budget targets and offer decisions are `client`.
- `ownerForCheckpoint(id)` maps every checkpoint id in `checkpoints.ts` (T1–T10, S1–S5, B1–B7, A1–A5, C1–C7, F1–F5) to a capability. A unit test scans `checkpoints.ts` for `id: "…"` and fails if one is unmapped.
- A generated prompt block ("What you can queue in Approvals / what needs someone else") is built from the map and injected into the writer's static system prompt, replacing the hand-written capability text in `prompts.ts`, `prompts-v2.ts` and `adspirer-agent.ts`. A test fails if a tool classified `execute` has no capability entry.
- `renderOptimisationSignals` adds the owner to each priority line.

### D4. Writer rules for optimization replies

For `optimize` intent (and re-routed follow-ups) the writer is told: lead with the answer for the stated scope and period; describe each step in Meta-specialist wording with evidence (numbers + source + period), expected effect, and ref numbers; do not restate the "who does what" table (code appends it); say plainly which steps are not doable in the app and who does them; never invent steps not in the evidence or the checkpoint fixes; no menu of next steps.

### D5. Queue selection — `src/lib/agent/queue-selection.ts`

`selectForQueue({ brief, offered, writerCalls, resolvedEntityIds })` returns `{ queue, skipped }`:

1. `brief.mode !== "act"` or `!brief.queue.requested` → queue **nothing** (applies to every intent that is not an explicit create flow). Writer-emitted execute JSON is dropped, with a skipped reason.
2. Candidates = offered proposals ∪ writer-emitted calls, de-duplicated by `tool + canonical args`.
3. Selectors combine by AND where more than one is present: `refs` (exact), `focus`, `entities`. `all` means "everything that was shown": the offer stored from the previous optimize turn, intersected with the currently valid proposals (re-validated live; any that no longer match are skipped with a reason).
4. A writer-emitted call survives only if it targets an entity in the resolved scope **and** its tool's focus is in the brief's focus (or matches an offered proposal). Anything else is skipped: "not what you asked for".
5. `resume_campaign`, `create_adset`, `create_ad`, `create_campaign` from optimization turns are never selected unless the operator named them (focus `reactivation` / `structure` or an explicit ref).
6. The previous turn's offer is stored on the task (`agent_state.optimize_offer`: ref, tool, args, focus, entity ids, created_at) and loaded from the conversation's most recent task that has one. No DB migration (`tasks.agent_state` is jsonb).
7. The reply gets a code-written block: "Queued in Approvals (n): …" and "Not queued (m): … reason". `stripFalseQueuedClaims` stays as a second guard.

Create flows (`create_campaign`, ad copy, creatives) keep their existing explicit-request behaviour; the gate in (1) is applied by intent, not by removing those flows.

### D6. New execute tools (all `account_id` + ad set, all Approvals-gated)

| Tool | Args | Behaviour |
|---|---|---|
| `update_adset_placements` | `adset_id`, then either `advantage_placements: true` (clear manual placements) or `publisher_platforms` plus optional per-platform position arrays, optional `device_platforms` | Read ad set + full `targeting`; replace **only** the placement keys; POST the whole targeting object; read back and verify the placement keys. At least one platform must remain; deprecated `video_feeds` dropped; positions must belong to a chosen platform. |
| `update_adset_audience_exclusions` | `adset_id`, `add_excluded_custom_audiences?`, `remove_excluded_custom_audiences?` (ids) | Read targeting; validate ids exist among the account's custom audiences; change only `excluded_custom_audiences`; POST whole targeting; verify. |
| `update_adset_bid` | `adset_id`, `bid_strategy` (existing enum), `bid_amount?` (major units), `roas_average_floor?` | Refuses CBO campaigns, lifetime-budget ad sets are allowed; min-ROAS only for Sales ad sets already optimising for VALUE; cap strategies need `bid_amount`; reuses the create path's cap/ROAS conversion; verifies read-back. Risk text notes the learning phase restarts. |
| `update_adset_schedule` | `adset_id`, `end_time?` (ISO, future), `clear_end_time?`, `start_time?` | `clear_end_time` refused for lifetime-budget ad sets; `start_time` only before the ad set has started; verifies read-back. |

Wiring for each (a shared checklist the plan expands): zod schema + `EXECUTE_TOOL_SCHEMAS`, `TOOL_POLICY`, registry entry, `validate-args` canonicalisation (ad set id alias) and arg guards, `MetaAdsProvider` method + `MetaGraphProviderV2` + `MockMetaAdsProvider`, `dispatchToProvider` and proof fields in `buildExecutionResult`, `live-state` (`tracksLiveState`, entity state superset for ad sets, per-tool drift), `risk`, `change-log` before/after for the new fields, `rollback.inverseOf`, `display-labels`, approval card rows and success text, capability map entries, tests.

Risk levels *(call)*: placements and exclusions `medium` (can shrink delivery; no extra spend); bid changes `medium`, `high` when moving from a capped strategy to uncapped (can raise spend); schedule `low` when ending earlier, `medium` when extending or clearing an end time (more days of spend).

### D7. New read tool `meta_account_health`

Diagnose class, on the writer allowlist: `{ since?, until?, days?, campaign_ids? }` → the audit snapshot and checkpoint scorecard for the period (tracking, structure, bidding, audiences, creative, funnel), with the owner tag on each failing/warning checkpoint. Account id comes from the client's mapping (never from the model), like `meta_insights`. The three `optimize_meta_*` / `detect_meta_creative_fatigue` tools join the allowlist with `since/until` accepted.

## Left to the builder

File-level structure inside the modules above, exact zod shapes, test fixtures, the focus keyword lists for the rules fallback, wording of the capability notes, and approval-card row layout, as long as the decisions above hold.

## Verification

- Unit tests for every module above; the existing suite stays green; `npx tsc --noEmit` clean.
- A phrasing eval (`tests/request-brief-eval.test.ts`): ≥ 30 realistic optimization messages (typos, shorthand, named campaigns, explicit periods, "queue #2", "queue the budget ones", "apply all of these", "don't touch X") with expected brief fields, run through the rules fallback and, with a stubbed model, through the model path.
- Queue-selection tests assert the anti-goal directly: for each phrasing, exactly the expected approvals are created and no others.
- Fake-Graph tests for the four new provider methods assert the exact POST bodies (placement keys replaced, everything else in `targeting` preserved), verification failure on mismatched read-back, CBO/lifetime refusals, and that nothing is posted on refusal.
- **Not verified here**: the four new write tools against live Meta Graph. Before first use on a real account, run each once on a PAUSED ad set in a test ad account and confirm in Ads Manager. This is stated in the hand-off.
