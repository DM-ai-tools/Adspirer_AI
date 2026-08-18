import { z } from "zod";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { getApproval, reject } from "@/lib/approvals/service";
import { appendWorkflowMessage, resolveConversationForTask } from "@/lib/workflow/events";
import { completeTaskIfApprovalsTerminal } from "@/lib/workflow/bindings";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";

const bodySchema = z.object({
  reason: z.string().optional(),
});

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  return withApiHandler(async () => {
    const { id } = await context.params;
    const user = await getCurrentUser();
    assertAuthenticated(user);

    const existing = await getApproval(id);
    await assertClientAccess(user.id, existing.client_id);

    let reason: string | undefined;
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const body = await parseBody(request, bodySchema);
      reason = body.reason;
    }

    const approval = await reject({
      approvalId: id,
      reviewedBy: user.id,
      reason,
    });

    const conversationId = approval.task_id
      ? await resolveConversationForTask(approval.task_id)
      : null;
    if (conversationId) {
      await appendWorkflowMessage({
        conversationId,
        taskId: approval.task_id,
        eventType: "approval_rejected",
        content: `Rejected **${approval.tool_name}**${reason ? `: ${reason}` : "."} Tell me how you'd like to adjust the campaign and I can queue a revised action.`,
        metadata: { approvalId: approval.id, reason: reason ?? null },
      });
    }
    if (approval.task_id) {
      await completeTaskIfApprovalsTerminal(approval.task_id);
    }

    return jsonOk({ approval });
  });
}
