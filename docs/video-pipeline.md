# Video ad pipeline: clean video, verified inputs, inspected clips

How a video ad goes from a script to a file that is allowed to be delivered. Everything below is stored in the existing jsonb columns of `video_projects` (no migration).

## What is delivered

**Clean video is the default.** The MP4 is finished footage and sound only: joined clips, levelled audio, a natural ending. Nothing is drawn onto it: no subtitles, highlighted words, logo, headline, stat badge, proof screenshot, web address, call-to-action button or end card.

Beside it, for manual editing, and never inside it:

| File | What it is |
| --- | --- |
| Subtitles (SRT, VTT) | Cut from the final audio through the spoken-to-display mapping, so "26.5 million" stays written that way. No cue runs past the end of the video. |
| Transcript | Each line with its time in the final audio, and how each written term was spoken. |
| Placement plan (text and JSON) | Optional on-screen text (exact wording, start and end, scene, position, alignment, styling, what to watch for), where the logo and each proof image could go, and what an end card could say. Times are on the exported video's own timeline and are worked out again on every export. |
| Original logo and uploaded images | The exact stored bytes, by checksum. |

`clean-mode.ts` holds the rule. `resolveFinishing` returns clean unless `mode: "branded"` is sent by name: flags such as `captions: true` on their own, or a setting kept from an older video, cannot turn a graphic on. The branded path (captions, logo, stats, images, end card burned in) still exists behind that name and has no control on the screen. An export with no `mode` was made before clean video and is shown as an earlier export.

## Why clean has to reach the prompt, not only the render

A video model draws whatever its prompt mentions. The earlier plan put overlay wording into fields that were sent to the model ("Stat overlay ... appears and is legible", "Presenter with composited dashboard asset"), and the model drew captions, a call to action and an invented dashboard into the clips. So the rule is applied where the words are written:

- **Plan** (`scene-plan.ts`, mode `clean`). The planner is told the footage is the whole picture. `requiredAssets` and `overlays` must be empty; suggestions for a person go in `editingNotes`, a field that is never sent to the video model. The validator rejects a footage field that mentions a graphic (`graphic_in_footage`), a screen to read (`text_in_footage`) or a frozen or carded ending (`ending_not_natural`), and sends the plan back before any clip is paid for. Whatever the model still lists as a graphic is moved to `editingNotes` when the plan is normalised.
- **Prompt** (`clip-prompt.ts`, `clean: true`). No "a graphic is added afterwards", no acceptance check that names an overlay, no style clause about a composited asset. The spoken line is passed on exactly, as speech. The last clip carries the natural-close instruction. This also holds for a plan written before clean video existed.
- **Narration** (`standalone.ts`). A line that points at an image ("shown here", "as you can see") is reworded so the video stands on its own, keeping every figure; a rewording that changes or adds a figure is not used. A line that cannot be reworded stops generation with the line named.
- **References**. Only generated people and places, and the previous clip, are ever sent as references. An uploaded image is never sent to the video or image model.

## Order of work

