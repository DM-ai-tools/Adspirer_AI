# Video Concepts First Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "Write the script for me" shows 3 invented video concepts, writes the full voiceover + scenes for the one picked, and takes plain-language change requests; uploaded concepts/scripts are fitted to the model; stats and script inspection are gone; up to 3 speaking voices.

**Architecture:** A new concept stage (`concepts.ts`: invent → judge → pick 3 distinct) sits on the existing fact-checked creative brief and replaces `planAngles` on the written path. A concept converts into the existing `AnglePlan` + a concept block in the writer prompt, so the length-fitting writer is reused. Change requests (`change-request.ts`) and model fitting (`fit-to-model.ts`) are new focused modules. Voices are a script-level list plus per-scene `lines`; generation picks one voice anchor per voice.

**Tech Stack:** Next.js route handlers, `ai` `generateObject` + zod via `withModelFallback`, vitest.

**Spec:** `docs/superpowers/specs/2026-11-16-video-concepts-design.md`

## Global Constraints

- Exactly 3 concepts shown; invent ~8 candidates per round; avoid loglines of the client's last 30 concepts.
- Scene cap 15 seconds (`MAX_SCENE_SECONDS = 15`); video max 60s (`MAX_SECONDS`).
- Up to 3 voices per script; at most 2 voices in one scene; each voice's first scene has it speaking alone.
- No stats collected or forced; numbers only when they are sourced facts.
- No script-level inspection shown or blocking (editorial panel, per-scene issues, plan validation list). Clip and final inspection unchanged.
- Nothing about the business beyond the brief / operator text; fiction allowed for story.
- No DB migration: concepts live in `project.brand` (jsonb); status is free text.
- Operator-facing text: plain words, no jargon.

## Review Focus

1. A model that returns fewer than 3 usable concepts → show what survived with a plain note, never an empty screen or a throw (Task 1 test).
2. A change request naming a scene number that does not exist → nothing changes, operator told why (Task 4 test).
3. An uploaded voiceover whose single paragraph is 60 words (> 15s) → split into scenes ≤ 15s, words kept exactly (Task 5 test).
4. Old projects (one voice, `stat`/`assetId` on scenes, three angle versions) still load, confirm and generate (Task 2 + Task 6 tests).
5. A clip with two voices where one voice has no anchor yet → that voice is described in words only; no wrong reference attached (Task 6 test).

---

### Task 1: Concept engine

**Files:**
- Create: `src/lib/video/concepts.ts`
- Modify: `src/lib/video/script-types.ts` (add `VideoConcept`)
- Test: `tests/video-concepts.test.ts`

**Interfaces:**
- Produces:
  - `type VideoConcept = { id: string; title: string; format: string; logline: string; hook: string; beats: Array<{ text: string; seconds: number }>; whyItWorks: string; brandLink: string; look: string; cast: string[]; settings: string[]; voices: Array<{ id: string; who: string; description: string }>; seconds: number; scores?: ConceptScores }`
  - `type ConceptScores = { originality: number; hook: number; emotion: number; brandLink: number; renderable: number; truth: number }`
  - `planConcepts(brief: CreativeBrief, opts: { targetSeconds: number; direction: string | null; avoid: string[]; feedback?: string | null; deps?: { invent?(prompt: string): Promise<unknown>; judge?(prompt: string): Promise<unknown> } }): Promise<{ concepts: VideoConcept[]; limitation: string | null }>`
  - `renderProblems(c: VideoConcept): string[]` (pure; >3 voices, >3 cast, >4 settings, a beat >15s, total >60s)

- [ ] Step 1: tests — `planConcepts` with mocked invent (8 candidates) and judge returns 3 concepts, highest combined score, none with `truth < 6` or `renderable < 6`, no two marked duplicates; `renderProblems` flags a 20s beat and 4 voices; fewer than 3 survivors after one retry → returns survivors + `limitation` string; `avoid` loglines appear in the invent prompt.
- [ ] Step 2: run `npx vitest run tests/video-concepts.test.ts` → FAIL (module missing).
- [ ] Step 3: implement. Invent at temperature 1.0, judge at 0.2. The invent prompt carries `briefForPrompt(brief)`, the direction, target length, model limits in words, the anti-generic list from the spec, the avoid list, and asks for formats and registers the model invents itself (no fixed list). Judge returns per-candidate scores + `duplicateOf: number | null`. Drop `truth < 6 || renderable < 6 || renderProblems(c).length`; rank by sum; greedily skip duplicates; one more invent round with the drop reasons if < 3.
- [ ] Step 4: run tests → PASS.
- [ ] Step 5: commit `feat(video): invent, judge and pick three video concepts`.

