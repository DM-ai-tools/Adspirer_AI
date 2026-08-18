import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { getApproval } from "@/lib/approvals/service";
import { executeApprovedAction } from "@/lib/approvals/executor";
import { assertTransition } from "@/lib/approvals/validator";
import { DuplicateExecutionError } from "@/lib/errors";
import { nowIso } from "@/lib/utils";
import { logger } from "@/lib/observability/logger";
import type { Approval } from "@/types";
import { defineJobTask } from "./optional-task";

export type RetryFailedToolCallPayload = {
  approvalId: string;
  executedBy: string;
  /** Must match the original approval idempotency key intent — never mint a new mutation key. */
  idempotencyKey?: string;
};

export type RetryFailedToolCallResult = {
  approvalId: string;
  status: Approval["status"];
  retried: boolean;
  skipped: boolean;
  reason?: string;
};

async function persistApproval(approval: Approval): Promise<Approval> {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    const store = getDemoStore();
    const idx = store.approvals.findIndex((a) => a.id === approval.id);
    if (idx >= 0) store.approvals[idx] = approval;
    else store.approvals.push(approval);
    return approval;
  }
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("approvals")
    .update(approval)
    .eq("id", approval.id)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data as Approval;
}

/**
 * Retry a failed Execute approval using the SAME idempotency key.
 * Never double-mutates an already-executed approval.
 */
export async function runRetryFailedToolCall(
  payload: RetryFailedToolCallPayload,
): Promise<RetryFailedToolCallResult> {
  const approval = await getApproval(payload.approvalId);

  if (approval.status === "executed") {
    return {
      approvalId: approval.id,
      status: approval.status,
      retried: false,
      skipped: true,
      reason: "Already executed (idempotent skip)",
    };
  }

  if (approval.status !== "failed") {
    return {
      approvalId: approval.id,
      status: approval.status,
      retried: false,
      skipped: true,
      reason: `Not in failed status (status=${approval.status})`,
    };
  }

  // Preserve original idempotency key — never mint a new one for retries.
  if (
    payload.idempotencyKey &&
    payload.idempotencyKey !== approval.idempotency_key
  ) {
    return {
      approvalId: approval.id,
      status: approval.status,
      retried: false,
      skipped: true,
      reason: "Idempotency key mismatch — refusing retry",
    };
  }

  assertTransition(approval.status, "pending");
  let working: Approval = {
    ...approval,
    status: "pending",
    execution_error: null,
    updated_at: nowIso(),
  };
  working = await persistApproval(working);

  // Re-approve for executable path (failed → pending → approved → executing)
  assertTransition(working.status, "approved");
  working = {
    ...working,
    status: "approved",
    reviewed_by: payload.executedBy,
    reviewed_at: nowIso(),
    updated_at: nowIso(),
  };
  working = await persistApproval(working);

  try {
    const result = await executeApprovedAction({
      approvalId: working.id,
      executedBy: payload.executedBy,
    });

    logger.info("Retried failed tool call", {
      approvalId: working.id,
      idempotencyKey: working.idempotency_key,
    });

    return {
      approvalId: result.approval.id,
      status: result.approval.status,
      retried: true,
      skipped: false,
    };
  } catch (error) {
    if (error instanceof DuplicateExecutionError) {
      return {
        approvalId: working.id,
        status: "executed",
        retried: false,
        skipped: true,
        reason: error.message,
      };
    }
    throw error;
  }
}

export const retryFailedToolCallTask = defineJobTask(
  "retry-failed-tool-call",
  runRetryFailedToolCall,
);
