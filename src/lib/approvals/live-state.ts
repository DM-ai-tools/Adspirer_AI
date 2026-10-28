import type { AdSetDetail, MetaAdsProvider } from "@/lib/adspirer/provider";
import { metaTimeMs, placementsEqual, sameIds } from "@/lib/meta/adset-edits";
import { describePlacements, type PlacementState } from "@/lib/meta/placement-format";
import { accountDailyTotalCents, campaignDailySpendCents } from "@/lib/approvals/validator";
import type { WorkspaceExecutionBackend } from "@/lib/runtime/workspace-context";
import { formatMoney } from "@/lib/monitoring/health";
import { logger } from "@/lib/observability/logger";

/**
 * The Meta state an approval changes, read live: when it is proposed (so the
 * "before" on the card and the risk score are true) and again right before
 * it runs (so a change someone made in Ads Manager meanwhile is not
 * overwritten). Stored on the args as `__before`.
 */
export type LiveState = {
  daily_budget_cents?: number | null;
  status?: string;
  /** Ad set schedule (ISO); null = no end date. */
  start_time?: string | null;
  end_time?: string | null;
  /** Ad set bid: strategy, cap (app cents) and minimum ROAS (multiple). */
  bid_strategy?: string | null;
  bid_amount_cents?: number | null;
  roas_average_floor?: number | null;
  /** Where the ad set's ads run. */
  placements?: PlacementState;
  /** Ids of the custom audiences the ad set excludes. */
  excluded_custom_audiences?: string[];
};

const BUDGET_TOOLS = new Set(["update_adset_budget", "update_campaign_budget"]);
/** Tools that edit an existing ad set in place; the state they read comes from one read by id. */
const EDIT_ADSET_TOOLS = new Set([
  "update_adset_schedule",
  "update_adset_bid",
  "update_adset_placements",
  "update_adset_audience_exclusions",
]);
const ADSET_TOOLS = new Set(["update_adset_budget", "pause_adset", "resume_adset", ...EDIT_ADSET_TOOLS]);
const CAMPAIGN_TOOLS = new Set(["update_campaign_budget", "pause_campaign", "resume_campaign"]);
const AD_TOOLS = new Set(["pause_ad", "resume_ad"]);

