import { afterEach, describe, expect, it, vi } from "vitest";
import { gatherDiagnoseEvidence, runAdspirerAgent } from "@/lib/agent/adspirer-agent";
import { createTask, runTask } from "@/lib/agent/task-runner";
import { detectRequestIntent } from "@/lib/agent/task-plan";
import { getDemoStore, resetDemoStore } from "@/lib/demo/store";
import { GoogleReconnectRequired } from "@/lib/google/oauth";
import { getGoogleDataProvider } from "@/lib/google/provider";
import { getMockGoogleDataProvider } from "@/lib/google/mock-provider";
import { loadChannelSnapshot } from "@/lib/google/snapshot";
import { listClassifiedTools } from "@/lib/tools/policy";

vi.mock("@/lib/google/snapshot", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/google/snapshot")>();
  return { ...actual, loadChannelSnapshot: vi.fn(actual.loadChannelSnapshot) };
});
vi.mock("@/lib/google/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/google/provider")>();
  return { ...actual, getGoogleDataProvider: vi.fn(actual.getGoogleDataProvider) };
});

const EXECUTE_TOOLS = new Set(listClassifiedTools().filter((t) => t.safety === "execute").map((t) => t.name));
const LABEL = "Google budget is a recommendation for the Google Ads account — this tool doesn't change Google.";
const STRATEGY_ASK = "How do we spend $4k and get $40k back on bar stools using Google Ads and Meta together?";
const SPEND_ASK =
  "How much has gone into bar stools, what did it return, and what was the best category in the last 30 days?";
const CT = "client_clicktrends";

afterEach(() => {
  resetDemoStore();
  vi.mocked(loadChannelSnapshot).mockClear();
});

