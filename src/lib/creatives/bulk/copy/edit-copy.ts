import { getCreativeDraftAsync, isRenderStalled, upsertCreativeDraftAsync, type CreativeDraft } from "@/lib/creatives/drafts";
import { getRun, updateRun } from "@/lib/creatives/bulk/runs";
import { copySummary } from "@/lib/creatives/bulk/view";
import { COPY_FIELD_LIMITS } from "@/lib/creatives/bulk/copy/rules";

const LABEL = { headline: "Headline", primary_text: "Primary text", description: "Description" } as const;

/**
 * Save the operator's own edit of one ad's copy. Only the fields given change, only on that ad: every other ad and
 * the shared body are untouched. The ad is marked hand-edited (a later image edit never rewrites its copy) and its
 * "did not follow your instructions" note is cleared, because the words are now the operator's.
 */
export async function saveAdCopy(input: { runId: string; draftId: string; headline?: string; primary_text?: string; description?: string | null }): Promise<CreativeDraft> {
  const run = await getRun(input.runId);
  if (!run) throw new Error("Run not found");
  if (!run.items.some((i) => i.draft_id === input.draftId)) throw new Error("That ad is not part of this run.");
  // The copy job saves every ad when it finishes; an edit made meanwhile would be overwritten or would lose the job's save.
  if (copySummary(run)?.status === "writing") throw new Error("The ad copy is still being written. Edit it when it is ready.");
  const draft = await getCreativeDraftAsync(input.draftId);
  if (!draft) throw new Error("Creative draft not found");
  if (draft.image_status === "generating" && !isRenderStalled(draft)) throw new Error("This ad's image is still being made. Edit its copy when it appears.");

  const next: { headline?: string; primary_text?: string; description?: string | null } = {};
  if (input.headline !== undefined) next.headline = input.headline.trim();
  if (input.primary_text !== undefined) next.primary_text = input.primary_text.trim();
  if (input.description !== undefined) next.description = input.description === null ? null : input.description.trim() || null;
  if (!Object.keys(next).length) throw new Error("There is nothing to save.");

  for (const field of ["headline", "primary_text", "description"] as const) {
    const value = next[field];
    if (typeof value === "string" && value.length > COPY_FIELD_LIMITS[field]) {
      throw new Error(`${LABEL[field]} is ${value.length} characters; the most it can be is ${COPY_FIELD_LIMITS[field]}.`);
    }
  }

  const saved = await upsertCreativeDraftAsync({ ...draft, id: draft.id, ...next });
  const items = run.items.map((item) => (item.draft_id === input.draftId ? { ...item, copy_edited: true, copy_note: null } : item));
  await updateRun(run.id, { items });
  return saved;
}
