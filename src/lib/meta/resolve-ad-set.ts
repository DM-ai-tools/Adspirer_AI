import type { MetaAdsProvider } from "@/lib/adspirer/provider";

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

function candidateList<T extends { name: string }>(items: T[]): string {
  const names = items.slice(0, 10).map((i) => `"${i.name}"`);
  const more = items.length > 10 ? ` (+${items.length - 10} more)` : "";
  return names.length ? `${names.join(", ")}${more}` : "none";
}

/**
 * Find one entity by exact (case-insensitive, trimmed) name. Substring
 * matching used to pick "X - Ad Set" for "X" — the wrong ad set — so it is
 * gone: no match returns undefined, and several equal names throw with the
 * candidates so the operator can pick an ID.
 */
export function matchEntityByName<T extends { id: string; name: string }>(
  items: T[],
  name: string,
  label = "entity",
): T | undefined {
  const target = normalizeName(name);
  if (!target) return undefined;

  const exact = items.filter((item) => normalizeName(item.name) === target);
  if (exact.length > 1) {
    throw new Error(
      `More than one ${label} is named "${name.trim()}" (${exact
        .map((e) => e.id)
        .join(", ")}). Use Edit to set the exact ID instead of the name.`,
    );
  }
  return exact[0];
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
    const campaign = matchEntityByName(campaigns, campaignName, "campaign");
    if (!campaign) {
      throw new Error(
        `No campaign is named exactly "${campaignName}". Campaigns in this account: ${candidateList(campaigns)}. Use Edit to set campaign_id or the exact name.`,
      );
    }
    campaignId = campaign.id;
  }
  if (!campaignId) return undefined;

  const adSets = await provider.listAdSets(accountId, campaignId);
  if (!adSets.length) {
    throw new Error(
      `Campaign ${campaignId} has no ad sets yet — create the ad set first, then add the ad.`,
    );
  }

  const adSetName =
    optionalString(args.ad_set_name) ??
    optionalString(args.adset_name) ??
    optionalString(args.ad_set);

  if (adSetName) {
    const adSet = matchEntityByName(adSets, adSetName, "ad set");
    if (adSet) return adSet.id;
    throw new Error(
      `No ad set in campaign ${campaignId} is named exactly "${adSetName}". Ad sets: ${candidateList(adSets)}. Use Edit to set ad_set_id or the exact name.`,
    );
  }

  // No ad set name given: only unambiguous when the campaign has one ad set.
  if (adSets.length === 1) return adSets[0].id;

  throw new Error(
    `Campaign ${campaignId} has ${adSets.length} ad sets (${candidateList(adSets)}). Use Edit to set ad_set_id or ad_set_name.`,
  );
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
