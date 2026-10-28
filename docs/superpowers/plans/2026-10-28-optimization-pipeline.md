# Optimization Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make workspace optimization answers live, scoped to what the operator asked, labelled with who can do each step, and make "queue to Approvals" queue only what the operator asked for; add four new in-app ad set actions.

**Architecture:** A validated *request brief* (intent, act-vs-analyse, focus, scope, period, queue selection) replaces the one-word intent. Optimization evidence is built per brief from live Meta data and produces numbered proposals; a code-side queue selector picks exactly the requested proposals; a capability map is the single source of truth for what the app can do and who does the rest. Four new execute tools reuse the existing Approvals gate, live-state drift check, change log and rollback.

**Tech Stack:** Next.js 16 (modified; no route changes here), TypeScript, zod, Vitest (`npx vitest run`), AI SDK v7 (`generateText`/`streamText`), Meta Graph via `src/lib/meta/graph-client.ts`.

**Spec:** `docs/superpowers/specs/2026-10-28-optimization-pipeline-design.md` (decisions D1–D7 are binding; "call" marks my choices)

## Global Constraints

- Every change to Meta goes through Approvals; policy fails closed for unknown tools; the executor re-validates args and re-reads live state before writing.
- Brief `period` is computed by code; when none is stated: inherit the conversation's period, else the **last 7 completed days** with `explicit: false`.
- An unmatched named campaign / ad set / ad is reported; scope is **never** widened to the account.
- `mode` is `act` only when the operator asks to change, queue, apply, send, pause, resume, set, exclude or similar. Nothing is queued unless `mode === "act"` and `queue.requested`.
- Refs: proposals are numbered `#1..#n` (focus order, then spend at stake descending). Queue keeps a proposal only when its canonical args are identical in the fresh live build.
- New tools: `update_adset_placements`, `update_adset_audience_exclusions`, `update_adset_bid`, `update_adset_schedule`. CBO campaigns are refused for bid changes ("Ads Manager" owner). Every provider write reads back and verifies; every refusal says "Nothing was changed."
- Risk: placements and exclusions `medium`; bid `medium`, `high` when moving from a capped strategy to uncapped; schedule `low` when ending earlier, `medium` when extending or clearing the end time.
- Vendor names (Adspirer, Graph API, MCP, OpenAI, Anthropic) never appear in operator-facing text, including step labels.
- Tests: Vitest, files in `tests/*.test.ts`, run with `npx vitest run <file>`. Baseline on this branch: 141 files, 1776 tests pass; `npx tsc --noEmit` clean. Both must stay green.
- Working tree files are CRLF (git normalises). Edit with `Edit`; never rewrite a whole existing file.
- Do not commit unless the user asks (harness rule). Task "commit" steps are therefore **omitted**; leave changes in the working tree on branch `optimization-pipeline`.

## Review Focus

1. Operator names a campaign that doesn't exist: reply says so, no proposals, no account-wide fallback. (Task 5)
2. "Queue these" / "apply all" with no earlier offer in the conversation: nothing queued, reply says why. (Task 6)
3. Live state changed between "shown" and "queue": that proposal is skipped with was/now, never applied from stale numbers. (Task 6)
4. Classifier returns bad JSON, times out, or cites a ref beyond the offered count: rules brief takes over; out-of-range refs are skipped, never guessed. (Tasks 2, 6)
5. Operator sends the same queue message twice: no duplicate approvals. (Task 6)
6. Account with no ad sets, zero results, or a campaign under CBO: sections degrade to a plain statement, no crash, no invented proposal. (Tasks 5, 9)
7. Meta accepts a write but reads back different: tool fails with a verification error, the approval records failure. (Tasks 8–11)

## File Structure

Create:
- `src/lib/agent/request-brief.ts` — brief types, rules fallback, reply parsing, period/scope inheritance.
- `src/lib/agent/optimization-capabilities.ts` — capability + owner map, `ownerForCheckpoint`, `focusesOfTool`, prompt block.
- `src/lib/agent/optimize-evidence.ts` — demand-driven live evidence, numbered proposals, who-does-what appendix.
- `src/lib/agent/optimize-offer.ts` — `OptimizeOffer` type, persist to / load from tasks.
- `src/lib/agent/queue-selection.ts` — `selectForQueue`, queue decision block.
- `src/lib/meta/adset-edits.ts` — pure helpers for the four edit tools (no network).
- `src/lib/tools/diagnose/health-tool.ts` — `meta_account_health`.
- Tests: `request-brief.test.ts`, `request-brief-eval.test.ts`, `optimization-capabilities.test.ts`, `optimize-evidence.test.ts`, `queue-selection.test.ts`, `optimize-queue-flow.test.ts`, `adset-edits.test.ts`, `adset-edit-tools.test.ts`, `meta-adset-edit-provider.test.ts`, `meta-account-health.test.ts` (all under `tests/`).

Modify: `intent-classifier.ts`, `task-plan.ts`, `task-runner.ts`, `adspirer-agent.ts`, `optimize-proposals.ts`, `optimize-queue.ts`, `diagnose-tools-ai.ts`, `prompts.ts`, `prompts-v2.ts`, `audit/render.ts`, `tools/policy.ts`, `tools/display-labels.ts`, `tools/execute/schemas.ts`, `tools/execute/index.ts`, `tools/diagnose/index.ts`, `adspirer/provider.ts`, `meta/provider-v2.ts`, `adspirer/mock-provider.ts`, `approvals/executor.ts`, `approvals/validate-args.ts`, `approvals/live-state.ts`, `approvals/risk.ts`, `changes/change-log.ts`, `changes/rollback.ts`, `components/approvals/approval-card.tsx`.

---

### Task 1: Capability and owner map

**Files:**
- Create: `src/lib/agent/optimization-capabilities.ts`
- Test: `tests/optimization-capabilities.test.ts`

**Interfaces:**
- Produces:
  - `type Focus = "budget"|"bids"|"placements"|"audiences"|"creative"|"schedule"|"tracking"|"structure"|"reactivation"|"landing_page"` and `FOCUS_AREAS: readonly Focus[]` (exported here; Task 2 imports them).
  - `type ActionOwner = "app"|"ads_manager"|"developer"|"landing_page"|"client"`.
  - `type Capability = { id: string; label: string; focus: Focus; owner: ActionOwner; tool?: string; note: string }`.
  - `CAPABILITIES: readonly Capability[]`; `focusesOfTool(tool: string): Focus[]`; `ownerForCheckpoint(id: string): { owner: ActionOwner; capabilityId: string }`; `ownerLabel(owner: ActionOwner): string` (`"this app"`, `"someone in Ads Manager"`, `"a developer"`, `"the landing page owner"`, `"the client"`); `capabilityPromptBlock(): string`.

