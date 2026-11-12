import { formatLabel } from "@/lib/audit/breakdowns";
import type { AuditAd, AuditAdSet, AuditAudience, AuditCampaign, MetaAuditSnapshot, PeriodPerformance } from "@/lib/audit/meta-audit-data";

/**
 * The performance tables of the audit report: month by month, campaigns with their type and
 * audience, audience types, ad formats, offer vs no offer, landing page type, placements, age and
 * gender. Every number is a sum of Meta's own rows; every grouping follows the rule stated beside
 * it. They are built here, not written by the model, so the figures in the report are the figures
 * Meta returned. Each table carries one computed "Read:" line; the writer adds the interpretation.
 *
 * Pure: snapshot in, markdown out.
 */

/** The marker the writer puts where the tables go. */
export const PERFORMANCE_TABLES_MARKER = "[[PERFORMANCE_TABLES]]";

/** A group needs this many add-to-carts (or results) before its cost is compared with another's. */
export const MIN_VOLUME = 20;
/** A ROAS built on fewer purchases than this is marked: one or two orders make it swing from 0× to 40×. */
export const THIN_PURCHASES = 10;
export const THIN_MARK = "†";
const isThinPurchases = (g: Pick<Group, "purchases">) => g.purchases > 0 && g.purchases < THIN_PURCHASES;
/** ...and this share of spend, so a tiny test is not called the winner. */
const MIN_SHARE = 0.05;

export type Group = {
  label: string;
  /** Ads (or campaigns, or months) in the group that spent. */
  count: number;
  spendCents: number;
  impressions: number;
  linkClicks: number;
  landingPageViews: number;
  addToCart: number;
  purchases: number;
  purchaseValueCents: number;
  leads: number;
  messagingConversations: number;
  results: number;
};

type Perf = PeriodPerformance | null | undefined;

export function groupOf(label: string, rows: Perf[], count = rows.filter((p) => (p?.spendCents ?? 0) > 0).length): Group {
  const perf = rows.filter((p): p is PeriodPerformance => p != null);
  const sum = (pick: (p: PeriodPerformance) => number | null | undefined) => perf.reduce((a, p) => a + (pick(p) ?? 0), 0);
  return {
    label,
    count,
    spendCents: sum((p) => p.spendCents),
    impressions: sum((p) => p.impressions),
    linkClicks: sum((p) => p.linkClicks ?? (p.impressions * p.linkCtr) / 100),
    landingPageViews: sum((p) => p.landingPageViews),
    addToCart: sum((p) => p.addToCart),
    purchases: sum((p) => p.purchases),
    purchaseValueCents: sum((p) => p.purchaseValueCents),
    leads: sum((p) => p.leads),
    messagingConversations: sum((p) => p.messagingConversations),
    results: sum((p) => p.results),
  };
}

const delivered = (p: Perf) => (p?.spendCents ?? 0) > 0;

// ------------------------------------------------------------------ classification

const SALES_OBJECTIVES = /^(OUTCOME_SALES|CONVERSIONS|PRODUCT_CATALOG_SALES)$/i;
export const isSalesCampaign = (c: Pick<AuditCampaign, "objective">) => SALES_OBJECTIVES.test(c.objective);

/** Audiences of people who already know the brand: site visitors, engagers, customer lists. */
const WARM = /^(WEBSITE|ENGAGEMENT|CUSTOM|APP|OFFLINE_CONVERSION|VIDEO|IG_BUSINESS|FB_EVENT|LEAD_AD|SHOPPING|INSTANT_EXPERIENCE|MEASUREMENT|PARTNER|DATA_SET)/i;

export type AudienceType = "Broad" | "Interest" | "Lookalike" | "Retargeting" | "Catalogue retargeting" | "Catalogue prospecting";

/** What an ad set targets, from its settings (never its name). */
export function audienceTypeOf(adSet: AuditAdSet, audiences: Map<string, AuditAudience>): AudienceType {
  const subtypes = adSet.includedAudienceIds.map((id) => audiences.get(id)?.subtype ?? "UNKNOWN");
  const warm = subtypes.some((s) => WARM.test(s) || s === "UNKNOWN");
  if (adSet.productSetId) return warm ? "Catalogue retargeting" : "Catalogue prospecting";
  if (warm) return "Retargeting";
  if (subtypes.some((s) => s === "LOOKALIKE")) return "Lookalike";
  if ((adSet.interests?.length ?? 0) > 0) return "Interest";
  return "Broad";
}

const CAMPAIGN_TYPE: Record<AudienceType, string> = {
  Broad: "Prospecting",
  Interest: "Prospecting (interest)",
  Lookalike: "Prospecting (lookalike)",
  Retargeting: "Retargeting",
  "Catalogue retargeting": "Catalogue retargeting",
  "Catalogue prospecting": "Catalogue prospecting",
};

