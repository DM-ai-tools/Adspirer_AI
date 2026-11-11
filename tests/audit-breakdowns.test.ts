import { describe, expect, it } from "vitest";
import {
  audienceKind,
  destinationKind,
  groupAds,
  renderBreakdownEvidence,
  settingsInUse,
  sliceOf,
} from "@/lib/audit/breakdowns";
import { demoMetaAuditSnapshot, type AuditAd, type AuditAdSet, type MetaAuditSnapshot, type PeriodPerformance } from "@/lib/audit/meta-audit-data";
import { META_AUDIT_FRAMEWORK } from "@/lib/agent/meta-audit-framework";

const perf = (over: Partial<PeriodPerformance> = {}): PeriodPerformance => ({
  spendCents: 100_000,
  impressions: 10_000,
  reach: 8_000,
  frequency: 1.2,
  linkCtr: 1.5,
  cpmCents: 1000,
  results: 10,
  resultLabel: "Purchases",
  costPerResultCents: 10_000,
  roas: null,
  addToCart: 50,
  landingPageViews: 500,
  ...over,
});

const ad = (id: string, format: string | null, linkUrl: string | null, p: PeriodPerformance | null): AuditAd => ({
  id,
  name: id,
  adSetId: "s1",
  campaignId: "c1",
  status: "ACTIVE",
  createdTime: null,
  format,
  issue: null,
  linkUrl,
  performance: p,
});

const base = (): MetaAuditSnapshot => demoMetaAuditSnapshot("act_1", "Test", 30);

describe("breakdown grouping", () => {
  it("adds up spend, results and add to cart per format and ignores ads that did not spend", () => {
    const groups = groupAds(
      [
        ad("a", "VIDEO", null, perf({ spendCents: 200_000, results: 20, addToCart: 100 })),
        ad("b", "VIDEO", null, perf({ spendCents: 100_000, results: 5, addToCart: 20 })),
        ad("c", "IMAGE", null, perf()),
        ad("d", "IMAGE", null, null),
        ad("e", "IMAGE", null, perf({ spendCents: 0 })),
      ],
      (x) => (x.format === "VIDEO" ? "Video" : "Static image"),
    );
    expect(groups.map((g) => g.label)).toEqual(["Video", "Static image"]);
    expect(groups[0]).toMatchObject({ items: 2, spendCents: 300_000, results: 25, addToCart: 120 });
    expect(groups[1]).toMatchObject({ items: 1, spendCents: 100_000 });
  });

  it("leaves a metric empty (not zero) when no row returned it", () => {
    const s = sliceOf("x", [perf({ addToCart: undefined, purchases: undefined })]);
    expect(s.addToCart).toBeNull();
    expect(s.purchases).toBeNull();
  });

  it("reads the destination from the link and says when there is none", () => {
    expect(destinationKind("https://shop.example/products/blue-sofa")).toBe("Product page");
    expect(destinationKind("https://shop.example/collections/sofas")).toBe("Collection page");
    expect(destinationKind("https://shop.example/")).toBe("Homepage");
    expect(destinationKind("https://shop.example/pages/about")).toBe("Other page");
    expect(destinationKind(null)).toBe("Link not returned by Meta");
    expect(destinationKind("not a url")).toBe("Link not returned by Meta");
  });

  it("types audiences from what the ad set includes, never calling no-audience broad", () => {
    const set = (over: Partial<AuditAdSet>) => ({ includedAudienceIds: [], productSetId: undefined, ...over }) as AuditAdSet;
    const subtypes = new Map([["l1", "LOOKALIKE"], ["c1", "WEBSITE"]]);
    expect(audienceKind(set({ includedAudienceIds: ["l1"] }), subtypes)).toBe("Lookalike audience");
    expect(audienceKind(set({ includedAudienceIds: ["c1"] }), subtypes)).toMatch(/^Custom audience/);
    expect(audienceKind(set({ includedAudienceIds: ["l1", "c1"] }), subtypes)).toBe("Lookalike + custom audience");
    expect(audienceKind(set({ productSetId: "p1" }), subtypes)).toBe("Catalogue (product set)");
    const none = audienceKind(set({}), subtypes);
    expect(none).toMatch(/broad or interest-based/);
    expect(none).toMatch(/interests not read/);
  });
});

