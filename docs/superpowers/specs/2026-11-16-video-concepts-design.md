# Video concepts first, scripts on approval — design

Date: 2026-11-16 · Area: Creatives › Video ad (`/creatives/video`, `src/lib/video/*`)

## Intent

Rithin wants the video tool to come up with excellent, unique video ideas — something that plays like a
movie scene, a trailer, a story with a twist — instead of a generic scene list wrapped around a script.
The operator should see the ideas first, pick one, then get a strong full voiceover and scene list, and
change any of it by just saying what they want. Operators who bring their own concept or voiceover should
have it adapted to what the video model can really make, instead of being blocked. Stats are no longer
shown in the video, so everything that asks for or forces stats goes. Only the video itself is inspected.

## Goals

1. **Concepts first.** "Write the script for me" produces **3 concept summaries**, clearly different from
   each other. The operator picks one (or asks for 3 new ones). Only then is the full script written.
2. **Concepts are invented, not templated.** No fixed list of concepts, angles or frameworks feeds the
   writer. The video type the operator picks steers the *format*; the idea inside it is the model's own,
   fresh each time, and never a repeat of a concept already made for the same client.
3. **Full script on approval:** voiceover + scenes written from the chosen concept, faithful to it.
4. **Change by asking.** After the script exists, one box: "Tell us what to change". The request may be about
   the whole voiceover, one or more scenes, the tone, the ending, the length. It is understood and applied
   to just what it is about; the rest stays word for word. Direct editing of any field stays.
5. **Own script, adapted.** "I have the script" accepts a concept, a voiceover, or both. The app fits it to
   the model: length, scene/clip sizes, things the model cannot render. It says what it adapted and why.
6. **No stats.** Remove the stat fields and every rule that forces a stat into the voiceover or blocks on one.
7. **Only video inspection.** Remove the voiceover inspection and the scene inspection from the script step.
   Clip inspection and final-video inspection stay exactly as they are.

## Non-goals

- No live trend data from the web. "Viral" means the model writes in formats and with hooks that make
  people stop and share (cinematic, trailer, twist, POV, absurd escalation, etc.) — chosen by the model.
- No change to clip/final inspection, brand check, logo/subtitle finishing, cost caps. Clip generation
  changes only for several voices (§8).
- Not putting images or stat graphics into the video.

## Anti-goals (failure even if it "works")

- Concepts that read like the old output: someone at a desk with a laptop, a talking head listing benefits,
  "Tired of X? Meet Y."
- Three concepts that are the same idea in different clothes.
- Concepts the model cannot render (on-screen text, real celebrities, exact UI screens, a 12-character cast,
  scenes longer than a clip) — a beautiful summary that turns into a broken video.
- Invented facts about the brand: prices, offers, results, guarantees, customers. Fiction is fine for the
  story (characters, situations); claims about the business stay true to the brief.
- A change request that silently rewrites parts the operator did not mention.

## Constraints (from the code and the model)

- Video model limits (`seedance.ts` `SEEDANCE_SPECS`, `capabilities.ts`): clip 4–30s (2.5) / 4–15s (2.0);
  video max 60s (`script.ts`); no readable text in the picture; real faces cannot be references, so people
  are invented characters made by Seedream; voice comes from the video model; scenes are split into clips on
  scene boundaries only, so no scene may be longer than one clip.
- Words → seconds: about 2.5 words/sec (`duration.ts`, `timing.ts`).
- The fact-checked creative brief (`buildCreativeBrief`) and brand manifest stay the source of truth for
  anything said about the business. Thin sources still stop at `needs_context`.
- Model calls go through `withModelFallback` (Anthropic → OpenAI).

## Approaches considered

1. **New concept stage on the existing brief; one full script for the chosen concept; one change box;
   a fit-to-model step for own scripts. Keep brand, generation and inspection as is.** ← chosen.
   Reuses the fact-checked brief and everything after confirm; changes are concentrated in the
   script stage and the page.
2. Replace the whole script stack with one new "writer" agent. Simpler to describe, but throws away the
   claim/brand safeguards that took several rounds to get right.
3. Keep writing 3 full scripts and add summaries on top. Still pays for 3 scripts nobody picked, and does
   nothing about generic ideas.

Rithin chose 3 concepts at the summary step; the approach (1) is my call, as they handed over the how.

## The design

### Flow — "Write the script for me"

```
form ─▶ brief (as today) ─▶ concepts: invent ~8 ─▶ judge ─▶ 3 shown ─▶ pick
                                                  ▲                       │
                                    "3 new concepts" (avoid all shown)    ▼
                                         full script for the chosen concept
                                                  │
                         "Tell us what to change" (repeatable) + direct edits
                                                  │
                                       confirm ─▶ brand check ─▶ video (as today)
```