/** Text of one evidence section, from its heading to the next `### `. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const next = text.indexOf("\n### ", start + heading.length);
  return text.slice(start, next < 0 ? undefined : next);
}

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

describe("cross-channel strategy for ClickTrends in DEMO_MODE", () => {
  it("answers Karthik's $4k → $40k bar-stools ask with a Meta and Google split", async () => {
    expect(detectRequestIntent(STRATEGY_ASK)).toBe("strategy");
    const { gathered, result, toolNames } = await strategyTurn(CT, STRATEGY_ASK);
    const evidence = gathered.evidence;
    expect(evidence).toContain("### Level 1");
    expect(evidence).toContain("### Level 2");
    expect(evidence).toContain("### Level 3");
    expect(evidence).toContain("### Level 3: channel split");
    expect(evidence).toContain("30 days");
    expect(evidence).toContain(LABEL);
    expect(section(evidence, "### Scope")).toContain("Bar stools");

    const split = section(evidence, "### Level 3: channel split");
    const bar = split.split("\n").find((l) => l.startsWith("| Bar stools |"))!;
    expect(bar).toBeDefined();
    // Daily budget, Meta budget, Google budget: Google gets a real share.
    const [, daily, meta, google] = bar.split(" | ");
    expect(daily).toBe("$133.33");
    expect(google).not.toBe("$0.00");
    expect(Number(meta.replace(/[$,]/g, "")) + Number(google.replace(/[$,]/g, ""))).toBeCloseTo(133.33, 2);

    // The demo reply carries the channel split too.
    expect(result.summary).toContain("### Level 3: channel split");
    expect(result.summary).toContain(LABEL);

    expect(toolNames).toContain("strategy_plan");
    expect(toolNames.filter((n) => EXECUTE_TOOLS.has(n))).toEqual([]);
    expect(gathered.executeProposals ?? []).toEqual([]);
    expect(vi.mocked(loadChannelSnapshot)).toHaveBeenCalledWith(CT, expect.objectContaining({ since: expect.any(String), until: expect.any(String) }));
  });

  it("queues no approvals and no execute tools for the cross-channel plan", async () => {
    const task = await createTask({ clientId: CT, createdBy: "profile_operator_demo", title: STRATEGY_ASK, goal: STRATEGY_ASK });
    const done = await runTask(task.id);
    const steps = (done.agent_state?.steps ?? []) as Array<{ id: string; state: string }>;
    expect(steps.find((s) => s.id === "build_plan")?.state).toBe("done");
    expect(getDemoStore().approvals.filter((a) => a.task_id === task.id)).toEqual([]);
    const calls = getDemoStore().toolCalls.filter((c) => c.task_id === task.id).map((c) => c.tool_name);
    expect(calls).toContain("strategy_plan");
    expect(calls.filter((n) => EXECUTE_TOOLS.has(n))).toEqual([]);
  });

  it("answers the bar-stools spend question with GA4 revenue, best category first", async () => {
    const intent = detectRequestIntent(SPEND_ASK);
    expect(["general", "budget"]).toContain(intent);
    const gathered = await gatherDiagnoseEvidence({ clientId: CT, request: SPEND_ASK, intent });
    const spend = section(gathered.evidence, "### Spend & return by category");
    expect(spend).toContain("GA4 revenue");
    expect(spend).toContain("Ranked by: GA4 revenue");
    const rows = spend.split("\n").filter((l) => /^\| (Bar stools|Sofas) /.test(l));
    expect(rows[0]).toMatch(/^\| Bar stools /);
    expect(gathered.toolCalls.map((c) => c.name)).not.toContain("strategy_plan");
    expect(gathered.toolCalls.map((c) => c.name).filter((n) => EXECUTE_TOOLS.has(n))).toEqual([]);
    expect(gathered.executeProposals ?? []).toEqual([]);
  });

  it("says Google needs reconnecting when the token is revoked, and still plans on Meta", async () => {
    vi.mocked(getGoogleDataProvider).mockReturnValue({
      ...getMockGoogleDataProvider(),
      ga4CategoryRevenue: async () => {
        throw new GoogleReconnectRequired();
      },
    });
    const { gathered } = await strategyTurn(CT, STRATEGY_ASK);
    expect(section(gathered.evidence, "### Channel data")).toContain(
      "Google needs reconnecting — an admin can reconnect under Connections",
    );
    expect(gathered.strategyPlanBuilt).toBe(true);
    vi.mocked(getGoogleDataProvider).mockReset();
  });

  it("keeps going on Meta, with a warning, when the Google load fails unexpectedly", async () => {
    vi.mocked(loadChannelSnapshot).mockRejectedValueOnce(new Error("database is down"));
    const { gathered, toolNames } = await strategyTurn(CT, STRATEGY_ASK);
    expect(section(gathered.evidence, "### Channel data")).toContain("database is down");
    expect(gathered.evidence).not.toContain("### Level 3: channel split");
    expect(gathered.evidence).toContain("| Category | Spend (30d) | Revenue | ROAS | Tier | Match |");
    expect(toolNames).toContain("strategy_plan");
  });

  it("keeps a category-spend answer on Meta, with a warning, when the Google load fails", async () => {
    vi.mocked(loadChannelSnapshot).mockRejectedValueOnce(new Error("database is down"));
    const gathered = await gatherDiagnoseEvidence({ clientId: CT, request: SPEND_ASK, intent: detectRequestIntent(SPEND_ASK) });
    const spend = section(gathered.evidence, "### Spend & return by category");
    expect(spend).toContain("database is down");
    expect(spend).toContain("| Category | Spend (30d) | Revenue | ROAS | Match |");
  });
});

describe("clients with no Google asset mapped", () => {
  it("gets today's Meta-only strategy evidence, with no Google data loaded", async () => {
    const { gathered } = await strategyTurn("client_modern_dental", "Plan to hit 10x ROAS on $500/day");
    // The engine's evidence, up to the framework text (which mentions GA4 generically).
    const start = gathered.evidence.indexOf("### Strategy inputs");
    const evidence = gathered.evidence.slice(start, gathered.evidence.indexOf("### Strategy framework", start));
    expect(evidence).toContain("### Level 1: spend & return by service");
    for (const h of ["### Scope", "### Channel data", "### Google campaign types", "### Search demand", "channel split", "GA4", "Google"]) {
      expect(evidence).not.toContain(h);
    }
  });

  it("gets today's category-spend evidence when ClickTrends' Google assets are unmapped", async () => {
    const store = getDemoStore();
    for (const a of store.googleAssets) a.mapped_client_id = null;
    const gathered = await gatherDiagnoseEvidence({ clientId: CT, request: SPEND_ASK, intent: detectRequestIntent(SPEND_ASK) });
    const spend = section(gathered.evidence, "### Spend & return by category");
    expect(spend).toContain("| Category | Spend (30d) | Revenue | ROAS | Match |");
    expect(spend).not.toMatch(/Ranked by|GA4|Google|Warning/);
  });
});
