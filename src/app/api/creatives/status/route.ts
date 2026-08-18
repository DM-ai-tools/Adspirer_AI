import { getCurrentUser } from "@/lib/security/auth";
import {
  assertAuthenticated,
  assertClientAccess,
} from "@/lib/authz/assert";
import {
  isRenderStalled,
  listCreativeDraftsAsync,
  toPublicDraft,
} from "@/lib/creatives/drafts";
import { jsonOk, withApiHandler } from "@/lib/api/response";

/**
 * Live view of creative generation for any surface.
 *
 * Images are rendered in the background, so the chat and the Creatives page
 * both poll this instead of holding a request open. It is safe to leave and
 * come back: progress lives on the drafts, not in the client.
 */
export async function GET(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);

    const params = new URL(request.url).searchParams;
    const clientId = params.get("clientId");
    if (!clientId) throw new Error("clientId required");
    await assertClientAccess(user.id, clientId);

    const drafts = await listCreativeDraftsAsync(clientId, {
      conversationId: params.get("conversationId") ?? undefined,
      taskId: params.get("taskId") ?? undefined,
    });

    const counts = {
      total: drafts.length,
      generating: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      stalled: 0,
    };
    for (const draft of drafts) {
      if (draft.image_status === "succeeded") counts.succeeded += 1;
      else if (draft.image_status === "failed") counts.failed += 1;
      else if (draft.image_status === "skipped") counts.skipped += 1;
      else if (isRenderStalled(draft)) counts.stalled += 1;
      else counts.generating += 1;
    }

    return jsonOk({
      drafts: drafts.map(toPublicDraft),
      progress: counts,
      active: counts.generating > 0,
    });
  });
}
