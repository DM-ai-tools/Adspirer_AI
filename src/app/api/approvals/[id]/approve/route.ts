import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { approve, getApproval } from "@/lib/approvals/service";
import { executeApprovedAction } from "@/lib/approvals/executor";
import { appendWorkflowMessage, resolveConversationForTask } from "@/lib/workflow/events";
import { completeTaskIfApprovalsTerminal } from "@/lib/workflow/bindings";
import { jsonOk, withApiHandler } from "@/lib/api/response";
import { logger } from "@/lib/observability/logger";
import type { Approval } from "@/types";
import { NextResponse } from "next/server";

/** Multi-step creates (upload → campaign → ad set → creative → ad) can be slow. */
export const maxDuration = 120;

type RouteContext = { params: Promise<{ id: string }> };

function formatMoneyCents(cents: unknown, currency: unknown): string | null {
  if (typeof cents !== "number" || !Number.isFinite(cents)) return null;
  const code = typeof currency === "string" && currency ? currency : "USD";
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency: code,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${code}`;
  }
}

/** What actually changed in Meta, worded per action (not "PAUSED" for a resume). */
function outcomeLine(approval: Approval): string {
  const result = (approval.execution_result ?? {}) as Record<string, unknown>;
  const unverified =
    result.verified === false
      ? " Meta accepted it, but the read-back failed — confirm it in Ads Manager."
      : "";
  switch (approval.tool_name) {
    case "resume_campaign":
      return `The campaign is now **ACTIVE** and can start spending.${unverified}`;
    case "pause_campaign":
      return `The campaign is now **PAUSED**.${unverified}`;
    case "pause_ad":
      return `The ad is now **PAUSED**.${unverified}`;
    case "update_adset_budget": {
      const money = formatMoneyCents(result.daily_budget_cents, result.currency);
      return `${money ? `Daily budget is now **${money}**` : "Daily budget updated"}${
        result.verified === true ? " (confirmed by reading it back from Meta)." : "."
      }${unverified}`;
    }
    default: {
      const note =
        typeof result.budget_note === "string" ? ` ${result.budget_note}` : "";
      return `New entities were created **PAUSED** — nothing is live until you publish them in Meta.${note}`;
    }
  }
}

function proofLine(approval: Approval): string {
  const result = (approval.execution_result ?? {}) as Record<string, unknown>;
  const proof =
    result.proof && typeof result.proof === "object"
      ? (result.proof as Record<string, unknown>)
      : {};
  const ids = Object.entries(proof)
    .filter(([k, v]) => /_id$/.test(k) && (typeof v === "string" || typeof v === "number"))
    .map(([k, v]) => `${k}=${String(v)}`);
  return ids.length ? `Proof: ${ids.join(", ")}.` : "";
}

async function bestEffort(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    logger.warn(`Approve route: ${label} failed`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function POST(_request: Request, context: RouteContext) {
  return withApiHandler(async () => {
    const { id } = await context.params;
    const user = await getCurrentUser();
    assertAuthenticated(user);

    const existing = await getApproval(id);
    await assertClientAccess(user.id, existing.client_id);

    // An approval left in "approved" by an earlier failed run goes straight to
    // execution; approving it again would be an invalid transition.
    const approved =
      existing.status === "approved"
        ? existing
        : await approve({
            approvalId: id,
            reviewedBy: user.id,
          });

    let execution: Awaited<ReturnType<typeof executeApprovedAction>>;
    try {
      execution = await executeApprovedAction({
        approvalId: approved.id,
        executedBy: user.id,
      });
    } catch (error) {
      const latest = await getApproval(id).catch(() => approved);
      const message =
        error instanceof Error ? error.message : "Execution failed";
      const isCreate = latest.tool_name.startsWith("create_");
      await bestEffort("failure message", async () => {
        const conversationId = latest.task_id
          ? await resolveConversationForTask(latest.task_id)
          : null;
        if (!conversationId) return;
        await appendWorkflowMessage({
          conversationId,
          taskId: latest.task_id,
          eventType: "approval_failed",
          content: `Approval for **${latest.tool_name}** failed during execution: ${message}${
            isCreate
              ? " Check Ads Manager before approving again; anything listed as already created is reused, not duplicated."
              : " Edit the values if needed and approve again."
          }`,
          metadata: { approvalId: latest.id, error: message },
        });
      });
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

    // Meta has applied the change. Nothing below may turn that into a
    // reported failure (which would invite a duplicate re-approval).
    const done = execution.approval;
    await bestEffort("success message", async () => {
      const conversationId = done.task_id
        ? await resolveConversationForTask(done.task_id)
        : null;
      if (!conversationId) return;
      await appendWorkflowMessage({
        conversationId,
        taskId: done.task_id,
        eventType: "approval_executed",
        content: [
          `Approved and executed **${done.tool_name}**.`,
          proofLine(done),
          outcomeLine(done),
        ]
          .filter(Boolean)
          .join(" "),
        metadata: {
          approvalId: done.id,
          toolName: done.tool_name,
          executionResult: done.execution_result ?? {},
        },
      });
    });
    if (done.task_id) {
      const taskId = done.task_id;
      await bestEffort("task completion", () =>
        completeTaskIfApprovalsTerminal(taskId),
      );
    }

    return jsonOk({
      approval: done,
      result: execution.result,
    });
  });
}
