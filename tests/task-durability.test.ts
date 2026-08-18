import { describe, expect, it } from "vitest";
import {
  createTask,
  getTask,
  pauseTask,
} from "@/lib/agent/task-runner";
import {
  approve,
  createPendingApproval,
} from "@/lib/approvals/service";
import { executeApprovedAction } from "@/lib/approvals/executor";
import { getDemoStore, resetDemoStore } from "@/lib/demo/store";
import { nowIso } from "@/lib/utils";

describe("task durability", () => {
  it("pause persists status and paused_at", async () => {
    resetDemoStore();
    const task = await createTask({
      clientId: "client_modern_dental",
      createdBy: "profile_operator_demo",
      title: "Pause durability test",
      goal: "Verify pause checkpoint",
    });

    const paused = await pauseTask(task.id);
    expect(paused.status).toBe("paused");
    expect(paused.paused_at).toBeTruthy();
    expect(paused.agent_state?.phase).toBe("paused");

    const reloaded = await getTask(task.id);
    expect(reloaded.status).toBe("paused");
    expect(reloaded.paused_at).toBe(paused.paused_at);
  });

  it("persists waiting_approval state", async () => {
    resetDemoStore();
    const task = await createTask({
      clientId: "client_modern_dental",
      createdBy: "profile_operator_demo",
      title: "Waiting approval durability",
      goal: "Budget change",
    });

    const approval = await createPendingApproval({
      clientId: task.client_id,
      taskId: task.id,
      toolName: "update_adset_budget",
      proposedArgs: {
        account_id: "act_100200300",
        adset_id: "adset_mdc_npl_1",
        daily_budget_cents: 5500,
        previous_daily_budget_cents: 4000,
      },
      budgetImpactCents: 1500,
      requestedBy: task.created_by,
      idempotencyKey: `idem_wait_${task.id}`,
    });

    const store = getDemoStore();
    const row = store.tasks.find((t) => t.id === task.id)!;
    row.status = "waiting_approval";
    row.agent_state = {
      phase: "awaiting_approval",
      pending_approval_id: approval.id,
      last_tool: "update_adset_budget",
    };
    row.updated_at = nowIso();

    const waiting = await getTask(task.id);
    expect(waiting.status).toBe("waiting_approval");
    expect(waiting.agent_state?.pending_approval_id).toBe(approval.id);
  });

  it("resumes (completes) after approval execution", async () => {
    resetDemoStore();
    const task = await createTask({
      clientId: "client_modern_dental",
      createdBy: "profile_operator_demo",
      title: "Resume after approval",
      goal: "Apply approved budget change",
    });

    const approval = await createPendingApproval({
      clientId: task.client_id,
      taskId: task.id,
      toolName: "update_adset_budget",
      proposedArgs: {
        account_id: "act_100200300",
        adset_id: "adset_mdc_npl_1",
        daily_budget_cents: 5500,
        previous_daily_budget_cents: 4000,
      },
      budgetImpactCents: 1500,
      requestedBy: task.created_by,
      idempotencyKey: `idem_resume_${task.id}`,
    });

    const store = getDemoStore();
    const row = store.tasks.find((t) => t.id === task.id)!;
    row.status = "waiting_approval";
    row.agent_state = {
      phase: "awaiting_approval",
      pending_approval_id: approval.id,
    };
    row.updated_at = nowIso();

    await approve({
      approvalId: approval.id,
      reviewedBy: "profile_admin_demo",
    });

    const executed = await executeApprovedAction({
      approvalId: approval.id,
      executedBy: "profile_admin_demo",
    });
    expect(executed.approval.status).toBe("executed");

    const after = await getTask(task.id);
    expect(after.status).toBe("done");
    expect(after.agent_state?.phase).toBe("completed");
    expect(after.completed_at).toBeTruthy();
  });
});
