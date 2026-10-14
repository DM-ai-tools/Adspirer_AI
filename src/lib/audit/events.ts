import type { Approval } from "@/types";
import { humanToolLabel } from "@/lib/tools/display-labels";

export type AuditEvent = {
  id: string;
  at: string;
  type: string;
  client_id: string | null;
  actor_id: string | null;
  summary: string;
  payload: Record<string, unknown>;
};

/** Audit-trail event for an approval (always from a mapped Approval, never a raw row). */
export function approvalAuditEvent(a: Approval): AuditEvent {
  return {
    id: `audit_approval_${a.id}`,
    at: a.updated_at ?? a.created_at,
    type: `approval.${a.status}`,
    client_id: a.client_id,
    actor_id: a.reviewed_by ?? a.requested_by,
    summary: `${humanToolLabel(a.tool_name)} → ${a.status}`,
    payload: {
      approvalId: a.id,
      toolName: a.tool_name,
      status: a.status,
      budgetImpactCents: a.budget_impact_cents,
    },
  };
}
