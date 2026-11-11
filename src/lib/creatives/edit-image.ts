import { getConfig } from "@/lib/config";
import { logger } from "@/lib/observability/logger";
import { getObjectStorage } from "@/lib/storage/r2";
import { getCreativeDraftAsync, upsertCreativeDraftAsync, type CreativeDraft } from "@/lib/creatives/drafts";
import { generateImageForDraft, storeDraftImage } from "@/lib/creatives/generate-draft-image";
import { generationSize, readAspectMarker, readLogoMarker, readRunMarker, type ImageFormat } from "@/lib/creatives/formats";
import { getRun, updateRun, type ImageVersion, type RunItem } from "@/lib/creatives/bulk/runs";
import { resolveEditInstruction } from "@/lib/creatives/resolve-instruction";

/**
 * Changing one thing in an image without redrawing it.
 *
 * "edit" sends the existing image to the image model with the instruction and tells it to change
 * only that. The exact logo is then put back from the original (the model may blur or move it), so
 * the brand mark never drifts. "full" regenerates from the same brief with the feedback.
 * Either way the image as it was is kept, so the edit can be undone.
 */

/** How many earlier versions of one image are kept. */
const KEEP_VERSIONS = 5;

export function buildEditPrompt(instruction: string, hasLogo: boolean): string {
  return [
    "Edit this existing ad image.",
    `Make ONLY this change: ${instruction.trim()}`,
    `Everything else must stay exactly as it is: the composition, every other word and number (spelled exactly as they are now), the colours, the people and objects, the lighting and the style${hasLogo ? ", and the logo with its position" : ""}.`,
    "Do not redraw, restyle, move, add or remove anything that was not mentioned. If the change involves text, use exactly the wording given and spell it correctly. Keep the same size and shape.",
  ].join(" ");
}

async function imageBytes(draft: CreativeDraft): Promise<Buffer> {
  const full = await getCreativeDraftAsync(draft.id, { withImageData: true });
  const b64 = full?.image_b64 ?? (full?.image_url?.startsWith("data:") ? full.image_url.split(",")[1] : null);
  if (b64) return Buffer.from(b64, "base64");
  const url = full?.image_url;
  if (url && /^https?:\/\//i.test(url)) {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
  }
  throw new Error("This image is not available to edit.");
}

/** Call the image model's edit endpoint. Asks for the highest fidelity to the input; retries without if that option is refused. */
export async function callImageEdit(image: Buffer, prompt: string, size: string): Promise<Buffer> {
  const config = getConfig();
  if (!config.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not configured");
  const send = async (withFidelity: boolean) => {
    const form = new FormData();
    form.set("model", config.OPENAI_IMAGE_MODEL || "gpt-image-2");
    form.set("prompt", prompt);
    form.set("size", size);
    form.set("quality", config.OPENAI_IMAGE_QUALITY ?? "high");
    form.set("n", "1");
    if (withFidelity) form.set("input_fidelity", "high");
    form.append("image[]", new Blob([new Uint8Array(image)], { type: "image/png" }), "ad.png");
    const res = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.OPENAI_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(240_000),
    });
    const body = (await res.json().catch(() => null)) as { data?: Array<{ b64_json?: string; url?: string }>; error?: { message?: string } } | null;
    return { res, body };
  };
  let out = await send(true);
  if (!out.res.ok && /input_fidelity|unknown parameter|unrecognized/i.test(out.body?.error?.message ?? "")) out = await send(false);
  if (!out.res.ok) throw new Error(out.body?.error?.message || `The image edit failed (${out.res.status}).`);
  const first = out.body?.data?.[0];
  if (first?.b64_json) return Buffer.from(first.b64_json, "base64");
  if (first?.url) return Buffer.from(await (await fetch(first.url, { signal: AbortSignal.timeout(30_000) })).arrayBuffer());
  throw new Error("The image edit returned no image.");
}

/** Same size as the original, with the exact logo pixels from the original put back where they were. */
export async function finishEdit(original: Buffer, edited: Buffer, logoBox: { left: number; top: number; width: number; height: number } | null): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const meta = await sharp(original).metadata();
  const width = meta.width ?? 1024;
  const height = meta.height ?? 1024;
  let image = sharp(edited);
  const editedMeta = await image.metadata();
  if (editedMeta.width !== width || editedMeta.height !== height) image = image.resize(width, height, { fit: "fill" });
  const base = await image.png().toBuffer();
  if (!logoBox) return base;
  const box = {
    left: Math.min(Math.max(logoBox.left, 0), width - 1),
    top: Math.min(Math.max(logoBox.top, 0), height - 1),
    width: Math.max(1, Math.min(logoBox.width, width - logoBox.left)),
    height: Math.max(1, Math.min(logoBox.height, height - logoBox.top)),
  };
  const logo = await sharp(original).extract(box).png().toBuffer();
  return sharp(base).composite([{ input: logo, left: box.left, top: box.top }]).png().toBuffer();
}

