import type { Approval } from "@/types";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { getProvider, getProviderForBackend, resolveProvider } from "@/lib/adspirer/client";
import type { MetaAdsProvider } from "@/lib/adspirer/provider";
import {
  DuplicateExecutionError,
  ProviderUnavailableError,
} from "@/lib/errors";
import {
  assertApprovalNotExpired,
  assertExecutableStatus,
  assertTransition,
  assertWithinBudgetCeiling,
  effectiveApprovalArgs,
} from "@/lib/approvals/validator";
import { getApproval } from "@/lib/approvals/service";
import { nowIso } from "@/lib/utils";
import { toApprovalInsert } from "@/lib/db/live-maps";
import { completeTaskIfApprovalsTerminal } from "@/lib/workflow/bindings";
import { logger } from "@/lib/observability/logger";
import type { WorkspaceExecutionBackend } from "@/lib/runtime/workspace-context";
import { resolveBudgetDaily } from "@/lib/meta/resolve-budget-daily";
import { normalizeMetaApprovalArgs } from "@/lib/meta/normalize-approval-args";

const executingKeys = new Set<string>();

export type ExecuteApprovedActionResult = {
  approval: Approval;
  result: unknown;
};

/**
 * Execute an approved action with idempotency protection.
 * Enforces ADS_EXECUTION_MODE — production/sandbox require MCP provider availability.
 */