const short = (s: string, n = 26) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** A short description of who an ad set reaches: "Broad, AU 25-65", "Interests: Home décor +2", "Site visitors 180d + 1 more". */
export function audienceSummary(adSet: AuditAdSet, audiences: Map<string, AuditAudience>): string {
  const type = audienceTypeOf(adSet, audiences);
  const geo = adSet.countries.length ? adSet.countries.slice(0, 2).join("/") + (adSet.countries.length > 2 ? "+" : "") : "";
  const age = adSet.ageMin || adSet.ageMax ? `${adSet.ageMin ?? 18}-${adSet.ageMax ?? 65}` : "";
  const where = [geo, age].filter(Boolean).join(" ");
  const named = adSet.includedAudienceIds.map((id) => audiences.get(id)?.name).filter((n): n is string => Boolean(n));
  const list = (items: string[]) => (items.length ? `${short(items[0]!)}${items.length > 1 ? ` +${items.length - 1}` : ""}` : "");
  switch (type) {
    case "Broad":
      return ["Broad", where].filter(Boolean).join(", ");
    case "Interest":
      return `Interests: ${list(adSet.interests ?? [])}`;
    case "Catalogue prospecting":
      return ["Catalogue, broad", where].filter(Boolean).join(", ");
    default:
      return list(named) || type;
  }
}

/** The type that holds most of a campaign's spend, and how its ad sets reach people. */
export function campaignProfile(campaign: AuditCampaign, adSets: AuditAdSet[], audiences: Map<string, AuditAudience>): { type: string; audience: string } {
  const own = adSets.filter((a) => a.campaignId === campaign.id);
  if (!own.length) return { type: "—", audience: "—" };
  const bySpend = [...own].sort((a, b) => (b.performance?.spendCents ?? 0) - (a.performance?.spendCents ?? 0));
  const types = new Set(own.filter((a) => delivered(a.performance) || own.length === 1).map((a) => audienceTypeOf(a, audiences)));
  const lead = audienceTypeOf(bySpend[0]!, audiences);
  const audienceTexts = [...new Set(bySpend.filter((a) => delivered(a.performance)).map((a) => audienceSummary(a, audiences)))];
  const audience = audienceTexts.length > 1 ? `${audienceTexts[0]} + ${audienceTexts.length - 1} more` : (audienceTexts[0] ?? audienceSummary(bySpend[0]!, audiences));
  return { type: types.size > 1 ? `${CAMPAIGN_TYPE[lead]} (mixed)` : CAMPAIGN_TYPE[lead], audience };
}

/** Wording that makes an ad a sale or offer message. */
const OFFER = /(\d+\s?%\s?off|\bsale\b|\bdiscount|\bsave\s+(up\s+to\s+)?\$?\d|\bdeals?\b|\boffer\b|\bfree\s+(shipping|delivery|gift|returns)|\bpromo|\bcode\b|\bcoupon|\bclearance|\blimited[- ]time|\bbogo\b|buy\s+(one|1|2)|black\s+friday|cyber\s+monday|\bends\s+(soon|tonight|today|sunday|midnight))/i;

export function messageOf(ad: Pick<AuditAd, "copy">): "Offer / sale message" | "No offer (product / lifestyle)" | "Copy not returned by Meta" {
  if (!ad.copy) return "Copy not returned by Meta";
  return OFFER.test(ad.copy) ? "Offer / sale message" : "No offer (product / lifestyle)";
}

/** Format of an ad as a buyer would name it. A catalogue ad set's ads are catalogue ads whatever their creative type. */
export function adFormatOf(ad: AuditAd, adSetById: Map<string, AuditAdSet>): string {
  if (adSetById.get(ad.adSetId)?.productSetId) return "Catalogue / collection ad";
  const f = (ad.format ?? "").toUpperCase();
  if (f === "PHOTO" || f === "IMAGE") return "Static image";
  if (f === "DYNAMIC") return "Flexible / dynamic creative";
  if (f === "STATUS" || f === "POST") return "Boosted organic post";
  return formatLabel(ad);
}

