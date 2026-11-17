import { describe, expect, it } from "vitest";
import { demoMetaAuditSnapshot, type AuditAd, type MetaAuditSnapshot, type PeriodPerformance } from "@/lib/audit/meta-audit-data";
import { resolveGoals } from "@/lib/clients/goals";
import { resolveProfile } from "@/lib/strategy/profile-resolution";

const money = (c: number) => `$${(c / 100).toFixed(2)}`;
const base = demoMetaAuditSnapshot("act_1", "Bethel Shopfitting World", 30);

function perf(over: Partial<PeriodPerformance> = {}): PeriodPerformance {
  return {
    spendCents: 134_900,
    impressions: 87_457,
    reach: 22_493,
    frequency: 3.89,
    linkCtr: 1.02,
    cpmCents: 1_542,
    results: 24,
    resultLabel: "Purchases",
    costPerResultCents: 5_619,
    roas: 16.09,
    purchases: 24,
    purchaseValueCents: 2_169_500,
    ...over,
  };
}

function ad(id: string, name: string, format: string, status: string, spendCents: number, copy: string | null = null): AuditAd {
  return {
    id,
    name,
    adSetId: "as_1",
    campaignId: "c_1",
    status,
    createdTime: null,
    format,
    issue: null,
    performance: spendCents ? perf({ spendCents }) : null,
    copy,
  };
}

/** A Bethel-like sales account: three live image ads, two paused videos, AU only, $45/day. */
function bethel(over: Partial<MetaAuditSnapshot> = {}): MetaAuditSnapshot {
  return {
    ...base,
    period: { days: 30, since: "2026-10-18", until: "2026-11-16" },
    totals: perf(),
    campaigns: [{ ...base.campaigns[0], id: "c_1", name: "TR | New Categories Sales - Aug 2026", objective: "OUTCOME_SALES", status: "ACTIVE" }],
    adSets: [
      { ...base.adSets[0], id: "as_1", name: "Basket and Retail Display", campaignId: "c_1", status: "ACTIVE", countries: ["AU"], performance: perf({ spendCents: 87_071 }) },
      { ...base.adSets[0], id: "as_2", name: "Shopping Basket and Trolley", campaignId: "c_1", status: "PAUSED", countries: ["AU"], performance: perf({ spendCents: 34_185 }) },
      { ...base.adSets[0], id: "as_3", name: "Data Strips and Display Hooks", campaignId: "c_1", status: "ACTIVE", countries: ["AU"], performance: perf({ spendCents: 13_600 }) },
    ],
    ads: [
      ad("a1", "Basket Display Rack Image - Aug 2026", "IMAGE", "ACTIVE", 87_071, "Heavy-duty basket display racks for retail stores. Free shipping Australia-wide."),
      ad("a2", "Data Strips and Display Hooks - August 2026", "IMAGE", "ACTIVE", 13_600),
      ad("a3", "Shopping Baskets and Trolleys - August 2026", "IMAGE", "ACTIVE", 34_185),
      ad("v1", "Video Ad - July 2026", "VIDEO", "PAUSED", 0),
      ad("v2", "Video Ad - August 2026", "VIDEO", "PAUSED", 0),
    ],
    ...over,
  };
}

const noGoals = resolveGoals({ goals_profile: { business_model: "ecommerce" } });

