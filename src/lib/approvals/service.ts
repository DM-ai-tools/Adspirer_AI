import { nanoid } from "nanoid";
import type { Approval } from "@/types";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { assertNotBlocked } from "@/lib/tools/policy";
import {
  assertTransition,
  assertWithinBudgetCeiling,
} from "@/lib/approvals/validator";
import { AuthorizationError } from "@/lib/errors";
import { addHoursIso, nowIso } from "@/lib/utils";
import { logger } from "@/lib/observability/logger";
import {
  mapApprovalRow,
  newEntityId,
  toApprovalInsert,
} from "@/lib/db/live-maps";
import { mapClientRow } from "@/lib/clients/map-client";

async function getClient(clientId: string) {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    const client = getDemoStore().clients.find((c) => c.id === clientId);
    if (!client) throw new Error(`Client not found: ${clientId}`);
    return client;
  }
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("clients")
    .select("*")
    .eq("id", clientId)
    .single();
  if (error || !data) throw new Error(`Client not found: ${clientId}`);
  return mapClientRow(data as Record<string, unknown>);
}

function persistDemoApproval(approval: Approval): Approval {
  const store = getDemoStore();
  const idx = store.approvals.findIndex((a) => a.id === approval.id);
  if (idx >= 0) store.approvals[idx] = approval;
  else store.approvals.push(approval);
  return approval;
}

export async function createPendingApproval(input: {
  clientId: string;
  taskId?: string | null;
  toolCallId?: string | null;
  toolName: string;
  proposedArgs: Record<string, unknown>;
  rationale?: string | null;
  budgetImpactCents?: number | null;
  requestedBy?: string | null;
  idempotencyKey?: string;
}): Promise<Approval> {
  assertNotBlocked(input.toolName);
  const client = await getClient(input.clientId);
  assertWithinBudgetCeiling(
    client,
    input.proposedArgs,
    input.budgetImpactCents,
  );

  const config = getConfig();
  const ts = nowIso();
  const approval: Approval = {
    id:
      config.isDemoMode || !config.hasSupabase
        ? `approval_${nanoid(10)}`
        : newEntityId(),
    client_id: input.clientId,
    task_id: input.taskId ?? null,
    tool_call_id: input.toolCallId ?? null,
    tool_name: input.toolName,
    proposed_args: input.proposedArgs,
    edited_args: null,
    status: "pending",
    rationale: input.rationale ?? null,
    budget_impact_cents: input.budgetImpactCents ?? null,
    idempotency_key: input.idempotencyKey ?? `idem_${nanoid(16)}`,
    requested_by: input.requestedBy ?? null,
    reviewed_by: null,
    reviewed_at: null,
    expires_at: addHoursIso(config.APPROVAL_EXPIRY_HOURS),
    execution_result: null,
    execution_error: null,
    executed_at: null,
    created_at: ts,
    updated_at: ts,
  };

  if (config.isDemoMode || !config.hasSupabase) {
    const existing = getDemoStore().approvals.find(
      (a) => a.idempotency_key === approval.idempotency_key,
    );
    if (existing) return existing;
    persistDemoApproval(approval);
    logger.info("Created pending approval", {
      approvalId: approval.id,
      toolName: approval.tool_name,
      clientId: approval.client_id,
    });
    return approval;
  }

  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("approvals")
    .insert(toApprovalInsert(approval))
    .select("*")
    .single();
  if (error) throw new Error(`Failed to create approval: ${error.message}`);
  return mapApprovalRow(data as Record<string, unknown>);
}

export async function approve(input: {
  approvalId: string;
  reviewedBy: string;
}): Promise<Approval> {
  return transitionApproval(input.approvalId, "approved", input.reviewedBy);
}

export async function reject(input: {
  approvalId: string;
  reviewedBy: string;
  reason?: string;
}): Promise<Approval> {
  return transitionApproval(
    input.approvalId,
    "rejected",
    input.reviewedBy,
    undefined,
    input.reason,
  );
}

export async function edit(input: {
  approvalId: string;
  reviewedBy: string;
  editedArgs: Record<string, unknown>;
  budgetImpactCents?: number | null;
}): Promise<Approval> {
  const approval = await getApproval(input.approvalId);
  assertTransition(approval.status, "edited");

  const client = await getClient(approval.client_id);
  assertWithinBudgetCeiling(
    client,
    input.editedArgs,
    input.budgetImpactCents ?? approval.budget_impact_cents,
  );

  const ts = nowIso();
  const updated: Approval = {
    ...approval,
    status: "edited",
    edited_args: input.editedArgs,
    budget_impact_cents:
      input.budgetImpactCents ?? approval.budget_impact_cents,
    reviewed_by: input.reviewedBy,
    reviewed_at: ts,
    updated_at: ts,
  };

  return saveApproval(updated);
}

async function transitionApproval(
  approvalId: string,
  to: "approved" | "rejected",
  reviewedBy: string,
  editedArgs?: Record<string, unknown>,
  reason?: string,
): Promise<Approval> {
  const approval = await getApproval(approvalId);
  assertTransition(approval.status, to);

  if (!reviewedBy) {
    throw new AuthorizationError("reviewedBy is required");
  }

  const ts = nowIso();
  const updated: Approval = {
    ...approval,
    status: to,
    edited_args: editedArgs ?? approval.edited_args,
    rationale: reason
      ? `${approval.rationale ?? ""}\n[reject] ${reason}`.trim()
      : approval.rationale,
    reviewed_by: reviewedBy,
    reviewed_at: ts,
    updated_at: ts,
  };

  const saved = await saveApproval(updated);
  const { saveLearning } = await import("@/lib/agent/learning");
  await saveLearning({
    clientId: saved.client_id,
    source: `approval_${to}`,
    insight:
      to === "approved"
        ? `Operators approved ${saved.tool_name} proposals like this — prefer similar rationale and args when safe.`
        : `Operators rejected ${saved.tool_name}${
            reason ? ` because: ${reason}` : ""
          }. Avoid repeating that proposal without addressing the objection.`,
    createdBy: reviewedBy,
    evidence: {
      approvalId: saved.id,
      toolName: saved.tool_name,
      status: to,
      reason: reason ?? null,
    },
    weight: to === "rejected" ? 1.3 : 1,
  });
  return saved;
}

export async function getApproval(approvalId: string): Promise<Approval> {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    const found = getDemoStore().approvals.find((a) => a.id === approvalId);
    if (!found) throw new Error(`Approval not found: ${approvalId}`);
    return found;
  }
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("approvals")
    .select("*")
    .eq("id", approvalId)
    .single();
  if (error || !data) throw new Error(`Approval not found: ${approvalId}`);
  return mapApprovalRow(data as Record<string, unknown>);
}

async function saveApproval(approval: Approval): Promise<Approval> {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    return persistDemoApproval(approval);
  }
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("approvals")
    .update(toApprovalInsert(approval))
    .eq("id", approval.id)
    .select("*")
    .single();
  if (error) throw new Error(`Failed to update approval: ${error.message}`);
  return mapApprovalRow(data as Record<string, unknown>);
}