export function landingTypeOf(linkUrl: string | null | undefined): string {
  if (!linkUrl) return "Link not returned by Meta";
  let path: string;
  try {
    path = new URL(linkUrl).pathname.toLowerCase();
  } catch {
    return "Link not returned by Meta";
  }
  if (/\/products?\//.test(path)) return "Product page (PDP)";
  if (/\/collections?\/|\/category\/|\/shop\b/.test(path)) return "Collection page (PLP)";
  if (path === "/" || path === "") return "Homepage";
  return "Other page";
}

// ------------------------------------------------------------------ formatting

/** The account's main outcome: the figure each table's cost and read are about. */
export type PrimaryMetric = "addToCart" | "purchases" | "leads" | "messagingConversations" | "results";

const PRIMARY_NOUN: Record<PrimaryMetric, { one: string; many: string; short: string }> = {
  addToCart: { one: "add to cart", many: "add to carts", short: "ATC" },
  purchases: { one: "purchase", many: "purchases", short: "purchase" },
  leads: { one: "lead", many: "leads", short: "lead" },
  messagingConversations: { one: "messaging conversation", many: "messaging conversations", short: "conversation" },
  results: { one: "result", many: "results", short: "result" },
};

export type Fmt = {
  currency: string;
  /** "sales" when the account records add to carts or purchases; kept for the purchases footnote. */
  mode: "sales" | "results";
  primary: PrimaryMetric;
  /** Which funnel figures the account has: every one it has gets its columns, in every table. */
  has: { lpv: boolean; atc: boolean; purchases: boolean; revenue: boolean; leads: boolean; messaging: boolean };
  /** For table cells: the currency is in the column header. */
  money: (cents: number) => string;
  money2: (cents: number) => string;
  /** For the one-line reads, which stand alone: with the currency code. */
  say: (cents: number) => string;
};

export function fmtFor(snap: MetaAuditSnapshot): Fmt {
  // Totals first; ad and ad set rows as a fallback, so a figure Meta returned anywhere gets its column.
  const rows = [snap.totals, ...snap.campaigns.map((c) => c.performance), ...snap.adSets.map((a) => a.performance), ...snap.ads.map((a) => a.performance)];
  const total = (pick: (p: PeriodPerformance) => number | null | undefined) => {
    const t = snap.totals ? pick(snap.totals) ?? 0 : 0;
    return t > 0 ? t : Math.max(0, ...rows.map((p) => (p ? pick(p) ?? 0 : 0)));
  };
  const atc = total((p) => p.addToCart);
  const purchases = total((p) => p.purchases);
  const leads = total((p) => p.leads);
  const messaging = total((p) => p.messagingConversations);
  const has = {
    lpv: total((p) => p.landingPageViews) > 0,
    atc: atc > 0,
    purchases: purchases > 0,
    revenue: total((p) => p.purchaseValueCents) > 0,
    leads: leads > 0,
    messaging: messaging > 0,
  };
  const primary: PrimaryMetric = has.atc
    ? "addToCart"
    : purchases >= MIN_VOLUME
      ? "purchases"
      : has.leads || has.messaging
        ? messaging > leads
          ? "messagingConversations"
          : "leads"
        : has.purchases
          ? "purchases"
          : "results";
  const n = (digits: number) => (cents: number) => (cents / 100).toLocaleString("en", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return { currency: snap.account.currency, mode: has.atc || has.purchases ? "sales" : "results", primary, has, money: n(0), money2: n(2), say: (cents) => `${snap.account.currency} ${n(2)(cents)}` };
}

const int = (v: number) => Math.round(v).toLocaleString("en");
const pct = (part: number, whole: number) => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "–");
/** Campaign names often contain "|" ("TR | Sales"): escaped, so the cell is not split. */
const pipe = (s: string) => s.replace(/\|/g, "\\|");

const volume = (g: Group, f: Pick<Fmt, "primary">) => g[f.primary];
/** Cost of one unit of the account's main outcome, in cents; null when there are none. */
export const unitCost = (g: Group, f: Pick<Fmt, "primary">) => (volume(g, f) > 0 ? g.spendCents / volume(g, f) : null);

type Column = { head: string; cell: (g: Group, total: Group) => string };

function columns(f: Fmt, opts: { count?: string; share?: boolean; ctr?: boolean; cpm?: boolean; lpv?: boolean }): Column[] {
  const cur = f.currency;
  const cost = (units: (g: Group) => number) => (g: Group) => (units(g) > 0 ? f.money2(g.spendCents / units(g)) : "–");
  const cols: Column[] = [];
  if (opts.count) cols.push({ head: opts.count, cell: (g) => int(g.count) });
  cols.push({ head: `Spend (${cur})`, cell: (g) => f.money(g.spendCents) });
  if (opts.share) cols.push({ head: "Share", cell: (g, t) => pct(g.spendCents, t.spendCents) });
  if (opts.cpm) cols.push({ head: `CPM (${cur})`, cell: (g) => (g.impressions > 0 ? f.money2((g.spendCents / g.impressions) * 1000) : "–") });
  if (opts.ctr) cols.push({ head: "Link CTR", cell: (g) => pct(g.linkClicks, g.impressions) });
  const lpv = opts.lpv !== false && f.has.lpv;
  if (lpv) cols.push({ head: "Landing-page views", cell: (g) => int(g.landingPageViews) });
  if (f.has.atc) {
    cols.push({ head: "Add to carts", cell: (g) => int(g.addToCart) }, { head: `Cost / ATC (${cur})`, cell: cost((g) => g.addToCart) });
    if (lpv) cols.push({ head: "ATC rate", cell: (g) => pct(g.addToCart, g.landingPageViews) });
  }
  if (f.has.purchases) {
    cols.push({ head: "Reported purchases*", cell: (g) => int(g.purchases) });
    if (!f.has.atc) cols.push({ head: `Cost / purchase (${cur})`, cell: cost((g) => g.purchases) });
  }
  if (f.has.revenue) {
    cols.push(
      { head: `Purchase value* (${cur})`, cell: (g) => f.money(g.purchaseValueCents) },
      { head: "ROAS*", cell: (g) => (g.spendCents > 0 ? `${(g.purchaseValueCents / g.spendCents).toFixed(2)}${isThinPurchases(g) ? ` ${THIN_MARK}` : ""}` : "–") },
    );
  }
  if (f.has.leads) cols.push({ head: "Leads", cell: (g) => int(g.leads) }, { head: `Cost / lead (${cur})`, cell: cost((g) => g.leads) });
  if (f.has.messaging) cols.push({ head: "Conversations", cell: (g) => int(g.messagingConversations) }, { head: `Cost / conversation (${cur})`, cell: cost((g) => g.messagingConversations) });
  if (!f.has.atc && !f.has.purchases && !f.has.leads && !f.has.messaging) {
    cols.push({ head: "Results", cell: (g) => int(g.results) }, { head: `Cost / result (${cur})`, cell: cost((g) => g.results) });
  }
  return cols;
}

function table(first: string, groups: Group[], cols: Column[], total: Group, opts: { totalRow?: boolean; extra?: Array<{ head: string; cell: (g: Group) => string }> } = {}): string {
  const extra = opts.extra ?? [];
  const head = [first, ...extra.map((e) => e.head), ...cols.map((c) => c.head)];
  const line = (cells: string[]) => `| ${cells.map(pipe).join(" | ")} |`;
  const rows = groups.map((g) => line([g.label, ...extra.map((e) => e.cell(g)), ...cols.map((c) => c.cell(g, total))]));
  const out = [line(head), `|${head.map(() => "---").join("|")}|`, ...rows];
  if (opts.totalRow !== false && groups.length > 1) out.push(line([`**Total**`, ...extra.map(() => ""), ...cols.map((c) => `**${c.cell(total, total)}**`)]));
  return out.join("\n");
}

// ------------------------------------------------------------------ the one-line reads

function read(groups: Group[], total: Group, f: Fmt, noun = "groups"): string {
  const spenders = groups.filter((g) => g.spendCents > 0);
  if (!spenders.length) return "";
  const top = [...spenders].sort((a, b) => b.spendCents - a.spendCents)[0]!;
  const parts = [`${top.label} takes ${pct(top.spendCents, total.spendCents)} of spend`];
  const metric = `cost per ${PRIMARY_NOUN[f.primary].one}`;
  // A group Meta returned no link or copy for is not a format, page or message: it is never called best or worst.
  const qualifying = spenders.filter((g) => !/not returned|no website link/i.test(g.label) && volume(g, f) >= MIN_VOLUME && g.spendCents >= total.spendCents * MIN_SHARE && unitCost(g, f) != null);
  const overall = unitCost(total, f);
  if (qualifying.length >= 2) {
    const sorted = [...qualifying].sort((a, b) => unitCost(a, f)! - unitCost(b, f)!);
    const best = sorted[0]!;
    const worst = sorted[sorted.length - 1]!;
    parts.push(`lowest ${metric}: ${best.label} at ${f.say(unitCost(best, f)!)}${overall != null ? ` (overall ${f.say(overall)})` : ""}`);
    if (worst !== best) parts.push(`highest: ${worst.label} at ${f.say(unitCost(worst, f)!)}`);
  } else {
    parts.push(`too few ${noun} with ${MIN_VOLUME}+ ${PRIMARY_NOUN[f.primary].many} to compare costs reliably`);
  }
  return `*Read: ${parts.join("; ")}.*`;
}

// ------------------------------------------------------------------ the tables

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Oct 2025", or "Oct 2026 (1-21)" for a month the period only partly covers. */
export function monthLabel(month: string, since: string, until: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const base = `${MONTHS[m - 1]} ${y}`;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const from = since.startsWith(month) ? Number(since.slice(8, 10)) : 1;
  const to = until.startsWith(month) ? Number(until.slice(8, 10)) : last;
  return from === 1 && to === last ? base : `${base} (${from}-${to})`;
}

export function monthlyTable(snap: MetaAuditSnapshot, f: Fmt): string | null {
  if (!snap.monthly?.length) return null;
  const campaignById = new Map(snap.campaigns.map((c) => [c.id, c]));
  // Only sales campaigns when they carry most of the spend (a sales account); otherwise every campaign,
  // so a messaging or lead account with one small sales test is not reduced to that test.
  const isSales = (r: { campaignId: string }) => Boolean(campaignById.get(r.campaignId) && isSalesCampaign(campaignById.get(r.campaignId)!));
  const spent = snap.monthly.filter((r) => delivered(r.performance));
  const salesSpend = spent.filter(isSales).reduce((t, r) => t + r.performance.spendCents, 0);
  const allSpend = spent.reduce((t, r) => t + r.performance.spendCents, 0);
  const anySales = allSpend > 0 && salesSpend / allSpend >= 0.5;
  const rows = spent.filter((r) => !anySales || isSales(r));
  const months = [...new Set(rows.map((r) => r.month))].sort();
  if (months.length < 2) return null;
  const groups = months.map((m) => {
    const inMonth = rows.filter((r) => r.month === m);
    return groupOf(monthLabel(m, snap.period.since, snap.period.until), inMonth.map((r) => r.performance), new Set(inMonth.map((r) => r.campaignId)).size);
  });
  const total = groupOf("Total", rows.map((r) => r.performance), new Set(rows.map((r) => r.campaignId)).size);
  const cols = columns(f, { count: anySales ? "Sales campaigns" : "Campaigns", cpm: true });
  const out = [`### ${anySales ? "Sales campaigns" : "Campaigns"} month by month`, "", table("Month", groups, cols, total)];
  // The read for a trend: the cheapest and dearest full-volume months, and spend at the start against the end.
  const q = groups.filter((g) => volume(g, f) >= MIN_VOLUME);
  const parts: string[] = [];
  if (q.length >= 2) {
    const sorted = [...q].sort((a, b) => unitCost(a, f)! - unitCost(b, f)!);
    const metric = `cost per ${PRIMARY_NOUN[f.primary].one}`;
    parts.push(`lowest ${metric} in ${sorted[0]!.label} (${f.say(unitCost(sorted[0]!, f)!)}), highest in ${sorted[sorted.length - 1]!.label} (${f.say(unitCost(sorted[sorted.length - 1]!, f)!)})`);
  }
  const busiest = [...groups].sort((a, b) => b.spendCents - a.spendCents)[0]!;
  parts.push(`most spend in ${busiest.label} (${f.currency} ${f.money(busiest.spendCents)})`);
  out.push("", `*Read: ${parts.join("; ")}.*`);
  // The table's total is the sales campaigns alone, so it is lower than the account total on purpose: say so.
  if (anySales && salesSpend < allSpend) {
    out.push("", `*Sales campaigns only: ${f.currency} ${f.money(salesSpend)} of ${f.currency} ${f.money(allSpend)} spent (${pct(salesSpend, allSpend)}); the rest went to other objectives (traffic, awareness, messaging) and is in the account totals.*`);
  }
  return out.join("\n");
}

export function campaignTable(snap: MetaAuditSnapshot, f: Fmt): string | null {
  const audiences = new Map(snap.audiences.map((a) => [a.id, a]));
  const spent = snap.campaigns.filter((c) => delivered(c.performance)).sort((a, b) => b.performance!.spendCents - a.performance!.spendCents);
  if (!spent.length) return null;
  const profiles = new Map(spent.map((c) => [c.id, campaignProfile(c, snap.adSets, audiences)]));
  const status = (s: string) => (s === "ACTIVE" ? "Active" : s === "WITH_ISSUES" ? "Issues" : /PAUSED/.test(s) ? "Paused" : s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " "));
  const groups = spent.map((c) => ({ ...groupOf(c.name, [c.performance], 1), id: c.id }));
  const total = groupOf("Total", spent.map((c) => c.performance), spent.length);
  const cols = columns(f, {});
  const byId = new Map(spent.map((c) => [c.id, c]));
  const out = [
    "### Campaigns by type",
    "",
    table("Campaign", groups, cols, total, {
      extra: [
        { head: "Type", cell: (g) => profiles.get((g as Group & { id: string }).id)?.type ?? "—" },
        { head: "Audience", cell: (g) => profiles.get((g as Group & { id: string }).id)?.audience ?? "—" },
        { head: "Status", cell: (g) => status(byId.get((g as Group & { id: string }).id)?.status ?? "") },
      ],
    }),
  ];
  // The read by type, so it says something the rows alone don't.
  const byType = new Map<string, AuditCampaign[]>();
  for (const c of spent) {
    const t = (profiles.get(c.id)?.type ?? "—").replace(/ \(mixed\)$/, "");
    byType.set(t, [...(byType.get(t) ?? []), c]);
  }
  const typeGroups = [...byType.entries()].map(([t, cs]) => groupOf(t, cs.map((c) => c.performance), cs.length));
  const line = read(typeGroups, total, f, "campaign types");
  if (line) out.push("", line);
  return out.join("\n");
}

