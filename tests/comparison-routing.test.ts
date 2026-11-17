import { describe, expect, it } from "vitest";
import { detectRequestIntent, detectRequestIntentWithHistory, planTaskSteps, REPORT_INTENTS } from "@/lib/agent/task-plan";
import { INTENT_GUIDE, SYSTEM } from "@/lib/agent/intent-classifier";
import { maxOutputTokensFor } from "@/lib/agent/adspirer-agent";
import { writerHasTools } from "@/lib/agent/diagnose-tools-ai";
import { isRequestIntent } from "@/lib/agent/request-brief";

describe("comparison routing (keyword fallback)", () => {
  it.each([
    "compare last 14 days with the 14 days before",
    "month over month report for October vs September",
    "week over week comparison for my account",
  ])("%s -> comparison", (text) => {
    expect(detectRequestIntent(text)).toBe("comparison");
  });

  it("an audit that also asks to compare stays an audit", () => {
    expect(detectRequestIntent("audit the account for last 30 days and compare with the previous period")).toBe("audit");
  });

  it("a single metric vs question is not a comparison report", () => {
    expect(detectRequestIntent("what was CPL last week vs the week before?")).not.toBe("comparison");
  });

  it.each([
    "how does CPL compare to last month?",
    "show me roas this week vs last week",
    "cpl vs last month",
    "compare our landing pages with competitors",
    "compare campaign A vs B",
  ])("%s -> not comparison", (text) => {
    expect(detectRequestIntent(text)).not.toBe("comparison");
  });

  it("a whole-account compare naming metrics is still a comparison", () => {
    expect(detectRequestIntent("compare account performance last 14 days with the 14 days before")).toBe("comparison");
  });

  it("a strategy ask is still strategy", () => {
    expect(detectRequestIntent("give me a strategy to hit 4x roas")).toBe("strategy");
  });
});

describe("comparison intent plumbing", () => {
  it("is a known request intent", () => {
    expect(isRequestIntent("comparison")).toBe(true);
  });

  it("has its own step list", () => {
    const steps = planTaskSteps("compare last 14 days with the 14 days before", "comparison");
    const tail = steps.filter((s) => ["fetch_overview", "pull_insights", "build_plan", "write_report", "complete"].includes(s.id));
    expect(tail.map((s) => [s.id, s.label])).toEqual([
      ["fetch_overview", "Load both periods"],
      ["pull_insights", "Compare performance"],
      ["build_plan", "Work out what drove the change"],
      ["write_report", "Write comparison"],
      ["complete", "Complete"],
    ]);
  });

  it("the classifier guide describes the comparison intent and its edges", () => {
    expect(SYSTEM).toContain("- comparison:");
    expect(INTENT_GUIDE.comparison).toMatch(/comparison of (?:the )?periods/i);
    expect(INTENT_GUIDE.comparison).toMatch(/single metric/i);
    expect(INTENT_GUIDE.audit).toMatch(/compare/i);
    expect(INTENT_GUIDE.audit).toMatch(/stays? (?:an )?audit/i);
    expect(INTENT_GUIDE.custom).toMatch(/single metric/i);
  });
});

describe("comparison with chat history", () => {
  it("a reply to the audit brief question that asks to compare stays an audit", () => {
    const history = [
      { role: "user" as const, content: "audit my account" },
      {
        role: "assistant" as const,
        content: "Before I run the full audit, what date range should I cover?",
      },
    ];
    expect(detectRequestIntentWithHistory("last 30 days, and compare with the previous period", history)).toBe("audit");
  });

  it("a plain comparison ask in a chat with no open audit brief stays a comparison", () => {
    expect(
      detectRequestIntentWithHistory("compare last 14 days with the 14 days before", [
        { role: "user" as const, content: "hi" },
        { role: "assistant" as const, content: "Hello, how can I help?" },
      ]),
    ).toBe("comparison");
  });
});

describe("comparison is a report intent", () => {
  it("gets the report output budget", () => {
    expect(REPORT_INTENTS.has("comparison")).toBe(true);
    expect(maxOutputTokensFor("comparison")).toBe(maxOutputTokensFor("audit"));
    expect(maxOutputTokensFor("comparison")).toBeGreaterThanOrEqual(16_000);
  });

  it("its writer does not get the read tools (all figures are in the evidence)", () => {
    expect(writerHasTools("comparison")).toBe(false);
  });
});