describe("resolveProfile — fill from data, default the rest, ask only what changes the plan", () => {
  it("asks a Bethel-like sales account only for its margin", () => {
    const p = resolveProfile({ snapshot: bethel(), goals: noGoals, request: "give me a strategy", history: [], money });
    expect(p.ask.map((q) => q.item)).toEqual(["margin"]);
    expect(p.ask[0].question).toMatch(/gross margin/i);
    expect(p.ask[0].why).toContain("$903.96"); // average order value from the account: 21,695 ÷ 24
  });

  it("reads what they sell, the offer, creative and geography from the account", () => {
    const p = resolveProfile({ snapshot: bethel(), goals: noGoals, request: "strategy", history: [], money });
    const by = Object.fromEntries(p.fromData.map((x) => [x.item, x]));
    expect(by["what they sell"].value).toContain("Basket and Retail Display");
    expect(by["what they sell"].source).toMatch(/ad set names/);
    expect(by.offer.value).toContain("Free shipping Australia-wide");
    expect(by.offer.source).toContain("Basket Display Rack Image - Aug 2026");
    expect(by["creative assets"].value).toBe("3 live ads (3 image); 2 paused video ads available");
    expect(by.constraints.value).toBe("delivery limited to AU");
    expect(by.goal.value).toContain("ROAS 16.09×");
    expect(by.goal.value).toContain("$56.19");
    expect(by.budget.value).toContain("$44.97 per day");
  });

  it("keeps the product part of ad set names and drops audience labels", () => {
    const snap = bethel({
      adSets: [
        { ...base.adSets[0], id: "x1", name: "Veneers – Advantage+ audience", campaignId: "c_1", status: "ACTIVE", countries: ["AU"], performance: perf({ spendCents: 50_000 }) },
        { ...base.adSets[0], id: "x2", name: "Implants – Broad AU 30-65", campaignId: "c_1", status: "ACTIVE", countries: ["AU"], performance: perf({ spendCents: 40_000 }) },
        { ...base.adSets[0], id: "x3", name: "Retargeting – Website visitors 30d", campaignId: "c_1", status: "ACTIVE", countries: ["AU"], performance: perf({ spendCents: 30_000 }) },
        { ...base.adSets[0], id: "x4", name: "Implants – Interests: dental", campaignId: "c_1", status: "ACTIVE", countries: ["AU"], performance: perf({ spendCents: 20_000 }) },
      ],
    });
    const sell = resolveProfile({ snapshot: snap, goals: noGoals, request: "strategy", history: [], money }).fromData.find((x) => x.item === "what they sell")!;
    expect(sell.value).toBe("Veneers, Implants");

    // Product names with short words or "custom" survive.
    const kept = bethel({
      adSets: [
        { ...base.adSets[0], id: "y1", name: "TV Stands", campaignId: "c_1", status: "ACTIVE", countries: ["AU"], performance: perf({ spendCents: 50_000 }) },
        { ...base.adSets[0], id: "y2", name: "Custom Shelving – Broad", campaignId: "c_1", status: "ACTIVE", countries: ["AU"], performance: perf({ spendCents: 40_000 }) },
      ],
    });
    expect(resolveProfile({ snapshot: kept, goals: noGoals, request: "strategy", history: [], money }).fromData.find((x) => x.item === "what they sell")!.value).toBe(
      "TV Stands, Custom Shelving",
    );
  });

  it("prefers the client's saved services for what they sell", () => {
    const p = resolveProfile({ snapshot: bethel(), goals: noGoals, request: "strategy", history: [], money, services: ["Retail basket displays", "Shop trolleys"] });
    const sell = p.fromData.find((x) => x.item === "what they sell")!;
    expect(sell.value).toBe("Retail basket displays, Shop trolleys");
    expect(sell.source).toBe("the client's saved services");
  });

  it("defaults risk, timeframe and owners instead of asking", () => {
    const p = resolveProfile({ snapshot: bethel(), goals: noGoals, request: "strategy", history: [], money });
    const items = p.assumed.map((x) => x.item);
    expect(items).toEqual(expect.arrayContaining(["risk appetite", "timeframe", "owners"]));
    expect(p.assumed.find((x) => x.item === "risk appetite")!.value).toContain("±20%");
    for (const q of p.ask) expect(["risk appetite", "timeframe", "owners", "industry", "offer"]).not.toContain(q.item);
  });

  it("does not ask for what the operator already said in chat, and lists it as stated", () => {
    const p = resolveProfile({ snapshot: bethel(), goals: noGoals, request: "strategy, our margin is about 35%", history: [], money });
    expect(p.ask).toEqual([]);
    expect(p.stated).toContain("margin");
  });

  it.each([
    "ROAS fell by a small margin last week, build a strategy",
    "why is my ROAS low? give me a strategy",
    "we are a bit worried, strategy please",
    "I can't see why CPA rose, strategy please",
    "why are my video ads failing? strategy",
    "make the margin of error small in the strategy",
  ])("a passing mention is not an answer: %s", (request) => {
    const p = resolveProfile({ snapshot: bethel(), goals: noGoals, request, history: [], money });
    expect(p.ask.map((q) => q.item)).toEqual(["margin"]);
    expect(p.stated).toEqual([]);
    // The data-filled answers stay.
    for (const item of ["what they sell", "constraints", "creative assets", "goal"]) {
      expect(p.fromData.map((x) => x.item)).toContain(item);
    }
  });

  it.each([
    ["our gross margin is 35%", "margin"],
    ["we run at a 40% margin", "margin"],
    ["aim for 5x ROAS", "goal"],
    ["get CPA down to $45", "goal"],
    ["we only ship to Australia", "constraints"],
    ["we sell commercial shopfittings", "what they sell"],
    ["margin is around 30 percent", "margin"],
    ["target ROAS 4", "goal"],
    ["4x roas", "goal"],
    ["CPL under $50", "goal"],
    ["in the next 60 days", "timeframe"],
    ["budget is $50 a day", "budget"],
    ["we're happy to be aggressive", "risk appetite"],
    ["we have new videos ready", "creative assets"],
    ["we're an ecommerce store selling shop fittings", "what they sell"],
  ])("a real answer counts as stated: %s", (request, item) => {
    expect(resolveProfile({ snapshot: bethel(), goals: noGoals, request, history: [], money }).stated).toContain(item);
  });

  it("asks a lead account about lead quality even when they mention a CRM, until they give a figure", () => {
    const leads = bethel({
      totals: perf({ purchases: null, purchaseValueCents: null, roas: null, leads: 40, results: 40, resultLabel: "Leads", costPerResultCents: 3_372 }),
      campaigns: [{ ...base.campaigns[0], id: "c_1", name: "Leads", objective: "OUTCOME_LEADS", status: "ACTIVE" }],
    });
    const g = resolveGoals({ goals_profile: { business_model: "lead_gen" } });
    expect(resolveProfile({ snapshot: leads, goals: g, request: "we use a CRM, give me a strategy", history: [], money }).ask.map((q) => q.item)).toEqual(["lead quality"]);
    expect(resolveProfile({ snapshot: leads, goals: g, request: "about 30% of leads become sales", history: [], money }).ask).toEqual([]);
  });

  it("keeps hyphenated product names whole", () => {
    const snap = bethel({
      adSets: [
        { ...base.adSets[0], id: "h1", name: "Anti-Theft Hooks - Broad", campaignId: "c_1", status: "ACTIVE", countries: ["AU"], performance: perf({ spendCents: 50_000 }) },
        { ...base.adSets[0], id: "h2", name: "TR | T-Shirts", campaignId: "c_1", status: "ACTIVE", countries: ["AU"], performance: perf({ spendCents: 40_000 }) },
      ],
    });
    expect(resolveProfile({ snapshot: snap, goals: noGoals, request: "strategy", history: [], money }).fromData.find((x) => x.item === "what they sell")!.value).toBe(
      "Anti-Theft Hooks, T-Shirts",
    );
  });

  it("drops agency prefixes and keeps products that start with a temperature word", () => {
    const snap = bethel({
      adSets: [
        { ...base.adSets[0], id: "z1", name: "TR | Baskets | Broad", campaignId: "c_1", status: "ACTIVE", countries: ["AU"], performance: perf({ spendCents: 50_000 }) },
        { ...base.adSets[0], id: "z2", name: "Cold Brew Coffee", campaignId: "c_1", status: "ACTIVE", countries: ["AU"], performance: perf({ spendCents: 40_000 }) },
        { ...base.adSets[0], id: "z3", name: "Warm – Website visitors 30d", campaignId: "c_1", status: "ACTIVE", countries: ["AU"], performance: perf({ spendCents: 30_000 }) },
      ],
    });
    expect(resolveProfile({ snapshot: snap, goals: noGoals, request: "strategy", history: [], money }).fromData.find((x) => x.item === "what they sell")!.value).toBe(
      "Baskets, Cold Brew Coffee",
    );
  });

  it("explains a missing target differently when the numbers failed to load", () => {
    const p = resolveProfile({ snapshot: bethel({ totals: null }), goals: noGoals, request: "strategy", history: [], money });
    expect(p.ask.find((q) => q.item === "goal")!.why).toContain("didn't load");
  });

  it("does not quote a $0.00 order value", () => {
    const p = resolveProfile({ snapshot: bethel({ totals: perf({ purchaseValueCents: 0 }) }), goals: noGoals, request: "strategy", history: [], money });
    expect(p.ask[0].why).not.toContain("$0.00");
  });

  it("does not ask for margin when it is saved", () => {
    const g = resolveGoals({ goals_profile: { business_model: "ecommerce", gross_margin_pct: 40 } });
    expect(resolveProfile({ snapshot: bethel(), goals: g, request: "strategy", history: [], money }).ask).toEqual([]);
  });

  it("asks a lead account about lead quality, never margin", () => {
    const leads = bethel({
      totals: perf({ purchases: null, purchaseValueCents: null, roas: null, leads: 40, results: 40, resultLabel: "Leads", costPerResultCents: 3_372 }),
      campaigns: [{ ...base.campaigns[0], id: "c_1", name: "Leads", objective: "OUTCOME_LEADS", status: "ACTIVE" }],
    });
    const g = resolveGoals({ goals_profile: { business_model: "lead_gen" } });
    const p = resolveProfile({ snapshot: leads, goals: g, request: "strategy", history: [], money });
    expect(p.ask.map((q) => q.item)).toEqual(["lead quality"]);
    expect(p.fromData.find((x) => x.item === "goal")!.value).toContain("$33.72 per lead");
  });

  it("asks for a target only when the account has no results to plan from", () => {
    const none = bethel({ totals: perf({ results: 0, purchases: 0, purchaseValueCents: 0, roas: null, costPerResultCents: null }) });
    const p = resolveProfile({ snapshot: none, goals: noGoals, request: "strategy", history: [], money });
    expect(p.ask.map((q) => q.item)).toContain("goal");
  });

  it("never asks more than three questions", () => {
    const empty = bethel({ totals: perf({ results: 0, purchases: 0, purchaseValueCents: 0, roas: null, costPerResultCents: null, leads: 0 }) });
    const g = resolveGoals({ goals_profile: {} });
    expect(resolveProfile({ snapshot: empty, goals: g, request: "strategy", history: [], money }).ask.length).toBeLessThanOrEqual(3);
  });
});
