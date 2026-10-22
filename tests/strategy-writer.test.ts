import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { gatherDiagnoseEvidence, runAdspirerAgent } from "@/lib/agent/adspirer-agent";
import { createTask } from "@/lib/agent/task-runner";
import { buildStrategyClarifyingQuestion } from "@/lib/agent/strategy-brief";

// The writer runs on a stubbed model: these tests see the prompt it gets, or that it is never called.
const streamText = vi.fn();
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  streamText: (...args: unknown[]) => streamText(...args),
}));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: () => () => ({ provider: "stub" }) }));

function userTurn(): string {
  const call = streamText.mock.calls.at(-1)?.[0] as { messages: Array<{ role: string; content: string }> };
  return call.messages.at(-1)!.content;
}

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  resetConfigCache();
  streamText.mockImplementation(() => ({
    fullStream: (async function* () {
      yield { type: "start-step" };
      yield { type: "text-delta", text: "Written by the model." };
    })(),
  }));
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  resetConfigCache();
});

async function writeStrategy(clientId: string, request: string, history: Array<{ role: "user" | "assistant"; content: string }> = []) {
  const task = await createTask({ clientId, createdBy: "profile_operator_demo", title: request, goal: request });
  const gathered = await gatherDiagnoseEvidence({ clientId, request, intent: "strategy", history });
  const result = await runAdspirerAgent({ task, clientContext: "", toolEvidence: gathered.evidence, intent: "strategy", history });
  return { gathered, result };
}

describe("strategy writer with an LLM configured", () => {
  it("replies with exactly the clarifying question, without calling the model, when the brief is incomplete", async () => {
    const { gathered, result } = await writeStrategy("client_trafficradius", "Build me a strategy");
    expect(gathered.strategyBriefIncomplete).toBe(true);
    expect(streamText).not.toHaveBeenCalled();
    // The demo account's current spend fills the budget, so only the target is asked for.
    expect(result.summary).toBe(buildStrategyClarifyingQuestion(["target_roas"]));
    expect(result.toolCalls).toEqual([]);
  });

  it("asks for exactly the fields the evidence lists as missing", async () => {
    const task = await createTask({ clientId: "client_trafficradius", createdBy: "profile_operator_demo", title: "x", goal: "x" });
    for (const missing of [["budget"], ["budget", "target_roas"]] as const) {
      const result = await runAdspirerAgent({
        task,
        clientContext: "",
        intent: "strategy",
        toolEvidence: `### Strategy brief incomplete\n- Missing: ${missing.join(", ")}\nAsk ONLY for the missing values below.`,
      });
      expect(result.summary).toBe(buildStrategyClarifyingQuestion([...missing]));
    }
    expect(streamText).not.toHaveBeenCalled();
  });

  it("tells the writer the plan can't be built when no Meta account is mapped", async () => {
    const store = getDemoStore();
    store.connectedMetaAccounts = store.connectedMetaAccounts.filter((a) => a.client_id !== "client_modern_dental");
    const { result } = await writeStrategy("client_modern_dental", "Plan to hit 10x ROAS on $500/day");
    expect(result.mode).toBe("anthropic");
    const turn = userTurn();
    expect(turn).toContain("### Strategy unavailable");
    expect(turn).toMatch(/strategy plan can't be built/);
    expect(turn).toMatch(/Give NO tiers, allocations/);
    expect(turn).not.toMatch(/Write the strategy report using the headings/);
  });

  it("keeps text from separate model steps apart instead of running it together", async () => {
    streamText.mockImplementation(() => ({
      fullStream: (async function* () {
        yield { type: "start-step" };
        yield { type: "text-delta", text: "Let me pull the data now." };
        yield { type: "start-step" };
        yield { type: "text-delta", text: "Here are the results." };
      })(),
    }));
    const { result } = await writeStrategy("client_modern_dental", "Plan to hit 10x ROAS on $500/day");
    expect(result.summary).toContain("Let me pull the data now.\n\nHere are the results.");
  });
});
