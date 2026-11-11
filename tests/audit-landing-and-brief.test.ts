import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demoMetaAuditSnapshot, type AuditAd, type MetaAuditSnapshot, type PeriodPerformance } from "@/lib/audit/meta-audit-data";
import {
  LANDING_PAGE_TABLES_MARKER,
  NO_WEBSITE_LINK,
  insertLandingPageTables,
  landingPageGroups,
  landingTargets,
  pageKey,
  pageLabel,
  renderLandingPageTables,
  type LandingCheck,
} from "@/lib/audit/performance-tables";
import { parseDateRangeFromText, resolveAuditBrief } from "@/lib/agent/audit-brief";
import { auditBriefQuestion } from "@/lib/agent/adspirer-agent";
import { META_AUDIT_FRAMEWORK } from "@/lib/agent/meta-audit-framework";

const perf = (spend: number, lpv: number, atc: number, purch: number, ctr = 4): PeriodPerformance => ({
  spendCents: spend * 100,
  impressions: spend * 30,
  reach: 0,
  frequency: 1.5,
  linkCtr: ctr,
  cpmCents: 3300,
  results: purch,
  resultLabel: "Purchases",
  costPerResultCents: null,
  roas: null,
  linkClicks: Math.round((spend * 30 * ctr) / 100),
  landingPageViews: lpv,
  addToCart: atc,
  purchases: purch,
});

const base = demoMetaAuditSnapshot("act_1", "Shop");
const ad = (id: string, link: string | null, p: PeriodPerformance | null, copy: string | null = null): AuditAd => ({ ...base.ads[0]!, id, name: id, linkUrl: link, copy, performance: p });

const snap = (ads: AuditAd[]): MetaAuditSnapshot => ({ ...base, account: { ...base.account, currency: "AUD" }, ads, totals: perf(10000, 12000, 1500, 60) });

const ADS = [
  ad("a1", "https://www.shop.test/products/blue-hour?utm_source=facebook&fbclid=x", perf(3000, 4000, 600, 25), "Blue Hour print, free framing"),
  ad("a2", "https://shop.test/products/blue-hour/", perf(1000, 1500, 200, 8)),
  ad("a3", "https://shop.test/collections/sale", perf(4000, 5000, 500, 20), "Spring sale: 20% off"),
  ad("a4", null, perf(2000, 1500, 200, 7)),
  ad("a5", "https://shop.test/collections/never-spent", null),
];

// ------------------------------------------------------------------ landing pages

