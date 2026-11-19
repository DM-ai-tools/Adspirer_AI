import { generateObject } from "ai";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { logger } from "@/lib/observability/logger";
import { getObjectStorage } from "@/lib/storage/r2";
import { pickModel } from "@/lib/creatives/concept-writer";
import { getCreativeDraftAsync, upsertCreativeDraftAsync, type CreativeDraft } from "@/lib/creatives/drafts";
import { storeDraftImage } from "@/lib/creatives/generate-draft-image";
import { buildEditPrompt, callImageEdit, finishEdit, imageBytes } from "@/lib/creatives/edit-image";
import { generationSize, readAspectMarker, readLogoMarker, readRunMarker, type ImageFormat } from "@/lib/creatives/formats";
import { getRun } from "@/lib/creatives/bulk/runs";
import { copyFromPrint, readDirectedMarker, withDirectedMarker, type DirectedMeta, type PrintLine } from "@/lib/creatives/directed/markers";

/** How many earlier versions of one directed image are kept for undo. */
export const MAX_KEPT_VERSIONS = 5;
/** How many edit instructions are remembered for variations and redraws. */
const MAX_KEPT_EDITS = 10;

const printSchema = z.object({ print: z.array(z.object({ role: z.string().nullable(), text: z.string() })) });

/**
 * The words printed on the image after an edit. When the instruction does not touch the words they are
 * returned exactly as they were; when it does, the new words are exactly what the operator gave. If the
 * model is unavailable the words stay as they were (the image edit still stands).
 */
export async function updatePrintedWords(print: PrintLine[], instruction: string): Promise<PrintLine[]> {
  const model = pickModel();
  if (!model) return print;
  try {
    const { object } = await generateObject({
      model,
      schema: printSchema,
      temperature: 0,
      system: "You keep track of the exact words printed on an ad image. Given the current printed lines and an edit instruction, return the printed lines after the edit. If the instruction does not add, remove or change any printed word, return the lines exactly unchanged. If it does, apply only that change, using the exact words the operator gave (never reword or correct them), and keep the other lines and roles exactly as they are.",
      prompt: `Current printed lines:\n${JSON.stringify(print)}\n\nEdit instruction: ${instruction}`,
    });
    const next = object.print.filter((l) => l.text.trim()).map((l) => ({ role: l.role?.trim() || null, text: l.text }));
    return next.length || !print.length ? next : print;
  } catch (error) {
    logger.warn("Could not check whether the edit changed the printed words", { error: error instanceof Error ? error.message : String(error) });
    return print;
  }
}

/**
 * True when this image's ad copy is not the printed words' to change: it is in a bulk run and either the operator
 * edited that ad's copy by hand or the run's copy was written to the operator's instructions (the ad headline may
 * differ from the printed one). Chat images and runs without instructions keep the ad copy following the words.
 */
async function copyLocked(draft: CreativeDraft): Promise<boolean> {
  const runId = readRunMarker(draft.creative_direction);
  if (!runId) return false;
  const run = await getRun(runId).catch(() => null);
  if (!run) return false;
  return Boolean(run.items.find((i) => i.draft_id === draft.id)?.copy_edited) || Boolean(run.inputs.copyInstructions?.trim());
}

/** Headline (and primary text, only when it was the one made from the printed lines) follow the printed words. */
function copyAfter(draft: CreativeDraft, before: PrintLine[], after: PrintLine[]): Pick<CreativeDraft, "headline" | "primary_text"> {
  const old = copyFromPrint(before);
  const next = copyFromPrint(after);
  return { headline: next.headline, primary_text: draft.primary_text === old.primary_text ? next.primary_text : draft.primary_text };
}

/**
 * Change one thing in a directed image without redrawing it. The current image goes to the image model with
 * "change only this", the exact logo is put back, and the image as it was is kept so the edit can be undone.
 * On failure the original image stays exactly as it was.
 */
