import { describe, expect, it } from "vitest";
import { detectRequestIntentWithHistory } from "@/lib/agent/task-plan";

const history = [
  { role: "user" as const, content: "Create an image campaign TR_Leads_Broad_AU_202610 for leads" },
  {
    role: "assistant" as const,
    content:
      "I need a public image URL. Once you share it I'll queue the full campaign create for Approvals with your budget and targeting.",
  },
];

describe("intent while a campaign is being built", () => {
  it("keeps 'send it to Approvals' on the campaign build, not optimize", () => {
    expect(
      detectRequestIntentWithHistory("here is the link, queue it to Approvals", history),
    ).toBe("create_campaign");
  });

  it("does not turn a plain reply into optimize because the assistant mentioned budget/Approvals", () => {
    expect(
      detectRequestIntentWithHistory("https://cdn.example.com/ad.jpg send it", history),
    ).not.toBe("optimize");
  });

  it("still optimizes when the operator asks for it explicitly", () => {
    expect(
      detectRequestIntentWithHistory("optimize the carousel ad", history),
    ).toBe("optimize");
  });

  it("queues optimize proposals when no campaign is being built", () => {
    expect(
      detectRequestIntentWithHistory("queue these to approvals", [
        { role: "user", content: "optimize my campaign" },
        { role: "assistant", content: "Recommendations: SCALE ad set X. Approvals needed." },
      ]),
    ).toBe("optimize");
  });
});
