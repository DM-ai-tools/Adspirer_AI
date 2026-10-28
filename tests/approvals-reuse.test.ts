import { describe, expect, it } from "vitest";
import { approve, createPendingApproval, reject } from "@/lib/approvals/service";

const CLIENT = "client_modern_dental";
const REVIEWER = "profile_admin_demo";
const ARGS = { account_id: "act_100200300", adset_id: "adset_mdc_npl_2" };

const propose = (taskId: string, reuseAcrossTasks?: boolean) =>
  createPendingApproval({
    clientId: CLIENT,
    taskId,
    toolName: "pause_adset",
    proposedArgs: { ...ARGS },
    reuseAcrossTasks,
  });

describe("reusing an approval that is still in flight", () => {
  it("two tasks proposing the same change get two approvals by default", async () => {
    const a = await propose("task_a");
    const b = await propose("task_b");
    expect(b.id).not.toBe(a.id);
  });

  it("with reuseAcrossTasks the second task gets the pending one back", async () => {
    const a = await propose("task_a", true);
    const b = await propose("task_b", true);
    expect(b.id).toBe(a.id);
    expect(b.task_id).toBe("task_a");
  });

  it("an approved-but-not-yet-executed approval is reused too", async () => {
    const a = await propose("task_a", true);
    await approve({ approvalId: a.id, reviewedBy: REVIEWER });
    expect((await propose("task_b", true)).id).toBe(a.id);
  });

  it("a rejected approval is not reused: the operator may want it again", async () => {
    const a = await propose("task_a", true);
    await reject({ approvalId: a.id, reviewedBy: REVIEWER });
    const b = await propose("task_b", true);
    expect(b.id).not.toBe(a.id);
    expect(b.status).toBe("pending");
  });
});
