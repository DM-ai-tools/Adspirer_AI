import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The extraction LLM is stubbed per test: each test says what it returns.
const llm = vi.hoisted(() => ({ reply: "" as string | Error, calls: 0 }));
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: vi.fn(async (args: { system?: string }) => {
      if (!String(args.system ?? "").includes("client settings")) throw new Error("unexpected LLM call");
      llm.calls += 1;
      if (llm.reply instanceof Error) throw llm.reply;
      return { text: llm.reply };
    }),
  };
});
vi.mock("@/lib/scraping/site-scan", () => ({ scanSiteCandidates: vi.fn() }));

import { gatherDiagnoseEvidence } from "@/lib/agent/adspirer-agent";
import { detectRequestIntent } from "@/lib/agent/task-plan";
import { extractChatSettings, mentionsSettings } from "@/lib/clients/chat-settings";
import { resetConfigCache } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { scanSiteCandidates } from "@/lib/scraping/site-scan";
import { resetSiteScanCache } from "@/lib/strategy/requested-category";
import { classify } from "@/lib/tools/policy";

const CT = "client_clicktrends";
const ADMIN = "profile_admin_demo";
const OPERATOR = "profile_operator_demo";
const SITE = "https://clicktrends.example";
const settings = (...items: unknown[]) => JSON.stringify({ settings: items });

const ctClient = () => getDemoStore().clients.find((c) => c.id === CT)!;
const ctServices = () => getDemoStore().clientServices.filter((s) => s.client_id === CT);

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test-key";
  resetConfigCache();
  llm.reply = settings();
  llm.calls = 0;
  // The seeded ClickTrends account is only "requested"; grant it.
  getDemoStore().connectedMetaAccounts.find((a) => a.client_id === CT)!.access_status = "granted";
});

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  resetConfigCache();
  resetSiteScanCache();
  vi.mocked(scanSiteCandidates).mockReset();
});

describe("mentionsSettings (cheap gate)", () => {
  it("lets only messages with setting words through", () => {
    expect(mentionsSettings("how did bar stools do last week")).toBe(false);
    expect(mentionsSettings("Plan to hit 10x on $500/day")).toBe(false);
    expect(mentionsSettings("our margin is 40%")).toBe(true);
    expect(mentionsSettings("set target ROAS to 8")).toBe(true);
    expect(mentionsSettings("business description: we sell furniture")).toBe(true);
    expect(mentionsSettings("allowed countries AU and NZ")).toBe(true);
  });
});

describe("extractChatSettings (LLM stubbed)", () => {
  const cases: Array<[string, unknown, unknown]> = [
    ["our target ROAS is 8×", { field: "target_roas", value: 8 }, { field: "target_roas", value: 8 }],
    ["set target ROAS to 8", { field: "target_roas", value: "8x" }, { field: "target_roas", value: 8 }],
    ["margin is 40%", { field: "gross_margin_pct", value: "40%" }, { field: "gross_margin_pct", value: 40 }],
    [
      "bar stools margin is 45%",
      { field: "category_margin", category: "bar stools", value: 45 },
      { field: "category_margin", category: "bar stools", value: 45 },
    ],
    ["average order value is $189", { field: "average_value", value: "$189" }, { field: "average_value", value: 189 }],
    ["target CPA $60", { field: "target_cpa", value: 60 }, { field: "target_cpa", value: 60 }],
    ["daily cap $1,200", { field: "daily_account_cap", value: "$1,200" }, { field: "daily_account_cap", value: 1200 }],
    ["monthly cap $30k", { field: "monthly_cap", value: "$30k" }, { field: "monthly_cap", value: 30000 }],
    ["we're ecommerce", { field: "business_model", value: "ecommerce" }, { field: "business_model", value: "ecommerce" }],
    ["industry is furniture", { field: "industry", value: "Furniture" }, { field: "industry", value: "Furniture" }],
    [
      "website is https://duringdays.example",
      { field: "website_url", value: "https://duringdays.example" },
      { field: "website_url", value: "https://duringdays.example" },
    ],
    [
      "always exclude NZ",
      { field: "standing_instruction", value: "Always exclude NZ" },
      { field: "standing_instruction", value: "Always exclude NZ" },
    ],
    [
      "never pause the brand campaign",
      { field: "standing_instruction", value: "Never pause the brand campaign" },
      { field: "standing_instruction", value: "Never pause the brand campaign" },
    ],
    [
      "business description: handmade oak furniture for small homes",
      { field: "business_description", value: "Handmade oak furniture for small homes" },
      { field: "business_description", value: "Handmade oak furniture for small homes" },
    ],
    [
      "allowed countries AU and NZ",
      { field: "allowed_countries", value: ["au", "NZ"] },
      { field: "allowed_countries", value: ["AU", "NZ"] },
    ],
  ];

  it.each(cases)("%s", async (message, reply, expected) => {
    llm.reply = settings(reply);
    expect(await extractChatSettings(message)).toEqual([expected]);
  });

  it("gives nothing for a hypothetical, even when the LLM returns it", async () => {
    llm.reply = settings({ field: "target_roas", value: 15 });
    expect(await extractChatSettings("what if we tried 15x ROAS")).toEqual([]);
    expect(await extractChatSettings("what if we tried 15x")).toEqual([]);
  });

  it("never reads a plan's budget as a cap", async () => {
    llm.reply = settings({ field: "daily_account_cap", value: 500 });
    expect(await extractChatSettings("Plan to hit 10x on $500/day")).toEqual([]);
    expect(llm.calls).toBe(0);
    expect(await extractChatSettings("Plan to hit 10x ROAS on $500/day")).toEqual([]);
  });

  it("never saves a stretch target or a question", async () => {
    llm.reply = settings({ field: "target_roas", value: 15 });
    expect(await extractChatSettings("stretch target ROAS 15x")).toEqual([]);
    expect(await extractChatSettings("what's our target ROAS?")).toEqual([]);
  });

  it("drops malformed items and keeps the good ones", async () => {
    llm.reply = settings({ field: "nope", value: 1 }, { field: "target_roas", value: "lots" }, { field: "gross_margin_pct", value: 40 });
    expect(await extractChatSettings("target ROAS and margin is 40%")).toEqual([{ field: "gross_margin_pct", value: 40 }]);
  });

  it("gives nothing without an OpenAI key, or when the call fails", async () => {
    llm.reply = new Error("boom");
    expect(await extractChatSettings("our margin is 40%")).toEqual([]);
    llm.reply = "not json";
    expect(await extractChatSettings("our margin is 40%")).toEqual([]);
    delete process.env.OPENAI_API_KEY;
    resetConfigCache();
    llm.reply = settings({ field: "gross_margin_pct", value: 40 });
    expect(await extractChatSettings("our margin is 40%")).toEqual([]);
    expect(llm.calls).toBe(2);
  });
});

