import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Landing pages would be fetched over the network in the end-to-end audit turn.
vi.mock("@/lib/landing/analyze-page", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/landing/analyze-page")>();
  return { ...actual, analyzeLandingPages: vi.fn(async () => []) };
});

import { asksForComparison, resolveAuditBrief } from "@/lib/agent/audit-brief";
import { META_AUDIT_FRAMEWORK } from "@/lib/agent/meta-audit-framework";
import { gatherDiagnoseEvidence } from "@/lib/agent/adspirer-agent";
import {
  demoMetaAuditSnapshot,
  fetchMetaAuditSnapshot,
  scopeAuditSnapshot,
} from "@/lib/audit/meta-audit-data";
import { evaluateCheckpoints } from "@/lib/audit/checkpoints";
import { renderAdSetEvidence, renderScorecardEvidence, renderScorecardMarkdown } from "@/lib/audit/render";
import { createMockMetaAdsProvider } from "@/lib/adspirer/mock-provider";
import { getDemoStore, resetDemoStore } from "@/lib/demo/store";

const NOW = new Date("2026-10-23T08:00:00Z");
const BUG_PROMPT = "give me an audit of the active campaign from 21st oct to 23rd oct";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  resetDemoStore();
});

// ---------------------------------------------------------------------------
// 1. The brief: compare only when the operator asks.

describe("asksForComparison", () => {
  it.each([
    "audit the account for last 7 days and compare with the previous period",
    "audit last week and compare with the week before",
    "audit the active campaign for Oct 19-20, compared to the previous 2 days",
    "how does this compare to last week",
    "audit the account last 14 days vs previous period",
    "audit the account last 14 days vs. the prior period",
    "audit last 7 days versus the previous 7 days",
    "audit last month against the previous month",
    "audit the account for September, include a comparison with August",
    "audit last week and show the trend",
    "what's the trend in cost per lead over the last 30 days",
    "audit the campaign, is CPA trending up?",
    "how has it changed since last week",
    "how have the results changed over the last 2 weeks",
    "give me a week over week view for the last 14 days",
    "audit with week-over-week numbers",
    "audit this month, month over month",
    "has CPL improved since the new creative went live",
    "audit — has performance declined since last month?",
    "is spend higher than last week",
    "audit the account for last 7 days and the previous period",
    "audit last 7 days vs the week before",
  ])("asks: %s", (text) => {
    expect(asksForComparison(text)).toBe(true);
  });

  it.each([
    BUG_PROMPT,
    "audit the account for the last 7 days",
    "audit last week",
    "audit the account from the last 7 days",
    "audit the previous week",
    "audit campaign TR | Lead | Previous video for last 7 days",
    "audit the campaign that was live previously",
    "audit the account for last month",
    "Please audit the entire account for the last 7 days. No competitor landing pages.",
    "audit the account and compare our landing pages with competitor landing pages",
    "compare my ads with the competitor ads",
    "compare campaign A vs campaign B",
    "audit the active campaign last 7 days, test the new creative against the old one",
    "audit the account since 1 Oct",
    "audit the account for the last 30 days, what changed in the setup",
    "audit last 7 days, no comparison",
    "audit last 7 days but don't compare with the previous period",
    "audit last 7 days, skip the competitor comparison",
    "no competitor comparison, last 7 days",
    "audit the account for last 7 days, maybe compare landing pages later",
  ])("does not ask: %s", (text) => {
    expect(asksForComparison(text)).toBe(false);
  });
});