### Task 2: Write a script from a concept (voices, 15s scenes, no stats)

**Files:**
- Modify: `src/lib/video/script.ts` (`VideoScene.lines?`, `VideoScript.voices?`, `VideoScript.concept?`, `sceneSchema` lines, `MAX_SCENE_SECONDS`)
- Modify: `src/lib/video/script-writer.ts` (concept block, voices, scene cap, drop required-stats from the loop)
- Modify: `src/lib/video/timing.ts` (nothing new unless scene cap helper lives here: `splitLongLine(text, maxSeconds): string[]`)
- Test: `tests/video-concept-writer.test.ts`

**Interfaces:**
- Produces:
  - `type SceneLine = { voiceId: string; text: string; onCamera: boolean }`; `VideoScene.lines?: SceneLine[]`; `VideoScript.voices?: Array<{ id: string; who: string; description: string }>`; `VideoScript.concept?: VideoConcept`
  - `conceptAngle(c: VideoConcept): AnglePlan` (pure)
  - `writeScriptForConcept(ctx: WriteContext, concept: VideoConcept, opts?: WriteOptions): Promise<VideoScript>`
  - `normaliseVoices(script: VideoScript): VideoScript` (pure; fills `line`/`speaker` from `lines`, defaults one `narrator` voice for old scripts)
  - `MAX_SCENE_SECONDS = 15`, `splitLongLine(text: string, maxSeconds?: number): string[]` (sentence-first, then clause, never drops a word)

- [ ] Step 1: tests — `conceptAngle` carries title/logline/hook into name/centralMessage/hookPremise; `buildWrittenScript` with a mocked raw draft that has two voices produces `voices` and per-scene `lines`, `line` = joined texts; scene over 15s triggers a fit note (scene-level) and after attempts is split by `splitLongLine`; `splitLongLine` keeps every word for a 60-word paragraph and every part ≤ 15s; no `imageStats` / stat fix note in the loop; old script without `lines` → `normaliseVoices` gives one narrator voice.
- [ ] Step 2: run → FAIL.
- [ ] Step 3: implement. `scriptPrompt` gains the concept block (title, format, logline, hook, beats with seconds, look, cast, settings, voices) and "scenes follow these beats; this is the idea, write it". Scene schema gains `lines: [{ voice_id, text, on_camera }]` (max 2) — `line`/`speaker` derived. Drop `requiredStatsPrompt`, `statFixNote`, `operator stats` lines. Scene words cap: `≤ floor(15 × wordsPerSecond)`.
- [ ] Step 4: run task tests + `tests/script-writer*.test.ts` → PASS (update old expectations that asserted stat behaviour).
- [ ] Step 5: commit `feat(video): write the script from the chosen concept with several voices`.

### Task 3: Project flow and API for concepts

**Files:**
- Modify: `src/lib/video/projects.ts` (status `concepts_ready`; `VideoBrand.concepts?`, `shownConcepts?`)
- Modify: `src/lib/video/brief.ts` (`writeProjectScripts` → concepts; `writeConceptScript`; `moreConcepts`; `editScripts` without `ensureMainStats`; `conceptHistory`)
- Create: `src/app/api/creatives/video/[id]/concepts/route.ts`
- Modify: `src/app/api/creatives/video/[id]/route.ts` (view exposes concepts; confirm drops the unsaid-stat throw; POST = new concepts)
- Modify: `src/app/api/creatives/video/route.ts` (drop `stats`, `images`; add `conceptText`)
- Test: `tests/video-concept-flow.test.ts`

