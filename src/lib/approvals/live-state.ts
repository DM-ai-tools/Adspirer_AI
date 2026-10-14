import type { MetaAdsProvider } from "@/lib/adspirer/provider";
import type { WorkspaceExecutionBackend } from "@/lib/runtime/workspace-context";
import { formatMoney } from "@/lib/monitoring/health";
import { logger } from "@/lib/observability/logger";

/**
 * The Meta state an approval changes, read live: when it is proposed (so the
 * "before" on the card and the risk score are true) and again right before
 * it runs (so a change someone made in Ads Manager meanwhile is not
 * overwritten). Stored on the args as `__before`.
 */
export type LiveState = { daily_budget_cents?: number | null; status?: string };

const BUDGET_TOOLS = new Set(["update_adset_budget", "update_campaign_budget"]);
const ADSET_TOOLS = new Set(["update_adset_budget", "pause_adset", "resume_adset"]);
const CAMPAIGN_TOOLS = new Set(["update_campaign_budget", "pause_campaign", "resume_campaign"]);
const AD_TOOLS = new Set(["pause_ad", "resume_ad"]);

export function tracksLiveState(toolName: string): boolean {
  return ADSET_TOOLS.has(toolName) || CAMPAIGN_TOOLS.has(toolName) || AD_TOOLS.has(toolName);
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
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
  if (before.status && now.status && before.status !== now.status) {
    return `The ${entityWord(toolName)} changed in Meta since this was proposed: status was ${before.status}, now ${now.status}.${tail}`;
  }
  return null;
}

function entityWord(toolName: string): string {
  return ADSET_TOOLS.has(toolName) ? "ad set" : CAMPAIGN_TOOLS.has(toolName) ? "campaign" : "ad";
}