export async function executeApprovedAction(input: {
  approvalId: string;
  executedBy: string;
  overrideArgs?: Record<string, unknown>;
}): Promise<ExecuteApprovedActionResult> {
  const approval = await getApproval(input.approvalId);
  const config = getConfig();
  const idempotencyKey = approval.idempotency_key;

  // Already executed? Check before executable-status gate so callers get
  // DuplicateExecutionError (idempotency) rather than a generic status error.
  if (approval.status === "executed") {
    throw new DuplicateExecutionError("Approval already executed", {
      approvalId: approval.id,
      idempotencyKey,
    });
  }

  assertExecutableStatus(approval);
  assertApprovalNotExpired(approval);

  // In-flight guard (process-local + demo store)
  if (executingKeys.has(idempotencyKey)) {
    throw new DuplicateExecutionError("Approval execution already in progress", {
      approvalId: approval.id,
      idempotencyKey,
    });
  }

  const storeMatch =
    config.isDemoMode || !config.hasSupabase
      ? getDemoStore().approvals.find(
          (a) =>
            a.idempotency_key === idempotencyKey && a.status === "executed",
        )
      : null;
  if (storeMatch) {
    throw new DuplicateExecutionError("Idempotency key already used", {
      approvalId: approval.id,
      idempotencyKey,
    });
  }

  const args = {
    ...effectiveApprovalArgs(approval),
    ...input.overrideArgs,
  };

  const providerBackend =
    typeof args.__provider_backend === "string"
      ? (args.__provider_backend as WorkspaceExecutionBackend)
      : null;

  const enrichedArgs = await enrichMetaCampaignArgs(
    approval.tool_name,
    args,
    providerBackend,
  );

  const client =
    config.isDemoMode || !config.hasSupabase
      ? getDemoStore().clients.find((c) => c.id === approval.client_id)
      : null;

  if (client) {
    assertWithinBudgetCeiling(client, args, approval.budget_impact_cents);
  }

  // Mode gate: production/sandbox must not silently fall back to mock,
  // unless this approval targets Workspace V2 meta_direct (Facebook OAuth).
  if (
    (config.adsExecutionMode === "production" ||
      config.adsExecutionMode === "sandbox") &&
    providerBackend !== "meta_direct"
  ) {
    if (!config.hasAdspirerMcp) {
      throw new ProviderUnavailableError(
        `ADS_EXECUTION_MODE=${config.adsExecutionMode} requires ADSPIRER_MCP_URL`,
        { mode: config.adsExecutionMode },
      );
    }
  }

  executingKeys.add(idempotencyKey);
  assertTransition(approval.status, "executing");

  let working: Approval = {
    ...approval,
    status: "executing",
    updated_at: nowIso(),
  };
  await persist(working);

  try {
    const provider = await resolveProvider(providerBackend);
    const result = await dispatchToProvider(
      approval.tool_name,
      enrichedArgs,
      provider,
    );

    working = {
      ...working,
      status: "executed",
      execution_result: (result ?? {}) as Record<string, unknown>,
      execution_error: null,
      executed_at: nowIso(),
      reviewed_by: working.reviewed_by ?? input.executedBy,
      updated_at: nowIso(),
    };
    await persist(working);

    // Mark linked task done when all approvals are terminal
    if (working.task_id) {
      await completeTaskIfApprovalsTerminal(working.task_id);
      if (config.isDemoMode || !config.hasSupabase) {
        const task = getDemoStore().tasks.find((t) => t.id === working.task_id);
        if (task && task.status === "waiting_approval") {
          task.agent_state = {
            ...(task.agent_state ?? {}),
            phase: "completed",
            last_execution: working.tool_name,
            last_execution_result: working.execution_result,
          };
        }
      }
    }

    try {
      const { saveLearning } = await import("@/lib/agent/learning");
      const proof = summarizeExecutionProof(working.tool_name, result);
      await saveLearning({
        clientId: working.client_id,
        source: "execution_proof",
        insight: proof,
        createdBy: input.executedBy,
        evidence: {
          approvalId: working.id,
          toolName: working.tool_name,
          result: (result ?? null) as Record<string, unknown> | null,
        },
        weight: 1.1,
      });
    } catch {
      // learning is best-effort
    }

    logger.info("Executed approved action", {
      approvalId: working.id,
      toolName: working.tool_name,
      provider: provider.name,
      mode: config.adsExecutionMode,
    });

    return { approval: working, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Execution failed";
    // Return to editable state so the operator can fix args and approve again.
    assertTransition(working.status, "edited");
    working = {
      ...working,
      status: "edited",
      execution_error: message,
      updated_at: nowIso(),
    };
    await persist(working);
    logger.error("Approved action execution failed", {
      approvalId: working.id,
      toolName: working.tool_name,
      error: message,
    });
    throw error;
  } finally {
    executingKeys.delete(idempotencyKey);
  }
}

/**
 * A required arg the LLM (or an edit) dropped must stop the run here —
 * `String(undefined)` used to ship the literal text "undefined" to Adspirer,
 * which published a campaign actually named "undefined - <timestamp>".
 */
function requireString(
  args: Record<string, unknown>,
  key: string,
  toolName: string,
  aliases: string[] = [],
): string {
  for (const candidate of [key, ...aliases]) {
    const value = args[candidate];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  throw new Error(
    `${toolName} is missing "${key}". Use Edit on the approval to add it, then approve again.`,
  );
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === "string")
    ? (value as string[])
    : undefined;
}

async function enrichMetaCampaignArgs(
  toolName: string,
  args: Record<string, unknown>,
  backend: WorkspaceExecutionBackend | null,
): Promise<Record<string, unknown>> {
  let next = normalizeMetaApprovalArgs(toolName, args);

  const needsPage = [
    "create_meta_image_campaign",
    "create_meta_video_campaign",
    "create_adset",
    "create_ad",
  ].includes(toolName);

  if (backend !== "meta_direct" || !needsPage) return next;
  if (optionalString(next.facebook_page_id)) return next;

  const accountId =
    optionalString(next.account_id) ?? optionalString(next.ad_account_id);
  if (!accountId) return next;

  const { resolveFacebookPageIdForAccount } = await import(
    "@/lib/meta/resolve-page"
  );
  const pageId = await resolveFacebookPageIdForAccount(accountId);
  return { ...next, facebook_page_id: pageId };
}

/**
 * Adspirer's create_meta_image_campaign / create_meta_video_campaign /
 * add_meta_ad_set accept far more than our typed core (interests, custom
 * audiences, dynamic-creative arrays, placements, DSA fields…). Anything on
 * this list found in the approval args is forwarded verbatim, so operators/the
 * agent can use the full schema without a code change per field.
 */
const CAMPAIGN_PASSTHROUGH_KEYS = [
  "location_types",
  "interests",
  "behaviors",
  "job_titles",
  "work_employers",
  "life_events",
  "education_schools",
  "education_majors",
  "custom_audiences",
  "excluded_custom_audiences",
  "lead_form_id",
  "multi_advertiser",
  "advantage_audience",
  "advantage_plus_creative",
  "disabled_creative_features",
  "primary_texts",
  "headlines",
  "descriptions",
  "facebook_positions",
  "instagram_positions",
  "story_image_url",
  "right_column_image_url",
  "destination_type",
  "dsa_beneficiary",
  "dsa_payor",
  "daily_min_spend_target",
  "daily_spend_cap",
  "custom_conversion_id",
] as const;

function collectPassthrough(
  args: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const extra: Record<string, unknown> = {};
  for (const key of CAMPAIGN_PASSTHROUGH_KEYS) {
    if (args[key] !== undefined && args[key] !== null) extra[key] = args[key];
  }
  return Object.keys(extra).length ? extra : undefined;
}

async function dispatchToProvider(
  toolName: string,
  args: Record<string, unknown>,
  resolvedProvider?: MetaAdsProvider,
): Promise<unknown> {
  const backend =
    typeof args.__provider_backend === "string"
      ? (args.__provider_backend as WorkspaceExecutionBackend)
      : null;
  delete args.__provider_backend;
  const provider =
    resolvedProvider ??
    (backend ? getProviderForBackend(backend) : getProvider());

  switch (toolName) {
    case "update_adset_budget":
      return provider.updateAdSetBudget({
        account_id: String(args.account_id),
        adset_id: String(args.adset_id),
        daily_budget_cents: Number(args.daily_budget_cents),
      });
    case "pause_campaign":
      return provider.pauseCampaign(
        String(args.account_id),
        String(args.campaign_id),
      );
    case "resume_campaign":
      return provider.resumeCampaign(
        String(args.account_id),
        String(args.campaign_id),
      );
    case "create_campaign":
      return provider.createCampaign({
        account_id: requireString(args, "account_id", toolName, [
          "ad_account_id",
        ]),
        name: requireString(args, "name", toolName, ["campaign_name"]),
        objective: String(args.objective ?? "OUTCOME_TRAFFIC"),
        status: (args.status as "ACTIVE" | "PAUSED" | undefined) ?? "PAUSED",
        daily_budget_cents:
          typeof args.daily_budget_cents === "number"
            ? args.daily_budget_cents
            : undefined,
        special_ad_categories: Array.isArray(args.special_ad_categories)
          ? (args.special_ad_categories as string[])
          : undefined,
      });
    case "create_meta_image_campaign":
      return provider.createImageCampaign({
        account_id: requireString(args, "account_id", toolName, [
          "ad_account_id",
        ]),
        campaign_name: requireString(args, "campaign_name", toolName, ["name"]),
        objective: optionalString(args.objective),
        budget_daily: resolveBudgetDaily(args) ?? optionalNumber(args.budget_daily),
        budget_lifetime: optionalNumber(args.budget_lifetime),
        end_time: optionalString(args.end_time),
        primary_text: requireString(args, "primary_text", toolName),
        headline: requireString(args, "headline", toolName),
        description: optionalString(args.description),
        call_to_action: optionalString(args.call_to_action),
        landing_page_url: requireString(args, "landing_page_url", toolName),
        display_link: optionalString(args.display_link),
        url_tags: optionalString(args.url_tags),
        image_url: optionalString(args.image_url),
        existing_image_hash: optionalString(args.existing_image_hash),
        ad_set_name: optionalString(args.ad_set_name),
        ad_name: optionalString(args.ad_name),
        age_min: optionalNumber(args.age_min),
        age_max: optionalNumber(args.age_max),
        genders: optionalStringArray(args.genders),
        locations: Array.isArray(args.locations) ? args.locations : undefined,
        publisher_platforms: optionalStringArray(args.publisher_platforms),
        special_ad_categories: optionalStringArray(args.special_ad_categories),
        campaign_budget_optimization:
          typeof args.campaign_budget_optimization === "boolean"
            ? args.campaign_budget_optimization
            : undefined,
        pixel_id: optionalString(args.pixel_id),
        pixel_event_name: optionalString(args.pixel_event_name),
        instagram_account_id: optionalString(args.instagram_account_id),
        facebook_page_id: optionalString(args.facebook_page_id),
        extra_args: collectPassthrough(args),
      });
    case "create_meta_video_campaign": {
      const videoUrl = optionalString(args.video_url);
      const existingVideoId = optionalString(args.existing_video_id);
      if (!videoUrl && !existingVideoId) {
        throw new Error(
          "create_meta_video_campaign requires video_url or existing_video_id",
        );
      }
      return provider.createVideoCampaign({
        account_id: requireString(args, "account_id", toolName, [
          "ad_account_id",
        ]),
        campaign_name: requireString(args, "campaign_name", toolName, ["name"]),
        objective: optionalString(args.objective),
        budget_daily: resolveBudgetDaily(args) ?? optionalNumber(args.budget_daily),
        budget_lifetime: optionalNumber(args.budget_lifetime),
        end_time: optionalString(args.end_time),
        primary_text: requireString(args, "primary_text", toolName),
        headline: optionalString(args.headline),
        description: optionalString(args.description),
        call_to_action: optionalString(args.call_to_action),
        landing_page_url: requireString(args, "landing_page_url", toolName),
        display_link: optionalString(args.display_link),
        url_tags: optionalString(args.url_tags),
        video_url: videoUrl,
        existing_video_id: existingVideoId,
        thumbnail_url: optionalString(args.thumbnail_url),
        ad_set_name: optionalString(args.ad_set_name),
        ad_name: optionalString(args.ad_name),
        age_min: optionalNumber(args.age_min),
        age_max: optionalNumber(args.age_max),
        genders: optionalStringArray(args.genders),
        locations: Array.isArray(args.locations) ? args.locations : undefined,
        publisher_platforms: optionalStringArray(args.publisher_platforms),
        special_ad_categories: optionalStringArray(args.special_ad_categories),
        campaign_budget_optimization:
          typeof args.campaign_budget_optimization === "boolean"
            ? args.campaign_budget_optimization
            : undefined,
        pixel_id: optionalString(args.pixel_id),
        pixel_event_name: optionalString(args.pixel_event_name),
        instagram_account_id: optionalString(args.instagram_account_id),
        facebook_page_id: optionalString(args.facebook_page_id),
        extra_args: collectPassthrough(args),
      });
    }
    case "create_adset": {
      const normalized = normalizeCreateAdSetArgs(args);
      return provider.createAdSet({
        account_id: requireString(normalized, "account_id", toolName, [
          "ad_account_id",
        ]),
        campaign_id: requireString(normalized, "campaign_id", toolName),
        name:
          typeof normalized.name === "string" ? normalized.name : undefined,
        budget_daily: resolveBudgetDaily(normalized),
        ad_type:
          normalized.ad_type === "video" || normalized.ad_type === "carousel"
            ? normalized.ad_type
            : "image",
        landing_page_url: String(normalized.landing_page_url),
        primary_text: String(normalized.primary_text),
        headline:
          typeof normalized.headline === "string"
            ? normalized.headline
            : undefined,
        description: optionalString(normalized.description),
        call_to_action: optionalString(normalized.call_to_action),
        image_url:
          typeof normalized.image_url === "string"
            ? normalized.image_url
            : undefined,
        video_url: optionalString(normalized.video_url),
        existing_video_id: optionalString(normalized.existing_video_id),
        thumbnail_url: optionalString(normalized.thumbnail_url),
        age_min:
          typeof normalized.age_min === "number"
            ? normalized.age_min
            : undefined,
        age_max:
          typeof normalized.age_max === "number"
            ? normalized.age_max
            : undefined,
        genders: optionalStringArray(normalized.genders),
        locations: Array.isArray(normalized.locations)
          ? normalized.locations
          : undefined,
        publisher_platforms: optionalStringArray(
          normalized.publisher_platforms,
        ),
        objective: optionalString(normalized.objective),
        facebook_page_id: optionalString(normalized.facebook_page_id),
        pixel_id: optionalString(normalized.pixel_id),
        pixel_event_name: optionalString(normalized.pixel_event_name),
        campaign_budget_optimization:
          typeof normalized.campaign_budget_optimization === "boolean"
            ? normalized.campaign_budget_optimization
            : undefined,
        extra_args: collectPassthrough(normalized),
      });
    }
    case "create_ad":
      return provider.createAd({
        account_id: requireString(args, "account_id", toolName, [
          "ad_account_id",
        ]),
        ad_set_id: requireString(args, "ad_set_id", toolName, ["adset_id"]),
        ad_type:
          args.ad_type === "video" || args.ad_type === "carousel"
            ? args.ad_type
            : "image",
        primary_text: requireString(args, "primary_text", toolName),
        landing_page_url: requireString(args, "landing_page_url", toolName),
        display_link: optionalString(args.display_link),
        url_tags: optionalString(args.url_tags),
        headline:
          typeof args.headline === "string" ? args.headline : undefined,
        description: optionalString(args.description),
        call_to_action: optionalString(args.call_to_action),
        image_url:
          typeof args.image_url === "string" ? args.image_url : undefined,
        existing_image_hash:
          typeof args.existing_image_hash === "string"
            ? args.existing_image_hash
            : undefined,
        video_url: optionalString(args.video_url),
        existing_video_id: optionalString(args.existing_video_id),
        thumbnail_url: optionalString(args.thumbnail_url),
        name: typeof args.name === "string" ? args.name : undefined,
        facebook_page_id: optionalString(args.facebook_page_id),
        instagram_account_id: optionalString(args.instagram_account_id),
      });
    case "pause_ad":
      return provider.pauseAd(String(args.account_id), String(args.ad_id));
    default:
      throw new Error(`No provider dispatch for tool: ${toolName}`);
  }
}

/** Fill Adspirer-required create_adset fields so older pending approvals still execute. */
function normalizeCreateAdSetArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const name =
    (typeof args.name === "string" && args.name.trim()) ||
    "Ad Set";
  const landing =
    (typeof args.landing_page_url === "string" && args.landing_page_url.trim()) ||
    (typeof args.website_url === "string" && args.website_url.trim()) ||
    (typeof args.url === "string" && args.url.trim()) ||
    (typeof args.landing_url === "string" && args.landing_url.trim()) ||
    "";
  const primary =
    (typeof args.primary_text === "string" && args.primary_text.trim()) ||
    `${name} — Learn more. Created via Adspirer AI (paused).`;

  if (!landing || !/^https?:\/\//i.test(landing)) {
    throw new Error(
      "This create_adset approval is missing landing_page_url. Click Edit, add a full https:// website URL, Save, then Approve again. New ad sets are created PAUSED (not published).",
    );
  }

  return {
    ...args,
    name,
    ad_type: args.ad_type ?? "image",
    primary_text: primary,
    landing_page_url: landing,
    headline:
      (typeof args.headline === "string" && args.headline.trim()) ||
      name.slice(0, 40),
  };
}