1. **Brand manifest** (`brand-resolve.ts`, `brand-manifest.ts`, `brand-page.ts`, `logo-verify.ts`, `claims.ts`). The verified public name, the original logo, colours, offer, CTA and the claims that have a source. A clean video shows no logo, so a missing or unverified logo does not hold it up; the name still has to be verified, because it is spoken.
2. **Uploaded images** (`assets.ts`, `evidence.ts`). Each is read for its figures, with the label the tool itself prints kept apart from any label added on top, the selected period, added notes, and whether a currency is named. Cautions are raised, shown before generation and written into the placement plan: a figure relabelled by an annotation (conversion value called sales revenue), a time claim the period does not support, a currency symbol with no currency named.
3. **Script**, written from the manifest. Every figure must match an approved claim by value. Keywords, a stat and an image id on a scene are notes for manual editing, not things shown.
4. **Start**. The uploaded files and the logo are snapshotted into the job by id, version, role and SHA-256 (`plan.assets`, `plan.logo`). The job uses the snapshot from then on.
5. **Creative plan**, validated before any clip is paid for.
6. **Speech** (`pronunciation.ts`). Display text and speech text are separate; the clip prompt gets the speech text.
7. **Clips** (`generation.ts`).
8. **Clip inspection** (`clip-qa.ts`, `pipeline.ts`). Technical checks, frames read by a vision model, the transcript against the speech text. Text or a graphic drawn into the footage is critical. A small background detail of the filmed place (not a graphic, not an interface) is noted as minor and does not cause a retry.
9. **Assembly** (`assemble.ts`). Clips are normalised and joined, the sound is levelled and eased out at the very end, the voice is located in the final audio, and the subtitle files, transcript and placement plan are written.
10. **Final inspection** (`final-qa.ts`, `clean: true`). A missing logo, captions or end card is correct. A caption, graphic, logo or card in the picture is critical; so is prominent lettering in the footage. The ending is checked from the last frames and from the audio (cut off mid-word, frozen, or a card).

## Files and storage

Files are kept in a private Supabase Storage bucket (`app-files`) through `getObjectStorage()` (`src/lib/storage/r2.ts`) whenever Supabase is configured with a service-role key and the app is not in demo mode. They outlive a restart or redeploy and are the same for every server instance. A dropped connection is retried; a store that cannot be reached is an error and is never reported as a missing file. With no Supabase the app falls back to the server's own disk (`.data/storage`), logs an error in production, and the screen warns that files would be lost on a restart.

Files are served only by the app's own authorised routes, read from storage on each request. No public or expiring address is stored or handed out.

- A file is identified by its id, version and checksum, never by its name or an address.
- `loadOriginal` refuses a missing file or one whose checksum no longer matches the snapshot. Nothing is substituted.
- The logo has five separate states (`logoState`): name verified, logo found, logo saved, logo file readable, approved by the operator. It is shown as present only while the file can be read. A lost file is put back from the operator's upload or its source address only when what comes back is the same file.

## Inspection results and the operator's override

Three states are kept apart (`checkStatus`): **passed**, **issues detected**, **approved by you despite warnings**.

- A clip that fails its inspection waits for the operator: make it again (the cost is stated), use it as it is, inspect it again, or stop. Nothing is made again on its own.
- A final export that fails is kept out of the download until the operator chooses **Use this video anyway**.
- Either approval records who, when and exactly which findings were open (`override`). The findings stay on the clip or the video, and an approved result is never shown as having passed. Only the operator's request does this.

## Provider limits (see `capabilities.ts`)

- Narration is generated with each clip, not before the picture, so scene timing comes from the measured speech after generation; a clip whose speech is cut off can be made again with more seconds.
- No SSML, phoneme or pronunciation dictionary; lip-sync is the model's own and is only checked from frames and the transcript.
- The video model has no setting that guarantees text-free footage. It is asked for in the prompt and then checked; a clip that still contains text is caught by the inspection.
- Clips are joined with straight cuts. There is no colour matching between clips and no music bed.
- Frame inspection uses a vision language model (Anthropic first, OpenAI if that call fails). With no vision model the clip or video stays unresolved instead of being approved.
- Speech checks, subtitle timing and the timed parts of the placement plan need `OPENAI_API_KEY` (Whisper). Without it the files are still written and say that their timing is estimated.

## Regenerating a video

1. Open the project in Creatives > Video ad. Under **Brand check**, choose "Check again" if the logo file cannot be loaded.
2. Use **Make again from here** on clip 1, or **New plan, start again** to also make a fresh creative plan. New footage is always clean footage.
3. To get a clean export from clips that already exist, choose **Finish it again as a clean video**. This removes what the app drew on top; text the video model drew inside a clip is still there until the clip is made again.