- [ ] **Step 1: Write failing tests.**
  - `every app capability names an execute tool that exists in the policy` — for each capability with `owner === "app"` and a `tool`, `classify(tool) === "execute"`.
  - `every execute tool in the policy has a capability` — for each name in `listClassifiedTools()` with safety `execute`, some capability has that `tool`. (New tools are added in Tasks 8–11, together with their capability entries.)
  - `every checkpoint id in checkpoints.ts maps to an owner` — read `src/lib/audit/checkpoints.ts` with `fs`, collect every `id: "X\d+"` literal, assert `ownerForCheckpoint(id)` returns a value for each (T1–T10 and S/B/A/C/F codes), and that `T1`→`developer`, `B1`→ an owner other than `landing_page`, a landing-page-quality checkpoint (find which id covers landing pages) → `landing_page`.
  - `focusesOfTool maps tools` — `update_adset_budget`→`["budget"]`, `pause_adset`→`["budget"]`, `pause_ad`→`["creative"]`, `create_ad`→`["creative","structure"]`, `create_adset`→`["structure"]`, `resume_campaign`→`["reactivation"]`, `resume_adset`→`["reactivation"]`, `unknown_tool`→`[]`.
  - `prompt block states what the app cannot do` — `capabilityPromptBlock()` contains "developer", "landing page", and the tool name `update_adset_budget`, and does not contain "Adspirer".
- [ ] **Step 2: Run** `npx vitest run tests/optimization-capabilities.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement the module.** Entries: budget (`update_adset_budget`, `update_campaign_budget`), pause/resume ad set / ad / campaign, new ad set / ad / campaign (`create_adset`, `create_ad`, `create_meta_image_campaign`, `create_meta_video_campaign`, `create_campaign`), generate ad copy and images (app, no execute tool — omit `tool`), pixel / Conversions API / event deduplication / customer-information parameters (`developer`), page speed / message match / form friction (`landing_page`), CBO bid strategy, attribution window on an existing ad set, domain verification (`ads_manager`), budget targets and offer decisions (`client`). `ownerForCheckpoint` is an exhaustive `Record<string, string>` id → capability id plus a safe default of `ads_manager` for unknown ids is **not** allowed (throw) so the checkpoint test is meaningful.
- [ ] **Step 4: Run the test** — expect PASS. Also run `npx tsc --noEmit`.

---

### Task 2: Request brief (types, rules fallback, reply parsing)

**Files:**
- Create: `src/lib/agent/request-brief.ts`
- Test: `tests/request-brief.test.ts`

**Interfaces:**
- Consumes: `Focus`, `FOCUS_AREAS` (Task 1); `detectRequestIntentWithHistory`, `RequestIntent` (`task-plan.ts`); `parseDateRangeFromText`, `completedDaysRange` (`audit-brief.ts`); `wantsQueueApprovals` (`optimize-queue.ts`); `AgentHistoryMessage`.
- Produces:
  ```ts
  type RequestBrief = {
    intent: RequestIntent; mode: "analyse" | "act"; focus: Focus[];
    scope: { mentions: string[] };
    period: { since: string; until: string; label: string; explicit: boolean } | null;
    queue: { requested: boolean; all: boolean; refs: number[]; focus: Focus[]; entities: string[] };
    optimizationAsk: boolean; source: "model" | "rules";
  };
  rulesBrief(request: string, history: AgentHistoryMessage[], now?: Date): RequestBrief
  parseBriefReply(reply: string, request: string, history: AgentHistoryMessage[], now?: Date): RequestBrief | null
  resolvePeriod(request: string, history: AgentHistoryMessage[], now?: Date): NonNullable<RequestBrief["period"]>
  ```
  `period` is `null` only for intents that need none (`chat`, `out_of_scope`, `copy_approved`).

- [ ] **Step 1: Write failing tests** (fixed `now = new Date("2026-10-28T10:00:00Z")`):
  - `period: stated range is explicit` — `resolvePeriod("optimize campaign X for 1 Oct to 15 Oct", [], now)` → `{since:"2026-10-01", until:"2026-10-15", explicit:true}`.
  - `period: default is last 7 completed days` — `resolvePeriod("optimize my ads", [], now)` → `{since:"2026-10-21", until:"2026-10-27", explicit:false}`.
  - `period: inherits from earlier user message` — history has user "audit last 30 days" then assistant text; `resolvePeriod("what should I optimise?", history, now)` → 30 days ending 2026-10-27, `explicit:false`.
  - `rules: question is analyse` — `rulesBrief("how can I optimise my budget?", [], now)` → `mode "analyse"`, `focus ["budget"]`, `optimizationAsk true`, `queue.requested false`.
  - `rules: queue by ref` — after an assistant message containing "#1" and "#2", `rulesBrief("queue #2 and #3", history, now)` → `mode "act"`, `queue {requested:true, all:false, refs:[2,3]}`.
  - `rules: queue all` — "apply all of these" → `queue.all true`, `refs []`.
  - `rules: queue by focus` — "queue the budget changes" → `queue.focus ["budget"]`, `all false`.
  - `rules: named entity` — `rulesBrief('pause the "Retargeting – AU" ad set', [], now)` → `scope.mentions ["Retargeting – AU"]`, `mode "act"`.
  - `parseBriefReply accepts valid JSON` — `{"intent":"optimize","mode":"analyse","focus":["placements"],"scope":[],"periodStated":false,"optimizationAsk":true,"queue":{"requested":false,"all":false,"refs":[],"focus":[],"entities":[]}}` → brief with `source "model"` and code-computed period.
  - `parseBriefReply rejects` — returns `null` for non-JSON, unknown intent, unknown focus value, refs that are not positive integers, and `mode "act"` with `queue.requested false` on an `optimize` intent is **normalised** to `analyse`.
  - `model cannot invent dates` — extra `period` key in the reply is ignored.
- [ ] **Step 2: Run** `npx vitest run tests/request-brief.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Rules: focus keyword lists per `Focus` (budget: budget|spend|bid up/down|scale|trim; bids: bid|cap|cost cap|roas floor; placements: placement|reels|stories|audience network|feed; audiences: audience|exclu|overlap|lookalike; creative: creative|ad copy|fatigue|refresh ad; schedule: schedule|end date|start date|dayparting; tracking: pixel|capi|conversions api|tracking|events; structure: ad set|structure|consolidat|broad; reactivation: reactivate|resume|turn back on; landing_page: landing|page speed). `mode = "act"` when `wantsQueueApprovals(request)` or the message starts with / contains an imperative (`pause|resume|set|change|raise|lower|increase|decrease|exclude|remove|apply|queue|send`) applied to an entity. `optimizationAsk` true for `optimi[sz]`, "next steps", "what should i fix", etc. Entity mentions: text in quotes, `act_`/long numeric ids, and names matched later (rules only extract quoted/ids). Scope mentions from the model are trusted as strings only.
- [ ] **Step 4: Run the tests** — PASS; `npx tsc --noEmit`.

