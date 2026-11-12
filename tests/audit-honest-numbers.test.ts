import { describe, expect, it } from "vitest";
import { demoMetaAuditSnapshot, type AuditAd, type MetaAuditSnapshot, type PeriodPerformance } from "@/lib/audit/meta-audit-data";
import { renderLandingPageTables, renderPerformanceTables, THIN_MARK } from "@/lib/audit/performance-tables";
import { META_AUDIT_FRAMEWORK } from "@/lib/agent/meta-audit-framework";

const perf = (spend: number, lpv: number, atc: number, purch: number, value: number): PeriodPerformance => ({
  spendCents: spend * 100,
  impressions: spend * 30,
  reach: 0,
  frequency: 1.5,
  linkCtr: 4,
  cpmCents: 3300,
  results: purch,
  resultLabel: "Purchases",
  costPerResultCents: null,
  roas: null,
  linkClicks: Math.round((spend * 30 * 4) / 100),
  landingPageViews: lpv,
  addToCart: atc,
  purchases: purch,
  purchaseValueCents: value * 100,
});

const base = demoMetaAuditSnapshot("act_1", "Shop");
const ad = (id: string, link: string | null, p: PeriodPerformance): AuditAd => ({ ...base.ads[0]!, id, name: id, linkUrl: link, copy: null, performance: p });
const snap = (ads: AuditAd[]): MetaAuditSnapshot => ({
  ...base,
  account: { ...base.account, currency: "AUD" },
  ads,
  totals: perf(10000, 12000, 1500, 60, 40000),
});

const ADS = [
  ad("a1", "https://shop.test/", perf(5000, 6000, 700, 40, 20000)),
  ad("a2", "https://shop.test/collections/sale", perf(3500, 4500, 600, 18, 15000)),
  ad("a3", "https://shop.test/products/tiny", perf(100, 150, 8, 2, 4000)),
  ad("a4", null, perf(1400, 1350, 192, 0, 0)),
];

describe("figures that agree and small numbers that are marked", () => {
  it("marks a ROAS built on a handful of purchases, and says what the mark means", () => {
    const md = renderPerformanceTables(snap(ADS));
    // 4,000 revenue on 100 spend from 2 purchases is a 40× ROAS: marked, not offered as a finding.
    expect(md).toMatch(new RegExp(`40\.00 ${THIN_MARK}`));
    expect(md).toContain("Fewer than 10 reported purchases behind this ROAS");
    // A ROAS on plenty of purchases stays plain.
    expect(md).toMatch(/\| 4\.00 \|/);
  });

  it("makes the landing-page read use the same share and overall cost as the table above it", () => {
    const md = renderLandingPageTables(snap(ADS));
    const tableShare = /\| shop\.test \| 1 \| 5,000 \| ([\d.]+)%/.exec(md)?.[1];
    expect(tableShare).toBe("50.0");
    // The read names the same 50.0%, not a share of the linked pages only (which would be 58.1%).
    expect(md).toMatch(/shop\.test takes 50\.0% of spend/);
    expect(md).not.toMatch(/58\.\d% of spend/);
  });
});

describe("the audit method on honest numbers", () => {
  it("leads with add-to-cart cost when purchases are view-through or few, and treats small numbers as too little to judge", () => {
    expect(META_AUDIT_FRAMEWORK).toMatch(/lead performance with cost per add-to-cart/);
    expect(META_AUDIT_FRAMEWORK).toMatch(/too little to judge/);
    expect(META_AUDIT_FRAMEWORK).toMatch(/never evidence of broken tracking/);
    expect(META_AUDIT_FRAMEWORK).toMatch(/don't say where ads were delivered/);
  });

  it("keeps the report short and dates a change by the edit, not the launch", () => {
    expect(META_AUDIT_FRAMEWORK).toMatch(/Length limits/);
    expect(META_AUDIT_FRAMEWORK).toMatch(/date of the edit itself/);
  });
});

describe("the second review's findings", () => {
  it("judges on the cleaner signal and never recommends aligning to a view-through window", () => {
    expect(META_AUDIT_FRAMEWORK).toMatch(/Verdicts use the cleaner signal/);
    expect(META_AUDIT_FRAMEWORK).toMatch(/Never recommend aligning everything to a window that includes view-through/);
  });

  it("holds an edit verdict to the figures, and the tally to the cards", () => {
    expect(META_AUDIT_FRAMEWORK).toMatch(/A verdict needs the numbers/);
    expect(META_AUDIT_FRAMEWORK).toMatch(/count them/);
  });

  it("names one cause per problem, checks its pointers and gives already-paused ad sets a fitting verdict", () => {
    expect(META_AUDIT_FRAMEWORK).toMatch(/One cause per problem/);
    expect(META_AUDIT_FRAMEWORK).toMatch(/Every "see R#" must point to a risk/);
    expect(META_AUDIT_FRAMEWORK).toMatch(/Reactivate \(if …\) \/ Keep paused/);
  });

  it("asks for the used / never-used matrix, dollar budgets and test design", () => {
    expect(META_AUDIT_FRAMEWORK).toMatch(/Used \/ Not used in the audited period/);
    expect(META_AUDIT_FRAMEWORK).toMatch(/\| Layer \| Campaign \| Audience \| Budget share \| Daily budget \|/);
    expect(META_AUDIT_FRAMEWORK).toMatch(/the budget it needs, how long it runs/);
  });
});

describe("a card with an empty field", () => {
  it("leaves the field off instead of printing a dash", async () => {
    const { parseMarkdownToBlocks } = await import("@/lib/reports/parse-markdown");
    const { presentBlocks } = await import("@/lib/reports/present");
    const md = ["### 2. Confirm the Purchase event fires", "- **Who:** Developer", "- **How:** —", "- **Done when:** match rate is 70% or more"].join("\n");
    const card = presentBlocks(parseMarkdownToBlocks(md)).find((b) => b.type === "card");
    if (card?.type !== "card") throw new Error("expected a card");
    expect(card.fields.map((f) => f.label)).toEqual(["Who", "Done when"]);
  });
});