function adSetGroupsBy(snap: MetaAuditSnapshot, key: (a: AuditAdSet) => string): Group[] {
  const groups = new Map<string, AuditAdSet[]>();
  for (const a of snap.adSets) {
    if (!delivered(a.performance)) continue;
    groups.set(key(a), [...(groups.get(key(a)) ?? []), a]);
  }
  const adsIn = (ids: Set<string>) => snap.ads.filter((ad) => ids.has(ad.adSetId) && delivered(ad.performance)).length;
  return [...groups.entries()]
    .map(([label, sets]) => groupOf(label, sets.map((s) => s.performance), adsIn(new Set(sets.map((s) => s.id)))))
    .sort((a, b) => b.spendCents - a.spendCents);
}

function adGroupsBy(snap: MetaAuditSnapshot, key: (a: AuditAd) => string): Group[] {
  const groups = new Map<string, AuditAd[]>();
  for (const ad of snap.ads) {
    if (!delivered(ad.performance)) continue;
    groups.set(key(ad), [...(groups.get(key(ad)) ?? []), ad]);
  }
  return [...groups.entries()].map(([label, ads]) => groupOf(label, ads.map((a) => a.performance))).sort((a, b) => b.spendCents - a.spendCents);
}

const totalOf = (groups: Group[]) =>
  groups.reduce<Group>(
    (t, g) => ({
      label: "Total",
      count: t.count + g.count,
      spendCents: t.spendCents + g.spendCents,
      impressions: t.impressions + g.impressions,
      linkClicks: t.linkClicks + g.linkClicks,
      landingPageViews: t.landingPageViews + g.landingPageViews,
      addToCart: t.addToCart + g.addToCart,
      purchases: t.purchases + g.purchases,
      purchaseValueCents: t.purchaseValueCents + g.purchaseValueCents,
      leads: t.leads + g.leads,
      messagingConversations: t.messagingConversations + g.messagingConversations,
      results: t.results + g.results,
    }),
    { label: "Total", count: 0, spendCents: 0, impressions: 0, linkClicks: 0, landingPageViews: 0, addToCart: 0, purchases: 0, purchaseValueCents: 0, leads: 0, messagingConversations: 0, results: 0 },
  );

