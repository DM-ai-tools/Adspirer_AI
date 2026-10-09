import type { Approval } from "@/types";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { resolveProvider } from "@/lib/adspirer/client";
import type { MetaAdsProvider } from "@/lib/adspirer/provider";
import {
  ApprovalValidationError,
  DuplicateExecutionError,
  ExecutionVerificationError,
  ProviderUnavailableError,
} from "@/lib/errors";
import {
  assertApprovalNotExpired,
  assertExecutableStatus,
  assertTransition,
  canTransition,
  effectiveApprovalArgs,
} from "@/lib/approvals/validator";
import { getApproval, getClient } from "@/lib/approvals/service";
import { prepareApprovalArgs } from "@/lib/approvals/validate-args";
import { nowIso } from "@/lib/utils";
import { toApprovalInsert } from "@/lib/db/live-maps";
import { completeTaskIfApprovalsTerminal } from "@/lib/workflow/bindings";
import { logger } from "@/lib/observability/logger";
import type { WorkspaceExecutionBackend } from "@/lib/runtime/workspace-context";
import { resolveBudgetDaily } from "@/lib/meta/resolve-budget-daily";
import { resolveAdSetIdForCreateAd } from "@/lib/meta/resolve-ad-set";
import {
  PartialCreateError,
  describeProgress,
  hasProgress,
  parseProgress,
  type CreateProgress,
} from "@/lib/meta/create-progress";

const executingKeys = new Set<string>();

export type ExecuteApprovedActionResult = {
  approval: Approval;
  result: unknown;
};

/** Tools that build several Meta entities and can resume a failed run. */
const RESUMABLE_TOOLS = new Set([
  "create_meta_image_campaign",
  "create_meta_video_campaign",
  "create_ad",
]);

