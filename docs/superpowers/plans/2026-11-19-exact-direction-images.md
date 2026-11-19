# Exact-direction images Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator give a picture instruction and exact words to print, in Workspace chat or in a bulk-run directions file, and get images that follow them exactly (one image unless variations are asked for), with editing afterwards.

**Architecture:** A new `src/lib/creatives/directed/` module set. A "directed" draft is an ordinary creative draft carrying a `DIRECTED: <base64url JSON>` marker line in `creative_direction` (picture, printed lines, versions). `generateImageForDraft` gets one branch that hands directed drafts to a new renderer, so rework, bulk rendering and variations all work unchanged. Chat routing uses an LLM detector that fails safe to the existing concept flow. Bulk adds a directions-file parser, a confirm step, and a run created straight from the directions (no hook planner).

**Tech Stack:** Next.js (see AGENTS.md: read `node_modules/next/dist/docs/` before route/page changes), TypeScript, Vitest, `ai` `generateObject` via `pickModel()`, `sharp`, existing OpenAI image + Supabase draft storage.

**Spec:** `docs/superpowers/specs/2026-11-19-exact-direction-images-design.md`

## Global Constraints

- `src/lib/creatives/concept-writer.ts` is not modified.
- Shared files (`generate-draft-image.ts`, `formats.ts`, `edit-image.ts`, `bulk/run.ts`, `task-runner.ts`) gain only the minimal branches named in the tasks; every existing test passes unchanged.
- Printed words are reproduced word for word; nothing is reworded, corrected, shortened or added.
- Exactly one image per direction; 4 only for variations; at most 5 directions per chat message; at most 30 per bulk file, never truncated silently (over 30 is refused).
- Direction wins on anything it names (colours, style, background); unnamed things use the brand palette and logo as existing images do. The "top agency polish" craft brief is not used.
- Routing is decided by an LLM; on any detector error or no configured model it returns `open` (existing flow).
- Bulk files accepted: txt, md, csv, docx, pdf, xlsx (existing 10 MB document limit).
- Variations keep the printed words verbatim.
- Run `npx vitest run` for touched areas and `npx tsc --noEmit -p .` before each commit.

## Review Focus

- A message with only a headline ("make ads, headline 'X'") must reach the concept writer unchanged (Task 4 test).
- Detector throws or no model configured: existing flow runs, nothing is lost (Task 3 test).
- Directed draft with no printed words prints no words; empty picture never becomes a draft (Tasks 1, 3 tests).
- A bulk file of N directions makes exactly N drafts in file order, including a direction with blank primary text (Tasks 7, 8 tests).
- More than 30 directions refused; more than 5 in chat pointed to the bulk file (Tasks 3, 7 tests).
- Edit failure leaves the original image and status intact (Task 6 test).

---

### Task 1: Directed marker, prompt and copy helpers (pure)

**Files:**
- Create: `src/lib/creatives/directed/markers.ts`, `src/lib/creatives/directed/prompt.ts`
- Modify: `src/lib/creatives/formats.ts` (`stripAspectMarker` also strips `DIRECTED:` lines)
- Test: `tests/directed-markers.test.ts`

