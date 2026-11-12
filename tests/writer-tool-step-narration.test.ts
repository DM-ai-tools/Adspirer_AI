import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "@/lib/config";
import { gatherDiagnoseEvidence, runAdspirerAgent } from "@/lib/agent/adspirer-agent";
import { createTask } from "@/lib/agent/task-runner";

const streamText = vi.fn();
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  streamText: (...args: unknown[]) => streamText(...args),
}));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: () => () => ({ provider: "stub" }) }));

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  resetConfigCache();
});
afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  resetConfigCache();
});

async function write(request: string) {
  const task = await createTask({ clientId: "client_modern_dental", createdBy: "profile_operator_demo", title: request, goal: request });
  const gathered = await gatherDiagnoseEvidence({ clientId: "client_modern_dental", request, intent: "strategy", history: [] });
  return runAdspirerAgent({ task, clientContext: "", toolEvidence: gathered.evidence, intent: "strategy", history: [] });
}

describe("a report keeps only the step that writes it", () => {
  it("drops what the model says before a tool call", async () => {
    streamText.mockImplementation(() => ({
      fullStream: (async function* () {
        yield { type: "start-step" };
        yield { type: "text-delta", text: "I need to pull the full 12-month spend data first. Let me fetch that now." };
        yield { type: "tool-call", toolName: "meta_insights" };
        yield { type: "finish-step", finishReason: "tool-calls" };
        yield { type: "start-step" };
        yield { type: "text-delta", text: "Now let me pull the remaining campaigns." };
        yield { type: "tool-call", toolName: "meta_account_health" };
        yield { type: "finish-step", finishReason: "tool-calls" };
        yield { type: "start-step" };
        yield { type: "text-delta", text: "# Strategy — Modern Dental\n\nThe plan." };
        yield { type: "finish-step", finishReason: "stop" };
      })(),
    }));
    const result = await write("Plan to hit 10x ROAS on $500/day");
    expect(result.summary).toContain("# Strategy — Modern Dental");
    expect(result.summary).not.toMatch(/12-month|fetch that now|remaining campaigns/);
  });

  it("keeps the text of a step that makes no tool call", async () => {
    streamText.mockImplementation(() => ({
      fullStream: (async function* () {
        yield { type: "start-step" };
        yield { type: "text-delta", text: "The whole report." };
        yield { type: "finish-step", finishReason: "stop" };
      })(),
    }));
    const result = await write("Plan to hit 10x ROAS on $500/day");
    expect(result.summary).toContain("The whole report.");
  });
});