---

### Task 3: Classifier returns the brief; task runner uses it

**Files:**
- Modify: `src/lib/agent/intent-classifier.ts`, `src/lib/agent/task-runner.ts:239-480`, `src/lib/agent/task-plan.ts` (labels)
- Test: `tests/request-brief.test.ts` (extend), `tests/intent-classifier.test.ts` (existing must pass)

**Interfaces:**
- Consumes: `parseBriefReply`, `rulesBrief` (Task 2).
- Produces: `classifyRequest(request: string, history?: AgentHistoryMessage[], now?: Date): Promise<RequestBrief>` in `intent-classifier.ts`; `classifyIntent` kept and returns `(await classifyRequest(...)).intent`. Task runner holds `const brief = await classifyRequest(request, history)` and `const intent = brief.intent`.

- [ ] **Step 1: Failing tests** (`vi.mock("ai")` pattern from `tests/intent-classifier.test.ts`):
  - `classifyRequest returns the model brief` — stubbed `generateText` returns valid brief JSON → `source "model"`.
  - `classifyRequest falls back to rules on invalid JSON / thrown error / abort` — three cases → `source "rules"`, no throw.
  - `classifyRequest asks the model for the JSON shape` — the system prompt passed to `generateText` mentions `mode`, `focus`, `queue`, and `maxOutputTokens` is ≥ 300; timeout is 8000 ms.
  - `followup with optimizationAsk is re-routed` — a pure function `normalizeBrief(brief)` in `request-brief.ts` turns `{intent:"followup", optimizationAsk:true}` into `{intent:"optimize", mode:"analyse"}` and leaves `followup` without `optimizationAsk` unchanged. Test both.
- [ ] **Step 2: Run** the two test files — new tests FAIL.
- [ ] **Step 3: Implement.** Extend `SYSTEM` in `intent-classifier.ts` to request the JSON shape (field list from Task 2, `periodStated` boolean instead of dates, `scope` as an array of strings quoted from the message, ref numbers from `#n` in the last assistant message). Keep `buildClassifierPrompt`, `parseIntentReply`, `INTENT_GUIDE` exports. In `task-runner.ts` replace `classifyIntent(...)` with `classifyRequest(...)`, apply `normalizeBrief`, replace the `queueApprovalsTurn`/`wantsQueueApprovals` uses with `brief.queue.requested` (the later queue step is rewritten in Task 6; here only wire `brief` through and keep behaviour). Pass `brief` into `gatherDiagnoseEvidence` and `runAdspirerAgent` inputs (add optional `brief?: RequestBrief` to both input types). In `task-plan.ts` change the optimize step labels: `"Run Adspirer optimize tools"` → `"Review live budgets, creative and tracking"`, `"Operator picks ad"` → `"Pick an ad (creative refresh only)"`.
- [ ] **Step 4: Run** `npx vitest run tests/request-brief.test.ts tests/intent-classifier.test.ts tests/audit-followup-intent.test.ts tests/chat-turn-speed.test.ts` — PASS; `npx tsc --noEmit`.

---

### Task 4: Provider reads accept a period and scope