**Interfaces:**
- Consumes: `planConcepts`, `writeScriptForConcept`.
- Produces:
  - `writeProjectScripts(projectId)` ends at `status: "concepts_ready"`, `brand.concepts` (3), `brand.shownConcepts` (loglines).
  - `writeConceptScript(projectId: string, conceptId: string): Promise<void>` → appends/replaces the script for that concept in `scripts`, `status: "scripts_ready"`.
  - `moreConcepts(projectId: string, feedback: string | null): Promise<void>` → 3 new, avoiding all shown.
  - `conceptHistory(clientId: string, excludeProjectId: string): Promise<string[]>` (last 30 loglines)
  - Route `POST /api/creatives/video/[id]/concepts` body `{ action: "pick", conceptId } | { action: "more", feedback?: string }` → `{ started: true }`, runs in background, status `writing` meanwhile.
- [ ] Step 1: tests (demo store, mocked planConcepts/writer via `vi.mock`) — write → `concepts_ready` with 3 concepts; pick → `scripts_ready` with one script whose `concept.id` matches; pick another → two scripts kept; more → 3 new concepts, `shownConcepts` grows; confirm with a script lacking image stats no longer throws.
- [ ] Step 2: run → FAIL.
- [ ] Step 3: implement.
- [ ] Step 4: run → PASS.
- [ ] Step 5: commit `feat(video): concepts stage in the project flow`.

### Task 4: Change requests with undo

**Files:**
- Create: `src/lib/video/change-request.ts`
- Create: `src/app/api/creatives/video/[id]/change/route.ts`
- Test: `tests/video-change-request.test.ts`

**Interfaces:**
- Produces:
  - `planChange(script: VideoScript, request: string, deps?): Promise<ChangePlan>` where `ChangePlan = { scope: "voiceover" | "scenes" | "concept" | "ad_copy"; scenes: number[]; summary: string; edits: Array<{ scene: number; lines?: SceneLine[]; visual?: string; camera?: string; sound?: string }>; adCopy?: VideoScript["adCopy"]; conceptNote?: string; problem?: string }`
  - `applyChange(script: VideoScript, plan: ChangePlan): VideoScript` (pure; untouched scenes identical; edited scenes re-split if > 15s; retimed; keeps `previous` snapshot one level: `script.previousVersion`)
  - `undoChange(script: VideoScript): VideoScript | null`
  - Route `POST [id]/change` `{ scriptId, request }` → updated project view; `{ scriptId, action: "undo" }`.
  - Concept-scope: route rewrites via `writeScriptForConcept` with `direction = request`.
- [ ] Step 1: tests — voiceover scope rewrites lines of all scenes, visuals unchanged; scenes scope `[2]` changes only scene 2 (others deep-equal); a plan naming scene 9 of 4 → `problem` set and script unchanged; undo restores the exact prior script; operator-edited scene untouched unless named.
- [ ] Step 2: run → FAIL. Step 3: implement (one `generateObject`, temperature 0.4, prompt has full script with numbered scenes and voices). Step 4: PASS.
- [ ] Step 5: commit `feat(video): change the script by saying what to change`.

### Task 5: Fit uploaded concepts and scripts to the model

**Files:**
- Create: `src/lib/video/fit-to-model.ts`
- Modify: `src/lib/video/uploaded-script.ts` (drop `BULK_ANGLES`/`FRAMEWORKS` enums → free text), `src/lib/video/brief.ts` (`writeFromUploadedScript` calls fit; concept-only path)
- Modify: `src/lib/video/projects.ts` (`VideoInputs.conceptText?`), `VideoScript.adaptations?: string[]`
- Test: `tests/video-fit-to-model.test.ts`

