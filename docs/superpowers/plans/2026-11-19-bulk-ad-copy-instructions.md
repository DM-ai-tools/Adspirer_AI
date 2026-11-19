# Bulk ad copy instructions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One common "Ad copy instructions" box for bulk runs (hook runs and directions-file runs) whose rules are checked and repaired across every ad, a form that separates Images from Ad copy, and per-ad copy editing after the run.

**Architecture:** New `src/lib/creatives/bulk/copy/` modules: rules (extract + numeric limits), check-and-repair (one shared pass), directed copy writer. The hook planner gets an AD COPY RULES block; its output goes through check-and-repair inside `planAndRender`. A directions run writes copy in the background while images render, tracked by a run-level copy status. A new route edits one ad's copy and marks it hand-edited so image edits never overwrite it; image-edit copy rewrites get the instructions and a limit check.

**Tech Stack:** Next.js (see AGENTS.md), TypeScript, Vitest, `generateObject` via `pickModel()` / `withModelFallback`, existing bulk run store (`creative_runs.inputs` jsonb, `items` jsonb).

**Spec:** `docs/superpowers/specs/2026-11-19-bulk-ad-copy-instructions-design.md`

## Global Constraints

- A run without ad copy instructions behaves exactly as today; every existing bulk test passes unchanged.
- Precedence when rules collide: (1) no invented facts, (2) printed words of a directions image never changed, (3) the operator's instructions. A rule that cannot be met that way is not forced: the ad keeps its best copy and gets the note `Could not follow: <rule>, because <reason>`; no repair loop on an impossible rule.
- Instructions: max 2,000 characters; they override the planner's built-in lengths ("45-90 words", "under 40 characters") and say so in the prompt.
- Check and repair add at most 3 calls per run (extract rules, judge, repair); a failing check never blocks a run or deletes copy.
- Copy is per ad even in a hook run; editing one ad never touches another or the shared body (`body_id` stays a label).
- Directions run: copy is written only when instructions are given; with no instructions the printed words are the copy, and pasted copy alone is the primary text of every ad (today's behaviour).
- Copy-writing job: run-level `copyStatus` ("writing" | "ready" | "failed"); a job still "writing" 10 minutes after `copyStartedAt` counts as stalled: printed words stay, status shows failed, publishing unblocks.
- Meta publish limits stay: headline clipped at 255, description 255; editor limits: headline 255, primary text 2,200, description 255.
- Run `npx vitest run` for touched areas and `npx tsc --noEmit -p .` before each commit. Known unrelated failures: `video-visual-rules`; PDF export tests time out under full-suite load only.

## Review Focus

- No instructions given ⇒ hook run and directions run produce today's results (Tasks 3, 4 tests).
- Instruction-checker failure or model error ⇒ run still completes with unchanged copy (Tasks 2, 3 tests).
- An ad whose instruction needs an invented fact gets a "Could not follow" note, not invented copy (Task 2 test).
- Directions run: printed words on the image/marker are untouched after copy writing; copy-writer failure or stall ⇒ printed-words copy stays and publishing unblocks (Task 4 tests).
- Hand-edited copy is not overwritten by a later image edit; instructions still apply to copy an image edit rewrites (Task 5 tests).
- Editing is refused while the ad's image is still being made; one ad's edit leaves others untouched (Task 5 tests).

---

### Task 1: Copy rules: extract and numeric limits

**Files:**
- Create: `src/lib/creatives/bulk/copy/rules.ts`
- Test: `tests/bulk-copy-rules.test.ts`

**Interfaces:**
- Produces:
  - `type Limit = { unit: "words" | "characters"; max: number }`
  - `type CopyRules = { headline?: Limit; primary_text?: Limit; description?: Limit; checklist: string[] }`
  - `type AdFields = { headline: string; primary_text: string; description: string | null }`
  - `COPY_FIELD_LIMITS = { headline: 255, primary_text: 2200, description: 255 }`
  - `wordCount(text: string): number`
  - `limitProblems(copy: AdFields, rules: CopyRules): string[]` (e.g. `"Primary text is 52 words; your limit is 40."`; checks only fields that have a limit and, for description, only when `copy.description` is non-null)
  - `extractCopyRules(instructions: string, deps?: { generate?: typeof generateObject }): Promise<CopyRules>` (one model call; returns `{ checklist: [] }` and no limits on any error or when no model; `checklist` = every inclusion/exclusion/structure point stated, one short item each)

- [ ] **Step 1: Failing tests** in `tests/bulk-copy-rules.test.ts`: `wordCount` ("a b  c\n d" = 4, "" = 0); `limitProblems` for words and characters on each field, a copy at exactly the limit passes, description with `null` is not checked, no limits ⇒ `[]`; `extractCopyRules` with an injected generator returning limits+checklist, returning `{checklist: []}` when the generator throws and when `pickModel()` is null (mock `@/lib/creatives/concept-writer` `pickModel`).
- [ ] **Step 2: Run** `npx vitest run tests/bulk-copy-rules.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** with a zod schema (`temperature: 0`), the system prompt telling the model to copy only limits and points the operator actually stated.
- [ ] **Step 4: Run** — PASS. **Step 5: Commit** `feat(bulk): ad copy rules and length limits`.

### Task 2: Check and repair

**Files:**
- Create: `src/lib/creatives/bulk/copy/check.ts`
- Test: `tests/bulk-copy-check.test.ts`

**Interfaces:**
- Consumes: Task 1 exports.
- Produces:
  - `type CopyAd = AdFields & { id: string; fixedWords?: string[] }` (`fixedWords` = printed words that must never change; context only, never part of the ad copy fields)
  - `type CheckResult = { ads: CopyAd[]; notes: Record<string, string>; repaired: string[]; rules: CopyRules }` (`notes` keyed by ad id, only for ads that still fail or cannot comply)
  - `checkAndRepairCopy(input: { instructions: string; ads: CopyAd[]; facts: string }, deps?: { generate?: typeof generateObject; rules?: CopyRules }): Promise<CheckResult>`
  Behaviour: rules (from `deps.rules` or `extractCopyRules`); code-check limits; one judge call over all ads against the checklist (skipped when the checklist is empty); ads with any problem are rewritten in ONE repair call told exactly what failed, the precedence order, `fixedWords` untouched, and to answer `could_not` (rule + reason) instead of inventing a fact or changing printed words; repaired copy is re-checked in code; notes: `Did not fully follow your instructions: <problems>` for remaining limit problems and `Could not follow: <rule>, because <reason>` for `could_not`. Any model error ⇒ returns the ads unchanged with no notes (never throws).

- [ ] **Step 1: Failing tests** (injected `generate` routing on the prompt): all ads pass ⇒ no repair call, ads unchanged, empty notes; one ad over a word limit and one failing the checklist ⇒ exactly one repair call containing only those two ads, passing ads untouched, `repaired` lists them; repair output still over the limit ⇒ note `Did not fully follow…`; repair returns `could_not` ("include a price" because no price in the facts) ⇒ note `Could not follow: include a price, because …` and copy not replaced by invented text; the repair prompt contains each `fixedWords` line and the three-step precedence sentence; generator throws ⇒ ads unchanged, no notes, no throw; empty instructions ⇒ no calls.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(bulk): check and repair ad copy against the operator's instructions`.

### Task 3: Hook run: instructions in, checked copy out

**Files:**
- Modify: `src/lib/creatives/bulk/plan.ts` (`BulkBrief.copyInstructions`, AD COPY RULES block in the bodies prompt and `writeHooks` prompt; export `briefLines`), `src/lib/creatives/bulk/runs.ts` (`inputs.copyInstructions`, `inputs.copyRules`; `RunItem.copy_note?: string | null`), `src/lib/creatives/bulk/run.ts` (`startBulkRun` stores them; `planAndRender` runs `checkAndRepairCopy` over the hooks before drafts are written and writes `copy_note` on items; extract the brief building into `src/lib/creatives/bulk/run-brief.ts` `loadRunBrief(run)`), `src/app/api/creatives/bulk/route.ts` (`copyInstructions: z.string().max(2000).optional()`), `src/lib/creatives/bulk/view.ts` (cards carry `copyNote`; run view carries `copy: { status, message, repaired, flagged }`)
- Test: `tests/bulk-copy-hook-run.test.ts`

**Interfaces:**
- Consumes: Task 2 `checkAndRepairCopy`.
- Produces: `copyRulesBlock(instructions: string): string` exported from `plan.ts` (the AD COPY RULES text, states it overrides lengths/structure elsewhere in the prompt and field descriptions and applies to headline, primary text and description); `loadRunBrief(run: CreativeRun): Promise<{ brief: BulkBrief; colors: string[] | null; logoUrl: string | null; brandName: string }>`.

- [ ] **Step 1: Failing tests** (copy the mocks of `tests/bulk-run-flow.test.ts`, route the mocked `generateObject` on prompt text): with instructions ⇒ the bodies prompt and every hook prompt contain the AD COPY RULES block and the instruction text; without ⇒ neither contains it and the existing flow's outputs are identical; with instructions ⇒ `checkAndRepairCopy` runs, a repaired hook's headline/primary text is what the draft stores and an unrepairable one's `copy_note` is on its run item; a throwing checker ⇒ run reaches `rendering` with unchanged copy; the bulk route rejects `copyInstructions` over 2,000 characters; `loadRunView` returns `copyNote` per card.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** (refactor `planAndRender` to use `loadRunBrief` without changing behaviour; `tests/bulk-run-flow.test.ts` must stay green). **Step 4: Run** new and existing bulk tests — PASS.
- [ ] **Step 5: Commit** `feat(bulk): hook runs follow the ad copy instructions`.

### Task 4: Directions run: write the copy

**Files:**
- Create: `src/lib/creatives/bulk/copy/write-directed.ts`
- Modify: `src/lib/creatives/bulk/directed-run.ts` (accept `copyInstructions`; store with `copyStatus: "writing"` and `copyStartedAt` only when instructions given; `planAndRenderDirected` writes copy concurrently with `renderPending`, then check-and-repair, then updates the drafts, sets `copyStatus` ready/failed with counts; failure keeps printed-words copy), `src/app/api/creatives/bulk/route.ts` (pass it through), `src/lib/creatives/bulk/view.ts` (stalled = writing for more than 10 minutes ⇒ reported as failed with message), `src/app/api/creatives/bulk/[runId]/publish/route.ts` (GET and POST refuse while the run's copy is writing and not stalled: "The ad copy is still being written.")
- Test: `tests/bulk-copy-directed.test.ts`

**Interfaces:**
- Consumes: Tasks 2 and 3 (`loadRunBrief`, `briefLines`, `checkAndRepairCopy`).
- Produces: `writeDirectedCopy(input: { directions: Array<{ picture: string; print: PrintLine[] }>; instructions: string; pastedCopy?: string | null; facts: string }, deps?: { generate?: typeof generateObject }): Promise<AdFields[]>` — batches of at most 10 in file order, one result per direction in order (a missing or blank result falls back to `copyFromPrint(direction.print)`); the prompt forbids rewording the printed words and states the precedence order.

- [ ] **Step 1: Failing tests:** 25 directions ⇒ 3 model calls (10,10,5) and results in order; a missing item falls back to the printed-words copy; the prompt contains each direction's printed words and the no-reword rule; `planAndRenderDirected` with instructions ⇒ drafts get the written copy, `inputs.copyStatus` ends `ready`, the DIRECTED marker's `print` is unchanged and all N images still render; writer throws ⇒ drafts keep printed-words copy, status `failed` with a message, run still `done`; without instructions ⇒ nothing is written and `copyStatus` is absent (today's behaviour, existing `tests/directed-bulk-run.test.ts` green); view reports a run stuck "writing" past 10 minutes as failed; publish route refuses while writing.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** new and directed/bulk tests — PASS.
- [ ] **Step 5: Commit** `feat(bulk): directions runs write ad copy from the instructions`.

### Task 5: Edit one ad's copy; image edits respect it

**Files:**
- Create: `src/lib/creatives/bulk/copy/edit-copy.ts`, `src/app/api/creatives/bulk/[runId]/copy/route.ts`
- Modify: `src/lib/creatives/realign-copy.ts` (`realignCopy` and `buildRealignPrompt` accept `instructions?: string` and `lockCopy?: boolean`), `src/lib/creatives/edit-image.ts` (`matchCopyToImage`: read the run item and run; pass instructions, `lockCopy` when the item is hand-edited; after a rewrite check numeric limits and set the item's `copy_note`), `src/lib/creatives/bulk/runs.ts` (`RunItem.copy_edited?: boolean`)
- Test: `tests/bulk-copy-edit.test.ts`

**Interfaces:**
- Produces: `saveAdCopy(input: { runId: string; draftId: string; headline?: string; primary_text?: string; description?: string | null }): Promise<CreativeDraft>` — validates against `COPY_FIELD_LIMITS` (throws a plain message naming the field), refuses while `image_status` is "generating" and not stalled, updates only that draft, sets the item's `copy_edited: true` and clears its `copy_note`; route `POST /api/creatives/bulk/[runId]/copy` (auth, `assertClientAccess`, item must belong to the run).

- [ ] **Step 1: Failing tests:** save changes only the named fields of one draft and leaves another draft and its body untouched; over-limit headline/primary/description rejected with the field named; refused while generating; draft not in the run rejected; sets `copy_edited` and clears the note; `realignCopy` with `lockCopy` returns the current copy unchanged (`changed: false`) but still returns the on-image words; its prompt includes the instructions when given; after an image edit on a non-edited ad the rewritten copy over a stored limit adds `copy_note`; after an edit on a hand-edited ad the copy is unchanged.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** new, `tests/creative-edit-image.test.ts` and bulk tests — PASS.
- [ ] **Step 5: Commit** `feat(bulk): edit each ad's copy, and keep it through image edits`.

### Task 6: The form and the cards

**Files:**
- Modify: `src/app/(app)/creatives/bulk/page.tsx` (Images and Ad copy sections with plain labels; Ad copy instructions box with an example placeholder; "Copy that already works" moved under it; both start requests send `copyInstructions`; cards: Edit ad copy inline editor with counters, copy note, hand-edited badge, "Writing copy…" state, run header line when copy was written to instructions / failed / stalled), `src/lib/creatives/bulk/copy/limits-ui.ts` (pure)
- Test: `tests/bulk-copy-ui-logic.test.ts` (pure helper only) plus a browser check if a session is available

**Interfaces:**
- Produces: `counterState(text: string, max: number): { count: number; over: boolean; label: string }` (`label` like `"128 / 255"`), `copyHeaderLine(copy: { status; message; repaired; flagged } | null): string | null`.

- [ ] **Step 1: Failing tests** for the two helpers (exact and over-limit counts; header lines for ready with repairs/flags, failed with message, absent).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** helpers, then the page changes (relabel only what the spec names: notes ⇒ "Offer facts the ads may use", style box unchanged in meaning; start button copy unchanged). **Step 4: Run** helper tests, `npx tsc --noEmit -p .`, `npx eslint` on touched files (pre-existing set-state-in-effect errors in the bulk page are known).
- [ ] **Step 5: Commit** `feat(ui): bulk form split into Images and Ad copy, per-ad copy editing`.

### Task 7: Whole-feature check

- [ ] `npx vitest run` (all) and `npx tsc --noEmit -p .`; compare any failure with the known list.
- [ ] Live check with the real model (small): run `extractCopyRules`, `writeDirectedCopy` for 2 sample directions and `checkAndRepairCopy` with the instruction "headline under 6 words, primary text under 25 words, mention a free audit, end with a question"; report what held. State plainly that the screens were not checked in a browser unless they were.
- [ ] Update the spec status line and save a project memory.