**Files:**
- Modify: `src/lib/adspirer/provider.ts` (interface at 423-444), `src/lib/meta/provider-v2.ts:1944` (`optimizeBudget`), `:2265` (`detectCreativeFatigue`), `src/lib/adspirer/mock-provider.ts`, `src/lib/tools/diagnose/index.ts` (the three optimize tools' schemas)
- Test: `tests/optimize-hold.test.ts` and `tests/optimize-proposals.test.ts` (existing must pass); new cases in `tests/optimize-evidence.test.ts`

**Interfaces:**
- Produces: options `{ since?: string; until?: string; campaign_ids?: string[]; adset_ids?: string[]; ad_ids?: string[] }` on `optimizeBudget(accountId, options)` and `detectCreativeFatigue(accountId, options)`, passed through `Record<string, unknown>` today. `since/until` (YYYY-MM-DD) take precedence over `lookback_days`; id filters restrict which ad sets / campaigns / ads are ranked and proposed.

- [ ] **Step 1: Failing tests** with a fake graph (follow the harness in `tests/meta-provider-mutations.test.ts` for constructing `MetaGraphProviderV2` over a fake `graph`):
  - `optimizeBudget uses the given period` — assert the insights request carries `time_range {since, until}` equal to the options, and the output heading shows those dates.
  - `optimizeBudget restricts to campaign_ids` — ad sets of other campaigns neither ranked nor proposed.
  - `detectCreativeFatigue anchors on until` — the "now" window is the 7 days ending `until` and "before" the 7 before; ads outside `ad_ids` are ignored.
  - `defaults unchanged` — with no options the existing 7-day / 7v7 behaviour and request shape is identical (existing tests prove this).
- [ ] **Step 2: Run** `npx vitest run tests/optimize-evidence.test.ts tests/optimize-hold.test.ts tests/optimize-proposals.test.ts` — new tests FAIL.
- [ ] **Step 3: Implement** the option handling in `provider-v2.ts` (reuse `lookbackWindow`; add a `windowFromOptions` helper). Fatigue keeps the weekly rule: `time_range` windows replace the `date_preset` calls when `until` is given. Update the diagnose tool schemas to accept `since`, `until`, `campaign_ids`, `adset_ids`, `ad_ids` and forward them. Mirror in `mock-provider.ts` (filter by ids; echo the dates).
- [ ] **Step 4: Run** the three files — PASS; `npx tsc --noEmit`.

---

### Task 5: Demand-driven live evidence, numbered proposals, who-does-what appendix

**Files:**
- Create: `src/lib/agent/optimize-evidence.ts`
- Modify: `src/lib/agent/adspirer-agent.ts:3442-3602` (optimize block of `gatherDiagnoseEvidence`), `src/lib/agent/optimize-proposals.ts` (keep helpers; `buildFullOptimizeProposals` is split by focus), `src/lib/audit/render.ts:491` (owner tags)
- Test: `tests/optimize-evidence.test.ts`

**Interfaces:**
- Consumes: `RequestBrief`, `Focus`, capability map (`ownerForCheckpoint`, `focusesOfTool`, `ownerLabel`); provider read methods from Task 4; `matchCampaignsByHints` from `audit-brief.ts`.
- Produces:
  ```ts
  type OfferedProposal = { ref: number; tool: string; args: Record<string, unknown>; rationale?: string;
    focus: Focus; entityIds: string[]; label: string; spendAtStakeCents: number | null };
  type OptimizeEvidence = { sections: string[]; offered: OfferedProposal[]; scopeEntityIds: string[] | null;
    unresolvedMentions: string[]; appendix: string };
  buildOptimizeEvidence(input: { provider: MetaAdsProvider; accountId: string; brief: RequestBrief;
    currency: string | null; goals: ResolvedGoals; fallbackLandingUrl?: string | null }): Promise<OptimizeEvidence>
  ```
  `scopeEntityIds` is `null` for whole account, else the ids of every resolved campaign + its ad sets + ads.

- [ ] **Step 1: Failing tests** using `MockMetaAdsProvider` (demo client `client_modern_dental`, account `act_100200300`):
  - `focus budget fetches only budget evidence` — spy on `detectCreativeFatigue`, `getAdCreatives`, `getAuditSnapshot`: none called; proposals only `update_*_budget`/`pause_adset`.
  - `no focus builds the core set` — budget + creative + tracking evidence; no reactivation, no new ad set, no ad picker data.
  - `reactivation and structure only when asked` — `focus ["reactivation"]` yields a `resume_campaign` proposal when a paused campaign has results; `focus ["structure"]` yields the broad ad set proposal; neither appears for `focus ["budget"]`.
  - `period reaches the provider` — `getAuditSnapshot` receives `since/until` from `brief.period`, not `{days:14}`; `optimizeBudget` receives the same dates.
  - `scope: named campaign narrows` — `scope.mentions ["<a real mock campaign name>"]` → `scopeEntityIds` contains only that campaign tree and proposals target only it.
  - `scope: unknown name is not widened` — mention "Nonexistent Campaign" → `unresolvedMentions ["Nonexistent Campaign"]`, `offered` empty, a section saying it wasn't found with the closest names listed, `scopeEntityIds` is an empty array (not `null`).
  - `refs are stable and 1-based` — proposals ordered by focus order then `spendAtStakeCents` desc; refs `1..n`; same input twice → same refs.
  - `appendix tags owners` — appendix markdown has a row per offered proposal with its ref, label, owner "this app" and tool; and a row per failing/warning checkpoint (from the scorecard) with the owner from `ownerForCheckpoint` (a T-code row says "a developer"); contains no "Adspirer".
  - `held increases still held` — a budget increase on an ad set with silent tracking is not offered and is listed as held (reuse `holdIncreasesOnSilentTracking`).
  - `empty account` — provider with no ad sets/campaigns → sections state "nothing to optimise in this scope", `offered` empty, no throw.
- [ ] **Step 2: Run** `npx vitest run tests/optimize-evidence.test.ts` — FAIL.
- [ ] **Step 3: Implement `buildOptimizeEvidence`** per spec D2. Resolve scope first (campaigns via `matchCampaignsByHints`; ad sets and ads by exact id or case-insensitive name contains; collect child ids). Focus → sections as in D2 (the placements section is added in Task 12; here `placements` yields breakdown evidence only through the writer's `meta_insights` tool, so the section says so). Reuse `proposalsFromOptimizeStructured`, `mergeExecuteProposals`, `holdIncreasesOnSilentTracking`, `renderOptimisationSignals(evaluateCheckpoints(snapshot, {goals}))` (snapshot built with `{since, until}`). Number refs after the merge. Appendix: markdown table `| # | Step | Evidence | Who does it | In-app action |`.
- [ ] **Step 4: Replace the optimize block in `gatherDiagnoseEvidence`** (`adspirer-agent.ts:3442`): call `buildOptimizeEvidence`, push `sections`, set the return value's `offered`, `scopeEntityIds`, `optimizeAppendix`; keep the ad picker only when `brief.focus` includes `"creative"` and no ad id/name was named. Remove `executeProposals` from the return type and its uses (Task 6 consumes `offered`). Add `owner` to each line in `renderOptimisationSignals` via `ownerForCheckpoint`.
- [ ] **Step 5: Run** `npx vitest run tests/optimize-evidence.test.ts tests/optimize-proposals.test.ts tests/optimize-hold.test.ts tests/audit-checkpoints.test.ts` — PASS (update `audit-checkpoints` expectations only for the added owner text); `npx tsc --noEmit`.

---

### Task 6: Queue selection, offer persistence, honest queued/not-queued block

**Files:**
- Create: `src/lib/agent/queue-selection.ts`, `src/lib/agent/optimize-offer.ts`
- Modify: `src/lib/agent/task-runner.ts:853-1056` (the queue step), `src/lib/agent/optimize-queue.ts` (remove `wantsQueueApprovals` use from the runner; keep the export for the rules brief), `src/lib/agent/adspirer-agent.ts` (evidence "Queue decision" section)
- Test: `tests/queue-selection.test.ts`, `tests/optimize-queue-flow.test.ts`

**Interfaces:**
- Consumes: `RequestBrief`, `OfferedProposal`, `focusesOfTool`, `AgentToolCallProposal`.
- Produces:
  ```ts
  type QueueDecision = { queue: AgentToolCallProposal[]; skipped: Array<{ label: string; reason: string }>;
    queuedRefs: number[] };
  selectForQueue(input: { brief: RequestBrief; offered: OfferedProposal[]; previousOffer: OfferedProposal[] | null;
    writerCalls: AgentToolCallProposal[]; namedEntityIds: string[] }): QueueDecision
  renderQueueBlock(decision: QueueDecision, queuedLabels: string[]): string
  saveOptimizeOffer(task: Task, offered: OfferedProposal[]): void          // sets task.agent_state.optimize_offer
  loadLastOptimizeOffer(conversationId: string | null | undefined, excludeTaskId?: string): Promise<OfferedProposal[] | null>
  ```
  `namedEntityIds` = ids resolved from `brief.queue.entities` (empty when none named).

- [ ] **Step 1: Failing tests for `selectForQueue`** (pure; fixture offer: #1 `update_adset_budget` adset A budget, #2 `update_adset_budget` adset B budget, #3 `pause_ad` ad X creative, #4 `resume_campaign` reactivation):
  - `analyse mode queues nothing` — `mode "analyse"` → `queue []`, even if `writerCalls` contains `update_adset_budget`; skipped reasons mention it was not requested.
  - `act without queue.requested queues nothing`.
  - `refs select exactly` — `queue {requested:true, refs:[2]}` with `previousOffer` = fixture and fresh `offered` = fixture → only #2.
  - `ref out of range is skipped` — `refs:[9]` → nothing queued, skipped reason "no proposal #9".
  - `focus selects` — `queue.focus ["budget"]` → #1 and #2, never #3 or #4.
  - `all means the previous offer` — `queue.all` → #1–#3 only if fresh offer still has them; `#4` (resume) included only if it was in `previousOffer`; items in `previousOffer` but absent from fresh `offered` are skipped "no longer applies".
  - `all with no previous offer` — nothing queued; one skipped entry "no earlier list to queue from".
  - `changed args are skipped` — same tool and entity but different `daily_budget_cents` in fresh offer → skipped with "changed since it was shown".
  - `no selectors on the optimize-and-queue turn` — `queue {requested:true, all:false, refs:[], focus:[], entities:[]}` with `brief.focus ["budget"]` → this turn's offered items whose focus ∈ `brief.focus` only.
  - `writer call survives only for a named entity` — `writerCalls [pause_adset on adset C]`, `namedEntityIds ["C"]`, `brief.focus []` → queued; same call with `namedEntityIds []` → skipped "not something you asked for"; same call with `brief.focus ["creative"]` and `namedEntityIds ["C"]` → skipped (focus mismatch).
  - `duplicates collapse` — identical tool+args from offer and writer produce one entry.
  - `idempotent` — running the selection twice gives deep-equal decisions.
- [ ] **Step 2: Failing tests for the flow** (`optimize-queue-flow.test.ts`, demo mode, `runTask` with the stubbed writer pattern used in `tests/chat-status-honesty.test.ts`): (a) "optimize my budget" creates **zero** approvals and the reply carries refs; (b) the next turn "queue #1" creates exactly one approval whose tool/args equal proposal #1 and the reply contains a code-written "Queued in Approvals (1)" block; (c) "queue the budget changes" never creates `resume_campaign` / `create_adset`; (d) sending (b) twice yields one approval (idempotency key reuse) and no error; (e) "queue all of these" after an offer of N items queues N; (f) a writer reply that claims "queued" when nothing was selected has that claim stripped (existing `stripFalseQueuedClaims`) and the block says "Queued in Approvals (0)".
- [ ] **Step 3: Run** both files — FAIL.
- [ ] **Step 4: Implement `queue-selection.ts`** exactly per spec D5 (rules 1–7; focus matching via `focusesOfTool`; canonical args = `canonicalJson` from `approvals/service.ts` minus keys starting with `_`, `rationale`). `renderQueueBlock` produces: `### Queued in Approvals (n)` with one line per queued label, then `### Not queued (m)` with label — reason lines; omitted entirely when both are empty. `optimize-offer.ts`: `saveOptimizeOffer` stores `{ created_at, items }`; `loadLastOptimizeOffer` reads the conversation's most recent tasks (demo store or `tasks` table by `conversation_id`, newest first, limit 10) and returns the first non-empty `agent_state.optimize_offer.items` of a task other than `excludeTaskId`.
- [ ] **Step 5: Wire the task runner.** Before the writer runs: load `previousOffer`; resolve `namedEntityIds` from `brief.queue.entities` (ids or names against the live ad sets / campaigns / ads the evidence already loaded — expose them from `gatherDiagnoseEvidence`'s return as `entityIndex: Array<{ id: string; name: string; type: "campaign"|"adset"|"ad" }>`); compute a first `QueueDecision` from `gathered.offered` and add a "### Queue decision" evidence section (refs queued, refs held, reasons) so the writer's prose is accurate. After the writer: recompute the decision including `agentResult.toolCalls`; for intents other than `create_campaign` replace the execute-call loop's input with `decision.queue`; for `create_campaign` keep today's pass-through. Append `renderQueueBlock` to `approvalSummary`; call `saveOptimizeOffer(task, gathered.offered)` whenever `gathered.offered.length`. Delete the `mergeExecuteProposals(agentResult.toolCalls, gathered.executeProposals)` block and the "Could not queue Approvals — live Meta optimize analysis did not produce…" branch (replaced by the block).
- [ ] **Step 6: Run** `npx vitest run tests/queue-selection.test.ts tests/optimize-queue-flow.test.ts tests/approvals.test.ts tests/chat-status-honesty.test.ts tests/campaign-build-intent.test.ts` — PASS; `npx tsc --noEmit`.

---

### Task 7: Read tools, writer rules and prompts

**Files:**
- Create: `src/lib/tools/diagnose/health-tool.ts`
- Modify: `src/lib/tools/diagnose/index.ts` (import), `src/lib/tools/policy.ts` (add `meta_account_health: "diagnose"`), `src/lib/tools/display-labels.ts`, `src/lib/agent/diagnose-tools-ai.ts:17` (allowlist), `src/lib/agent/adspirer-agent.ts` (`optimizeRules`, `followup` rules, system prompt), `src/lib/agent/prompts.ts`, `src/lib/agent/prompts-v2.ts`
- Test: `tests/meta-account-health.test.ts`, `tests/builder-prompt.test.ts` (existing must pass), `tests/workspace-data-tools.test.ts` (existing)

**Interfaces:**
- Consumes: `capabilityPromptBlock()`, `ownerForCheckpoint`, `getAuditSnapshot`, `evaluateCheckpoints`.
- Produces: tool `meta_account_health` with input `{ since?: ISO date, until?: ISO date, days?: int 1–90, campaign_ids?: string[] }` returning `{ source:"Meta", period:{since,until}, score, grade, coverage, priorities:[{id,category,title,status,severity,evidence,fix,owner}] }` or `{ error:true, source:"Meta", message }`.

- [ ] **Step 1: Failing tests.**
  - `meta_account_health returns owner-tagged priorities` (mock provider) — a T-code priority has `owner "developer"`; `since/until` echoed.
  - `meta_account_health reports not mapped` — client without account → `{error:true, not_mapped:true}`.
  - `allowlist contains the optimize reads and the health tool` — `workspaceReadToolNames()` includes `optimize_meta_budget`, `optimize_meta_placements`, `detect_meta_creative_fatigue`, `meta_account_health`.
  - `static system prompt` — contains the generated capability block text, contains no "Adspirer", and does **not** contain the old sentences "Use diagnose tools evidence: optimize_meta_budget…" and "ONLY mark items as Ready to queue if they appear in Ready-to-queue EXECUTE proposals JSON".
  - `optimize writer rules by mode` — `buildWriterMessages` (export it for test) with a `mode "analyse"` brief says "do not queue" and lists refs; with `mode "act"` says the queue decision section is authoritative and the model must not add or drop items; both say "state the period and scope used" and "do not repeat the who-does-what table".
- [ ] **Step 2: Run** the new tests — FAIL.
- [ ] **Step 3: Implement.** `health-tool.ts` mirrors `meta_insights` (account from `resolvePrimaryAccountId`, provider via `resolveProvider`, snapshot with `{since, until}` or `{days}`, `evaluateCheckpoints(snapshot, {goals})`). Allowlist additions in `diagnose-tools-ai.ts`. In `adspirer-agent.ts` rewrite `optimizeRules` and the follow-up rules per spec D4 (the follow-up "which can you do" line now defers to the generated block); thread `brief` into `WriterInput`. Replace the capability text in `prompts.ts` ("Hard safety rules" #2 list, Optimize section) and `prompts-v2.ts` ("Optimization gate") with the generated block; keep every safety rule.
- [ ] **Step 4: Run** `npx vitest run tests/meta-account-health.test.ts tests/builder-prompt.test.ts tests/workspace-data-tools.test.ts tests/strategy-writer.test.ts` — PASS; `npx tsc --noEmit`.

---

### Task 8: `update_adset_schedule` (establishes the wiring checklist)

**Files:**
- Create: `src/lib/meta/adset-edits.ts` (schedule helper first), `tests/adset-edits.test.ts`, `tests/adset-edit-tools.test.ts`, `tests/meta-adset-edit-provider.test.ts`
- Modify: every file in **Wiring checklist W**

**Wiring checklist W** (each later tool repeats every item; "T" = the tool):
1. `tools/execute/schemas.ts`: zod schema + entry in `EXECUTE_TOOL_SCHEMAS`.
2. `tools/policy.ts`: `T: "execute"`. `tools/execute/index.ts`: `registerTool` via `requireAndExecute`.
3. `approvals/validate-args.ts`: ad set id alias (`ad_set_id`→`adset_id`) in `canonicalize`; extend the "cannot be executed" help text.
4. `adspirer/provider.ts`: `MetaAdsProvider` method; `meta/provider-v2.ts`: implementation (read → guard → POST → read back → verify); `adspirer/mock-provider.ts`: stateful mock.
5. `approvals/executor.ts`: `dispatchToProvider` case; `buildExecutionResult` proof fields.
6. `approvals/live-state.ts`: `tracksLiveState`, `LiveState` fields, `readLiveState`/`getEntityState` superset, `describeDrift` for T.
7. `approvals/risk.ts`: `assessRisk` case. `changes/change-log.ts`: `ChangeState` fields, `buildChangeEntry` before/after. `changes/rollback.ts`: `inverseOf` case from the recorded before-state.
8. `tools/display-labels.ts`: label + progress label. `components/approvals/approval-card.tsx`: rows + success text.
9. `agent/optimization-capabilities.ts`: capability entry (owner `app`, `tool: T`).
10. Tests: schema accepts/rejects; approval queues with `__before`; execution calls the provider once with exact args; refusal paths post nothing; drift between propose and execute refuses; change log has before/after; rollback queues the inverse and executes; risk level per spec.

**Interfaces (this task):**
- Schema `updateAdsetScheduleSchema = z.object({ account_id, adset_id: z.string().min(1), end_time: isoDate.optional(), clear_end_time: z.boolean().optional(), start_time: isoDate.optional() }).refine(v => v.end_time || v.clear_end_time || v.start_time, "Provide end_time, clear_end_time or start_time")` and also reject `end_time` together with `clear_end_time`.
- Provider: `updateAdSetSchedule(input: { account_id?: string; adset_id: string; end_time?: string; clear_end_time?: boolean; start_time?: string }): Promise<MetaAdSet & { start_time?: string; end_time?: string | null; previous_end_time: string | null; verified: boolean; verification_error?: string }>`.
- `LiveState` gains `end_time?: string | null; start_time?: string | null`; `ChangeState` gains the same.
- Pure helper in `adset-edits.ts`: `planScheduleChange(current: { status: string; start_time?: string; end_time?: string | null; lifetime_budget: boolean }, input): { body: Record<string,string>; note?: string }` throwing `Error` with "Nothing was changed." text.

- [ ] **Step 1: Failing tests.**
  - `adset-edits.test.ts` — `planScheduleChange`: sets `end_time`; rejects past `end_time`; rejects `clear_end_time` when the ad set has a lifetime budget ("A lifetime budget needs an end date…"); rejects `start_time` when the ad set already started (`start_time` in the past and status ACTIVE or has spend); `clear_end_time` produces `end_time: "0"` (Meta's "no end" sentinel is passed as `end_time=0`; assert exactly this body) — **verify this sentinel in the Meta docs/reference before relying on it and note the doc link in a code comment; if it differs, change the body and this test together.**
  - `meta-adset-edit-provider.test.ts` — fake graph: happy path POSTs `{ end_time }` to the ad set id and returns `verified:true` when the read-back matches; read-back mismatch throws `ExecutionVerificationError`; read-back network failure returns `verified:false` with `verification_error` and does **not** throw; ad set in another account throws and posts nothing.
  - `adset-edit-tools.test.ts` (demo mode, mock provider, `client_modern_dental`, an ad set from the mock data): queue → `risk_level` `low` when `end_time` is earlier than the current end and `medium` when later or cleared; approve+execute updates the mock; change log entry has `before.end_time` and `after.end_time`; `rollbackChange` queues `update_adset_schedule` with the old end time and executes; drift (mock end time edited after proposal) makes execute throw `ApprovalValidationError`; `classify("update_adset_schedule") === "execute"`.
- [ ] **Step 2: Run** the three files — FAIL.
- [ ] **Step 3: Implement the checklist W items for this tool**, plus the capability entry `{ id: "schedule", focus: "schedule", owner: "app", tool: "update_adset_schedule" }`. Risk and change-log rules per Global Constraints. Approval card rows: Ad set, "End date: <old> → <new>" / "Runs continuously", "Start". Success text: "Ad set schedule updated in Meta."
- [ ] **Step 4: Run** `npx vitest run tests/adset-edits.test.ts tests/adset-edit-tools.test.ts tests/meta-adset-edit-provider.test.ts tests/optimization-capabilities.test.ts tests/approvals.test.ts tests/change-log.test.ts` — PASS; `npx tsc --noEmit`.

---

### Task 9: `update_adset_bid`

**Files:** `src/lib/meta/adset-edits.ts` (add `planBidChange`), the **Wiring checklist W** files, same three new test files extended.

**Interfaces:**
- Schema `updateAdsetBidSchema = z.object({ account_id, adset_id, bid_strategy: z.enum(BID_STRATEGIES), bid_amount: z.number().positive().optional(), roas_average_floor: z.number().positive().optional(), previous_bid_strategy: z.string().optional() })`; refine: `COST_CAP` and `LOWEST_COST_WITH_BID_CAP` require `bid_amount`; `LOWEST_COST_WITH_MIN_ROAS` requires `roas_average_floor`.
- Provider `updateAdSetBid(input: { account_id?: string; adset_id: string; bid_strategy: string; bid_amount?: number; roas_average_floor?: number }): Promise<MetaAdSet & { bid_strategy: string; bid_amount_cents: number | null; roas_average_floor: number | null; previous_bid_strategy: string | null; previous_bid_amount_cents: number | null; verified: boolean; verification_error?: string }>`.
- `LiveState` / `ChangeState` gain `bid_strategy?: string; bid_amount_cents?: number | null; roas_average_floor?: number | null`.
- `planBidChange(current: { cbo: boolean; objective?: string; optimization_goal?: string; bid_strategy?: string; bid_amount_minor?: string; currency: string }, input): { body: Record<string, string>; fromCapped: boolean; toUncapped: boolean }` — reuse the cap and ROAS conversion used by `bidPlan` (`centsToMetaMinor`, `roas_average_floor * 10_000`); extract a shared function from `provider-v2.ts:320 bidPlan` instead of duplicating.

- [ ] **Step 1: Failing tests.**
  - `planBidChange`: cost cap with `bid_amount: 30` on USD → body `{ bid_strategy:"COST_CAP", bid_amount:"3000" }`; min-ROAS 2.5 → `bid_constraints` JSON with `roas_average_floor: 25000`; min-ROAS refused when objective is not `OUTCOME_SALES` or goal is not `VALUE`; refused for CBO ("set on the campaign … Ads Manager"); `LOWEST_COST_WITHOUT_CAP` body has no `bid_amount`; `toUncapped` true when moving from `COST_CAP` to `LOWEST_COST_WITHOUT_CAP`.
  - Provider (fake graph): posts the exact body; verifies read-back strategy and amount; mismatch → `ExecutionVerificationError`; CBO ad set posts nothing.
  - Tool flow: queue risk `medium`, `high` for capped→uncapped; risk reason mentions the learning phase restarting; execute updates mock; change log before/after carry strategy and amount; rollback restores the previous strategy and amount; drift refuses; schema rejects a cap strategy with no amount.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** the checklist W items + capability `{ id: "bids", focus: "bids", owner: "app", tool: "update_adset_bid" }` and a second capability `{ id: "cbo_bids", focus: "bids", owner: "ads_manager", note: "Bid strategy for campaign-budget campaigns is set on the campaign in Ads Manager." }`. Card rows: Ad set, "Bid strategy: A → B", "Cap: …".
- [ ] **Step 4: Run** the three test files plus `tests/meta-provider-mutations.test.ts tests/approval-risk.test.ts tests/optimization-capabilities.test.ts` — PASS; `npx tsc --noEmit`.

---

### Task 10: `update_adset_placements` (read–modify–write of targeting)

**Files:** `src/lib/meta/adset-edits.ts` (add `mergePlacements`), the **Wiring checklist W** files, tests extended.

**Interfaces:**
- Schema `updateAdsetPlacementsSchema = z.object({ account_id, adset_id, advantage_placements: z.boolean().optional(), publisher_platforms: z.array(z.enum(["facebook","instagram","audience_network","messenger"])).min(1).optional(), facebook_positions: z.array(z.string()).optional(), instagram_positions: z.array(z.string()).optional(), audience_network_positions: z.array(z.string()).optional(), messenger_positions: z.array(z.string()).optional(), device_platforms: z.array(z.enum(["mobile","desktop"])).optional() })`; refine: exactly one of `advantage_placements: true` or `publisher_platforms` present; position arrays only for chosen platforms.
- Pure `mergePlacements(targeting: Record<string, unknown>, change: PlacementChange): { targeting: Record<string, unknown>; before: PlacementState; after: PlacementState }` where `PlacementState = { publisher_platforms: string[] | null; facebook_positions: string[] | null; instagram_positions: string[] | null; audience_network_positions: string[] | null; messenger_positions: string[] | null; device_platforms: string[] | null }` (`null` = Advantage+/automatic). Replaces **only** those six keys; every other key (geo_locations, ages, genders, flexible_spec, custom audiences, `targeting_automation`, anything unknown) is preserved byte-for-byte; `video_feeds` dropped from Facebook positions; defaults for a chosen platform without explicit positions come from the same default table the create path uses (export it from `targeting-builder.ts` as `DEFAULT_PLATFORM_POSITIONS` if not exported).
- Provider `updateAdSetPlacements(input: { account_id?: string; adset_id: string } & PlacementChange): Promise<MetaAdSet & { placements: PlacementState; previous_placements: PlacementState; verified: boolean; verification_error?: string }>`; POSTs `{ targeting: JSON.stringify(mergedTargeting) }` — the **whole** targeting object.
- `LiveState` / `ChangeState` gain `placements?: PlacementState`.

- [ ] **Step 1: Failing tests.**
  - `mergePlacements`: starting from a realistic targeting object (geo, age 25–55, genders, `flexible_spec`, `custom_audiences`, `excluded_custom_audiences`, `targeting_automation:{advantage_audience:1}`, Facebook + Instagram manual positions) removing `audience_network` leaves all non-placement keys deep-equal to the input; `advantage_placements:true` deletes all six keys; choosing `["instagram"]` removes stale `facebook_positions`; positions for a platform not chosen → throws; empty result → throws "At least one placement must remain"; `video_feeds` dropped.
  - Provider (fake graph): asserts the POST body is the whole merged targeting object as a JSON string; read-back with a different `publisher_platforms` → `ExecutionVerificationError`; read-back failure → `verified:false`; Meta error (e.g. targeting rejected) surfaces with "Nothing was changed."; ad set in another account posts nothing.
  - Tool flow: queue `medium`; execute updates the mock; `before`/`after` placements in the change log; rollback restores the previous placements (including `null` → Advantage+); drift (mock placements changed after proposal) refuses; two identical proposals dedupe.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** + capability `{ id: "placements", focus: "placements", owner: "app", tool: "update_adset_placements" }`. Card rows: Ad set, "Placements: <before> → <after>". Drift compares `placements` deep-equal (order-insensitive).
- [ ] **Step 4: Run** the three test files plus `tests/meta-targeting-builder.test.ts tests/optimization-capabilities.test.ts` — PASS; `npx tsc --noEmit`.

---

### Task 11: `update_adset_audience_exclusions`

**Files:** `src/lib/meta/adset-edits.ts` (add `mergeExclusions`), the **Wiring checklist W** files, tests extended.

**Interfaces:**
- Schema `updateAdsetAudienceExclusionsSchema = z.object({ account_id, adset_id, add_excluded_custom_audiences: z.array(z.string().min(1)).optional(), remove_excluded_custom_audiences: z.array(z.string().min(1)).optional() }).refine(v => (v.add_excluded_custom_audiences?.length ?? 0) + (v.remove_excluded_custom_audiences?.length ?? 0) > 0)`; reject ids present in both lists.
- Pure `mergeExclusions(targeting, { add, remove }): { targeting; before: string[]; after: string[] }` — changes only `excluded_custom_audiences` (array of `{id}`), preserves everything else; refuses to add an audience that is also in `custom_audiences` ("can't be both included and excluded").
- Provider `updateAdSetAudienceExclusions(input): Promise<MetaAdSet & { excluded_custom_audiences: string[]; previous_excluded_custom_audiences: string[]; verified: boolean; verification_error?: string }>`; before the POST, validates every added id against `listCustomAudiences(account)` and refuses unknown ids.
- `LiveState` / `ChangeState` gain `excluded_custom_audiences?: string[]`.

- [ ] **Step 1: Failing tests.**
  - `mergeExclusions`: add keeps existing ones and dedupes; remove drops only the named; add of an included audience throws; other keys preserved deep-equal; result list order-insensitive for the verification compare.
  - Provider (fake graph): unknown audience id → throws, posts nothing; POST body is the whole merged targeting; mismatch → `ExecutionVerificationError`.
  - Tool flow: queue `medium`; execute; change log; rollback restores the earlier list; drift refuses; schema rejects the same id in add and remove.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** + capability `{ id: "audiences", focus: "audiences", owner: "app", tool: "update_adset_audience_exclusions" }`. Card rows: Ad set, "Excluding: +N / −M audiences" with names when known.
- [ ] **Step 4: Run** the three test files plus `tests/optimization-capabilities.test.ts` — PASS; `npx tsc --noEmit`.

---

### Task 12: Placement evidence and rule-based proposals

**Files:**
- Modify: `src/lib/agent/optimize-evidence.ts`
- Test: `tests/optimize-evidence.test.ts` (extend)

**Interfaces:**
- Consumes: `provider.getInsightsReport` with breakdowns `["publisher_platform","platform_position"]`; `update_adset_placements` (Task 10).
- Produces: a `placements` section and `OfferedProposal`s with `tool "update_adset_placements"`, `focus "placements"`.

- [ ] **Step 1: Failing tests** (mock provider returning breakdown rows): a placement with spend ≥ 10% of the ad set's spend and cost per result ≥ 2× the ad set average is offered for exclusion (the proposal keeps all other current placements); a placement with spend ≥ max(10, daily budget/100) and zero results is offered while another placement converts; an ad set on Advantage+ placements (no manual positions) is never offered a manual list (section says "automatic placements — change in the app only if you name placements"); no breakdown data → section says so, no proposal; proposals respect `scopeEntityIds`; not produced when `brief.focus` lacks `placements`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** the section using `getInsightsReport` for the brief period and scope; build the proposed placement list from the ad set's live manual placements minus the wasteful ones; label e.g. "Exclude Audience Network from <ad set>: <spend> with <results> results".
- [ ] **Step 4: Run** `npx vitest run tests/optimize-evidence.test.ts tests/queue-selection.test.ts tests/optimize-queue-flow.test.ts` — PASS; `npx tsc --noEmit`.

---

### Task 13: Phrasing eval, full verification, hand-off notes

**Files:**
- Create: `tests/request-brief-eval.test.ts`
- Modify: none in `src` unless a failure exposes a defect (fix it in the owning task's file with a failing test first).

- [ ] **Step 1: Write the eval.** A table of ≥ 30 `{ message, history?, expect }` cases covering: typos and shorthand ("optimise mah budgets", "pls pause the retargeting adset"), named campaigns, explicit periods ("last 14 days", "1 Oct to 15 Oct"), analyse vs act ("what should I fix" vs "fix it and queue"), refs ("queue #2 and #3"), all ("apply all of these", "send everything you suggested to approvals"), focus ("only budget", "just the placements"), constraints ("don't touch the Brand campaign" → no queue entities for Brand), non-optimization chat ("thanks", "what does CPM mean") staying `chat`. Each case runs through `rulesBrief` (strict expectations on the fields the rules can know) and, with `generateText` stubbed to return the case's canonical JSON, through `classifyRequest` (checks code-computed period and normalisation).
- [ ] **Step 2: Run** `npx vitest run tests/request-brief-eval.test.ts` — fix rules for any gap the eval shows (each fix gets the case as its failing test first).
- [ ] **Step 3: Full verification.** Run `npx vitest run` (expect all files green; ≥ 141 + the new files) and `npx tsc --noEmit` (expect exit 0) and `npm run lint` if the project defines it (expect no new errors on touched files).
- [ ] **Step 4: Final read of the diff** (`git diff --stat`, then skim each changed file): no vendor names in operator-facing strings, no `console.log`, no leftover references to `executeProposals`, `buildFullOptimizeProposals` callers, or `wantsQueueApprovals` in `task-runner.ts`.
- [ ] **Step 5: Hand-off notes** in the final message: what changed, the calls made, and that the four new write tools are verified against a fake Graph only and must be run once on a PAUSED ad set in a test ad account before first real use.
