import type { MetaAdsProvider } from "@/lib/adspirer/provider";

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function matchEntityByName<T extends { id: string; name: string }>(
  items: T[],
  name: string,
): T | undefined {
  const target = name.trim().toLowerCase();
  if (!target) return undefined;

  const exact = items.find((item) => item.name.trim().toLowerCase() === target);
  if (exact) return exact;

  return items.find((item) => {
    const candidate = item.name.trim().toLowerCase();
    return candidate.includes(target) || target.includes(candidate);
  });
}

/** Resolve Meta ad set ID when the agent only sent campaign/ad set names. */
export async function resolveAdSetIdForCreateAd(
  provider: MetaAdsProvider,
  args: Record<string, unknown>,
): Promise<string | undefined> {
  const direct =
    optionalString(args.ad_set_id) ?? optionalString(args.adset_id);
  if (direct) return direct;

  const accountId =
    optionalString(args.account_id) ?? optionalString(args.ad_account_id);
  if (!accountId) return undefined;

  let campaignId = optionalString(args.campaign_id);
  const campaignName = optionalString(args.campaign_name);
  if (!campaignId && campaignName) {
    const campaigns = await provider.listCampaigns(accountId);
    const campaign = matchEntityByName(campaigns, campaignName);
    campaignId = campaign?.id;
  }
  if (!campaignId) return undefined;

  const adSets = await provider.listAdSets(accountId, campaignId);
  if (!adSets.length) return undefined;

  const adSetName =
    optionalString(args.ad_set_name) ??
    optionalString(args.adset_name) ??
    optionalString(args.ad_set) ??
    campaignName;

  if (adSetName) {
    const adSet = matchEntityByName(adSets, adSetName);
    if (adSet) return adSet.id;
  }

  if (adSets.length === 1) return adSets[0].id;

  return undefined;
}

export function normalizeCreateAdArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const name =
    optionalString(args.name) ?? optionalString(args.ad_name) ?? undefined;
  const landing =
    optionalString(args.landing_page_url) ??
    optionalString(args.website_url) ??
    optionalString(args.url) ??
    optionalString(args.landing_url);

  return {
    ...args,
    ...(name ? { name } : {}),
    ...(landing ? { landing_page_url: landing } : {}),
  };
}
