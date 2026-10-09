import { describe, expect, it, vi } from "vitest";
import {
  approve,
  createPendingApproval,
  deriveIdempotencyKey,
  edit,
  getApproval,
  reject,
  STALE_EXECUTING_MS,
} from "@/lib/approvals/service";
import { executeApprovedAction } from "@/lib/approvals/executor";
import {
  ApprovalValidationError,
  BudgetCeilingViolation,
  ExecutionVerificationError,
  ToolClassificationError,
} from "@/lib/errors";
import { getDemoStore } from "@/lib/demo/store";
import { getProviderForBackend } from "@/lib/adspirer/client";

// Modern Dental: ceiling 250_000 cents, granted account act_100200300 (USD).
const CLIENT_ID = "client_modern_dental";
const REVIEWER = "profile_admin_demo";

function budgetArgs(cents: unknown = 5500) {
  return {
    account_id: "act_100200300",
    adset_id: "adset_mdc_npl_1",
    daily_budget_cents: cents,
    previous_daily_budget_cents: 4000,
  };
}

function imageCampaignArgs(overrides: Record<string, unknown> = {}) {
  return {
    account_id: "act_100200300",
    campaign_name: "Implants — Spring",
    objective: "OUTCOME_LEADS",
    budget_daily: 25,
    primary_text: "Book your consult",
    headline: "Dental implants",
    landing_page_url: "https://moderndental.example/implants",
    image_url: "https://moderndental.example/hero.jpg",
    locations: ["US"],
    facebook_page_id: "123456",
    ...overrides,
  };
}

describe("approval arg validation", () => {
  it("coerces numeric-string budgets and still enforces the ceiling", async () => {
    const ok = await createPendingApproval({
      clientId: CLIENT_ID,
      toolName: "update_adset_budget",
      proposedArgs: budgetArgs("5500"),
    });
    expect(ok.proposed_args.daily_budget_cents).toBe(5500);
    expect(ok.budget_impact_cents).toBe(1500);
    expect(ok.proposed_args.__account_currency).toBe("USD");

    // A string used to bypass the ceiling (typeof !== "number").
    await expect(
      createPendingApproval({
        clientId: CLIENT_ID,
        toolName: "update_adset_budget",
        proposedArgs: budgetArgs("500000"),
      }),
    ).rejects.toBeInstanceOf(BudgetCeilingViolation);
  });

  it("rejects non-numeric and fractional cent budgets", async () => {
    await expect(
      createPendingApproval({
        clientId: CLIENT_ID,
        toolName: "update_adset_budget",
        proposedArgs: budgetArgs("$55"),
      }),
    ).rejects.toThrow(/must be a plain number/);
    await expect(
      createPendingApproval({
        clientId: CLIENT_ID,
        toolName: "update_adset_budget",
        proposedArgs: budgetArgs(5500.5),
      }),
    ).rejects.toThrow(/whole number of cents/);
    await expect(
      createPendingApproval({
        clientId: CLIENT_ID,
        toolName: "update_adset_budget",
        proposedArgs: budgetArgs(-100),
      }),
    ).rejects.toBeInstanceOf(ApprovalValidationError);
  });

  it("enforces the ceiling on major-unit campaign budgets given as strings", async () => {
    await expect(
      createPendingApproval({
        clientId: CLIENT_ID,
        toolName: "create_meta_image_campaign",
        proposedArgs: imageCampaignArgs({ budget_daily: "5000" }),
      }),
    ).rejects.toBeInstanceOf(BudgetCeilingViolation);
  });

  it("flags a create without a location and refuses to execute it", async () => {
    const provider = getProviderForBackend(null);
    const spy = vi.spyOn(provider, "createImageCampaign");
    const queued = await createPendingApproval({
      clientId: CLIENT_ID,
      toolName: "create_meta_image_campaign",
      proposedArgs: imageCampaignArgs({ locations: undefined }),
    });
    // Queued for the operator to fix, never defaulted to a country.
    expect(queued.execution_error).toMatch(/No targeting location/);
    expect(queued.proposed_args.locations).toBeUndefined();

    await approve({ approvalId: queued.id, reviewedBy: REVIEWER });
    await expect(
      executeApprovedAction({ approvalId: queued.id, executedBy: REVIEWER }),
    ).rejects.toThrow(/No targeting location/);
    expect(spy).not.toHaveBeenCalled();
    expect((await getApproval(queued.id)).status).toBe("edited");

    // An edit must supply it.
    await expect(
      edit({
        approvalId: queued.id,
        reviewedBy: REVIEWER,
        editedArgs: imageCampaignArgs({ locations: [] }),
      }),
    ).rejects.toThrow(/No targeting location/);
    spy.mockRestore();
  });

  it("rejects unusable locations outright", async () => {
    await expect(
      createPendingApproval({
        clientId: CLIENT_ID,
        toolName: "create_meta_image_campaign",
        proposedArgs: imageCampaignArgs({ locations: ["Narnia"] }),
      }),
    ).rejects.toThrow(/No targeting location/);
  });

  it("requires end_time with a lifetime budget and rejects unknown CTAs", async () => {
    const queued = await createPendingApproval({
      clientId: CLIENT_ID,
      toolName: "create_meta_image_campaign",
      proposedArgs: imageCampaignArgs({
        budget_daily: undefined,
        budget_lifetime: 300,
      }),
    });
    expect(queued.execution_error).toMatch(/budget_lifetime requires end_time/);
    await expect(
      createPendingApproval({
        clientId: CLIENT_ID,
        toolName: "create_meta_image_campaign",
        proposedArgs: imageCampaignArgs({ call_to_action: "CLICK_HERE" }),
      }),
    ).rejects.toThrow(/not a Meta button type/);
  });

  it("rejects fields the executor cannot apply instead of dropping them", async () => {
    await expect(
      createPendingApproval({
        clientId: CLIENT_ID,
        toolName: "create_meta_image_campaign",
        proposedArgs: imageCampaignArgs({ daily_spend_cap: 50 }),
      }),
    ).rejects.toThrow(/daily_spend_cap/);
  });

  it("rejects ad accounts that are not granted to the client", async () => {
    await expect(
      createPendingApproval({
        clientId: CLIENT_ID,
        toolName: "pause_campaign",
        proposedArgs: { account_id: "act_400500600", campaign_id: "camp_x" },
      }),
    ).rejects.toThrow(/not a granted Meta account/);
  });

  it("does not queue tools that have no executor", async () => {
    await expect(
      createPendingApproval({
        clientId: CLIENT_ID,
        toolName: "optimize_meta_budget_v2",
        proposedArgs: { account_id: "act_100200300" },
      }),
    ).rejects.toBeInstanceOf(ToolClassificationError);
  });
});