/**
 * Execute an approved action with idempotency protection.
 * Enforces ADS_EXECUTION_MODE — production/sandbox require MCP provider availability.
 *
 * Once Meta has accepted the change, the call reports success no matter what
 * happens to the bookkeeping afterwards (status write, task completion,
 * learning) — a post-success failure must never send the approval back for a
 * second, duplicating run.
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

  executingKeys.add(idempotencyKey);
  assertTransition(approval.status, "executing");

  // Entities a previous failed run already created (all PAUSED).
  const priorProgress = RESUMABLE_TOOLS.has(approval.tool_name)
    ? parseProgress(
        (approval.execution_result as Record<string, unknown> | null)?.created,
      )
    : null;
  const priorAccount =
    typeof approval.execution_result?.account_id === "string"
      ? approval.execution_result.account_id
      : null;

  let working: Approval = {
    ...approval,
    status: "executing",
    updated_at: nowIso(),
  };
  // Claim the approval before any slow work (page lookups, provider calls).
  // The conditional write is the cross-process guard: two concurrent approve
  // clicks can both pass the checks above, but only one claim succeeds.
  try {
    await claimForExecution(working, approval.status);
  } catch (error) {
    executingKeys.delete(idempotencyKey);
    throw error;
  }

  let progress: CreateProgress | null = priorProgress;
  let accountId: string | null = priorAccount;

  try {
    let result: unknown;
    try {
      const rawArgs = {
        ...effectiveApprovalArgs(approval),
        ...input.overrideArgs,
      };
      const providerBackend =
        typeof rawArgs.__provider_backend === "string"
          ? (rawArgs.__provider_backend as WorkspaceExecutionBackend)
          : null;

      // Re-validate right before execution: schema, coercion, granted
      // account and the (live, not demo-only) budget ceiling.
      const client = await getClient(approval.client_id);
      const prepared = await prepareApprovalArgs({
        toolName: approval.tool_name,
        clientId: approval.client_id,
        args: rawArgs,
        client,
      });

      // Live executions only ever go to Meta directly. resolveProvider() throws
      // rather than falling back to mock data, so nothing "succeeds" silently.
      if (
        (config.adsExecutionMode === "production" ||
          config.adsExecutionMode === "sandbox") &&
        providerBackend &&
        providerBackend !== "meta_direct"
      ) {
        throw new ProviderUnavailableError(
          "This approval was created for a backend that is no longer supported. Ask the agent to propose it again.",
          { backend: providerBackend },
        );
      }

      const enrichedArgs = await enrichMetaCampaignArgs(
        approval.tool_name,
        prepared.args,
        providerBackend,
      );
      accountId =
        typeof enrichedArgs.account_id === "string" ? enrichedArgs.account_id : null;

      if (priorProgress && priorAccount && accountId !== priorAccount) {
        throw new ApprovalValidationError(
          `This approval already created PAUSED entities in ${priorAccount} (${describeProgress(priorProgress)}) but now targets ${accountId}. Reject it and ask for a new proposal so nothing is duplicated.`,
        );
      }

      const provider = await resolveProvider(providerBackend);
      const checkpoint = async (next: CreateProgress) => {
        progress = next;
        working = {
          ...working,
          execution_result: {
            partial: true,
            account_id: accountId,
            created: { ...next },
          },
          updated_at: nowIso(),
        };
        try {
          await persist(working);
        } catch (error) {
          logger.warn("Could not checkpoint execution progress", {
            approvalId: working.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      };

      result = await dispatchToProvider(approval.tool_name, enrichedArgs, provider, {
        resume: priorProgress ?? undefined,
        onProgress: checkpoint,
      });
    } catch (error) {
      if (error instanceof PartialCreateError && hasProgress(error.progress)) {
        progress = error.progress;
      }
      await recordFailure(working, error, progress, accountId);
      throw error;
    }

    // ---- Meta succeeded: everything below is best-effort bookkeeping ----
    const executionResult = buildExecutionResult(approval.tool_name, result, accountId);
    working = {
      ...working,
      status: "executed",
      execution_result: executionResult,
      execution_error: null,
      executed_at: nowIso(),
      reviewed_by: working.reviewed_by ?? input.executedBy,
      updated_at: nowIso(),
    };
    await persistBestEffort(working);

    // Mark linked task done when all approvals are terminal
    if (working.task_id) {
      try {
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
      } catch (error) {
        logger.warn("Task completion after execution failed", {
          approvalId: working.id,
          taskId: working.task_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    try {
      const { saveLearning } = await import("@/lib/agent/learning");
      const proof = summarizeExecutionProof(working.tool_name, executionResult);
      await saveLearning({
        clientId: working.client_id,
        source: "execution_proof",
        insight: proof,
        createdBy: input.executedBy,
        evidence: {
          approvalId: working.id,
          toolName: working.tool_name,
          result: executionResult,
        },
        weight: 1.1,
      });
    } catch {
      // learning is best-effort
    }

    logger.info("Executed approved action", {
      approvalId: working.id,
      toolName: working.tool_name,
      mode: config.adsExecutionMode,
    });

    return { approval: working, result };
  } finally {
    executingKeys.delete(idempotencyKey);
  }
}

/**
 * Persist the failure without ever throwing over the original error.
 * Verification mismatches (Meta accepted but reads back differently) become
 * `failed`; everything else returns to `edited` so the operator can fix args.
 * Already-created entity IDs stay in execution_result for the next run.
 */
async function recordFailure(
  working: Approval,
  error: unknown,
  progress: CreateProgress | null,
  accountId: string | null,
): Promise<void> {
  const message = error instanceof Error ? error.message : "Execution failed";
  const target: Approval["status"] =
    error instanceof ExecutionVerificationError ? "failed" : "edited";
  const created = progress && hasProgress(progress) ? progress : null;
  const executionError =
    created && !message.includes("Already created in Meta")
      ? `${message} Already created in Meta (PAUSED, not live): ${describeProgress(created)}. Approving again reuses them instead of creating duplicates.`
      : message;

  const failed: Approval = {
    ...working,
    status: canTransition(working.status, target) ? target : working.status,
    execution_error: executionError,
    execution_result: created
      ? { partial: true, account_id: accountId, created: { ...created } }
      : working.execution_result,
    updated_at: nowIso(),
  };
  try {
    await persist(failed);
  } catch (persistError) {
    // Left in `executing`; the stale-execution reaper will fail it later.
    logger.error("Could not record execution failure", {
      approvalId: working.id,
      error:
        persistError instanceof Error ? persistError.message : String(persistError),
    });
  }
  logger.error("Approved action execution failed", {
    approvalId: working.id,
    toolName: working.tool_name,
    error: message,
    created: created ?? undefined,
  });
}

