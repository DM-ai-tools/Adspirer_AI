import { afterEach, describe, expect, it } from "vitest";
import { gatherDiagnoseEvidence } from "@/lib/agent/adspirer-agent";
import { normalizeBrief, parseBriefReply, rulesBrief, rulesStrategyScope } from "@/lib/agent/request-brief";
import type { AgentHistoryMessage } from "@/lib/agent/history";
import { DEMO_CLICKTRENDS_META_ACCOUNT_ID, demoMetaAuditSnapshot } from "@/lib/audit/meta-audit-data";
import { renderCampaignBreakdownEvidence, campaignsToBreakDown } from "@/lib/strategy/campaign-breakdown";
import { baselineOf } from "@/lib/strategy/account-strategy";
import { scopeAuditSnapshot } from "@/lib/audit/meta-audit-data";
import { resetDemoStore } from "@/lib/demo/store";

const u = (content: string): AgentHistoryMessage => ({ role: "user", content });
const a = (content: string): AgentHistoryMessage => ({ role: "assistant", content });
const PROPOSAL = "# Strategy — Click Trends\n\n| Option | x |\n|---|---|\n| Safe | 1 |\n| **Recommended** | 2 |\n| Bold | 3 |\n\n---\n**Next:** reply **safe**, **recommended** or **bold** to pick a target for the strategy.";
const money = (c: number) => `$${(c / 100).toFixed(2)}`;

describe("the strategy's scope, from the words alone (no model)", () => {
  it.each([
    "give me a strategy for each campaign",
    "campaign-wise strategy please",
    "strategy report with a plan per campaign",
    "build the strategy by campaign",
  ])("reads a per-campaign ask: %s", (ask) => {
    expect(rulesStrategyScope(ask, []).perCampaign).toBe(true);
  });

  it("keeps the scope of the original ask when the reply is only a pick", () => {
    const history = [u("give me a strategy for each campaign"), a(PROPOSAL)];
    expect(rulesStrategyScope("recommended", history).perCampaign).toBe(true);
  });

  it("reads a named campaign without target or period words", () => {
    expect(rulesStrategyScope("strategy for the Bar Stools campaign to 4x ROAS in 60 days", []).campaigns).toEqual(["Bar Stools"]);
  });

  it("is a plain account strategy when nothing narrows it", () => {
    expect(rulesStrategyScope("give me a strategy report", [])).toEqual({ campaigns: [], perCampaign: false });
  });
});

describe("the model's scope is kept honest", () => {
  it("drops a campaign name the operator never typed", () => {
    const req = "strategy for the Bar Stools campaign";
    const brief = parseBriefReply('{"intent":"strategy","strategyScope":{"campaigns":["Bar Stools","Sofas"],"perCampaign":false}}', req, [])!;
    expect(brief.strategyScope!.campaigns).toEqual(["Bar Stools"]);
  });

  it("never treats 'each' or 'all campaigns' as a campaign name", () => {
    for (const name of ["each", "all campaigns", "every campaign", "campaigns"]) {
      const req = `strategy for ${name}`;
      const brief = parseBriefReply(`{"intent":"strategy","strategyScope":{"campaigns":["${name}"],"perCampaign":true}}`, req, [])!;
      expect(brief.strategyScope!.campaigns, name).toEqual([]);
    }
  });

  it("carries a per-campaign ask through a pick", () => {
    const history = [u("strategy for each campaign please"), a(PROPOSAL)];
    const brief = normalizeBrief(parseBriefReply('{"intent":"strategy","strategyPick":"recommended","strategyScope":{"campaigns":[],"perCampaign":true}}', "recommended", history)!, "recommended", history);
    expect(brief).toMatchObject({ intent: "strategy", strategyPick: "recommended", strategyScope: { perCampaign: true } });
  });
});

describe("campaign breakdown evidence", () => {
  const snap = demoMetaAuditSnapshot(DEMO_CLICKTRENDS_META_ACCOUNT_ID, "Click Trends", 30);

  it("has a block per spending campaign with its own figures and targets that never fall below its own ROAS", () => {
    const out = renderCampaignBreakdownEvidence({ snapshot: snap, kind: "sales", profit: {}, money, pick: "recommended" });
    const campaigns = campaignsToBreakDown(snap);
    expect(campaigns.length).toBeGreaterThan(0);
    for (const c of campaigns) {
      expect(out).toContain(`#### Campaign: ${c.name}`);
      const own = baselineOf(scopeAuditSnapshot(snap, [c.id]), "sales");
      if (own?.roas == null) continue;
      const block = out.slice(out.indexOf(`#### Campaign: ${c.name}`)).split("\n#### ")[0];
      const roasCells = [...block.matchAll(/\| (\d+\.\d+)× \|/g)].map((m) => Number(m[1]));
      for (const r of roasCells) expect(r).toBeGreaterThanOrEqual(Math.floor(own.roas * 100) / 100);
    }
    expect(out).toContain("(the account's pick)");
  });
});

describe("the strategy step uses the scope", () => {
  afterEach(() => resetDemoStore());

  it("narrows a named-campaign strategy to that campaign", async () => {
    const req = "strategy for the Bar Stools campaign to 4x ROAS in 60 days";
    const brief = normalizeBrief(rulesBrief(req, []), req, []);
    const g = await gatherDiagnoseEvidence({ clientId: "client_clicktrends", request: req, history: [], intent: "strategy", brief });
    expect(g.evidence).toContain("### Strategy scope (the operator asked for these campaigns)");
    expect(g.evidence).toMatch(/This strategy covers only: Bar Stools/);
  }, 60_000);

  it("adds a section per campaign when the operator asked for that and picked a target", async () => {
    const history = [u("strategy for each campaign"), a(PROPOSAL)];
    const brief = normalizeBrief(rulesBrief("recommended", history), "recommended", history);
    const g = await gatherDiagnoseEvidence({ clientId: "client_clicktrends", request: "recommended", history, intent: "strategy", brief });
    expect(g.evidence).toContain("### Strategy framework (write the plan with these headings)");
    expect(g.evidence).toContain("### Campaign breakdown (one section per campaign, as the operator asked)");
    expect(g.evidence).toContain("#### Campaign: Bar Stools | Advantage+ | Sales");
  }, 60_000);

  it("a plain strategy has neither", async () => {
    const g = await gatherDiagnoseEvidence({ clientId: "client_clicktrends", request: "strategy to 4x ROAS in 60 days", history: [], intent: "strategy" });
    expect(g.evidence).not.toContain("### Strategy scope");
    expect(g.evidence).not.toContain("### Campaign breakdown");
  }, 60_000);
});
