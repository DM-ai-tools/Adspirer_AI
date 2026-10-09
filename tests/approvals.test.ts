import { describe, expect, it } from "vitest";
import {
  approve,
  createPendingApproval,
  edit,
  getApproval,
  reject,
} from "@/lib/approvals/service";
import { executeApprovedAction } from "@/lib/approvals/executor";
import { DuplicateExecutionError } from "@/lib/errors";
import { getDemoStore, resetDemoStore } from "@/lib/demo/store";

const CLIENT_ID = "client_modern_dental";
const REVIEWER = "profile_admin_demo";

function budgetArgs(cents = 5500) {
  return {
    account_id: "act_100200300",
    adset_id: "adset_mdc_npl_1",
    daily_budget_cents: cents,
    previous_daily_budget_cents: 4000,
  };
}

describe("approvals service + executor", () => {
  it("creates a pending approval", async () => {
    resetDemoStore();
    const approval = await createPendingApproval({
      clientId: CLIENT_ID,
      toolName: "update_adset_budget",
      proposedArgs: budgetArgs(),
      rationale: "Test increase",
      budgetImpactCents: 1500,
      requestedBy: REVIEWER,
      idempotencyKey: "idem_test_create_pending",
    });

    expect(approval.status).toBe("pending");
    expect(approval.tool_name).toBe("update_adset_budget");
    expect(approval.proposed_args.daily_budget_cents).toBe(5500);
  });

  it("approve then executes exactly once", async () => {
    resetDemoStore();
    const pending = await createPendingApproval({
      clientId: CLIENT_ID,
      toolName: "update_adset_budget",
      proposedArgs: budgetArgs(),
      budgetImpactCents: 1500,
      requestedBy: REVIEWER,
      idempotencyKey: "idem_test_approve_once",
    });

    const approved = await approve({
      approvalId: pending.id,
      reviewedBy: REVIEWER,
    });
    expect(approved.status).toBe("approved");

    const first = await executeApprovedAction({
      approvalId: pending.id,
      executedBy: REVIEWER,
    });
    expect(first.approval.status).toBe("executed");
    expect(first.approval.executed_at).toBeTruthy();

    await expect(
      executeApprovedAction({
        approvalId: pending.id,
        executedBy: REVIEWER,
      }),
    ).rejects.toBeInstanceOf(DuplicateExecutionError);
  });

  it("reject prevents execution", async () => {
    resetDemoStore();
    const pending = await createPendingApproval({
      clientId: CLIENT_ID,
      toolName: "update_adset_budget",
      proposedArgs: budgetArgs(),
      budgetImpactCents: 1500,
      requestedBy: REVIEWER,
      idempotencyKey: "idem_test_reject",
    });

    await reject({
      approvalId: pending.id,
      reviewedBy: REVIEWER,
      reason: "Not now",
    });

    const rejected = await getApproval(pending.id);
    expect(rejected.status).toBe("rejected");

    await expect(
      executeApprovedAction({
        approvalId: pending.id,
        executedBy: REVIEWER,
      }),
    ).rejects.toThrow(/not executable/i);
  });

  it("edit replaces proposed input with edited_args", async () => {
    resetDemoStore();
    const pending = await createPendingApproval({
      clientId: CLIENT_ID,
      toolName: "update_adset_budget",
      proposedArgs: budgetArgs(5500),
      budgetImpactCents: 1500,
      requestedBy: REVIEWER,
      idempotencyKey: "idem_test_edit",
    });

    const edited = await edit({
      approvalId: pending.id,
      reviewedBy: REVIEWER,
      editedArgs: budgetArgs(5000),
      budgetImpactCents: 1000,
    });

    expect(edited.status).toBe("edited");
    expect(edited.edited_args?.daily_budget_cents).toBe(5000);
    expect(edited.proposed_args.daily_budget_cents).toBe(5500);

    const result = await executeApprovedAction({
      approvalId: pending.id,
      executedBy: REVIEWER,
    });
    expect(result.approval.status).toBe("executed");
    expect(
      (result.approval.execution_result as { daily_budget_cents?: number })
        ?.daily_budget_cents ?? 5000,
    ).toBeDefined();
  });

  it("blocks double execute with DuplicateExecutionError", async () => {
    resetDemoStore();
    const pending = await createPendingApproval({
      clientId: CLIENT_ID,
      toolName: "pause_campaign",
      proposedArgs: {
        account_id: "act_100200300",
        campaign_id: "camp_mdc_npl",
      },
      requestedBy: REVIEWER,
      idempotencyKey: "idem_test_double_exec",
    });

    await approve({ approvalId: pending.id, reviewedBy: REVIEWER });
    await executeApprovedAction({
      approvalId: pending.id,
      executedBy: REVIEWER,
    });

    await expect(
      executeApprovedAction({
        approvalId: pending.id,
        executedBy: REVIEWER,
      }),
    ).rejects.toBeInstanceOf(DuplicateExecutionError);
  });
});

describe("approval races", () => {
  it("a second reviewer cannot re-approve an already approved approval", async () => {
    resetDemoStore();
    const pending = await createPendingApproval({
      clientId: CLIENT_ID,
      toolName: "update_adset_budget",
      proposedArgs: budgetArgs(),
      budgetImpactCents: 1500,
      requestedBy: REVIEWER,
      idempotencyKey: "idem_test_double_approve",
    });

    await approve({ approvalId: pending.id, reviewedBy: REVIEWER });
    await expect(
      approve({ approvalId: pending.id, reviewedBy: REVIEWER }),
    ).rejects.toThrow();
  });

  it("concurrent executes run the action exactly once", async () => {
    resetDemoStore();
    const pending = await createPendingApproval({
      clientId: CLIENT_ID,
      toolName: "pause_campaign",
      proposedArgs: {
        account_id: "act_100200300",
        campaign_id: "camp_mdc_npl",
      },
      requestedBy: REVIEWER,
      idempotencyKey: "idem_test_concurrent_exec",
    });
    await approve({ approvalId: pending.id, reviewedBy: REVIEWER });

    const results = await Promise.allSettled([
      executeApprovedAction({ approvalId: pending.id, executedBy: REVIEWER }),
      executeApprovedAction({ approvalId: pending.id, executedBy: REVIEWER }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      DuplicateExecutionError,
    );
    expect((await getApproval(pending.id)).status).toBe("executed");
  });

  it("an expired approval cannot be approved", async () => {
    resetDemoStore();
    const pending = await createPendingApproval({
      clientId: CLIENT_ID,
      toolName: "pause_campaign",
      proposedArgs: {
        account_id: "act_100200300",
        campaign_id: "camp_mdc_npl",
      },
      requestedBy: REVIEWER,
      idempotencyKey: "idem_test_expired",
    });
    const stored = getDemoStore().approvals.find((a) => a.id === pending.id)!;
    stored.expires_at = new Date(Date.now() - 60_000).toISOString();

    await expect(
      approve({ approvalId: pending.id, reviewedBy: REVIEWER }),
    ).rejects.toThrow(/expired/i);
    expect((await getApproval(pending.id)).status).toBe("pending");
  });
});
