import { describe, expect, it } from "vitest";
import { categoriesFromServices, type StrategyCategory } from "@/lib/strategy/categories";
import { attributeSpendToCategories } from "@/lib/strategy/category-attribution";
import {
  demoMetaAuditSnapshot,
  type AuditAd,
  type MetaAuditSnapshot,
  type PeriodPerformance,
} from "@/lib/audit/meta-audit-data";
import type { ClientService } from "@/types/database";

function cat(over: Partial<StrategyCategory> & { id: string; name: string }): StrategyCategory {
  return {
    landingPageUrl: null,
    urlPatterns: [],
    keywords: [],
    grossMarginPct: null,
    averageOrderValueCents: null,
    priority: 0,
    ...over,
  };
}

function perf(spendCents: number, roas: number | null, results: number | null = 1): PeriodPerformance {
  return {
    spendCents,
    impressions: 1000,
    reach: 800,
    frequency: 1.2,
    linkCtr: 1,
    cpmCents: null,
    results,
    resultLabel: "Purchases",
    costPerResultCents: null,
    roas,
  };
}

function ad(id: string, over: Partial<AuditAd> = {}): AuditAd {
  return {
    id,
    name: `Ad ${id}`,
    adSetId: "as1",
    campaignId: "c1",
    status: "ACTIVE",
    createdTime: null,
    format: null,
    issue: null,
    performance: perf(10_000, 2),
    ...over,
  };
}

function snap(ads: AuditAd[], campaignName = "Generic campaign"): MetaAuditSnapshot {
  const base = demoMetaAuditSnapshot("act_1", "Demo");
  return {
    ...base,
    campaigns: [{ ...base.campaigns[0], id: "c1", name: campaignName }],
    adSets: [{ ...base.adSets[0], id: "as1", campaignId: "c1", name: "Generic ad set" }],
    ads,
  };
}

const barStools = cat({ id: "bar", name: "Bar Stools", landingPageUrl: "https://shop.example/collections/bar-stools" });
const tables = cat({ id: "tbl", name: "Dining Tables", landingPageUrl: "https://shop.example/collections/tables" });

