import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ACCOUNT_STRATEGY_FRAMEWORK, STRATEGY_TARGET_PROPOSAL_FRAMEWORK } from "@/lib/agent/account-strategy-framework";
import { LEAD_STRATEGY_FRAMEWORK, STRATEGY_FRAMEWORK } from "@/lib/agent/strategy-framework";
import { gatherDiagnoseEvidence, runAdspirerAgent } from "@/lib/agent/adspirer-agent";
import { createTask } from "@/lib/agent/task-runner";
import { resetDemoStore } from "@/lib/demo/store";

const HEADINGS = [
  "## 1. Strategy header",
  "## 2. Situation summary",
  "## 3. Diagnosis",
  "## 4. Targets and guardrails",
  "## 5. Strategic pillars",
  "## 6. Action plan",
  "## 7. Budget plan",
  "## 8. Creative plan",
  "## 9. Testing roadmap",
  "## 10. Measurement and review cadence",
  "## 11. Risks and dependencies",
  "## 12. Client checklist",
];

// SHA-256 of STRATEGY_FRAMEWORK taken before the 12-section change (5,155 characters): the category strategy stays as it was.
const CATEGORY_FRAMEWORK_SHA256 = "f1e9d5fffffa10a46be1412e91719a4f17fbec5cab7875cebec8e6e17a802e55";