Project status gains `concepts_ready` (between `writing` and `scripts_ready`).

### 1. Concept stage (new `src/lib/video/concepts.ts`)

**Invent.** One call (high temperature) with: the creative brief (facts, audience, pains, offer as sourced),
the video type and its format note, the operator's idea/instructions, target length, the model limits in
plain words, and the loglines of concepts already made for this client (to avoid). Ask for ~8 candidates,
each in a *different* format and emotional register, invented by the model (the prompt lists no fixed set of
concepts or angles). Each candidate:

- `title` (2–5 words), `format` (the model's own words: "faux movie trailer", "heist scene", …)
- `logline` — one sentence, the whole idea
- `hook` — what happens in the first 2 seconds that stops the scroll
- `story` — 3–6 beats, in plain words, each with roughly how long it runs
- `why_it_works` — one line: why someone would watch to the end or share it
- `brand_link` — how the story lands on the brand's real message (which brief fact it carries)
- `look` — mood, light, camera style, colour
- `cast` and `settings` — who and where (counts matter for rendering)
- `voice` — narrator / character dialogue / mixed, and the voice's feel
- `seconds` — planned length

**Judge.** A second call (low temperature) scores every candidate 1–10 on: originality (vs. the generic
anti-goal list and vs. the client's past concepts), hook strength, emotional pull, clarity of the brand link,
renderability under the model limits (no on-screen text, ≤ 3 recurring characters, ≤ 4 settings, every beat
fits one clip), and truth (nothing claimed about the business beyond the brief). Any candidate with a truth
or renderability score below a floor is dropped. Then the 3 highest that are also far apart (different
format and register; the judge marks near-duplicates) are kept. If fewer than 3 survive, one more invent
round runs with the reasons; if still short, show what survived.

**Show.** A card per concept: title, format, logline, hook, the story beats, look, cast/settings, voice,
length, "why it works". Buttons: **Use this concept**, and below all three **Show 3 new concepts**
(optional "what to do differently" text). Concepts are stored on the project (`concepts`, plus
`shownConcepts` loglines for avoidance and for the client's history).

**Client history.** Loglines of concepts shown for the same client (last ~30) are read from earlier
projects and passed as "do not repeat these ideas".

### 2. Full script for the chosen concept

The existing per-angle writer (`script-writer.ts`) is reworked to write **one** script from a concept
instead of an angle: scenes follow the concept's beats; each scene has the voiceover line (or dialogue),
speaker, visual, camera, sound, setting and characters from the concept. Word budget and length fitting
stay. The editorial pass may still run silently to polish wording, but nothing it finds is shown and
nothing blocks (see §5). Brand-truth repairs (`script-repairs.ts`) stay.

The script card shows the concept summary at the top, then the voiceover (read as one piece) and the scene
list.

### 3. "Tell us what to change"

One free-text box under the script (repeatable). A call reads the request with the full script and returns
an edit plan: which scope (`voiceover` — all lines; `scenes` — listed scene numbers; `concept` — the idea
itself changes) and the new content for just those parts. Applied in place; every untouched line stays
byte-for-byte. The app shows one line on what it changed ("Rewrote scenes 2 and 4 to end on the chase;
voiceover unchanged"). A `concept`-scope request rewrites the whole script from the amended concept and
says so. The previous version is kept so the operator can undo the last change.

This replaces the per-scene "Rewrite this scene with my feedback / Fix the problems automatically" and the
per-version actions (regenerate / same angle / different angle / retime). Direct edits of any field stay;
an edited scene is respected by later change requests unless the request names it.

### 4. "I have the script" — adapt to the model

Input: a concept, a voiceover, or both (text or file), plus optional "changes you want".

1. Structure as today (`structureUploadedScript`: scenes, words kept exactly).
2. If only a concept was given, write the voiceover and scenes from it (same writer as §2, the operator's
   concept treated as the chosen concept). If only a voiceover, invent visuals that serve it.
3. **Fit to the model** (new step): check total length against the target (default: the script's own length,
   capped at 60s), each scene against the clip limit, and each visual against what the model can render.
   Fix by the smallest change: split a long scene, re-picture an unrenderable visual (text on screen → an
   action that shows it; a real celebrity → an invented character of that type; exact app screens → a
   person reacting), and, only when over 60s, trim words — with the operator's words kept wherever possible.
   Report each adaptation in a short list ("Scene 3 split in two: 34s is longer than one clip").
4. The change box (§3) works here too.

The fixed enums (`BULK_ANGLES`, `FRAMEWORKS`) are removed from upload mode; the model describes the
script's angle/format in its own words.

### 5. Removed

- **Stats.** "Images to use in the video" upload, "Other stats to show", the per-image main-stat picker,
  scene "Figure that could be shown", "Stats to insert in editing" card; `pickMainStat`/`ensureMainStats`
  forcing, the editorial hard-failure for a missing stat, the confirm block on unsaid stats. (Images are only
  used to find stats today, so the upload goes with them.)
- **Voiceover and scene inspection.** The editor panel on script cards ("Must fix", issue list, ratings
  note), per-scene issue lists and auto-fix, and the plan validation issues shown before generation. None
  of these block confirm or generate any more. Brand check, clip inspection and final-video inspection stay.
- **Hardcoded concept material.** Legacy `writeVideoScripts`/`FRAMEWORKS`/`buildScripts` in `script.ts`;
  `substituteForScreenShot` fixed desk/laptop shot; angle/format enums in upload mode. `VIDEO_TYPES` stays
  as the operator's format picker, but its text is a short format note, not a scene template.
- The angle stage (`planAngles`) is replaced by the concept stage for the generated path.

### 6. Planner respects the approved script

`scene-plan.ts` currently treats a scene's visual as "a rough idea you may replace". After this change the
approved scene's visual is the brief: the planner adds shot detail (framing, lens, motion, continuity) but
keeps what happens in the scene.

### 7. Calls made after the builder check (mine, open to correction)

- **Going back to concepts.** Yes. The three shown concepts stay on the project; the operator can pick
  another or ask for 3 new ones at any time before confirm. Each concept tried keeps its own script as a
  version (`scripts[]` holds one per concept tried), so nothing written is thrown away. Status may go back
  from `scripts_ready` to `concepts_ready`.
- **Figures in the voiceover.** Never forced, never asked for. The writer may still say a number when it is
  a sourced fact in the brief (page, offer details, instructions) and it serves the story. Old projects keep
  their `inputs.stats` claims as they are; new projects simply no longer collect them.
- **Concept-only upload.** Writes from the operator's concept plus whatever brief can be built; the
  operator's own text counts as a source (as `operatorClaims` already does for uploaded scripts), so a thin
  page never stops it at `needs_context`. Anything said about the business that is in neither the operator's
  text nor the brief is still not invented.

### 8. Decided by Rithin after the builder check

**Scene cap: 15 seconds.** No scene in a concept beat, a written script or an adapted upload may run
longer than 15s, so every Seedance model (and the cheaper ones) stays available. The judge treats a beat
over 15s as unrenderable; the writer and the upload adaptation split anything longer.

**Several voices.** A concept may have up to 3 speaking voices: a narrator and/or characters who talk,
including dialogue between them. Today one voice is forced for the whole ad (`voiceAnchor`, plan `voice`,
`VOICE_RULE`, one `speaker` + `line` per scene), so this reaches into generation:

- *Script model.* The script gets `voices: [{ id, who, description }]` (≤ 3; `who` is "narrator" or a
  character). A scene's speech becomes `lines: [{ voiceId, text, onCamera }]` (in spoken order); `line` and
  `speaker` remain derived for old readers. Old scripts load as one voice.
- *Concepts and writer.* The concept's `voice` lists its voices. Renderability rules: ≤ 3 voices; each voice's
  first appearance is a scene where it speaks alone (so it has a clean reference); at most 2 voices in one
  scene; lines short enough to fit the scene.
- *Plan.* `voice` becomes `voices[]` with one fixed description each (gender, age, timbre, accent, pace),
  repeated word for word in every clip where that voice speaks. `VOICE_RULE` changes to "one fixed voice per
  speaker".
- *Generation.* One voice anchor **per voice**: the first finished clip where that voice speaks alone. Later
  clips get each speaking voice's reference, labelled ("Lines by Maya are in exactly the voice of
  Audio 1"); the reference is that clip's audio (extracted with ffmpeg) where the model takes audio
  references, otherwise the clip itself as now. Within the model's reference limits (2.0: 3 audio refs —
  enough for 3 voices). On-camera lines say who speaks; others keep their mouths closed (existing rule).
- *Inspection.* Clip inspection gets one more check: each line is spoken by the right person/voice.
- *Risk.* None of this has run on live Seedance. Before relying on it: one paid test video with two voices
  to see whether per-voice references hold. If the references do not hold, the fallback is the current
  single-voice behaviour for that video, with a note to the operator.

## Left to the builder

- Exact prompt wording, temperatures, scoring floor values, and the candidate count (≈8).
- Storage shape for concepts on the project (JSON on the project row like scripts today), and the migration if
  a new column is needed.
- How the "undo last change" is stored (previous script snapshot).
- Tests: concept judge keeps 3 distinct and drops unrenderable/untrue ones (mocked model); change requests
  touch only their scope; upload adaptation splits long scenes and reports it; confirm no longer blocks on
  stats or editorial issues; removed fields are gone from the page.
