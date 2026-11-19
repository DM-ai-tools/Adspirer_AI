import { getCreativeDraftAsync, upsertCreativeDraftAsync, type CreativeDraft } from "@/lib/creatives/drafts";
import { readAspectMarker, withAspectMarker } from "@/lib/creatives/formats";
import { readDirectedMarker, withDirectedMarker } from "@/lib/creatives/directed/markers";

/**
 * The one layout change each of the four variations makes. Fixed, so a variation never needs a model call
 * and can never reword the operator's printed words: only where things sit changes.
 */
export const VARIATION_TWEAKS = [
  "place the main subject on the left and the printed words on the right (or the nearest equivalent that keeps every word legible)",
  "crop in closer on the main subject, with the printed words kept fully inside the frame",
  "pull the camera back for a wider view, with more space around the subject, and keep the printed words clearly legible",
  "mirror the composition (subject on the opposite side) and let a different one of the brand colours lead",
] as const;

/**
 * Four close versions of one directed image: the same picture instruction and the same printed words, word
 * for word, with one small layout change each. Returns the new rows (rendering is started by the caller).
 */
export async function createDirectedVariations(input: { draftId: string }): Promise<{ source: CreativeDraft; drafts: CreativeDraft[] }> {
  const source = await getCreativeDraftAsync(input.draftId);
  if (!source) throw new Error("Creative draft not found");
  const meta = readDirectedMarker(source.creative_direction);
  if (!meta) throw new Error("Variations of this kind are only made for an image that came from a direction.");
  const format = readAspectMarker(source.creative_direction) ?? "4:5";
  const base = source.concept.replace(/ · Variation \d+$/, "");

  const drafts: CreativeDraft[] = [];
  for (const [index, tweak] of VARIATION_TWEAKS.entries()) {
    drafts.push(
      await upsertCreativeDraftAsync({
        client_id: source.client_id,
        service_id: source.service_id,
        conversation_id: source.conversation_id,
        task_id: source.task_id,
        brief_id: source.brief_id,
        concept: `${base} · Variation ${index + 1}`,
        headline: source.headline,
        primary_text: source.primary_text,
        description: source.description,
        cta: source.cta,
        creative_direction: withAspectMarker(withDirectedMarker("", { picture: meta.picture, print: meta.print, ...(meta.noLogo ? { noLogo: true } : {}), ...(meta.edits?.length ? { edits: meta.edits } : {}), tweak }), format),
        image_url: null,
        image_b64: null,
        image_mime: "image/png",
        image_model: null,
        image_prompt: null,
        image_status: "generating",
        image_error: null,
        landing_page_url: source.landing_page_url,
        brand_colors: source.brand_colors,
        logo_url: source.logo_url,
        revision_notes: null,
        status: "draft",
      }),
    );
  }
  return { source, drafts };
}
