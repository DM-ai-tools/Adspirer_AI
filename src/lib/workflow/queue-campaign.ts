import type { Approval } from "@/types";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { createPendingApproval } from "@/lib/approvals/service";
import type { CreativeDraft } from "@/lib/creatives/drafts";
import { getTaskById } from "@/lib/workflow/state";
import {
  targetingSelectionToCreateArgs,
  type CampaignTargetingSelection,
} from "@/lib/adspirer/targeting";

export type QueueCampaignResult =
  | { queued: true; approval: Approval }
  | { queued: false; reason: string };

const DEFAULT_OBJECTIVE = "OUTCOME_TRAFFIC";

async function resolveAccountId(clientId: string): Promise<string | null> {
  const config = getConfig();

  if (config.isDemoMode || !config.hasSupabase) {
    const store = getDemoStore();
    const account = store.connectedMetaAccounts.find(
      (a) => a.client_id === clientId && a.meta_account_id,
    );
    return account?.meta_account_id ?? null;
  }

  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();

  const { data: linked } = await supabase
    .from("connected_meta_accounts")
    .select("external_account_id")
    .eq("mapped_client_id", clientId)
    .limit(1)
    .maybeSingle();
  const external = linked?.external_account_id as string | undefined;
  if (external) return external;

  const { data: client } = await supabase
    .from("clients")
    .select("meta_account_id")
    .eq("id", clientId)
    .maybeSingle();
  return (client?.meta_account_id as string | null) ?? null;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

/** CTAs Adspirer accepts for create_meta_image_campaign. */
const META_CTAS = new Set([
  "LEARN_MORE",
  "SHOP_NOW",
  "SIGN_UP",
  "DOWNLOAD",
  "BOOK_TRAVEL",
  "CONTACT_US",
  "GET_QUOTE",
  "SUBSCRIBE",
  "WATCH_MORE",
]);

/** "Book Now" → BOOK_NOW; anything Meta doesn't accept falls back to LEARN_MORE. */
function toMetaCta(label: string | null | undefined): string | undefined {
  if (!label) return undefined;
  const candidate = label.trim().toUpperCase().replace(/[\s-]+/g, "_");
  return META_CTAS.has(candidate) ? candidate : "LEARN_MORE";
}

/**
 * Queue the campaign for a creative the operator just picked.
 *
 * The agent refuses to propose create_meta_image_campaign until an image_url
 * exists, so by the time a creative is selected there is usually nothing left
 * in Approvals to attach it to. Rather than depending on another LLM turn to
 * notice that, build the payload directly — every required field already lives
 * on the draft. Optional fields fall back to defaults the operator can change
 * with Edit before approving; nothing is applied to Meta until they do.
 */
export async function queueCampaignForSelectedCreative(input: {
  draft: CreativeDraft;
  imageUrl: string;
  clientName?: string | null;
  requestedBy?: string | null;
}): Promise<QueueCampaignResult> {
  const { draft, imageUrl } = input;

  if (!draft.landing_page_url) {
    return {
      queued: false,
      reason:
        "No landing page URL on this creative, which Meta requires to create the ad.",
    };
  }

  const accountId = await resolveAccountId(draft.client_id);
  if (!accountId) {
    return {
      queued: false,
      reason:
        "No Meta ad account is connected to this client yet, so there is nothing to create the campaign in.",
    };
  }

  const task = draft.task_id ? await getTaskById(draft.task_id) : null;
  const agentState = (task?.agent_state ?? {}) as Record<string, unknown>;
  const objective =
    typeof agentState.campaign_objective === "string"
      ? agentState.campaign_objective
      : DEFAULT_OBJECTIVE;
  const budgetDaily =
    typeof agentState.campaign_budget_daily === "number"
      ? agentState.campaign_budget_daily
      : undefined;

  const targetingArgs = readTargetingArgs(agentState.campaign_targeting);

  const campaignName = truncate(
    typeof agentState.campaign_name === "string" && agentState.campaign_name
      ? agentState.campaign_name
      : `${input.clientName ?? "Campaign"} — ${draft.headline}`,
    80,
  );

  const idempotencyKey = `creative_campaign_${draft.id}`;
  const existing = await findApprovalByIdempotencyKey(idempotencyKey);
  if (existing) return { queued: true, approval: existing };

  const approval = await createPendingApproval({
    clientId: draft.client_id,
    taskId: draft.task_id,
    toolName: "create_meta_image_campaign",
    proposedArgs: {
      account_id: accountId,
      campaign_name: campaignName,
      ad_set_name: `${campaignName} — Ad Set`,
      ad_name: `${campaignName} — ${truncate(draft.headline, 40)}`,
      objective,
      primary_text: draft.primary_text,
      headline: draft.headline,
      ...(draft.description ? { description: draft.description } : {}),
      ...(toMetaCta(draft.cta)
        ? { call_to_action: toMetaCta(draft.cta) }
        : {}),
      landing_page_url: draft.landing_page_url,
      image_url: imageUrl,
      ...(budgetDaily ? { budget_daily: budgetDaily } : {}),
      ...targetingArgs,
    },
    rationale: `Queued from the selected creative “${draft.headline}”. Campaign, ad set and ad are created PAUSED — review the objective and daily budget with Edit before approving.`,
    requestedBy: input.requestedBy ?? null,
    idempotencyKey,
  });

  return { queued: true, approval };
}

function readTargetingArgs(
  raw: unknown,
): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const t = raw as CampaignTargetingSelection;
  return targetingSelectionToCreateArgs({
    custom_audiences: Array.isArray(t.custom_audiences)
      ? t.custom_audiences
      : [],
    excluded_custom_audiences: Array.isArray(t.excluded_custom_audiences)
      ? t.excluded_custom_audiences
      : [],
    interests: Array.isArray(t.interests) ? t.interests : [],
    behaviors: Array.isArray(t.behaviors) ? t.behaviors : [],
    locations: Array.isArray(t.locations) ? t.locations : [],
    publisher_platforms: Array.isArray(t.publisher_platforms)
      ? t.publisher_platforms
      : [],
  });
}

async function findApprovalByIdempotencyKey(
  key: string,
): Promise<Approval | null> {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    return (
      getDemoStore().approvals.find((a) => a.idempotency_key === key) ?? null
    );
  }
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { mapApprovalRow } = await import("@/lib/db/live-maps");
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("approvals")
    .select("*")
    .eq("idempotency_key", key)
    .maybeSingle();
  return data ? mapApprovalRow(data as Record<string, unknown>) : null;
}
