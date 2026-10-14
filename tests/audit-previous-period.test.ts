import { describe, expect, it } from "vitest";
import {
  demoMetaAuditSnapshot,
  fetchMetaAuditSnapshot,
  previousPeriodOf,
  scopeAuditSnapshot,
} from "@/lib/audit/meta-audit-data";
import { renderAdSetEvidence } from "@/lib/audit/render";

describe("previous period", () => {
  it("is the same number of days immediately before", () => {
    expect(previousPeriodOf("2026-09-09", "2026-09-12")).toEqual({ since: "2026-09-05", until: "2026-09-08" });
    expect(previousPeriodOf("2026-09-16", "2026-09-16")).toEqual({ since: "2026-09-15", until: "2026-09-15" });
    expect(previousPeriodOf("2026-03-01", "2026-03-31")).toEqual({ since: "2026-01-29", until: "2026-02-28" });
  });

  it("fetches campaign and ad set results for the previous window", async () => {
    const calls: Array<{ path: string; params: Record<string, unknown> }> = [];
    const insight = (key: string, id: string, spend: string, leads: string) => ({
      [key]: id,
      spend,
      impressions: "1000",
      reach: "800",
      frequency: "1.25",
      inline_link_click_ctr: "1.1",
      cpm: "10",
      results: [{ indicator: "actions:onsite_conversion.lead_grouped", values: [{ value: leads }] }],
    });
    const graph = {
      get: async <T,>(path: string, params: Record<string, unknown> = {}): Promise<T> => {
        calls.push({ path, params });
        const range = String(params.time_range ?? "");
        const previous = range.includes("2026-09-05");
        if (path === "act_1") return { name: "TR", currency: "USD", timezone_name: "Australia/Sydney", account_status: 1 } as T;
        if (path === "act_1/campaigns") return { data: [{ id: "c1", name: "TR | Lead Gen", objective: "OUTCOME_LEADS", effective_status: "ACTIVE", daily_budget: "3000" }] } as T;
        if (path === "act_1/adsets") return { data: [{ id: "a1", name: "Broad", campaign_id: "c1", effective_status: "ACTIVE" }] } as T;
        if (path === "act_1/insights" && params.level === "campaign") {
          return { data: [previous ? insight("campaign_id", "c1", "100", "2") : insight("campaign_id", "c1", "120", "6")] } as T;
        }
        if (path === "act_1/insights" && params.level === "adset" && params.time_range) {
          return { data: [previous ? insight("adset_id", "a1", "100", "2") : insight("adset_id", "a1", "120", "6")] } as T;
        }
        if (path === "act_1/insights" && params.level === "account" && !params.breakdowns) {
          return { data: [previous ? insight("account_id", "act_1", "100", "2") : insight("account_id", "act_1", "120", "6")] } as T;
        }
        return { data: [] } as T;
      },
    };
    const snap = await fetchMetaAuditSnapshot(graph, "act_1", { since: "2026-09-09", until: "2026-09-12" });
    expect(snap.period).toMatchObject({ since: "2026-09-09", until: "2026-09-12", days: 4 });
    expect(snap.previousPeriod).toEqual({ since: "2026-09-05", until: "2026-09-08" });
    expect(snap.campaigns[0]!.performance?.spendCents).toBe(12_000);
    expect(snap.campaigns[0]!.previousPerformance?.spendCents).toBe(10_000);
    expect(snap.adSets[0]!.previousPerformance?.results).toBe(2);
    expect(snap.previousTotals?.spendCents).toBe(10_000);
    expect(calls.some((c) => String(c.params.time_range).includes('"until":"2026-09-08"'))).toBe(true);
  });
});

describe("period comparison in evidence", () => {
  it("scoping sums the previous totals of the audited campaigns", () => {
    const scoped = scopeAuditSnapshot(demoMetaAuditSnapshot("act_1", "Demo", 4), ["demo_campaign_1", "demo_campaign_3"]);
    expect(scoped.previousTotals?.spendCents).toBe(150_000 + 90_000);
  });

  it("shows the change against the previous period for totals, campaigns and ad sets", () => {
    const scoped = scopeAuditSnapshot(demoMetaAuditSnapshot("act_1", "Demo", 4), ["demo_campaign_1"]);
    const text = renderAdSetEvidence(scoped);
    expect(text).toMatch(/vs previous period \(\d{4}-\d{2}-\d{2} → \d{4}-\d{2}-\d{2}\)/);
    // demo_campaign_1: spend $1,500 → $1,780 (+19%), 40 → 49 Leads.
    expect(text).toContain("spend $1,500 → $1,780 (+19%)");
    expect(text).toContain("Leads 40 → 49");
    // as_2 had no delivery before.
    expect(text).toContain("no delivery in the previous period");
  });

  it("says so when the previous period wasn't loaded", () => {
    const snap = demoMetaAuditSnapshot("act_1", "Demo", 4);
    const scoped = scopeAuditSnapshot({ ...snap, previousPeriod: undefined }, ["demo_campaign_1"]);
    expect(renderAdSetEvidence(scoped)).not.toMatch(/vs previous period/);
  });
});
