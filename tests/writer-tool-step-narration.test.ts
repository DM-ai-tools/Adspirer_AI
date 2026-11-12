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

describe("a report that hits the output limit", () => {
  it("asks for the rest and joins it on instead of stopping mid-sentence", async () => {
    let call = 0;
    streamText.mockImplementation(() => {
      call += 1;
      const first = call === 1;
      return {
        fullStream: (async function* () {
          yield { type: "start-step" };
          yield { type: "text-delta", text: first ? "# Strategy\n\n- **Evidence:** a 7-day frequency of 20" : ".19 on 2,520 people.\n\n## Next Steps\n\nDone." };
          yield { type: "finish-step", finishReason: first ? "length" : "stop" };
        })(),
      };
    });
    const result = await write("Plan to hit 10x ROAS on $500/day");
    expect(call).toBe(2);
    expect(result.summary).toContain("frequency of 20.19 on 2,520 people.");
    expect(result.summary).toContain("## Next Steps");
    const continuation = streamText.mock.calls[1]![0] as { messages: Array<{ role: string; content: string }> };
    expect(continuation.messages.at(-2)).toMatchObject({ role: "assistant" });
    expect(continuation.messages.at(-1)!.content).toMatch(/Continue from exactly where it stopped/);
  });

  it("gives reports room for a year-long audit", async () => {
    streamText.mockImplementation(() => ({
      fullStream: (async function* () {
        yield { type: "start-step" };
        yield { type: "text-delta", text: "ok" };
        yield { type: "finish-step", finishReason: "stop" };
      })(),
    }));
    await write("Plan to hit 10x ROAS on $500/day");
    expect((streamText.mock.calls.at(-1)![0] as { maxOutputTokens: number }).maxOutputTokens).toBeGreaterThanOrEqual(16_000);
  });
});
