# Campaign Settings Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One "Campaign settings" card in the workspace chat lets the operator pick budget level, conversion location, performance goal, conversion event, attribution, age range and advanced placements (platform, placement, device, OS) from Meta-valid dropdowns with descriptions and server-computed suggestions, and the queued approval carries exactly those settings.

**Architecture:** A hand-maintained rules table (`campaign-rules.ts`) defines valid objective → conversion location → performance goal → event/attribution combinations and computes deterministic suggestions. A new options endpoint merges live Meta lookups (pixels + events, Pages, lead forms, device/OS) with those rules in one request. A new `campaign_settings` chat UI payload renders the card; confirming it composes a structured message the model passes to the create tools, whose schemas and ad-set builder gain the missing fields.

**Tech Stack:** Next.js 16 (read `node_modules/next/dist/docs/` before touching routes), TypeScript, zod, Vitest (`npx vitest run`), AI SDK, Meta Graph API via `lib/meta/graph-client.ts`.

**Spec:** `docs/superpowers/specs/2026-10-27-campaign-settings-card-design.md`

## Global Constraints

- Changes reach Meta only through Approvals; campaigns are created paused.
- Objectives in scope: `OUTCOME_SALES`, `OUTCOME_LEADS`, `OUTCOME_TRAFFIC`, `OUTCOME_ENGAGEMENT`, `OUTCOME_AWARENESS`. Create tools in scope: image and video campaign, ad set, ad. Carousel/catalog/DCO out of scope.
- Conversion locations supported in v1: website and instant forms only. Messaging, calls and app are shown disabled with the text "not supported yet".
- The card offers only what the create tools can execute; an unsupported setting is disabled with a one-line reason, never offered and ignored.
- Suggestions and their reasons are computed on the server by plain rules in the same request as the options; the model never generates them and the card never waits on it.
- With no settings block, today's behaviour is unchanged: performance goal is derived from the objective exactly as `optimizationForObjective` does now. All new fields are optional.
- The card owns age range and placements; the targeting picker keeps locations, audiences, interests, behaviours. If both supply age or placements, the most recent wins and the approval shows the final values.
- Device/OS options come from Meta targeting search; if the lookup fails or returns nothing usable, offer a short curated list.
- An invalid combination is rejected server-side with a plain message and is never silently altered.
- Rules table is pinned by a unit test so a `META_GRAPH_VERSION` bump is a deliberate change. Verify enum names and combinations against that Graph version.
- Files use CRLF line endings; edit with a tool that preserves them.

## Review Focus

- Engagement and Awareness objectives: no conversion location or event fields appear, and no event is sent.
- Sales or Leads (website) with no pixel on the account: card shows an inline message and the existing "needs a pixel" creation error still applies.
- Leads + instant form with no lead form found: field degrades with a message; nothing is invented.
- Operator changes objective, location or goal after choosing: dependent fields reset and are re-suggested, never left holding an invalid value.
- Operator sets age min above 25 or max below 65: existing Advantage+ audience conflict rule still applies and the approval shows it off.
- Meta lookup failure, unmapped account, expired token: one banner, rest of the card usable.
- A crafted message naming an unsupported conversion location (messaging, calls, app): create tool rejects it.

---

## File Structure

- Create `src/lib/meta/campaign-rules.ts` — types, rules table, validator, suggestion engine.
- Create `src/lib/meta/campaign-options.ts` — `loadCampaignOptions`, live Meta lookups with graceful degradation, curated device/OS fallback.
- Create `src/app/api/v2/meta/campaign-options/route.ts` — GET endpoint (pattern: `app/api/v2/meta/pages/route.ts` wrapping a base route).
- Create `src/lib/meta/campaign-settings-state.ts` — pure state transitions for the card (dependents reset).
- Create `src/components/ai/campaign-settings-card.tsx` — the card.
- Modify `src/lib/tools/execute/schemas.ts`, `src/lib/meta/targeting-builder.ts`, `src/lib/meta/provider-v2.ts`, `src/lib/meta/normalize-approval-args.ts` — new fields end to end.
- Modify `src/lib/agent/reply-format.ts`, `src/lib/agent/adspirer-agent.ts`, `src/lib/agent/task-runner.ts`, `src/lib/agent/prompts.ts`, `src/lib/chat/action-messages.ts`, `src/lib/chat/infer-flow.ts`, `src/components/ai/chat-panel.tsx` — chat plumbing.
- Tests in `tests/`: `campaign-rules.test.ts`, `campaign-options.test.ts`, `campaign-settings-state.test.ts`, `campaign-settings-create.test.ts`, `campaign-settings-chat.test.ts`.

