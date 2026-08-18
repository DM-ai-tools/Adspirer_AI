import { z } from "zod";
import { getCurrentUser } from "@/lib/security/auth";
import {
  assertAuthenticated,
  assertClientAccess,
} from "@/lib/authz/assert";
import { generateImageForDraft } from "@/lib/creatives/generate-draft-image";
import {
  getCreativeDraftAsync,
  toPublicDraft,
  upsertCreativeDraftAsync,
} from "@/lib/creatives/drafts";
import { appendWorkflowMessage } from "@/lib/workflow/events";
import { runAfterResponse } from "@/lib/api/background";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";

export const maxDuration = 300;

const bodySchema = z.object({
  draftId: z.string().min(1),
  suggestion: z.string().min(3).max(2000),
});

export async function POST(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const body = await parseBody(request, bodySchema);
    const existing = await getCreativeDraftAsync(body.draftId);
    if (!existing) throw new Error("Creative draft not found");
    await assertClientAccess(user.id, existing.client_id);

    // Flip to "generating" before returning so the card shows a live spinner
    // instead of the previous still while the rework renders.
    const pending = await upsertCreativeDraftAsync({
      ...existing,
      id: existing.id,
      image_status: "generating",
      image_error: null,
      revision_notes: body.suggestion,
    });

    runAfterResponse("creative-rework", async () => {
      const result = await generateImageForDraft(
        existing.id,
        undefined,
        body.suggestion,
      );

      if (!existing.conversation_id) return;
      await appendWorkflowMessage({
        conversationId: existing.conversation_id,
        taskId: existing.task_id,
        eventType:
          result.imageStatus === "succeeded"
            ? "creative_revised"
            : "creative_failed",
        content:
          result.imageStatus === "succeeded"
            ? `Reworked **${result.draft.headline}** with your note: "${body.suggestion}". Review the updated still below.`
            : `Rework failed for **${result.draft.headline}**: ${result.imageError ?? "Unknown error"}`,
        metadata: {
          ui: {
            creativePicker: {
              drafts: [toPublicDraft(result.draft)],
              status: result.imageStatus === "succeeded" ? "ready" : "failed",
            },
          },
          draftId: result.draft.id,
          suggestion: body.suggestion,
        },
      });
    });

    return jsonOk({
      draft: toPublicDraft(pending),
      imageStatus: "generating" as const,
      imageError: null,
    });
  });
}