function section(title: string, first: string, groups: Group[], f: Fmt, opts: Parameters<typeof columns>[1], noun: string, note?: string): string | null {
  // A split with one group compares nothing.
  if (groups.length < 2) return null;
  const total = totalOf(groups);
  const out = [`### ${title}`, "", table(first, groups, columns(f, opts), total)];
  const line = read(groups, total, f, noun);
  if (line) out.push("", line);
  if (note) out.push("", note);
  return out.join("\n");
}

export function audienceTable(snap: MetaAuditSnapshot, f: Fmt): string | null {
  const audiences = new Map(snap.audiences.map((a) => [a.id, a]));
  return section("Audience types", "Audience", adSetGroupsBy(snap, (a) => audienceTypeOf(a, audiences)), f, { count: "Ads", share: true, ctr: true }, "audience types",
    "*Grouped from what each ad set targets (custom audiences, lookalikes, interests, product sets), not from its name.*");
}

export function formatTable(snap: MetaAuditSnapshot, f: Fmt): string | null {
  const adSetById = new Map(snap.adSets.map((a) => [a.id, a]));
  return section("Ad formats", "Format", adGroupsBy(snap, (ad) => adFormatOf(ad, adSetById)), f, { count: "Ads", share: true, ctr: true }, "formats");
}

