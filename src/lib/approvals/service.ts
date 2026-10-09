import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import type { Approval } from "@/types";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { assertNotBlocked } from "@/lib/tools/policy";
import {
  assertApprovalNotExpired,
  assertTransition,
  assertWithinBudgetCeiling,
} from "@/lib/approvals/validator";
import { prepareApprovalArgs } from "@/lib/approvals/validate-args";
import { AuthorizationError, DuplicateExecutionError } from "@/lib/errors";
import { addHoursIso, nowIso } from "@/lib/utils";
import { logger } from "@/lib/observability/logger";
import {
  mapApprovalRow,
  newEntityId,
  toApprovalInsert,
} from "@/lib/db/live-maps";
import { mapClientRow } from "@/lib/clients/map-client";

export async function getClient(clientId: string) {
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

/** Stable JSON: object keys sorted recursively so key order never changes the hash. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Deterministic idempotency key: the same proposal (client, tool, normalized
 * args, task) maps to the same key, so an agent repeating itself inside one
 * task does not queue a second approval for the same change. Internal
 * bookkeeping keys (`__*`, `_notes`) are excluded.
 */
export function deriveIdempotencyKey(input: {
  clientId: string;
  toolName: string;
  args: Record<string, unknown>;
  taskId?: string | null;
}): string {
  const core = Object.fromEntries(
    Object.entries(input.args).filter(([k]) => !k.startsWith("_")),
  );
  const digest = createHash("sha256")
    .update(
      canonicalJson({
        client: input.clientId,
        tool: input.toolName,
        task: input.taskId ?? null,
        args: core,
      }),
    )
    .digest("hex");
  return `idem_${digest.slice(0, 40)}`;
}

/** Approvals still in flight for the same proposal — reuse instead of duplicating. */
const REUSABLE_STATUSES: Approval["status"][] = [
  "pending",
  "edited",
  "approved",
  "executing",
];

async function findApprovalByKey(key: string): Promise<Approval | null> {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    return getDemoStore().approvals.find((a) => a.idempotency_key === key) ?? null;
  }
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("approvals")
    .select("*")
    .eq("idempotency_key", key)
    .maybeSingle();
  if (error) throw new Error(`Failed to look up approval: ${error.message}`);
  return data ? mapApprovalRow(data as Record<string, unknown>) : null;
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
  // Throws ApprovalValidationError with an operator-readable message when a
  // value is wrong (bad types, account not granted, over the ceiling,
  // unsupported fields, no executor for the tool…). Values that are merely
  // missing (e.g. a creative queued so the operator can add budget and
  // location) are allowed here but flagged; execution re-validates strictly.
  const prepared = await prepareApprovalArgs({
    toolName: input.toolName,
    clientId: input.clientId,
    args: input.proposedArgs,
    client,
    allowIncomplete: true,
  });
  const proposedArgs = prepared.args;
  const budgetImpactCents =
    prepared.budgetImpactCents ?? input.budgetImpactCents ?? null;
  if (prepared.budgetImpactCents == null && input.budgetImpactCents != null) {
    assertWithinBudgetCeiling(client, {}, input.budgetImpactCents);
  }

  let idempotencyKey = input.idempotencyKey;
  if (idempotencyKey) {
    const existing = await findApprovalByKey(idempotencyKey);
    if (existing) return existing;
  } else {
    idempotencyKey = deriveIdempotencyKey({
      clientId: input.clientId,
      toolName: input.toolName,
      args: proposedArgs,
      taskId: input.taskId,
    });
    const existing = await findApprovalByKey(idempotencyKey);
    if (existing) {
      const sameTaskExecuted =
        existing.status === "executed" &&
        input.taskId != null &&
        existing.task_id === input.taskId;
      if (REUSABLE_STATUSES.includes(existing.status) || sameTaskExecuted) {
        logger.info("Reused existing approval for duplicate proposal", {
          approvalId: existing.id,
          toolName: input.toolName,
        });
        return existing;
      }
      // Rejected / cancelled / failed (or executed in an earlier task): the
      // operator may legitimately want it again — queue a fresh approval.
      idempotencyKey = `${idempotencyKey}_${nanoid(6)}`;
    }
  }

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
    proposed_args: proposedArgs,
    edited_args: null,
    status: "pending",
    rationale: input.rationale ?? null,
    budget_impact_cents: budgetImpactCents,
    idempotency_key: idempotencyKey,
    requested_by: input.requestedBy ?? null,
    reviewed_by: null,
    reviewed_at: null,
    expires_at: addHoursIso(config.APPROVAL_EXPIRY_HOURS),
    execution_result: null,
    execution_error: prepared.incomplete,
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
  if (error) {
    // Two identical proposals racing: the unique key let one through.
    if ((error as { code?: string }).code === "23505") {
      const existing = await findApprovalByKey(approval.idempotency_key);
      if (existing) return existing;
    }
    throw new Error(`Failed to create approval: ${error.message}`);
  }
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
  /**
   * Ignored for budget tools: the impact is recomputed from the final args so
   * an edit can't understate it. Kept for API compatibility.
   */
  budgetImpactCents?: number | null;
}): Promise<Approval> {
  const approval = await getApproval(input.approvalId);
  if (approval.status === "executing") {
    throw new DuplicateExecutionError(
      "This approval is executing right now — wait for it to finish before editing.",
      { approvalId: approval.id },
    );
  }
  assertTransition(approval.status, "edited");

  // Keep routing keys (e.g. __provider_backend) the edit form may have dropped.
  const original = approval.edited_args ?? approval.proposed_args;
  const carried = Object.fromEntries(
    Object.entries(original ?? {}).filter(
      ([k]) => k.startsWith("__") && input.editedArgs[k] === undefined,
    ),
  );

  const client = await getClient(approval.client_id);
  const prepared = await prepareApprovalArgs({
    toolName: approval.tool_name,
    clientId: approval.client_id,
    args: { ...input.editedArgs, ...carried },
    client,
  });

  const ts = nowIso();
  const updated: Approval = {
    ...approval,
    status: "edited",
    edited_args: prepared.args,
    budget_impact_cents: prepared.budgetImpactCents,
    // The previous failure no longer describes these args.
    execution_error: null,
    reviewed_by: input.reviewedBy,
    reviewed_at: ts,
    updated_at: ts,
  };

  return saveApproval(updated, approval.status);
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
  // Refuse to approve an expired proposal up front — otherwise it would sit in
  // "approved" after the executor rejects it and vanish from the review queue.
  if (to === "approved") assertApprovalNotExpired(approval);

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

  const saved = await saveApproval(updated, approval.status);
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
  let found: Approval;
  if (config.isDemoMode || !config.hasSupabase) {
    const row = getDemoStore().approvals.find((a) => a.id === approvalId);
    if (!row) throw new Error(`Approval not found: ${approvalId}`);
    found = row;
  } else {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("approvals")
      .select("*")
      .eq("id", approvalId)
      .single();
    if (error || !data) throw new Error(`Approval not found: ${approvalId}`);
    found = mapApprovalRow(data as Record<string, unknown>);
  }
  if (isStaleExecuting(found)) {
    const reaped = await reapApproval(found).catch(() => null);
    if (reaped) return reaped;
  }
  return found;
}