---

### Task 1: Rules table, validator, suggestions

**Files:**
- Create: `src/lib/meta/campaign-rules.ts`
- Test: `tests/campaign-rules.test.ts`

**Interfaces:**
- Produces:
  - `type CampaignObjective = "OUTCOME_SALES" | "OUTCOME_LEADS" | "OUTCOME_TRAFFIC" | "OUTCOME_ENGAGEMENT" | "OUTCOME_AWARENESS"`
  - `type ConversionLocation = "website" | "instant_form" | "messaging" | "calls" | "app"`
  - `type BudgetLevel = "campaign" | "ad_set"`
  - `type OptimizationGoal` — union of the Meta goal strings used in the table (`OFFSITE_CONVERSIONS`, `VALUE`, `LEAD_GENERATION`, `LINK_CLICKS`, `LANDING_PAGE_VIEWS`, `POST_ENGAGEMENT`, `REACH`, `IMPRESSIONS`)
  - `type CampaignSettings = { budget_level?: BudgetLevel; conversion_location?: ConversionLocation; optimization_goal?: OptimizationGoal; pixel_event_name?: string; attribution?: (typeof ATTRIBUTION_SETTINGS)[number]; age_min?: number; age_max?: number; publisher_platforms?: string[]; facebook_positions?: string[]; instagram_positions?: string[]; device_platforms?: ("mobile" | "desktop")[]; user_device?: string[]; user_os?: string[] }`
  - `type OptionInfo<T extends string = string> = { id: T; label: string; description: string; supported: boolean; unsupportedReason?: string }`
  - `conversionLocationsFor(objective: CampaignObjective): OptionInfo<ConversionLocation>[]` (empty for Engagement/Awareness; website for Traffic/Sales/Leads; instant_form for Leads; messaging/calls/app returned with `supported: false, unsupportedReason: "not supported yet"`)
  - `performanceGoalsFor(objective: CampaignObjective, location?: ConversionLocation): (OptionInfo<OptimizationGoal> & { needsEvent: boolean; supportsAttribution: boolean })[]`
  - `attributionOptionsFor(goal: OptimizationGoal): OptionInfo<(typeof ATTRIBUTION_SETTINGS)[number]>[]` (empty unless the goal supports attribution)
  - `PLACEMENT_OPTIONS` (platforms and per-platform positions, Meta enum ids with labels and descriptions; no deprecated `video_feeds`)
  - `validateCampaignSettings(settings: CampaignSettings, ctx: { objective: CampaignObjective; hasPixel: boolean; hasLeadForm: boolean }): { ok: true } | { ok: false; error: string }`
  - `suggestCampaignSettings(ctx: { objective: CampaignObjective; hasPixel: boolean; hasLeadForm: boolean; pixelEvents?: string[]; stated?: Partial<CampaignSettings> }): { settings: CampaignSettings; reasons: Partial<Record<keyof CampaignSettings, string>> }`

- [ ] **Step 1: Write failing tests** in `tests/campaign-rules.test.ts`:
  - `conversionLocationsFor("OUTCOME_LEADS")` ids are `website`, `instant_form`, `messaging`, `calls`, `app`; the last three have `supported === false` and `unsupportedReason === "not supported yet"`.
  - `conversionLocationsFor("OUTCOME_AWARENESS")` and `("OUTCOME_ENGAGEMENT")` return `[]`.
  - `performanceGoalsFor("OUTCOME_LEADS","instant_form")` is exactly `["LEAD_GENERATION"]`; `("OUTCOME_LEADS","website")` includes `OFFSITE_CONVERSIONS` with `needsEvent: true`; `("OUTCOME_TRAFFIC","website")` includes `LINK_CLICKS` and `LANDING_PAGE_VIEWS`.
  - `attributionOptionsFor("OFFSITE_CONVERSIONS")` ids equal `["7d_click_1d_view","7d_click","1d_click"]`; `attributionOptionsFor("LINK_CLICKS")` is `[]`.
  - `validateCampaignSettings` rejects: `conversion_location: "messaging"` (error contains "not supported yet"); `OFFSITE_CONVERSIONS` with `hasPixel:false`; `LEAD_GENERATION` with `hasLeadForm:false`; a goal not in `performanceGoalsFor` for the objective/location; `age_min` > `age_max`; `age_min` < 18; an attribution value on a goal that does not support it. It accepts an empty `{}`.
  - `suggestCampaignSettings({objective:"OUTCOME_LEADS", hasPixel:true, hasLeadForm:false, pixelEvents:["Lead","PageView"]})` suggests `conversion_location:"website"`, `optimization_goal:"OFFSITE_CONVERSIONS"`, `pixel_event_name:"LEAD"`, `attribution:"7d_click_1d_view"`, `budget_level:"campaign"`, with a non-empty reason for each. With `hasPixel:false, hasLeadForm:true` it suggests `instant_form` / `LEAD_GENERATION`. `stated.optimization_goal` is kept when valid.
  - Pin test: a snapshot-style assertion of the full goal list per objective/location so a change is deliberate.
