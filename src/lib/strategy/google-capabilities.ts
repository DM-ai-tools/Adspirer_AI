import type { AdsPerformance } from "@/lib/google/types";

export type GoogleCapabilityId = "google_search" | "google_shopping" | "google_pmax" | "google_demand_gen";

export type GoogleCapabilityStatus = {
  id: GoogleCapabilityId;
  label: string;
  why: string;
  state: "in_use" | "not_used" | "needs_feed" | "unknown";
};

type GoogleCapability = {
  id: GoogleCapabilityId;
  label: string;
  why: string;
  /** Google's advertising_channel_type for this campaign type. */
  channelType: string;
  needsFeed: boolean;
};

const GOOGLE_CAPABILITIES: readonly GoogleCapability[] = [
  {
    id: "google_search",
    label: "Search campaigns",
    why: "Captures people already searching for what you sell, usually the highest-intent conversions toward a ROAS goal.",
    channelType: "SEARCH",
    needsFeed: false,
  },
  {
    id: "google_shopping",
    label: "Shopping campaigns",
    why: "Shows your products with price and image to ready-to-buy shoppers, which lifts ROAS on product sales.",
    channelType: "SHOPPING",
    needsFeed: true,
  },
  {
    id: "google_pmax",
    label: "Performance Max",
    why: "Lets Google's automation spread budget across all its channels toward your best-converting products.",
    channelType: "PERFORMANCE_MAX",
    needsFeed: true,
  },
  {
    id: "google_demand_gen",
    label: "Demand Gen",
    why: "Reaches likely buyers on YouTube and Discover with visual ads, adding new demand beyond search.",
    channelType: "DEMAND_GEN",
    needsFeed: false,
  },
];

/** Each Google campaign type the plan can recommend, with whether the account runs it. */
export function detectGoogleCapabilities(ads: AdsPerformance | null): GoogleCapabilityStatus[] {
  return GOOGLE_CAPABILITIES.map(({ id, label, why, channelType, needsFeed }) => {
    let state: GoogleCapabilityStatus["state"];
    if (ads === null) state = "unknown";
    else if (ads.campaigns.some((c) => c.type === channelType && c.costCents > 0)) state = "in_use";
    else if (needsFeed && !ads.merchantCenterLinked) state = "needs_feed";
    else state = "not_used";
    return { id, label, why, state };
  });
}

/** Campaign types worth recommending for the Google Ads account, feed-based type first. */
export function recommendGoogleCampaignTypes(input: {
  tier: "proven" | "promising" | "test" | "hold";
  merchantCenterLinked: boolean;
  searchImpressions: number;
}): GoogleCapabilityId[] {
  if (input.tier === "hold") return [];
  const out: GoogleCapabilityId[] = [];
  if (input.merchantCenterLinked) out.push(input.tier === "proven" ? "google_pmax" : "google_shopping");
  if (input.searchImpressions > 0) out.push("google_search");
  return out;
}