describe("audit brief compare flag", () => {
  it("the bug prompt audits 21–23 Oct alone", () => {
    const brief = resolveAuditBrief(BUG_PROMPT);
    expect(brief).toMatchObject({
      scope: "campaigns",
      activeCampaigns: true,
      dateStart: "2026-10-21",
      dateStop: "2026-10-23",
      compare: false,
      compareStart: null,
      compareStop: null,
      ready: true,
    });
  });

  it("two named ranges compare those ranges", () => {
    const brief = resolveAuditBrief("audit the account for Oct 19-20 vs Oct 17-18");
    expect(brief).toMatchObject({
      dateStart: "2026-10-19",
      dateStop: "2026-10-20",
      compare: true,
      compareStart: "2026-10-17",
      compareStop: "2026-10-18",
    });
  });

  it("an asked comparison without a second range uses the period just before", () => {
    const brief = resolveAuditBrief("audit the account for last week and compare with the week before");
    expect(brief.compare).toBe(true);
    expect(brief.compareStart).toBeNull();
    expect(brief.compareStop).toBeNull();
    expect(brief.dateStart).not.toBeNull();
  });

  it("a later single range without a comparison ask drops an earlier comparison", () => {
    const named = resolveAuditBrief("now audit 16th to 17th october", [
      { role: "user", content: "audit the account Oct 19-20 vs Oct 17-18" },
    ]);
    expect(named.dateStart).toBe("2026-10-16");
    expect(named.compare).toBe(false);
    expect(named.compareStart).toBeNull();

    const asked = resolveAuditBrief(BUG_PROMPT, [
      { role: "user", content: "audit the account for last 7 days and compare with the previous period" },
    ]);
    expect(asked.compare).toBe(false);
  });

  it("a follow-up that asks to compare (no new range) turns the comparison on", () => {
    const brief = resolveAuditBrief("also compare with the previous period", [{ role: "user", content: BUG_PROMPT }]);
    expect(brief.dateStart).toBe("2026-10-21");
    expect(brief.compare).toBe(true);
    expect(brief.compareStart).toBeNull();
  });

  it("a follow-up that only fills a gap keeps the earlier comparison ask", () => {
    const brief = resolveAuditBrief("the entire account", [
      { role: "user", content: "audit last 7 days vs previous period" },
    ]);
    expect(brief.scope).toBe("account");
    expect(brief.compare).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. The snapshot: no comparison fetch unless asked.

type Params = Record<string, unknown>;

function fakeGraph() {
  const calls: Array<{ path: string; params: Params }> = [];
  const insight = (key: string, id: string) => ({
    [key]: id,
    spend: "120",
    impressions: "1000",
    reach: "800",
    frequency: "1.25",
    inline_link_click_ctr: "1.1",
    inline_link_clicks: "11",
    cpm: "10",
    results: [{ indicator: "actions:onsite_conversion.lead_grouped", values: [{ value: "6" }] }],
  });
  const graph = {
    get: async <T,>(path: string, params: Params = {}): Promise<T> => {
      calls.push({ path, params });
      if (path === "act_1") return { name: "TR", currency: "USD", timezone_name: "Australia/Sydney", account_status: 1 } as T;
      if (path === "act_1/campaigns") return { data: [{ id: "c1", name: "TR | Lead Gen", objective: "OUTCOME_LEADS", effective_status: "ACTIVE" }] } as T;
      if (path === "act_1/adsets") return { data: [{ id: "a1", name: "Broad", campaign_id: "c1", effective_status: "ACTIVE" }] } as T;
      if (path === "act_1/insights" && params.level === "campaign") return { data: [insight("campaign_id", "c1")] } as T;
      if (path === "act_1/insights" && params.level === "adset" && params.time_range) return { data: [insight("adset_id", "a1")] } as T;
      if (path === "act_1/insights" && params.level === "account" && !params.breakdowns) return { data: [insight("account_id", "act_1")] } as T;
      return { data: [] } as T;
    },
  };
  return { graph, calls };
}

const ranges = (calls: Array<{ params: Params }>) =>
  [...new Set(calls.map((c) => c.params.time_range).filter(Boolean).map(String))];

describe("fetchMetaAuditSnapshot compare option", () => {
  it("compare: false makes no comparison-window calls and carries no comparison data", async () => {
    const { graph, calls } = fakeGraph();
    const snap = await fetchMetaAuditSnapshot(graph, "act_1", { since: "2026-10-21", until: "2026-10-23", compare: false });
    expect(ranges(calls)).toEqual([JSON.stringify({ since: "2026-10-21", until: "2026-10-23" })]);
    expect(snap.previousPeriod).toBeUndefined();
    expect(snap.previousTotals).toBeUndefined();
    expect(snap.comparisonFailures).toBeUndefined();
    expect(snap.comparisonNamed).toBeUndefined();
    expect(snap.comparisonNotRequested).toBe(true);
    expect(snap.campaigns[0]).not.toHaveProperty("previousPerformance");
    expect(snap.adSets[0]).not.toHaveProperty("previousPerformance");
    expect(snap.warnings).toEqual([]);
    expect(snap.totals?.spendCents).toBe(12_000);
  });

  it("compare: false ignores a stray comparison range", async () => {
    const { graph, calls } = fakeGraph();
    await fetchMetaAuditSnapshot(graph, "act_1", {
      since: "2026-10-21",
      until: "2026-10-23",
      compare: false,
      compareSince: "2026-10-17",
      compareUntil: "2026-10-18",
    });
    expect(ranges(calls)).toEqual([JSON.stringify({ since: "2026-10-21", until: "2026-10-23" })]);
  });

  it("by default (monitoring) still loads the period just before", async () => {
    const { graph, calls } = fakeGraph();
    const snap = await fetchMetaAuditSnapshot(graph, "act_1", { since: "2026-10-21", until: "2026-10-23" });
    expect(ranges(calls)).toContain(JSON.stringify({ since: "2026-10-18", until: "2026-10-20" }));
    expect(snap.previousPeriod).toEqual({ since: "2026-10-18", until: "2026-10-20" });
    expect(snap.comparisonNotRequested).toBeUndefined();
  });

  it("the demo snapshot and the mock provider drop all comparison data when not asked", async () => {
    for (const id of ["act_1", "act_700800900"]) {
      const snap = demoMetaAuditSnapshot(id, "Demo", { since: "2026-10-21", until: "2026-10-23", compare: false });
      expect(snap.previousPeriod).toBeUndefined();
      expect(snap.previousTotals).toBeUndefined();
      expect(snap.comparisonNotRequested).toBe(true);
      expect(snap.campaigns.some((c) => "previousPerformance" in c)).toBe(false);
      expect(snap.adSets.some((a) => "previousPerformance" in a)).toBe(false);
    }
    // Monitoring's call shape is unchanged.
    expect(demoMetaAuditSnapshot("act_demo", "Demo", 7).previousTotals).toBeTruthy();

    const provider = createMockMetaAdsProvider();
    const snap = await provider.getAuditSnapshot("act_400500600", { since: "2026-10-21", until: "2026-10-23", compare: false });
    expect(snap.previousPeriod).toBeUndefined();
    expect(snap.comparisonNotRequested).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Evidence: one period, said once.

describe("evidence when no comparison was requested", () => {
  const snap = demoMetaAuditSnapshot("act_1", "Demo", { since: "2026-10-21", until: "2026-10-23", compare: false });

  it.each([
    ["account", snap],
    ["campaign scope", scopeAuditSnapshot(snap, ["demo_campaign_1"])],
  ])("%s: no previous-period lines, one 'not requested' statement", (_label, s) => {
    const text = renderAdSetEvidence(s);
    expect(text.match(/Comparison: not requested — report this period only\./g)).toHaveLength(1);
    expect(text).toMatch(/^Totals: spend /m);
    expect(text).not.toMatch(/previous period|comparison period|\bvs previous|Totals vs|failed to load|not available|→ \$/i);
    expect(text).not.toMatch(/no delivery in the previous/);
    const scorecard = evaluateCheckpoints(s);
    expect(renderScorecardEvidence(scorecard, s)).not.toMatch(/failed to load|previous period|comparison/i);
    expect(renderScorecardMarkdown(scorecard, s)).not.toMatch(/previous period|comparison period/i);
  });

  it("says it once when the scope has no ad sets", () => {
    const text = renderAdSetEvidence(scopeAuditSnapshot({ ...snap, adSets: [] }, ["demo_campaign_1"]));
    expect(text).toMatch(/No ad sets/);
    expect(text.match(/Comparison: not requested/g)).toHaveLength(1);
  });

  it("a requested comparison still shows before → after", () => {
    const compared = demoMetaAuditSnapshot("act_1", "Demo", { since: "2026-10-21", until: "2026-10-23" });
    const text = renderAdSetEvidence(compared);
    expect(text).toContain("Totals vs previous period (2026-10-18 → 2026-10-20)");
    expect(text).not.toContain("not requested");
  });
});

// ---------------------------------------------------------------------------
// 6. The writer's report format.

describe("report format prompt", () => {
  it("reports only what was asked", () => {
    expect(META_AUDIT_FRAMEWORK).toMatch(/Report only what the operator asked for/);
  });

  it("makes the comparison conditional on the evidence", () => {
    expect(META_AUDIT_FRAMEWORK).toMatch(/Comparison: not requested/);
    expect(META_AUDIT_FRAMEWORK).toMatch(/no "vs previous" columns/i);
    expect(META_AUDIT_FRAMEWORK).toMatch(/"Period:" line shows only the audited period/);
    expect(META_AUDIT_FRAMEWORK).not.toMatch(/if there is no comparison line at all, say the comparison wasn't loaded/);
    // The ad set verdict mentions a trend only with comparison evidence.
    expect(META_AUDIT_FRAMEWORK).not.toMatch(/cost per result vs the campaign, trend vs the previous period,/);
    expect(META_AUDIT_FRAMEWORK).toMatch(/trend[^.\n]*only when the evidence has comparison lines/i);
  });
});

// ---------------------------------------------------------------------------
// End to end: the bug prompt through the audit turn in DEMO_MODE.

describe("audit turn end to end", () => {
  // ClickTrends' demo campaigns match its demo snapshot, so its ad set evidence has totals.
  async function auditTurn(request: string) {
    getDemoStore().connectedMetaAccounts.find((a) => a.client_id === "client_clicktrends")!.access_status = "granted";
    const gathered = await gatherDiagnoseEvidence({ clientId: "client_clicktrends", request, intent: "audit" });
    const evidence = gathered.evidence;
    // The evidence the snapshot produced (the framework text after it quotes the line names).
    const adSets = evidence.slice(evidence.indexOf("### Ad sets ("), evidence.indexOf("### Audit checklist"));
    return { gathered, evidence, adSets };
  }

  it("the bug prompt audits the period alone", async () => {
    const { gathered, evidence, adSets } = await auditTurn(BUG_PROMPT);
    expect(evidence).toContain("### Audit brief (confirmed)");
    expect(evidence).toContain("- Compared with: nothing — not requested; report the audited period only");
    expect(adSets).toContain("### Ad sets (2026-10-21 → 2026-10-23)");
    expect(adSets).toMatch(/^Totals: spend /m);
    expect(adSets.match(/Comparison: not requested — report this period only\./g)).toHaveLength(1);
    expect(adSets).not.toMatch(/Totals vs|vs previous period|Campaign vs|immediately before|failed to load|→ \$/);
    expect(gathered.toolCalls.map((c) => c.name)).toContain("audit_checkpoints");
  });

  it("an asked comparison without a second range loads the period just before", async () => {
    const { evidence, adSets } = await auditTurn(`${BUG_PROMPT}, and show the trend`);
    expect(evidence).toContain("- Compared with: the same number of days immediately before (as asked)");
    expect(adSets).toContain("Totals vs previous period (2026-10-18 → 2026-10-20)");
    expect(adSets).not.toContain("not requested");
  });

  it("'compare with the previous period' resolves to the same window", async () => {
    // The date parser reads "the previous period" relative to the audited range, so it is named.
    const { evidence, adSets } = await auditTurn(`${BUG_PROMPT} and compare with the previous period`);
    expect(evidence).toMatch(/- Compared with: .*\(2026-10-18 → 2026-10-20\), as the operator asked/);
    expect(adSets).toContain("Totals vs comparison period (2026-10-18 → 2026-10-20)");
  });

  it("two named ranges compare exactly those", async () => {
    const { evidence, adSets } = await auditTurn("audit the active campaign for Oct 19-20 vs Oct 17-18");
    expect(evidence).toMatch(/- Compared with: .*\(2026-10-17 → 2026-10-18\), as the operator asked/);
    expect(adSets).toContain("Totals vs comparison period (2026-10-17 → 2026-10-18)");
  });
});
