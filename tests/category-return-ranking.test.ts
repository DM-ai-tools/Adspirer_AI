import { describe, expect, it } from "vitest";
import { completedDaysRange } from "@/lib/agent/audit-brief";
import { asksForReturnOnSpend } from "@/lib/strategy/categories";
import type { CategoryAttribution } from "@/lib/strategy/category-attribution";
import type { CategoryChannels, ChannelFigures, ChannelPerformance } from "@/lib/strategy/channels";
import { renderCategorySpendEvidence } from "@/lib/strategy/render";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return iso(d);
};

describe("completedDaysRange", () => {
  it("ends 'last N days' yesterday, so today's part day is never in the window", () => {
    expect(completedDaysRange("top categories for the last 3 days")).toMatchObject({
      dateStart: daysAgo(3),
      dateStop: daysAgo(1),
      days: 3,
    });
  });
  it("defaults to the last 30 whole days", () => {
    expect(completedDaysRange("spend by category")).toMatchObject({ dateStart: daysAgo(30), dateStop: daysAgo(1), days: 30 });
  });
  it("keeps an explicit 'yesterday' as it is", () => {
    expect(completedDaysRange("what did we spend yesterday")).toMatchObject({ dateStart: daysAgo(1), dateStop: daysAgo(1), days: 1 });
  });
});

describe("asksForReturnOnSpend", () => {
  it.each([
    "give me the top category by sales with redpect to the spend for the last 3 days",
    "which category has the best ROAS",
    "best return on ad spend by category",
    "most efficient categories",
    "sales relative to spend",
  ])("is true for %s", (q) => expect(asksForReturnOnSpend(q)).toBe(true));
  it.each(["top 10 categories by sales", "how much did we spend on sheds"])("is false for %s", (q) =>
    expect(asksForReturnOnSpend(q)).toBe(false));
});

const figures = (spendCents: number, ga4: number | null): ChannelFigures => ({
  spendCents, platformRevenueCents: 0, ga4RevenueCents: ga4, roas: null, basis: ga4 === null ? "none" : "ga4",
});
const row = (id: string, metaSpend: number, googleSpend: number, metaGa4: number, googleGa4: number, total: number): CategoryChannels => ({
  categoryId: id,
  meta: figures(metaSpend, metaGa4),
  google: figures(googleSpend, googleGa4),
  ga4TotalRevenueCents: total,
  searchImpressions: 0, searchClicks: 0, topQueries: [],
});

describe("renderCategorySpendEvidence: ranking by return on spend", () => {
  const categories = [
    { id: "big", name: "Big Seller" },     // most revenue, weak return
    { id: "eff", name: "Efficient" },      // best return on real spend
    { id: "tiny", name: "Tiny Spend" },    // huge ratio on a few cents
    { id: "none", name: "No Spend" },
  ];
  const attribution: CategoryAttribution = {
    byCategory: categories.map((c) => ({ categoryId: c.id, spendCents: 0, purchaseValueCents: 0, roas: null, results: 0, adIds: [], matchedBy: "url" as const })),
    unmatched: { spendCents: 0, adIds: [] },
    coveragePct: 100,
  };
  const channels: ChannelPerformance = {
    byCategory: [
      row("big", 100_000, 100_000, 150_000, 150_000, 400_000),   // 3,000 rev / 2,000 spend = 1.5x
      row("eff", 20_000, 10_000, 100_000, 50_000, 200_000),      // 1,500 / 300 = 5x
      row("tiny", 10, 0, 90_000, 0, 90_000),                     // 900 / 0.10 = 9,000x
      row("none", 0, 0, 0, 0, 80_000),
    ],
    ga4Method: "item", ga4Available: true, googleAdsMapped: true, googleAdsLoaded: true,
    currencyMismatch: null, googleUnmatchedSpendCents: 0, ga4UnmatchedRevenueCents: 0,
    metaVsGa4: null, ads: null, warnings: [],
  };
  const opts = { currency: "AUD", categoryWord: "category" as const, periodDays: 3, accountSpendCents: null, channels };
  const order = (text: string) =>
    text.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Category") && !l.startsWith("| ---")).map((l) => l.split("|")[1]!.trim());

  it("by default ranks by revenue", () => {
    expect(order(renderCategorySpendEvidence(attribution, categories, opts))[0]).toBe("Big Seller");
  });

  it("with rankBy return puts the best return on real spend first and parks tiny or no spend after", () => {
    const text = renderCategorySpendEvidence(attribution, categories, { ...opts, rankBy: "return" });
    expect(order(text)).toEqual(["Efficient", "Big Seller", "Tiny Spend", "No Spend"]);
    expect(text).toContain("Ranked by: return on spend");
    expect(text).toMatch(/Tiny Spend.*too small/);
  });

  it("states the dates when a period is given", () => {
    const text = renderCategorySpendEvidence(attribution, categories, {
      ...opts, rankBy: "return", period: { since: "2026-10-19", until: "2026-10-21" },
    });
    expect(text).toContain("Period: 2026-10-19 → 2026-10-21 (3 days");
  });
});
