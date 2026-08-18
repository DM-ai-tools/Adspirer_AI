import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { approve, getApproval } from "@/lib/approvals/service";
import { executeApprovedAction } from "@/lib/approvals/executor";
import { appendWorkflowMessage, resolveConversationForTask } from "@/lib/workflow/events";
import { completeTaskIfApprovalsTerminal } from "@/lib/workflow/bindings";
import { jsonOk, withApiHandler } from "@/lib/api/response";
import { NextResponse } from "next/server";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: RouteContext) {
  return withApiHandler(async () => {
    const { id } = await context.params;
    const user = await getCurrentUser();
    assertAuthenticated(user);

    const existing = await getApproval(id);
    await assertClientAccess(user.id, existing.client_id);

    const approved = await approve({
      approvalId: id,
      reviewedBy: user.id,
    });

    try {
      const execution = await executeApprovedAction({
        approvalId: approved.id,
        executedBy: user.id,
      });

      const conversationId = execution.approval.task_id
        ? await resolveConversationForTask(execution.approval.task_id)
        : null;
      if (conversationId) {
        const proof = execution.approval.execution_result ?? {};
        await appendWorkflowMessage({
          conversationId,
          taskId: execution.approval.task_id,
          eventType: "approval_executed",
          content: [
            `Approved and executed **${execution.approval.tool_name}**.`,
            proof && typeof proof === "object"
              ? `Proof: ${Object.entries(proof as Record<string, unknown>)
                  .filter(([k]) => /id$/i.test(k) || k === "id")
                  .map(([k, v]) => `${k}=${String(v)}`)
                  .join(", ")}`
              : "",
            "New entities remain **PAUSED** until you publish in Meta.",
          ]
            .filter(Boolean)
            .join(" "),
          metadata: {
            approvalId: execution.approval.id,
            toolName: execution.approval.tool_name,
            executionResult: proof,
          },
        });
      }
      if (execution.approval.task_id) {
        await completeTaskIfApprovalsTerminal(execution.approval.task_id);
      }

      return jsonOk({
        approval: execution.approval,
        result: execution.result,
      });
    } catch (error) {
      const latest = await getApproval(id);
      const message =
        error instanceof Error ? error.message : "Execution failed";
      const conversationId = latest.task_id
        ? await resolveConversationForTask(latest.task_id)
        : null;
      if (conversationId) {
        await appendWorkflowMessage({
          conversationId,
          taskId: latest.task_id,
          eventType: "approval_failed",
          content: `Approval for **${latest.tool_name}** failed during execution: ${message}. Edit args and try again.`,
          metadata: { approvalId: latest.id, error: message },
        });
      }
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "EXECUTION_FAILED",
            message,
            details: { approval: latest },
          },
        },
        { status: 422 },
      );
    }
  });
}
