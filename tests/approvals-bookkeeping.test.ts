import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/workflow/bindings", () => ({
  completeTaskIfApprovalsTerminal: vi.fn(async () => {
    throw new Error("task table unavailable");
  }),
}));

import { approve, createPendingApproval, getApproval } from "@/lib/approvals/service";
import { executeApprovedAction } from "@/lib/approvals/executor";

describe("post-success bookkeeping", () => {
  it("never reports a failure (or reopens the approval) after Meta succeeded", async () => {
    const pending = await createPendingApproval({
      clientId: "client_modern_dental",
      taskId: "task_mdc_audit_1",
      toolName: "pause_campaign",
      proposedArgs: { account_id: "act_100200300", campaign_id: "camp_mdc_npl" },
    });
    await approve({ approvalId: pending.id, reviewedBy: "profile_admin_demo" });

    const { approval } = await executeApprovedAction({
      approvalId: pending.id,
      executedBy: "profile_admin_demo",
    });
    expect(approval.status).toBe("executed");
    expect((await getApproval(pending.id)).status).toBe("executed");
  });
});