**Interfaces:**
- Produces (markers.ts, client-safe, no server imports):
  - `type PrintLine = { role: string | null; text: string }`
  - `type Direction = { picture: string; print: PrintLine[]; noLogo?: boolean }`
  - `type DirectedMeta = Direction & { tweak?: string; versions?: string[] }` (`versions` = storage keys, oldest first, max 5)
  - `withDirectedMarker(direction: string | null | undefined, meta: DirectedMeta): string`, `readDirectedMarker(direction): DirectedMeta | null`, `isDirectedDirection(direction): boolean`
  - `copyFromPrint(print: PrintLine[], pastedCopy?: string | null): { headline: string; primary_text: string }` (headline = line with role matching /headline/i else first line; primary_text = pastedCopy if given, else the other lines' text joined by `\n`, blank if none)
- Produces (prompt.ts): `buildDirectedImagePrompt(input: { picture: string; print: PrintLine[]; format: ImageFormat; colors?: string[] | null; hasLogo: boolean; tweak?: string; revisionNotes?: string | null }): string`

- [ ] **Step 1: Write failing tests** in `tests/directed-markers.test.ts`: round-trip of a meta with unicode/quotes/newlines through `withDirectedMarker`/`readDirectedMarker`; `stripAspectMarker` of a direction with the marker returns text without it; `isDirectedDirection` true/false; `copyFromPrint` cases (headline role, first-line fallback, pastedCopy wins, single line gives blank primary text); prompt tests: contains each printed line verbatim and the sentence "Print no other words", says "Print no words anywhere on the image" when `print` is empty, includes the tweak line only when given, includes brand colours as fallback with the sentence that the picture instruction overrides them, says the logo is added afterwards and not to draw one when `hasLogo`, and does not contain "top agency".
- [ ] **Step 2: Run** `npx vitest run tests/directed-markers.test.ts` — expect FAIL (modules missing).
- [ ] **Step 3: Implement** `markers.ts` (base64url of UTF-8 JSON via `TextEncoder`/`btoa`; marker regex `^DIRECTED: (\S+)$`; replace an existing marker line), `prompt.ts` (reuse `formatPromptRule` from `formats.ts`), and the `stripAspectMarker` regex change to `^(ASPECT|RUN|LOGO|DIRECTED): \S+$`.
- [ ] **Step 4: Run** the new test plus `npx vitest run tests/video-seedance-format.test.ts tests/creatives` — expect PASS (existing creative tests unchanged).
- [ ] **Step 5: Commit** `feat(creatives): directed-image marker, prompt and copy helpers`.

### Task 2: Directed drafts and rendering

**Files:**
- Create: `src/lib/creatives/directed/render.ts`, `src/lib/creatives/directed/create.ts`
- Modify: `src/lib/creatives/generate-draft-image.ts` (branch at top of `generateImageForDraft`), `src/lib/creatives/bulk/run.ts` (`renderPending` also renders drafts whose primary text is blank when they carry a DIRECTED marker)
- Test: `tests/directed-render.test.ts`

**Interfaces:**
- Consumes: Task 1 exports; `generateOpenAIImage`, `storeDraftImage`, `getCreativeDraftAsync`, `upsertCreativeDraftAsync`, `withLogoMarker`.
- Produces:
  - `renderDirectedDraft(draftId: string, options?: { revisionNotes?: string | null; format?: ImageFormat }): Promise<DraftImageResult>` (same result shape as `generateImageForDraft`)
  - `loadDirectedBrand(input: { clientId: string; landingUrl?: string | null }): Promise<{ brandName: string; colors: string[] | null; logoUrl: string | null; landingUrl: string | null }>` (brand analysis of landing url or client website like bulk `planAndRender`; falls back to client colours and uploaded logo; never throws)
  - `createDirectedDrafts(input: { clientId: string; serviceId?: string | null; conversationId?: string | null; taskId?: string | null; directions: Direction[]; format: ImageFormat; brand: Awaited<ReturnType<typeof loadDirectedBrand>>; status?: "generating" | "pending"; runId?: string; pastedCopy?: string | null; conceptPrefix?: string }): Promise<CreativeDraft[]>` — one draft per direction in order; marker + ASPECT (+ RUN) lines; headline/primary_text from `copyFromPrint`; concept `"<brand> — <prefix> <n>"`.

- [ ] **Step 1: Failing tests** (mock `@/lib/creatives/openai-image` `generateOpenAIImage`, `@/lib/creatives/drafts` in-memory, `@/lib/creatives/cloudinary` unconfigured): `createDirectedDrafts` makes N drafts in order with marker, aspect, headline/primary_text; `renderDirectedDraft` sends a prompt containing the printed lines verbatim and passes `logoUrl: null` when `noLogo`; success stores the image and keeps the marker; a generator error marks the draft failed with the message; `generateImageForDraft` on a directed draft calls the directed renderer and on a non-directed draft behaves as before (existing `tests` for it still pass).
- [ ] **Step 2: Run** `npx vitest run tests/directed-render.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** the three functions; the `generateImageForDraft` branch uses a dynamic `await import("@/lib/creatives/directed/render")` after fetching `existing` and before any write; in `renderPending` change the two `d.primary_text` filters to `(d.primary_text || isDirectedDirection(d.creative_direction))`.
- [ ] **Step 4: Run** new tests plus `npx vitest run tests` for creatives/bulk files — PASS.
- [ ] **Step 5: Commit** `feat(creatives): create and render directed drafts`.

### Task 3: Direction detector

**Files:**
- Create: `src/lib/creatives/directed/detect.ts`
- Test: `tests/directed-detect.test.ts`

**Interfaces:**
- Produces:
  - `type Detection = { mode: "directed" | "open" | "variations" | "edit" | "unsure"; directions: Direction[]; format: ImageFormat | null; editInstruction: string | null; question: string | null; overflow: boolean }`
  - `normaliseDetection(raw: unknown, hasDirectedImage: boolean): Detection` (pure: drops directions with a blank picture; `directed` with none left becomes `unsure`; more than 5 directions sets `overflow` and keeps none; `variations`/`edit` without a directed image become `open`; `edit` without an instruction becomes `unsure`)
  - `detectDirection(input: { message: string; recent: string[]; hasDirectedImage: boolean }, deps?: { generate?: typeof generateObject }): Promise<Detection>` (returns `{ mode: "open", ... }` on any error or when `pickModel()` is null)

- [ ] **Step 1: Failing tests:** `normaliseDetection` rules above; `detectDirection` with a mocked `generate` returning directed JSON, returning `variations`, throwing (→ `open`), and with no model (→ `open`); the system prompt string contains the decided boundary ("a headline alone is open") and the 5-direction rule.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** with a zod schema, `temperature: 0`, a system prompt encoding the spec's boundary (picture idea ⇒ directed; headline/copy only ⇒ open; "variations/more versions" of an existing image ⇒ variations; a change to the existing image ⇒ edit; unclear ⇒ unsure with one short question; print lines verbatim with optional role; `no_logo` only when the operator says so).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(creatives): LLM detector for exact-direction requests`.

### Task 4: Chat integration

**Files:**
- Create: `src/lib/creatives/directed/chat.ts`
- Modify: `src/lib/agent/task-runner.ts` (one hook before `const shouldGenerateCreatives`; skip the concept flow when the hook handled the turn)
- Test: `tests/directed-chat.test.ts`

**Interfaces:**
- Consumes: Tasks 1-3 and Task 5/6 functions `createDirectedVariations`, `editDirectedDraft` (import lazily so this task can land after 5/6 or stub them).
- Produces: `runDirectedTurn(input: { clientId: string; serviceId?: string | null; conversationId: string; taskId: string; message: string; recent: string[]; landingUrl?: string | null; defaultFormat: ImageFormat; wantsInlineCreatives: boolean; drafts: CreativeDraft[] /* this conversation's drafts */ }, deps?: { detect?: typeof detectDirection }): Promise<DirectedTurn | null>` with `type DirectedTurn = { summary: string; cards: ReturnType<typeof toPublicDraft>[]; rendering: boolean; run: (() => Promise<void>) | null }`; returns `null` for `open` and for any turn the existing flow should handle.

Behaviour: detector runs only when `wantsInlineCreatives` or the conversation already has a directed draft. `directed` → brand via `loadDirectedBrand`, drafts via `createDirectedDrafts` (status "generating"), `run` renders them (concurrency 4); `variations` → 4 drafts via `createDirectedVariations(latestDirected)`; `edit` → mark latest directed draft generating, `run` = `editDirectedDraft`; `unsure` with `wantsInlineCreatives` → returns a turn whose summary is the one short question and no cards; `overflow` → summary pointing to Creatives > Bulk run; the task-runner hook sets `agentResult.summary`, `agentResult.ui.creativePicker = { drafts: cards, status }`, completes the `generate_creatives` step, schedules `run` with `runAfterResponse`, and skips the concept block.

- [ ] **Step 1: Failing tests** with `detect` injected and drafts mocked: headline-only message ⇒ `null` and `createDirectedDrafts` not called (Review Focus); directed ⇒ exactly one draft and a `run`; three directions ⇒ three drafts; six ⇒ overflow summary, no drafts; variations ⇒ four drafts all carrying the source's printed lines; edit ⇒ run targets the latest directed draft; `unsure` question returned only when `wantsInlineCreatives`; no detector call when neither condition holds.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** `chat.ts` and the task-runner hook (read the neighbouring code first; keep the hook ≤ 40 lines; reuse `listCreativeDraftsAsync(task.client_id, { conversationId })`; `recent` = the last 6 messages of the conversation if available, else empty).
- [ ] **Step 4: Run** `npx vitest run tests/directed-chat.test.ts` and the existing task-runner/agent tests — PASS.
- [ ] **Step 5: Commit** `feat(chat): exact-direction images, variations and edits in Workspace`.

### Task 5: Directed variations

**Files:**
- Create: `src/lib/creatives/directed/variations.ts`
- Test: `tests/directed-variations.test.ts`

**Interfaces:**
- Produces: `VARIATION_TWEAKS: readonly [string, string, string, string]` and `createDirectedVariations(input: { draftId: string }): Promise<{ source: CreativeDraft; drafts: CreativeDraft[] }>` — four new "generating" drafts, same conversation/task/brand/logo/format, same picture and printed lines, `tweak` set to one of the four fixed layout tweaks each (deterministic, no model call), concept `"<source concept> · Variation n"`.

- [ ] **Step 1: Failing tests:** four drafts; each marker's `print` equals the source's exactly; tweaks are four distinct strings; the rendered prompt (via `buildDirectedImagePrompt`) contains the tweak; a non-directed source throws.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(creatives): four verbatim variations of a directed image`.

### Task 6: Directed editing and the API route

**Files:**
- Create: `src/lib/creatives/directed/edit.ts`, `src/app/api/creatives/directed/route.ts`
- Modify: `src/lib/creatives/edit-image.ts` (export `imageBytes`)
- Test: `tests/directed-edit.test.ts`

**Interfaces:**
- Consumes: `callImageEdit`, `finishEdit`, `buildEditPrompt`, `imageBytes` from `edit-image.ts`; `storeDraftImage`; `getObjectStorage`.
- Produces:
  - `editDirectedDraft(input: { draftId: string; instruction: string }, deps?: { callEdit?: typeof callImageEdit; updatePrint?: (print: PrintLine[], instruction: string) => Promise<PrintLine[]> }): Promise<{ ok: boolean; error?: string }>` — saves the current image under `creatives/versions/<draftId>/<ts>.png` (keeps 5, keys in the marker), edits only what was asked with the logo put back, updates the marker's printed lines when the instruction changes words (default `updatePrint` is a small `generateObject` call; on failure the lines stay as they were); on any failure the draft returns to `succeeded` with the original image and the version file is deleted.
  - `undoDirectedEdit(draftId: string): Promise<void>` — restores the last version, restores the prior printed lines, pops the key; throws "There is no earlier version to go back to." when none.
  - Route `POST /api/creatives/directed` with `{ action: "variations", draftId }` | `{ action: "edit", draftId, instruction }` | `{ action: "undo", draftId }`; auth and `assertClientAccess` like `/api/creatives/variations`; variations create drafts, render them with `runAfterResponse` and post the `creative_generating` workflow message like the existing route; edit marks the draft generating then runs `editDirectedDraft` after the response.

- [ ] **Step 1: Failing tests** (mock storage and `callEdit`): success keeps the marker, stores a version key, changes only status/image; words changed ⇒ marker `print` updated via `updatePrint`; `callEdit` rejects ⇒ `{ ok: false }`, draft `succeeded`, no version key left; undo restores bytes and printed lines; undo with no versions throws; only 5 versions kept.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** (read `node_modules/next/dist/docs/` route-handler guide first). **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(creatives): edit, undo and variations API for directed images`.

### Task 7: Directions file parsing and the bulk API

**Files:**
- Create: `src/lib/creatives/directed/file.ts`, `src/lib/creatives/bulk/directed-run.ts`, `src/app/api/creatives/bulk/directions/route.ts`
- Modify: `src/app/api/creatives/bulk/route.ts` (accept `directions`)
- Test: `tests/directed-file.test.ts`, `tests/directed-bulk-run.test.ts`

**Interfaces:**
- Produces (file.ts):
  - `type ParsedDirection = Direction & { unsure: boolean; note: string | null }`
  - `MAX_DIRECTIONS = 30`
  - `normaliseParsed(raw: unknown): ParsedDirection[]` (pure: keeps file order, trims, never drops an item that has any text; an item with no clear picture is kept with `picture: ""` and `unsure: true`)
  - `parseDirectionsFile(input: { name: string; bytes: Buffer }, deps?: { generate?: typeof generateObject }): Promise<ParsedDirection[]>` — `.txt` read as UTF-8, other types via `extractDocumentText`; throws "That file type isn't supported" for others, "The file has no readable text", and `This file has N directions; the most for one run is 30. Split it and upload the parts.` when over 30 (never truncates).
- Produces (directed-run.ts): `startDirectedBulkRun(input: { clientId: string; serviceId?: string | null; createdBy?: string | null; landingPageUrl?: string | null; directions: Direction[]; pastedCopy?: string | null; format: ImageFormat }): Promise<CreativeRun>` (creates the run with `inputs: { directed: true, pastedCopy }`, N pending directed drafts with RUN marker, items `angle_name: "Direction n"`) and `planAndRenderDirected(runId: string): Promise<void>` (loads brand, sets logo/colours/landing on every draft, sets status "rendering", then `renderPending`; on failure marks the run failed with the message).
- Route `POST /api/creatives/bulk/directions` (multipart `file`, `clientId`) → `{ directions: ParsedDirection[], fileName }`; bulk `POST` schema gains optional `directions` (array 1..30 of `{ picture: string, print: {role: string|null, text: string}[], noLogo?: boolean }`, picture min 1); when present it calls `startDirectedBulkRun` and schedules `planAndRenderDirected`, else unchanged.

- [ ] **Step 1: Failing tests:** `normaliseParsed` order/unsure rules; `parseDirectionsFile` with a mocked generator for a txt file, a file over 30 (exact message, nothing truncated), unsupported extension, empty text; `startDirectedBulkRun` makes exactly N drafts in order including one with a single printed line (blank primary text) and `pastedCopy` applied as primary text; `renderPending` renders such blank-primary-text drafts; the route schema rejects 31 directions and a blank picture.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** new tests and existing bulk tests — PASS.
- [ ] **Step 5: Commit** `feat(bulk): directions file, parse and run from directions`.

### Task 8: UI — chat cards and the bulk confirm step

**Files:**
- Modify: `src/components/ai/workflow-cards.tsx` (directed cards: "Edit" box with Undo and "Variations (4)" replace "More like this"), `src/app/(app)/creatives/bulk/page.tsx` (file upload, parsed list editor, confirm button)
- Test: `tests/directed-ui-logic.test.ts` (pure helpers only) plus manual browser check

**Interfaces:**
- Consumes: `isDirectedDirection` (cards read `creative_direction`, so `CreativeDraftCard` gains `creative_direction?: string | null`); routes from Tasks 6-7.
- Produces: pure helper `src/lib/creatives/directed/confirm-list.ts` with `updateItem`, `removeItem`, `addItem`, `readyToConfirm(items): { ok: boolean; reason: string | null }` (needs at least 1 item and every item has a picture or words; unsure items do not block) used by the page.

- [ ] **Step 1: Failing tests** for the helpers.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** helpers, then the card changes and the bulk page (an "Directions file" input accepting `.txt,.md,.csv,.docx,.pdf,.xlsx`; after upload show "Image 1: picture / words" rows with textareas, unsure rows highlighted with their note, remove and add controls; "Confirm and make N images" posts `directions` to `/api/creatives/bulk`; the existing start button is hidden while a file is loaded; clearing the file restores it).
- [ ] **Step 4: Run** helper tests, `npx tsc --noEmit -p .`, `npx eslint` on touched files; start the dev server and check in the browser: chat directed request, edit, variations; bulk file upload, edit a row, confirm.
- [ ] **Step 5: Commit** `feat(ui): directed image cards and bulk directions confirm step`.

### Task 9: Whole-feature check

- [ ] Run `npx vitest run` (all) and `npx tsc --noEmit -p .`; compare any failures against `git stash` baseline (known pre-existing: `video-visual-rules > uses the look for its kind of footage`).
- [ ] Live check against the configured image model with the operator's own test direction (one image, then an edit, then variations; a 3-line file). Report what was and was not verified.
- [ ] Update `docs/superpowers/specs/2026-11-19-exact-direction-images-design.md` status to "built, live-checked: <what>" and save a project memory.