describe("settings typed in the chat (DEMO_MODE)", () => {
  const WHOLE_ACCOUNT = "Plan to hit 10x ROAS on $500/day";

  it("saves a whole-account strategy target, overwriting the saved one", async () => {
    ctClient().goals_profile = { ...ctClient().goals_profile, target_roas: 6 };
    const gathered = await gatherDiagnoseEvidence({ clientId: CT, userId: ADMIN, request: WHOLE_ACCOUNT, intent: "strategy" });
    expect(ctClient().goals_profile.target_roas).toBe(10);
    expect(gathered.evidence).toContain("Saved to ClickTrends' settings: target ROAS 10× (was 6×).");
    const call = gathered.toolCalls.find((c) => c.name === "update_client_settings");
    expect(call?.args).toEqual({ changes: [{ field: "goals_profile.target_roas", before: 6, after: 10 }] });
    expect(call?.rationale).toBe("Saved to ClickTrends' settings: target ROAS 10× (was 6×).");
    expect(gathered.strategyPlanBuilt).toBe(true);
  });

  it("doesn't save the target of a category-scoped ask", async () => {
    const gathered = await gatherDiagnoseEvidence({
      clientId: CT,
      userId: ADMIN,
      request: "Plan to hit 10x ROAS on bar stools at $500/day",
      intent: "strategy",
    });
    expect(ctClient().goals_profile.target_roas).toBe(4);
    expect(gathered.toolCalls.map((c) => c.name)).not.toContain("update_client_settings");
    expect(gathered.evidence).not.toContain("Saved to");
  });

  it("never saves stretch targets or a hypothetical ask", async () => {
    await gatherDiagnoseEvidence({
      clientId: CT,
      userId: ADMIN,
      request: "Plan to hit 10x ROAS on $500/day, stretch 12x and 15x",
      intent: "strategy",
    });
    expect(ctClient().goals_profile.target_roas).toBe(10);
    ctClient().goals_profile = { ...ctClient().goals_profile, target_roas: 4 };
    const gathered = await gatherDiagnoseEvidence({
      clientId: CT,
      userId: ADMIN,
      request: "What if we tried 15x ROAS on $500/day?",
      intent: "strategy",
    });
    expect(ctClient().goals_profile.target_roas).toBe(4);
    expect(gathered.evidence).not.toContain("Saved to");
  });

  it("saves nothing for an operator and says the value was used for this answer only", async () => {
    const gathered = await gatherDiagnoseEvidence({ clientId: CT, userId: OPERATOR, request: WHOLE_ACCOUNT, intent: "strategy" });
    expect(ctClient().goals_profile.target_roas).toBe(4);
    expect(gathered.evidence).toContain(
      "Only an admin can save client settings; I used target ROAS 10× for this answer only.",
    );
    expect(gathered.toolCalls.map((c) => c.name)).not.toContain("update_client_settings");

    llm.reply = settings({ field: "gross_margin_pct", value: 40 });
    const general = await gatherDiagnoseEvidence({ clientId: CT, userId: OPERATOR, request: "our margin is 40%", intent: "general" });
    expect(ctClient().goals_profile.gross_margin_pct).toBe(45);
    expect(general.evidence).toContain("Only an admin can save client settings; I used margin 40% for this answer only.");
  });

  it("saves a stated setting for an admin, in the client's currency, with the previous value", async () => {
    llm.reply = settings({ field: "gross_margin_pct", value: 40 }, { field: "average_value", value: 189 });
    const request = "our margin is 40% and average order value is $189";
    const gathered = await gatherDiagnoseEvidence({ clientId: CT, userId: ADMIN, request, intent: detectRequestIntent(request) });
    expect(ctClient().goals_profile).toMatchObject({ gross_margin_pct: 40, average_value_cents: 18_900 });
    expect(gathered.evidence).toContain(
      "Saved to ClickTrends' settings: margin 40% (was 45%); average order value $189 (was not set).",
    );
    expect(gathered.toolCalls.find((c) => c.name === "update_client_settings")?.args).toEqual({
      changes: [
        { field: "goals_profile.gross_margin_pct", before: 45, after: 40 },
        { field: "goals_profile.average_value_cents", before: null, after: 18_900 },
      ],
    });
  });

  it("doesn't save an invalid value and says why", async () => {
    llm.reply = settings({ field: "gross_margin_pct", value: 140 });
    const gathered = await gatherDiagnoseEvidence({ clientId: CT, userId: ADMIN, request: "our margin is 140%", intent: "general" });
    expect(ctClient().goals_profile.gross_margin_pct).toBe(45);
    expect(gathered.evidence).toContain("Didn't save margin 140%: must be 0–100.");
    expect(gathered.toolCalls.map((c) => c.name)).not.toContain("update_client_settings");
  });

  it("says a category that isn't set up wasn't created", async () => {
    llm.reply = settings({ field: "category_margin", category: "dining chairs", value: 30 });
    const before = ctServices().length;
    const gathered = await gatherDiagnoseEvidence({
      clientId: CT,
      userId: ADMIN,
      request: "dining chairs margin is 30%",
      intent: "general",
    });
    expect(ctServices()).toHaveLength(before);
    expect(gathered.evidence).toContain(
      `Didn't save dining chairs margin 30%: no category called "dining chairs" is set up; add it on the Services tab.`,
    );
  });

  it("saves a loaded category's margin before the plan, so the plan uses it", async () => {
    llm.reply = settings({ field: "category_margin", category: "bar stools", value: 30 });
    const gathered = await gatherDiagnoseEvidence({
      clientId: CT,
      userId: ADMIN,
      request: "bar stools margin is 30%, plan 10x ROAS on bar stools at $500/day",
      intent: "strategy",
    });
    expect(ctServices().find((s) => s.name === "Bar stools")!.gross_margin_pct).toBe(30);
    expect(gathered.evidence).toContain("Saved to ClickTrends' settings: Bar stools margin 30% (was 40%).");
    // 10× at the account's 45% margin is 15× at 30%.
    expect(gathered.evidence).toMatch(/\| Bar stools \| [^|]+ \| 15× \(margin-adjusted\) \|/);
  });

  it("applies a margin to the category added from the same question", async () => {
    const store = getDemoStore();
    store.clientServices = store.clientServices.filter((s) => s.client_id !== CT);
    vi.mocked(scanSiteCandidates).mockResolvedValue({
      candidates: [{ name: "Bar Stools", landing_page_url: `${SITE}/collections/bar-stools`, alreadyAdded: false }],
      source: "firecrawl",
    });
    llm.reply = settings({ field: "category_margin", category: "bar stools", value: 45 });
    const gathered = await gatherDiagnoseEvidence({
      clientId: CT,
      userId: ADMIN,
      request: "bar stools margin is 45%, plan 10x ROAS on bar stools at $500/day",
      intent: "strategy",
    });
    expect(ctServices()).toHaveLength(1);
    expect(ctServices()[0]).toMatchObject({ name: "Bar Stools", gross_margin_pct: 45 });
    expect(gathered.evidence).toContain("Saved to ClickTrends' settings: Bar Stools margin 45% (was not set).");
    expect(gathered.evidence).not.toContain("no category called");
    expect(gathered.evidence).toMatch(/\| Bar Stools \| [^|]+ \| 10× \(margin-adjusted\) \|/);
    // The scoped target isn't saved as the account's.
    expect(ctClient().goals_profile.target_roas).toBe(4);
  });

  it("never runs on a chat turn without setting words", async () => {
    await gatherDiagnoseEvidence({ clientId: CT, userId: ADMIN, request: "how did bar stools do last week", intent: "general" });
    expect(llm.calls).toBe(0);
  });
});

describe("tool policy", () => {
  it("classifies update_client_settings as diagnose", () => {
    expect(classify("update_client_settings")).toBe("diagnose");
  });
});
