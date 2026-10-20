import type { MetaAd, MetaAdSet, MetaCampaign, MetaInsightsQuery, MetaInsightsReport } from "./provider";

/**
 * Demo rows for the flexible Meta insights read (meta_insights). Built from the
 * mock campaigns' own figures; ClickTrends' ads and catalog products add up to
 * its campaigns (Bar Stools $2,100 at ROAS 3.1, Sofas $1,200 at ROAS 1.6).
 */

type Base = {
  campaign: MetaCampaign;
  adset?: { id: string; name: string };
  ad?: { id: string; name: string };
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenue: number;
};

type CampaignFigures = { spend: number; impressions: number; clicks: number; conversions: number };

/** ROAS per demo campaign; others earn a flat value per result. */
const CAMPAIGN_ROAS: Record<string, number> = { ct_campaign_asc: 3.1, ct_campaign_rt: 1.6 };

/** ClickTrends' ads: share of their campaign's figures. */
const CT_ADS: Record<string, Array<{ id: string; name: string; adset: string; share: number }>> = {
  ct_campaign_asc: [
    { id: "ct_ad_oak", name: "Oak Counter Stool | Image", adset: "Bar Stools | Broad", share: 0.6 },
    { id: "ct_ad_swivel", name: "Swivel Bar Stool | Video", adset: "Bar Stools | Broad", share: 0.4 },
  ],
  ct_campaign_rt: [{ id: "ct_ad_sofa", name: "Modern Sofa | Retargeting", adset: "Sofas | Site visitors 30d", share: 1 }],
};

/** Catalog products per ClickTrends campaign (product_id breakdown). */
const CT_PRODUCTS: Record<string, Record<string, number>> = {
  ct_campaign_asc: { "BS-OAK-01": 1100 / 2100, "BS-SWV-02": 650 / 2100, "BS-BKL-03": 350 / 2100 },
  ct_campaign_rt: { "SF-MOD-01": 700 / 1200, "SF-VLV-02": 500 / 1200 },
};

const SHARES: Record<string, Record<string, number>> = {
  age: { "18-24": 0.1, "25-34": 0.35, "35-44": 0.3, "45-54": 0.15, "55-64": 0.1 },
  gender: { female: 0.55, male: 0.42, unknown: 0.03 },
  country: { US: 1 },
  region: { California: 0.4, Texas: 0.35, "New York": 0.25 },
  publisher_platform: { facebook: 0.6, instagram: 0.4 },
  platform_position: { feed: 0.55, instagram_reels: 0.25, instagram_stories: 0.2 },
  device_platform: { mobile_app: 0.8, desktop: 0.2 },
  impression_device: { iphone: 0.5, android_smartphone: 0.3, desktop: 0.2 },
};