- [ ] **Step 2: Run** `npx vitest run tests/campaign-rules.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `src/lib/meta/campaign-rules.ts` with the signatures above. Table content (verify each against Graph `META_GRAPH_VERSION`): Sales/website → `OFFSITE_CONVERSIONS` (needs event, attribution), `VALUE` (needs event, attribution; requires `roas_average_floor` which stays in the existing bid fields); Leads/website → `OFFSITE_CONVERSIONS`; Leads/instant_form → `LEAD_GENERATION`; Traffic/website → `LINK_CLICKS`, `LANDING_PAGE_VIEWS`; Engagement → `POST_ENGAGEMENT`; Awareness → `REACH`, `IMPRESSIONS`. Each option gets a one-line plain-English description. Default `age_min: 18`, `age_max: 65` are not suggested; suggest age only if `stated` has it.
- [ ] **Step 4: Run tests** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(meta): campaign settings rules table, validator and suggestions`.

---

### Task 2: Create tools carry the new fields

**Files:**
- Modify: `src/lib/tools/execute/schemas.ts` (`targetingFields`), `src/lib/meta/targeting-builder.ts`, `src/lib/meta/provider-v2.ts` (ad-set body near `optimizationForObjective` and `destination_type`), `src/lib/meta/normalize-approval-args.ts`
- Test: `tests/campaign-settings-create.test.ts`; keep `tests/meta-targeting-builder.test.ts` green

**Interfaces:**
- Consumes: `validateCampaignSettings`, `CampaignSettings` from Task 1.
- Produces:
  - schema fields on the create tools: `optimization_goal?: string`, `conversion_location?: "website"|"instant_form"|"messaging"|"calls"|"app"`, `device_platforms?: ("mobile"|"desktop")[]`, `user_device?: string[]`, `user_os?: string[]`
  - `optimizationForObjective(objective, options)` honours `options.extra_args.optimization_goal` when it passes `validateCampaignSettings`; otherwise unchanged
  - `buildMetaTargeting` writes `device_platforms`, `user_device`, `user_os` onto the targeting spec when given
  - ad set `destination_type`: `conversion_location "website"` → `WEBSITE`, `"instant_form"` → `ON_AD` (existing lead-form behaviour kept)

- [ ] **Step 1: Write failing tests**:
  - Regression: `optimizationForObjective("OUTCOME_LEADS",{pixel_id:"1"})` still returns `{optimization_goal:"OFFSITE_CONVERSIONS",billing_event:"IMPRESSIONS"}` and the other four objectives return what they do today.
  - `optimizationForObjective("OUTCOME_TRAFFIC",{extra_args:{optimization_goal:"LANDING_PAGE_VIEWS"}})` returns `LANDING_PAGE_VIEWS`; an invalid goal for the objective throws a message from the validator.
  - `buildMetaTargeting` with `extra_args:{device_platforms:["mobile"],user_os:["iOS"],user_device:["iPhone"]}` has those keys on the result; without them the result has none of these keys.
  - A create-tool schema parse accepts the new fields and rejects `conversion_location:"messaging"` with "not supported yet".
  - `normalize-approval-args` keeps all new fields (no silent drop).
- [ ] **Step 2: Run** `npx vitest run tests/campaign-settings-create.test.ts tests/meta-targeting-builder.test.ts` — Expected: FAIL on new cases only.
- [ ] **Step 3: Implement** the schema additions, the override in `optimizationForObjective`, the targeting keys, the `destination_type` mapping in `provider-v2.ts`, and pass-through in `normalize-approval-args.ts`. Budget level needs no new field: it is the existing `campaign_budget_optimization` boolean.
- [ ] **Step 4: Run** the two test files plus `npx tsc --noEmit -p .` — Expected: PASS, no type errors.
- [ ] **Step 5: Commit** `feat(meta): create tools accept performance goal, conversion location, device and OS`.

