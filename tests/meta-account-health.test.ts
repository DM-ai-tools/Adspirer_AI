import { describe, expect, it } from "vitest";
import "@/lib/tools/diagnose";
import { workspaceReadToolNames, buildWorkspaceReadToolSet } from "@/lib/agent/diagnose-tools-ai";
import { buildStaticSystemPromptV2 } from "@/lib/agent/prompts-v2";
import { capabilityPromptBlock } from "@/lib/agent/optimization-capabilities";
import { buildWriterMessages } from "@/lib/agent/adspirer-agent";
import { EMPTY_QUEUE, type RequestBrief } from "@/lib/agent/request-brief";
import { getDemoStore } from "@/lib/demo/store";
import { classify } from "@/lib/tools/policy";
import { humanToolLabel } from "@/lib/tools/display-labels";
import { invokeTool, type ToolContext } from "@/lib/tools/registry";
import type { Task } from "@/types";

const ctx: ToolContext = { clientId: "client_modern_dental", userId: "user_admin", taskId: "task_x" };
type HealthResult = {
  error?: boolean;
  not_mapped?: boolean;
  source?: string;
  period?: { since: string; until: string };
  scope?: Array<{ id: string }> | null;
  priorities: Array<{ id: string; owner: string; owner_label: string }>;
};
const call = (args: Record<string, unknown> = {}) => invokeTool("meta_account_health", args, ctx) as Promise<HealthResult>;

describe("meta_account_health", () => {
  it("is a read tool with an operator label", () => {
    expect(classify("meta_account_health")).toBe("diagnose");
    expect(humanToolLabel("meta_account_health")).not.toMatch(/_/);
  });

  it("returns the failing and warning checks with who has to fix each", async () => {
    const out = await call({ since: "2026-10-01", until: "2026-10-14" });
    expect(out.error).toBeUndefined();
    expect(out.source).toBe("Meta");
    expect(out.period).toMatchObject({ since: "2026-10-01", until: "2026-10-14" });
    expect(out.priorities.length).toBeGreaterThan(0);
    for (const p of out.priorities) {
      expect(p.owner).toMatch(/^(app|ads_manager|developer|landing_page|client)$/);
      expect(typeof p.owner_label).toBe("string");
    }
    const tracking = out.priorities.find((p: { id: string }) => p.id === "T4");
    expect(tracking?.owner).toBe("developer");
    expect(tracking?.owner_label).toBe("a developer");
  });

  it("can be limited to some campaigns", async () => {
    const all = await call();
    const scoped = await call({ campaign_ids: ["demo_campaign_2"] });
    expect(scoped.scope).toEqual([expect.objectContaining({ id: "demo_campaign_2" })]);
    expect(all.scope).toBeNull();
  });

  it("says plainly when no Meta account is mapped", async () => {
    const store = getDemoStore();
    store.connectedMetaAccounts = store.connectedMetaAccounts.filter((a) => a.client_id !== "client_modern_dental");
    const out = await call();
    expect(out).toMatchObject({ error: true, not_mapped: true, source: "Meta" });
  });

  it("rejects a malformed date instead of guessing", async () => {
    await expect(call({ since: "last tuesday" })).rejects.toThrow();
  });
});

describe("the writer's read tools", () => {
  it("include the optimisation reads and the health check, and nothing that writes", () => {
    const names = workspaceReadToolNames();
    for (const name of ["optimize_meta_budget", "detect_meta_creative_fatigue", "meta_account_health"]) {
      expect(names, name).toContain(name);
    }
    for (const name of Object.keys(buildWorkspaceReadToolSet(ctx))) expect(classify(name), name).toBe("diagnose");
  });

  it("leave out the placement tool that only returns generic advice", () => {
    expect(workspaceReadToolNames()).not.toContain("optimize_meta_placements");
  });
});

describe("the static system prompt", () => {
  const prompt = buildStaticSystemPromptV2();

  it("carries the generated capability list: what the app can queue and who does the rest", () => {
    expect(prompt).toContain(capabilityPromptBlock());
  });

  it("no longer sends the model to tools it cannot call, or tells it to queue every proposal", () => {
    expect(prompt).not.toMatch(/Use diagnose tools evidence: optimize_meta_budget/);
    expect(prompt).not.toMatch(/from the Ready-to-queue proposals in evidence/);
    expect(prompt).not.toMatch(/from Ready-to-queue proposals/);
  });

  it("keeps the safety rules", () => {
    expect(prompt).toMatch(/Approvals/);
    expect(prompt).toMatch(/PAUSED/);
    expect(prompt).toMatch(/Never name internal backends/);
  });

  it("never names the vendor", () => {
    expect(prompt).not.toMatch(/adspirer/i);
  });
});

describe("writer rules for an optimisation turn", () => {
  const task = { goal: "optimize my budget", title: "optimize my budget" } as Task;
  const brief = (over: Partial<RequestBrief>): RequestBrief => ({
    intent: "optimize",
    mode: "analyse",
    focus: ["budget"],
    scope: { mentions: [] },
    exclude: [],
    period: { since: "2026-10-21", until: "2026-10-27", label: "last 7 days", explicit: false },
    queue: { ...EMPTY_QUEUE },
    optimizationAsk: true,
    source: "rules",
    ...over,
  });
  const turn = (b: RequestBrief) => {
    const { messages } = buildWriterMessages({
      task,
      clientContext: "",
      toolEvidence: "### Scope and period\n- Period: 2026-10-21 → 2026-10-27\n\n### Numbered proposals\n- #1 [budget] Scale A → `update_adset_budget`",
      intent: "optimize",
      brief: b,
    });
    return messages.at(-1)!.content;
  };

  it("analyse: no queueing, numbers, who-does-what, period and scope", () => {
    const text = turn(brief({}));
    expect(text).toMatch(/do not queue anything/i);
    expect(text).toMatch(/#1/);
    expect(text).toMatch(/period and scope/i);
    expect(text).toMatch(/Who does what/);
    expect(text).toMatch(/queue #2/);
    expect(text).not.toMatch(/ONLY mark items as Ready to queue/);
  });

  it("act: the queue decision is final and the writer may not add or drop items", () => {
    const text = turn(brief({ mode: "act", queue: { ...EMPTY_QUEUE, requested: true, refs: [1] } }));
    expect(text).toMatch(/Queue decision/);
    expect(text).toMatch(/never add, drop or renumber/i);
    expect(text).toMatch(/Do not write tool JSON for items on the numbered list/);
    expect(text).not.toMatch(/do not queue anything/i);
  });

  it("act, direct change: the writer proposes exactly the named thing, never its ad sets or ads, and never calls it queued", () => {
    const text = turn(brief({ mode: "act", queue: { ...EMPTY_QUEUE, requested: true, entities: ["Brand"], kinds: ["pause"], phrased: false } }));
    expect(text).toMatch(/direct change/i);
    expect(text).toMatch(/exactly what they named/i);
    expect(text).toMatch(/not its ad sets or ads/i);
    expect(text).toMatch(/do not say it is queued/i);
  });

  it("an earlier report is only a guide to what to look at", () => {
    expect(turn(brief({}))).toMatch(/earlier report/i);
  });

  it("the follow-up capability answer defers to the generated list", () => {
    const { messages } = buildWriterMessages({
      task,
      clientContext: "",
      intent: "followup",
      history: [],
    });
    const text = messages.at(-1)!.content;
    expect(text).toMatch(/What can be done, and by whom/);
    expect(text).not.toMatch(/budgets, pausing\/resuming campaigns, ad sets and ads, creating ad sets/);
  });
});
