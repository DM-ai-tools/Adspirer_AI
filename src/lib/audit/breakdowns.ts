import { moneyFor } from "@/lib/audit/render";
import type { AuditAd, AuditAdSet, MetaAuditSnapshot, PeriodPerformance } from "@/lib/audit/meta-audit-data";

/**
 * Splits of the audited period that Meta's own rows already support: creative
 * format, audience type, destination page type, placement position, age and
 * gender, plus the settings actually in use. Everything here is a sum of rows
 * in the snapshot; nothing is inferred beyond the grouping rule stated beside
 * each split. The writer judges; these functions only group and add.
 */

export type Slice = {
  label: string;
  items: number;
  spendCents: number;
  results: number | null;
  addToCart: number | null;
  landingPageViews: number | null;
  purchases: number | null;
  purchaseValueCents: number | null;
};

const sumNullable = (values: Array<number | null | undefined>): number | null => {
  const present = values.filter((v): v is number => v != null);
  return present.length ? present.reduce((a, b) => a + b, 0) : null;
};

export function sliceOf(label: string, rows: Array<PeriodPerformance | null | undefined>): Slice {
  const perf = rows.filter((p): p is PeriodPerformance => p != null);
  return {
    label,
    items: rows.length,
    spendCents: perf.reduce((a, p) => a + p.spendCents, 0),
    results: sumNullable(perf.map((p) => p.results)),
    addToCart: sumNullable(perf.map((p) => p.addToCart)),
    landingPageViews: sumNullable(perf.map((p) => p.landingPageViews)),
    purchases: sumNullable(perf.map((p) => p.purchases)),
    purchaseValueCents: sumNullable(perf.map((p) => p.purchaseValueCents)),
  };
}

const FORMAT_LABEL: Record<string, string> = {
  VIDEO: "Video",
  DYNAMIC: "Dynamic / flexible creative",
  PHOTO: "Static image",
  IMAGE: "Static image",
  SHARE: "Link post (image or carousel)",
  CAROUSEL: "Carousel",
};

export function formatLabel(ad: Pick<AuditAd, "format">): string {
  if (!ad.format) return "Format not reported";
  return FORMAT_LABEL[ad.format.toUpperCase()] ?? ad.format.toLowerCase().replace(/_/g, " ");
}

const NO_LINK = "Link not returned by Meta";

