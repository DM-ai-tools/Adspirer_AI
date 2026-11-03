import { describe, expect, it } from "vitest";
import { demoMetaAuditSnapshot, type PeriodPerformance } from "@/lib/audit/meta-audit-data";
import { renderAdSetEvidence } from "@/lib/audit/render";
import { snapshotTableRows } from "@/lib/report/from-markdown";

const sales: PeriodPerformance = {
  spendCents: 200_000,
  impressions: 100_000,
  reach: 40_000,
  frequency: 2.5,
  linkCtr: 1.5,
  cpmCents: 2_000,
  results: 50,
  resultLabel: "Website leads",
  costPerResultCents: 4_000,
  roas: 3,
  linkClicks: 1_500,
  clicks: 2_400,
  landingPageViews: 1_100,
  addToCart: 300,
  initiateCheckout: 120,
  purchases: 40,
  purchaseValueCents: 600_000,
};

describe("account snapshot metrics", () => {
  it("gives the writer every metric incl. sales revenue on the Totals line", () => {
    const snap = { ...demoMetaAuditSnapshot("act_1", "Shop", 30), totals: sales };
    const line = renderAdSetEvidence(snap).split("\n").find((l) => l.startsWith("Totals:"))!;
    for (const part of [
      "sales revenue (purchase value) $6,000",
      "ROAS 3.00×",
      "purchases 40",
      "cost per purchase $50.00",
      "average order value $150.00",
      "link clicks 1,500",
      "cost per link click $1.33",
      "clicks (all) 2,400",
      "landing page views 1,100",
      "add to cart 300",
      "initiate checkout 120",
    ]) {
      expect(line).toContain(part);
    }
  });

  it("says so when a non-sales account has no purchase value, rather than dropping it silently", () => {
    const { purchaseValueCents, purchases, ...noSales } = sales;
    void purchaseValueCents;
    void purchases;
    const snap = { ...demoMetaAuditSnapshot("act_1", "Shop", 30), totals: { ...noSales, roas: null } };
    const line = renderAdSetEvidence(snap).split("\n").find((l) => l.startsWith("Totals:"))!;
    expect(line).toContain("sales revenue: no purchase value reported");
  });

  it("keeps every Metric | Value row of the snapshot table for the PDF/Word export", () => {
    const md = [
      "## 2. Account Snapshot",
      "| Metric | Value |",
      "|---|---|",
      "| Total spend | $2,000 |",
      "| Sales revenue (purchase value) | $6,000 |",
      "| ROAS | 3.00× |",
      "| Purchases | 40 |",
      "### Changes during this period",
      "| Date | What changed |",
      "| 20 Oct | Budget raised |",
    ].join("\n");
    const rows = snapshotTableRows(md);
    expect(rows.map((r) => r.label)).toEqual(["Total spend", "Sales revenue (purchase value)", "ROAS", "Purchases"]);
    expect(rows.find((r) => r.label === "ROAS")!.value).toBe("3.00×");
  });
});