async function runItem(draft: CreativeDraft): Promise<{ runId: string; items: RunItem[]; index: number } | null> {
  const runId = readRunMarker(draft.creative_direction);
  if (!runId) return null;
  const run = await getRun(runId);
  if (!run) return null;
  const index = run.items.findIndex((i) => i.draft_id === draft.id);
  return index < 0 ? null : { runId, items: run.items, index };
}

async function saveVersion(draft: CreativeDraft, bytes: Buffer, instruction: string, mode: "edit" | "full"): Promise<ImageVersion> {
  const key = `creatives/versions/${draft.id}/${Date.now()}.png`;
  await getObjectStorage().put(key, bytes, "image/png");
  return { id: `v_${Date.now()}`, key, at: new Date().toISOString(), instruction, mode };
}

async function recordVersion(draft: CreativeDraft, version: ImageVersion | null, error: string | null): Promise<void> {
  const found = await runItem(draft);
  if (!found) return;
  const items = found.items.map((it, i) => {
    if (i !== found.index) return it;
    const versions = version ? [...(it.versions ?? []), version].slice(-KEEP_VERSIONS) : (it.versions ?? []);
    return { ...it, versions, edit_error: error };
  });
  await updateRun(found.runId, { items });
}

export type EditMode = "edit" | "full";

/**
 * Edit or regenerate one image of a bulk run. The draft shows as rendering while this runs; on
 * failure the original image stays exactly as it was and the reason is recorded.
 */
export async function editImage(input: { draftId: string; instruction: string; mode: EditMode }): Promise<{ ok: boolean; error?: string }> {
  const existing = await getCreativeDraftAsync(input.draftId);
  if (!existing) throw new Error("Creative draft not found");
  const instruction = input.instruction.trim();
  if (instruction.length < 3) throw new Error("Say what you want changed.");
  const format = (readAspectMarker(existing.creative_direction) ?? "4:5") as ImageFormat;

  const original = await imageBytes(existing);
  const version = await saveVersion(existing, original, instruction, input.mode);
  await upsertCreativeDraftAsync({ ...existing, id: existing.id, image_status: "generating", image_error: null });
  await recordVersion(existing, null, null);

  try {
    // The image model cannot open a web page. When the instruction points at the landing page (or a
    // pasted link), read it and swap in the real words and numbers before the image model sees it.
    const resolved = await resolveEditInstruction({
      instruction,
      mode: input.mode,
      landingPageUrl: existing.landing_page_url,
      headline: existing.headline,
      primaryText: existing.primary_text,
      creativeDirection: existing.creative_direction,
    });
    const change = resolved.instruction;
    if (input.mode === "full") {
      const result = await generateImageForDraft(existing.id, undefined, change, format);
      if (result.imageStatus !== "succeeded") throw new Error(result.imageError ?? "The image could not be regenerated.");
    } else {
      const edited = await callImageEdit(original, buildEditPrompt(change, Boolean(existing.logo_url)), generationSize(format));
      const finished = await finishEdit(original, edited, readLogoMarker(existing.creative_direction));
      await storeDraftImage(existing, {
        b64: finished.toString("base64"),
        imageUrl: null,
        mime: "image/png",
        model: getConfig().OPENAI_IMAGE_MODEL,
        prompt: buildEditPrompt(change, Boolean(existing.logo_url)),
        status: "succeeded",
        error: null,
        revisionNotes: instruction,
        direction: existing.creative_direction,
      });
    }
    await recordVersion(existing, version, null);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Image edit failed", { draftId: input.draftId, error: message });
    // Nothing was overwritten: the original is still the image. Put the card back to showing it.
    await upsertCreativeDraftAsync({ ...existing, id: existing.id, image_status: "succeeded", image_error: null }).catch(() => undefined);
    await getObjectStorage().delete(version.key).catch(() => undefined);
    await recordVersion(existing, null, message);
    return { ok: false, error: message };
  }
}

/** Put back the image as it was before the last edit. */
export async function undoLastEdit(draftId: string): Promise<void> {
  const draft = await getCreativeDraftAsync(draftId);
  if (!draft) throw new Error("Creative draft not found");
  const found = await runItem(draft);
  const versions = found?.items[found.index]?.versions ?? [];
  const last = versions[versions.length - 1];
  if (!found || !last) throw new Error("There is no earlier version to go back to.");
  const bytes = await getObjectStorage().get(last.key);
  if (!bytes) throw new Error("The earlier version is no longer stored.");
  await storeDraftImage(draft, { b64: bytes.toString("base64"), imageUrl: null, mime: "image/png", model: null, prompt: null, status: "succeeded", error: null, revisionNotes: null, direction: null });
  const items = found.items.map((it, i) => (i === found.index ? { ...it, versions: versions.slice(0, -1), edit_error: null } : it));
  await updateRun(found.runId, { items });
  await getObjectStorage().delete(last.key).catch(() => undefined);
}
