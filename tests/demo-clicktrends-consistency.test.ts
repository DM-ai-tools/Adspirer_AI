import { describe, expect, it } from "vitest";
import { createMockMetaAdsProvider } from "@/lib/adspirer/mock-provider";
import { DEMO_CLICKTRENDS_META_ACCOUNT_ID, demoMetaAuditSnapshot } from "@/lib/audit/meta-audit-data";
import { getDemoStore } from "@/lib/demo/store";

const CT = "client_clicktrends";
const ACCOUNT = DEMO_CLICKTRENDS_META_ACCOUNT_ID;

describe("ClickTrends demo data is one consistent account", () => {
  it("has its Meta access request granted, with the time it was granted", () => {
    const requests = getDemoStore().clientAccessRequests.filter((r) => r.client_id === CT);
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) {
      expect(r.status).toBe("granted");
      expect(r.granted_at).toEqual(expect.any(String));
    }
    expect(getDemoStore().connectedMetaAccounts.find((a) => a.client_id === CT)?.access_status).toBe("granted");
  });

  it("lists the audit snapshot's campaigns and 30-day spend in the account overview", async () => {
    const provider = createMockMetaAdsProvider();
    const audit = demoMetaAuditSnapshot(ACCOUNT, "ClickTrends Performance", 30);
    const campaigns = await provider.listCampaigns(ACCOUNT);
    expect(campaigns.map((c) => [c.id, c.name, c.status, c.objective])).toEqual(
      audit.campaigns.map((c) => [c.id, c.name, c.status, c.objective]),
    );
    const overview = await provider.getAccountOverview(ACCOUNT);
    expect(overview.spend_30d * 100).toBe(audit.totals!.spendCents);
    expect(overview.active_campaigns).toBe(2);
    const insights = await provider.getAccountInsights(ACCOUNT, audit.period.since, audit.period.until);
    expect(Math.round(insights.spend * 100)).toBe(audit.totals!.spendCents);
    expect(insights.conversions).toBe(audit.totals!.results);
  });

  it("has a previous-period ROAS that matches its previous campaigns", () => {
    const audit = demoMetaAuditSnapshot(ACCOUNT, "ClickTrends Performance", 30);
    const previous = audit.campaigns.map((c) => c.previousPerformance!);
    const spend = previous.reduce((s, p) => s + p.spendCents, 0);
    const revenue = previous.reduce((s, p) => s + p.spendCents * p.roas!, 0);
    expect(audit.previousTotals!.spendCents).toBe(spend);
    expect(audit.previousTotals!.roas).toBe(2.46);
    expect(audit.previousTotals!.roas).toBe(Math.round((revenue / spend) * 100) / 100);
  });
});