---

### Task 3: Options endpoint

**Files:**
- Create: `src/lib/meta/campaign-options.ts`, `src/app/api/v2/meta/campaign-options/route.ts`
- Test: `tests/campaign-options.test.ts`

**Interfaces:**
- Consumes: `conversionLocationsFor`, `performanceGoalsFor`, `attributionOptionsFor`, `PLACEMENT_OPTIONS`, `suggestCampaignSettings` from Task 1.
- Produces:
  - `type CampaignOptions = { accountId: string; objective: CampaignObjective; conversionLocations: OptionInfo<ConversionLocation>[]; performanceGoals: Record<string, ReturnType<typeof performanceGoalsFor>>; attribution: Record<string, ReturnType<typeof attributionOptionsFor>>; pixels: { id: string; name: string; events: string[] }[]; pages: { id: string; name: string }[]; leadForms: { id: string; name: string; page_id: string }[]; devices: { id: string; name: string }[]; osList: { id: string; name: string }[]; placements: typeof PLACEMENT_OPTIONS; suggestion: ReturnType<typeof suggestCampaignSettings>; warnings: string[] }` (`performanceGoals` keyed by conversion location id)
  - `loadCampaignOptions(input: { clientId: string; accountId: string; objective: CampaignObjective; stated?: Partial<CampaignSettings> }): Promise<CampaignOptions>`
  - `GET /api/v2/meta/campaign-options?clientId=&accountId=&objective=&stated=` returns `jsonOk(CampaignOptions)`; same auth and account-resolution pattern as `app/api/meta/pages/route.ts`.

- [ ] **Step 1: Write failing tests** (mock the Graph calls): all lookups succeed → pixels carry events, suggestion computed from them; pixel lookup throws → `pixels: []`, `warnings` contains a message naming pixels, other fields still returned; device/OS lookup returns empty → curated fallback list used and non-empty; unmapped account / token error → one warning, the rules-derived fields still present; unsupported locations are present with `supported:false`.
- [ ] **Step 2: Run** `npx vitest run tests/campaign-options.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `loadCampaignOptions` running the Meta lookups in parallel, each wrapped so failure appends to `warnings` instead of throwing. Pixels: ad-account `adspixels` plus each pixel's recent event names (see `lib/audit/meta-audit-data.ts` for existing pixel calls). Lead forms: per-Page `leadgen_forms` (reuse `listFacebookPagesForAccountId` from `lib/meta/resolve-page.ts`). Device/OS: Meta targeting search by class `user_device` and `user_os` (follow the search code in `provider-v2.ts` around the `adTargetingCategory` params), with a curated fallback constant. Cache each lookup per `(accountId, kind)` for 5 minutes. Add the route and a `v2` wrapper like `app/api/v2/meta/pages/route.ts`.
- [ ] **Step 4: Run tests** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(meta): campaign options endpoint with live Meta lookups`.

---

### Task 4: Card state transitions

**Files:**
- Create: `src/lib/meta/campaign-settings-state.ts`
- Test: `tests/campaign-settings-state.test.ts`

**Interfaces:**
- Consumes: Task 1 types and functions, `CampaignOptions` from Task 3.
- Produces: `applyChange(current: CampaignSettings, change: Partial<CampaignSettings>, options: CampaignOptions): CampaignSettings` — applies the change, then resets and re-suggests any dependent field that is no longer valid (location change resets goal, event, attribution; goal change resets event and attribution; platform change drops positions of removed platforms). `canConfirm(settings: CampaignSettings, options: CampaignOptions): { ok: true } | { ok: false; error: string }` — wraps `validateCampaignSettings` using `options.pixels.length > 0` and `options.leadForms.length > 0`.

