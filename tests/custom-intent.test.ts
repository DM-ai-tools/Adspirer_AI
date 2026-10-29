import { describe, expect, it } from "vitest";
import { planTaskSteps } from "@/lib/agent/task-plan";
import { isRequestIntent } from "@/lib/agent/request-brief";
import { writerHasTools } from "@/lib/agent/diagnose-tools-ai";
import { parseIntentReply } from "@/lib/agent/intent-classifier";

describe("custom intent", () => {
  it("is a recognised intent the classifier may return", () => {
    expect(isRequestIntent("custom")).toBe(true);
    expect(parseIntentReply('{"intent":"custom"}')).toBe("custom");
  });

  it("gets the read tools so the model fetches its own data", () => {
    expect(writerHasTools("custom")).toBe(true);
  });

  it("plans a data pull and an answer, not the audit steps", () => {
    const ids = planTaskSteps("weekly excel of spend and leads", "custom").map((s) => s.id);
    expect(ids).toContain("pull_insights");
    expect(ids).toContain("write_report");
    expect(ids).not.toContain("apply_framework");
    expect(ids).not.toContain("clarify_brief");
  });
});
