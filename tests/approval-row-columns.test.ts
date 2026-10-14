import { describe, expect, it } from "vitest";
import { approvalAuditEvent } from "@/lib/audit/events";
import { findMatchingApproval } from "@/lib/tools/execute/match-approval";
import { mapApprovalRow } from "@/lib/db/live-maps";

// A row exactly as Supabase returns it: database column names, not app names.
const dbRow = {
  id: "ap1",
  client_id: "c1",
  tool_name: "update_adset_budget",
  original_input: { adset_id: "as1", daily_budget_cents: 4400 },
  editable_input: null,
  status: "approved",
  budget_impact: "4.00",
  requested_by: "operator1",
  decided_by: "admin1",
  idempotency_key: "k",
  created_at: "2026-10-14T00:00:00Z",
  updated_at: "2026-10-14T01:00:00Z",
};

describe("audit events from database rows", () => {
  it("reads who decided and the budget impact from the real columns", () => {
    const event = approvalAuditEvent(mapApprovalRow(dbRow));
    expect(event.actor_id).toBe("admin1");
    expect(event.payload.budgetImpactCents).toBe(400);
    expect(event.type).toBe("approval.approved");
  });
});

describe("matching an approved approval to tool args", () => {
  it("compares against the stored args from the database row", () => {
    const rows = [mapApprovalRow(dbRow)];
    expect(findMatchingApproval(rows, { adset_id: "as1", daily_budget_cents: 4400 })).toBe("ap1");
    expect(findMatchingApproval(rows, { adset_id: "as1", daily_budget_cents: 9999 })).toBeNull();
  });
});