function sharesFor(breakdown: string, base: Base): Record<string, number> {
  if (breakdown === "product_id") return CT_PRODUCTS[base.campaign.id] ?? { "DEMO-PRODUCT-1": 1 };
  const shares = SHARES[breakdown];
  if (!shares) throw new Error(`(#100) The demo Meta data has no "${breakdown}" breakdown.`);
  return shares;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function baseRows(
  query: MetaInsightsQuery,
  campaigns: MetaCampaign[],
  adsets: MetaAdSet[],
  ads: MetaAd[],
  figures: (campaign: MetaCampaign) => CampaignFigures,
): Base[] {
  const out: Base[] = [];
  for (const campaign of campaigns) {
    const f = figures(campaign);
    const roas = CAMPAIGN_ROAS[campaign.id];
    const revenue = roas != null ? f.spend * roas : 45 * f.conversions;
    const whole: Base = { campaign, ...f, revenue };
    const scaled = (share: number, extra: Partial<Base>): Base => ({
      ...whole,
      ...extra,
      spend: f.spend * share,
      impressions: Math.round(f.impressions * share),
      clicks: Math.round(f.clicks * share),
      conversions: Math.round(f.conversions * share),
      revenue: revenue * share,
    });
    if (query.level === "campaign" || query.level === "account") {
      out.push(whole);
      continue;
    }
    const ctAds = CT_ADS[campaign.id];
    const ownAds = ads.filter((a) => a.campaign_id === campaign.id);
    const ownSets = adsets.filter((a) => a.campaign_id === campaign.id);
    if (query.level === "ad") {
      if (ctAds) {
        for (const ad of ctAds) {
          out.push(scaled(ad.share, { ad: { id: ad.id, name: ad.name }, adset: { id: `${campaign.id}_set`, name: ad.adset } }));
        }
      } else if (ownAds.length) {
        for (const ad of ownAds) {
          const set = ownSets.find((s) => s.id === ad.adset_id);
          out.push(scaled(1 / ownAds.length, { ad: { id: ad.id, name: ad.name }, adset: { id: ad.adset_id, name: set?.name ?? ad.adset_id } }));
        }
      } else {
        out.push(scaled(1, { ad: { id: `${campaign.id}_ad`, name: `${campaign.name} — Ad` }, adset: { id: `${campaign.id}_set`, name: `${campaign.name} — Ad set` } }));
      }
      continue;
    }
    const sets = ctAds
      ? [...new Set(ctAds.map((a) => a.adset))].map((name) => ({ id: `${campaign.id}_set`, name }))
      : ownSets.length
        ? ownSets.map((s) => ({ id: s.id, name: s.name }))
        : [{ id: `${campaign.id}_set`, name: `${campaign.name} — Ad set` }];
    for (const set of sets) out.push(scaled(1 / sets.length, { adset: set }));
  }
  return out.filter(
    (b) =>
      (!query.campaign_ids?.length || query.campaign_ids.includes(b.campaign.id)) &&
      (!query.adset_ids?.length || (b.adset && query.adset_ids.includes(b.adset.id))) &&
      (!query.ad_ids?.length || (b.ad && query.ad_ids.includes(b.ad.id))),
  );
}

type Row = { keys: Record<string, string>; base: Base; spend: number; impressions: number; clicks: number; conversions: number; revenue: number };

function fieldValue(field: string, row: Row, accountId: string, accountName: string, query: MetaInsightsQuery): unknown {
  const { spend, impressions, clicks, conversions, revenue, base } = row;
  switch (field) {
    case "spend": return round2(spend);
    case "impressions": return impressions;
    case "clicks": return clicks;
    case "reach": return Math.round(impressions * 0.55);
    case "frequency": return 1.8;
    case "ctr": return impressions ? round2((clicks / impressions) * 100) : 0;
    case "cpc": return clicks ? round2(spend / clicks) : 0;
    case "cpm": return impressions ? round2((spend / impressions) * 1000) : 0;
    case "actions": return { purchase: conversions };
    case "action_values": return { purchase: round2(revenue) };
    case "purchase_roas": return { omni_purchase: spend ? round2(revenue / spend) : 0 };
    case "cost_per_action_type": return { purchase: conversions ? round2(spend / conversions) : 0 };
    case "account_id": return accountId.replace(/^act_/, "");
    case "account_name": return accountName;
    case "campaign_id": return base.campaign.id;
    case "campaign_name": return base.campaign.name;
    case "objective": return base.campaign.objective;
    case "adset_id": return base.adset?.id;
    case "adset_name": return base.adset?.name;
    case "ad_id": return base.ad?.id;
    case "ad_name": return base.ad?.name;
    case "date_start": return query.time_range?.since ?? query.date_preset ?? "last_30d";
    case "date_stop": return query.time_range?.until ?? query.date_preset ?? "last_30d";
    default: return undefined;
  }
}

export function mockInsightsReport(input: {
  accountId: string;
  accountName: string;
  currency: string;
  query: MetaInsightsQuery;
  campaigns: MetaCampaign[];
  adsets: MetaAdSet[];
  ads: MetaAd[];
  figures: (campaign: MetaCampaign) => CampaignFigures;
}): MetaInsightsReport {
  const { query } = input;
  const breakdowns = query.breakdowns ?? [];
  let rows: Row[] = baseRows(query, input.campaigns, input.adsets, input.ads, input.figures).map((base) => ({
    keys: {},
    base,
    spend: base.spend,
    impressions: base.impressions,
    clicks: base.clicks,
    conversions: base.conversions,
    revenue: base.revenue,
  }));
  for (const breakdown of breakdowns) {
    rows = rows.flatMap((row) =>
      Object.entries(sharesFor(breakdown, row.base)).map(([value, share]) => ({
        ...row,
        keys: { ...row.keys, [breakdown]: value },
        spend: row.spend * share,
        impressions: Math.round(row.impressions * share),
        clicks: Math.round(row.clicks * share),
        conversions: Math.round(row.conversions * share),
        revenue: row.revenue * share,
      })),
    );
  }
  // Account level: one row per breakdown value across every campaign.
  if (query.level === "account") {
    const merged = new Map<string, Row>();
    for (const row of rows) {
      const key = JSON.stringify(row.keys);
      const seen = merged.get(key);
      if (!seen) merged.set(key, { ...row });
      else {
        seen.spend += row.spend;
        seen.impressions += row.impressions;
        seen.clicks += row.clicks;
        seen.conversions += row.conversions;
        seen.revenue += row.revenue;
      }
    }
    rows = [...merged.values()];
  }
  const out = rows.map((row) => {
    const record: Record<string, unknown> = {};
    for (const field of query.fields) {
      if (query.level === "account" && /^(?:campaign|adset|ad)_/.test(field)) continue;
      const value = fieldValue(field, row, input.accountId, input.accountName, query);
      if (value !== undefined) record[field] = value;
    }
    return { ...record, ...row.keys };
  });
  return { currency: input.currency, rows: out.slice(0, query.limit), has_more: out.length > query.limit };
}