describe("deterministic idempotency", () => {
  it("reuses the pending approval for a duplicate proposal in the same task", async () => {
    const first = await createPendingApproval({
      clientId: CLIENT_ID,
      taskId: "task_mdc_audit_1",
      toolName: "pause_campaign",
      proposedArgs: { account_id: "act_100200300", campaign_id: "camp_mdc_npl" },
    });
    const again = await createPendingApproval({
      clientId: CLIENT_ID,
      taskId: "task_mdc_audit_1",
      toolName: "pause_campaign",
      // Same proposal, different key order.
      proposedArgs: { campaign_id: "camp_mdc_npl", account_id: "act_100200300" },
    });
    expect(again.id).toBe(first.id);

    const otherTask = await createPendingApproval({
      clientId: CLIENT_ID,
      taskId: "task_other",
      toolName: "pause_campaign",
      proposedArgs: { account_id: "act_100200300", campaign_id: "camp_mdc_npl" },
    });
    expect(otherTask.id).not.toBe(first.id);
  });

  it("derives the same key regardless of key order and internal fields", () => {
    const a = deriveIdempotencyKey({
      clientId: "c",
      toolName: "t",
      taskId: "k",
      args: { b: 1, a: { y: 2, x: 1 }, __provider_backend: "meta_direct" },
    });
    const b = deriveIdempotencyKey({
      clientId: "c",
      toolName: "t",
      taskId: "k",
      args: { a: { x: 1, y: 2 }, b: 1 },
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^idem_[0-9a-f]{40}$/);
  });

  it("queues a fresh approval after the previous identical one was rejected", async () => {
    const first = await createPendingApproval({
      clientId: CLIENT_ID,
      taskId: "task_mdc_audit_1",
      toolName: "pause_campaign",
      proposedArgs: { account_id: "act_100200300", campaign_id: "camp_mdc_npl" },
    });
    await reject({ approvalId: first.id, reviewedBy: REVIEWER });
    const second = await createPendingApproval({
      clientId: CLIENT_ID,
      taskId: "task_mdc_audit_1",
      toolName: "pause_campaign",
      proposedArgs: { account_id: "act_100200300", campaign_id: "camp_mdc_npl" },
    });
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("pending");
  });
});

describe("edit", () => {
  it("re-validates, recomputes the budget impact and clears the old error", async () => {
    const pending = await createPendingApproval({
      clientId: CLIENT_ID,
      toolName: "update_adset_budget",
      proposedArgs: { ...budgetArgs(5500), __provider_backend: "meta_direct" },
    });
    const stored = getDemoStore().approvals.find((a) => a.id === pending.id)!;
    stored.execution_error = "old failure";

    const edited = await edit({
      approvalId: pending.id,
      reviewedBy: REVIEWER,
      editedArgs: budgetArgs("9000"),
      budgetImpactCents: 1, // ignored — recomputed from the args
    });
    expect(edited.edited_args?.daily_budget_cents).toBe(9000);
    expect(edited.budget_impact_cents).toBe(5000);
    expect(edited.execution_error).toBeNull();
    // Internal routing key carried over even though the editor hid it.
    expect(edited.edited_args?.__provider_backend).toBe("meta_direct");

    await expect(
      edit({
        approvalId: pending.id,
        reviewedBy: REVIEWER,
        editedArgs: budgetArgs("900000"),
      }),
    ).rejects.toBeInstanceOf(BudgetCeilingViolation);
  });
});

describe("execution state", () => {
  it("marks a read-back mismatch as failed (not executed, not silently edited)", async () => {
    const provider = getProviderForBackend(null);
    const spy = vi
      .spyOn(provider, "updateAdSetBudget")
      .mockRejectedValueOnce(
        new ExecutionVerificationError("Meta reads back 40.00 instead of 55.00"),
      );
    const pending = await createPendingApproval({
      clientId: CLIENT_ID,
      toolName: "update_adset_budget",
      proposedArgs: budgetArgs(5500),
    });
    await approve({ approvalId: pending.id, reviewedBy: REVIEWER });
    await expect(
      executeApprovedAction({ approvalId: pending.id, executedBy: REVIEWER }),
    ).rejects.toBeInstanceOf(ExecutionVerificationError);

    const after = await getApproval(pending.id);
    expect(after.status).toBe("failed");
    expect(after.execution_error).toMatch(/reads back/);
    spy.mockRestore();
  });

  it("returns ordinary failures to edited with the error recorded", async () => {
    const provider = getProviderForBackend(null);
    const spy = vi
      .spyOn(provider, "pauseCampaign")
      .mockRejectedValueOnce(new Error("Meta said no"));
    const pending = await createPendingApproval({
      clientId: CLIENT_ID,
      toolName: "pause_campaign",
      proposedArgs: { account_id: "act_100200300", campaign_id: "camp_mdc_npl" },
    });
    await approve({ approvalId: pending.id, reviewedBy: REVIEWER });
    await expect(
      executeApprovedAction({ approvalId: pending.id, executedBy: REVIEWER }),
    ).rejects.toThrow(/Meta said no/);
    const after = await getApproval(pending.id);
    expect(after.status).toBe("edited");
    expect(after.execution_error).toMatch(/Meta said no/);
    spy.mockRestore();
  });

  it("reaps approvals stuck in executing for over 10 minutes", async () => {
    const pending = await createPendingApproval({
      clientId: CLIENT_ID,
      toolName: "pause_campaign",
      proposedArgs: { account_id: "act_100200300", campaign_id: "camp_mdc_npl" },
    });
    const stored = getDemoStore().approvals.find((a) => a.id === pending.id)!;
    stored.status = "executing";
    stored.updated_at = new Date(Date.now() - STALE_EXECUTING_MS - 60_000).toISOString();

    const reaped = await getApproval(pending.id);
    expect(reaped.status).toBe("failed");
    expect(reaped.execution_error).toMatch(/did not finish within 10 minutes/);
  });

  it("stores verified proof for budget updates", async () => {
    const pending = await createPendingApproval({
      clientId: CLIENT_ID,
      toolName: "update_adset_budget",
      proposedArgs: budgetArgs(5500),
    });
    await approve({ approvalId: pending.id, reviewedBy: REVIEWER });
    const { approval } = await executeApprovedAction({
      approvalId: pending.id,
      executedBy: REVIEWER,
    });
    expect(approval.status).toBe("executed");
    expect(approval.execution_result?.proof).toMatchObject({
      ad_set_id: "adset_mdc_npl_1",
      daily_budget_cents: 5500,
    });
  });
});
