import { beforeEach, describe, expect, it, vi } from "vitest";

const generateText = vi.fn();
vi.mock("ai", () => ({ generateText: (...a: unknown[]) => generateText(...a) }));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI: () => () => "model" }));
vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    hasOpenAI: true,
    OPENAI_API_KEY: "k",
    OPENAI_MODEL: "m",
    hasAnthropic: false,
  }),
}));

import {
  buildClassifierPrompt,
  classifyIntent,
  parseIntentReply,
} from "@/lib/agent/intent-classifier";

const history = [
  { role: "user" as const, content: "audit the TR campaign" },
  { role: "assistant" as const, content: "Meta Ads Account Audit ".repeat(100) },
];

describe("intent classifier", () => {
  beforeEach(() => generateText.mockReset());

  it("uses the model's reading of the message, whatever the wording", async () => {
    generateText.mockResolvedValue({ text: '{"intent":"followup"}' });
    await expect(
      classifyIntent("so which of those fixes can u actually handle", history),
    ).resolves.toBe("followup");
    const call = generateText.mock.calls[0][0];
    expect(call.prompt).toContain("so which of those fixes can u actually handle");
    expect(call.prompt).toContain("Meta Ads Account Audit");
  });

  it("falls back to keyword rules when the model errors or returns junk", async () => {
    generateText.mockRejectedValueOnce(new Error("boom"));
    await expect(classifyIntent("audit this account", [])).resolves.toBe("audit");
    generateText.mockResolvedValueOnce({ text: "I think it's an audit" });
    await expect(classifyIntent("list campaigns", [])).resolves.toBe("list_campaigns");
  });

  it("parses only known intents", () => {
    expect(parseIntentReply('```json\n{"intent":"audit"}\n```')).toBe("audit");
    expect(parseIntentReply('{"intent":"nonsense"}')).toBeNull();
  });

  it("trims long earlier replies in the prompt", () => {
    expect(buildClassifierPrompt("hi", history).length).toBeLessThan(1500);
  });
});
