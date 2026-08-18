import { getCurrentUser } from "@/lib/security/auth";
import {
  assertAuthenticated,
  assertClientAccess,
} from "@/lib/authz/assert";
import { listCreativeDraftsAsync } from "@/lib/creatives/drafts";
import { toPublicDraft } from "@/lib/creatives/drafts";
import { listActionableApprovals } from "@/lib/workflow/bindings";
import { getTaskById, readCreativesState } from "@/lib/workflow/state";
import { jsonOk, withApiHandler } from "@/lib/api/response";

export async function GET(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const url = new URL(request.url);
    const clientId = url.searchParams.get("clientId");
    const conversationId = url.searchParams.get("conversationId");
    const taskId = url.searchParams.get("taskId");
    if (!clientId) throw new Error("clientId required");
    await assertClientAccess(user.id, clientId);

    const task = taskId ? await getTaskById(taskId) : null;
    const creativesState = readCreativesState(task?.agent_state ?? null);
    const drafts = await listCreativeDraftsAsync(clientId, {
      conversationId: conversationId ?? undefined,
      taskId: taskId ?? undefined,
    });
    const approvals = await listActionableApprovals({
      clientId,
      taskId: taskId ?? undefined,
    });

    return jsonOk({
      task,
      creatives: {
        ...creativesState,
        drafts: drafts.map(toPublicDraft),
      },
      approvals,
    });
  });
}
