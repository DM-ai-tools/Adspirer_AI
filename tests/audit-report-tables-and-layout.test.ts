import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { creativeCopy, demoMetaAuditSnapshot, interestNames, type AuditAd, type AuditAdSet, type AuditCampaign, type MetaAuditSnapshot, type PeriodPerformance } from "@/lib/audit/meta-audit-data";
import {
  PERFORMANCE_TABLES_MARKER,
  adFormatOf,
  audienceSummary,
  audienceTypeOf,
  campaignProfile,
  insertPerformanceTables,
  landingTypeOf,
  messageOf,
  monthLabel,
  renderPerformanceTables,
} from "@/lib/audit/performance-tables";
import { stripChatOnlySections } from "@/lib/reports/prepare-export";
import { parseMarkdownToBlocks } from "@/lib/reports/parse-markdown";
import { presentBlocks } from "@/lib/reports/present";
import { exportReportPayload } from "@/lib/reports/export";
import { META_AUDIT_FRAMEWORK } from "@/lib/agent/meta-audit-framework";

// ------------------------------------------------------------------ a small sales account

const perf = (spend: number, lpv: number, atc: number, purch: number, ctr = 4, cpm = 33): PeriodPerformance => ({
  spendCents: spend * 100,
  impressions: Math.round((spend / cpm) * 1000),
  reach: 0,
  frequency: 1.5,
  linkCtr: ctr,
  cpmCents: cpm * 100,
  results: purch,
  resultLabel: "Purchases",
  costPerResultCents: purch ? Math.round((spend * 100) / purch) : null,
  roas: null,
  linkClicks: Math.round(((spend / cpm) * 1000 * ctr) / 100),
  landingPageViews: lpv,
  addToCart: atc,
  purchases: purch,
});

const base = demoMetaAuditSnapshot("act_1", "Shop");
const campaign = (id: string, name: string, p: PeriodPerformance, status = "ACTIVE", objective = "OUTCOME_SALES"): AuditCampaign => ({ ...base.campaigns[0]!, id, name, status, objective, performance: p });
const adSet = (id: string, campaignId: string, p: PeriodPerformance, o: Partial<AuditAdSet> = {}): AuditAdSet => ({
  ...base.adSets[0]!,
  id,
  name: id,
  campaignId,
  includedAudienceIds: [],
  interests: [],
  ageMin: 25,
  ageMax: 65,
  countries: ["AU"],
  productSetId: undefined,
  attributionWindows: ["7d_click", "1d_view"],
  performance: p,
  ...o,
});
const ad = (id: string, adSetId: string, campaignId: string, format: string, copy: string | null, link: string | null, p: PeriodPerformance): AuditAd => ({ ...base.ads[0]!, id, name: id, adSetId, campaignId, format, copy, linkUrl: link, performance: p });

const pBroad = perf(7000, 10000, 1000, 50);
const pWarm = perf(3000, 4000, 600, 15);
const pCat = perf(1800, 700, 75, 6, 1.7);

const shop = (over: Partial<MetaAuditSnapshot> = {}): MetaAuditSnapshot => ({
  ...base,
  account: { ...base.account, currency: "AUD" },
  period: { days: 82, since: "2026-04-01", until: "2026-06-21" },
  audiences: [
    { id: "aud_site", name: "Site visitors 180d", subtype: "WEBSITE", sizeLower: 9000, ready: true, problem: null },
    { id: "aud_lal", name: "Buyers 1% LAL", subtype: "LOOKALIKE", sizeLower: 900000, ready: true, problem: null },
  ],
  campaigns: [campaign("c1", "TR | Prospecting", pBroad), campaign("c2", "TR | Warm", pWarm, "PAUSED"), campaign("c3", "TR | RTG Catalogue", pCat, "PAUSED")],
  adSets: [adSet("s1", "c1", pBroad), adSet("s2", "c2", pWarm, { includedAudienceIds: ["aud_site"] }), adSet("s3", "c3", pCat, { includedAudienceIds: ["aud_site"], productSetId: "ps1" })],
  ads: [
    ad("a1", "s1", "c1", "VIDEO", "Art for your walls.", "https://shop.test/products/blue", perf(3000, 4000, 520, 25)),
    ad("a2", "s1", "c1", "PHOTO", "Spring sale: 20% off prints", "https://shop.test/collections/sale", perf(4000, 6000, 480, 25)),
    ad("a3", "s2", "c2", "PHOTO", "Still thinking about it?", "https://shop.test/products/dune", pWarm),
    ad("a4", "s3", "c3", "SHARE", null, null, pCat),
  ],
  totals: perf(11800, 14700, 1675, 71),
  monthly: [
    { month: "2026-04", campaignId: "c1", performance: perf(2000, 3000, 330, 15) },
    { month: "2026-05", campaignId: "c1", performance: perf(3000, 4000, 380, 20) },
    { month: "2026-06", campaignId: "c1", performance: perf(2000, 3000, 290, 15) },
    { month: "2026-04", campaignId: "c2", performance: perf(1000, 1300, 200, 5) },
    { month: "2026-05", campaignId: "c2", performance: perf(2000, 2700, 400, 10) },
  ],
  placementPositions: [
    { platform: "facebook", position: "feed", performance: perf(8000, 9000, 1200, 50) },
    { platform: "instagram", position: "instagram_stories", performance: perf(3800, 5700, 475, 21) },
  ],
  demographics: [
    { age: "25-34", gender: "female", performance: perf(5000, 6000, 800, 30) },
    { age: "35-44", gender: "male", performance: perf(6800, 8700, 875, 41) },
  ],
  ...over,
});