function summarizeExecutionProof(toolName: string, result: unknown): string {
  const obj =
    result && typeof result === "object"
      ? (result as Record<string, unknown>)
      : {};
  const ids = [
    typeof obj.id === "string" ? `id=${obj.id}` : null,
    typeof obj.campaign_id === "string" ? `campaign_id=${obj.campaign_id}` : null,
    typeof obj.ad_set_id === "string" ? `ad_set_id=${obj.ad_set_id}` : null,
    typeof obj.adset_id === "string" ? `adset_id=${obj.adset_id}` : null,
    typeof obj.ad_id === "string" ? `ad_id=${obj.ad_id}` : null,
  ].filter(Boolean);
  if (ids.length) {
    return `Executed ${toolName} successfully (PAUSED entities). Proof: ${ids.join(", ")}. After campaign creates, ask for website URL → scrape services → create ad sets/ads.`;
  }
  return `Executed ${toolName} successfully. Report returned IDs/status as proof; keep new entities PAUSED and continue the builder stages.`;
}

async function persist(approval: Approval): Promise<void> {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    const store = getDemoStore();
    const idx = store.approvals.findIndex((a) => a.id === approval.id);
    if (idx >= 0) store.approvals[idx] = approval;
    else store.approvals.push(approval);
    return;
  }
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("approvals")
    .update(toApprovalInsert(approval))
    .eq("id", approval.id);
  if (error) throw new Error(error.message);
}