- [ ] **Step 1: Write failing tests**: changing `conversion_location` from `website` to `instant_form` under Leads sets `optimization_goal` to `LEAD_GENERATION` and clears `pixel_event_name` and `attribution`; changing goal from `OFFSITE_CONVERSIONS` to `LINK_CLICKS` under Traffic clears the event and attribution; removing `instagram` from `publisher_platforms` removes `instagram_positions`; a change that leaves everything valid keeps other fields untouched; `canConfirm` fails for Sales with no pixels.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** both functions, pure and synchronous.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(meta): campaign settings card state transitions`.

---

### Task 5: Chat plumbing and prompt

**Files:**
- Modify: `src/lib/agent/reply-format.ts` (add `FormattedCampaignSettingsPicker = { account_id?: string | null; objective?: string | null; stated?: Partial<CampaignSettings> }`, `extractCampaignSettingsPicker`, include `campaign_settings` in the machine-JSON patterns near lines 74 and 114), `src/lib/agent/adspirer-agent.ts` (`CampaignSettingsPickerUi` on the UI type near line 331; thread it through like `targetingPicker`), `src/lib/agent/task-runner.ts` (attach like `targetingPicker` near line 611), `src/lib/chat/action-messages.ts`, `src/lib/chat/infer-flow.ts`, `src/lib/agent/prompts.ts`
- Test: `tests/campaign-settings-chat.test.ts`

**Interfaces:**
- Consumes: `CampaignSettings` (Task 1).
- Produces: `composeCampaignSettingsMessage(settings: CampaignSettings, labels: Partial<Record<keyof CampaignSettings, string>>): string` — returns text starting `Campaign settings selections:` with one readable line per chosen field followed by the create args as a JSON block, in the style of `composeTargetingMessage`; the JSON args map `budget_level` to the existing `campaign_budget_optimization` boolean (`"campaign"` → `true`, `"ad_set"` → `false`) and keep the other fields under their own names; `inferConversationFlow` returns `create_campaign` for a user message starting `Campaign settings selections`; the model emits `{"ui":"campaign_settings","account_id":"act_…","objective":"OUTCOME_LEADS"}`.

- [ ] **Step 1: Write failing tests**: `extractCampaignSettingsPicker` parses the JSON appendix and the machine JSON is stripped from displayed text; `composeCampaignSettingsMessage` output contains `Campaign settings selections:`, the chosen goal label and the JSON args; `inferConversationFlow` on such a message returns `create_campaign`; `detectRequestIntentWithHistory` on that message during a campaign build returns `create_campaign` (not optimize).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** the plumbing following the `targeting_picker` path end to end. In `prompts.ts` Stage A: after the objective is known and before creative, append `{"ui":"campaign_settings",…}` and stop until the operator confirms; pass fields from the "Campaign settings selections" block to the create tool verbatim; age range and placements come from this card, locations/audiences/interests from the targeting picker; remove the prompt's separate questions for placements and age.
- [ ] **Step 4: Run** the new test file and `npx tsc --noEmit -p .` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(chat): campaign_settings UI payload, message and prompt`.

---

### Task 6: The card component

**Files:**
- Create: `src/components/ai/campaign-settings-card.tsx`
- Modify: `src/components/ai/chat-panel.tsx` (render when the latest assistant message carries `campaignSettingsPicker` and flow is `create_campaign`; same pattern as `TargetingPicker` and `onConfirm` → `applyToComposer(composeCampaignSettingsMessage(...), "settings")`)

**Interfaces:**
- Consumes: `CampaignOptions` (Task 3) via `apiFetch("/api/v2/meta/campaign-options?…")`, `applyChange` and `canConfirm` (Task 4), `composeCampaignSettingsMessage` (Task 5), UI primitives in `src/components/ui/`.
- Produces: `<CampaignSettingsCard clientId accountId objective stated disabled onConfirm onSkip />` where `onConfirm(settings: CampaignSettings, labels: Partial<Record<keyof CampaignSettings, string>>)`.

- [ ] **Step 1: Implement** the card: one request on mount; sections for Budget level, Conversion location (unsupported ones disabled with their reason), Performance goal, Conversion event, Attribution, Age range, and a collapsed "Advanced placements" (platforms, positions, device, OS). Each field has its label, a one-line description and, where the server suggested it, the reason text beside the pre-selected value. Engagement/Awareness hide the conversion fields. A single banner shows `warnings`. Confirm is disabled with the `canConfirm` error when invalid. Loading shows a skeleton, never blocks the chat.
- [ ] **Step 2: Wire into chat-panel** and run `npx tsc --noEmit -p .` and `npx eslint src/components/ai` — Expected: clean.
- [ ] **Step 3: Verify in the running app** (`npm run dev:https`, https://localhost:3000): start a lead campaign in the workspace, confirm the card appears after the objective, suggestions are pre-selected with reasons, messaging/calls/app are disabled, changing the conversion location resets the goal, and confirming puts the "Campaign settings selections" block in the composer. Expected: all of that observed; report anything not observed.
- [ ] **Step 4: Run the full suite** `npx vitest run` — Expected: all green.
- [ ] **Step 5: Commit** `feat(chat): campaign settings card`.