describe("attributeSpendToCategories", () => {
  it("matches by url, ignoring query string", () => {
    const r = attributeSpendToCategories(
      snap([ad("a1", { linkUrl: "https://shop.example/collections/bar-stools?utm_source=fb" })]),
      [barStools, tables],
    );
    const bar = r.byCategory.find((c) => c.categoryId === "bar")!;
    expect(bar.adIds).toEqual(["a1"]);
    expect(bar.matchedBy).toBe("url");
    expect(bar.spendCents).toBe(10_000);
    expect(r.unmatched.adIds).toEqual([]);
  });

  it("longest url path wins", () => {
    const a = cat({ id: "s", name: "Stools", landingPageUrl: "https://shop.example/collections/stools" });
    const b = cat({ id: "sb", name: "Stools Bar", landingPageUrl: "https://shop.example/collections/stools/bar" });
    const r = attributeSpendToCategories(
      snap([ad("a1", { linkUrl: "https://shop.example/collections/stools/bar/" })]),
      [a, b],
    );
    expect(r.byCategory.find((c) => c.categoryId === "sb")!.adIds).toEqual(["a1"]);
    expect(r.byCategory.find((c) => c.categoryId === "s")!.adIds).toEqual([]);
  });

  it("matches urlPatterns by substring", () => {
    const c = cat({ id: "p", name: "Pendants", urlPatterns: ["/lighting/pendant"] });
    const r = attributeSpendToCategories(
      snap([ad("a1", { linkUrl: "https://shop.example/lighting/pendant-lamps" })]),
      [c],
    );
    expect(r.byCategory[0].adIds).toEqual(["a1"]);
  });

  it("matches by campaign name when there is no url", () => {
    const r = attributeSpendToCategories(snap([ad("a1")], "Bar Stools | Sales | Broad"), [barStools, tables]);
    const bar = r.byCategory.find((c) => c.categoryId === "bar")!;
    expect(bar.adIds).toEqual(["a1"]);
    expect(bar.matchedBy).toBe("name");
  });

  it("name matching is whole-word", () => {
    const c = cat({ id: "t", name: "Tab" });
    const r = attributeSpendToCategories(snap([ad("a1")], "Tablets sale"), [c]);
    expect(r.unmatched.adIds).toEqual(["a1"]);
  });

  it("reports mixed when both url and name matched", () => {
    const r = attributeSpendToCategories(
      snap([
        ad("a1", { linkUrl: "https://shop.example/collections/bar-stools" }),
        ad("a2", { name: "Bar Stools promo" }),
      ]),
      [barStools],
    );
    expect(r.byCategory[0].matchedBy).toBe("mixed");
    expect(r.byCategory[0].adIds).toEqual(["a1", "a2"]);
  });

  it("sends unmatched ads to unmatched and computes coverage", () => {
    const r = attributeSpendToCategories(
      snap([
        ad("a1", { linkUrl: "https://shop.example/collections/bar-stools", performance: perf(30_000, 2) }),
        ad("a2", { linkUrl: "https://other.example/x", performance: perf(10_000, 4) }),
      ]),
      [barStools],
    );
    expect(r.unmatched).toEqual({ spendCents: 10_000, adIds: ["a2"] });
    expect(r.coveragePct).toBe(75);
  });

  it("computes purchase value, roas and results", () => {
    const r = attributeSpendToCategories(
      snap([
        ad("a1", { linkUrl: "https://shop.example/collections/bar-stools", performance: perf(10_000, 3, 4) }),
        ad("a2", { linkUrl: "https://shop.example/collections/bar-stools", performance: perf(10_000, null, null) }),
      ]),
      [barStools],
    );
    const bar = r.byCategory[0];
    expect(bar.spendCents).toBe(20_000);
    expect(bar.purchaseValueCents).toBe(30_000);
    expect(bar.roas).toBe(1.5);
    expect(bar.results).toBe(4);
  });

  it("lists zero-spend categories with null roas, and coverage 0 with no spend", () => {
    const r = attributeSpendToCategories(snap([]), [barStools, tables]);
    expect(r.byCategory).toHaveLength(2);
    expect(r.byCategory.every((c) => c.spendCents === 0 && c.roas === null)).toBe(true);
    expect(r.coveragePct).toBe(0);
  });

  it("assigns ads with null performance at zero spend", () => {
    const r = attributeSpendToCategories(
      snap([ad("a1", { linkUrl: "https://shop.example/collections/bar-stools", performance: null })]),
      [barStools],
    );
    expect(r.byCategory[0].adIds).toEqual(["a1"]);
    expect(r.byCategory[0].spendCents).toBe(0);
  });
});

describe("categoriesFromServices", () => {
  it("keeps active services only and applies defaults", () => {
    const base = {
      client_id: "cl", description: null, created_at: "", updated_at: "",
    };
    const services: ClientService[] = [
      { ...base, id: "1", name: "A", keywords: null, landing_page_url: "https://a.example", is_active: true },
      { ...base, id: "2", name: "B", keywords: ["b"], landing_page_url: null, is_active: false },
      {
        ...base, id: "3", name: "C", keywords: ["c"], landing_page_url: null, is_active: true, priority: 2,
        gross_margin_pct: 40, average_order_value_cents: 5000, url_patterns: ["/c"],
      },
    ];
    const out = categoriesFromServices(services);
    expect(out.map((c) => c.id)).toEqual(["1", "3"]);
    expect(out[0]).toEqual({
      id: "1", name: "A", landingPageUrl: "https://a.example", urlPatterns: [], keywords: [],
      grossMarginPct: null, averageOrderValueCents: null, priority: 0,
    });
    expect(out[1]).toMatchObject({ priority: 2, grossMarginPct: 40, averageOrderValueCents: 5000, urlPatterns: ["/c"], keywords: ["c"] });
  });
});
