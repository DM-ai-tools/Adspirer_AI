import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { gatherDiagnoseEvidence, runAdspirerAgent } from "@/lib/agent/adspirer-agent";
import { createTask } from "@/lib/agent/task-runner";

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
    textStream: (async function* () {
      yield "Written by the model.";
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
});
