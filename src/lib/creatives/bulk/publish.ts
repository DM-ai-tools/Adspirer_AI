import { MAX_EXTRA_ADS } from "@/lib/meta/conventions";
import { toMetaCta } from "@/lib/workflow/queue-campaign";

/**
 * Sending a bulk run's images to Meta as one approval.
 *
 * All the images become ads in ONE ad set (the main ad plus the rest as extra ads), under either a
 * new campaign or one that already exists. The campaign, ad set and ad settings are asked once and
 * apply to every ad; each ad keeps its own image and its own hook-led copy. Nothing here talks to
 * Meta: this builds the arguments the approval carries, and the approval creates everything PAUSED.
 */

/** What the person decided in the wizard. */
export type BulkPublishPlan = {
  destination:
    | {
        mode: "new";
        campaignName: string;
        objective: string;
        /** Campaign-level settings from the settings card, as create arguments (pixel, goal, budget level …). */
        settings?: Record<string, unknown>;
      }
    | {
        mode: "existing";
        campaignId: string;
        campaignName: string;
        objective?: string;
        settings?: Record<string, unknown>;
      };
  adSet: {
    name?: string;
    budget_daily?: number;
    budget_lifetime?: number;
    start_time?: string;
    end_time?: string;
    /** Targeting as create arguments (locations, interests, audiences, platforms, age, gender). */
    targeting?: Record<string, unknown>;
  };
  ad: {
    facebook_page_id?: string;
    instagram_account_id?: string;
    call_to_action?: string;
    landing_page_url: string;
    display_link?: string;
    url_tags?: string;
  };
};

export type BulkPublishAd = {
  draftId: string;
  headline: string;
  primaryText: string;
  description?: string | null;
  /** A name for the ad, e.g. the angle it tests. */
  name?: string | null;
  imageUrl: string;
};

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value);

/** Settings that may be passed from the wizard's cards to the create call. Anything else is dropped. */
const CAMPAIGN_SETTING_KEYS = [
  "campaign_budget_optimization",
  "budget_daily",
  "budget_lifetime",
  "start_time",
  "end_time",
  "conversion_location",
  "optimization_goal",
  "pixel_id",
  "pixel_event_name",
  "lead_form_id",
  "attribution",
  "bid_strategy",
  "bid_amount",
  "roas_average_floor",
  "special_ad_categories",
  "age_min",
  "age_max",
  "publisher_platforms",
  "facebook_positions",
  "instagram_positions",
  "device_platforms",
  "user_device",
  "user_os",
] as const;

const TARGETING_KEYS = [
  "locations",
  "interests",
  "behaviors",
  "custom_audiences",
  "excluded_custom_audiences",
  "age_min",
  "age_max",
  "genders",
  "publisher_platforms",
  "facebook_positions",
  "instagram_positions",
  "device_platforms",
  "user_device",
  "user_os",
] as const;

function pick(source: Record<string, unknown> | undefined, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = source?.[key];
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value) && !value.length) continue;
    out[key] = value;
  }
  return out;
}

/** True when Meta cannot reach the address (it has to download each image). */
export function isPrivateImageUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === "localhost" ||
      host.endsWith(".local") ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      host === "[::1]"
    );
  } catch {
    return true;
  }
}

export class BulkPublishError extends Error {}

/** The create_meta_image_campaign arguments for the whole run: one approval, one ad set, every image an ad. */
export function buildBulkPublishArgs(input: { accountId: string; plan: BulkPublishPlan; ads: BulkPublishAd[] }): Record<string, unknown> {
  const { plan, ads } = input;
  if (!ads.length) throw new BulkPublishError("There are no finished images to send.");
  if (ads.length > MAX_EXTRA_ADS + 1) throw new BulkPublishError(`At most ${MAX_EXTRA_ADS + 1} ads can go in one ad set.`);
  const blocked = ads.filter((a) => isPrivateImageUrl(a.imageUrl));
  if (blocked.length) {
    throw new BulkPublishError(
      "Meta has to download each image, and these are only reachable on your own computer (the app's public address is not set to a real website). Set APP_URL to the live address, or set up image hosting (Cloudinary), then try again.",
    );
  }
  if (!plan.ad.landing_page_url) throw new BulkPublishError("A landing page is needed for the ads.");

  const existing = plan.destination.mode === "existing";
  const cta = toMetaCta(plan.ad.call_to_action) ?? "LEARN_MORE";
  const campaignName = clip(plan.destination.campaignName.trim() || "Bulk ads", 80);
  const [first, ...rest] = ads;

  const settings = pick(plan.destination.settings, CAMPAIGN_SETTING_KEYS);
  const targeting = pick(plan.adSet.targeting, TARGETING_KEYS);
  const schedule = pick(plan.adSet as Record<string, unknown>, ["budget_daily", "budget_lifetime", "start_time", "end_time"]);

  const adName = (a: BulkPublishAd) => clip(`${a.name?.trim() || a.headline}`, 100);

  return {
    account_id: input.accountId,
    campaign_name: campaignName,
    ...(plan.destination.objective ? { objective: plan.destination.objective } : {}),
    ...(existing ? { existing_campaign_id: (plan.destination as { campaignId: string }).campaignId } : {}),
    ...settings,
    // The ad set's own budget and dates win over the campaign card's when both are given.
    ...schedule,
    ...targeting,
    ad_set_name: clip(plan.adSet.name?.trim() || `${campaignName} — Ad Set`, 100),
    primary_text: first!.primaryText,
    headline: clip(first!.headline, 255),
    ...(first!.description ? { description: clip(first!.description, 255) } : {}),
    ad_name: adName(first!),
    call_to_action: cta,
    landing_page_url: plan.ad.landing_page_url,
    image_url: first!.imageUrl,
    ...(plan.ad.display_link ? { display_link: plan.ad.display_link } : {}),
    ...(plan.ad.url_tags ? { url_tags: plan.ad.url_tags } : {}),
    ...(plan.ad.facebook_page_id ? { facebook_page_id: plan.ad.facebook_page_id } : {}),
    ...(plan.ad.instagram_account_id ? { instagram_account_id: plan.ad.instagram_account_id } : {}),
    ...(rest.length
      ? {
          extra_ads: rest.map((a) => ({
            primary_text: a.primaryText,
            headline: clip(a.headline, 255),
            image_url: a.imageUrl,
            name: adName(a),
          })),
        }
      : {}),
  };
}