// ------------------------------------------------------------------ the data read from Meta

describe("what is read from Meta for the tables", () => {
  it("reads interests and behaviours from detailed targeting", () => {
    expect(interestNames({ flexible_spec: [{ interests: [{ id: "1", name: "Home décor" }], behaviors: [{ id: "2", name: "Engaged shoppers" }] }], interests: [{ id: "3", name: "Interior design" }] })).toEqual(["Interior design", "Home décor", "Engaged shoppers"]);
    expect(interestNames({})).toEqual([]);
  });

  it("reads an ad's own words from its post or its flexible creative", () => {
    expect(creativeCopy({ object_story_spec: { link_data: { message: "20% off this week", name: "Shop prints" } } })).toBe("20% off this week | Shop prints");
    expect(creativeCopy({ asset_feed_spec: { bodies: [{ text: "Free shipping" }], titles: [{ text: "New art" }] } })).toBe("Free shipping | New art");
    expect(creativeCopy({})).toBeNull();
  });
});

// ------------------------------------------------------------------ classification

describe("grouping rules", () => {
  const audiences = new Map(shop().audiences.map((a) => [a.id, a]));

  it("names an ad set's audience type from its settings, never its name", () => {
    const named = (o: Partial<AuditAdSet>) => audienceTypeOf(adSet("x", "c", pBroad, { name: "RETARGETING best", ...o }), audiences);
    expect(named({})).toBe("Broad");
    expect(named({ interests: ["Home décor"] })).toBe("Interest");
    expect(named({ includedAudienceIds: ["aud_lal"] })).toBe("Lookalike");
    expect(named({ includedAudienceIds: ["aud_site"] })).toBe("Retargeting");
    expect(named({ productSetId: "ps", includedAudienceIds: ["aud_site"] })).toBe("Catalogue retargeting");
    expect(named({ productSetId: "ps" })).toBe("Catalogue prospecting");
  });

  it("describes who an ad set reaches in a few words", () => {
    expect(audienceSummary(adSet("x", "c", pBroad), audiences)).toBe("Broad, AU 25-65");
    expect(audienceSummary(adSet("x", "c", pBroad, { interests: ["Home décor", "Interior design", "Art"] }), audiences)).toBe("Interests: Home décor +2");
    expect(audienceSummary(adSet("x", "c", pBroad, { includedAudienceIds: ["aud_site"] }), audiences)).toBe("Site visitors 180d");
  });

  it("gives a campaign the type of the ad sets that hold its spend", () => {
    const s = shop();
    expect(campaignProfile(s.campaigns[0]!, s.adSets, audiences)).toEqual({ type: "Prospecting", audience: "Broad, AU 25-65" });
    expect(campaignProfile(s.campaigns[2]!, s.adSets, audiences).type).toBe("Catalogue retargeting");
  });

  it("tells an offer message from a product message, and says when Meta returned no copy", () => {
    expect(messageOf({ copy: "Spring sale: 20% off prints" })).toBe("Offer / sale message");
    expect(messageOf({ copy: "Free shipping on every order" })).toBe("Offer / sale message");
    expect(messageOf({ copy: "Art for your walls." })).toBe("No offer (product / lifestyle)");
    expect(messageOf({ copy: null })).toBe("Copy not returned by Meta");
  });

  it("names formats and landing pages as a buyer would", () => {
    const s = shop();
    const byId = new Map(s.adSets.map((a) => [a.id, a]));
    expect(adFormatOf(s.ads[3]!, byId)).toBe("Catalogue / collection ad");
    expect(adFormatOf(s.ads[1]!, byId)).toBe("Static image");
    expect(landingTypeOf("https://shop.test/products/x")).toBe("Product page (PDP)");
    expect(landingTypeOf("https://shop.test/collections/sale")).toBe("Collection page (PLP)");
    expect(landingTypeOf(null)).toBe("Link not returned by Meta");
  });

  it("labels a month the period covers only in part", () => {
    expect(monthLabel("2026-04", "2026-04-01", "2026-06-21")).toBe("Apr 2026");
    expect(monthLabel("2026-06", "2026-04-01", "2026-06-21")).toBe("Jun 2026 (1-21)");
    expect(monthLabel("2025-10", "2025-10-05", "2026-01-31")).toBe("Oct 2025 (5-31)");
  });
});

