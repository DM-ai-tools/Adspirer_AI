# Bulk run: ad copy instructions, a cleaner form, and per-ad copy editing

Date: 2026-11-19. Status: draft for approval.

## Intent and why

In the bulk run the operator cannot tell the system how the **ad copy** should be written (what to include, how to structure it, how long), and the inputs blur two different jobs: instructions for the **images** and instructions for the **ad copy**. Pasted copy only seeds the bodies. A run made from a directions file does not write ad copy at all (it reuses the printed words). After a run there is no way to fix one ad's copy: only the image can be edited.

The operator wants: one clear place for image instructions and one for ad copy instructions; copy that **follows what they wrote**, robustly, across all ads; the same ad copy box working with a directions file; and per-ad editing of the copy once the run is done.

## Goals

- A single **Ad copy instructions** box, common to the whole run, available in both modes (hook run and directions-file run). It is followed as a hard rule: inclusions, structure, length, tone.
- The instructions are **checked**: every ad's copy is verified against them and any ad that misses is rewritten once; an ad that still cannot comply carries a visible note.
- The bulk form separates **Images** from **Ad copy**, with plain labels, so it is obvious where each instruction goes.
- A directions-file run writes ad copy per image from the instructions (when given), the image's picture and printed words, and the page's facts.
- After the run, each ad card has **Edit ad copy** (headline, primary text, description). A hand-edited ad copy is never overwritten by a later image edit.

## Non-goals

- No per-image copy instructions inside the file (one common box only).
- No change to the Quick run, the chat flow, or the video flow.
- No change to image generation or the image/direction rules.
- No per-ad CTA editing (the CTA is chosen at publish time).
- No new claims: copy never invents prices, statistics, awards, guarantees or customers (existing rule stays).

## Anti-goals (failure even if it "works")

- The instruction is silently ignored for some ads (e.g. "under 40 words" met by 12 of 15).
- The operator's printed words (directions file) are reworded by the copy writer.
- An image edit overwrites copy the operator edited by hand.
- A run with no ad copy instructions behaves differently from today.

## Constraints

- Additive where possible; existing bulk tests must pass unchanged. A run without ad copy instructions produces what it does today (hook run: planner as now; directions run: printed words as copy, or pasted copy as primary text).
- Instructions override the planner's built-in length/structure defaults (the field descriptions say "45-90 words", "under 40 characters"); the prompt says so explicitly.
- Meta limits still apply: headline is clipped at 255 and the other publish limits stay as they are.
- Model calls stay bounded: the check and repair add at most 3 calls per run (extract rules, judge, repair) plus, for directions runs, the copy writing in batches.
- Same models/tooling as the planner (`pickModel`, `generateObject`).

## Approaches considered

1. Put the instructions into the writing prompt only. Cheapest, but drifts across 15-30 ads.
2. **Write with the instructions, then check and repair (chosen).** One extra pass verifies every ad against the instructions (including any length number) and rewrites only the misses, once; anything still failing is flagged on its card. Most reliable.
3. Convert the instructions into fixed rules first. Precise for numbers, brittle for loose phrasing; only its length check is borrowed inside approach 2.

The operator chose approach 2, with one common instruction box before the run and per-ad edits after it.

## Design

### 1. The form (bulk page, "new run" tab)

Two clearly labelled sections replace the current mix:

- **Images**: landing page, offer notes (facts the ads may use: audience, proof), style reference and look words, image shape, and the directions file with its confirm list. (The existing "Notes" box is relabelled as facts; the style box keeps its meaning.)
- **Ad copy**: **Ad copy instructions** (new, free text: what to include, structure, length, tone; with a one-line example in the placeholder) and **Copy that already works** (the existing pasted-copy box, moved here and relabelled).

The start request carries `copyInstructions` (max 2,000 characters) in both modes.

### 2. Hook run (no file)

`writeBulkPlan` receives `copyInstructions`. When present they are added to the bodies prompt and to every hook-writing prompt as a binding **AD COPY RULES** block stating that they override any length or structure given elsewhere in the prompt or field descriptions, and that they apply to the headline, the primary text and the description. When absent nothing changes.

### 3. Check and repair (new, shared by both modes)

After the copy exists, when instructions were given:
1. **Read the rules:** one model call turns the instructions into a checklist (inclusions, exclusions, structure points) and any numeric limits (words or characters for headline, primary text, description).
2. **Check:** numeric limits are checked in code; the checklist is judged by one model call over all ads.
3. **Repair:** ads that fail are rewritten in one call that is told exactly what each failed (the printed words of a directions image stay untouched); the result is re-checked in code.
4. **Flag:** an ad still failing gets a note on its card ("Did not fully follow your instructions: <what>") and the run carries on.
The check never blocks a run and never deletes copy.

### 3b. Precedence when rules collide (my call)

In this order: (1) no invented facts, (2) the printed words of a directions image are never changed, (3) the operator's instructions. An instruction that cannot be met without inventing a fact ("always include a price" when no source gives one) or without changing printed words is **not** forced: the ad keeps its best copy and carries the note "Could not follow: <rule>, because <reason>". There is no repair loop on an impossible rule. The ad headline may differ from the on-image headline of a directions image.

### 3c. Copy is per ad, even in a hook run (my call)

A hook run's primary text is already rewritten per hook (the shared body is only its starting point; `body_id` stays as a label for the export). So checking, repairing and editing are per ad; editing one ad never touches another or the shared body. The export's body-reuse columns and publishing read each ad's saved copy.

### 4. Directions-file run

- When **copy instructions are given**, ad copy is written per image, in batches of at most 10 in file order: from the instructions, the image's picture and printed words, the offer notes, the page's facts and any "copy that already works" (as a seed). It never rewords or contradicts the printed words. Then step 3 runs.
- When **no instructions** are given the behaviour is today's: the printed words are the copy; if pasted copy is given it is the primary text of every ad.
- Copy is written **in the background while the images render**; each card shows "Writing copy…" until it is ready, and Meta publishing is unavailable for the whole run until the copy is ready (a run-level state, my call). A copy-writing failure, or a job that has not finished 10 minutes after it started (a restart can kill it), leaves the printed-words copy in place, stops the "Writing copy…" state and says so on the run.

### 5. Editing ad copy after the run

- Each finished card gets **Edit ad copy**: headline, primary text and description, with character counters against the publish limits. Saving updates that ad only. It is separate from editing the image and from the words printed on it.
- The run stores the instructions. An **image edit** that rewrites the copy to match the new image (ordinary bulk ads) is given the same instructions and its result goes through the same numeric-limit check, so the rule still holds after image edits; a note is added when it cannot comply (my call).
- A new route updates one ad's copy (access-checked like the other bulk routes). Refused while that ad's image is still being made.
- The copy the operator edited is marked, and a later **image edit** (which today may rewrite the copy to match the image for ordinary bulk ads) leaves it alone.
- Publishing and export read the saved copy.

### 6. Reporting

The run header says when copy was written to the operator's instructions and how many ads needed repair or still carry a note.

## What is left to the builder

- Field names and storage (run item/run inputs/draft marker) for the instructions, copy status, per-ad notes and the "hand-edited" mark; any migration.
- The exact wording of the prompts for rules, check and repair.
- The charset/limit numbers for the editor counters (headline 255 is fixed by publish; choose sensible primary-text and description limits).
- Extracting the shared "page facts / brief" building out of `planAndRender` so the directions run can reuse it without changing hook-run behaviour.
- Tests; the existing suites must pass unchanged.

## Not verified

Nothing is built. How closely the check follows loosely phrased instructions depends on the model; the visible per-ad note is the safety net.