export function messageTable(snap: MetaAuditSnapshot, f: Fmt): string | null {
  const groups = adGroupsBy(snap, messageOf);
  if (!groups.some((g) => g.label !== "Copy not returned by Meta")) return null;
  return section("Offer vs no offer", "Message", groups, f, { count: "Ads", share: true, ctr: true }, "message types",
    "*An offer message mentions a discount, sale, deal, code or free shipping in the ad's own text.*");
}

export function landingTable(snap: MetaAuditSnapshot, f: Fmt): string | null {
  const groups = adGroupsBy(snap, (ad) => landingTypeOf(ad.linkUrl));
  if (!groups.some((g) => g.label !== "Link not returned by Meta")) return null;
  return section("Landing page type", "Destination", groups, f, { count: "Ads", share: true, ctr: true }, "destinations");
}

const PLATFORM: Record<string, string> = { facebook: "Facebook", instagram: "Instagram", audience_network: "Audience Network", messenger: "Messenger", threads: "Threads" };
const POSITION: Record<string, string> = {
  feed: "Feed", story: "Stories", instagram_stories: "Stories", reels: "Reels", facebook_reels: "Reels", instagram_reels: "Reels", marketplace: "Marketplace",
  video_feeds: "Video feeds", search: "Search", instream_video: "In-stream video", rewarded_video: "Rewarded video", instagram_explore: "Explore",
  instagram_explore_grid_home: "Explore home", right_hand_column: "Right column", an_classic: "Native, banner & interstitial", facebook_profile_feed: "Profile feed",
  instagram_profile_feed: "Profile feed", messenger_inbox: "Inbox", facebook_stories: "Stories", threads_feed: "Feed",
};

export function placementTable(snap: MetaAuditSnapshot, f: Fmt): string | null {
  if (!snap.placementPositions?.length) return null;
  const groups = snap.placementPositions
    .filter((p) => delivered(p.performance))
    .map((p) => groupOf(`${PLATFORM[p.platform] ?? p.platform} – ${POSITION[p.position] ?? p.position.replace(/_/g, " ")}`, [p.performance], 1))
    .sort((a, b) => b.spendCents - a.spendCents)
    .slice(0, 10);
  return section("Placements", "Placement", groups, f, { share: true, cpm: true, lpv: false }, "placements");
}

export function demographicTables(snap: MetaAuditSnapshot, f: Fmt): string | null {
  if (!snap.demographics?.length) return null;
  const by = (key: (d: { age: string; gender: string }) => string) => {
    const m = new Map<string, PeriodPerformance[]>();
    for (const d of snap.demographics!) m.set(key(d), [...(m.get(key(d)) ?? []), d.performance]);
    return [...m.entries()].map(([k, v]) => groupOf(k, v, v.length)).filter((g) => g.spendCents > 0);
  };
  const gender = (g: string) => (g === "female" ? "Women" : g === "male" ? "Men" : "Unknown");
  const ages = by((d) => d.age).sort((a, b) => a.label.localeCompare(b.label, "en", { numeric: true }));
  const genders = by((d) => gender(d.gender)).sort((a, b) => b.spendCents - a.spendCents);
  const out = [section("Age", "Age", ages, f, { share: true, lpv: false }, "age groups"), section("Gender", "Gender", genders, f, { share: true, lpv: false }, "genders")].filter(Boolean);
  return out.length ? out.join("\n\n") : null;
}

const WINDOW: Record<string, string> = { "7d_click": "7-day click", "1d_click": "1-day click", "28d_click": "28-day click", "1d_view": "1-day view", "7d_view": "7-day view" };

/** The attribution window most of the spend is counted in, in words. */
export function attributionLabel(snap: MetaAuditSnapshot): string | null {
  const spendBy = new Map<string, number>();
  for (const a of snap.adSets) {
    if (!delivered(a.performance) || !a.attributionWindows.length) continue;
    const k = a.attributionWindows.map((w) => WINDOW[w] ?? w).join(" + ");
    spendBy.set(k, (spendBy.get(k) ?? 0) + a.performance!.spendCents);
  }
  const top = [...spendBy.entries()].sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] + (spendBy.size > 1 ? " on most spend" : "") : null;
}

/** Every performance table that has data, as one markdown block (no heading of its own: it goes under the writer's section heading). */
export function renderPerformanceTables(snap: MetaAuditSnapshot): string {
  const f = fmtFor(snap);
  const parts = [monthlyTable, campaignTable, audienceTable, formatTable, messageTable, landingTable, placementTable, demographicTables]
    .map((build) => build(snap, f))
    .filter((p): p is string => Boolean(p));
  if (!parts.length) return "";
  const notes: string[] = [];
  if (f.has.purchases || f.has.revenue) {
    const window = attributionLabel(snap);
    notes.push(
      `*Reported purchases${f.has.revenue ? ", purchase value and ROAS" : ""}: as Meta reports them${window ? ` (${window} attribution)` : ""}, Meta's own claim and not verified sales.${f.has.atc && f.has.lpv ? " ATC rate = add to carts ÷ landing-page views." : ""}*`,
    );
  }
  if (parts.some((p) => p.includes(` ${THIN_MARK}`))) {
    notes.push(`*${THIN_MARK} Fewer than ${THIN_PURCHASES} reported purchases behind this ROAS: too little to judge, so it is not a winner or a loser.*`);
  }
  const accountSpend = snap.totals?.spendCents ?? 0;
  const adSpend = snap.ads.reduce((a, x) => a + (x.performance?.spendCents ?? 0), 0);
  if (!snap.scope && accountSpend > 0 && accountSpend - adSpend > accountSpend * 0.01) {
    notes.push(`*Ad-level tables cover ${f.money(adSpend)} of ${f.money(accountSpend)} ${f.currency}: the rest was spent by ads Meta no longer lists.*`);
  }
  return [...parts, ...notes].join("\n\n");
}