// ------------------------------------------------------------------ the tables

/** The cells after the label of the row that starts with `first`. */
const rowOf = (md: string, first: string) => md.split("\n").find((l) => l.startsWith(`| ${first} |`))!.split("|").map((c) => c.trim()).slice(2, -1);

describe("the performance tables", () => {
  const md = renderPerformanceTables(shop());

  it("has every section the reference report has, in order", () => {
    const order = ["### Sales campaigns month by month", "### Campaigns by type", "### Audience types", "### Ad formats", "### Offer vs no offer", "### Landing page type", "### Placements", "### Age", "### Gender"];
    const at = order.map((h) => md.indexOf(h));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("adds up the month rows from Meta's own monthly figures, with a total", () => {
    expect(rowOf(md, "Apr 2026")).toEqual(["2", "3,000", "33.00", "4,300", "530", "5.66", "12.3%", "20"]);
    expect(rowOf(md, "Jun 2026 (1-21)").slice(0, 2)).toEqual(["1", "2,000"]);
    expect(rowOf(md, "**Total**").slice(0, 2)).toEqual(["**2**", "**10,000**"]);
  });

  it("lists each campaign with its type, audience and status, keeping the | in its name", () => {
    expect(md).toContain("| TR \\| Prospecting | Prospecting | Broad, AU 25-65 | Active | 7,000 |");
    expect(md).toContain("| TR \\| RTG Catalogue | Catalogue retargeting | Site visitors 180d | Paused | 1,800 |");
  });

  it("works out cost per add to cart, ATC rate and share from the summed rows", () => {
    const warm = rowOf(md, "Retargeting");
    // ads, spend, share, link CTR, LPV, ATC, cost / ATC, ATC rate, purchases
    expect(warm).toEqual(["1", "3,000", "25.4%", "4.0%", "4,000", "600", "5.00", "15.0%", "15"]);
  });

  it("gives each table one computed read, and never calls a group with no link or copy the best or worst", () => {
    expect(md).toMatch(/\*Read: Broad takes 59\.3% of spend; lowest cost per add to cart: Retargeting at AUD 5\.00 \(overall AUD 7\.04\); highest: Catalogue retargeting at AUD 24\.00\.\*/);
    const landing = md.slice(md.indexOf("### Landing page type"), md.indexOf("### Placements"));
    expect(landing).not.toMatch(/(lowest|highest)[^;]*Link not returned/);
  });

  it("says when groups are too small to compare", () => {
    const small = renderPerformanceTables(shop({ ads: shop().ads.map((a) => ({ ...a, performance: { ...a.performance!, addToCart: 3 } })) }));
    expect(small).toMatch(/too few formats with 20\+ add to carts to compare costs reliably/);
  });

  it("explains what reported purchases are, with the attribution window", () => {
    expect(md).toMatch(/Reported purchases: as Meta reports them \(7-day click \+ 1-day view attribution\), Meta's own claim and not verified sales/);
  });

  it("leaves out the month table for a one-month audit and a split with only one group", () => {
    const one = renderPerformanceTables(shop({ monthly: undefined, ads: shop().ads.map((a) => ({ ...a, linkUrl: "https://shop.test/products/x" })) }));
    expect(one).not.toContain("month by month");
    expect(one).not.toContain("### Landing page type");
  });

  it("uses results and cost per result for an account with no funnel figures at all", () => {
    const bare = (p: PeriodPerformance | null): PeriodPerformance | null => (p ? { ...p, addToCart: null, purchases: null, landingPageViews: null, results: 20 } : p);
    const s = shop();
    const out = renderPerformanceTables({
      ...s,
      totals: bare(s.totals),
      campaigns: s.campaigns.map((c) => ({ ...c, performance: bare(c.performance) })),
      adSets: s.adSets.map((a) => ({ ...a, performance: bare(a.performance) })),
      ads: s.ads.map((a) => ({ ...a, performance: bare(a.performance) })),
      monthly: s.monthly?.map((m) => ({ ...m, performance: bare(m.performance)! })),
    });
    expect(out).toMatch(/\| Format \| Ads \| Spend \(AUD\) \| Share \| Link CTR \| Results \| Cost \/ result \(AUD\) \|/);
    expect(out).not.toContain("Reported purchases");
  });

  it("shows every funnel a messaging and lead account has: conversations, leads and the odd purchase", () => {
    const chat = (spend: number, leads: number, convs: number, purchases = 0): PeriodPerformance => ({
      ...perf(spend, 0, 0, purchases, 2, 25),
      landingPageViews: null,
      addToCart: null,
      purchases: purchases || null,
      leads,
      messagingConversations: convs,
      results: convs,
      resultLabel: "Messaging conversations started",
    });
    const s = shop();
    const sales = chat(300, 0, 0, 2);
    const msgs = chat(4000, 38, 495);
    const store = chat(2400, 24, 329);
    const out = renderPerformanceTables({
      ...s,
      totals: chat(6700, 62, 824, 2),
      campaigns: [
        { ...s.campaigns[0]!, id: "m1", name: "TR | Messages x Sleepless III", objective: "OUTCOME_ENGAGEMENT", performance: msgs },
        { ...s.campaigns[0]!, id: "m2", name: "TR | Store Ad | Messages", objective: "OUTCOME_ENGAGEMENT", performance: store },
        { ...s.campaigns[0]!, id: "m3", name: "TR | EOFY Sales", objective: "OUTCOME_SALES", performance: sales },
      ],
      adSets: [
        { ...s.adSets[0]!, id: "x1", campaignId: "m1", performance: msgs },
        { ...s.adSets[1]!, id: "x2", campaignId: "m2", performance: store },
        { ...s.adSets[0]!, id: "x3", campaignId: "m3", performance: sales },
      ],
      ads: [
        { ...s.ads[0]!, id: "y1", adSetId: "x1", campaignId: "m1", linkUrl: null, copy: "Send us a message", performance: msgs },
        { ...s.ads[1]!, id: "y2", adSetId: "x2", campaignId: "m2", linkUrl: null, copy: "Visit our store", performance: store },
        { ...s.ads[1]!, id: "y3", adSetId: "x3", campaignId: "m3", linkUrl: "https://shop.test/collections/sale?utm_source=fb", copy: "Save up to 60% off", performance: sales },
      ],
      monthly: [
        { month: "2026-09", campaignId: "m1", performance: chat(2000, 20, 250) },
        { month: "2026-10", campaignId: "m1", performance: chat(2000, 18, 245) },
        { month: "2026-09", campaignId: "m3", performance: sales },
      ],
    });
    const head = out.split("\n").find((l) => l.startsWith("| Campaign |"))!;
    expect(head).toContain("| Reported purchases* | Cost / purchase (AUD) | Leads | Cost / lead (AUD) | Conversations | Cost / conversation (AUD) |");
    expect(head).not.toMatch(/Add to carts|Landing-page views/);
    // The one small sales test does not stand in for the whole account month by month.
    expect(out).toContain("### Campaigns month by month");
    expect(out).toMatch(/\| Sep 2026 \| 2 \|/);
    expect(out).toMatch(/cost per messaging conversation/);
  });

  it("goes where the writer left the marker, or under the heading, or before Risks", () => {
    expect(insertPerformanceTables(`## 3. Performance Breakdown\n${PERFORMANCE_TABLES_MARKER}\n### Summary`, "TABLES")).toBe("## 3. Performance Breakdown\nTABLES\n### Summary");
    expect(insertPerformanceTables("## 3. Performance Breakdown\n### Summary", "TABLES")).toMatch(/Performance Breakdown\n\nTABLES\n\n### Summary/);
    expect(insertPerformanceTables("## 1. Executive Summary\n## 7. Risks & Issues", "TABLES")).toMatch(/## Performance Breakdown\n\nTABLES\n\n## 7\. Risks/);
    expect(insertPerformanceTables(`A\n${PERFORMANCE_TABLES_MARKER}\nB`, "")).toBe("A\n\nB");
  });

  it("is what the writer is told to leave to the application", () => {
    expect(META_AUDIT_FRAMEWORK).toContain(PERFORMANCE_TABLES_MARKER);
    expect(META_AUDIT_FRAMEWORK).toMatch(/Recommended Meta Structure/);
    expect(META_AUDIT_FRAMEWORK).toMatch(/\| Layer \| Campaign \| Audience \| Budget share \| Daily budget \| Creative focus \|/);
  });
});

// ------------------------------------------------------------------ downloads

const AUDIT = `# Meta Ads Account Audit — Shop

## 1. Executive Summary
- **Score 64/100**

## 2. Account Snapshot
| Metric | Value |
|---|---|
| Spend | A$11,800 |
| Add to cart | 1,675 |
| Cost per add to cart | A$7.04 |

**12 May 2026 — Budget cut: TR | Prospecting** (campaign)
- **Who:** Jane
- **Verdict:** Wrong call — cost per ATC rose 39%.

## 3. Performance Breakdown
${renderPerformanceTables(shop())}

## 7. Risks & Issues
### R1 · 🔴 Critical — Catalogue retargeting costs 3× the account
- **Evidence:** A$24.00 per ATC vs A$7.04.
- **Fix:** fold it into warm retargeting.
- **Spend at stake:** A$1,800.

## 9. Prioritised Recommendations
### 1. Fold catalogue retargeting into warm (fixes R1)
- **Expected impact:** ~A$1,200 a quarter.
- **Effort:** Low · **When:** Week 1

---

## Audit checklist

C (64/100) from 31 checkpoints.

### Scores by area
| Area | Score |
|---|---|
| Tracking | 90/100 |

### Tracking — 90/100
| ID | Checkpoint |
|---|---|
| T1 | Pixel fires |
`;

describe("downloaded reports", () => {
  it("leave out the audit checklist and everything under it, and keep the rest", () => {
    const out = stripChatOnlySections(AUDIT);
    expect(out).not.toMatch(/Audit checklist|Scores by area|Pixel fires/);
    expect(out).toContain("### 1. Fold catalogue retargeting into warm (fixes R1)");
    expect(out.trimEnd().endsWith("- **Effort:** Low · **When:** Week 1")).toBe(true);
    // A section after the checklist survives.
    expect(stripChatOnlySections(`${AUDIT}\n## Optimize\n- item`)).toContain("## Optimize");
  });

  it("leave it out of every format: Markdown, Word, PDF and Excel", async () => {
    for (const format of ["md", "docx", "xlsx", "pdf"] as const) {
      const r = await exportReportPayload({ format, title: "Audit", content: AUDIT });
      let text: string;
      if (format === "md") text = r.body as string;
      else if (format === "pdf") text = Buffer.from(r.body as Uint8Array).toString("latin1");
      else {
        const zip = await JSZip.loadAsync(r.body as Uint8Array);
        const files = await Promise.all(Object.values(zip.files).filter((f) => f.name.endsWith(".xml")).map((f) => f.async("string")));
        text = files.join("\n");
      }
      if (format !== "pdf") {
        expect(text, format).not.toMatch(/Audit checklist|Scores by area/);
        expect(text, format).toMatch(/Performance Breakdown/i);
      }
      expect(r.body.length, format).toBeGreaterThan(500);
    }
  }, 60_000);

  it("print key figures as tiles, risks, actions and changes as cards, reads as highlights and totals as totals", () => {
    const blocks = presentBlocks(parseMarkdownToBlocks(stripChatOnlySections(AUDIT)));
    const kpis = blocks.find((b) => b.type === "kpis");
    expect(kpis).toEqual({ type: "kpis", items: [{ label: "Spend", value: "A$11,800" }, { label: "Add to cart", value: "1,675" }, { label: "Cost per add to cart", value: "A$7.04" }] });
    const cards = blocks.filter((b) => b.type === "card");
    expect(cards.map((c) => c.type === "card" && [c.tone, c.tag, c.title])).toEqual([
      ["negative", null, "12 May 2026 — Budget cut: TR | Prospecting (campaign)"],
      ["critical", "R1 · Critical", "Catalogue retargeting costs 3× the account"],
      ["action", "1", "Fold catalogue retargeting into warm (fixes R1)"],
    ]);
    const action = cards[2];
    expect(action?.type === "card" && action.fields.map((f) => [f.label, f.value.map((s) => s.text).join("")])).toEqual([
      ["Expected impact", "~A$1,200 a quarter."],
      ["Effort", "Low"],
      ["When", "Week 1"],
    ]);
    expect(blocks.filter((b) => b.type === "note" && b.kind === "read").length).toBeGreaterThanOrEqual(8);
    const month = blocks.find((b) => b.type === "table" && b.headers[0] === "Month");
    expect(month?.type === "table" && month.strongRows).toEqual([3]);
  });
});
