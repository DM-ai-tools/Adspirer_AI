import { generateObject } from "ai";
import { z } from "zod";
import { directionWithText, pickModel } from "@/lib/creatives/concept-writer";
import { readAspectMarker, stripAspectMarker, withAspectMarker } from "@/lib/creatives/formats";
import { getCreativeDraftAsync, upsertCreativeDraftAsync, type CreativeDraft } from "@/lib/creatives/drafts";

const variationSchema = z.object({
  variations: z.array(
    z.object({
      headline: z.string().describe("3-7 words printed large on the image: the same message as the original, worded differently"),
      highlights: z.array(z.string()).max(3).describe("1-3 chips: the same kind of proof points as the original, reworded or swapped for a close alternative from the same facts"),
      cta_label: z.string().describe("The button text, 2-4 words, close to the original's"),
      tweak: z.string().describe("One small change to the layout of the same image: where the subject or headline sits, which brand colour leads, the camera angle or the crop. The style and idea stay the same."),
    }),
  ),
});

const ON_IMAGE = /^ON-IMAGE TEXT/;

/** The art direction with the printed words taken out, and the printed-words line on its own. */
export function splitDirection(direction: string | null | undefined): { base: string; onImage: string | null } {
  const lines = stripAspectMarker(direction).split("\n");
  const onImage = lines.find((l) => ON_IMAGE.test(l.trim())) ?? null;
  const base = lines.filter((l) => !ON_IMAGE.test(l.trim()) && !/^VARIATION:/.test(l.trim())).join("\n").trim();
  return { base, onImage };
}

/**
 * More of one image the operator likes: the same concept, style and message with the words
 * reworded and the layout nudged, not new ideas. Returns the new draft rows (rendering is
 * started by the caller) so the cards can appear at once.
 */
export async function createVariationsOfDraft(input: {
  draftId: string;
  count: number;
}): Promise<{ source: CreativeDraft; drafts: CreativeDraft[] }> {
  const source = await getCreativeDraftAsync(input.draftId);
  if (!source) throw new Error("Creative draft not found");
  const model = pickModel();
  if (!model) throw new Error("No language model is configured to write variations.");

  const count = Math.min(Math.max(input.count, 1), 4);
  const { base, onImage } = splitDirection(source.creative_direction);
  const format = readAspectMarker(source.creative_direction) ?? "4:5";

  const { object } = await generateObject({
    model,
    schema: variationSchema,
    temperature: 0.8,
    system:
      "You are a paid-social creative director making close variations of an ad image the client already likes. Keep the concept, style, mood and message; change only the wording a little and the layout slightly. Never invent claims, prices or statistics.",
    prompt: [
      `The image the client liked (art direction): ${base}`,
      onImage ? `Its printed words: ${onImage}` : null,
      `Post headline: ${source.headline}`,
      `Post text: ${source.primary_text.slice(0, 500)}`,
      `Write exactly ${count} variations. Each keeps the same message and similar wording to the original (synonyms, a different order, a close alternative proof point), and each makes one small, different layout change. They should read as siblings of the original, clearly related to each other.`,
    ]
      .filter(Boolean)
      .join("\n"),
  });

  const drafts: CreativeDraft[] = [];
  for (const [index, v] of object.variations.slice(0, count).entries()) {
    const direction = [
      directionWithText(base, { headline: v.headline, highlights: v.highlights, cta_label: v.cta_label }),
      `VARIATION: keep everything about this image the same (style, subject, mood, palette) except: ${v.tweak}`,
    ].join("\n");
    drafts.push(
      await upsertCreativeDraftAsync({
        client_id: source.client_id,
        service_id: source.service_id,
        conversation_id: source.conversation_id,
        task_id: source.task_id,
        brief_id: source.brief_id,
        concept: `${source.concept.replace(/ · More like this \d+$/, "")} · More like this ${index + 1}`,
        headline: source.headline,
        primary_text: source.primary_text,
        description: source.description,
        cta: source.cta,
        creative_direction: withAspectMarker(direction, format),
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