describe.each([
  ["ACCOUNT_STRATEGY_FRAMEWORK", ACCOUNT_STRATEGY_FRAMEWORK],
  ["LEAD_STRATEGY_FRAMEWORK", LEAD_STRATEGY_FRAMEWORK],
])("%s", (_name, text) => {
  it("has the 12 headings in order", () => {
    const at = HEADINGS.map((h) => text.indexOf(h));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("numbers actions STR-, types them, and opens section 6 with the short table", () => {
    expect(text).toContain("STR-");
    expect(text).toContain("### STR-001.");
    expect(text).toContain("Type A");
    expect(text).toContain("ID | Action | Owner | Type | Timing | Effort");
    expect(text).toContain("Can be queued to Approvals by asking to optimise.");
  });

  it("says when impact can't be sized and asks for missing details", () => {
    expect(text).toContain("Impact uncertain");
    expect(text).toContain("Questions for the client");
    expect(text).toMatch(/never save/i);
  });

  it("carries the shared rules and reads the strategy inputs", () => {
    expect(text).toContain("SHARED RULES");
    expect(text).toContain("Strategy inputs");
    expect(text).toContain("App capabilities");
    expect(text).toContain("Never show the reader tool names, API fields or setting keys");
  });
});

describe("ACCOUNT_STRATEGY_FRAMEWORK voice", () => {
  it("never invites a closing offer to queue, and allows only STR and finding IDs in headings", () => {
    expect(ACCOUNT_STRATEGY_FRAMEWORK).not.toMatch(/offering to queue/i);
    expect(ACCOUNT_STRATEGY_FRAMEWORK).toContain("nothing in Meta is changed and nothing is queued");
    expect(ACCOUNT_STRATEGY_FRAMEWORK).toContain("The only ids allowed there are STR-### and the finding IDs (AUD-###, CMP-###, SF-###)");
    expect(STRATEGY_TARGET_PROPOSAL_FRAMEWORK).not.toMatch(/offering to queue/i);
  });
});

describe("LEAD_STRATEGY_FRAMEWORK", () => {
  it("still forbids ROAS and keeps the lead rules", () => {
    expect(LEAD_STRATEGY_FRAMEWORK).toMatch(/never mention ROAS, revenue or return on ad spend/);
    expect(LEAD_STRATEGY_FRAMEWORK).toContain('"service"');
    expect(LEAD_STRATEGY_FRAMEWORK).toContain("campaign allocation table");
    expect(LEAD_STRATEGY_FRAMEWORK).toMatch(/cost per qualified lead[^\n]*CRM/);
  });
});

describe("ACCOUNT_STRATEGY_FRAMEWORK", () => {
  it("keeps the budget steps and the order of moves", () => {
    expect(ACCOUNT_STRATEGY_FRAMEWORK).toContain("20–30% every 3–4 days");
    expect(ACCOUNT_STRATEGY_FRAMEWORK).toMatch(/tracking problems first/);
    expect(ACCOUNT_STRATEGY_FRAMEWORK).toMatch(/never mention ROAS/);
  });
});

describe("asking as little as possible", () => {
  it.each([
    ["account", ACCOUNT_STRATEGY_FRAMEWORK],
    ["lead", LEAD_STRATEGY_FRAMEWORK],
  ])("the %s strategy states data and defaults as assumptions and asks only the listed questions", (_k, text) => {
    expect(text).toContain("Profile from the account's data");
    expect(text).toContain("Profile assumed by default");
    expect(text).toMatch(/never add (?:a question of your own|others)/);
    expect(text).not.toContain("Profile missing");
  });
});

describe("STRATEGY_TARGET_PROPOSAL_FRAMEWORK", () => {
  it("asks for missing profile items as Questions for the client", () => {
    expect(STRATEGY_TARGET_PROPOSAL_FRAMEWORK).toContain("Questions for the client");
    expect(STRATEGY_TARGET_PROPOSAL_FRAMEWORK).toContain("# Strategy target proposal");
  });
});

describe("STRATEGY_FRAMEWORK (category strategy)", () => {
  it("is unchanged", () => {
    expect(createHash("sha256").update(STRATEGY_FRAMEWORK).digest("hex")).toBe(CATEGORY_FRAMEWORK_SHA256);
  });
});

describe("strategy inputs in the DEMO evidence", () => {
  afterEach(() => resetDemoStore());

  it("account strategy with a target gets the inputs block before the 12-section framework", async () => {
    const gathered = await gatherDiagnoseEvidence({
      clientId: "client_trafficradius",
      request: "strategy to hit $40 per lead in 45 days",
      intent: "strategy",
    });
    expect(gathered.toolCalls.find((c) => c.name === "strategy_plan")?.args).toMatchObject({ stage: "plan" });
    const inputsAt = gathered.evidence.indexOf("### Strategy inputs (findings");
    expect(inputsAt).toBeGreaterThanOrEqual(0);
    expect(inputsAt).toBeLessThan(gathered.evidence.indexOf("## 1. Strategy header"));
  });

  it("account target proposal gets the inputs block too", async () => {
    const gathered = await gatherDiagnoseEvidence({ clientId: "client_trafficradius", request: "Build me a strategy", intent: "strategy" });
    expect(gathered.toolCalls.find((c) => c.name === "strategy_plan")?.args).toMatchObject({ stage: "target_proposal" });
    expect(gathered.evidence).toContain("### Strategy inputs (findings");
  });

  it("the DEMO reply leaves out the strategy inputs block", async () => {
    const ask = "strategy to hit $40 per lead in 45 days";
    const task = await createTask({ clientId: "client_trafficradius", createdBy: "profile_operator_demo", title: ask, goal: ask });
    const gathered = await gatherDiagnoseEvidence({ clientId: "client_trafficradius", request: ask, intent: "strategy" });
    expect(gathered.evidence).toContain("### Strategy inputs (findings");
    const result = await runAdspirerAgent({ task, clientContext: "", toolEvidence: gathered.evidence, intent: "strategy" });
    expect(result.summary).toContain("## Strategy (demo)");
    expect(result.summary).not.toContain("### Strategy inputs (findings");
    expect(result.summary).not.toContain("App capabilities");
  });

  it("lead strategy gets the inputs block before the framework", async () => {
    const gathered = await gatherDiagnoseEvidence({
      clientId: "client_modern_dental",
      request: "to get 100 leads in a month tell me what is the budget i need to put and the ad strategy",
      intent: "strategy",
    });
    expect(gathered.toolCalls.find((c) => c.name === "strategy_plan")?.args).toMatchObject({ goal: "leads", target_leads: 100 });
    const inputsAt = gathered.evidence.indexOf("### Strategy inputs (findings");
    expect(inputsAt).toBeGreaterThanOrEqual(0);
    expect(inputsAt).toBeLessThan(gathered.evidence.indexOf("# Lead strategy report method"));
  });
});
