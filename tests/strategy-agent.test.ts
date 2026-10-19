import { describe, expect, it } from "vitest";
import { gatherDiagnoseEvidence, runAdspirerAgent } from "@/lib/agent/adspirer-agent";
import { createTask, runTask } from "@/lib/agent/task-runner";
import { STRATEGY_BRIEF_MARKER } from "@/lib/agent/strategy-brief";
import { getDemoStore } from "@/lib/demo/store";
import { classify, listClassifiedTools } from "@/lib/tools/policy";

const EXECUTE_TOOLS = new Set(listClassifiedTools().filter((t) => t.safety === "execute").map((t) => t.name));

async function strategyTurn(clientId: string, request: string) {
  const task = await createTask({ clientId, createdBy: "profile_operator_demo", title: request, goal: request });
  const gathered = await gatherDiagnoseEvidence({ clientId, request, intent: "strategy" });
  const result = await runAdspirerAgent({
    task,
    clientContext: "",
    toolEvidence: gathered.evidence,
    intent: "strategy",
  });
  const toolNames = [...gathered.toolCalls, ...result.toolCalls].map((c) => c.name);
  return { gathered, result, toolNames };
}

describe("strategy turn in DEMO_MODE", () => {
  it("answers with the three-level report from the plan engine", async () => {
    const { gathered, result, toolNames } = await strategyTurn(
      "client_modern_dental",
      "Plan to hit 10x ROAS on $500/day",
    );
    expect(result.mode).toBe("mock");
    expect(result.summary).toContain("Level 1");
    expect(result.summary).toContain("Level 2");
    expect(result.summary).toContain("Level 3");
    // The demo reply is the real engine output, not canned text.
    expect(result.summary).toContain("Dental Implants");
    expect(result.summary).toMatch(/Daily budget: \$500(\.00)?\/day/);
    expect(toolNames).toContain("audit_checkpoints");
    expect(toolNames).toContain("strategy_plan");
    expect(toolNames.filter((n) => EXECUTE_TOOLS.has(n))).toEqual([]);
    expect(classify("strategy_plan")).toBe("diagnose");
    expect(gathered.executeProposals ?? []).toEqual([]);
    expect(gathered.strategyBriefIncomplete).toBeFalsy();

    const plan = gathered.toolCalls.find((c) => c.name === "strategy_plan")!;
    expect(plan.rationale).toMatch(/^Strategy plan: target 10x, 2 categories, verdict (within|stretch|unrealistic)$/);
    expect(gathered.evidence).toContain("### Strategy framework");
    // Lead-gen client: user-facing copy says "service".
    expect(gathered.evidence).toContain("### Level 1: spend & return by service");
  });

  it("asks for the missing brief values and builds no plan", async () => {
    // TrafficRadius has no target ROAS and no daily cap set.
    const { gathered, result, toolNames } = await strategyTurn("client_trafficradius", "Build me a strategy");
    expect(gathered.strategyBriefIncomplete).toBe(true);
    expect(result.summary.toLowerCase()).toContain(STRATEGY_BRIEF_MARKER);
    expect(result.summary).toMatch(/Target ROAS/);
    expect(result.summary).not.toContain("Level 1");
    expect(toolNames).not.toContain("strategy_plan");
    expect(toolNames).not.toContain("audit_checkpoints");
  });

  it("keeps values from the earlier ask when the operator answers the brief question", async () => {
    const gathered = await gatherDiagnoseEvidence({
      clientId: "client_trafficradius",
      request: "$250/day",
      intent: "strategy",
      history: [
        { role: "user", content: "Plan to hit 7x ROAS" },
        { role: "assistant", content: "Reply with the missing piece and your strategy brief is done: daily budget?" },
      ],
    });
    expect(gathered.toolCalls.find((c) => c.name === "strategy_plan")?.args).toMatchObject({
      daily_budget_cents: 25_000,
      target_roas: 7,
    });
  });

  it("reaches the zero-category path without seeding a default service", async () => {
    const { gathered, toolNames } = await strategyTurn("client_trafficradius", "Plan to hit 4x ROAS on $200/day");
    expect(getDemoStore().clientServices.filter((s) => s.client_id === "client_trafficradius")).toEqual([]);
    expect(gathered.evidence).toMatch(/No (categories|services) loaded yet/);
    expect(gathered.evidence).toMatch(/No budget allocated: /);
    expect(toolNames).toContain("strategy_plan");
  });

  it("parks the task on the brief question with clarify_brief waiting", async () => {
    const task = await createTask({
      clientId: "client_trafficradius",
      createdBy: "profile_operator_demo",
      title: "Build me a strategy",
      goal: "Build me a strategy",
    });
    const done = await runTask(task.id);
    const steps = (done.agent_state?.steps ?? []) as Array<{ id: string; state: string }>;
    expect(steps.find((s) => s.id === "clarify_brief")?.state).toBe("waiting");
    expect(steps.find((s) => s.id === "build_plan")?.state).toBe("pending");
    expect(done.agent_state?.awaitingOperator).toBe(true);
    expect(getDemoStore().approvals.filter((a) => a.task_id === task.id)).toEqual([]);
  });

  it("completes the plan steps and queues no approvals on a full brief", async () => {
    const request = "Plan to hit 10x ROAS on $500/day";
    const task = await createTask({
      clientId: "client_modern_dental",
      createdBy: "profile_operator_demo",
      title: request,
      goal: request,
    });
    const done = await runTask(task.id);
    const steps = (done.agent_state?.steps ?? []) as Array<{ id: string; state: string }>;
    expect(steps.find((s) => s.id === "build_plan")?.state).toBe("done");
    expect(getDemoStore().approvals.filter((a) => a.task_id === task.id)).toEqual([]);
    const calls = getDemoStore().toolCalls.filter((c) => c.task_id === task.id).map((c) => c.tool_name);
    expect(calls).toContain("strategy_plan");
    expect(calls.filter((n) => EXECUTE_TOOLS.has(n))).toEqual([]);
  });
});
