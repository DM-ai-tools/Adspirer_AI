import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateText = vi.fn();
vi.mock("ai", () => ({ generateText: (...a: unknown[]) => generateText(...a) }));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI: () => () => "model" }));
vi.mock("@/lib/config", () => ({
  getConfig: () => ({ hasOpenAI: true, OPENAI_API_KEY: "k", OPENAI_MODEL: "m", hasAnthropic: false }),
}));

import { classifyIntent, classifyRequest } from "@/lib/agent/intent-classifier";
import { normalizeBrief, rulesBrief } from "@/lib/agent/request-brief";

const report = (campaign: string) => [
  { role: "user" as const, content: `audit the campaign ${campaign} for the last 30 days` },
  {
    role: "assistant" as const,
    content: `Meta Ads Account Audit — ${campaign}\n${"F2 Frequency within healthy range Pass. ".repeat(40)}`,
  },
];

const modelJson = {
  intent: "optimize",
  mode: "analyse",
  focus: ["budget"],
  scope: [],
  periodStated: false,
  optimizationAsk: true,
  queue: { requested: false, all: false, refs: [], focus: [], entities: [] },
  exclude: [],
};

beforeEach(() => {
  generateText.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-28T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("classifyRequest", () => {
  it("returns the model's brief", async () => {
    generateText.mockResolvedValue({ text: JSON.stringify(modelJson) });
    const brief = await classifyRequest("tighten up my budgets please", []);
    expect(brief).toMatchObject({ intent: "optimize", mode: "analyse", focus: ["budget"], source: "model" });
    expect(brief.period).toMatchObject({ since: "2026-10-21", until: "2026-10-27", explicit: false });
  });

  it("falls back to the rules on junk, an error and an abort, without throwing", async () => {
    generateText.mockResolvedValueOnce({ text: "I think it is an audit" });
    expect((await classifyRequest("audit this account", [])).source).toBe("rules");
    generateText.mockRejectedValueOnce(new Error("boom"));
    expect((await classifyRequest("audit this account", [])).source).toBe("rules");
    generateText.mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "AbortError" }));
    const brief = await classifyRequest("audit this account", []);
    expect(brief).toMatchObject({ source: "rules", intent: "audit" });
  });

  it("asks the model for the whole brief, with room to answer and a longer timeout", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    generateText.mockResolvedValue({ text: JSON.stringify(modelJson) });
    await classifyRequest("optimise", []);
    const call = generateText.mock.calls[0][0];
    expect(call.system).toMatch(/"mode"/);
    expect(call.system).toMatch(/"focus"/);
    expect(call.system).toMatch(/"queue"/);
    expect(call.system).toMatch(/"exclude"/);
    expect(call.maxOutputTokens).toBeGreaterThanOrEqual(300);
    expect(timeout).toHaveBeenCalledWith(8000);
  });

  it("an intent-only reply still works (older shape)", async () => {
    generateText.mockResolvedValue({ text: '{"intent":"list_campaigns"}' });
    await expect(classifyIntent("show campaigns", [])).resolves.toBe("list_campaigns");
  });

  it("a model that says followup for an optimisation-steps ask is re-routed to live optimize", async () => {
    generateText.mockResolvedValue({ text: '{"intent":"followup"}' });
    const brief = await classifyRequest("based on the audit give me the optimization steps", report("TR Lead"));
    expect(brief).toMatchObject({ intent: "optimize", mode: "analyse", optimizationAsk: true });
    expect(brief.queue.requested).toBe(false);
  });

  it("a capability question after a report stays a data-free follow-up", async () => {
    generateText.mockResolvedValue({ text: '{"intent":"followup"}' });
    const brief = await classifyRequest("which of these can you do?", report("TR Lead"));
    expect(brief.intent).toBe("followup");
  });
});

describe("normalizeBrief", () => {
  it("leaves a follow-up without an optimisation ask unchanged", () => {
    const brief = { ...rulesBrief("which of these can you do?", report("TR Lead")), intent: "followup" as const };
    expect(normalizeBrief(brief, "which of these can you do?", report("TR Lead"))).toEqual(brief);
  });

  it("re-routes a follow-up that asks for optimisation steps", () => {
    const history = report("TR Lead");
    const brief = { ...rulesBrief("give me the optimization steps", history), intent: "followup" as const };
    const out = normalizeBrief(brief, "give me the optimization steps", history);
    expect(out).toMatchObject({ intent: "optimize", mode: "analyse" });
    expect(out.period).not.toBeNull();
  });

  it("keeps the campaign the conversation was working on", () => {
    const history = report("TR Lead");
    const out = normalizeBrief(
      rulesBrief("give me the optimization steps", history),
      "give me the optimization steps",
      history,
    );
    expect(out.scope.mentions).toEqual(["TR Lead"]);
  });

  it("does not keep it when the operator says entire account", () => {
    const history = report("TR Lead");
    const ask = "optimize the entire account";
    const out = normalizeBrief(rulesBrief(ask, history), ask, history);
    expect(out.scope.mentions).toEqual([]);
  });

  it("does not keep a campaign the operator said not to touch", () => {
    const history = report("TR Lead");
    const ask = "give me the optimization steps but leave the TR Lead campaign alone";
    const out = normalizeBrief(rulesBrief(ask, history), ask, history);
    expect(out.scope.mentions).toEqual([]);
    expect(out.exclude).toEqual(["TR Lead"]);
  });

  it("a budget request that changes something goes through the optimize flow", () => {
    const base = rulesBrief('increase the budget of the "Leads" campaign by 20%', []);
    const out = normalizeBrief({ ...base, intent: "budget" }, "increase the budget of the Leads campaign", []);
    expect(out.intent).toBe("optimize");
    expect(out.mode).toBe(base.mode);
  });

  it("a budget ask for advice goes through the optimize flow too", () => {
    const base = rulesBrief("how should I optimise my budget?", []);
    const out = normalizeBrief({ ...base, intent: "budget", optimizationAsk: true }, "how should I optimise my budget?", []);
    expect(out.intent).toBe("optimize");
    expect(out.mode).toBe("analyse");
  });

  it("a plain budget question stays a budget question", () => {
    const base = rulesBrief("what is my budget?", []);
    const out = normalizeBrief({ ...base, intent: "budget", optimizationAsk: false, mode: "analyse" }, "what is my budget?", []);
    expect(out.intent).toBe("budget");
  });

  it("does not inherit a scope into a queue request", () => {
    const history = [
      ...report("TR Lead"),
      { role: "assistant" as const, content: "#1 Scale ad set. #2 Trim ad set. budget Approvals" },
    ];
    const out = normalizeBrief(rulesBrief("queue #1", history), "queue #1", history);
    expect(out.queue.requested).toBe(true);
    expect(out.scope.mentions).toEqual([]);
  });
});
