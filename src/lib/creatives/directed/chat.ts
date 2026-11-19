import type { ImageFormat } from "@/lib/creatives/formats";
import { getCreativeDraftAsync, toPublicDraft, upsertCreativeDraftAsync, type CreativeDraft } from "@/lib/creatives/drafts";
import { generateImagesForDrafts } from "@/lib/creatives/service";
import { appendWorkflowMessage } from "@/lib/workflow/events";
import { detectDirection, MAX_CHAT_DIRECTIONS } from "@/lib/creatives/directed/detect";
import { createDirectedDrafts, loadDirectedBrand } from "@/lib/creatives/directed/create";
import { createDirectedVariations } from "@/lib/creatives/directed/variations";
import { editDirectedDraft } from "@/lib/creatives/directed/edit";
import { isDirectedDirection } from "@/lib/creatives/directed/markers";

export type DirectedTurn = {
  summary: string;
  cards: ReturnType<typeof toPublicDraft>[];
  rendering: boolean;
  /** The slow part (rendering or editing). The caller schedules it after the response. */
  run: (() => Promise<void>) | null;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The image a typed "change it" or "variations" refers to: the newest image of this chat, of any kind. It is only a
 * target when it came from a direction; when the newest is a concept from the existing flow, the existing rework
 * and "More like this" behaviour applies and this path stays out of it.
 */
function latestDirected(drafts: CreativeDraft[]): CreativeDraft | null {
  const newest = drafts.filter((d) => d.status !== "rejected" && d.image_status !== "failed").sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  return newest && isDirectedDirection(newest.creative_direction) ? newest : null;
}

const STILL_RENDERING: DirectedTurn = {
  summary: "That image is still rendering. Ask again in a moment, once it appears below.",
  cards: [],
  rendering: false,
  run: null,
};

/**
 * The chat's exact-direction path. Decides, from the operator's own words, whether this message is a direction
 * for an image, a request for variations of or an edit to a directed image, or none of those. Returns null for
 * everything else, so the existing concept flow handles the turn exactly as before.
 */
export async function runDirectedTurn(
  input: {
    clientId: string;
    serviceId?: string | null;
    conversationId: string;
    taskId: string;
    message: string;
    recent: string[];
    landingUrl?: string | null;
    defaultFormat: ImageFormat;
    /** True when the request is for ad images (the existing flow would generate concepts for it). */
    wantsInlineCreatives: boolean;
    /** This conversation's creative drafts. */
    drafts: CreativeDraft[];
  },
  deps: { detect?: typeof detectDirection; loadBrand?: typeof loadDirectedBrand } = {},
): Promise<DirectedTurn | null> {
  const target = latestDirected(input.drafts);
  if (!input.wantsInlineCreatives && !target) return null;

  const detection = await (deps.detect ?? detectDirection)({ message: input.message, recent: input.recent, hasDirectedImage: Boolean(target) });
  const render = (draftIds: string[], brandName?: string) => async () => {
    await generateImagesForDrafts({ draftIds, brandName, conversationId: input.conversationId, taskId: input.taskId });
  };

  switch (detection.mode) {
    case "directed": {
      if (detection.overflow) {
        return {
          summary: `That message holds more than ${MAX_CHAT_DIRECTIONS} directions, which is more than I make in one chat message. Put them in a file and use **Creatives → Bulk run → Directions file**: each direction becomes its own image, and you confirm the list before anything renders.`,
          cards: [],
          rendering: false,
          run: null,
        };
      }
      const brand = await (deps.loadBrand ?? loadDirectedBrand)({ clientId: input.clientId, serviceId: input.serviceId, landingUrl: input.landingUrl, conversationId: input.conversationId });
      const drafts = await createDirectedDrafts({
        clientId: input.clientId,
        serviceId: input.serviceId,
        conversationId: input.conversationId,
        taskId: input.taskId,
        directions: detection.directions,
        format: detection.format ?? input.defaultFormat,
        brand,
      });
      return {
        summary: `Making ${plural(drafts.length, "image")} exactly from your direction${drafts.length === 1 ? "" : "s"}: your picture instruction and your words, as written. ${drafts.length === 1 ? "It appears" : "They appear"} below when ready (30–90s). Ask me to change something and I'll edit it, or ask for **variations** and I'll make 4.`,
        cards: drafts.map(toPublicDraft),
        rendering: true,
        run: render(drafts.map((d) => d.id), brand.brandName),
      };
    }
    case "variations": {
      if (!target) return null;
      if (target.image_status !== "succeeded") return STILL_RENDERING;
      const { source, drafts } = await createDirectedVariations({ draftId: target.id });
      return {
        summary: "Making 4 variations of your image: the same picture and the same words, with a different layout in each.",
        cards: drafts.map(toPublicDraft),
        rendering: true,
        run: render(drafts.map((d) => d.id), source.concept.split("—")[0]?.trim()),
      };
    }
    case "edit": {
      if (!target || !detection.editInstruction) return null;
      if (target.image_status !== "succeeded") return STILL_RENDERING;
      const instruction = detection.editInstruction;
      const working = await upsertCreativeDraftAsync({ ...target, id: target.id, image_status: "generating", image_error: null });
      return {
        summary: `Editing your image: "${instruction}". Only that changes; everything else stays as it is.`,
        cards: [toPublicDraft(working)],
        rendering: true,
        run: async () => {
          const result = await editDirectedDraft({ draftId: target.id, instruction });
          const updated = await getCreativeDraftAsync(target.id);
          await appendWorkflowMessage({
            conversationId: input.conversationId,
            taskId: input.taskId,
            eventType: result.ok ? "creative_revised" : "creative_failed",
            content: result.ok ? `Edited your image: "${instruction}". Review the updated image below.` : `The edit failed (${result.error ?? "unknown error"}). Your image is unchanged.`,
            metadata: { ui: { creativePicker: { drafts: updated ? [toPublicDraft(updated)] : [], status: result.ok ? "ready" : "failed" } }, draftId: target.id },
          }).catch(() => undefined);
        },
      };
    }
    case "unsure":
      // A question is only worth interrupting for when the operator asked for images.
      if (!input.wantsInlineCreatives) return null;
      return {
        summary: detection.question || "What should the picture show, and what words (if any) should be printed on it?",
        cards: [],
        rendering: false,
        run: null,
      };
    default:
      return null;
  }
}