export async function editDirectedDraft(
  input: { draftId: string; instruction: string },
  deps: { callEdit?: typeof callImageEdit; updatePrint?: (print: PrintLine[], instruction: string) => Promise<PrintLine[]> } = {},
): Promise<{ ok: boolean; error?: string }> {
  const instruction = input.instruction.trim();
  if (instruction.length < 3) throw new Error("Say what you want changed.");
  const existing = await getCreativeDraftAsync(input.draftId);
  if (!existing) throw new Error("Creative draft not found");
  const meta = readDirectedMarker(existing.creative_direction);
  if (!meta) throw new Error("Only an image that came from a direction can be edited this way.");
  const format = (readAspectMarker(existing.creative_direction) ?? "4:5") as ImageFormat;
  const callEdit = deps.callEdit ?? callImageEdit;
  const updatePrint = deps.updatePrint ?? updatePrintedWords;
  const storage = getObjectStorage();
  const key = `creatives/versions/${existing.id}/${Date.now()}.png`;

  // Callers show the card as working before this runs, so every step from here is guarded: whatever fails,
  // the card goes back to showing the image (or says it has none), never stays "generating".
  try {
    const original = await imageBytes(existing);
    await storage.put(key, original, "image/png");
    await upsertCreativeDraftAsync({ ...existing, id: existing.id, image_status: "generating", image_error: null });
    const hasLogo = Boolean(existing.logo_url);
    const edited = await callEdit(original, buildEditPrompt(instruction, hasLogo), generationSize(format));
    const finished = await finishEdit(original, edited, readLogoMarker(existing.creative_direction));
    const print = await updatePrint(meta.print, instruction);
    const changedWords = JSON.stringify(print) !== JSON.stringify(meta.print);

    const versions = [...(meta.versions ?? []), key];
    const printBefore = [...(meta.printBefore ?? []), meta.print];
    while (versions.length > MAX_KEPT_VERSIONS) {
      const dropped = versions.shift()!;
      printBefore.shift();
      await storage.delete(dropped).catch(() => undefined);
    }
    const nextMeta: DirectedMeta = { ...meta, print, versions, printBefore, edits: [...(meta.edits ?? []), instruction].slice(-MAX_KEPT_EDITS) };
    // Saved onto the draft as it is now: copy written or edited while the edit ran is kept.
    const current = (await getCreativeDraftAsync(input.draftId)) ?? existing;
    const copy = changedWords && !(await copyLocked(current)) ? copyAfter(current, meta.print, print) : {};
    await storeDraftImage({ ...current, ...copy }, {
      b64: finished.toString("base64"),
      imageUrl: null,
      mime: "image/png",
      model: getConfig().OPENAI_IMAGE_MODEL,
      prompt: buildEditPrompt(instruction, hasLogo),
      status: "succeeded",
      error: null,
      revisionNotes: instruction,
      direction: withDirectedMarker(current.creative_direction, nextMeta),
    });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Directed image edit failed", { draftId: input.draftId, error: message });
    // Put the card back from what is stored now (not from the copy read at the start): a draft with an image shows it
    // again; one with none says so. The version file saved for this attempt is removed.
    const current = await getCreativeDraftAsync(input.draftId).catch(() => null);
    if (current) {
      const hasImage = Boolean(current.image_url) || Boolean(current.image_b64);
      await upsertCreativeDraftAsync({ ...current, id: current.id, image_status: hasImage ? "succeeded" : "failed", image_error: hasImage ? null : message }).catch(() => undefined);
    }
    await storage.delete(key).catch(() => undefined);
    return { ok: false, error: message };
  }
}

/** Put back the image (and the printed words) as they were before the last edit. */
export async function undoDirectedEdit(draftId: string): Promise<void> {
  const draft = await getCreativeDraftAsync(draftId);
  if (!draft) throw new Error("Creative draft not found");
  const meta = readDirectedMarker(draft.creative_direction);
  const versions = meta?.versions ?? [];
  const last = versions[versions.length - 1];
  if (!meta || !last) throw new Error("There is no earlier version to go back to.");
  const storage = getObjectStorage();
  const bytes = await storage.get(last);
  if (!bytes) throw new Error("The earlier version is no longer stored.");

  const printBefore = [...(meta.printBefore ?? [])];
  const restoredPrint = printBefore.pop() ?? meta.print;
  const nextMeta: DirectedMeta = { ...meta, print: restoredPrint, versions: versions.slice(0, -1), printBefore, edits: (meta.edits ?? []).slice(0, -1) };
  const locked = await copyLocked(draft);
  await storeDraftImage({ ...draft, ...(locked ? {} : copyAfter(draft, meta.print, restoredPrint)) }, {
    b64: bytes.toString("base64"),
    imageUrl: null,
    mime: "image/png",
    model: null,
    prompt: null,
    status: "succeeded",
    error: null,
    revisionNotes: null,
    direction: withDirectedMarker(draft.creative_direction, nextMeta),
  });
  await storage.delete(last).catch(() => undefined);
}
