import type {
  MetaAd,
  MetaAdSet,
  MetaAdsProvider,
  MetaCampaign,
} from "@/lib/adspirer/provider";
import type { AgentHistoryMessage } from "@/lib/agent/history";

/**
 * Live campaign → ad set → ad status for questions like "is anything running?"
 * or "are any ad sets active under this campaign?". Without it the writer only
 * saw the campaign list and guessed ad set names, IDs and statuses.
 */

const STRUCTURE_QUESTION =
  /\b(ad\s?sets?|ads|creatives?|active|running|live|paused|turned\s+(on|off)|switched\s+(on|off)|on\s+or\s+off|delivering|delivery|status|enabled|disabled)\b/i;

export function asksAboutDeliveryStructure(request: string): boolean {
  return STRUCTURE_QUESTION.test(request);
}

const REFERS_BACK = /\b(this|that|these|those|same|its?|the)\s+(campaigns?|one)\b|\bunder\s+(it|this|that)\b/i;
const MAX_CAMPAIGNS = 8;

function mentioned(text: string, campaigns: MetaCampaign[]): MetaCampaign[] {
  const lower = text.toLowerCase();
  return campaigns.filter(
    (c) =>
      text.includes(c.id) ||
      (c.name.trim().length >= 6 && lower.includes(c.name.trim().toLowerCase())),
  );
}

/**
 * Campaigns the question is about: named or ID'd in the message; "this
 * campaign" resolves to the ones named in the last exchange; otherwise every
 * campaign that is switched on.
 */
export function pickStructureCampaigns(
  request: string,
  campaigns: MetaCampaign[],
  history: AgentHistoryMessage[] = [],
): MetaCampaign[] {
  const direct = mentioned(request, campaigns);
  if (direct.length) return direct.slice(0, MAX_CAMPAIGNS);
  if (REFERS_BACK.test(request)) {
    for (const message of history.slice(-4).reverse()) {
      const found = mentioned(message.content, campaigns);
      if (found.length) return found.slice(0, MAX_CAMPAIGNS);
    }
  }
  return campaigns.filter((c) => c.status === "ACTIVE").slice(0, MAX_CAMPAIGNS);
}

const STATUS_TEXT: Record<string, string> = {
  ACTIVE: "ACTIVE",
  PAUSED: "OFF (paused)",
  CAMPAIGN_PAUSED: "OFF (its campaign is paused)",
  ADSET_PAUSED: "OFF (its ad set is paused)",
  DISAPPROVED: "REJECTED by Meta review",
  WITH_ISSUES: "ON but has delivery issues",
  PENDING_REVIEW: "IN REVIEW",
  IN_PROCESS: "PROCESSING",
  ARCHIVED: "ARCHIVED",
  DELETED: "DELETED",
};

const statusOf = (entity: { status: string; effective_status?: string }) =>
  entity.effective_status ?? entity.status;
const label = (status: string) => STATUS_TEXT[status] ?? status;

export type CampaignStructure = {
  campaign: MetaCampaign;
  adSets: MetaAdSet[] | null;
  ads: MetaAd[] | null;
  error?: string;
};

export function formatDeliveryStructure(
  rows: CampaignStructure[],
  money: (major: number) => string,
): string {
  const lines = [
    "### Delivery structure (live from Meta — campaign → ad sets → ads)",
  ];
  if (!rows.length) {
    lines.push("- No campaign in this account is switched on.");
  }
  for (const { campaign: c, adSets, ads, error } of rows) {
    const cbo = (c.daily_budget_cents ?? 0) > 0 || (c.lifetime_budget_cents ?? 0) > 0;
    const budget =
      (c.daily_budget_cents ?? 0) > 0
        ? ` · campaign budget ${money(c.daily_budget_cents! / 100)}/day (shared by its ad sets)`
        : (c.lifetime_budget_cents ?? 0) > 0
          ? ` · campaign lifetime budget ${money(c.lifetime_budget_cents! / 100)}`
          : " · budgets set per ad set";
    lines.push(`- CAMPAIGN "${c.name}" (campaign ID ${c.id}) · ${label(c.status)}${budget}`);
    if (error || !adSets) {
      lines.push(`  - Ad sets/ads could not be loaded: ${error ?? "no data"}. Say so instead of guessing.`);
      continue;
    }
    const activeSets = adSets.filter((a) => statusOf(a) === "ACTIVE");
    lines.push(`  - AD SETS: ${adSets.length} total, ${activeSets.length} ACTIVE`);
    for (const a of adSets.slice(0, 20)) {
      const own =
        a.daily_budget_cents > 0
          ? `own budget ${money(a.daily_budget_cents / 100)}/day`
          : (a.lifetime_budget_cents ?? 0) > 0
            ? `own lifetime budget ${money(a.lifetime_budget_cents! / 100)}`
            : cbo
              ? "uses the campaign budget"
              : "no budget set";
      lines.push(`    - AD SET "${a.name}" (ad set ID ${a.id}) · ${label(statusOf(a))} · ${own}`);
    }
    if (adSets.length > 20) lines.push(`    - …and ${adSets.length - 20} more ad sets`);

    const setName = new Map(adSets.map((a) => [a.id, a.name]));
    const adList = ads ?? [];
    const activeAds = adList.filter((a) => statusOf(a) === "ACTIVE");
    lines.push(`  - ADS: ${adList.length} total, ${activeAds.length} ACTIVE`);
    for (const ad of adList.slice(0, 15)) {
      const parent = setName.get(ad.adset_id);
      lines.push(
        `    - AD "${ad.name}" (ad ID ${ad.id}) · ${label(statusOf(ad))}${parent ? ` · in ad set "${parent}"` : ""}`,
      );
    }
    if (adList.length > 15) lines.push(`    - …and ${adList.length - 15} more ads`);

    if (statusOf(c) === "ACTIVE") {
      if (!activeSets.length) {
        lines.push("  - ⇒ NOT DELIVERING: the campaign is switched on but every ad set is off.");
      } else if (ads && !activeAds.length) {
        lines.push("  - ⇒ NOT DELIVERING: ad sets are on but no ad is active.");
      } else {
        lines.push(
          `  - ⇒ Can deliver: ${activeSets.length} active ad set${activeSets.length === 1 ? "" : "s"}, ${activeAds.length} active ad${activeAds.length === 1 ? "" : "s"}.`,
        );
      }
    }
  }
  lines.push(
    "Rules: answer status questions ONLY from this block. Each ID is labelled with its type — never call an ad an ad set or reuse a campaign budget as an ad set budget. If something the operator asks about is not listed, say you couldn't see it.",
  );
  return lines.join("\n");
}

export async function gatherDeliveryStructure(input: {
  provider: MetaAdsProvider;
  accountId: string;
  campaigns: MetaCampaign[];
  request: string;
  history?: AgentHistoryMessage[];
  money: (major: number) => string;
  mapWithConcurrency: <T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) => Promise<R[]>;
}): Promise<string> {
  const picked = pickStructureCampaigns(input.request, input.campaigns, input.history);
  const rows = await input.mapWithConcurrency(picked, 4, async (campaign): Promise<CampaignStructure> => {
    try {
      const [adSets, ads] = await Promise.all([
        input.provider.listAdSets(input.accountId, campaign.id),
        input.provider.listAds(input.accountId, campaign.id).catch(() => null),
      ]);
      return { campaign, adSets, ads };
    } catch (error) {
      return {
        campaign,
        adSets: null,
        ads: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  return formatDeliveryStructure(rows, input.money);
}
