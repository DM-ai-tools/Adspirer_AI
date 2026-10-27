import { describe, expect, it } from "vitest";
import {
  detectRequestIntent,
  detectRequestIntentWithHistory,
} from "@/lib/agent/task-plan";

const history = [
  { role: "user" as const, content: "audit the TR Lead campaign for 27 Oct 2026" },
  {
    role: "assistant" as const,
    content: `Meta Ads Account Audit — TR Internal Marketing\n${"F2 Frequency within healthy range Pass. ".repeat(40)}`,
  },
];

describe("follow-ups on a delivered audit", () => {
  it("does not re-run the audit for 'based on the audit give me the optimization steps'", () => {
    const ask = "okay absed on the audit give me the optimization steps";
    expect(detectRequestIntent(ask)).not.toBe("audit");
    expect(detectRequestIntentWithHistory(ask, history)).toBe("followup");
  });

  it("treats a bare 'optimization steps' ask after a report as a follow-up", () => {
    expect(detectRequestIntentWithHistory("give me the optimization steps", history)).toBe(
      "followup",
    );
  });

  it("still runs an audit when asked to", () => {
    expect(detectRequestIntentWithHistory("audit this account", history)).toBe("audit");
    expect(
      detectRequestIntentWithHistory("run another audit based on the last one", history),
    ).toBe("audit");
  });

  it("keeps explicit queue asks on the optimize path", () => {
    expect(
      detectRequestIntentWithHistory("queue these optimizations to Approvals", history),
    ).toBe("optimize");
  });

  it("needs a delivered report in the chat", () => {
    expect(detectRequestIntentWithHistory("give me the optimization steps", [])).not.toBe(
      "followup",
    );
  });
});

describe("capability follow-ups after an audit", () => {
  it("does not re-run or re-append the audit for 'which of these can you do'", () => {
    for (const ask of [
      "okay among these recommendations, which ones are possible by you to do",
      "which of these can you do?",
    ]) {
      expect(detectRequestIntentWithHistory(ask, history)).toBe("followup");
    }
  });

  it("stays a follow-up when the previous reply was a short follow-up that mentions the audit", () => {
    const h = [
      ...history,
      { role: "user" as const, content: "based on the audit give me the optimization steps" },
      { role: "assistant" as const, content: "From the audit above: 1. Fix tracking. 2. Refresh creatives." },
    ];
    expect(
      detectRequestIntentWithHistory("which ones are possible by you to do", h),
    ).toBe("followup");
  });
});