/**
 * Put the tables into the writer's report: where the writer left the marker; failing that, right
 * under its "Performance Breakdown" heading; failing that, before "Risks & Issues"; else at the end.
 */
export function insertPerformanceTables(report: string, tables: string): string {
  if (!tables.trim()) return report.replace(PERFORMANCE_TABLES_MARKER, "").replace(/\n{3,}/g, "\n\n");
  if (report.includes(PERFORMANCE_TABLES_MARKER)) return report.replace(PERFORMANCE_TABLES_MARKER, tables);
  const lines = report.split("\n");
  const heading = lines.findIndex((l) => /^#{1,3}\s*(\d+\.\s*)?Performance Breakdown\b/i.test(l.trim()));
  if (heading >= 0) {
    lines.splice(heading + 1, 0, "", tables, "");
    return lines.join("\n");
  }
  const risks = lines.findIndex((l) => /^#{1,3}\s*(\d+\.\s*)?Risks\b/i.test(l.trim()));
  const block = ["## Performance Breakdown", "", tables, ""];
  if (risks >= 0) {
    lines.splice(risks, 0, ...block);
    return lines.join("\n");
  }
  return `${report.trimEnd()}\n\n${block.join("\n")}`;
}

// ------------------------------------------------------------------ landing pages

/** The marker the writer puts in the Landing Pages section. */
export const LANDING_PAGE_TABLES_MARKER = "[[LANDING_PAGE_TABLES]]";

/** No website destination: Messenger, Instagram Direct, WhatsApp, calls, lead forms, or a link Meta didn't return. */
export const NO_WEBSITE_LINK = "No website link (messaging, call, lead form or not returned)";

/** One page, whatever the tracking parameters: "https://Shop.com/products/x/?utm_source=fb" and "https://shop.com/products/x" are the same page. */
export function pageKey(url: string | null | undefined): string | null {
  if (!url || !/^https?:\/\//i.test(url.trim())) return null;
  try {
    const u = new URL(url.trim());
    const path = u.pathname.replace(/\/+$/, "") || "/";
    return `${u.hostname.toLowerCase().replace(/^www\./, "")}${path === "/" ? "" : path}`;
  } catch {
    return null;
  }
}

/** A page as it is shown in a table: host and path, shortened from the middle when long. */
export function pageLabel(key: string, max = 52): string {
  if (key.length <= max) return key;
  const keep = max - 1;
  return `${key.slice(0, Math.ceil(keep * 0.55))}…${key.slice(key.length - Math.floor(keep * 0.45))}`;
}

/** What the landing page check measured, as the table needs it (a structural subset of the analysis). */
export type LandingCheck = {
  url: string;
  role: "own" | "competitor";
  score100?: number | null;
  messageMatch: string;
  checks?: {
    httpStatus: number | null;
    reachable: boolean | null;
    mobileLcpMs: number | null;
    pageSpeed: number | null;
    formFields: number | null;
    metaPixel: boolean | null;
    keepsTracking: boolean | null;
    trust: boolean;
    cta: boolean;
  };
};

/** Every page the audited ads sent people to, by spend (pages of ads that didn't spend are left out). */
export function landingPageGroups(snap: MetaAuditSnapshot): Array<Group & { key: string | null; urls: string[] }> {
  const byKey = new Map<string, { key: string | null; urls: Set<string>; ads: AuditAd[] }>();
  for (const ad of snap.ads) {
    if (!delivered(ad.performance)) continue;
    const key = pageKey(ad.linkUrl);
    const k = key ?? NO_WEBSITE_LINK;
    const entry = byKey.get(k) ?? { key, urls: new Set<string>(), ads: [] };
    if (ad.linkUrl) entry.urls.add(ad.linkUrl.trim());
    entry.ads.push(ad);
    byKey.set(k, entry);
  }
  return [...byKey.entries()]
    .map(([label, e]) => ({ ...groupOf(e.key ? pageLabel(label) : label, e.ads.map((a) => a.performance)), key: e.key, urls: [...e.urls] }))
    .sort((a, b) => b.spendCents - a.spendCents);
}

const yesNo = (v: boolean | null | undefined, yes = "Yes", no = "No") => (v == null ? "–" : v ? yes : no);
const MATCH_WORD: Record<string, string> = { exact: "Strong", partial: "Partial", weak: "Weak", mismatch: "Mismatch", unknown: "–" };

/**
 * The Landing Pages section's tables: every page that took spend in the period with its numbers,
 * then the checks for each page that was analysed (score, message match, mobile speed, form,
 * pixel, tracking kept through redirects, trust and call to action).
 */
export function renderLandingPageTables(snap: MetaAuditSnapshot, analyses: LandingCheck[] = []): string {
  const f = fmtFor(snap);
  const groups = landingPageGroups(snap);
  if (!groups.length) return "";
  const total = totalOf(groups);
  const out: string[] = ["### Landing pages in this period", "", table("Page", groups, columns(f, { count: "Ads", share: true, ctr: true }), total)];
  const withPage = groups.filter((g) => g.key);
  const none = groups.find((g) => !g.key);
  const facts: string[] = [`${withPage.length} landing page${withPage.length === 1 ? "" : "s"} took spend`];
  if (none) facts.push(`${pct(none.spendCents, total.spendCents)} of ad spend went to ads with no website link (messaging, call or lead-form ads, or a link Meta didn't return)`);
  out.push("", `*Read: ${facts.join("; ")}.*`);
  // Shares and the overall cost are the table's own (all spend, linked or not), so the read never disagrees with the table above it.
  const line = withPage.length >= 2 ? read(withPage, total, f, "pages") : "";
  if (line) out.push("", line);

  const own = analyses.filter((a) => a.role === "own");
  const analysedKeys = new Set(own.map((a) => pageKey(a.url)).filter(Boolean));
  if (own.length) {
    const spendBy = new Map(withPage.map((g) => [g.key, g.spendCents]));
    const rows = [...own].sort((a, b) => (spendBy.get(pageKey(b.url)) ?? 0) - (spendBy.get(pageKey(a.url)) ?? 0));
    const head = ["Page", "Score", "Message match", "Mobile LCP", "PageSpeed", "Form fields", "Meta pixel", "UTMs kept", "Trust", "CTA"];
    const cells = (a: LandingCheck) => {
      const c = a.checks;
      const dead = c?.reachable === false;
      return [
        pageLabel(pageKey(a.url) ?? a.url),
        dead ? `0 (HTTP ${c?.httpStatus ?? "error"})` : a.score100 != null ? `${a.score100}/100` : "–",
        MATCH_WORD[a.messageMatch] ?? a.messageMatch,
        c?.mobileLcpMs != null ? `${(c.mobileLcpMs / 1000).toFixed(1)} s` : "–",
        c?.pageSpeed != null ? `${c.pageSpeed}/100` : "–",
        c?.formFields != null ? String(c.formFields) : "–",
        yesNo(c?.metaPixel, "Found", "Not found"),
        yesNo(c?.keepsTracking),
        c ? yesNo(c.trust) : "–",
        c ? yesNo(c.cta) : "–",
      ];
    };
    out.push(
      "",
      "### Landing page checks",
      "",
      `| ${head.join(" | ")} |`,
      `|${head.map(() => "---").join("|")}|`,
      ...rows.map((a) => `| ${cells(a).map(pipe).join(" | ")} |`),
      "",
      "*Mobile LCP: how long the main content takes to appear on a phone (under 2.5 s is good). Meta pixel \"Not found\" means it isn't in the page source; it may still load through a tag manager.*",
    );
  }
  const unchecked = withPage.filter((g) => !analysedKeys.has(g.key));
  if (unchecked.length && own.length) out.push("", `*Not analysed (lower spend): ${unchecked.map((g) => g.label).join(", ")}.*`);
  const competitors = analyses.filter((a) => a.role === "competitor");
  if (competitors.length) {
    out.push(
      "",
      "### Competitor pages",
      "",
      "| Page | Score | Mobile LCP | Form fields | Trust | CTA |",
      "|---|---|---|---|---|---|",
      ...competitors.map(
        (a) =>
          `| ${pipe(pageLabel(pageKey(a.url) ?? a.url))} | ${a.score100 != null ? `${a.score100}/100` : "–"} | ${a.checks?.mobileLcpMs != null ? `${(a.checks.mobileLcpMs / 1000).toFixed(1)} s` : "–"} | ${a.checks?.formFields ?? "–"} | ${a.checks ? yesNo(a.checks.trust) : "–"} | ${a.checks ? yesNo(a.checks.cta) : "–"} |`,
      ),
    );
  }
  return out.join("\n");
}

/** The pages worth analysing: by spend, up to `limit`, with the first matching ad's words for the message-match check. */
export function landingTargets(snap: MetaAuditSnapshot, limit = 8): Array<{ url: string; key: string; adContext: string | null }> {
  return landingPageGroups(snap)
    .filter((g) => g.key)
    .slice(0, limit)
    .map((g) => {
      const ad = snap.ads.find((a) => pageKey(a.linkUrl) === g.key && a.copy);
      return { url: g.urls[0]!, key: g.key!, adContext: ad?.copy ?? null };
    });
}

/** Put the landing page tables where the writer left the marker, or under its Landing Pages heading, or before Risks. */
export function insertLandingPageTables(report: string, tables: string): string {
  if (!tables.trim()) return report.replace(LANDING_PAGE_TABLES_MARKER, "").replace(/\n{3,}/g, "\n\n");
  if (report.includes(LANDING_PAGE_TABLES_MARKER)) return report.replace(LANDING_PAGE_TABLES_MARKER, tables);
  const lines = report.split("\n");
  const heading = lines.findIndex((l) => /^#{1,3}\s*(\d+\.\s*)?Landing Pages?\b/i.test(l.trim()));
  if (heading >= 0) {
    lines.splice(heading + 1, 0, "", tables, "");
    return lines.join("\n");
  }
  const risks = lines.findIndex((l) => /^#{1,3}\s*(\d+\.\s*)?Risks\b/i.test(l.trim()));
  const block = ["## Landing Pages", "", tables, ""];
  if (risks >= 0) {
    lines.splice(risks, 0, ...block);
    return lines.join("\n");
  }
  return `${report.trimEnd()}\n\n${block.join("\n")}`;
}