/** Retry the success write once; a lost write is logged, never surfaced as failure. */
async function persistBestEffort(approval: Approval): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await persist(approval);
      return;
    } catch (error) {
      logger.error("Could not record successful execution", {
        approvalId: approval.id,
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** Flatten the provider result + IDs into what the approval row stores. */
function buildExecutionResult(
  toolName: string,
  result: unknown,
  accountId: string | null,
): Record<string, unknown> {
  const obj =
    result && typeof result === "object"
      ? { ...(result as Record<string, unknown>) }
      : {};
  const pickId = (value: unknown): string | undefined =>
    value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string"
      ? (value as { id: string }).id
      : undefined;

  const proof: Record<string, unknown> = {};
  if (toolName === "create_meta_image_campaign" || toolName === "create_meta_video_campaign") {
    const campaignId = pickId(obj.campaign);
    const adSetId = pickId(obj.adset);
    const adId = pickId(obj.ad);
    if (campaignId) proof.campaign_id = campaignId;
    if (adSetId) proof.ad_set_id = adSetId;
    if (adId) proof.ad_id = adId;
    proof.status = "PAUSED";
  } else if (toolName === "create_adset") {
    if (typeof obj.id === "string") proof.ad_set_id = obj.id;
    if (typeof obj.campaign_id === "string") proof.campaign_id = obj.campaign_id;
    proof.status = "PAUSED";
  } else if (toolName === "create_ad") {
    if (typeof obj.id === "string") proof.ad_id = obj.id;
    if (typeof obj.adset_id === "string") proof.ad_set_id = obj.adset_id;
    proof.status = "PAUSED";
  } else if (toolName === "create_campaign") {
    if (typeof obj.id === "string") proof.campaign_id = obj.id;
    if (typeof obj.status === "string") proof.status = obj.status;
  } else if (toolName === "update_adset_budget") {
    if (typeof obj.id === "string") proof.ad_set_id = obj.id;
    if (typeof obj.daily_budget_cents === "number") {
      proof.daily_budget_cents = obj.daily_budget_cents;
    }
    if (typeof obj.currency === "string") proof.currency = obj.currency;
  } else if (toolName === "pause_campaign" || toolName === "resume_campaign") {
    if (typeof obj.id === "string") proof.campaign_id = obj.id;
    if (typeof obj.status === "string") proof.status = obj.status;
  } else if (toolName === "pause_ad") {
    if (typeof obj.id === "string") proof.ad_id = obj.id;
    if (typeof obj.status === "string") proof.status = obj.status;
  }
  if (typeof obj.verified === "boolean") proof.verified = obj.verified;

  return {
    ...obj,
    ...(accountId ? { account_id: accountId } : {}),
    proof,
  };
}

/**
 * A required arg the LLM (or an edit) dropped must stop the run here —
 * `String(undefined)` used to ship the literal text "undefined" to Meta,
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
  throw new ApprovalValidationError(
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
  const next = { ...args };

  const needsPage = [
    "create_meta_image_campaign",
    "create_meta_video_campaign",
    "create_adset",
    "create_ad",
  ].includes(toolName);

  if (backend !== "meta_direct" || !needsPage) return next;
  if (optionalString(next.facebook_page_id)) return next;

  const accountId = optionalString(next.account_id);
  if (!accountId) return next;

  const { resolveFacebookPageIdForAccount } = await import(
    "@/lib/meta/resolve-page"
  );
  const pageId = await resolveFacebookPageIdForAccount(accountId);
  return { ...next, facebook_page_id: pageId };
}

/**
 * Fields beyond the typed core that the Graph provider actually applies
 * (targeting extras, placements, DSA, lead forms). Fields it cannot apply are
 * rejected at validation time (see validate-args UNSUPPORTED_KEYS) instead of
 * being forwarded and silently dropped.
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
  "advantage_audience",
  "facebook_positions",
  "instagram_positions",
  "audience_network_positions",
  "messenger_positions",
  "destination_type",
  "dsa_beneficiary",
  "dsa_payor",
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

type DispatchOptions = {
  resume?: CreateProgress;
  onProgress?: (progress: CreateProgress) => Promise<void>;
};

async function dispatchToProvider(
  toolName: string,
  args: Record<string, unknown>,
  provider: MetaAdsProvider,
  options: DispatchOptions = {},
): Promise<unknown> {
  switch (toolName) {
    case "update_adset_budget":
      return provider.updateAdSetBudget({
        // Expected account only — the provider derives the real one from the
        // ad set and refuses on mismatch.
        account_id: optionalString(args.account_id),
        adset_id: requireString(args, "adset_id", toolName),
        daily_budget_cents: args.daily_budget_cents as number,
      });
    case "pause_campaign":
      return provider.pauseCampaign(
        requireString(args, "account_id", toolName),
        requireString(args, "campaign_id", toolName),
      );
    case "resume_campaign":
      return provider.resumeCampaign(
        requireString(args, "account_id", toolName),
        requireString(args, "campaign_id", toolName),
      );
    case "create_campaign":
      return provider.createCampaign({
        account_id: requireString(args, "account_id", toolName),
        name: requireString(args, "name", toolName, ["campaign_name"]),
        objective: requireString(args, "objective", toolName),
        status: (args.status as "ACTIVE" | "PAUSED" | undefined) ?? "PAUSED",
        daily_budget_cents: optionalNumber(args.daily_budget_cents),
        special_ad_categories: optionalStringArray(args.special_ad_categories),
      });
    case "create_meta_image_campaign":
      return provider.createImageCampaign({
        account_id: requireString(args, "account_id", toolName),
        campaign_name: requireString(args, "campaign_name", toolName, ["name"]),
        objective: optionalString(args.objective),
        budget_daily: resolveBudgetDaily(args),
        budget_lifetime: optionalNumber(args.budget_lifetime),
        start_time: optionalString(args.start_time),
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
        lead_form_id: optionalString(args.lead_form_id),
        instagram_account_id: optionalString(args.instagram_account_id),
        facebook_page_id: optionalString(args.facebook_page_id),
        extra_args: collectPassthrough(args),
        resume: options.resume,
        onProgress: options.onProgress,
      });
    case "create_meta_video_campaign": {
      const videoUrl = optionalString(args.video_url);
      const existingVideoId = optionalString(args.existing_video_id);
      if (!videoUrl && !existingVideoId) {
        throw new ApprovalValidationError(
          "create_meta_video_campaign requires video_url or existing_video_id",
        );
      }
      return provider.createVideoCampaign({
        account_id: requireString(args, "account_id", toolName),
        campaign_name: requireString(args, "campaign_name", toolName, ["name"]),
        objective: optionalString(args.objective),
        budget_daily: resolveBudgetDaily(args),
        budget_lifetime: optionalNumber(args.budget_lifetime),
        start_time: optionalString(args.start_time),
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
        lead_form_id: optionalString(args.lead_form_id),
        instagram_account_id: optionalString(args.instagram_account_id),
        facebook_page_id: optionalString(args.facebook_page_id),
        extra_args: collectPassthrough(args),
        resume: options.resume,
        onProgress: options.onProgress,
      });
    }
    case "create_adset":
      return provider.createAdSet({
        account_id: requireString(args, "account_id", toolName),
        campaign_id: requireString(args, "campaign_id", toolName),
        name: optionalString(args.name),
        budget_daily: resolveBudgetDaily(args),
        budget_lifetime: optionalNumber(args.budget_lifetime),
        start_time: optionalString(args.start_time),
        end_time: optionalString(args.end_time),
        ad_type:
          args.ad_type === "video" || args.ad_type === "carousel"
            ? args.ad_type
            : "image",
        landing_page_url: requireString(args, "landing_page_url", toolName),
        primary_text: requireString(args, "primary_text", toolName),
        headline: optionalString(args.headline),
        description: optionalString(args.description),
        call_to_action: optionalString(args.call_to_action),
        image_url: optionalString(args.image_url),
        video_url: optionalString(args.video_url),
        existing_video_id: optionalString(args.existing_video_id),
        thumbnail_url: optionalString(args.thumbnail_url),
        age_min: optionalNumber(args.age_min),
        age_max: optionalNumber(args.age_max),
        genders: optionalStringArray(args.genders),
        locations: Array.isArray(args.locations) ? args.locations : undefined,
        publisher_platforms: optionalStringArray(args.publisher_platforms),
        objective: optionalString(args.objective),
        facebook_page_id: optionalString(args.facebook_page_id),
        pixel_id: optionalString(args.pixel_id),
        pixel_event_name: optionalString(args.pixel_event_name),
        lead_form_id: optionalString(args.lead_form_id),
        campaign_budget_optimization:
          typeof args.campaign_budget_optimization === "boolean"
            ? args.campaign_budget_optimization
            : undefined,
        extra_args: collectPassthrough(args),
      });
    case "create_ad": {
      const adSetId =
        optionalString(args.ad_set_id) ??
        optionalString(args.adset_id) ??
        (await resolveAdSetIdForCreateAd(provider, args));
      if (!adSetId) {
        throw new ApprovalValidationError(
          'create_ad is missing "ad_set_id". Include ad_set_id, or campaign_name + ad_set_name so we can look up the ad set on Meta. Use Edit on the approval to add it, then approve again.',
        );
      }
      return provider.createAd({
        account_id: requireString(args, "account_id", toolName),
        ad_set_id: adSetId,
        ad_type:
          args.ad_type === "video" || args.ad_type === "carousel"
            ? args.ad_type
            : "image",
        primary_text: requireString(args, "primary_text", toolName),
        landing_page_url: requireString(args, "landing_page_url", toolName),
        display_link: optionalString(args.display_link),
        url_tags: optionalString(args.url_tags),
        headline: optionalString(args.headline),
        description: optionalString(args.description),
        call_to_action: optionalString(args.call_to_action),
        image_url: optionalString(args.image_url),
        existing_image_hash: optionalString(args.existing_image_hash),
        video_url: optionalString(args.video_url),
        existing_video_id: optionalString(args.existing_video_id),
        thumbnail_url: optionalString(args.thumbnail_url),
        name: optionalString(args.name),
        facebook_page_id: optionalString(args.facebook_page_id),
        instagram_account_id: optionalString(args.instagram_account_id),
        lead_form_id: optionalString(args.lead_form_id),
        resume: options.resume,
        onProgress: options.onProgress,
      });
    }
    case "pause_ad":
      return provider.pauseAd(
        requireString(args, "account_id", toolName),
        requireString(args, "ad_id", toolName),
      );
    default:
      throw new ApprovalValidationError(
        `No provider dispatch for tool: ${toolName}`,
      );
  }
}

function summarizeExecutionProof(
  toolName: string,
  result: Record<string, unknown>,
): string {
  const proof =
    result.proof && typeof result.proof === "object"
      ? (result.proof as Record<string, unknown>)
      : {};
  const ids = Object.entries(proof)
    .filter(([k, v]) => /_id$/.test(k) && typeof v === "string")
    .map(([k, v]) => `${k}=${String(v)}`);
  if (toolName.startsWith("create_")) {
    return ids.length
      ? `Executed ${toolName} successfully (PAUSED entities). Proof: ${ids.join(", ")}. After campaign creates, ask for website URL → scrape services → create ad sets/ads.`
      : `Executed ${toolName} successfully. Report returned IDs/status as proof; keep new entities PAUSED and continue the builder stages.`;
  }
  return ids.length
    ? `Executed ${toolName} successfully. Proof: ${ids.join(", ")}.`
    : `Executed ${toolName} successfully.`;
}

/** Move an approval to `executing` only if it is still in `expectedStatus`. */
async function claimForExecution(
  approval: Approval,
  expectedStatus: Approval["status"],
): Promise<void> {
  const config = getConfig();
  const conflict = () =>
    new DuplicateExecutionError("Approval execution already in progress", {
      approvalId: approval.id,
      idempotencyKey: approval.idempotency_key,
    });

  if (config.isDemoMode || !config.hasSupabase) {
    const current = getDemoStore().approvals.find((a) => a.id === approval.id);
    if (current && current.status !== expectedStatus) throw conflict();
    await persist(approval);
    return;
  }
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("approvals")
    .update(toApprovalInsert(approval))
    .eq("id", approval.id)
    .eq("status", expectedStatus)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw conflict();
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
