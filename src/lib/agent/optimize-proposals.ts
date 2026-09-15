import type { MetaAdsProvider, MetaAdCreative, MetaCampaign, MetaAdSet } from "@/lib/adspirer/provider";
import type { AgentToolCallProposal } from "@/lib/agent/adspirer-agent";
import {
  mergeExecuteProposals,
  proposalsFromOptimizeStructured,
} from "@/lib/agent/optimize-queue";

export type OptimizeProposalBundle = {
  proposals: AgentToolCallProposal[];
  /** Operator-facing lines for evidence (only queueable items). */
  queueableLines: string[];
  /** Items that need operator input before Approvals. */
  blockedLines: string[];
};

function isHttpsUrl(value: string | null | undefined): value is string {
  return Boolean(value && /^https?:\/\//i.test(value.trim()));
}

function pickCreativeSeed(
  creatives: MetaAdCreative[],
  campaignId?: string,
): MetaAdCreative | null {
  const scoped = campaignId
    ? creatives.filter((c) => c.campaign_id === campaignId)
    : creatives;
  const pool = scoped.length ? scoped : creatives;
  return (
    pool.find((c) => isHttpsUrl(c.landing_page_url) && c.primary_text?.trim()) ??
    pool.find((c) => isHttpsUrl(c.landing_page_url)) ??
    pool[0] ??
    null
  );
}

/**
 * Build every EXECUTE proposal we can safely queue for an account optimize turn.
 * Only tools with concrete IDs/args are included — chat must not invent extras.
 */
export async function buildFullOptimizeProposals(input: {
  provider: MetaAdsProvider;
  accountId: string;
  /** Optional client website — used only if live creatives lack a landing URL. */
  fallbackLandingUrl?: string | null;
}): Promise<OptimizeProposalBundle> {
  const { provider, accountId } = input;
  const proposals: AgentToolCallProposal[] = [];
  const queueableLines: string[] = [];
  const blockedLines: string[] = [];

  const [campaigns, adsets, creatives] = await Promise.all([
    provider.listCampaigns(accountId).catch(() => [] as MetaCampaign[]),
    provider.listAdSets(accountId).catch(() => [] as MetaAdSet[]),
    provider.getAdCreatives
      ? provider.getAdCreatives(accountId, { limit: 30 }).catch(() => [] as MetaAdCreative[])
      : Promise.resolve([] as MetaAdCreative[]),
  ]);

  // 1) Budget + fatigue from provider diagnose helpers (structured proposals)
  if (provider.optimizeBudget) {
    const budget = await provider.optimizeBudget(accountId);
    const fromBudget = proposalsFromOptimizeStructured(
      budget.structured as Record<string, unknown> | null,
    );
    for (const p of fromBudget) {
      proposals.push(p);
      queueableLines.push(
        `- BUDGET: ${p.rationale ?? "update_adset_budget"} → tool \`${p.name}\``,
      );
    }
  }
  if (provider.detectCreativeFatigue) {
    const fatigue = await provider.detectCreativeFatigue(accountId);
    const fromFatigue = proposalsFromOptimizeStructured(
      fatigue.structured as Record<string, unknown> | null,
    );
    for (const p of fromFatigue) {
      proposals.push(p);
      queueableLines.push(
        `- FATIGUE: ${p.rationale ?? "pause_ad"} → tool \`${p.name}\``,
      );
    }
  }

  // 2) Reactivate paused campaigns (resume_campaign)
  const pausedCampaigns = campaigns
    .filter((c) => c.status === "PAUSED")
    .slice(0, 2);
  for (const c of pausedCampaigns) {
    proposals.push({
      name: "resume_campaign",
      args: {
        account_id: accountId,
        campaign_id: c.id,
      },
      rationale: `Reactivate paused campaign ${c.name} (${c.id}).`,
    });
    queueableLines.push(
      `- REACTIVATE: ${c.name} (${c.id}) → tool \`resume_campaign\``,
    );
  }
  if (!pausedCampaigns.length) {
    blockedLines.push(
      "- Reactivate campaign: no PAUSED campaigns found on this account.",
    );
  }

  // 3) New broad / Advantage+ ad set under the best ACTIVE campaign
  const activeCampaigns = campaigns.filter((c) => c.status === "ACTIVE");
  const hostCampaign =
    activeCampaigns.find((c) =>
      adsets.some((a) => a.campaign_id === c.id && a.status === "ACTIVE"),
    ) ??
    activeCampaigns[0] ??
    campaigns[0];

  if (hostCampaign) {
    const seed = pickCreativeSeed(creatives, hostCampaign.id);
    const landing =
      (isHttpsUrl(seed?.landing_page_url) ? seed!.landing_page_url!.trim() : null) ??
      (isHttpsUrl(input.fallbackLandingUrl)
        ? input.fallbackLandingUrl!.trim()
        : null);
    const primary =
      seed?.primary_text?.trim() ||
      seed?.headline?.trim() ||
      `${hostCampaign.name} — learn more.`;
    const sibling = adsets.find(
      (a) => a.campaign_id === hostCampaign.id && a.daily_budget_cents > 0,
    );
    const budgetDaily =
      sibling && sibling.daily_budget_cents > 0
        ? Math.max(1, Math.round(sibling.daily_budget_cents / 100))
        : 10;

    if (landing) {
      const name = `Broad Advantage+ | ${hostCampaign.name}`.slice(0, 120);
      // One create_adset covers "new broad ad set" + Advantage+ placements
      // (empty publisher_platforms → Meta Advantage+ placements).
      proposals.push({
        name: "create_adset",
        args: {
          account_id: accountId,
          campaign_id: hostCampaign.id,
          name,
          budget_daily: budgetDaily,
          ad_type: "image",
          landing_page_url: landing,
          primary_text: primary.slice(0, 500),
          headline: (seed?.headline ?? hostCampaign.name).slice(0, 40),
          objective: hostCampaign.objective,
          publisher_platforms: [],
        },
        rationale: `New broad Advantage+ ad set under ${hostCampaign.name} (PAUSED until you activate). Covers placement expansion + broad audience test.`,
      });
      queueableLines.push(
        `- BROAD / ADVANTAGE+ AD SET: ${name} under campaign ${hostCampaign.id} → tool \`create_adset\` (covers Advantage+ placements + new broad ad set)`,
      );
    } else {
      blockedLines.push(
        "- New broad / Advantage+ ad set: needs a https landing_page_url (none on live creatives). Provide the URL, then ask to queue again.",
      );
      blockedLines.push(
        "- Expand to Advantage+ placements: queued as part of create_adset once a landing URL is available (no separate placement mutate tool).",
      );
    }
  } else {
    blockedLines.push(
      "- New broad / Advantage+ ad set: no campaign available to attach an ad set to.",
    );
  }

  // 4) Creative refresh + pixel always need operator input
  blockedLines.push(
    "- Creative refresh: waiting on image choice / new creative URL — cannot queue create_ad yet.",
  );
  blockedLines.push(
    "- Pixel verification: waiting on Pixel ID — cannot queue a pixel mutate yet.",
  );

  return {
    proposals: mergeExecuteProposals([], proposals),
    queueableLines,
    blockedLines,
  };
}
