import { z } from "zod";
import { getCurrentUser } from "@/lib/security/auth";
import {
  assertAuthenticated,
  assertClientAccess,
} from "@/lib/authz/assert";
import {
  getCreativeDraftAsync,
  listCreativeDraftsAsync,
  selectCreativeDraftAsync,
  toPublicDraft,
} from "@/lib/creatives/drafts";
import { ensurePublicCreativeUrl } from "@/lib/creatives/cloudinary";
import { appendWorkflowMessage } from "@/lib/workflow/events";
import { bindImageToPendingApprovals } from "@/lib/workflow/bindings";
import { selectionFollowUpMessage } from "@/lib/workflow/selection-message";
import { patchTaskAgentState } from "@/lib/workflow/state";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";

const selectSchema = z.object({
  draftId: z.string().min(1),
});

export async function GET(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const clientId = new URL(request.url).searchParams.get("clientId");
    const conversationId = new URL(request.url).searchParams.get("conversationId");
    if (!clientId) throw new Error("clientId required");
    await assertClientAccess(user.id, clientId);
    const drafts = await listCreativeDraftsAsync(clientId, {
      conversationId: conversationId ?? undefined,
    });
    return jsonOk({
      drafts: drafts.map((d) => ({
        ...toPublicDraft(d),
        image_b64: undefined,
      })),
    });
  });
}

export async function POST(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const body = await parseBody(request, selectSchema);
    const existing = await getCreativeDraftAsync(body.draftId);
    if (!existing) throw new Error("Creative draft not found");
    await assertClientAccess(user.id, existing.client_id);

    // Meta must be able to fetch the creative from the public internet. Upload
    // local/data-URI previews before creating or patching any approval.
    const uploaded = await ensurePublicCreativeUrl(existing);
    const draft = await selectCreativeDraftAsync(body.draftId);
    if (!draft) throw new Error("Could not select draft");
    const imageUrl = uploaded.imageUrl;

    if (existing.task_id) {
      await patchTaskAgentState(existing.task_id, {
        creatives: {
          selected_draft_id: draft.id,
          selected_image_url: imageUrl,
          last_event_at: new Date().toISOString(),
        },
      });
    }

    const bound = imageUrl
      ? await bindImageToPendingApprovals({
          clientId: draft.client_id,
          imageUrl,
          taskId: draft.task_id,
          reviewedBy: user.id,
        })
      : [];

    // Picking an image never queues a campaign by itself: that needs the ad
    // copy, objective, budget and locations. With nothing waiting on the image,
    // the chat asks about the copy next.
    const approvalIds = bound.map((a) => a.id);
    const content = selectionFollowUpMessage(draft, bound.length);

    if (existing.conversation_id) {
      await appendWorkflowMessage({
        conversationId: existing.conversation_id,
        taskId: existing.task_id,
        eventType: "creative_selected",
        content,
        metadata: {
          ui: {
            creativePicker: {
              drafts: [toPublicDraft(draft)],
              status: "selected",
            },
          },
          draftId: draft.id,
          imageUrl,
          pendingApprovalIds: approvalIds,
        },
      });
    }

    return jsonOk({
      draft: { ...toPublicDraft(draft), image_b64: undefined },
      image_url: imageUrl,
      approvalIds,
      queued: bound.length > 0,
      needsDetails: bound.length === 0,
      blockedReason: null,
      workspaceHint: content,
    });
  });
}
