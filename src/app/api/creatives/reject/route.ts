import { z } from "zod";
import { getCurrentUser } from "@/lib/security/auth";
import {
  assertAuthenticated,
  assertClientAccess,
} from "@/lib/authz/assert";
import {
  getCreativeDraftAsync,
  rejectCreativeDraftAsync,
  toPublicDraft,
} from "@/lib/creatives/drafts";
import { appendWorkflowMessage } from "@/lib/workflow/events";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";

const bodySchema = z.object({
  draftId: z.string().min(1),
  reason: z.string().optional(),
});

export async function POST(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const body = await parseBody(request, bodySchema);
    const existing = await getCreativeDraftAsync(body.draftId);
    if (!existing) throw new Error("Creative draft not found");
    await assertClientAccess(user.id, existing.client_id);
    const draft = await rejectCreativeDraftAsync(body.draftId);
    if (!draft) throw new Error("Could not reject draft");

    if (existing.conversation_id) {
      await appendWorkflowMessage({
        conversationId: existing.conversation_id,
        taskId: existing.task_id,
        eventType: "creative_rejected",
        content: `Rejected creative **${draft.headline}**${body.reason ? `: ${body.reason}` : "."}`,
        metadata: { draftId: draft.id, reason: body.reason ?? null },
      });
    }

    return jsonOk({ draft: toPublicDraft(draft) });
  });
}
