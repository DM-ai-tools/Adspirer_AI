# Exact-direction images (Workspace chat + bulk run)

Date: 2026-11-19. Status: draft for approval.

## Intent and why

Today an image request in the Workspace chat goes to the concept writer, which invents 4 concepts from the brand and landing page. The operator's wording is only a loose "reference note", so the result is never exactly what they described. The concept writer works very well for open requests and **must not change**.

The operator wants a second, additive way to work: they write the creative idea and direction themselves, containing both a **picture instruction** and the **exact words to print**, and get **one** image that follows it exactly. They want to edit that image afterwards, and get 4 versions only when they ask for variations. In the bulk run they want to upload a file holding all 15 directions (or however many it has) and have each image follow its own direction, each different.

This is for flexibility, not a replacement.

## Goals

- In the Workspace chat, a message that contains a direction produces exactly one image that follows the picture instruction, with the printed words reproduced word for word.
- The generated image can be edited afterwards (change one thing, leave the rest), and the edit can be undone.
- "Variation(s)" produces 4 close versions of that image; nothing else ever produces more than one.
- Bulk run: upload a directions file, see the parsed directions, confirm, then one image per direction, in order.

## Non-goals

- No change to `concept-writer.ts` or to what the existing Quick run, chat concept flow and bulk-without-file produce.
- No new copy writing: in direction mode nothing is invented (no extra slogans, claims or text).
- No change to the video flow.

## Anti-goals (failure even if it "works")

- The existing concept flow changes behaviour for any message that has no direction.
- Printed words are reworded, corrected, shortened or added to.
- The assistant guesses that a loose request is a direction and quietly skips the concept writer.
- A run of N directions produces fewer or more than N images, or images in a different order from the file.

## Constraints

