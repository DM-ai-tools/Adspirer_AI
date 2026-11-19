import { z } from "zod";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { getCreativeDraftAsync, toPublicDraft, upsertCreativeDraftAsync } from "@/lib/creatives/drafts";
import { generateImagesForDrafts } from "@/lib/creatives/service";
import { createDirectedVariations } from "@/lib/creatives/directed/variations";
import { editDirectedDraft, undoDirectedEdit } from "@/lib/creatives/directed/edit";
import { appendWorkflowMessage } from "@/lib/workflow/events";
import { runAfterResponse } from "@/lib/api/background";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";

export const maxDuration = 300;

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("variations"), draftId: z.string().min(1) }),
  z.object({ action: z.literal("edit"), draftId: z.string().min(1), instruction: z.string().min(3).max(1500) }),
  z.object({ action: z.literal("undo"), draftId: z.string().min(1) }),
]);

/** Variations of, an edit to, or an undo on an image the operator made from their own direction. */
export async function POST(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const body = await parseBody(request, bodySchema);
    const existing = await getCreativeDraftAsync(body.draftId);
    if (!existing) throw new Error("Creative draft not found");
    await assertClientAccess(user.id, existing.client_id);

    if (body.action === "undo") {
      await undoDirectedEdit(body.draftId);
      return jsonOk({ undone: true });
    }

    if (body.action === "edit") {
      // The card shows as working at once; the edit itself runs after the response.
      await upsertCreativeDraftAsync({ ...existing, id: existing.id, image_status: "generating", image_error: null });
      runAfterResponse("directed-image-edit", () => editDirectedDraft({ draftId: body.draftId, instruction: body.instruction }));
      return jsonOk({ started: true });
    }

    const { source, drafts } = await createDirectedVariations({ draftId: body.draftId });
    runAfterResponse("directed-variations", async () => {
      await generateImagesForDrafts({
        draftIds: drafts.map((d) => d.id),
        brandName: source.concept.split("—")[0]?.trim(),
        conversationId: source.conversation_id ?? undefined,
        taskId: source.task_id ?? undefined,
      });
    });
    if (source.conversation_id) {
      await appendWorkflowMessage({
        conversationId: source.conversation_id,
        taskId: source.task_id ?? undefined,
        eventType: "creative_generating",
        content: `Making 4 variations of your image: same picture and the same words, a different layout in each. They appear below as each finishes.`,
        metadata: {
          ui: { creativePicker: { drafts: drafts.map(toPublicDraft), status: "generating" } },
          draftIds: drafts.map((d) => d.id),
        },
      }).catch(() => undefined);
    }
    return jsonOk({ drafts: drafts.map(toPublicDraft) });
  });
}