**Interfaces:**
- Produces:
  - `fitToModel(script: VideoScript, opts: { maxSeconds: number; repicture?(scenes: Array<{ number: number; visual: string; reasons: string[] }>): Promise<Record<number, string>> }): Promise<{ script: VideoScript; adaptations: string[] }>`
  - `unrenderable(visual: string): string[]` (pure: on-screen text via `textRisk`, real/celebrity names, exact app screens, > 3 people)
  - `conceptFromText(text: string, ctx): Promise<VideoConcept>` (reads the operator's concept into a `VideoConcept`, operator text counts as source)
- [ ] Step 1: tests — 34s scene split into scenes ≤ 15s with words exact and adaptation line "Scene 3 split in two…"; visual "screen shows the dashboard with the words SALE" gets repictured (mock) and reported; 75s script trimmed to ≤ 60s with adaptation note; a fitting script returns no adaptations.
- [ ] Step 2: FAIL. Step 3: implement (split deterministic via `splitLongLine`; repicture by one model call; trim by dropping middle unedited scenes like `trimToFit`). Step 4: PASS.
- [ ] Step 5: commit `feat(video): fit an uploaded concept or script to what the model can make`.

### Task 6: Several voices in generation

**Files:**
- Modify: `src/lib/video/generation.ts` (`voiceAnchors`, clip request), `src/lib/video/clip-prompt.ts` (per-line voices), `src/lib/video/scene-plan.ts` (`VOICE_RULE`, planner input carries voices), `src/lib/video/clip-qa.ts` (expected speakers in the review)
- Test: `tests/video-voices.test.ts`

**Interfaces:**
- Produces:
  - `voiceAnchors(script, clips, clip, now?): Record<string, ClipState>` — per voice id, first earlier fresh succeeded clip where that voice speaks alone.
  - `PlannedClipPromptInput.spoken[n].parts?: Array<{ voiceId: string; who: string; text: string; onCamera: boolean }>`; `PlannedClipPromptInput.voices?: Array<{ id: string; who: string; description: string; videoRef: number | null }>`
  - Single-voice scripts keep today's behaviour exactly (old `voiceAnchor` stays for them).
- [ ] Step 1: tests — two-voice script: clip 3 gets narrator anchor clip 1 and Maya anchor clip 2 as Video 1/Video 2 and the prompt says whose voice each is; a voice without an anchor is described in words only; a clip where both voices spoke is never an anchor; one-voice script prompt unchanged (snapshot of existing test passes).
- [ ] Step 2: FAIL. Step 3: implement (lines go through `applyLexicon` per part). Step 4: PASS.
- [ ] Step 5: commit `feat(video): one voice reference per speaker`.

### Task 7: Remove stats, script inspection and fixed scene templates; planner keeps approved visuals

**Files:**
- Modify: `src/lib/video/scene-plan.ts` (visual is the brief, not "a rough idea"), `src/lib/video/visual-rules.ts` + `clip-prompt.ts` (drop `substituteForScreenShot` use), `src/lib/video/script.ts` (delete `writeVideoScripts`, `buildScripts`, `FRAMEWORKS`, `assignFrameworks` if unused elsewhere), `src/lib/video/pipeline.ts` (plan validation never blocks on script-text issues), `src/lib/video/brief.ts` (`editScripts` silent)
- Test: update affected tests; add `tests/video-no-stats.test.ts` (confirm and generate do not require stats; `statInserts` not in view)
- [ ] Steps: failing tests → implement → `npx vitest run tests/*video*` PASS → commit `refactor(video): drop stats, script inspection and fixed templates`.

### Task 8: Page

**Files:** Modify `src/app/(app)/creatives/video/page.tsx`

- Remove: images upload, "Other stats to show", per-image stat picker, scene "Figure that could be shown"/image select/keywords, `StatInserts`, editorial panel, `FixBar` issues/auto-fix, per-version actions, plan validation list.
- Add: `ConceptCards` (3 cards, Use this concept, Show 3 new concepts + optional feedback, back-to-concepts link from the script), voices list on the script, scene lines with speaker names, "Tell us what to change" box + Undo last change, adaptations list for uploads, upload mode "Your concept (optional)" textarea next to the script.
- [ ] Steps: implement → `npx tsc --noEmit` + `npx eslint` clean → run the app (run skill) and click through concepts → script → change → confirm with demo data → commit `feat(video): concepts, change box and voices on the video page`.

### Task 9: Docs, full suite, review

- [ ] Update `docs/script-generation.md` and `docs/video-pipeline.md` for the new flow.
- [ ] `npx vitest run` (note pre-existing `video-visual-rules` failure if still present), `npx tsc --noEmit`, `npx eslint`.
- [ ] Whole-branch review by a fresh reviewer; fix findings; merge and push.
