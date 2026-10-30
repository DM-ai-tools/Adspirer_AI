import { describe, expect, it } from "vitest";
import { buildWriterMessages } from "@/lib/agent/adspirer-agent";
import type { RequestIntent } from "@/lib/agent/task-plan";
import type { Task } from "@/types";

const turn = (intent: RequestIntent, toolEvidence?: string, goal = "why is cpa up on retargeting") => {
  const task = { goal, title: goal } as Task;
  const { messages } = buildWriterMessages({ task, clientContext: "", intent, toolEvidence, history: [] });
  return messages.at(-1)!.content;
};

describe("conversation turns share one adaptive brief", () => {
  it.each<RequestIntent>(["chat", "general", "budget", "list_campaigns", "custom", "followup", "out_of_scope"])(
    "%s gets the conversational brief with read tools and diagnosis",
    (intent) => {
      const text = turn(intent);
      expect(text).toMatch(/senior Meta media buyer/);
      expect(text).toMatch(/meta_account_health/);
      expect(text).toMatch(/Diagnosing performance/);
      expect(text).toMatch(/no tool JSON/);
      expect(text).not.toMatch(/Keep it short — a few sentences/);
    },
  );

  it("treats preflight evidence as a head start, and omits the section when nothing was fetched", () => {
    expect(turn("general", "### Account overview\n- Name: Acme")).toMatch(/head start[\s\S]*### Account overview/);
    expect(turn("chat")).not.toMatch(/Live evidence fetched up front/);
  });

  it("keeps each turn's own job", () => {
    expect(turn("followup")).toMatch(/from the audit above/);
    expect(turn("custom")).toMatch(/time_increment 7/);
    expect(turn("out_of_scope")).toMatch(/two or three specific example questions/);
  });

  it("leaves the workflow turns on their own templates", () => {
    const audit = turn("audit", "### Audit checklist\n- …", "audit the account last 30 days");
    expect(audit).toMatch(/Write the report NOW/);
    expect(audit).not.toMatch(/senior Meta media buyer/);
  });
});