export function tracksLiveState(toolName: string): boolean {
  return ADSET_TOOLS.has(toolName) || CAMPAIGN_TOOLS.has(toolName) || AD_TOOLS.has(toolName);
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The part of an ad set's detail that a given edit tool depends on. */
function editState(toolName: string, detail: AdSetDetail): LiveState {
  if (toolName === "update_adset_schedule") {
    return { status: detail.status, start_time: detail.start_time, end_time: detail.end_time };
  }
  if (toolName === "update_adset_audience_exclusions") {
    return { status: detail.status, excluded_custom_audiences: detail.excluded_custom_audiences };
  }
  if (toolName === "update_adset_placements") return { status: detail.status, placements: detail.placements };
  if (toolName === "update_adset_bid") {
    return {
      status: detail.status,
      bid_strategy: detail.bid_strategy,
      bid_amount_cents: detail.bid_amount_cents,
      roas_average_floor: detail.roas_average_floor,
    };
  }
  return { status: detail.status };
}

const sameTime = (a: string | null | undefined, b: string | null | undefined) => metaTimeMs(a ?? null) === metaTimeMs(b ?? null);
const actId = (v: string) => (v.startsWith("act_") ? v : `act_${v}`);

/** null when the tool doesn't track state or the entity isn't found. */
export async function readLiveState(
  provider: MetaAdsProvider,
  toolName: string,
  args: Record<string, unknown>,
): Promise<LiveState | null> {
  const account = str(args.account_id) ?? str(args.ad_account_id);
  if (!account || !tracksLiveState(toolName)) return null;
  const accountId = actId(account);
  if (EDIT_ADSET_TOOLS.has(toolName)) {
    const id = str(args.adset_id) ?? str(args.ad_set_id);
    if (!id || !provider.getAdSetDetail) return null;
    const detail = await provider.getAdSetDetail(accountId, id);
    return detail ? editState(toolName, detail) : null;
  }
  // One direct read by id when the provider supports it — account-wide lists
  // are slow and truncated on large accounts.
  if (provider.getEntityState) {
    const [type, id] = ADSET_TOOLS.has(toolName)
      ? (["adset", str(args.adset_id) ?? str(args.ad_set_id)] as const)
      : CAMPAIGN_TOOLS.has(toolName)
        ? (["campaign", str(args.campaign_id)] as const)
        : (["ad", str(args.ad_id)] as const);
    return id ? provider.getEntityState(accountId, type, id) : null;
  }
  if (ADSET_TOOLS.has(toolName)) {
    const id = str(args.adset_id) ?? str(args.ad_set_id);
    const adset = (await provider.listAdSets(accountId)).find((a) => a.id === id);
    return adset ? { daily_budget_cents: adset.daily_budget_cents || null, status: adset.status } : null;
  }
  if (CAMPAIGN_TOOLS.has(toolName)) {
    const id = str(args.campaign_id);
    const campaign = (await provider.listCampaigns(accountId)).find((c) => c.id === id);
    return campaign ? { daily_budget_cents: campaign.daily_budget_cents || null, status: campaign.status } : null;
  }
  const id = str(args.ad_id);
  const ad = (await provider.listAds(accountId)).find((a) => a.id === id);
  return ad ? { status: ad.status } : null;
}

/**
 * Args with the live state recorded as `__before` and, for budget changes,
 * `previous_daily_budget_cents` set to the live budget. Best effort: when
 * Meta can't be read the args come back unchanged.
 */
export async function withLiveBefore(
  toolName: string,
  args: Record<string, unknown>,
  resolve: (backend: WorkspaceExecutionBackend | null) => Promise<MetaAdsProvider>,
): Promise<Record<string, unknown>> {
  if (!tracksLiveState(toolName)) return args;
  try {
    const backend =
      typeof args.__provider_backend === "string" ? (args.__provider_backend as WorkspaceExecutionBackend) : null;
    const state = await readLiveState(await resolve(backend), toolName, args);
    if (!state) return args;
    const next: Record<string, unknown> = { ...args, __before: state };
    if (BUDGET_TOOLS.has(toolName) && state.daily_budget_cents != null) {
      next.previous_daily_budget_cents = state.daily_budget_cents;
    }
    return next;
  } catch (error) {
    logger.warn("Could not read live Meta state for approval", {
      toolName,
      error: error instanceof Error ? error.message : String(error),
    });
    return args;
  }
}

/**
 * The account's live daily budgets after this change, or null when the
 * change adds no daily spend (decreases, pauses, paused creates).
 */
export async function projectAccountDailyCents(
  provider: MetaAdsProvider,
  toolName: string,
  args: Record<string, unknown>,
): Promise<number | null> {
  const account = str(args.account_id);
  const adds = ["update_adset_budget", "update_campaign_budget", "resume_campaign", "resume_adset", "create_campaign"];
  if (!account || !adds.includes(toolName)) return null;
  if (toolName === "create_campaign" && args.status !== "ACTIVE") return null;
  const accountId = actId(account);
  const [campaigns, adsets] = await Promise.all([provider.listCampaigns(accountId), provider.listAdSets(accountId)]);
  const campaignId = str(args.campaign_id);
  const adsetId = str(args.adset_id) ?? str(args.ad_set_id);
  const next = typeof args.daily_budget_cents === "number" ? args.daily_budget_cents : 0;
  let added = 0;
  if (toolName === "update_campaign_budget") {
    added = next - (campaigns.find((c) => c.id === campaignId)?.daily_budget_cents ?? 0);
  } else if (toolName === "update_adset_budget") {
    added = next - (adsets.find((a) => a.id === adsetId)?.daily_budget_cents ?? 0);
  } else if (toolName === "resume_campaign") {
    const campaign = campaigns.find((c) => c.id === campaignId);
    added = campaign && campaign.status !== "ACTIVE" ? (campaignDailySpendCents(campaign, adsets) ?? 0) : 0;
  } else if (toolName === "resume_adset") {
    const adset = adsets.find((a) => a.id === adsetId);
    added = adset && adset.status !== "ACTIVE" ? adset.daily_budget_cents : 0;
  } else {
    added = next; // a campaign created ACTIVE spends from day one
  }
  return added > 0 ? accountDailyTotalCents(campaigns, adsets) + added : null;
}

/** Why the approval no longer matches Meta, or null when nothing it depends on changed. */
export function describeDrift(
  toolName: string,
  before: LiveState,
  now: LiveState | null,
  currency: string,
): string | null {
  const tail = " Reject it and ask for a fresh proposal.";
  if (!now) return `The ${entityWord(toolName)} can no longer be found in Meta, so it changed since this was proposed.${tail}`;
  if (BUDGET_TOOLS.has(toolName)) {
    const was = before.daily_budget_cents ?? null;
    const is = now.daily_budget_cents ?? null;
    if (was !== is) {
      const show = (c: number | null) => (c == null ? "no daily budget" : formatMoney(c, currency));
      return `The ${entityWord(toolName)}'s daily budget changed in Meta since this was proposed: was ${show(was)}, now ${show(is)}.${tail}`;
    }
    return null;
  }
  if (toolName === "update_adset_schedule") {
    const show = (t: string | null | undefined) => (metaTimeMs(t ?? null) == null ? "none" : String(t));
    if (!sameTime(before.end_time, now.end_time)) {
      return `The ad set's end date changed in Meta since this was proposed: was ${show(before.end_time)}, now ${show(now.end_time)}.${tail}`;
    }
    if (!sameTime(before.start_time, now.start_time)) {
      return `The ad set's start changed in Meta since this was proposed: was ${show(before.start_time)}, now ${show(now.start_time)}.${tail}`;
    }
  }
  if (
    toolName === "update_adset_audience_exclusions" &&
    before.excluded_custom_audiences &&
    now.excluded_custom_audiences &&
    !sameIds(before.excluded_custom_audiences, now.excluded_custom_audiences)
  ) {
    const list = (ids: string[]) => (ids.length ? ids.join(", ") : "none");
    return `The ad set's audience exclusions changed in Meta since this was proposed: was ${list(before.excluded_custom_audiences)}, now ${list(now.excluded_custom_audiences)}.${tail}`;
  }
  if (toolName === "update_adset_placements" && before.placements && now.placements && !placementsEqual(before.placements, now.placements)) {
    return `The ad set's placements changed in Meta since this was proposed: was ${describePlacements(before.placements)}, now ${describePlacements(now.placements)}.${tail}`;
  }
  if (toolName === "update_adset_bid") {
    const show = (s: LiveState) =>
      `${s.bid_strategy ?? "no bid strategy"}${s.bid_amount_cents != null ? ` at ${formatMoney(s.bid_amount_cents, currency)}` : ""}${
        s.roas_average_floor != null ? ` at ${s.roas_average_floor}x ROAS` : ""
      }`;
    if (
      (before.bid_strategy ?? null) !== (now.bid_strategy ?? null) ||
      (before.bid_amount_cents ?? null) !== (now.bid_amount_cents ?? null) ||
      (before.roas_average_floor ?? null) !== (now.roas_average_floor ?? null)
    ) {
      return `The ad set's bid changed in Meta since this was proposed: was ${show(before)}, now ${show(now)}.${tail}`;
    }
  }
  if (before.status && now.status && before.status !== now.status) {
    return `The ${entityWord(toolName)} changed in Meta since this was proposed: status was ${before.status}, now ${now.status}.${tail}`;
  }
  return null;
}

/** Has the entity moved away from the state a logged change left it in? (Rolling back would overwrite that.) */
export function changedSince(after: LiveState | null, live: LiveState): boolean {
  if (!after) return false;
  if (after.daily_budget_cents !== undefined && live.daily_budget_cents !== after.daily_budget_cents) return true;
  if (after.status !== undefined && live.status !== after.status) return true;
  if (after.end_time !== undefined && !sameTime(live.end_time, after.end_time)) return true;
  if (after.start_time !== undefined && !sameTime(live.start_time, after.start_time)) return true;
  if (after.excluded_custom_audiences !== undefined && !sameIds(live.excluded_custom_audiences ?? [], after.excluded_custom_audiences)) return true;
  if (after.placements !== undefined && (!live.placements || !placementsEqual(live.placements, after.placements))) return true;
  if (after.bid_strategy !== undefined && (live.bid_strategy ?? null) !== (after.bid_strategy ?? null)) return true;
  if (after.bid_amount_cents !== undefined && (live.bid_amount_cents ?? null) !== (after.bid_amount_cents ?? null)) return true;
  if (after.roas_average_floor !== undefined && (live.roas_average_floor ?? null) !== (after.roas_average_floor ?? null)) return true;
  return false;
}

function entityWord(toolName: string): string {
  return ADSET_TOOLS.has(toolName) ? "ad set" : CAMPAIGN_TOOLS.has(toolName) ? "campaign" : "ad";
}