describe("renderBreakdownEvidence", () => {
  it("flags spend that no listed ad accounts for instead of implying full coverage", () => {
    const snap = base();
    snap.totals = perf({ spendCents: 1_000_000 });
    snap.ads = [ad("a", "VIDEO", null, perf({ spendCents: 400_000 }))];
    const text = renderBreakdownEvidence(snap);
    expect(text).toMatch(/Spend not attributed to any listed ad/);
  });

  it("does not claim a gap when ads cover the account spend", () => {
    const snap = base();
    snap.totals = perf({ spendCents: 400_000 });
    snap.ads = [ad("a", "VIDEO", null, perf({ spendCents: 400_000 }))];
    expect(renderBreakdownEvidence(snap)).not.toMatch(/not attributed/);
  });

  it("states the unread share when ads return no link", () => {
    const snap = base();
    snap.totals = perf({ spendCents: 300_000 });
    snap.ads = [
      ad("a", "VIDEO", "https://s.example/products/x", perf({ spendCents: 100_000 })),
      ad("b", "VIDEO", null, perf({ spendCents: 200_000 })),
    ];
    expect(renderBreakdownEvidence(snap)).toMatch(/67% of ad spend has no readable link/);
  });

  it("prints age, gender and placement positions only when Meta returned them, and names a failed part", () => {
    const snap = base();
    snap.demographics = undefined;
    snap.placementPositions = undefined;
    snap.warnings = ["Age and gender breakdown: (#100) bad"];
    const text = renderBreakdownEvidence(snap);
    expect(text).not.toMatch(/#### Age/);
    expect(text).toMatch(/Not loaded .*Age and gender breakdown/);

    snap.demographics = [
      { age: "25-34", gender: "female", performance: perf({ spendCents: 50_000 }) },
      { age: "25-34", gender: "male", performance: perf({ spendCents: 20_000 }) },
    ];
    snap.placementPositions = [{ platform: "facebook", position: "feed", performance: perf({ spendCents: 70_000 }) }];
    const withData = renderBreakdownEvidence(snap);
    expect(withData).toMatch(/\| 25-34 \| 2 \|/);
    expect(withData).toMatch(/facebook \/ feed/);
  });

  it("every spend figure in a split table comes from the rows it was given", () => {
    const snap = base();
    snap.totals = perf({ spendCents: 123_400 });
    snap.ads = [ad("a", "VIDEO", null, perf({ spendCents: 123_400, results: 7, addToCart: 31 }))];
    const text = renderBreakdownEvidence(snap);
    const format = text.split("#### Creative format")[1].split("####")[0];
    expect(format).toMatch(/\$1,234/);
    expect(format).toMatch(/\| 7 \|/);
    expect(format).toMatch(/\| 31 \|/);
  });
});

describe("settingsInUse", () => {
  it("counts only what ad sets that spent are configured with", () => {
    const snap = base();
    const lines = settingsInUse(snap);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).toMatch(/Ad sets that spent: \d+/);
  });
});

describe("audit method", () => {
  it("tells the writer to keep splits honest and to phase recommendations", () => {
    expect(META_AUDIT_FRAMEWORK).toMatch(/not used in the audited period/i);
    expect(META_AUDIT_FRAMEWORK).toMatch(/Performance Breakdown/);
    expect(META_AUDIT_FRAMEWORK).toContain("[[PERFORMANCE_TABLES]]");
    expect(META_AUDIT_FRAMEWORK).toMatch(/Never write those tables yourself/);
    expect(META_AUDIT_FRAMEWORK).toMatch(/Week 1 \/ Weeks 2/);
  });
});