/** An execution that has not checkpointed for this long is considered dead. */
export const STALE_EXECUTING_MS = 10 * 60 * 1000;

export const STALE_EXECUTING_MESSAGE =
  "Execution did not finish within 10 minutes (the server likely timed out mid-run). Check Ads Manager before approving again: anything already created is PAUSED, and IDs recorded below are reused rather than re-created.";

export function isStaleExecuting(approval: Approval, now = Date.now()): boolean {
  if (approval.status !== "executing") return false;
  const ts = Date.parse(approval.updated_at);
  return Number.isFinite(ts) && now - ts > STALE_EXECUTING_MS;
}

/** Move one stale `executing` approval to `failed` (only if still stale/executing). */
async function reapApproval(approval: Approval): Promise<Approval | null> {
  const ts = nowIso();
  const reaped: Approval = {
    ...approval,
    status: "failed",
    execution_error: approval.execution_error
      ? `${STALE_EXECUTING_MESSAGE}\n${approval.execution_error}`
      : STALE_EXECUTING_MESSAGE,
    updated_at: ts,
  };
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    const current = getDemoStore().approvals.find((a) => a.id === approval.id);
    if (!current || !isStaleExecuting(current)) return null;
    persistDemoApproval(reaped);
    logger.warn("Reaped stale executing approval", { approvalId: approval.id });
    return reaped;
  }
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("approvals")
    .update(toApprovalInsert(reaped))
    .eq("id", approval.id)
    .eq("status", "executing")
    // Only if no checkpoint landed since we decided it was stale.
    .lt("updated_at", new Date(Date.now() - STALE_EXECUTING_MS).toISOString())
    .select("*")
    .maybeSingle();
  if (error || !data) return null;
  logger.warn("Reaped stale executing approval", { approvalId: approval.id });
  return mapApprovalRow(data as Record<string, unknown>);
}

/**
 * Fail every approval stuck in `executing` for over 10 minutes (a crashed or
 * timed-out run). Cheap enough to call when listing approvals.
 */
export async function reapStaleExecutingApprovals(options?: {
  clientId?: string;
}): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_EXECUTING_MS).toISOString();
  const config = getConfig();
  let stale: Approval[];
  if (config.isDemoMode || !config.hasSupabase) {
    stale = getDemoStore().approvals.filter(
      (a) =>
        isStaleExecuting(a) &&
        (!options?.clientId || a.client_id === options.clientId),
    );
  } else {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const supabase = createAdminClient();
    let query = supabase
      .from("approvals")
      .select("*")
      .eq("status", "executing")
      .lt("updated_at", cutoff)
      .limit(50);
    if (options?.clientId) query = query.eq("client_id", options.clientId);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    stale = (data ?? []).map((row) =>
      mapApprovalRow(row as Record<string, unknown>),
    );
  }
  let count = 0;
  for (const approval of stale) {
    if (await reapApproval(approval).catch(() => null)) count += 1;
  }
  return count;
}

/**
 * Persist a reviewed approval. The update only applies while the row is still
 * in `expectedStatus`, so two reviewers (or a double click across the rail and
 * the inline card) cannot both move the same approval forward.
 */
async function saveApproval(
  approval: Approval,
  expectedStatus: Approval["status"],
): Promise<Approval> {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    const current = getDemoStore().approvals.find((a) => a.id === approval.id);
    if (current && current.status !== expectedStatus) {
      throw new DuplicateExecutionError(
        "This approval was already handled by someone else. Refresh to see its latest status.",
        { approvalId: approval.id, status: current.status },
      );
    }
    return persistDemoApproval(approval);
  }
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("approvals")
    .update(toApprovalInsert(approval))
    .eq("id", approval.id)
    .eq("status", expectedStatus)
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`Failed to update approval: ${error.message}`);
  if (!data) {
    throw new DuplicateExecutionError(
      "This approval was already handled by someone else. Refresh to see its latest status.",
      { approvalId: approval.id, expectedStatus },
    );
  }
  return mapApprovalRow(data as Record<string, unknown>);
}