/** Where the ad sends people, from the creative link: product, collection, homepage, other, or not returned. */
export function destinationKind(linkUrl: string | null | undefined): string {
  if (!linkUrl) return NO_LINK;
  let path: string;
  try {
    path = new URL(linkUrl).pathname.toLowerCase();
  } catch {
    return NO_LINK;
  }
  if (/\/products?\//.test(path)) return "Product page";
  if (/\/collections?\//.test(path)) return "Collection page";
  if (path === "/" || path === "") return "Homepage";
  return "Other page";
}

/** Ads that spent in the period, grouped by `by`. */
export function groupAds(ads: AuditAd[], by: (ad: AuditAd) => string): Slice[] {
  const groups = new Map<string, AuditAd[]>();
  for (const ad of ads) {
    if (!ad.performance || ad.performance.spendCents <= 0) continue;
    const key = by(ad);
    groups.set(key, [...(groups.get(key) ?? []), ad]);
  }
  return [...groups.entries()]
    .map(([label, rows]) => sliceOf(label, rows.map((a) => a.performance)))
    .sort((a, b) => b.spendCents - a.spendCents);
}

/**
 * Audience type for an ad set, from what the ad set is set up with, not from its name:
 * a lookalike or custom audience it includes, or none included. Interest targeting is not read,
 * so "no saved audience" is broad OR interest-based and is never called either.
 */
export function audienceKind(adSet: AuditAdSet, subtypeById: Map<string, string>): string {
  if (adSet.productSetId) return "Catalogue (product set)";
  const subtypes = adSet.includedAudienceIds.map((id) => subtypeById.get(id) ?? "UNKNOWN");
  if (!subtypes.length) return "No saved audience included (broad or interest-based; interests not read)";
  if (subtypes.every((s) => s === "LOOKALIKE")) return "Lookalike audience";
  if (subtypes.some((s) => s === "LOOKALIKE")) return "Lookalike + custom audience";
  return "Custom audience (website visitors, engagers or lists)";
}

export function groupAdSets(snap: MetaAuditSnapshot): Slice[] {
  const subtypeById = new Map(snap.audiences.map((a) => [a.id, a.subtype]));
  const groups = new Map<string, AuditAdSet[]>();
  for (const a of snap.adSets) {
    if (!a.performance || a.performance.spendCents <= 0) continue;
    const key = audienceKind(a, subtypeById);
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }
  return [...groups.entries()]
    .map(([label, rows]) => sliceOf(label, rows.map((a) => a.performance)))
    .sort((a, b) => b.spendCents - a.spendCents);
}

const tally = (values: Array<string | null | undefined>, empty: string) => {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v || empty, (counts.get(v || empty) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} x${n}`)
    .join(", ");
};

const WINDOW_LABEL: Record<string, string> = {
  "7d_click": "7-day click",
  "1d_view": "1-day view",
  "1d_click": "1-day click",
  "28d_click": "28-day click",
  "7d_view": "7-day view",
  "28d_view": "28-day view",
};

/** What the audited ad sets and campaigns are configured with: facts only, counted. */
export function settingsInUse(snap: MetaAuditSnapshot): string[] {
  const live = snap.adSets.filter((a) => (a.performance?.spendCents ?? 0) > 0);
  const spentCampaigns = snap.campaigns.filter((c) => (c.performance?.spendCents ?? 0) > 0);
  if (!live.length) return [];
  const manualPlacements = live.filter((a) => a.publisherPlatforms.length > 0).length;
  const windows = tally(
    live.map((a) => (a.attributionWindows.length ? a.attributionWindows.map((w) => WINDOW_LABEL[w] ?? w).join(" + ") : null)),
    "not reported",
  );
  return [
    `Ad sets that spent: ${live.length}; campaigns that spent: ${spentCampaigns.length}`,
    `Campaign objective: ${tally(spentCampaigns.map((c) => c.objective), "not reported")}`,
    `Bid strategy, campaigns: ${tally(spentCampaigns.map((c) => c.bidStrategy), "not set at campaign level")}; ad sets: ${tally(live.map((a) => a.bidStrategy), "not set")}`,
    `Optimisation goal: ${tally(live.map((a) => a.optimizationGoal), "not reported")}`,
    `Attribution window: ${windows}`,
    `Advantage+ campaigns: ${spentCampaigns.filter((c) => c.advantagePlus).length} of ${spentCampaigns.length}`,
    `Placements: ${live.length - manualPlacements} ad set(s) on automatic placements, ${manualPlacements} on chosen platforms`,
  ];
}

export function renderBreakdownEvidence(snap: MetaAuditSnapshot): string {
  const money = moneyFor(snap.account.currency);
  const n = (v: number) => v.toLocaleString("en");
  const row = (s: Slice) => {
    const cpAtc = s.addToCart && s.addToCart > 0 ? money(Math.round(s.spendCents / s.addToCart)) : "-";
    const atcRate =
      s.addToCart != null && s.landingPageViews && s.landingPageViews > 0
        ? `${((s.addToCart / s.landingPageViews) * 100).toFixed(1)}%`
        : "-";
    const cpr = s.results && s.results > 0 ? money(Math.round(s.spendCents / s.results)) : "-";
    return `| ${s.label} | ${s.items} | ${money(s.spendCents)} | ${s.results != null ? n(s.results) : "-"} | ${cpr} | ${s.addToCart != null ? n(s.addToCart) : "-"} | ${cpAtc} | ${atcRate} |`;
  };
  const head = (first: string) =>
    `| ${first} | Count | Spend | Results | Cost per result | Add to cart | Cost per add to cart | Add-to-cart rate (of landing page views) |\n|---|---|---|---|---|---|---|---|`;
  const table = (first: string, slices: Slice[]) => [head(first), ...slices.map(row)].join("\n");

  const out: string[] = [
    `### Breakdowns of ${snap.period.since} to ${snap.period.until} (sums of live Meta rows, authoritative)`,
    "Each table is a plain sum of Meta's own rows grouped by the rule stated; '-' means Meta did not return that metric. Compare groups only when each has enough results (~20-30) to read. Never add a figure that is not in a table.",
  ];

  const ads = snap.ads;
  const adSpend = ads.reduce((a, x) => a + (x.performance?.spendCents ?? 0), 0);
  const formats = groupAds(ads, formatLabel);
  const dests = groupAds(ads, (a) => destinationKind(a.linkUrl));
  if (formats.length) {
    out.push("", "#### Creative format (ads that spent, grouped by Meta's creative type)", table("Format", formats));
    const accountSpend = snap.totals?.spendCents ?? 0;
    const gap = accountSpend - adSpend;
    // Ads Meta no longer lists (deleted) still spent: say so rather than let the tables look complete.
    if (!snap.scope && accountSpend > 0 && gap > accountSpend * 0.01) {
      out.push(
        `Spend not attributed to any listed ad: ${money(gap)} (${((gap / accountSpend) * 100).toFixed(1)}% of ${money(accountSpend)}), likely ads Meta no longer lists. The tables here cover ${money(adSpend)}.`,
      );
    }
  }
  if (dests.length) {
    out.push("", "#### Destination page (from each ad's link; catalogue and flexible ads may not return one)", table("Destination", dests));
    const notReturned = dests.find((d) => d.label === NO_LINK);
    if (notReturned && adSpend > 0) {
      out.push(
        `${((notReturned.spendCents / adSpend) * 100).toFixed(0)}% of ad spend has no readable link, so a product vs collection comparison covers only the rest. Say so, and say the link has to be read in Ads Manager.`,
      );
    }
  }
  const audiences = groupAdSets(snap);
  if (audiences.length) {
    out.push("", "#### Audience type (grouped from what each ad set includes, not from its name)", table("Audience", audiences));
  }
  const settings = settingsInUse(snap);
  if (settings.length) {
    out.push(
      "",
      "#### Settings in use (counted from the ad sets and campaigns that spent in this period)",
      ...settings.map((s) => `- ${s}`),
      "A setting can only be called 'not used' for this period's campaigns; Meta was not asked about earlier ones. Say 'not used in the audited period'.",
    );
  }
  if (snap.placementPositions?.length) {
    const positions = snap.placementPositions
      .map((p) => sliceOf(`${p.platform} / ${p.position.replace(/_/g, " ")}`, [p.performance]))
      .filter((s) => s.spendCents > 0)
      .sort((a, b) => b.spendCents - a.spendCents)
      .slice(0, 12);
    if (positions.length) out.push("", "#### Placement position (top 12 by spend)", table("Placement", positions));
  }
  if (snap.demographics?.length) {
    const byAge = new Map<string, PeriodPerformance[]>();
    const byGender = new Map<string, PeriodPerformance[]>();
    for (const d of snap.demographics) {
      byAge.set(d.age, [...(byAge.get(d.age) ?? []), d.performance]);
      byGender.set(d.gender, [...(byGender.get(d.gender) ?? []), d.performance]);
    }
    const toSlices = (m: Map<string, PeriodPerformance[]>) =>
      [...m.entries()]
        .map(([k, v]) => sliceOf(k, v))
        .filter((s) => s.spendCents > 0)
        .sort((a, b) => a.label.localeCompare(b.label, "en", { numeric: true }));
    out.push("", "#### Age", table("Age", toSlices(byAge)), "", "#### Gender", table("Gender", toSlices(byGender)));
  }
  const missing = snap.warnings.filter((w) => w.startsWith("Age and gender") || w.startsWith("Placement position"));
  if (missing.length) out.push("", `Not loaded (say which part failed to load): ${missing.join("; ")}`);
  return out.join("\n");
}
