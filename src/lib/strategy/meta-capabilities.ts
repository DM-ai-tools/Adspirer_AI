import type { AuditAd, AuditAdSet, AuditCampaign, MetaAuditSnapshot } from "@/lib/audit/meta-audit-data";
import type { BUSINESS_MODELS } from "@/lib/clients/goals";

export type CapabilityState = "in_use" | "not_used" | "unknown";

export type MetaCapabilityId =
  | "advantage_plus_sales"
  | "catalog_ads"
  | "website_retargeting"
  | "lookalike_audiences"
  | "broad_advantage_audience"
  | "video_creative"
  | "dynamic_creative"
  | "instant_forms"
  | "automatic_placements"
  | "cost_or_roas_controls";

export type MetaCapability = {
  id: MetaCapabilityId;
  label: string;
  why: string;
  businessModels: ReadonlyArray<(typeof BUSINESS_MODELS)[number]> | "all";
  detect(snapshot: MetaAuditSnapshot): CapabilityState;
};

export type CapabilityStatus = { id: MetaCapabilityId; label: string; why: string; state: CapabilityState };

/** Only active or recently spending entities count toward "in use". */
function counts(e: { status: string; performance: { spendCents: number } | null }): boolean {
  return e.status === "ACTIVE" || (e.performance?.spendCents ?? 0) > 0;
}

const campaigns = (s: MetaAuditSnapshot): AuditCampaign[] => s.campaigns.filter(counts);
const adSets = (s: MetaAuditSnapshot): AuditAdSet[] => s.adSets.filter(counts);
const ads = (s: MetaAuditSnapshot): AuditAd[] => s.ads.filter(counts);

/** `in_use` when any entity matches; `unknown` when there is nothing to inspect; else `not_used`. */
function check<T>(entities: T[], test: (e: T) => boolean): CapabilityState {
  if (entities.length === 0) return "unknown";
  return entities.some(test) ? "in_use" : "not_used";
}

function includesSubtype(s: MetaAuditSnapshot, subtype: string): CapabilityState {
  const ids = new Set(s.audiences.filter((a) => a.subtype === subtype).map((a) => a.id));
  return check(adSets(s), (a) => a.includedAudienceIds.some((id) => ids.has(id)));
}

const COST_CONTROLS = new Set(["COST_CAP", "LOWEST_COST_WITH_MIN_ROAS"]);

export const META_CAPABILITIES: readonly MetaCapability[] = [
  {
    id: "advantage_plus_sales",
    label: "Advantage+ sales campaigns",
    why: "Lets Meta's automation find buyers across the whole catalogue, which usually lifts ROAS at scale.",
    businessModels: ["ecommerce"],
    detect: (s) => check(campaigns(s), (c) => c.advantagePlus && c.objective === "OUTCOME_SALES"),
  },
  {
    id: "catalog_ads",
    label: "Catalogue ads",
    why: "Shows shoppers the exact products they viewed, which lifts ROAS from warm audiences.",
    businessModels: ["ecommerce"],
    // No catalog data until Phase 3, so absence is "unknown", never "not_used".
    detect: (s) =>
      campaigns(s).some((c) => c.objective === "PRODUCT_CATALOG_SALES") || ads(s).some((a) => a.format === "DYNAMIC")
        ? "in_use"
        : "unknown",
  },
  {
    id: "website_retargeting",
    label: "Website retargeting",
    why: "Brings back recent visitors who already showed intent, the cheapest conversions toward a ROAS goal.",
    businessModels: "all",
    detect: (s) => includesSubtype(s, "WEBSITE"),
  },
  {
    id: "lookalike_audiences",
    label: "Lookalike audiences",
    why: "Finds new people who resemble your best customers, adding efficient reach beyond retargeting.",
    businessModels: "all",
    detect: (s) => includesSubtype(s, "LOOKALIKE"),
  },
  {
    id: "broad_advantage_audience",
    label: "Broad / Advantage+ audience",
    why: "Gives Meta room to find buyers outside narrow interests, which often lowers cost per sale.",
    businessModels: "all",
    detect: (s) => check(adSets(s), (a) => a.advantageAudience === true),
  },
  {
    id: "video_creative",
    label: "Video creative",
    why: "Video earns cheaper attention and feeds the algorithm more variety, supporting steadier ROAS.",
    businessModels: "all",
    detect: (s) => check(ads(s), (a) => a.format === "VIDEO"),
  },
  {
    id: "dynamic_creative",
    label: "Dynamic creative",
    why: "Tests combinations of images and copy automatically so the best performers get the spend.",
    businessModels: "all",
    detect: (s) => check(ads(s), (a) => a.format === "DYNAMIC"),
  },
  {
    id: "instant_forms",
    label: "Instant forms",
    why: "Lets people enquire without leaving Meta, which raises lead volume at a lower cost per lead.",
    businessModels: ["lead_gen", "local_service", "b2b"],
    detect: (s) => check(adSets(s), (a) => a.optimizationGoal === "LEAD_GENERATION"),
  },
  {
    id: "automatic_placements",
    label: "Automatic placements",
    why: "Lets Meta put spend where it converts best instead of limiting delivery to a few placements.",
    businessModels: "all",
    detect: (s) => check(adSets(s), (a) => a.publisherPlatforms.length === 0),
  },
  {
    id: "cost_or_roas_controls",
    label: "Cost cap or minimum ROAS controls",
    why: "Holds results near your target return instead of letting cost drift as spend scales.",
    businessModels: "all",
    detect: (s) => {
      const entities = [...campaigns(s), ...adSets(s)];
      return check(entities, (e) => e.bidStrategy !== null && COST_CONTROLS.has(e.bidStrategy));
    },
  },
];

/** Catalogue entries relevant to the business model, in catalogue order, with each one's state. */
export function detectCapabilityGaps(snapshot: MetaAuditSnapshot, businessModel: string | undefined): CapabilityStatus[] {
  return META_CAPABILITIES.filter(
    (c) => c.businessModels === "all" || (businessModel !== undefined && (c.businessModels as readonly string[]).includes(businessModel)),
  ).map((c) => ({ id: c.id, label: c.label, why: c.why, state: c.detect(snapshot) }));
}
