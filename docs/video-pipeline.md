# Video ad pipeline: verified brand, planned scenes, inspected clips

How a video ad goes from a script to a file that is allowed to be delivered. Everything below is stored in the existing jsonb columns of `video_projects` (no migration).

## Order of work

1. **Brand manifest** (`brand-resolve.ts`, `brand-manifest.ts`, `brand-page.ts`, `logo-verify.ts`, `claims.ts`). Built before the script is written. Holds the public company name, the original logo (saved untouched under `video/<projectId>/brand/`), colours, offer, CTA and the claims that have a source, each with where it came from. Internal labels (project titles, service names, file names, a client record called "... Internal ... Version 1") are kept in `internalLabels` and can never become the brand name. Blocking issues (`name_missing`, `name_internal`, `name_unverified`, `logo_missing`, `logo_unverified`, ...) stop generation until the operator picks a logo, uploads one, types the name, supplies a landing page, or allows a text-only treatment.
2. **Script** is written from the manifest. Every figure must match an approved claim by value (`sourceClaims`), not by a substring of the page.
3. **Creative plan** (`scene-plan.ts`), made per job from the product, audience, offer, platform, duration and assets, then validated (`validatePlan`) before any clip is paid for: purpose and new information per scene, no repeated room or filler, screens handled as composited verified assets, length derived from the narration. A plan that fails its checks stops the video with the reasons.
4. **Speech** (`pronunciation.ts`). A lexicon decides, in context, how each abbreviation, brand name, currency, percentage or number is said. Display text and speech text are separate; the clip prompt gets the speech text, the captions keep the display text. The video model has no SSML or phoneme support, so only the wording of the spoken text is adapted.
5. **Clips** (`generation.ts`, `clip-prompt.ts`). One reference image per person and per place. The previous clip's last frame is used only when the plan says a scene continues; the previous clip is a voice reference only when the same person speaks in both.
6. **Clip inspection** (`clip-qa.ts`, `pipeline.ts`). Technical checks (freeze, black, silence, A/V length, unplanned cuts), frames read by a vision model (faces, hands, stray text, invented logos, relevance) and the transcript against the speech text. A rejected clip is retried with targeted corrections (new seed), then the shot is redesigned once, then it is reported as not approved. Approved clips are kept. Rejected takes count toward a cost cap (`RETRY_BUDGET_FACTOR` times the estimate).
7. **Assembly** (`assemble.ts`). Captions are cut from the audio through the spoken-to-display mapping (`subtitles.ts`), placed away from the logo, cards and detected faces (`face-bands.ts`), and also written as SRT and VTT. The logo and end card come from the manifest only. The end card is shown long enough to read.
8. **Final inspection** (`final-qa.ts`). The export is inspected again. A wrong or internal brand name, an invented wordmark, a missing logo, an unsupported figure, text in the footage or a wrong CTA is critical and the export is **blocked**: it is kept only for the operator to look at and is never served as the finished video.

## Provider limits (see `capabilities.ts`)

- Narration is generated with each clip, not before the picture, so scene timing comes from the measured speech after generation; clips whose speech is cut off are regenerated with more seconds.
- No SSML, phoneme or pronunciation dictionary; lip-sync is the model's own and is only checked from frames and the transcript.
- Screens are composited flat; perspective tracking is not implemented.
- Frame inspection and text reading use a vision language model (Anthropic first, OpenAI if that call fails). With no vision model the clip or video stays unresolved instead of being approved.
- Speech checks and caption timing need `OPENAI_API_KEY` (Whisper).

## When a clip does not pass its inspection

Every new attempt at a clip is paid for, so nothing is made again on its own. The clip is kept, the video pauses ("Waiting for your decision") and the screen shows what was found and what each choice costs:

- **Make it again** (or **Redesign the shot and make it again**) pays for one more attempt with the corrections. The video's cost cap is raised to cover that attempt and the clips still to come, because the spend was approved.
- **Use this clip as it is** keeps the clip, marks it "Used as it is" and carries on. The findings stay on the clip.
- **Inspect it again** (only when the inspection itself could not run, for example no vision credit) re-checks the same clip and pays for no video.
- **Stop here** stops the video; carrying on from a stop returns to the same decision.

A final export that fails its inspection is still kept out of the download; the screen offers **Use this video anyway**, and a video delivered that way shows the findings above it. Actions: `decide` (clip, choice) and `accept_final` on the generation route.

## Regenerating a video

1. Open the project in Creatives > Video ad. Under **Brand check**, choose "Check the brand". If the project was made without a landing page, open "Fix or change the name and logo" and give the landing page (or the company name and a logo).
2. Confirm the brand, then use **Make again from here** on clip 1, or **New plan, start again** to also make a fresh creative plan.
3. Clips pause after the first for a look (the default); the finished video appears only if the final inspection passes.