- Additive: new modules for the direction path. Shared code (`generate-draft-image.ts`, `drafts.ts`, `openai-image.ts` `buildBrandImagePrompt`, `edit-image.ts`, `variations.ts`) may only gain a branch for directed drafts; behaviour for every other draft stays identical and the existing tests must pass unchanged.
- Routing is decided by an LLM reading the message (the operator's standing preference), not by keyword rules. When it is unsure it asks one short question instead of guessing.
- Same image model, brand logo and palette handling, formats (4:5, 9:16, 1:1) and cost behaviour as today's images.
- Bulk: one run at a time per client (existing rule); the run still renders at the existing concurrency; files up to the existing 10 MB document limit.

## Approaches considered

1. **Assistant detects a direction in the message (chosen).** An LLM step decides "direction" vs "open request" per message. No UI switch to forget; follows the operator's routing preference. Risk: misreading a loose request; mitigated by asking when unsure.
2. A switch next to the chat box ("Exact direction"). Predictable but easy to forget, and forgetting gives 4 invented concepts. Rejected.
3. Make the concept writer obey directions. Rejected: the operator wants it untouched.

The operator picked approach 1, and "yes" to the bulk file formats and the confirm step.

## Design

### 1. Direction detection (chat)

A new step in the chat task flow, before `startCreativeGeneration` is called. The model is given the operator's message (and the last few turns, and whether an image from this chat already exists) and returns:

- `mode`: `directed` (the message carries a picture instruction and/or words to print), `open` (a general request), `variations` (asks for variations of an existing image), `edit` (asks to change an existing image), or `unsure`.
- For `directed`: `picture` (the picture instruction, as written, minimally tidied), `print_text` (the words to print, verbatim, with their roles if stated: headline, sub-line, button, etc.), `format` if stated (otherwise the chat's current default).
- `open` falls into the existing flow untouched. `unsure` makes the assistant ask one short question.

**Where the line is (decided):** a message that says what to draw (a picture idea), with or without printed words, is `directed`. A message that only hands over a headline or copy ("make ads, headline 'X'") stays `open` and goes to the existing concept flow, which already handles supplied copy. When the model cannot tell, mode is `unsure` and the assistant asks one short question.

A direction that has a picture instruction but no printed words prints no words.

**Several directions in one message (decided):** the model returns a list of directions. One image is made per direction, up to 5 per message; more than 5 is pointed to the bulk file. A single direction with "give me 3 images of this" makes 1 image and tells the operator they can ask for variations; it never makes extras on its own.

**Edit and variations target (my call):** the card the operator clicks; when typed in chat, the most recent directed image of this chat. If the latest image is an open-flow concept, the existing rework and "More like this" behaviour applies unchanged.

### 2. The directed image

A new prompt builder (separate from `buildBrandImagePrompt`) states: draw exactly this picture; print exactly these words, spelled exactly, nowhere else any text; honour the requested format.

**Direction versus brand (decided):** the direction wins on anything it names (colours, style, logo position, background). Anything it does not name uses the brand palette and the brand logo exactly as existing images do. The "top agency polish" craft/style push of `buildBrandImagePrompt` is not used (it fights exactness); the legibility and exact-spelling rules are kept, plus a short realism/anatomy line. A directed draft is marked so every other module can tell (marker in `creative_direction`, like the existing aspect/run markers). It stores the picture instruction and the printed words separately so edits and variations can reuse them. Exactly one draft is created. The draft appears in the chat's existing creative card.

### 3. Editing

The card gets an "Edit" action beside the existing rework. It uses the existing "change only this" edit (send the image and the instruction, put the exact logo back, keep prior versions, allow undo), extended so it works on a chat draft and not only on a bulk run item. If the instruction changes the printed words, the stored printed words are updated to the new wording. The operator can also just ask in chat ("make the background darker"); detection returns `edit` for the latest directed image.

### 4. Variations

"Variations" (button or typed) on a directed draft creates 4 new drafts: same picture instruction and the same printed words verbatim, with one small layout change each (position of subject/text, crop, which brand colour leads). This differs from the existing "More like this" (which rewords the text): printed words here never change. No other path creates more than one image.

### 5. Bulk run with a directions file

- The bulk page gets a "Directions file" upload next to the existing style box. Accepted: txt, md, csv, docx, pdf, xlsx (any layout). Text is extracted with the existing document extraction (txt is read directly; the existing extractor does not list it).
- An LLM splits the text into one item per direction, each with `picture` and `print_text`, **in file order**, never merging or dropping items; if a row/section has no clear picture instruction it is still an item (picture left to the brand look) and flagged. Lenient parsing, like the existing uploaded-script reader: it never fails on shape, it flags what it was unsure of.
- **Confirm step:** the page shows the parsed list ("Image 1: picture…, words…") with the ability to edit any item's text and remove or add an item, before anything renders. Nothing is spent until the operator confirms.
- On confirm, a run is created with N items (N = number of directions; at most 30 to bound cost, my call) using the existing run machinery (placeholders, renderer, concurrency, history, export, edit/undo). The planner that writes hooks from angles is **not** called; each item's draft is filled directly from its direction, so the printed words are exactly the file's.
- Ad copy for publishing (decided): use the operator's pasted copy if they gave any. Otherwise the headline is the words marked as the headline (or the first printed line), and the primary text is the rest of the printed words (blank when there is only one line). The planner is not used to invent copy. The builder checks that publish and export accept a blank primary text.
- **Limits (decided):** nothing is ever cut off silently. A file with more than 30 directions is refused with a message to split it. Items the parser was unsure about are highlighted in the confirm step; the operator can edit or remove them, and they do not block confirming.
- Without a file the bulk run behaves exactly as today.

### 6. Reporting

Chat replies say plainly what was done ("Made 1 image from your direction", "Making 4 variations of it"). Failures say which image failed and why.

## What is left to the builder

- Exact marker format, where printed words are stored, and the migration if a column is needed.
- The detection prompt and the schema details; the "unsure" question wording.
- How the Edit action reaches chat drafts (route shape, version storage) while keeping bulk behaviour unchanged.
- The confirm-step UI layout, the file size limit beyond the existing 10 MB, and tests (the existing suites must pass unchanged).
- How runs of N≠15 appear in the existing bulk summary/monthly target counters.

## Not verified

None of this is built. Image quality of "exactly as written" depends on the image model; long printed text may still be mis-spelled by the model, so the design keeps words short per image and relies on the edit action to correct them.
