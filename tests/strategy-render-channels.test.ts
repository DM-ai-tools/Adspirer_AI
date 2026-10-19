import { describe, expect, it } from "vitest";
import {
  DEMO_CLICKTRENDS_META_ACCOUNT_ID,
  demoMetaAuditSnapshot,
  type AuditAd,
  type MetaAuditSnapshot,
  type PeriodPerformance,
} from "@/lib/audit/meta-audit-data";
import { resolveGoals } from "@/lib/clients/goals";
import { getDemoStore } from "@/lib/demo/store";
import { loadChannelSnapshot } from "@/lib/google/snapshot";
import type { ChannelSnapshot } from "@/lib/google/types";
import { STRATEGY_FRAMEWORK } from "@/lib/agent/strategy-framework";
import { categoriesFromServices, type StrategyCategory } from "@/lib/strategy/categories";
import { attributeSpendToCategories } from "@/lib/strategy/category-attribution";
import { buildChannelPerformance, type CategoryChannels, type ChannelPerformance } from "@/lib/strategy/channels";
import { buildStrategyPlan, type StrategyBrief } from "@/lib/strategy/plan";
import { renderCategorySpendEvidence, renderStrategyEvidence } from "@/lib/strategy/render";

const LABEL = "Google budget is a recommendation for the Google Ads account — this tool doesn't change Google.";
const RECONNECT = "Google needs reconnecting — an admin can reconnect under Connections";
const range = { since: "2026-09-19", until: "2026-10-18" };

function cat(name: string, over: Partial<StrategyCategory> = {}): StrategyCategory {
  return {
    id: name.toLowerCase(),
    name,
    landingPageUrl: null,
    urlPatterns: [],
    keywords: [],
    grossMarginPct: null,
    averageOrderValueCents: null,
    priority: 0,
    ...over,
  };
}

function perf(spendCents: number, roas: number | null): PeriodPerformance {
  return {
    spendCents,
    impressions: 1000,
    reach: 800,
    frequency: 1.2,
    linkCtr: 1,
    cpmCents: null,
    results: 1,
    resultLabel: "Purchases",
    costPerResultCents: null,
    roas,
  };
}

function ad(name: string, spendCents: number, roas: number | null): AuditAd {
  return {
    id: `ad_${name.toLowerCase()}`,
    name: `${name} ad`,
    adSetId: "as_1",
    campaignId: "demo_campaign_1",
    status: "ACTIVE",
    createdTime: null,
    format: null,
    issue: null,
    performance: perf(spendCents, roas),
  };
}

function snap(ads: AuditAd[], totals: PeriodPerformance | null = perf(100_000, 2)): MetaAuditSnapshot {
  return { ...demoMetaAuditSnapshot("act_1", "Demo", 30), totals, ads };
}

/** Text of one evidence section, from its heading to the next `### `. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = text.indexOf("\n### ", start + heading.length);
  return text.slice(start, next < 0 ? undefined : next);
}

/** ClickTrends from the demo store and the mock Google provider; `google` edits the channel snapshot. */
async function clickTrends(
  opts: {
    brief?: Partial<StrategyBrief>;
    scopeCategoryIds?: string[];
    google?: (s: ChannelSnapshot) => ChannelSnapshot;
    channels?: (c: ChannelPerformance) => ChannelPerformance;
    channelWarnings?: string[];
  } = {},
) {
  const services = getDemoStore().clientServices.filter((s) => s.client_id === "client_clicktrends");
  const categories = categoriesFromServices(services);
  const snapshot = demoMetaAuditSnapshot(DEMO_CLICKTRENDS_META_ACCOUNT_ID, "ClickTrends Performance", 30);
  const attribution = attributeSpendToCategories(snapshot, categories);
  const google = await loadChannelSnapshot("client_clicktrends", range);
  const built = buildChannelPerformance({
    categories,
    metaAttribution: attribution,
    metaCurrency: snapshot.account.currency,
    snapshot: opts.google ? opts.google(google) : google,
  });
  const channels = opts.channels ? opts.channels(built) : built;
  const client = getDemoStore().clients.find((c) => c.id === "client_clicktrends")!;
  const plan = buildStrategyPlan({
    snapshot,
    scorecard: { score: 62, grade: "C" },
    categories,
    goals: resolveGoals(client),
    brief: { dailyBudgetCents: 20_000, targetRoas: 3, stretchTargets: [], ...opts.brief },
    categoryWord: "category",
    channels,
    scopeCategoryIds: opts.scopeCategoryIds,
  });
  const text = renderStrategyEvidence(plan, attribution, {
    currency: "USD",
    categoryWord: "category",
    warnings: snapshot.warnings,
    channels,
    channelWarnings: opts.channelWarnings,
  });
  const spend = renderCategorySpendEvidence(attribution, categories, {
    currency: "USD",
    categoryWord: "category",
    periodDays: 30,
    accountSpendCents: snapshot.totals?.spendCents ?? null,
    warnings: snapshot.warnings,
    channels,
    channelWarnings: opts.channelWarnings,
  });
  return { categories, snapshot, attribution, channels, plan, text, spend };
}

