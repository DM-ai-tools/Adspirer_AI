import { randomUUID } from "node:crypto";
import type {
  Approval,
  Conversation,
  Message,
  Task,
  ToolCall,
  ToolSafetyClass,
  ApprovalStatus,
  TaskStatus,
  MessageRole,
} from "@/types";

export function newEntityId(): string {
  return randomUUID();
}

export function mapConversationRow(row: Record<string, unknown>): Conversation {
  return {
    id: String(row.id),
    client_id: String(row.client_id),
    task_id: (row.task_id as string | null) ?? null,
    created_by: String(row.user_id ?? row.created_by ?? ""),
    title: (row.title as string | null) ?? null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export function toConversationInsert(conversation: Conversation): Record<string, unknown> {
  return {
    id: conversation.id,
    client_id: conversation.client_id,
    user_id: conversation.created_by,
    task_id: conversation.task_id,
    title: conversation.title,
    created_at: conversation.created_at,
    updated_at: conversation.updated_at,
  };
}

export function mapTaskRow(row: Record<string, unknown>): Task {
  return {
    id: String(row.id),
    client_id: String(row.client_id),
    conversation_id: (row.conversation_id as string | null) ?? null,
    created_by: String(row.user_id ?? row.created_by ?? ""),
    title: String(row.title),
    goal: (row.user_request as string | null) ?? (row.goal as string | null) ?? null,
    status: row.status as TaskStatus,
    agent_state: (row.agent_state as Record<string, unknown> | null) ?? null,
    error_message: (row.error_message as string | null) ?? null,
    paused_at: (row.paused_at as string | null) ?? null,
    completed_at: (row.completed_at as string | null) ?? null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export function toTaskUpsert(task: Task): Record<string, unknown> {
  return {
    id: task.id,
    client_id: task.client_id,
    user_id: task.created_by,
    conversation_id: task.conversation_id,
    title: task.title,
    user_request: task.goal,
    status: task.status,
    current_step:
      typeof task.agent_state?.phase === "string"
        ? task.agent_state.phase
        : null,
    agent_state: task.agent_state,
    error_message: task.error_message,
    paused_at: task.paused_at,
    completed_at: task.completed_at,
    updated_at: task.updated_at,
    created_at: task.created_at,
  };
}

export function mapMessageRow(row: Record<string, unknown>): Message {
  return {
    id: String(row.id),
    conversation_id: String(row.conversation_id),
    role: row.role as MessageRole,
    content: String(row.content),
    tool_call_id: (row.tool_call_id as string | null) ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    created_at: String(row.created_at),
  };
}

export function toMessageInsert(
  message: Message,
  taskId?: string | null,
): Record<string, unknown> {
  return {
    id: message.id,
    conversation_id: message.conversation_id,
    task_id: taskId ?? null,
    role: message.role,
    content: message.content,
    tool_call_id: message.tool_call_id,
    metadata: message.metadata,
    created_at: message.created_at,
  };
}

/**
 * Tool outputs are raw Meta API payloads and can reach hundreds of KB. They
 * are kept for the audit trail, not replayed to the model, so store a capped
 * copy instead of letting them grow the database without bound.
 */
const TOOL_OUTPUT_MAX_CHARS = 20_000;

export function capToolOutput(output: unknown): unknown {
  if (output == null) return output;
  const json = JSON.stringify(output);
  if (json.length <= TOOL_OUTPUT_MAX_CHARS) return output;
  return {
    truncated: true,
    original_chars: json.length,
    preview: json.slice(0, TOOL_OUTPUT_MAX_CHARS),
  };
}

export function toToolCallInsert(
  toolCall: ToolCall,
  clientId: string,
): Record<string, unknown> {
  const status = toolCall.completed_at
    ? toolCall.error_message
      ? "failed"
      : toolCall.approval_id
        ? "awaiting_approval"
        : "succeeded"
    : "started";

  return {
    id: toolCall.id,
    task_id: toolCall.task_id,
    client_id: clientId,
    conversation_id: toolCall.conversation_id,
    approval_id: toolCall.approval_id,
    tool_name: toolCall.tool_name,
    tool_type: toolCall.safety_class as ToolSafetyClass,
    input: toolCall.arguments,
    output: capToolOutput(toolCall.result),
    status,
    error: toolCall.error_message,
    started_at: toolCall.started_at,
    completed_at: toolCall.completed_at,
  };
}

export function mapApprovalRow(row: Record<string, unknown>): Approval {
  const budget =
    row.budget_impact_cents ??
    (typeof row.budget_impact === "number"
      ? Math.round(row.budget_impact * 100)
      : typeof row.budget_impact === "string"
        ? Math.round(Number(row.budget_impact) * 100)
        : null);

  return {
    id: String(row.id),
    client_id: String(row.client_id),
    task_id: (row.task_id as string | null) ?? null,
    tool_call_id: (row.tool_call_id as string | null) ?? null,
    tool_name: String(row.tool_name),
    proposed_args:
      (row.proposed_args as Record<string, unknown> | undefined) ??
      (row.original_input as Record<string, unknown> | undefined) ??
      {},
    edited_args:
      (row.edited_args as Record<string, unknown> | null | undefined) ??
      (row.editable_input as Record<string, unknown> | null | undefined) ??
      null,
    status: row.status as ApprovalStatus,
    rationale:
      (row.rationale as string | null | undefined) ??
      (row.agent_reasoning as string | null | undefined) ??
      (row.human_summary as string | null | undefined) ??
      null,
    budget_impact_cents: Number.isFinite(budget as number)
      ? (budget as number)
      : null,
    idempotency_key: String(row.idempotency_key),
    requested_by: (row.requested_by as string | null) ?? null,
    reviewed_by:
      (row.reviewed_by as string | null | undefined) ??
      (row.decided_by as string | null | undefined) ??
      null,
    reviewed_at:
      (row.reviewed_at as string | null | undefined) ??
      (row.decided_at as string | null | undefined) ??
      null,
    expires_at: (row.expires_at as string | null) ?? null,
    execution_result: (row.execution_result as Record<string, unknown> | null) ?? null,
    execution_error: (row.execution_error as string | null) ?? null,
    executed_at: (row.executed_at as string | null) ?? null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export function toApprovalInsert(approval: Approval): Record<string, unknown> {
  return {
    id: approval.id,
    client_id: approval.client_id,
    task_id: approval.task_id,
    tool_call_id: approval.tool_call_id,
    tool_name: approval.tool_name,
    original_input: approval.proposed_args,
    editable_input: approval.edited_args,
    human_summary: approval.rationale,
    agent_reasoning: approval.rationale,
    budget_impact:
      approval.budget_impact_cents == null
        ? null
        : approval.budget_impact_cents / 100,
    status: approval.status,
    requested_by: approval.requested_by,
    decided_by: approval.reviewed_by,
    decided_at: approval.reviewed_at,
    idempotency_key: approval.idempotency_key,
    expires_at: approval.expires_at,
    execution_result: approval.execution_result,
    execution_error: approval.execution_error,
    executed_at: approval.executed_at,
    created_at: approval.created_at,
    updated_at: approval.updated_at,
  };
}

export const APPROVAL_PORTAL_CTA =
  "**Action required:** Open **Approvals** in the left sidebar, review this pending change, then Approve or Reject before anything is applied to Meta.";