describe("the landing pages in the audited period", () => {
  it("treats a page with or without tracking parameters, www or a trailing slash as one page", () => {
    expect(pageKey("https://www.Shop.test/products/blue-hour/?utm_source=fb")).toBe("shop.test/products/blue-hour");
    expect(pageKey("https://shop.test/")).toBe("shop.test");
    expect(pageKey(null)).toBeNull();
    expect(pageKey("not a url")).toBeNull();
    expect(pageLabel("shop.test/collections/a-very-long-collection-name-that-goes-on-and-on/and-on")).toMatch(/…/);
  });

  it("lists every page that took spend, with its numbers, and the spend that had no website link", () => {
    const groups = landingPageGroups(snap(ADS));
    expect(groups.map((g) => [g.label, g.count, g.spendCents / 100])).toEqual([
      ["shop.test/products/blue-hour", 2, 4000],
      ["shop.test/collections/sale", 1, 4000],
      [NO_WEBSITE_LINK, 1, 2000],
    ]);
    const md = renderLandingPageTables(snap(ADS));
    expect(md).toContain("### Landing pages in this period");
    expect(md).toMatch(/\| shop\.test\/products\/blue-hour \| 2 \| 4,000 \| 40\.0% \| 4\.0% \| 5,500 \| 800 \| 5\.00 \| 14\.5% \| 33 \|/);
    expect(md).toMatch(/\*Read: 2 landing pages took spend; 20\.0% of ad spend went to ads with no website link/);
    // A page whose ads didn't spend is not a landing page of this period.
    expect(md).not.toContain("never-spent");
  });

  it("adds the checks for each analysed page, in spend order, and names the pages left unchecked", () => {
    const checks: LandingCheck[] = [
      { url: "https://shop.test/collections/sale", role: "own", score100: 75, messageMatch: "partial", checks: { httpStatus: 200, reachable: true, mobileLcpMs: 3400, pageSpeed: 48, formFields: 11, metaPixel: false, keepsTracking: true, trust: true, cta: true } },
      { url: "https://competitor.test/", role: "competitor", score100: 82, messageMatch: "unknown", checks: { httpStatus: 200, reachable: true, mobileLcpMs: 2100, pageSpeed: 70, formFields: 3, metaPixel: true, keepsTracking: true, trust: true, cta: true } },
    ];
    const md = renderLandingPageTables(snap(ADS), checks);
    expect(md).toContain("| Page | Score | Message match | Mobile LCP | PageSpeed | Form fields | Meta pixel | UTMs kept | Trust | CTA |");
    expect(md).toContain("| shop.test/collections/sale | 75/100 | Partial | 3.4 s | 48/100 | 11 | Not found | Yes | Yes | Yes |");
    expect(md).toMatch(/Not analysed \(lower spend\): shop\.test\/products\/blue-hour/);
    expect(md).toContain("### Competitor pages");
  });

  it("says a page that would not load scored zero, with its error", () => {
    const md = renderLandingPageTables(snap(ADS), [{ url: "https://shop.test/collections/sale", role: "own", score100: 0, messageMatch: "unknown", checks: { httpStatus: 404, reachable: false, mobileLcpMs: null, pageSpeed: null, formFields: null, metaPixel: null, keepsTracking: null, trust: false, cta: false } }]);
    expect(md).toContain("| shop.test/collections/sale | 0 (HTTP 404) |");
  });

  it("picks the pages to analyse by spend, with the ad's own words for the message-match check", () => {
    const targets = landingTargets(snap(ADS), 8);
    expect(targets.map((t) => t.key)).toEqual(["shop.test/products/blue-hour", "shop.test/collections/sale"]);
    expect(targets[0]!.adContext).toBe("Blue Hour print, free framing");
    expect(landingTargets(snap(ADS), 1)).toHaveLength(1);
  });

  it("goes where the writer left the marker, or under the Landing Pages heading, or before Risks", () => {
    expect(insertLandingPageTables(`## 6. Landing Pages\n${LANDING_PAGE_TABLES_MARKER}\n- **page** — fix`, "T")).toBe("## 6. Landing Pages\nT\n- **page** — fix");
    expect(insertLandingPageTables("## 6. Landing Pages\n- x", "T")).toMatch(/## 6\. Landing Pages\n\nT\n\n- x/);
    expect(insertLandingPageTables("## 7. Risks & Issues", "T")).toMatch(/## Landing Pages\n\nT\n\n## 7\. Risks/);
  });

  it("is what the writer is told to leave to the application", () => {
    expect(META_AUDIT_FRAMEWORK).toContain(LANDING_PAGE_TABLES_MARKER);
    expect(META_AUDIT_FRAMEWORK).toMatch(/every landing page that took spend in the period/);
  });
});

// ------------------------------------------------------------------ dates

describe("the date ranges people actually type", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-11T07:03:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  const range = (text: string) => {
    const r = parseDateRangeFromText(text);
    return r && [r.dateStart, r.dateStop, r.dateLabel];
  };

  it("reads months, weeks and days, in digits or words", () => {
    expect(range("Give me an audit of the account for the last 2 months")).toEqual(["2026-09-12", "2026-11-11", "last 2 months"]);
    expect(range("for the last one month")).toEqual(["2026-10-12", "2026-11-11", "last 1 month"]);
    expect(range("past two months")).toEqual(["2026-09-12", "2026-11-11", "last 2 months"]);
    expect(range("previous 3 months")).toEqual(["2026-08-12", "2026-11-11", "last 3 months"]);
    expect(range("last 6 weeks")).toEqual(["2026-10-01", "2026-11-11", "last 6 weeks"]);
    expect(range("the last fortnight")).toEqual(["2026-10-29", "2026-11-11", "last 14 days"]);
    expect(range("last 45 days")).toEqual(["2026-09-28", "2026-11-11", "last 45 days"]);
  });

  it("keeps what already worked", () => {
    expect(range("last 30 days")).toEqual(["2026-10-13", "2026-11-11", "last 30 days"]);
    expect(range("last month")).toEqual(["2026-10-01", "2026-10-31", "1 Oct 2026 – 31 Oct 2026"]);
    expect(range("last week")).toEqual(["2026-11-05", "2026-11-11", "last 7 days"]);
    expect(range("from 1st sept to 15th sept")).toEqual(["2026-09-01", "2026-09-15", "1 Sept 2026 – 15 Sept 2026"]);
  });

  it("reads a span of months", () => {
    expect(range("from August to October")).toEqual(["2026-08-01", "2026-10-31", "1 Aug 2026 – 31 Oct 2026"]);
    expect(range("Nov 2025 to Jan 2026")).toEqual(["2025-11-01", "2026-01-31", "1 Nov 2025 – 31 Jan 2026"]);
    expect(range("sept - nov")?.slice(0, 2)).toEqual(["2026-09-01", "2026-11-11"]);
  });

  it("makes the request that failed ready for a full audit of the account", () => {
    const brief = resolveAuditBrief("Give me an audit of the account for the last 2 months", []);
    expect(brief).toMatchObject({ scope: "account", ready: true, missing: [] });
    // "past 2 months" is a period, not a campaign called "past 2 months".
    expect(resolveAuditBrief("audit for the past 2 months", []).campaignHints).toEqual([]);
  });
});

// ------------------------------------------------------------------ an incomplete brief

describe("an audit whose scope or dates can't be read", () => {
  it("gets the clarifying question word for word, and no audit written from partial evidence", () => {
    const evidence = [
      "### Campaigns",
      "- TR | Messages",
      "### Audit briefing incomplete",
      "Ask ONLY for the missing fields below.",
      "<!-- audit-brief-question -->",
      "I can run a **Meta Ads best-practice audit** — I just need:",
      "1. **Date range** — e.g. last 7 days",
      "<!-- /audit-brief-question -->",
    ].join("\n");
    expect(auditBriefQuestion({ toolEvidence: evidence })).toBe("I can run a **Meta Ads best-practice audit** — I just need:\n1. **Date range** — e.g. last 7 days");
    expect(auditBriefQuestion({ toolEvidence: "### Audit brief (confirmed)\n- Period: last 2 months" })).toBeNull();
    expect(auditBriefQuestion({ toolEvidence: evidence, reportDraft: "# Report" })).toBeNull();
  });
});