const CHANNEL_HEADINGS = [
  "### Strategy inputs",
  "### Scope",
  "### Channel data",
  "### Level 1: spend & return by category",
  "### Untouched categories",
  "### Meta capabilities: in use / not used / unknown",
  "### Google campaign types: in use / not used / needs a product feed",
  "### Level 2: reality check",
  "### Level 2: GA4 vs platform-reported",
  "### Search demand",
  "### Level 3: allocation",
  "### Level 3: channel split",
  "### Stretch scenarios",
  "### Next test",
  "### Assumptions",
];

/** Headings this task adds; none may appear without channels. */
const NEW_HEADINGS = [
  "### Scope",
  "### Channel data",
  "### Google campaign types",
  "### Level 2: GA4 vs platform-reported",
  "### Search demand",
  "### Level 3: channel split",
];

describe("renderStrategyEvidence with channels", () => {
  it("prints every section, the new ones included, in order", async () => {
    const { text } = await clickTrends({ scopeCategoryIds: ["svc_ct_bar_stools"] });
    const positions = CHANNEL_HEADINGS.map((h) => text.indexOf(h));
    for (const [i, p] of positions.entries()) expect(p, CHANNEL_HEADINGS[i]).toBeGreaterThanOrEqual(0);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("prints Meta spend, Google spend, GA4 paid and all-channel revenue, combined ROAS and basis per category", async () => {
    const { text, plan } = await clickTrends();
    const level1 = section(text, "### Level 1");
    expect(level1).toContain(
      "| Category | Meta spend (30d) | Google spend (30d) | GA4 paid revenue | GA4 revenue (all channels) | Platform revenue | Combined ROAS | Basis | Tier | Match |",
    );
    const bar = plan.allocations.find((a) => a.categoryId === "svc_ct_bar_stools")!;
    // Meta $2,100 + Google $1,166.67 against GA4's paid social + paid search $6,363.63 (of $7,000 on
    // all channels): the plan's own observed ROAS.
    expect(bar.observedRoas).toBe(1.95);
    expect(level1).toMatch(
      new RegExp(`\\| Bar stools \\| \\$2,100\\.00 \\| \\$1,166\\.67 \\| \\$6,363\\.63 \\| \\$7,000\\.00 \\| [^|]+ \\| ${bar.observedRoas}× \\| GA4 \\| ${bar.tier} \\|`),
    );
    expect(level1).not.toContain("GA4 revenue not matched to any category");
    expect(level1).toContain("- GA4 method: GA4 product categories");
    expect(level1).toMatch(/- Google Ads unmatched spend: \$[\d,.]+ \(not attributed to any category\)/);
  });

  it("prints GA4 revenue no category matched, with its share of GA4 revenue", async () => {
    const lamps = (s: ChannelSnapshot): ChannelSnapshot => ({
      ...s,
      ga4: { ...s.ga4!, rows: [...s.ga4!.rows, { key: "Lamps", revenueCents: 100_000, purchases: 3 }] },
    });
    const { text, spend, plan } = await clickTrends({ google: lamps });
    // $1,000 of $11,100.
    const line = "- GA4 revenue not matched to any category: $1,000.00 (9% of GA4 revenue)";
    expect(section(text, "### Level 1")).toContain(line);
    expect(spend).toContain(line);
    expect(plan.revenueBasis).toBe("ga4");
  });

  it("uses platform revenue, and says why, when GA4 matched under half its revenue", async () => {
    const lamps = (s: ChannelSnapshot): ChannelSnapshot => ({
      ...s,
      ga4: { ...s.ga4!, rows: [...s.ga4!.rows, { key: "Lamps", revenueCents: 2_000_000, purchases: 30 }] },
    });
    const { text, spend, plan } = await clickTrends({ google: lamps });
    expect(plan.revenueBasis).toBe("platform");
    const note = "GA4 matched only 33.6% of revenue to categories, so the plan uses platform-reported revenue.";
    expect(plan.assumptions).toContain(note);
    expect(section(text, "### Assumptions")).toContain(`- ${note}`);
    expect(section(text, "### Level 1")).toMatch(/\| Bar stools \|(?: [^|]+ \|){6} platform \|/);
    expect(spend).toContain("- Ranked by: combined platform revenue");
    expect(spend).toContain("- GA4 matched only 33.6% of revenue to categories, so the figures use platform-reported revenue.");
  });

  it("names the landing-page method as an estimate", async () => {
    const { text } = await clickTrends({ channels: (c) => ({ ...c, ga4Method: "landing_page" }) });
    expect(section(text, "### Level 1")).toContain(
      "- GA4 method: GA4 landing pages — an estimate, not exact product sales",
    );
  });

  it("compares Meta-reported revenue with GA4 paid-social revenue, with the gap in %", async () => {
    const { text, channels } = await clickTrends();
    const { metaReportedCents, ga4PaidSocialCents } = channels.metaVsGa4!;
    const pct = Math.round(((metaReportedCents - ga4PaidSocialCents) / ga4PaidSocialCents) * 1000) / 10;
    const level2 = section(text, "### Level 2: GA4 vs platform-reported");
    expect(level2).toContain("Meta-reported revenue");
    expect(level2).toContain("GA4 revenue from Facebook/Instagram paid sessions");
    expect(level2).toContain(`${Math.abs(pct)}% ${pct >= 0 ? "more" : "less"} than GA4`);
  });

  it("prints search demand per category, top 10 by impressions", () => {
    const categories = Array.from({ length: 12 }, (_, i) => cat(`Cat${String(i).padStart(2, "0")}`));
    const rows: CategoryChannels[] = categories.map((c, i) => ({
      categoryId: c.id,
      meta: { spendCents: 0, platformRevenueCents: 0, ga4RevenueCents: null, roas: null, basis: "none" },
      google: { spendCents: 0, platformRevenueCents: 0, ga4RevenueCents: null, roas: null, basis: "none" },
      ga4TotalRevenueCents: null,
      searchImpressions: 1_000 + i * 100,
      searchClicks: 10 + i,
      topQueries: [`query ${i}`],
    }));
    const channels: ChannelPerformance = {
      byCategory: rows,
      ga4Method: "none",
      ga4Available: false,
      googleAdsMapped: false,
      googleAdsLoaded: false,
      currencyMismatch: null,
      googleUnmatchedSpendCents: 0,
      ga4UnmatchedRevenueCents: 0,
      metaVsGa4: null,
      ads: null,
      warnings: [],
    };
    const snapshot = snap([]);
    const plan = buildStrategyPlan({
      snapshot,
      scorecard: { score: 62, grade: "C" },
      categories,
      goals: resolveGoals({ goals_profile: { business_model: "ecommerce" } }),
      brief: { dailyBudgetCents: 10_000, targetRoas: 4, stretchTargets: [] },
      channels,
    });
    const text = renderStrategyEvidence(plan, attributeSpendToCategories(snapshot, categories), {
      currency: "USD",
      categoryWord: "category",
      channels,
    });
    const demand = section(text, "### Search demand");
    const lines = demand.split("\n").filter((l) => /^\| Cat\d\d /.test(l));
    expect(lines).toHaveLength(10);
    expect(lines[0]).toBe("| Cat11 | 2,100 | 21 | query 11 |");
    expect(lines[9]).toMatch(/^\| Cat02 /);
    expect(demand).toContain("…and 2 more categories with search demand (top 10 by impressions shown).");
  });

  it("splits each funded category across Meta and Google, with totals and the recommendation label", async () => {
    // Bar stools is below its 40%-margin break-even, so only a plan asked for it funds it.
    const { text, plan } = await clickTrends({ scopeCategoryIds: ["svc_ct_bar_stools"] });
    const split = section(text, "### Level 3: channel split");
    expect(split).toContain(
      "| Category | Daily budget | Meta budget | Google budget | Meta projected | Google projected | Basis | Google campaign types |",
    );
    const bar = plan.allocations.find((a) => a.categoryId === "svc_ct_bar_stools")!;
    expect(bar.channelSplit!.googleCents).toBeGreaterThan(0);
    const money = (c: number) => `$${(c / 100).toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    expect(split).toContain(
      `| Bar stools | ${money(bar.dailyBudgetCents)} | ${money(bar.channelSplit!.metaCents)} | ${money(bar.channelSplit!.googleCents)} | ${money(bar.channelSplit!.metaProjectedCents)} | ${money(bar.channelSplit!.googleProjectedCents)} | GA4 | Shopping campaigns, Search campaigns |`,
    );
    const totals = plan.channelTotals!;
    expect(split).toContain(`- Totals: Meta ${money(totals.metaCents)}/day, Google ${money(totals.googleCents)}/day`);
    expect(split.trim().endsWith(LABEL)).toBe(true);
  });

  it("lists the Google campaign types in use, not used and needing a product feed", async () => {
    const { text } = await clickTrends();
    const types = section(text, "### Google campaign types");
    expect(types).toContain("- In use: Search campaigns, Performance Max");
    expect(types).toMatch(/- Not used:\n {2}- Shopping campaigns: /);
    expect(types).toContain("  - Demand Gen: ");
    expect(types).toContain("- Needs a product feed (link Merchant Center to run them): none");
    const noFeed = await clickTrends({
      google: (s) => ({ ...s, ads: { ...s.ads!, merchantCenterLinked: false } }),
    });
    expect(section(noFeed.text, "### Google campaign types")).toContain(
      "- Needs a product feed (link Merchant Center to run them): Shopping campaigns",
    );
  });

  it("names the categories of a scoped plan", async () => {
    const { text } = await clickTrends({ scopeCategoryIds: ["svc_ct_bar_stools"] });
    expect(section(text, "### Scope")).toContain("- Planned only for: Bar stools");
    const whole = await clickTrends();
    expect(whole.text).not.toContain("### Scope");
  });

  it("says Google needs reconnecting rather than dropping Google silently (Review Focus #2)", async () => {
    const { text } = await clickTrends({
      google: (s) => ({ ...s, ga4: null, ads: null, gsc: null, warnings: [RECONNECT] }),
    });
    const data = section(text, "### Channel data");
    expect(data).toContain(`- Warning: ${RECONNECT}`);
    expect(text.indexOf("### Channel data")).toBeLessThan(text.indexOf("### Level 1"));
    expect(section(text, "### Level 1")).toContain("- GA4 method: none");
  });

  it("prints a part failure and keeps the parts that loaded (Review Focus #5)", async () => {
    const { text, plan, channels } = await clickTrends({
      scopeCategoryIds: ["svc_ct_bar_stools"],
      google: (s) => ({ ...s, ads: null, warnings: ["Google Ads: quota exceeded"] }),
    });
    expect(channels.googleAdsLoaded).toBe(false);
    const data = section(text, "### Channel data");
    expect(data).toContain("- Warning: Google Ads: quota exceeded");
    expect(data).toContain("- Note: Google Ads is mapped but its data didn't load this time; Google wasn't considered.");
    // GA4 still loaded; with Google left out the ROAS is Meta's spend against GA4's paid-social share.
    const level1 = section(text, "### Level 1");
    expect(level1).toContain("- GA4 method: GA4 product categories");
    expect(level1).toContain("| GA4 paid-social revenue | GA4 revenue (all channels) | Meta-reported revenue | ROAS (Meta only) |");
    expect(level1).not.toContain("Combined ROAS");
    const bar = plan.allocations[0];
    const ga4Social = channels.byCategory.find((c) => c.categoryId === "svc_ct_bar_stools")!.meta.ga4RevenueCents!;
    expect(bar.observedRoas).toBe(Math.round((ga4Social / 210_000) * 100) / 100);
    expect(level1).toMatch(
      new RegExp(`\\| Bar stools \\| \\$2,100\\.00 \\| not loaded \\| [^|]+ \\| \\$7,000\\.00 \\| \\$6,510\\.00 \\| ${bar.observedRoas}× \\| GA4 \\|`),
    );
    // No Google share.
    expect(bar.channelSplit).toMatchObject({ googleCents: 0, metaCents: bar.dailyBudgetCents });
    expect(section(text, "### Google campaign types")).toMatch(/Unknown \(Google Ads data didn't load\): Search campaigns/);
  });

  it("takes Level 1's ROAS from the plan's observed ROAS", async () => {
    const { text, plan } = await clickTrends({ channels: (c) => c });
    const level1 = section(text, "### Level 1");
    for (const a of plan.allocations) {
      expect(level1).toMatch(new RegExp(`\\| ${a.name} \\|(?: [^|]+ \\|){5} ${a.observedRoas}× \\|`));
    }
    expect(section(text, "### Strategy inputs")).toContain("- Meta spend in period: $3,300.00 · Meta account ROAS");
  });

  it("says a funded scoped hold was funded on request and makes it the next test", async () => {
    const { text, plan } = await clickTrends({ scopeCategoryIds: ["svc_ct_bar_stools"] });
    expect(plan.allocations[0].tier).toBe("hold");
    const level3 = section(text, "### Level 3: allocation");
    expect(level3).toContain(
      "- Hold, funded on request (Bar stools): below break-even, funded because the plan was asked for it; set up like a test: ",
    );
    expect(level3).not.toContain("no budget until it returns at least break-even");
    expect(section(text, "### Next test")).toContain("- Bar stools: $200.00/day for 14 days");
  });

  it("prints the currency mismatch reason, no combined figures and no split table", async () => {
    const reason = "Meta reports in USD, GA4 in AUD, Google Ads in AUD: figures are shown per channel and not combined.";
    const { text, plan } = await clickTrends({ channels: (c) => ({ ...c, currencyMismatch: reason }) });
    expect(plan.channelTotals).toBeNull();
    expect(section(text, "### Channel data")).toContain(reason);
    const level1 = section(text, "### Level 1");
    expect(level1).toContain("| Category | Spend (30d) | Revenue | ROAS | Tier | Match |");
    expect(level1).not.toMatch(/Combined ROAS|GA4 revenue|Google Ads unmatched/);
    const split = section(text, "### Level 3: channel split");
    expect(split).toContain(reason);
    expect(split).not.toContain("| Category |");
    expect(split).not.toContain(LABEL);
    expect(section(text, "### Level 2: GA4 vs platform-reported")).toContain(reason);
  });

  it("prints load warnings passed without channels", () => {
    const text = renderStrategyEvidence(baselinePlan(), baselineAttribution(), {
      currency: "USD",
      categoryWord: "category",
      defaultsUsed: ["Daily budget not stated: used the client's daily account cap."],
      warnings: [],
      channelWarnings: ["Google data couldn't load: boom. The figures below are Meta only."],
    });
    expect(section(text, "### Channel data")).toContain(
      "- Warning: Google data couldn't load: boom. The figures below are Meta only.",
    );
    expect(text).not.toContain("### Level 3: channel split");
  });
});

describe("renderCategorySpendEvidence with channels", () => {
  it("adds the channel columns and ranks by GA4 revenue, best category first", async () => {
    const { spend } = await clickTrends();
    expect(spend).toContain("- Ranked by: GA4 revenue");
    expect(spend).toContain(
      "| Category | Meta spend (30d) | Google spend (30d) | GA4 paid revenue | GA4 revenue (all channels) | Platform revenue | Combined ROAS | Basis | Match |",
    );
    const rows = spend.split("\n").filter((l) => /^\| (Bar stools|Sofas) /.test(l));
    expect(rows.map((r) => r.split(" | ")[0])).toEqual(["| Bar stools", "| Sofas"]);
    expect(rows[0]).toContain("| $6,363.63 | $7,000.00 |");
    expect(spend).toContain("- GA4 method: GA4 product categories");
    expect(spend).toMatch(/- Google Ads unmatched spend: /);
    expect(spend).not.toMatch(/### Level|Daily budget|Tier/);
  });

  it("ranks by combined platform revenue without GA4", async () => {
    const { spend } = await clickTrends({ google: (s) => ({ ...s, ga4: null }) });
    expect(spend).toContain("- Ranked by: combined platform revenue");
    expect(spend).toContain("- GA4 method: none");
  });

  it("does not combine currencies that differ", async () => {
    const reason = "Meta reports in USD, Google Ads in AUD: figures are shown per channel and not combined.";
    const { spend } = await clickTrends({ channels: (c) => ({ ...c, currencyMismatch: reason }) });
    expect(spend).toContain(reason);
    expect(spend).toContain("- Ranked by: Meta-reported revenue");
    expect(spend).toContain("| Category | Spend (30d) | Revenue | ROAS | Match |");
    expect(spend).not.toMatch(/Combined ROAS|combined platform revenue/);
  });

  it("shows Google spend as not loaded, Meta-only ROAS, when Google Ads didn't load", async () => {
    const { spend } = await clickTrends({ google: (s) => ({ ...s, ads: null, warnings: ["Google Ads: quota exceeded"] }) });
    expect(spend).toContain("- Ranked by: GA4 paid-social revenue");
    expect(spend).toContain("- Note: Google Ads is mapped but its data didn't load this time; Google spend isn't included.");
    expect(spend).toContain("- Warning: Google Ads: quota exceeded");
    expect(spend).toContain("ROAS (Meta only)");
    expect(spend).not.toContain("Combined ROAS");
    expect(spend).toMatch(/\| Bar stools \| \$2,100\.00 \| not loaded \|/);
  });

  it("prints the reconnect warning near the top", async () => {
    const { spend } = await clickTrends({
      google: (s) => ({ ...s, ga4: null, ads: null, gsc: null, warnings: [RECONNECT] }),
    });
    expect(spend).toContain(`- Warning: ${RECONNECT}`);
    expect(spend.indexOf(RECONNECT)).toBeLessThan(spend.indexOf("| Category |"));
  });
});

// --- Without channels: byte-identical to the output before channels existed ---

const fiveCategories = [cat("Shoes"), cat("Bags"), cat("Hats"), cat("Belts"), cat("Socks")];
const fiveAds = [
  ad("Shoes", 20_000, 5),
  ad("Bags", 20_000, 3),
  ad("Hats", 20_000, 1),
  ad("Belts", 1_000, 6),
  { ...ad("Mystery", 9_000, 2), name: "Unbranded promo" },
];

function baselinePlan() {
  return buildStrategyPlan({
    snapshot: snap(fiveAds),
    scorecard: { score: 62, grade: "C" },
    categories: fiveCategories,
    goals: resolveGoals({ goals_profile: { business_model: "ecommerce" } }),
    brief: { dailyBudgetCents: 10_000, targetRoas: 4, stretchTargets: [6] },
    categoryWord: "category",
  });
}

function baselineAttribution() {
  return attributeSpendToCategories(snap(fiveAds), fiveCategories);
}

/** renderStrategyEvidence's output for the fixture above, captured before channels were added. */
const BASELINE_STRATEGY = `### Strategy inputs
- Daily budget: $100.00/day
- Target ROAS: 4×
- Stretch targets: 6×
- Period analysed: last 30 days
- Account audit score: 62/100 (grade C)
- Spend in period: $1,000.00 · account ROAS 2×
- Categories loaded: 5 (4 with spend)
- Word for offerings: category
- Currency: USD
- Default used: Daily budget not stated: used the client's daily account cap.

### Level 1: spend & return by category
| Category | Spend (30d) | Revenue | ROAS | Tier | Match |
| --- | --- | --- | --- | --- | --- |
| Shoes | $200.00 | $1,000.00 | 5× | proven | name |
| Bags | $200.00 | $600.00 | 3× | promising | name |
| Hats | $200.00 | $200.00 | 1× | hold | name |
| Belts | $10.00 | $60.00 | 6× | test | name |
| Socks | $0.00 | $0.00 | unknown | test | none |

- Unmatched spend: $90.00 across 1 ads (not attributed to any category)
- Coverage: 87.1% of ad spend matched to a category
- Ad-level spend covered: $700.00 of account spend $1,000.00 (70%)
- Per-category figures are partial: the loaded ads cover only 70% of account spend. A category with no spend here was not seen in the loaded ads; that does not mean it had no spend.

### Untouched categories
- 1 not seen in the loaded ads: Socks

### Meta capabilities: in use / not used / unknown
- In use: Website retargeting, Lookalike audiences, Broad / Advantage+ audience, Cost cap or minimum ROAS controls
- Not used:
  - Advantage+ sales campaigns: Lets Meta's automation find buyers across the whole catalogue, which usually lifts ROAS at scale.
  - Video creative: Video earns cheaper attention and feeds the algorithm more variety, supporting steadier ROAS.
  - Dynamic creative: Tests combinations of images and copy automatically so the best performers get the spend.
  - Automatic placements: Lets Meta put spend where it converts best instead of limiting delivery to a few placements.
- Unknown (not enough data to tell): Catalogue ads

### Level 2: reality check
- Target 4× vs reference 3× (the higher of the retargeting benchmark and the account ROAS): 1.33× the reference, verdict **stretch**.

| Metric | Value | Source |
| --- | --- | --- |
| Prospecting ROAS | 1.5× | Internal paid-social playbook (generic, not industry-specific) |
| Retargeting ROAS | 3× | Internal paid-social playbook (generic, not industry-specific) |
| Account ROAS | 2× | This account, last 30 days |

### Level 3: allocation
| Category | Tier | Target ROAS | Observed ROAS | Daily budget | Projected daily revenue |
| --- | --- | --- | --- | --- | --- |
| Shoes | proven | 4× | 5× | $70.00 | $297.50 |
| Bags | promising | 4× | 3× | $20.00 | $51.00 |
| Hats | hold | 4× | 1× | $0.00 | $0.00 |
| Belts | test | 4× | 6× | $10.00 | $14.00 |
| Socks | test | 4× | unknown | $0.00 | $0.00 |

- Plan total: $100.00/day spend → $362.50/day projected revenue, blended ROAS 3.63× (misses the 4× target).

Structure per tier:
- Proven (Shoes): Advantage+ sales campaigns, Catalogue ads, Website retargeting, Cost cap or minimum ROAS controls
- Promising (Bags): Cost cap or minimum ROAS controls, Video creative, Website retargeting
- Test (Belts, Socks): Broad / Advantage+ audience, Automatic placements, Dynamic creative
- Hold (Hats): no budget until it returns at least break-even

### Stretch scenarios
- 6× target (above the main 4× target): $100.00/day spend → $339.12/day projected revenue, blended ROAS 3.39×, misses this target; tiers: 0 proven, 2 promising, 2 test, 1 held.

### Next test
- Belts: $10.00/day for 14 days (from the Level 3 allocation).

### Assumptions
- Budget split 70% proven, 20% promising, 10% test; an empty tier's share moves to the next tier.
- Within the proven and promising tiers, budget follows each category's purchase value.
- Test categories are funded at $20.00/day each, highest priority first, as far as the test budget allows; a test budget under $20.00 goes entirely to the top test category.
- A category needs $50.00 of spend in the last 30 days before it is judged; below that it is a test.
- Scaled budgets assumed to return 85% of current ROAS.
- Test budgets assumed to return 70% of the account ROAS (2×).
- No margin is known, so every category uses the account target ROAS.
- Categories below break-even ROAS, or below half their target when the margin is unknown, are held at no budget.
- The target is compared with the higher of the 3× retargeting benchmark and the account ROAS: up to 1.2× that is within reach, up to 2.5× a stretch, beyond that unrealistic.
- Benchmarks (1.5× prospecting, 3× retargeting ROAS) come from the internal paid-social playbook (generic, not industry-specific).
- The next test is the highest-priority funded test category (else the funded promising category with the biggest budget), run for 14 days at its planned daily budget.`;

/** renderCategorySpendEvidence's output for the fixture above, captured before channels were added. */
const BASELINE_SPEND = `### Spend & return by category
- Period: last 30 days. Figures only: no plan, no budget allocation.
| Category | Spend (30d) | Revenue | ROAS | Match |
| --- | --- | --- | --- | --- |
| Shoes | $200.00 | $1,000.00 | 5× | name |
| Bags | $200.00 | $600.00 | 3× | name |
| Hats | $200.00 | $200.00 | 1× | name |
| Belts | $10.00 | $60.00 | 6× | name |
| Socks | $0.00 | $0.00 | unknown | none |

- Unmatched spend: $90.00 across 1 ads (not attributed to any category)
- Coverage: 87.1% of ad spend matched to a category
- Ad-level spend covered: $700.00 of account spend $1,000.00 (70%)
- Per-category figures are partial: the loaded ads cover only 70% of account spend. A category with no spend here was not seen in the loaded ads; that does not mean it had no spend.`;

describe("evidence without channels", () => {
  const strategyOpts = {
    currency: "USD",
    categoryWord: "category" as const,
    defaultsUsed: ["Daily budget not stated: used the client's daily account cap."],
    warnings: [],
  };
  const spendOpts = {
    currency: "USD",
    categoryWord: "category" as const,
    periodDays: 30,
    accountSpendCents: 100_000,
    warnings: [],
  };

  it("renders the strategy evidence byte-identical to before", () => {
    const plan = baselinePlan();
    for (const extra of [{}, { channels: undefined }, { channelWarnings: [] }]) {
      const text = renderStrategyEvidence(plan, baselineAttribution(), { ...strategyOpts, ...extra });
      expect(text).toBe(BASELINE_STRATEGY);
      for (const h of NEW_HEADINGS) expect(text).not.toContain(h);
    }
  });

  it("still names the categories of a scoped plan, and funds a held one on request", () => {
    const plan = buildStrategyPlan({
      snapshot: snap(fiveAds),
      scorecard: { score: 62, grade: "C" },
      categories: fiveCategories,
      goals: resolveGoals({ goals_profile: { business_model: "ecommerce" } }),
      brief: { dailyBudgetCents: 10_000, targetRoas: 4, stretchTargets: [] },
      categoryWord: "category",
      scopeCategoryIds: ["hats"],
    });
    const text = renderStrategyEvidence(plan, baselineAttribution(), strategyOpts);
    expect(section(text, "### Scope")).toContain("- Planned only for: Hats");
    expect(text).not.toContain("### Channel data");
    expect(section(text, "### Level 3: allocation")).toContain("- Hold, funded on request (Hats): ");
    expect(section(text, "### Next test")).toContain("- Hats: $100.00/day for 14 days");
  });

  it("renders the category spend evidence byte-identical to before", () => {
    for (const extra of [{}, { channels: undefined }, { channelWarnings: [] }]) {
      const text = renderCategorySpendEvidence(baselineAttribution(), fiveCategories, { ...spendOpts, ...extra });
      expect(text).toBe(BASELINE_SPEND);
      expect(text).not.toContain("Ranked by");
    }
  });
});

describe("STRATEGY_FRAMEWORK for channels", () => {
  it("uses GA4 figures and names the method in Level 1", () => {
    expect(STRATEGY_FRAMEWORK).toMatch(/Level 1: where you are[^\n]*\n(?:[^\n]*\n)*?[^\n]*GA4 method/);
  });

  it("covers the GA4 vs Meta gap and search demand in Level 2, and the channel split in Level 3", () => {
    expect(STRATEGY_FRAMEWORK).toContain("GA4 vs platform-reported");
    expect(STRATEGY_FRAMEWORK).toContain("Search demand");
    expect(STRATEGY_FRAMEWORK).toContain("Level 3: channel split");
    expect(STRATEGY_FRAMEWORK).toContain(LABEL);
  });

  it("never lets the report claim the tool changes Google", () => {
    expect(STRATEGY_FRAMEWORK).toMatch(/never say[^\n]*Google[^\n]*(changed|change)/i);
  });
});
