import { detectCreativeFormat } from "@/lib/agent/creative-format";
import type { LanguageModel, ModelMessage, SystemModelMessage } from "ai";
import {
  asksAboutDeliveryStructure,
  gatherDeliveryStructure,
} from "@/lib/agent/delivery-structure";
import { formatCtaForDisplay } from "@/lib/meta/extract-creative-destination";
import { evaluateCheckpoints } from "@/lib/audit/checkpoints";
import { applyChatSettings, settingsNoticeLines, type ChatSettingsTurn } from "@/lib/clients/chat-settings";
import { resolveGoals, type GoalsProfile, type ResolvedGoals } from "@/lib/clients/goals";

/**
 * The client's goals for judging the account; defaults when it can't be loaded.
 * `override` holds values stated this turn (used even when they weren't saved).
 */
async function clientGoals(clientId: string, override: GoalsProfile = {}): Promise<ResolvedGoals> {
  try {
    const { getClient } = await import("@/lib/approvals/service");
    const client = await getClient(clientId);
    return resolveGoals({ goals_profile: { ...(client.goals_profile ?? {}), ...override } });
  } catch {
    return resolveGoals({ goals_profile: { ...override } });
  }
}

/** Active services / categories as stored. Unlike ensureClientServices, never seeds a default. */
async function activeClientServices(clientId: string): Promise<ClientService[]> {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    return getDemoStore().clientServices.filter((s) => s.client_id === clientId && s.is_active);
  }
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { data, error } = await createAdminClient()
    .from("client_services")
    .select("*")
    .eq("client_id", clientId)
    .eq("is_active", true);
  if (error) throw new Error(error.message);
  return (data ?? []) as ClientService[];
}

/**
 * Catalog ads' spend per product, each product tagged with its GA4 item category so the spend
 * can go to a category. A snapshot without catalog spend is returned untouched; when GA4 isn't
 * mapped or won't load, the products stay uncategorised and a warning says so.
 */
async function withCatalogCategories(clientId: string, snapshot: MetaAuditSnapshot): Promise<MetaAuditSnapshot> {
  if (!snapshot.catalogProducts?.length) return snapshot;
  const warn = (reason: string): MetaAuditSnapshot => ({
    ...snapshot,
    warnings: [...snapshot.warnings, `Catalog ad spend can't be matched to categories: ${reason}.`],
  });
  try {
    const { ga4 } = await clientGoogleAssets(clientId);
    if (!ga4) return warn("no GA4 property is connected for this client");
    const categories = await getGoogleDataProvider().ga4ItemCategories(ga4.external_id, {
      since: snapshot.period.since,
      until: snapshot.period.until,
    });
    return {
      ...snapshot,
      catalogProducts: snapshot.catalogProducts.map((p) => ({ ...p, itemCategory: categories.get(p.productId) ?? null })),
    };
  } catch (error) {
    return warn(`GA4 item categories didn't load (${error instanceof Error ? error.message : String(error)})`);
  }
}

/**
 * The client's Google figures per category for the snapshot's period, read-only.
 * Nothing when no Google asset is mapped (or the mapping can't be read), so those
 * clients keep the Meta-only evidence; a Google load that fails outright becomes a
 * warning, never an error.
 */
async function loadChannelPerformance(
  clientId: string,
  snapshot: MetaAuditSnapshot,
  categories: StrategyCategory[],
  metaAttribution: CategoryAttribution,
): Promise<{ channels?: ChannelPerformance; channelWarnings: string[] }> {
  try {
    const assets = await clientGoogleAssets(clientId);
    if (!assets.ga4 && !assets.ads && !assets.gsc) return { channelWarnings: [] };
  } catch (error) {
    logger.warn("agent.google_assets_unreadable", {
      clientId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { channelWarnings: [] };
  }
  try {
    const google = await loadChannelSnapshot(clientId, {
      since: snapshot.period.since,
      until: snapshot.period.until,
    });
    const channels = buildChannelPerformance({
      categories,
      metaAttribution,
      metaCurrency: snapshot.account.currency,
      snapshot: google,
    });
    return { channels, channelWarnings: [] };
  } catch (error) {
    return {
      channelWarnings: [
        `Google data couldn't load (${error instanceof Error ? error.message : String(error)}), so the figures are Meta only.`,
      ],
    };
  }
}
import { scopeAuditSnapshot, type MetaAuditSnapshot } from "@/lib/audit/meta-audit-data";
import { clientGoogleAssets } from "@/lib/google/assets";
import { getGoogleDataProvider } from "@/lib/google/provider";
import { loadChannelSnapshot } from "@/lib/google/snapshot";
import {
  asksAboutCategorySpend,
  asksForReturnOnSpend,
  categoriesFromServices,
  scopeCategoriesFromRequest,
  type StrategyCategory,
} from "@/lib/strategy/categories";
import { attributeSpendToCategories, type CategoryAttribution } from "@/lib/strategy/category-attribution";
import {
  addCategoryFromRequest,
  categoryNoticeLine,
  requestedCategoryPhrase,
} from "@/lib/strategy/requested-category";
import { buildChannelPerformance, type ChannelPerformance } from "@/lib/strategy/channels";
import { buildStrategyPlan } from "@/lib/strategy/plan";
import { renderCategorySpendEvidence, renderStrategyEvidence } from "@/lib/strategy/render";
import { buildLeadPlan } from "@/lib/strategy/lead-plan";
import { renderLeadStrategyEvidence } from "@/lib/strategy/lead-render";
import { buildLeadClarifyingQuestion, isLeadStrategy, resolveLeadBrief } from "@/lib/agent/lead-brief";
import { LEAD_STRATEGY_FRAMEWORK, STRATEGY_FRAMEWORK } from "@/lib/agent/strategy-framework";
import {
  buildStrategyClarifyingQuestion,
  resolveStrategyBrief,
  strategyAskTexts,
} from "@/lib/agent/strategy-brief";
import {
  renderAdSetEvidence,
  renderScorecardEvidence,
  renderScorecardMarkdown,
} from "@/lib/audit/render";
import type { Task } from "@/types";
import { getConfig } from "@/lib/config";
import { resolveProvider } from "@/lib/adspirer/client";
import type {
  MetaAdsProvider,
  MetaAdCreative,
  MetaCampaign,
  MetaInsights,
} from "@/lib/adspirer/provider";
import { getDemoStore } from "@/lib/demo/store";
import {
  buildStaticSystemPromptV2,
  buildSystemPromptV2,
} from "@/lib/agent/prompts-v2";
import type { AgentHistoryMessage } from "@/lib/agent/history";
import {
  CONVERSATIONAL_INTENTS,
  REPORT_INTENTS,
  detectRequestIntent,
  detectRequestIntentWithHistory,
  mentionsCreativeGeneration,
  type RequestIntent,
} from "@/lib/agent/task-plan";
import { buildOptimizeEvidence, type EntityRef, type Inventory, type OfferedProposal } from "@/lib/agent/optimize-evidence";
import {
  buildAuditClarifyingQuestion,
  resolveAuditBrief,
  resolveAuditCampaigns,
  applyCompetitorUrlsFromDocuments,
  completedDaysRange,
  parseDateRangeFromText,
} from "@/lib/agent/audit-brief";
import {
  analyzeLandingPages,
  formatLandingAnalysesForEvidence,
} from "@/lib/landing/analyze-page";
import { loadDocumentsForContext } from "@/lib/documents/service";
import { META_AUDIT_FRAMEWORK } from "@/lib/agent/meta-audit-framework";
import {
  GENERIC_FALLBACK_REPLY,
  humanizeAgentReply,
  stripMachineJson,
} from "@/lib/agent/reply-format";
import {
  buildAllowedUrlsMarker,
  buildVerifiedDestinationsMarker,
  destinationsWereFetched,
  enforceVerifiedDestinations,
  readAllowedUrlsMarker,
  readVerifiedDestinationsMarker,
  stripDestinationMarkers,
} from "@/lib/landing/verified-destinations";
import { logger } from "@/lib/observability/logger";
import { rulesBrief, type RequestBrief } from "@/lib/agent/request-brief";
import { resolvePrimaryAccountId } from "@/lib/adspirer/resolve-meta-account";
import type { ClientService, ConnectedMetaAccount, WorkspaceDocument } from "@/types";
import type { CreativeDraft } from "@/lib/creatives/drafts";

function activeSystemPrompt(clientContext: string): string {
  return buildSystemPromptV2(clientContext);
}

/** Anthropic prompt-cache breakpoint (ignored by other providers). */
const CACHE_BREAKPOINT = {
  anthropic: { cacheControl: { type: "ephemeral" as const } },
};

/** Live → Meta Graph with the operator's Facebook token; demo → mock data. */
async function resolveAgentProvider(): Promise<MetaAdsProvider> {
  return resolveProvider();
}

function noMappedAccountMessage(): string {
  return "No granted Meta account is mapped to this client. Connect Facebook, sync accounts under Connections, then Add as client / Map — and select that client in the Workspace.";
}

export type AgentToolCallProposal = {
  name: string;
  args: Record<string, unknown>;
  rationale?: string;
};

export type AgentProgressEvent = {
  phase: string;
  label: string;
  delta?: string;
  summary?: string;
  stepId?: string;
  ui?: AgentRunResult["ui"];
};

export type ServicePickerUi = {
  services: Array<{ id: string; name: string; description?: string }>;
};

export type CopyPickerUi = {
  copies: Array<{
    id: string;
    angle: string;
    primary_text: string;
    headline: string;
    description?: string;
    cta?: string;
  }>;
};

export type AdPickerUi = {
  ads: Array<{
    id: string;
    name: string;
    status?: string;
    creative_summary?: string;
    adset_id?: string;
    campaign_id?: string;
  }>;
};

export type ImageChoiceUi = {
  landing_page_url?: string;
  /** Prefer for brand colour / logo scrape when distinct from landing. */
  brand_url?: string;
  headline?: string;
  primary_text?: string;
  /** Competitor / reference guidance for art direction. */
  reference_notes?: string;
  /** "4:5" (feed, default), "9:16" (Reels/Stories) or "1:1". */
  format?: string;
};

export type FormatChoiceUi = {
  selected?: "image" | "video" | null;
};

export type VideoChoiceUi = {
  landing_page_url?: string;
  headline?: string;
  primary_text?: string;
};

/** Opens the advanced targeting picker (audiences + detailed targeting search). */
export type TargetingPickerUi = {
  account_id?: string | null;
};

/** Opens the campaign settings card. The card loads its own options from Meta. */
export type CampaignSettingsPickerUi = {
  account_id?: string | null;
  objective?: string | null;
  stated?: Partial<import("@/lib/meta/campaign-rules").CampaignSettings>;
};

export type CreativePickerUi = {
  drafts: Array<{
    id: string;
    concept: string;
    headline: string;
    primary_text: string;
    image_url?: string | null;
    image_status?: string | null;
    image_error?: string | null;
    status?: string | null;
  }>;
  status?: string;
};

/**
 * A provider-level problem the operator has to fix (billing, key, model, quota).
 * Carried on the result instead of thrown so the chat can show the fix steps
 * rather than a generic "try again" — retrying the prompt cannot help.
 */
export type AgentFailure = {
  kind:
    | "billing"
    | "auth"
    | "model"
    | "rate_limit"
    | "unavailable"
    | "empty_reply"
    | "unknown";
  detail: string;
};

export type AgentRunResult = {
  summary: string;
  messages: Array<{ role: "assistant" | "user" | "system"; content: string }>;
  toolCalls: AgentToolCallProposal[];
  mode: "anthropic" | "openai" | "mock";
  failure?: AgentFailure;
  ui?: {
    servicePicker?: ServicePickerUi;
    copyPicker?: CopyPickerUi;
    adPicker?: AdPickerUi;
    imageChoice?: ImageChoiceUi;
    formatChoice?: FormatChoiceUi;
    videoChoice?: VideoChoiceUi;
    targetingPicker?: TargetingPickerUi;
    campaignSettingsPicker?: CampaignSettingsPickerUi;
    creativePicker?: CreativePickerUi;
  };
  report?: {
    title: string;
    /** Structured audit payload for branded PDF/Word/MD export. */
    data?: import("@/lib/report/schema").AuditReport;
  };
};

export async function runAdspirerAgent(input: {
  task: Task;
  clientContext: string;
  toolEvidence?: string;
  reportDraft?: string;
  reportTitle?: string;
  reportData?: import("@/lib/report/schema").AuditReport;
  history?: AgentHistoryMessage[];
  /** Intent already resolved by the task runner (avoids re-detecting). */
  intent?: RequestIntent;
  /** What the operator's message means: mode, focus, scope, period, queue selection. */
  brief?: RequestBrief;
  correlationId?: string;
  onProgress?: (event: AgentProgressEvent) => void | Promise<void>;
}): Promise<AgentRunResult> {
  const config = getConfig();

  // Export turns already have a finished, structured report rendered to
  // markdown. Asking Claude to re-type it added 30–60s and could drift from the
  // structured data that the PDF/Word export uses — present the draft as-is.
  if (input.reportDraft?.trim()) {
    return finalizeWriterResult({
      text: "",
      input,
      mode: config.hasAnthropic ? "anthropic" : "openai",
    });
  }

  // An incomplete strategy brief gets the clarifying question verbatim, in every
  // mode: the next turn's routing keys on its wording, so no writer rephrases it.
  const question = strategyBriefQuestion(input);
  // Settings saved (or not) this turn are said first; routing finds the brief marker anywhere.
  const settingsLines = settingsNoticeLines(input.toolEvidence);
  const briefQuestion = question && settingsLines.length ? [...settingsLines, "", question].join("\n") : question;
  if (briefQuestion) {
    await input.onProgress?.({
      phase: "write_report",
      label: "Asking for the goal & budget…",
      stepId: "write_report",
      summary: briefQuestion,
      delta: briefQuestion,
    });
    return {
      summary: briefQuestion,
      messages: [{ role: "assistant", content: briefQuestion }],
      toolCalls: [],
      mode: config.hasAnthropic ? "anthropic" : config.hasOpenAI ? "openai" : "mock",
    };
  }

  if (config.hasAnthropic && config.ANTHROPIC_API_KEY) {
    try {
      return await runAnthropicAgent(input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failure = classifyProviderFailure(error);
      logger.error("Anthropic agent failed", {
        error: message,
        kind: failure.kind,
        correlationId: input.correlationId,
        model: config.ANTHROPIC_MODEL,
      });
      // Every other model call in the app runs on OpenAI, so a Claude outage
      // should not block the turn — write it with OpenAI and say so.
      if (config.hasOpenAI && config.OPENAI_API_KEY) {
        try {
          return await runOpenAIWriter(
            input,
            describeProviderFallback(failure, config.OPENAI_MODEL),
          );
        } catch (fallbackError) {
          logger.error("OpenAI writer fallback failed", {
            error:
              fallbackError instanceof Error
                ? fallbackError.message
                : String(fallbackError),
            correlationId: input.correlationId,
          });
        }
      }

      // No writer answered. The canned mock reply reads like a finished turn, so
      // report what broke and how to clear it instead.
      const summary = describeProviderFailure(failure, config.ANTHROPIC_MODEL);
      await input.onProgress?.({
        phase: "write_report",
        label: "Model call failed",
        stepId: "write_report",
        summary,
        delta: summary,
      });
      return {
        summary,
        messages: [{ role: "assistant", content: summary }],
        toolCalls: [],
        mode: "mock",
        failure,
      };
    }
  }

  // No model configured at all — demo/offline mode.
  return runMockAgent(input);
}

export function classifyProviderFailure(error: unknown): AgentFailure {
  const parts: string[] = [];
  if (error instanceof Error) parts.push(error.message);
  const raw = error as { statusCode?: number; responseBody?: string } | null;
  const statusCode = typeof raw?.statusCode === "number" ? raw.statusCode : 0;
  if (typeof raw?.responseBody === "string") parts.push(raw.responseBody);
  const text = parts.join(" ");

  if (
    /credit balance|too low|billing|payment|purchase credits|insufficient/i.test(
      text,
    )
  ) {
    return { kind: "billing", detail: text.slice(0, 400) };
  }
  if (
    statusCode === 401 ||
    statusCode === 403 ||
    /invalid[_ -]?api[_ -]?key|authentication|unauthorized|x-api-key/i.test(text)
  ) {
    return { kind: "auth", detail: text.slice(0, 400) };
  }
  if (statusCode === 404 || /model:|not_found|does not exist/i.test(text)) {
    return { kind: "model", detail: text.slice(0, 400) };
  }
  if (statusCode === 429 || /rate limit|quota|too many requests/i.test(text)) {
    return { kind: "rate_limit", detail: text.slice(0, 400) };
  }
  if (statusCode === 529 || statusCode >= 500 || /overloaded/i.test(text)) {
    return { kind: "unavailable", detail: text.slice(0, 400) };
  }
  if (/empty reply/i.test(text)) {
    return { kind: "empty_reply", detail: text.slice(0, 400) };
  }
  return { kind: "unknown", detail: text.slice(0, 400) };
}

/** One honest line explaining why this reply came from the backup model. */
export function describeProviderFallback(
  failure: AgentFailure,
  openaiModel: string,
): string {
  const reason = (() => {
    switch (failure.kind) {
      case "billing":
        return "Claude is out of credit — top up the Anthropic workspace behind `ANTHROPIC_API_KEY`";
      case "auth":
        return "the Anthropic API key was rejected — check `ANTHROPIC_API_KEY` in `.env.local`";
      case "model":
        return "the configured `ANTHROPIC_MODEL` was rejected — set `claude-sonnet-4-6`";
      case "rate_limit":
        return "Claude rate-limited this workspace";
      case "unavailable":
        return "Claude was unavailable";
      case "empty_reply":
        return "Claude returned an empty reply";
      default:
        return "the Claude call failed";
    }
  })();
  return `_Heads up: ${reason}. I wrote this reply with OpenAI \`${openaiModel}\` instead._`;
}

export function describeProviderFailure(
  failure: AgentFailure,
  model: string,
): string {
  const head = "**I couldn't write this reply — the Claude call failed.**";
  const footer =
    "Nothing was sent to Meta and no approvals were queued. Re-send this message once it's fixed.";

  const body: string[] = (() => {
    switch (failure.kind) {
      case "billing":
        return [
          "Your Anthropic account is out of credit, so the model refused the request.",
          "",
          "Fix it: open [Anthropic Plans & Billing](https://console.anthropic.com/settings/billing) and add credit to the workspace behind `ANTHROPIC_API_KEY`.",
        ];
      case "auth":
        return [
          "The Anthropic API key was rejected.",
          "",
          "Fix it: check `ANTHROPIC_API_KEY` in `.env.local` (no quotes or trailing spaces), then restart the dev server.",
        ];
      case "model":
        return [
          `Anthropic rejected the configured model \`${model}\`.`,
          "",
          "Fix it: set `ANTHROPIC_MODEL=claude-sonnet-4-6` in `.env.local` and restart the dev server.",
        ];
      case "rate_limit":
        return [
          "Anthropic rate-limited this workspace.",
          "",
          "Wait a moment and send the message again.",
        ];
      case "unavailable":
        return [
          "Anthropic was unavailable or overloaded while writing this reply.",
          "",
          "Send the message again in a few seconds.",
        ];
      case "empty_reply":
        return ["The model returned an empty reply, so there's nothing to show."];
      default:
        return ["The model call failed before any text came back."];
    }
  })();

  const detail = failure.detail.trim();
  return [
    head,
    "",
    ...body,
    "",
    footer,
    ...(detail ? ["", `<details>Provider error: ${detail}</details>`] : []),
  ].join("\n");
}

async function runAnthropicAgent(input: WriterInput): Promise<AgentRunResult> {
  const { createAnthropic } = await import("@ai-sdk/anthropic");
  const config = getConfig();

  const anthropic = createAnthropic({
    apiKey: config.ANTHROPIC_API_KEY,
  });

  await input.onProgress?.({
    phase: "write_report",
    label: writingLabel(input),
    stepId: "write_report",
  });

  const text = await streamWriterText({
    model: anthropic(config.ANTHROPIC_MODEL),
    providerLabel: "Claude",
    input,
  });

  return finalizeWriterResult({ text, input, mode: "anthropic" });
}

/**
 * Claude writes the operator reply, but every other model call in the app runs on
 * OpenAI. When Claude is down or unpaid, write the turn with OpenAI instead of
 * dropping the operator into a dead-end reply.
 */
async function runOpenAIWriter(
  input: WriterInput,
  notice: string,
): Promise<AgentRunResult> {
  const { createOpenAI } = await import("@ai-sdk/openai");
  const config = getConfig();

  const openai = createOpenAI({ apiKey: config.OPENAI_API_KEY });

  await input.onProgress?.({
    phase: "write_report",
    label: "Claude unavailable — writing with OpenAI…",
    stepId: "write_report",
  });

  const text = await streamWriterText({
    model: openai(config.OPENAI_MODEL),
    providerLabel: "OpenAI",
    input,
  });

  return finalizeWriterResult({ text, input, mode: "openai", notice });
}

type WriterInput = {
  task: Task;
  clientContext: string;
  toolEvidence?: string;
  reportDraft?: string;
  reportTitle?: string;
  reportData?: import("@/lib/report/schema").AuditReport;
  history?: AgentHistoryMessage[];
  intent?: RequestIntent;
  brief?: RequestBrief;
  correlationId?: string;
  onProgress?: (event: AgentProgressEvent) => void | Promise<void>;
};

const BRIEF_FIELDS = ["budget", "target_roas"] as const;

/** Writer rules: open the reply with the category notice line, then the settings lines, word for word. */
export function writerNoticeRules(evidence: string): string[] {
  const rules: string[] = [];
  const categoryNotice = categoryNoticeLine(evidence);
  if (categoryNotice) {
    rules.push(`- Start the reply with this line, word for word, before anything else: ${categoryNotice}`);
  }
  const settingsLines = settingsNoticeLines(evidence);
  if (settingsLines.length) {
    rules.push(
      `- ${categoryNotice ? "Right after that line" : "Start the reply"} with these client-settings lines, word for word, each on its own line: ${settingsLines.map((l) => `"${l}"`).join(" ")}`,
    );
  }
  return rules;
}

/** The clarifying question for an incomplete strategy brief, rebuilt from the evidence's "Missing" line. */
function strategyBriefQuestion(input: WriterInput): string | null {
  if (input.reportDraft || resolveWriterIntent(input) !== "strategy") return null;
  const evidence = input.toolEvidence ?? "";
  const at = evidence.indexOf("### Strategy brief incomplete");
  if (at < 0) return null;
  const listed = evidence.slice(at).match(/^- Missing: (.*)$/m)?.[1] ?? "";
  if (listed.split(/,\s*/).includes("leads")) return buildLeadClarifyingQuestion();
  const missing = BRIEF_FIELDS.filter((f) => listed.split(/,\s*/).includes(f));
  return buildStrategyClarifyingQuestion(missing.length ? missing : [...BRIEF_FIELDS]);
}

function resolveWriterIntent(input: WriterInput): RequestIntent {
  return (
    input.intent ??
    detectRequestIntentWithHistory(
      input.task.goal ?? input.task.title,
      input.history ?? [],
    )
  );
}

/** Status label shown while the reply streams. */
function writingLabel(input: WriterInput): string {
  if (input.reportDraft) return "Formatting report…";
  const intent = resolveWriterIntent(input);
  if (intent === "chat") return "Answering…";
  if (intent === "custom") return "Building your data…";
  if (intent === "strategy") {
    return input.toolEvidence?.includes("### Strategy brief incomplete")
      ? "Asking for the goal & budget…"
      : "Writing strategy…";
  }
  return REPORT_INTENTS.has(intent) ? "Writing report…" : "Writing reply…";
}

/** Output budget: short for Q&A, long for audits / reports. */
function maxOutputTokensFor(intent: RequestIntent): number {
  if (REPORT_INTENTS.has(intent) || intent === "custom") return 8000;
  if (CONVERSATIONAL_INTENTS.has(intent)) return 3000;
  return 4000;
}

/** Prepended to earlier assistant turns so their figures are never treated as current. */
const STALE_REPLY_MARKER =
  "[Earlier reply from this chat: its figures, statuses and URLs were not re-verified and may be outdated or wrong.]";

/** Added to every turn: answers come from live tool data, not from the chat. */
const FRESH_DATA_RULE = [
  "## Fresh data rule (applies to this turn)",
  "- Every metric, status, setting, URL, CTA or score in your answer must come from the live tool evidence below or from a read-only data tool you call this turn. Name the source.",
  "- Do NOT reuse a number, status or URL from earlier messages in this chat, or from workspace documents, unless the operator explicitly asks about what was said earlier (\"you said\", \"earlier\", \"before\"). Then say it is from the earlier reply and not re-verified, and re-check it live when you can.",
  "- If a figure cannot be verified live, say so plainly. Never fill the gap from memory or from earlier replies.",
  "- Meta returns some CTA enums under legacy names. BOOK_TRAVEL is the API value for the button Ads Manager labels \"Book Now\"; that is not a mismatch. Report the Ads Manager label and mention the API value only for reference.",
  "",
  "## Answer scope rule (applies to every turn)",
  "- Answer ONLY what the latest operator message asks, in the shape it asks for (steps, a list, one number, a yes/no). Do not widen it.",
  "- When it builds on a report already in this chat (\"based on the audit\", \"from those findings\", \"what next\"), use that report as the input and produce only the new thing asked for. Never repeat or re-run the report, its summary, scorecard or tables.",
  "- Stay on the same account, campaign scope and period the chat is already working on unless the operator changes them.",
].join("\n");

/**
 * Turns that answer the operator in conversation rather than run a workflow
 * (audit, strategy, optimise, export, the create / copy / image pickers). They
 * share one adaptive brief: the preflight evidence is a head start and the
 * model reads whatever else the question needs with the read tools.
 */
const CONVERSATION_INTENTS: ReadonlySet<RequestIntent> = new Set<RequestIntent>([
  "chat",
  "general",
  "budget",
  "list_campaigns",
  "custom",
  "followup",
  "out_of_scope",
]);

/** What the turn looks like, said to the model in plain words (never shown to the operator). */
const CONVERSATION_SITUATION: Partial<Record<RequestIntent, string>> = {
  chat: "A conversational or expertise question; no account data was fetched up front.",
  general: "A question about this client's ads or data; some live evidence was fetched up front.",
  budget: "A question about budgets or bids; some live evidence was fetched up front.",
  list_campaigns: "They want to see campaigns; the live campaign list is below.",
  custom: "A specific deliverable (chosen metrics, a period, a breakdown or a format); plan it yourself and read the data with the tools.",
  followup: "Builds on a report or answer already in this chat; nothing was re-run this turn.",
  out_of_scope: "Looks outside this workspace's scope; no account data was fetched.",
};

/** Extra guidance for the conversation turns that have a particular job. */
function conversationTurnRules(intent: RequestIntent): string[] {
  switch (intent) {
    case "followup":
      return [
        "- The report or answer earlier in this chat is your source: its findings, failed checks, numbers, scope and period. Cite them as \"from the audit above\" (for this purpose only, this overrides the fresh-data rule's ban on reusing earlier figures).",
        "- Produce only the new thing asked for, in the shape asked for. When it's steps, fixes or priorities: a numbered list ordered by impact (tracking before scaling), each with the fix, the finding or check ID it comes from, the campaign or ad set it applies to, and the expected effect.",
        "- Never restate or re-create the report: no executive summary, scope header, scorecard, checkpoint tables or per-ad-set verdicts.",
        "- If they ask which recommendations you can do: answer per item using \"What can be done, and by whom\". Never list something you can't do as doable.",
        "- Read live data only when a step needs a number the earlier report doesn't have; name the source if you do.",
        "- Recommendations only: no Approvals, no tool JSON, never say Meta was changed. When steps are actionable here, end with one sentence saying they can ask you to queue specific ones.",
      ];
    case "custom":
      return [
        "- Never turn it into an account audit, a health score or a generic report.",
        "- Work out the deliverable from their words: the metrics or columns, the period, the breakdown (e.g. one block per week), the filter (e.g. only campaigns that delivered) and the format.",
        "- Fetch every number with the read tools. For per-week data call meta_insights with time_increment 7 and an explicit time_range at level campaign, requesting only the fields needed (spend, impressions, clicks, inline_link_clicks, inline_link_click_ctr, cost_per_inline_link_click, cpc, cpm, actions for leads). Split a long range into several calls if a limit is hit. A campaign with no delivery in a period does not appear for it.",
        "- Derive metrics only from what came back (e.g. link CPC = spend / link clicks). A metric that isn't available is \"n/a\" in its cell, with one line below the table saying why.",
        "- Present markdown tables: one header row, one row per record, currency symbol on money, % on rates, the period as its own column (e.g. \"29 Sep – 5 Oct\"), rows ordered the way they asked, each distinct table under its own short heading (the Excel export puts every table on its own sheet).",
        "- One sentence before the tables with the period, the account and the currency. Mention the Export menu under this message has an Excel (.xlsx) option; never claim a file is attached.",
        "- If you can't fulfil it (no account mapped, a Meta error, a metric Meta doesn't provide), say exactly what failed and what you need.",
      ];
    case "out_of_scope":
      return [
        "- Follow \"When a request is outside that scope\" in your instructions.",
        "- If it turns out to be about this client's ads, analytics or marketing after all, just answer it (read data if needed).",
        "- Adjacent marketing: help briefly from expertise and say what you can't do here. Something the workspace can't do: say so, offer the closest thing you can do, and where they'd do the rest.",
        "- Unrelated to marketing: one friendly sentence, then two or three specific example questions for this client as a short bulleted list (use the client name, industry, goals and connected data from Additional context).",
        "- Short and warm: no lecture about scope, no apologies, no invented data.",
      ];
    case "chat":
      return [
        "- Greetings or thanks: one short, friendly sentence. A greeting with no request can mention one or two things you could do for this client right now.",
        "- Marketing outside Meta (another ad platform, SEO, email, landing pages): answer from expertise and say plainly that you can't read or change that platform here.",
      ];
    case "list_campaigns":
      return [
        "- Show the campaigns as a compact table (name, status, objective, daily budget) unless they asked for something narrower; add spend or results only when asked or when it is in the evidence.",
      ];
    default:
      return [];
  }
}

function buildConversationTurn(args: {
  intent: RequestIntent;
  request: string;
  accountHint?: string;
  evidence: string;
  extraRules: string[];
}): string {
  const { intent, request, accountHint, evidence, extraRules } = args;
  return [
    `Operator message: ${request}`,
    `Situation: ${CONVERSATION_SITUATION[intent] ?? "A question for you to answer."}`,
    accountHint ? `Primary Meta account_id: ${accountHint}` : "",
    "",
    ...(evidence
      ? [
          "## Live evidence fetched up front (a head start: use it, but it may not cover everything asked)",
          evidence,
          "",
        ]
      : []),
    "How to reply (you are a senior Meta media buyer talking to a colleague):",
    "- Work out the question behind the words, using the conversation and Additional context, and answer it directly in your first sentence. If the message is vague, take the most useful reading, say your assumption in a few words, and answer; ask one short question back only when the readings would lead to genuinely different answers.",
    "- Get the facts the answer needs. Use the evidence above; for anything it doesn't cover, call the read-only tools (meta_insights, list_adsets, list_ads, get_meta_ad_creatives, meta_account_health for tracking / learning / audiences / what's wrong, detect_meta_creative_fatigue, optimize_meta_budget, analyze_landing_pages, ga4_report, search_console_query, google_ads_report, Shopify when connected). Never say a figure is unavailable before trying the tools, and never estimate one. Name the source and period of every number.",
    "- \"Why\" and \"what's wrong\" questions: diagnose like a specialist. Follow the chain in \"Diagnosing performance\" (cost per result moves with CPM, click-through rate and conversion rate), compare with the period before when the question is about a change, and name the most likely cause with the numbers that point to it, then what to do about it. Not a list of metrics.",
    "- Expertise questions need no data: answer them fully, then tie them to this client when that adds something real.",
    "- Shape the answer to the question: one number or a yes/no in a sentence; a why / how in a short explanation, with bullets or numbered steps only when it really is a list or a sequence; a table when comparing several campaigns, ad sets or periods. Headings only when the answer genuinely has sections.",
    "- Quote numbers with the account currency, and keep campaign, ad set and ad names exactly as Meta returns them.",
    "- Nothing is changed or queued on this turn: no tool JSON, and never say anything was queued. When a change is clearly the right move, recommend it specifically (what, where, by how much) and say they can ask you to queue it for Approvals.",
    "- If evidence or a tool failed, say exactly what failed and what to check (Facebook connection, account mapping, Admin → Connections).",
    "- At most one natural next step. No emojis, no \"Anything else?\", no \"fetching data\" / \"results incoming\", and never make the whole reply JSON.",
    ...conversationTurnRules(intent),
    ...extraRules,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildWriterMessages(input: WriterInput): {
  /** Same for every client and turn — cached. */
  systemStatic: string;
  /** Client brand, research memo, documents. */
  systemContext: string;
  messages: Array<{ role: "assistant" | "user" | "system"; content: string }>;
} {
  const intent = resolveWriterIntent(input);
  const brief = input.brief;
  const evidence = input.toolEvidence?.trim() || "(no live tool evidence yet)";
  const accountHint =
    evidence.match(/ID:\s*(act_[^\s]+)/)?.[1] ??
    evidence.match(/account_id["']?\s*[:=]\s*["']?(act_[^\s"']+)/i)?.[1];
  const auditIncomplete = evidence.includes("### Audit briefing incomplete");
  const auditReady =
    evidence.includes("### Audit brief (confirmed)") ||
    evidence.includes("### Audit checklist");
  const hasDestinationInventory = evidence.includes(
    "### Ad CTA & destination inventory",
  );
  const auditToolsEnabled = evidence.includes("### Diagnose tools");

  const auditRules = auditIncomplete
    ? [
        "- Audit briefing is incomplete: ask ONLY for the missing fields from the evidence.",
        "- Do NOT invent spend, findings, or a full audit yet.",
        "- Do NOT propose optimize/execute tools.",
      ]
      : auditReady
      ? [
          "- Write a full Meta Ads best-practice audit using the checklist sections in the evidence.",
          "- Lead with scope + period, then spend snapshot, what's working, needs improvement, **Landing pages**, and prioritized recommendations.",
          ...(hasDestinationInventory
            ? [
                "- In **Landing pages**, use ONLY Website URLs + CTA types from “Ad CTA & destination inventory” and scores from “Landing page analysis”.",
                "- NEVER say destinations are unavailable because a campaign is paused or had no spend.",
                "- NEVER use workspace-document / competitor-doc URLs as the own Meta destination (that caused wrong URLs like googleconsult vs googleaudit).",
              ]
            : [
                "- You have diagnose tools. BEFORE writing Landing pages: call `get_meta_ad_creatives` (paused OK), then `analyze_landing_pages` with those Website URLs.",
                "- Never invent destinations or use workspace-document URLs as own destinations.",
              ]),
          "- Ground every claim in the live metrics / scraped page evidence; say Unknown when evidence is missing.",
          "- Do NOT queue execute/optimize tools and do NOT change Meta yet.",
          "- If competitor LPs were not provided, finish the own-LP audit and mention in one sentence that they can paste competitor URLs for a comparison.",
          "- Close with at most ONE next step — the single highest-impact fix — not a menu of options.",
        ]
      : intent === "audit"
        ? [
            "- This is an audit request: clarify scope (account vs campaigns) and date range if missing, otherwise audit from evidence.",
            "- Landing page analysis of Meta destinations is part of the initial audit — do not defer it.",
            "- Recommendations only — wait for an explicit optimize ask before mutations.",
          ]
        : [];

  const strategyBriefIncomplete = evidence.includes("### Strategy brief incomplete");
  const strategyUnavailable = evidence.includes("### Strategy unavailable");
  const strategyReady = evidence.includes("### Strategy inputs");
  const strategyRules =
    intent === "strategy"
      ? [
          ...(strategyUnavailable
            ? [
                "- The strategy plan can't be built: no Meta ad account is mapped to this client. Say that plainly, give the loaded count from “Strategy unavailable”, and say what to do (map the account under Connections).",
                "- Give NO tiers, allocations, budgets, projections, benchmarks or other numbers, and no generic plan.",
              ]
            : strategyBriefIncomplete
            ? [
                "- Strategy brief is incomplete: ask ONLY for the missing values, using the question in the evidence.",
                "- Do NOT build a plan, allocation or projection yet, and do NOT invent spend or ROAS.",
              ]
            : strategyReady
              ? [
                  "- Write the strategy report using the headings in “Strategy framework”, in order.",
                  "- Use only numbers from the strategy evidence; say a number is not available rather than estimate it.",
                  "- Use the Word for offerings from “Strategy inputs” (category or service) everywhere.",
                  "- If Level 3 says “No budget allocated”, explain why and what has to change; never invent an allocation.",
                ]
              : ["- The strategy plan could not be built: say what failed from the evidence. Do NOT invent a plan."]),
          "- Strategy is recommend-only: do NOT append tool JSON, do NOT queue Approvals, do NOT say Meta was changed.",
        ]
      : evidence.includes("### Spend & return by")
        ? [
            "- For spend or return by category / service, quote only the “Spend & return by” table and its coverage lines; if they say the figures are partial, say so.",
            "- When it has “GA4 … revenue by platform” lines, give each one with how it was matched, and pass on any UTM-tag check it names.",
            "- Do NOT build a plan or suggest budget allocations for this question.",
          ]
        : [];

  // A category added from the question (or not found, or switched off), then
  // the settings saved this turn, are said first.
  const categoryNoticeRules = writerNoticeRules(evidence);

  const optimizeShared = [
    "- State the period and scope you used in your first sentence (they are in \"Scope and period\"). If a name was not found, say so and stop; never widen to the account.",
    "- Use only this turn's live evidence. If an earlier report is in this chat, use it only to decide what to look at; every number must come from the evidence below.",
    "- Use the 'Optimisation signals (live checkpoints)' to order advice: fix tracking (T-codes) before scaling; consolidate learning-limited ad sets; keep 7-day frequency at 1.5–2.5 for prospecting and 3–5 for retargeting; keep 2–6 live ads per ad set and add 3–5 new concepts a month; exclude customers from prospecting; keep retargeting under half of spend.",
    "- Describe each step as a Meta specialist would: what to change, the numbers behind it (with source and period), the expected effect. Refer to proposals by number (#1, #2…). Add no step that is not in the evidence.",
    "- Say plainly which steps this app can queue and which need someone else (a developer, the landing page owner, someone in Ads Manager, the client), using \"What can be done, and by whom\".",
    "- Do not repeat the \"Who does what\" table: the system adds it after your reply.",
    "- Never invent a 'known limitation'. Offer at most one next step.",
  ];
  const optimizeRules =
    intent === "optimize"
      ? brief?.mode === "act" && brief.queue.requested
        ? [
            "- The operator asked for changes. The Queue decision section below lists exactly what is queued and what is not: confirm it and nothing else, and never add, drop or renumber an item or claim anything more was queued.",
            "- Do not write tool JSON for items on the numbered list: the system queues them.",
            "- Only if the operator named a campaign, ad set or ad for a direct change (\"pause X\", \"set the daily budget of X to 60\"), append one JSON block for that change with the matching tool and the exact id from the evidence (budget tools take cents; give an end date with its time zone offset). Write exactly what they named: the campaign, ad set or ad itself, not its ad sets or ads, and no other change. Never invent ids. For a direct change the Queue decision section says whether the system already matched it from the live list; do not say it is queued, the system lists what was queued under your reply.",
            "- Tell them to review the queued items in Approvals; nothing changes in Meta until approved.",
            ...optimizeShared,
          ]
        : [
            "- The operator has not asked for changes: do not queue anything and do not claim anything was queued or sent to Approvals. Tell them they can ask by number (\"queue #2\"), by area (\"queue the budget changes\") or \"all of these\".",
            ...optimizeShared,
          ]
      : [
          "- Do NOT start an optimize/execute workflow unless Detected intent is optimize (or they clearly asked to change Meta).",
        ];

  const userTurn = input.reportDraft
    ? [
        `Operator request: ${input.task.goal ?? input.task.title}`,
        `Detected intent: export / report`,
        accountHint ? `Primary Meta account_id: ${accountHint}` : "",
        "",
        "An OpenAI draft report was already generated from the chat history + Meta evidence.",
        "Your job: present it as a neat operator-facing markdown report.",
        "Rules:",
        "- Keep all facts from the draft; do not invent new metrics or IDs.",
        "- Improve clarity, headings, and bullet structure.",
        "- Start with a short intro line, then the full report body.",
        "- End with: Use the Download Word / PDF buttons under this message.",
        "- Do NOT output JSON. Do NOT say you are still generating the report.",
        "",
        `Suggested title: ${input.reportTitle ?? "Meta Ops session report"}`,
        "",
        "## OpenAI draft report (source of truth)",
        input.reportDraft,
      ]
        .filter(Boolean)
        .join("\n")
    : CONVERSATION_INTENTS.has(intent)
      ? buildConversationTurn({
          intent,
          request: input.task.goal ?? input.task.title,
          accountHint,
          evidence: input.toolEvidence?.trim() ?? "",
          extraRules: [...categoryNoticeRules, ...strategyRules],
        })
      : [
        `Operator request: ${input.task.goal ?? input.task.title}`,
        `Detected intent: ${intent}`,
        accountHint ? `Primary Meta account_id: ${accountHint}` : "",
        "",
        "## Live tool evidence (already fetched — use this; do NOT say you are still fetching)",
        evidence,
        "",
        REPORT_INTENTS.has(intent)
          ? "Write the report NOW from the evidence above."
          : "Answer the operator's question NOW from the evidence above.",
        "Rules:",
        REPORT_INTENTS.has(intent)
          ? "- This is a report: use clear headings and tables where they help. Lead with the answer (scope, period, headline numbers)."
          : "- Answer exactly what was asked, directly, in the first sentence. Keep it short — a few sentences, or a compact list/table only when listing several campaigns or numbers. No report structure, no headings unless the answer genuinely needs sections.",
        "- Quote real numbers from the evidence with their currency, and keep campaign / ad set / ad names exactly as Meta returns them.",
        "- If a number or answer is not in the evidence, read it with the data tools (meta_insights, ga4_report, search_console_query, google_ads_report, list_client_categories, …) before saying it isn't available — never estimate or invent it. Name the source of each number (Meta, GA4, Search Console, Google Ads).",
        "- Offer at most ONE next step, and only when there is an obvious one. Never end with a menu of options or \"Anything else?\".",
        "- No emojis.",
        "- NEVER make the entire reply a JSON object/array or a wrapper like {\"message\":...}. JSON is only an optional appendix at the very end for tool proposals or pickers.",
        "- Never say \"fetching data\", \"stand by\", or \"results incoming\".",
        "- If evidence is thin/failed, say exactly what failed and what the operator should check (Facebook connection / Meta account mapping).",
        "- If proposing execute change(s), explain in prose first, then append one JSON block per tool at the end:",
        '```json\n{"tool":"create_meta_image_campaign"|"create_meta_video_campaign","args":{...},"rationale":"..."}\n```',
        "- For scrape/services: list services in prose, then append service_picker JSON at the end (not instead of prose).",
        "- When you queue Approvals, say in one sentence what is waiting in Approvals and that nothing changes in Meta until it is approved. Never claim Meta mutations applied yet.",
        "- If they asked for Word/PDF export, deliver a complete markdown report and tell them to use Export Word / Export PDF under the message.",
        ...auditRules,
        ...categoryNoticeRules,
        ...strategyRules,
        ...optimizeRules,
      ]
        .filter(Boolean)
        .join("\n");

  return {
    systemStatic: buildStaticSystemPromptV2(),
    systemContext: input.clientContext
      ? `## Additional context\n${input.clientContext}`
      : "",
    messages: [
      ...(input.history ?? []).map((m) => ({
        role: m.role,
        content:
          m.role === "assistant" && m.content.trim()
            ? `${STALE_REPLY_MARKER}\n${m.content}`
            : m.content,
      })),
      { role: "user" as const, content: `${FRESH_DATA_RULE}\n\n${userTurn}` },
    ],
  };
}

async function streamWriterText(args: {
  model: LanguageModel;
  providerLabel: string;
  input: WriterInput;
}): Promise<string> {
  const { model, providerLabel, input } = args;
  const { streamText, stepCountIs } = await import("ai");
  const { systemStatic, systemContext, messages } = buildWriterMessages(input);
  // Two cache breakpoints: the static instructions (shared by every request)
  // and the end of this turn's prompt, so each step of the diagnose tool loop
  // re-reads history + evidence from cache instead of re-billing it.
  // AI SDK v7 only accepts system content via `instructions`.
  const instructions: SystemModelMessage[] = [
    { role: "system", content: systemStatic, providerOptions: CACHE_BREAKPOINT },
    ...(systemContext
      ? [{ role: "system" as const, content: systemContext }]
      : []),
  ];
  const turnMessages = messages.filter((m) => m.role !== "system");
  const lastIndex = turnMessages.length - 1;
  const modelMessages = turnMessages.map((m, i) =>
    (i === lastIndex
      ? { ...m, providerOptions: CACHE_BREAKPOINT }
      : m) as ModelMessage,
  );

  // `textStream` only forwards text deltas — it drops error parts and ends
  // cleanly, so a failed call would otherwise look like an empty success and get
  // reported as "Done". Capture the error here and rethrow it after the loop.
  let streamError: unknown = null;
  const intent = resolveWriterIntent(input);

  // Every question gets the read-only tools (Meta, GA4, Search Console, Google
  // Ads, categories), so a question the evidence doesn't cover is answered by
  // reading, not refused. The fixed picker flows keep their own steps.
  const { buildWorkspaceReadToolSetForClient, writerHasTools } = await import(
    "@/lib/agent/diagnose-tools-ai"
  );
  const tools =
    !input.reportDraft && writerHasTools(intent)
      ? await buildWorkspaceReadToolSetForClient({
          clientId: input.task.client_id,
          userId: input.task.created_by,
          taskId: input.task.id,
          conversationId: input.task.conversation_id,
          correlationId: input.correlationId,
        })
      : undefined;
  const label = writingLabel(input);
  const result = streamText({
    model,
    instructions,
    messages: modelMessages,
    maxOutputTokens: maxOutputTokensFor(intent),
    temperature: 0.4,
    ...(tools
      ? {
          tools,
          // Default stopWhen is 1 step (no tool loop) — allow multi-step diagnose fetches
          stopWhen: stepCountIs(12),
          onToolExecutionStart: async ({ toolCall }) => {
            const toolName = String(toolCall.toolName ?? "");
            const { humanToolProgressLabel } = await import(
              "@/lib/tools/display-labels"
            );
            await input.onProgress?.({
              phase: "write_report",
              label: humanToolProgressLabel(toolName),
              stepId:
                toolName === "analyze_landing_pages" ||
                toolName === "get_meta_ad_creatives"
                  ? "landing_pages"
                  : "pull_insights",
            });
          },
        }
      : {}),
    onError: ({ error }) => {
      streamError = error;
    },
  });

  // Re-stripping the whole reply on every token is quadratic on long audits.
  // Batch tokens and rebuild the preview at most every PREVIEW_INTERVAL_MS.
  let text = "";
  let pendingDelta = "";
  let lastPreviewAt = 0;
  const flushPreview = async () => {
    if (!pendingDelta) return;
    const delta = pendingDelta;
    pendingDelta = "";
    lastPreviewAt = Date.now();
    await input.onProgress?.({
      phase: "write_report",
      label,
      stepId: "write_report",
      delta,
      summary: liveReplyPreview(text),
    });
  };
  // fullStream, not textStream: text from separate model steps (before and after tool calls)
  // would otherwise run together with no gap ("…now.Here are…").
  for await (const part of result.fullStream) {
    let delta: string;
    if (part.type === "start-step") {
      if (!text || /\s$/.test(text)) continue;
      delta = "\n\n";
    } else if (part.type === "text-delta") {
      delta = part.text;
    } else continue;
    text += delta;
    pendingDelta += delta;
    // The first tokens go out immediately — time to first token matters most.
    if (lastPreviewAt === 0 || Date.now() - lastPreviewAt >= PREVIEW_INTERVAL_MS) {
      await flushPreview();
    }
  }
  await flushPreview();

  if (streamError) throw streamError;
  if (!text.trim() && !input.reportDraft) {
    throw new Error(`${providerLabel} returned an empty reply`);
  }

  // Strip accidental placeholder closers if the model slips.
  return text
    .replace(/Results incoming[^.!\n]*[.!]?\s*/gi, "")
    .replace(/Once these come back[\s\S]*?(?=\n\n|$)/gi, "")
    .trim();
}

async function finalizeWriterResult(args: {
  text: string;
  input: WriterInput;
  mode: "anthropic" | "openai";
  notice?: string;
}): Promise<AgentRunResult> {
  const { text, input, mode, notice } = args;

  // For report mode, prefer the OpenAI draft if the writer returns empty/JSON-only thin text
  const humanized = humanizeAgentReply(text);
  let display = humanized.display;
  if (input.reportDraft) {
    const draftLooksBetter =
      display.length < 80 ||
      /^formatting reply/i.test(display) ||
      humanized.toolCalls.length > 0;
    if (draftLooksBetter) {
      display = [
        "Here is your session report. Use **Download Word** / **Download PDF** under this message.",
        "",
        input.reportDraft.trim(),
      ].join("\n");
    } else if (!/download|export|word|pdf/i.test(display)) {
      display = `${display.trim()}\n\n---\nUse **Download Word** / **Download PDF** under this message.`;
    }
  }

  display = stripDestinationMarkers(display);

  const evidenceText = input.toolEvidence ?? "";
  if (destinationsWereFetched(evidenceText)) {
    const verifiedDestinations = readVerifiedDestinationsMarker(evidenceText);
    const enforced = enforceVerifiedDestinations(display, {
      verified: verifiedDestinations,
      allowed: readAllowedUrlsMarker(evidenceText),
      fetched: true,
    });
    if (enforced.replaced.length) {
      logger.warn("agent.destination_url_corrected", {
        replaced: enforced.replaced.slice(0, 5),
        verified: verifiedDestinations.slice(0, 5),
      });
    }
    display = enforced.text;
  }

  // Leave a bare sign-off untouched so the caller can still swap in a
  // description of the picker it attached.
  if (notice && display.trim() !== GENERIC_FALLBACK_REPLY) {
    display = `${notice}\n\n${display.trim()}`;
  }

  await input.onProgress?.({
    phase: "write_report",
    label: writingLabel(input),
    stepId: "write_report",
    summary: display,
    delta: "",
  });

  return {
    summary: display,
    messages: [{ role: "assistant", content: display }],
    // A strategy is recommend-only: tool JSON in its reply is never queued.
    toolCalls:
      input.reportDraft || resolveWriterIntent(input) === "strategy"
        ? []
        : humanized.toolCalls,
    mode,
    ui: input.reportDraft
      ? undefined
      : {
          ...(humanized.servicePicker
            ? { servicePicker: humanized.servicePicker }
            : {}),
          ...(humanized.copyPicker ? { copyPicker: humanized.copyPicker } : {}),
          ...(humanized.adPicker ? { adPicker: humanized.adPicker } : {}),
          ...(humanized.imageChoice
            ? { imageChoice: humanized.imageChoice }
            : {}),
          ...(humanized.formatChoice
            ? { formatChoice: humanized.formatChoice }
            : {}),
          ...(humanized.videoChoice
            ? { videoChoice: humanized.videoChoice }
            : {}),
          ...(humanized.targetingPicker
            ? { targetingPicker: humanized.targetingPicker }
            : {}),
          ...(humanized.campaignSettingsPicker
            ? { campaignSettingsPicker: humanized.campaignSettingsPicker }
            : {}),
        },
    report: input.reportDraft
      ? {
          title: input.reportTitle ?? "Meta Ops session report",
          data: input.reportData,
        }
      : undefined,
  };
}

/** Minimum gap between live preview rebuilds while tokens stream. */
const PREVIEW_INTERVAL_MS = 60;

function liveReplyPreview(text: string): string {
  const trimmed = text.trim();
  // Prefer any prose before machine JSON so the bubble grows smoothly.
  const stripped = stripMachineJson(text).trim();
  if (stripped && stripped !== GENERIC_FALLBACK_REPLY && stripped.length >= 8) {
    return stripped;
  }
  if (
    trimmed.startsWith("{") ||
    trimmed.startsWith("[") ||
    trimmed.startsWith("```json") ||
    trimmed.startsWith("```")
  ) {
    return "Writing reply…";
  }
  if (trimmed.length >= 12) return trimmed;
  if (trimmed.includes("?")) return trimmed;
  return text.length > 0 ? text : "Writing reply…";
}

async function runMockAgent(input: {
  task: Task;
  clientContext: string;
  toolEvidence?: string;
  reportDraft?: string;
  reportTitle?: string;
  reportData?: import("@/lib/report/schema").AuditReport;
  intent?: RequestIntent;
  correlationId?: string;
  onProgress?: (event: AgentProgressEvent) => void | Promise<void>;
}): Promise<AgentRunResult> {
  const intent =
    input.intent ?? detectRequestIntent(input.task.goal ?? input.task.title);
  await input.onProgress?.({
    phase: "write_report",
    label: input.reportDraft
      ? "Formatting report…"
      : intent === "chat"
        ? "Answering…"
        : intent === "strategy"
          ? "Writing strategy…"
          : "Preparing summary…",
    stepId: "write_report",
  });

  const evidence = input.toolEvidence?.trim();

  // Strategy replies come from the real engine evidence, so DEMO shows the
  // actual plan: the evidence sections verbatim. (The brief question never
  // reaches here; runAdspirerAgent answers it deterministically.)
  if (intent === "strategy" && !input.reportDraft) {
    const inputsAt = evidence?.indexOf("### Strategy inputs") ?? -1;
    let summary: string;
    if (evidence && inputsAt >= 0) {
      const frameworkAt = evidence.indexOf("### Strategy framework", inputsAt);
      const body = evidence.slice(inputsAt, frameworkAt < 0 ? undefined : frameworkAt).trim();
      const notice = categoryNoticeLine(evidence);
      const settingsLines = settingsNoticeLines(evidence);
      summary = [
        ...(notice ? [notice, ""] : []),
        ...(settingsLines.length ? [...settingsLines, ""] : []),
        "## Strategy plan (demo)",
        "",
        body,
        "",
        "This is a recommendation only — nothing in Meta has changed.",
      ].join("\n");
    } else {
      summary = [
        "### Strategy",
        "I couldn't build the strategy plan for this client yet.",
        evidence ?? "",
      ]
        .filter(Boolean)
        .join("\n");
    }
    await input.onProgress?.({
      phase: "write_report",
      label: "Writing strategy…",
      stepId: "write_report",
      summary,
      delta: summary,
    });
    return {
      summary,
      messages: [{ role: "assistant", content: summary }],
      toolCalls: [],
      mode: "mock",
    };
  }

  if (intent === "chat" && !input.reportDraft) {
    const summary =
      "I'm running without a language model in this workspace, so I can't answer free-form questions here. Ask me to list campaigns or audit the account and I'll pull the live data.";
    await input.onProgress?.({
      phase: "write_report",
      label: "Answering…",
      stepId: "write_report",
      summary,
      delta: summary,
    });
    return {
      summary,
      messages: [{ role: "assistant", content: summary }],
      toolCalls: [],
      mode: "mock",
    };
  }

  if (evidence?.includes("### Audit briefing incomplete")) {
    const summary =
      "I can run a Meta Ads best-practice audit — reply with whether you want the **entire account** or **specific campaigns**, and a **date range** (e.g. last 30 days). I won't change anything until you ask to optimize.";
    await input.onProgress?.({
      phase: "write_report",
      label: "Asking for audit details…",
      stepId: "write_report",
      summary,
      delta: summary,
    });
    return {
      summary,
      messages: [{ role: "assistant", content: summary }],
      toolCalls: [],
      mode: "mock",
    };
  }

  if (evidence?.includes("### Audit checklist")) {
    const spendLine =
      evidence.match(/### Account spend[^\n]*\n- ([^\n]+)/)?.[1] ??
      evidence.match(/Sum of listed campaign spend: (\$[0-9.]+)/)?.[1] ??
      "see campaign performance section";
    const summary = [
      "## Meta Ads audit (demo)",
      "",
      "### Spend snapshot",
      `- ${spendLine}`,
      "",
      "### What's working",
      "- See live campaign performance evidence above for CTR/CPC winners.",
      "",
      "### Needs improvement",
      "- Review low-efficiency high-spend campaigns against the audit checklist.",
      "",
      "### Recommendations",
      "- Prioritize creative refresh and budget reallocation on underperformers (advisory only).",
      "",
      "Say which campaign or ad copy you want to **optimize** when you're ready — I won't change Meta until then.",
    ].join("\n");
    await input.onProgress?.({
      phase: "write_report",
      label: "Writing audit…",
      stepId: "write_report",
      summary,
      delta: summary,
    });
    return {
      summary,
      messages: [{ role: "assistant", content: summary }],
      toolCalls: [],
      mode: "mock",
    };
  }

  if (input.reportDraft) {
    const summary = [
      "Here is your session report. Use **Download Word** / **Download PDF** under this message.",
      "",
      input.reportDraft.trim(),
    ].join("\n");
    await input.onProgress?.({
      phase: "write_report",
      label: "Formatting report…",
      stepId: "write_report",
      summary,
      delta: summary,
    });
    return {
      summary,
      messages: [{ role: "assistant", content: summary }],
      toolCalls: [],
      mode: "mock",
      report: {
        title: input.reportTitle ?? "Meta Ops session report",
        data: input.reportData,
      },
    };
  }

  if (intent === "out_of_scope") {
    const summary = [
      "That one's outside what this workspace is set up for. I'm here for this client's Meta ads and the analytics around them (GA4, Search Console, Google Ads, Shopify). A few things you could ask instead:",
      "",
      "- Which campaigns had the best cost per result last week?",
      "- Why did my CPM go up this month?",
      "- Write three new ad angles for our best-selling offer.",
    ].join("\n");
    await input.onProgress?.({
      phase: "write_report",
      label: "Scope reminder",
      stepId: "write_report",
      summary,
      delta: summary,
    });
    return {
      summary,
      messages: [{ role: "assistant", content: summary }],
      toolCalls: [],
      mode: "mock",
    };
  }

  const accountId = await resolvePrimaryAccountId(input.task.client_id);
  const toolCalls: AgentToolCallProposal[] = [];
  let summary: string;
  let ui: AgentRunResult["ui"];

  if (intent === "create_campaign") {
    summary = [
      "### Stage status",
      "- **Format** — pick image or video first",
      "- **A Brief intake** — pending (objective, name, daily budget, landing URL, primary text, headline)",
      "- **Creative** — image URL / generate stills, OR video URL / Meta video ID",
      "- **B Website services** — waiting for campaign proof",
      "- **C Ad sets + ads** — waiting",
      "",
      "I can create a **PAUSED** Meta image or video campaign on the connected account.",
      "First: do you want an **image** or **video** ad/campaign?",
      accountId ? `\nMapped account: \`${accountId}\`` : "",
    ]
      .filter(Boolean)
      .join("\n");
    ui = { formatChoice: {} };
  } else if (intent === "scrape_services") {
    const services = parseServicesFromEvidence(evidence ?? "");
    summary = [
      `I found **${services.length} services** you can build ad sets for.`,
      "Select the ones you want below (or reply with the names).",
      "",
      "### Stage status",
      "- **B Website services** — scraped",
      "- **C Ad sets + ads** — pick services to continue",
      "",
      evidence ?? "No scrape evidence yet.",
    ].join("\n");
    ui = { servicePicker: { services } };
  } else if (intent === "ad_copy") {
    const humanized = evidence ? humanizeAgentReply(evidence) : null;
    const copies =
      humanized?.copyPicker?.copies ??
      parseCopyPickerFromEvidence(evidence ?? "");
    if (copies.length) {
      summary = [
        `I drafted **${copies.length} Meta ad copy variants**. Pick one below.`,
        "",
        ...copies.map(
          (c) =>
            `**${c.id} · ${c.angle}**\n- Headline: ${c.headline}\n- Primary: ${c.primary_text}`,
        ),
        "",
        "After you approve a variant, tell me if you want to create a campaign, generate images, or something else — I won't advance on my own.",
      ].join("\n");
      ui = { copyPicker: { copies } };
    } else {
      summary = [
        "I can draft Meta ad copy (headline, primary text, description, CTA).",
        "",
        "Reply with:",
        "1. Offer / product / service",
        "2. Audience",
        "3. Landing page URL",
        "4. Tone (optional)",
        "5. Must-include / must-avoid (optional)",
        "6. Variant count (default 3)",
        "",
        evidence ?? "",
      ]
        .filter(Boolean)
        .join("\n");
    }
  } else if (intent === "copy_approved") {
    const humanized = evidence ? humanizeAgentReply(evidence) : null;
    summary =
      humanized?.display ??
      [
        "Copy approved and ready to reuse.",
        "",
        "What would you like next? I can create a campaign with this copy, generate image creatives, write a video script, or leave it here until you decide.",
      ].join("\n");
  } else if (intent === "optimize") {
    const humanized = evidence ? humanizeAgentReply(evidence) : null;
    summary = humanized?.display
      ? [
          humanized.display,
          "",
          "Pick an ad below (or reply with the ad id), then I’ll run the optimize tools.",
        ].join("\n")
      : (evidence ?? "No ads found to optimize yet.");
    if (humanized?.adPicker?.ads?.length) {
      ui = { adPicker: humanized.adPicker };
    }
  } else {
    const humanized = evidence
      ? humanizeAgentReply(evidence)
      : null;
    const notice = categoryNoticeLine(evidence);
    const settingsLines = settingsNoticeLines(evidence);
    const opening = [...(notice ? [notice] : []), ...settingsLines];
    // The notices open the reply, so they aren't repeated where the evidence had them.
    const display = opening.length
      ? humanized?.display
          ?.split("\n")
          .filter((line) => !opening.includes(line.trim().replace(/^[-*]\s+/, "")))
          .join("\n")
      : humanized?.display;
    summary = display
      ? [
          ...(notice ? [notice, ""] : []),
          ...(settingsLines.length ? [...settingsLines, ""] : []),
          display,
          "",
          "Use **Export Word** / **Export PDF** under this message if you need a file.",
          "If you want an execute change (budget/pause/create campaign), ask me to propose it for Approvals.",
        ].join("\n")
      : [
          "### Meta Ads report",
          "I couldn't gather live Meta data for this client yet.",
          "Check Connections → synced Meta accounts are mapped to this client, then ask again to audit.",
        ].join("\n");
  }

  await input.onProgress?.({
    phase: "write_report",
    label: "Preparing summary…",
    stepId: "write_report",
    summary,
    delta: summary,
  });

  if (
    accountId &&
    (accountId === "act_100200300" ||
      input.task.client_id === "client_modern_dental") &&
    intent === "budget"
  ) {
    toolCalls.push({
      name: "update_adset_budget",
      args: {
        account_id: accountId,
        adset_id: "adset_mdc_npl_1",
        daily_budget_cents: 5500,
        previous_daily_budget_cents: 4000,
      },
      rationale:
        "Increase New Patient Leads daily budget $40 → $55 within ceiling.",
    });
  }

  logger.info("Mock agent completed", {
    taskId: input.task.id,
    toolCallCount: toolCalls.length,
    correlationId: input.correlationId,
  });

  return {
    summary,
    messages: [{ role: "assistant", content: summary }],
    toolCalls,
    mode: "mock",
    ui,
  };
}

function parseServicesFromEvidence(
  evidence: string,
): Array<{ id: string; name: string; description?: string }> {
  const lines = evidence
    .split("\n")
    .map((l) => l.replace(/^[-*]\s*/, "").trim())
    .filter((l) => /^svc_|\b[A-Z]/.test(l) && l.length < 120);
  const fromBullets = lines
    .filter((l) => /svc_|service|offering/i.test(evidence) || l.includes("·"))
    .slice(0, 12);
  if (fromBullets.length) {
    return fromBullets.map((line, i) => {
      const m = line.match(/^(svc_\d+)\s*[·:.-]\s*(.+?)(?:\s*[·—-]\s*(.*))?$/i);
      if (m) {
        return { id: m[1], name: m[2].trim(), description: m[3]?.trim() };
      }
      return { id: `svc_${i + 1}`, name: line };
    });
  }
  return [
    { id: "svc_1", name: "Core offering", description: "Confirm with operator" },
    { id: "svc_2", name: "Secondary offering" },
  ];
}

function parseCopyPickerFromEvidence(evidence: string): CopyPickerUi["copies"] {
  const fromJson = humanizeAgentReply(evidence).copyPicker?.copies;
  if (fromJson?.length) return fromJson;

  const blocks = evidence.split(/^####\s+/m).slice(1);
  const copies: CopyPickerUi["copies"] = [];
  for (const block of blocks) {
    const header = block.split("\n")[0] ?? "";
    const idMatch = header.match(/^(copy_\d+)/i);
    if (!idMatch) continue;
    const angle = header.split("·")[1]?.trim() || "Variant";
    const headline =
      block.match(/Headline:\s*(.+)/i)?.[1]?.trim() ?? "";
    const primary =
      block.match(/Primary text:\s*(.+)/i)?.[1]?.trim() ?? "";
    const description =
      block.match(/Description:\s*(.+)/i)?.[1]?.trim() ?? undefined;
    const cta = block.match(/CTA:\s*(.+)/i)?.[1]?.trim() ?? undefined;
    if (!headline || !primary) continue;
    copies.push({
      id: idMatch[1],
      angle,
      primary_text: primary,
      headline,
      description,
      cta,
    });
  }
  return copies;
}

export function extractUrlFromText(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s)>"']+/i);
  if (match) return match[0].replace(/[.,;:]+$/, "");
  const www = text.match(/\bwww\.[^\s)>"']+/i);
  if (www) return `https://${www[0].replace(/[.,;:]+$/, "")}`;
  return null;
}

/** Pull labeled headline / primary text from a freeform operator message. */
export function extractAdCopyFromText(text: string): {
  headline?: string;
  primaryText?: string;
} {
  const headlineMatch = text.match(
    /\bheadline\s*[:\-–—]\s*["“]?([^\n"”]{4,160})["”]?/i,
  );
  const primaryMatch = text.match(
    /\bprimary(?:\s*text)?\s*[:\-–—]\s*["“]?([\s\S]{12,1200}?)["”]?(?=\n\s*(?:headline|cta|description|landing|url|https?:\/\/)|$)/i,
  );
  const headline = headlineMatch?.[1]?.trim().replace(/\s+/g, " ");
  const primaryText = primaryMatch?.[1]
    ?.trim()
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s+/g, " ");
  return {
    ...(headline ? { headline } : {}),
    ...(primaryText ? { primaryText } : {}),
  };
}

export { resolvePrimaryAccountId } from "@/lib/adspirer/resolve-meta-account";

const INSIGHTS_CONCURRENCY = 5;

/**
 * Start a request now and await it later. The no-op catch stops an early
 * rejection from being reported as unhandled before the caller awaits it;
 * awaiting the returned promise still throws.
 */
function background<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined);
  return promise;
}

/** Map with at most `limit` calls in flight; results keep input order. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

/** Major-unit amount in the account currency (code suffix when unknown symbol). */
export function formatMoneyMajor(
  amount: number,
  currency: string | null | undefined,
): string {
  if (!Number.isFinite(amount)) return "n/a";
  if (!currency) return `${amount.toFixed(2)} (account currency)`;
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function formatInsightMetrics(
  i: MetaInsights,
  money: (amount: number) => string,
): string {
  const parts = [
    `spend ${money(i.spend)}`,
    `${i.impressions.toLocaleString()} imps`,
    `${i.clicks.toLocaleString()} clicks`,
    `CTR ${i.ctr.toFixed(2)}%`,
    `CPC ${money(i.cpc)}`,
  ];
  if (i.reach != null) parts.push(`reach ${i.reach.toLocaleString()}`);
  if (i.frequency != null) parts.push(`freq ${i.frequency.toFixed(2)}`);
  if (i.conversions != null) parts.push(`conv ${i.conversions}`);
  if (i.cost_per_conversion != null) {
    parts.push(`CPA ${money(i.cost_per_conversion)}`);
  }
  return parts.join(" · ");
}

/** Collect live Meta evidence before the LLM writes the report. */
export async function gatherDiagnoseEvidence(input: {
  clientId: string;
  /** The turn's user (the task's created_by): only an admin's stated settings are saved. */
  userId?: string | null;
  request: string;
  conversationId?: string | null;
  history?: AgentHistoryMessage[];
  /** Pre-resolved intent (supports audit brief follow-ups). */
  intent?: ReturnType<typeof detectRequestIntent>;
  /** What the operator's message means: mode, focus, scope, period, queue selection. */
  brief?: RequestBrief;
  /** Reads the task runner already started — shared to avoid repeat queries. */
  preloaded?: {
    metaAccounts?: Promise<ConnectedMetaAccount[]>;
    documents?: Promise<WorkspaceDocument[]>;
    selectedCreative?: Promise<CreativeDraft | null>;
  };
  onProgress?: (event: AgentProgressEvent) => void | Promise<void>;
  /**
   * Persists the settings save's audit record the moment it changes, so a
   * later throw in this turn can never leave a save without its audit row.
   */
  onSettingsSaved?: (call: AgentToolCallProposal) => void | Promise<void>;
}): Promise<{
  accountId: string | null;
  evidence: string;
  toolCalls: AgentToolCallProposal[];
  /** Numbered optimisation proposals offered this turn (nothing is queued from them until asked). */
  offered?: OfferedProposal[];
  /** Ids in the optimisation's scope; null = the whole account. */
  scopeEntityIds?: string[] | null;
  /** Campaigns, ad sets and ads by name, for resolving names the operator types later. */
  entityIndex?: EntityRef[];
  /** The account's campaigns, ad sets and ads, for resolving names the operator typed. */
  inventory?: Inventory;
  /** Code-written "who does what" table appended to an optimisation reply. */
  optimizeAppendix?: string;
  copyPicker?: CopyPickerUi;
  adPicker?: AdPickerUi;
  imageChoice?: ImageChoiceUi;
  formatChoice?: FormatChoiceUi;
  videoChoice?: VideoChoiceUi;
  targetingPicker?: TargetingPickerUi;
  /** True when audit needs scope/dates/campaigns before full analysis. */
  auditBriefingIncomplete?: boolean;
  /** Deterministic checklist table appended to the audit reply (and exports). */
  auditAppendix?: string;
  /** True when a strategy needs a daily budget or target ROAS before planning. */
  strategyBriefIncomplete?: boolean;
  /** True only once the strategy plan engine has produced a plan this turn. */
  strategyPlanBuilt?: boolean;
}> {
  const intent = input.intent ?? detectRequestIntent(input.request);
  const preloadedAccounts = input.preloaded?.metaAccounts
    ? await input.preloaded.metaAccounts.catch(() => undefined)
    : undefined;
  const accountId = await resolvePrimaryAccountId(
    input.clientId,
    preloadedAccounts,
  );
  const loadDocuments = () =>
    input.preloaded?.documents ??
    loadDocumentsForContext({
      clientId: input.clientId,
      conversationId: input.conversationId ?? null,
    });
  /** Account currency from the overview — evidence money is never assumed USD. */
  let currency: string | null = null;
  const money = (amount: number) => formatMoneyMajor(amount, currency);
  const toolCalls: AgentToolCallProposal[] = [];
  let offered: OfferedProposal[] = [];
  let scopeEntityIds: string[] | null = null;
  let entityIndex: EntityRef[] = [];
  let inventory: Inventory | undefined;
  let optimizeAppendix: string | undefined;
  const sections: string[] = [];
  let copyPicker: CopyPickerUi | undefined;
  let adPicker: AdPickerUi | undefined;
  let imageChoice: ImageChoiceUi | undefined;
  let formatChoice: FormatChoiceUi | undefined;
  let videoChoice: VideoChoiceUi | undefined;
  let targetingPicker: TargetingPickerUi | undefined;
  let auditBriefingIncomplete = false;
  let auditAppendix: string | undefined;
  let strategyBriefIncomplete = false;
  let strategyPlanBuilt = false;

  const targetingSubmitted =
    /\badvanced targeting selections\b/i.test(input.request) ||
    /\bskip advanced targeting\b/i.test(input.request);

  if (targetingSubmitted) {
    sections.push(
      [
        "### Targeting recorded",
        "Operator submitted advanced targeting from the picker.",
        "Acknowledge what they selected in plain language.",
        "Do NOT show image_choice, video_choice, format_choice, service_picker, or creative generation.",
        "Do NOT prescribe a creative or campaign-create next step unless they explicitly ask.",
        "Wait for their next instruction.",
      ].join("\n"),
    );
    return {
      accountId,
      evidence: sections.join("\n\n"),
      toolCalls,
    };
  }

  // Settings the message states ("our margin is 40%") are saved before any
  // plan is built, so this turn already uses them. Reported in one section.
  // Every step reports straight away (onChange), so a save always has its
  // line and its audit row even if a later step throws.
  let settingsSection = -1;
  let settingsCall: AgentToolCallProposal | null = null;
  const showSettings = async (turn: ChatSettingsTurn) => {
    const text = turn.evidence();
    if (text) {
      if (settingsSection < 0) settingsSection = sections.push(text) - 1;
      else sections[settingsSection] = text;
    }
    const call = turn.toolCall();
    if (call) {
      if (settingsCall) Object.assign(settingsCall, call);
      else toolCalls.push((settingsCall = { ...call }));
      await input.onSettingsSaved?.({ ...settingsCall });
    }
  };
  const settings: ChatSettingsTurn | null =
    intent === "chat" || intent === "out_of_scope"
      ? null
      : await applyChatSettings({
          clientId: input.clientId,
          userId: input.userId,
          request: input.request,
          loadServices: () => activeClientServices(input.clientId).catch(() => []),
          onChange: showSettings,
        });
  /** The client's goals with this turn's stated values on top. */
  const turnGoals = () => clientGoals(input.clientId, settings?.goalsOverride());

  if (
    !accountId &&
    intent !== "ad_copy" &&
    intent !== "generate_creatives" &&
    intent !== "scrape_services" &&
    intent !== "optimize" &&
    intent !== "copy_approved"
  ) {
    if (intent === "strategy") {
      // No account, no snapshot: say so instead of letting a generic plan through.
      const goals = await turnGoals();
      const word = goals.business_model === "ecommerce" ? "category" : "service";
      const loaded = categoriesFromServices(await activeClientServices(input.clientId)).length;
      sections.push(
        noMappedAccountMessage(),
        [
          "### Strategy unavailable",
          "- No Meta ad account is mapped to this client, so there is no spend or return to plan from.",
          `- ${loaded} ${loaded === 1 ? word : word === "category" ? "categories" : "services"} loaded for this client.`,
          "- To fix: map the client's Meta ad account under Connections (connect Facebook, sync accounts, then Add as client / Map), then ask again.",
        ].join("\n"),
      );
      return { accountId: null, evidence: sections.join("\n\n"), toolCalls };
    }
    return {
      accountId: null,
      evidence: [...sections, noMappedAccountMessage()].join("\n\n"),
      toolCalls,
    };
  }

  let provider: MetaAdsProvider;
  try {
    provider = await resolveAgentProvider();
  } catch (error) {
    return {
      accountId,
      evidence: [
        ...sections,
        `### Provider\n- Failed to resolve Meta access: ${
          error instanceof Error ? error.message : String(error)
        }\n- Connect Facebook in the Workspace header or under Connections, then retry.`,
      ].join("\n\n"),
      toolCalls,
    };
  }

  if (intent === "out_of_scope") {
    return { accountId, evidence: "Request appears outside this client's ads and analytics. If it is about the client's Meta, GA4, Search Console or Google Ads data, answer it with the read-only data tools.", toolCalls };
  }

  const wantsCampaignList = Boolean(
    accountId &&
      (intent === "audit" ||
        intent === "list_campaigns" ||
        intent === "budget" ||
        intent === "general" ||
        intent === "export"),
  );
  // Start the campaign list now so it loads while the overview does.
  const campaignsPromise = wantsCampaignList
    ? background(provider.listCampaigns(accountId!))
    : null;

  if (accountId) {
    await input.onProgress?.({
      phase: "fetch_overview",
      label: "Fetching account overview…",
      stepId: "fetch_overview",
    });
    try {
      const overview = await provider.getAccountOverview(accountId);
      currency = overview.currency || null;
      toolCalls.push({
        name: "get_account_overview",
        args: { account_id: accountId },
        rationale: "Account overview",
      });
      sections.push(
        [
          "### Account overview",
          `- Name: ${overview.account_name}`,
          `- ID: ${overview.account_id}`,
          `- Currency: ${overview.currency} · TZ: ${overview.timezone}`,
          `- Campaigns: ${overview.total_campaigns ?? overview.active_campaigns + overview.paused_campaigns} total (${overview.active_campaigns} active, ${overview.paused_campaigns} paused)`,
          `- Health: ${overview.health}`,
          ...(overview.notes ?? []).map((n) => `- Note: ${n}`),
        ].join("\n"),
      );
    } catch (error) {
      sections.push(
        `### Account overview\n- Failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  } else if (intent === "ad_copy") {
    sections.push(
      "### Account overview\n- No Meta account mapped yet — copy can still be drafted; map an account before Approvals create.",
    );
  }

  if (accountId && campaignsPromise) {
    await input.onProgress?.({
      phase: "list_campaigns",
      label: "Listing Meta campaigns…",
      stepId: "list_campaigns",
    });
    try {
      const campaigns = await campaignsPromise;
      toolCalls.push({
        name: "list_campaigns",
        args: { account_id: accountId },
        rationale: "Campaign inventory",
      });
      if (!campaigns.length) {
        sections.push(
          `### Campaigns\n- No campaigns returned from Meta for ${accountId}.`,
        );
      } else {
        const lines = campaigns.slice(0, 25).map((c) => {
          const budget =
            c.daily_budget_cents != null
              ? ` · daily ${money(c.daily_budget_cents / 100)}`
              : "";
          return `- ${c.name} (${c.id}) · ${c.status} · ${c.objective}${budget}`;
        });
        sections.push(
          `### Campaigns (${campaigns.length})\n${lines.join("\n")}`,
        );
      }

      if (intent === "audit") {
        let brief = resolveAuditBrief(input.request, input.history ?? []);
        // Competitor LP URLs only from competitor docs / spreadsheets — never scan
        // brand/copy docs (those poisoned own destinations with googleconsult etc.).
        try {
          const docs = await loadDocuments();
          const pinnedOrRecent = docs.slice(0, 8);
          const competitorDocs = pinnedOrRecent.filter(
            (d) =>
              d.doc_kind === "competitor" ||
              /\.(xlsx|xls|csv)$/i.test(d.filename),
          );
          if (competitorDocs.length) {
            brief = applyCompetitorUrlsFromDocuments(
              brief,
              competitorDocs.map((d) => d.extracted_text || d.excerpt || ""),
            );
            sections.push(
              [
                "### Workspace documents (competitor / spreadsheet only — NOT own Meta Website URLs)",
                "Do not use these as the campaign Destination → Website URL.",
                ...competitorDocs.slice(0, 5).map(
                  (d) =>
                    `- ${d.filename} · kind=${d.doc_kind}${
                      d.conversation_id ? " · this chat" : ""
                    }`,
                ),
              ].join("\n"),
            );
          }
        } catch {
          // Documents optional
        }

        let effectiveMissing = [...brief.missing];
        // Competitor LPs are optional when unset — do not block the initial audit.
        if (brief.competitorLanding === "unset") {
          effectiveMissing = effectiveMissing.filter(
            (m) => m !== "competitor_landing",
          );
        }
        let matchedCampaigns: MetaCampaign[] = [];

        if (brief.scope === "campaigns") {
          matchedCampaigns = resolveAuditCampaigns(campaigns, brief);
          if ((brief.campaignHints.length || brief.activeCampaigns) && matchedCampaigns.length === 0) {
            if (!effectiveMissing.includes("campaigns")) {
              effectiveMissing.push("campaigns");
            }
          } else if (matchedCampaigns.length > 0) {
            effectiveMissing = effectiveMissing.filter((m) => m !== "campaigns");
          }
        }

        // Competitor LPs only block when operator promised URLs but none were found.
        const ready =
          !effectiveMissing.includes("scope") &&
          !effectiveMissing.includes("date_range") &&
          !effectiveMissing.includes("competitor_landing") &&
          !(
            brief.scope === "campaigns" &&
            (effectiveMissing.includes("campaigns") || matchedCampaigns.length === 0)
          ) &&
          Boolean(brief.dateStart && brief.dateStop);

        if (!ready) {
          auditBriefingIncomplete = true;
          const askBrief = {
            ...brief,
            missing: effectiveMissing as typeof brief.missing,
            ready: false,
          };
          sections.push(
            [
              "### Audit briefing incomplete",
              `- Known scope: ${brief.scope ?? "unset"}`,
              `- Campaign hints: ${[
                ...brief.campaignHints,
                ...(brief.activeCampaigns ? ["(active campaigns)"] : []),
              ].join(", ") || "(none)"}`,
              brief.activeCampaigns && matchedCampaigns.length === 0
                ? "- No campaign is ACTIVE right now — tell the operator that and ask which campaign(s) to audit."
                : "",
              `- Date range: ${brief.dateLabel ?? "unset"}`,
              `- Competitor LPs: ${
                brief.competitorLanding === "skip"
                  ? "skip"
                  : brief.competitorLanding === "provided"
                    ? `${brief.competitorUrls.length} URL(s)`
                    : "unset"
              }`,
              `- Missing: ${effectiveMissing.join(", ") || "none"}`,
              "",
              "Ask ONLY for the missing fields below. Do NOT invent an audit yet.",
              "Do NOT queue optimize or execute tools.",
              "",
              buildAuditClarifyingQuestion(askBrief),
              "",
              campaigns.length
                ? "You may briefly list a few live campaign names to help them pick (from Campaigns evidence)."
                : "",
            ]
              .filter(Boolean)
              .join("\n"),
          );
        } else {
          await input.onProgress?.({
            phase: "pull_insights",
            label: "Pulling spend & performance…",
            stepId: "pull_insights",
          });

          const dateStart = brief.dateStart!;
          const dateStop = brief.dateStop!;
          const dateLabel = brief.dateLabel ?? `${dateStart} → ${dateStop}`;

          sections.push(
            [
              "### Audit brief (confirmed)",
              `- Scope: ${brief.scope === "account" ? "Entire ad account" : "Selected campaigns"}`,
              brief.scope === "campaigns"
                ? `- Campaigns: ${matchedCampaigns.map((c) => `${c.name} (${c.id})`).join("; ")}`
                : null,
              `- Period: ${dateLabel} (${dateStart} → ${dateStop})`,
              !brief.compare
                ? `- Compared with: nothing — not requested; report the audited period only`
                : brief.compareStart && brief.compareStop
                  ? `- Compared with: ${brief.compareLabel ?? ""} (${brief.compareStart} → ${brief.compareStop}), as the operator asked`
                  : `- Compared with: the same number of days immediately before (as asked)`,
              `- Competitor LPs: ${
                brief.competitorLanding === "skip"
                  ? "skipped"
                  : `${brief.competitorUrls.length} URL(s) provided`
              }`,
            ]
              .filter(Boolean)
              .join("\n"),
          );

          // Ads and creatives don't depend on insights — fetch them in parallel.
          const adsPromise = background(provider.listAds(accountId));
          const creativesPromise = background(
            (async (): Promise<MetaAdCreative[]> => {
              if (!provider.getAdCreatives) return [];
              if (brief.scope === "campaigns" && matchedCampaigns.length) {
                // Campaign-scoped only — never mix other campaigns' Website URLs.
                const perCampaign = await Promise.all(
                  matchedCampaigns.slice(0, 8).map((c) =>
                    provider.getAdCreatives!(accountId, {
                      campaign_id: c.id,
                      limit: 40,
                    }).catch(() => [] as MetaAdCreative[]),
                  ),
                );
                const byAd = new Map<string, MetaAdCreative>();
                for (const batch of perCampaign) {
                  for (const row of batch) byAd.set(row.ad_id, row);
                }
                return [...byAd.values()];
              }
              return provider.getAdCreatives(accountId, { limit: 50 });
            })(),
          );

          if (provider.getAccountInsights && brief.scope === "account") {
            try {
              const accountInsights = await provider.getAccountInsights(
                accountId,
                dateStart,
                dateStop,
              );
              toolCalls.push({
                name: "get_account_insights",
                args: {
                  account_id: accountId,
                  date_start: dateStart,
                  date_stop: dateStop,
                },
                rationale: "Account spend for audit period",
              });
              sections.push(
                `### Account spend (${dateLabel})\n- ${formatInsightMetrics(accountInsights, money)}`,
              );
            } catch (error) {
              sections.push(
                `### Account spend\n- Failed: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
          }

          const insightTargets: MetaCampaign[] =
            brief.scope === "campaigns"
              ? matchedCampaigns
              : [
                  ...campaigns.filter((c) => c.status === "ACTIVE"),
                  ...campaigns.filter((c) => c.status === "PAUSED"),
                ].slice(0, 20);

          const insightLines: string[] = [];
          let totalSpend = 0;
          // A few at a time: fast, but well inside Meta's per-account rate limits.
          const insightResults = await mapWithConcurrency(
            insightTargets,
            INSIGHTS_CONCURRENCY,
            async (c) => {
              try {
                return {
                  ok: true as const,
                  row: await provider.getCampaignInsights(
                    accountId,
                    c.id,
                    dateStart,
                    dateStop,
                  ),
                };
              } catch (error) {
                return { ok: false as const, error };
              }
            },
          );
          for (const [index, c] of insightTargets.entries()) {
            const outcome = insightResults[index]!;
            if (outcome.ok) {
              const row = outcome.row;
              toolCalls.push({
                name: "get_campaign_insights",
                args: {
                  account_id: accountId,
                  campaign_id: c.id,
                  date_start: dateStart,
                  date_stop: dateStop,
                },
                rationale: `Insights for ${c.name}`,
              });
              totalSpend += row.spend;
              insightLines.push(
                `- ${c.name} (${c.id}) · ${c.status} · ${c.objective} · ${formatInsightMetrics(row, money)}`,
              );
            } else {
              const error = outcome.error;
              insightLines.push(
                `- ${c.name} (${c.id}): insights failed — ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
          }
          sections.push(
            [
              `### Campaign performance (${dateLabel})`,
              `- Campaigns scored: ${insightTargets.length}`,
              `- Sum of listed campaign spend: ${money(totalSpend)}`,
              "",
              ...insightLines,
            ].join("\n"),
          );

          // Light ad sample for creative pillar (LLM can deepen via tools)
          try {
            const ads = await adsPromise;
            toolCalls.push({
              name: "list_ads",
              args: { account_id: accountId },
              rationale: "Creative inventory sample for audit",
            });
            const scopedAds =
              brief.scope === "campaigns"
                ? ads.filter((a) =>
                    matchedCampaigns.some((c) => c.id === a.campaign_id),
                  )
                : ads;
            sections.push(
              [
                `### Ads sample (${Math.min(scopedAds.length, 25)} of ${scopedAds.length})`,
                ...scopedAds.slice(0, 25).map(
                  (a) =>
                    `- ${a.name} (${a.id}) · ${a.status}${
                      a.creative_summary ? ` — ${a.creative_summary}` : ""
                    }`,
                ),
              ].join("\n"),
            );
          } catch (error) {
            sections.push(
              `### Ads sample\n- Failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }

          // Destination URLs + landing page analysis from Meta Graph (paused OK).
          // Do this in preflight so the writer cannot invent pause excuses or
          // substitute workspace-document URLs for Ads Manager Website URLs.
          await input.onProgress?.({
            phase: "landing_pages",
            label: "Fetching ad destinations & analysing landing pages…",
            stepId: "landing_pages",
          });
          try {
            const creatives = await creativesPromise;

            toolCalls.push({
              name: "get_meta_ad_creatives",
              args: {
                account_id: accountId,
                limit: 50,
                ...(brief.scope === "campaigns" && matchedCampaigns[0]
                  ? { campaign_id: matchedCampaigns[0].id }
                  : {}),
              },
              rationale:
                "Ads Manager Website URL / CTA destinations (includes paused; resolves page post)",
            });

            const scopedCreatives =
              brief.scope === "campaigns"
                ? creatives.filter((c) =>
                    matchedCampaigns.some(
                      (m) =>
                        m.id === c.campaign_id ||
                        String(m.id) === String(c.campaign_id),
                    ),
                  )
                : creatives;

            const perAdLines = scopedCreatives.slice(0, 40).map((c) => {
              const cta = formatCtaForDisplay(c.call_to_action_type);
              const dest = c.landing_page_url?.trim();
              const statusBits = [
                c.ad_status ? `ad=${c.ad_status}` : null,
                c.effective_status ? `effective=${c.effective_status}` : null,
              ]
                .filter(Boolean)
                .join(" · ");
              const alts =
                c.destination_candidates?.filter(
                  (u) => u.toLowerCase() !== dest?.toLowerCase(),
                ) ?? [];
              return `- Ad **${c.ad_name ?? c.ad_id}** (${c.ad_id})${
                statusBits ? ` · ${statusBits}` : ""
              } · ${c.creative_type ?? "creative"} · CTA: ${cta} · Website URL: ${
                dest && /^https?:\/\//i.test(dest)
                  ? dest
                  : "_not returned by Meta on this creative_"
              }${
                c.destination_source ? ` _(from ${c.destination_source})_` : ""
              }${
                alts.length
                  ? `\n  - Other Meta candidates: ${alts.slice(0, 3).join(" · ")}`
                  : ""
              }`;
            });

            const byUrl = new Map<
              string,
              {
                url: string;
                ads: string[];
                adContext: string;
                ctaTypes: string[];
              }
            >();
            for (const c of scopedCreatives) {
              const url = c.landing_page_url?.trim();
              if (!url || !/^https?:\/\//i.test(url)) continue;
              const key = url.toLowerCase();
              const existing = byUrl.get(key);
              const adLabel = `${c.ad_name ?? c.ad_id}${
                c.campaign_id ? ` · campaign ${c.campaign_id}` : ""
              }`;
              const ctx = [c.headline, c.primary_text, c.call_to_action_type]
                .filter(Boolean)
                .join(" — ");
              if (existing) {
                existing.ads.push(adLabel);
                if (c.call_to_action_type) {
                  existing.ctaTypes.push(c.call_to_action_type);
                }
                if (ctx && ctx.length > (existing.adContext?.length ?? 0)) {
                  existing.adContext = ctx;
                }
              } else {
                byUrl.set(key, {
                  url,
                  ads: [adLabel],
                  adContext: ctx,
                  ctaTypes: c.call_to_action_type
                    ? [c.call_to_action_type]
                    : [],
                });
              }
            }

            const destLines = [...byUrl.values()].slice(0, 20).map((row) => {
              const ctas =
                [...new Set(row.ctaTypes)].map(formatCtaForDisplay).join(", ") ||
                "n/a";
              return `- **${row.url}**\n  - CTA type(s): ${ctas}\n  - Used by: ${row.ads.slice(0, 4).join("; ")}${
                row.ads.length > 4 ? "…" : ""
              }`;
            });

            sections.push(
              [
                buildVerifiedDestinationsMarker(
                  [...byUrl.values()].map((row) => row.url),
                ),
                buildAllowedUrlsMarker(brief.competitorUrls),
                `### Ad CTA & destination inventory (${scopedCreatives.length} ads)`,
                "SOURCE OF TRUTH for own landing pages = Ads Manager **Destination → Website URL** from Meta (creative + page post). Works when PAUSED.",
                "Copy these Website URLs into Landing pages. NEVER invent. NEVER use workspace-document URLs (e.g. googleconsult from competitor copy) as this campaign's destination.",
                perAdLines.length
                  ? perAdLines.join("\n")
                  : "- No ads returned for destination inventory.",
                "",
                `### Unique destination URLs (${byUrl.size})`,
                destLines.length
                  ? destLines.join("\n")
                  : "- No https Website URLs parsed from Meta creatives yet.",
              ].join("\n"),
            );

            const ownTargets = [...byUrl.values()].slice(0, 5).map((row) => ({
              url: row.url,
              role: "own" as const,
              adContext: row.adContext || null,
            }));
            const competitorTargets =
              brief.competitorLanding === "provided"
                ? brief.competitorUrls.slice(0, 5).map((url) => ({
                    url,
                    role: "competitor" as const,
                    adContext: null,
                  }))
                : [];

            if (ownTargets.length || competitorTargets.length) {
              const analyses = await analyzeLandingPages([
                ...ownTargets,
                ...competitorTargets,
              ]);
              sections.push(formatLandingAnalysesForEvidence(analyses));
            } else {
              sections.push(
                [
                  formatLandingAnalysesForEvidence([]),
                  "",
                  "### Landing page note",
                  "- Meta returned ads but no Website URL on creatives — flag as a creative/destination gap.",
                  "- NEVER claim this is because the campaign is paused (paused ads still have Website URLs when configured).",
                  "- NEVER substitute a URL from workspace documents for the Meta destination.",
                ].join("\n"),
              );
            }
          } catch (error) {
            sections.push(
              `### Landing page analysis\n- Failed fetching Meta destinations: ${
                error instanceof Error ? error.message : String(error)
              }\n- Retry get_meta_ad_creatives; do not invent URLs or use workspace docs as own destinations.`,
            );
          }

          sections.push(
            [
              "### Diagnose tools (optional enrichment)",
              "Preflight already loaded overview, campaigns, insights, and Meta destination / LP analysis above.",
              "You may call diagnose tools for extra detail, but Landing pages MUST use the **Ad CTA & destination inventory** Website URLs (not workspace documents).",
              "Paused campaigns still have destinations — never say otherwise.",
            ].join("\n"),
          );

          if (brief.competitorLanding === "unset") {
            sections.push(
              [
                "### Competitor landing pages (optional)",
                "- None provided yet — still analyse own Meta destinations now.",
                "- After the audit, invite the operator to paste competitor LP URLs or upload Excel/CSV if they want a comparison.",
              ].join("\n"),
            );
          }

          // Checkpoint engine: tracking, structure, bidding, audiences,
          // creative and funnel scored from live data. The writer interprets;
          // the table is appended to the reply verbatim.
          if (provider.getAuditSnapshot) {
            await input.onProgress?.({
              phase: "audit_checkpoints",
              label: "Checking tracking, structure & audiences…",
              stepId: "apply_framework",
            });
            try {
              const accountSnapshot = await provider.getAuditSnapshot(accountId, {
                since: dateStart,
                until: dateStop,
                days: Math.max(
                  1,
                  Math.round((Date.parse(`${dateStop}T00:00:00Z`) - Date.parse(`${dateStart}T00:00:00Z`)) / 86_400_000) + 1,
                ),
                // Compare only when the operator asked; then a range they named ("Oct 19-20 vs Oct 17-18").
                compare: brief.compare,
                ...(brief.compare && brief.compareStart && brief.compareStop
                  ? { compareSince: brief.compareStart, compareUntil: brief.compareStop }
                  : {}),
              });
              // A campaign audit scores and lists only those campaigns' ad sets and ads.
              const snapshot =
                brief.scope === "campaigns"
                  ? scopeAuditSnapshot(accountSnapshot, matchedCampaigns.map((c) => c.id))
                  : accountSnapshot;
              const scorecard = evaluateCheckpoints(snapshot, { goals: await turnGoals() });
              sections.push(renderScorecardEvidence(scorecard, snapshot));
              sections.push(renderAdSetEvidence(snapshot));
              auditAppendix = renderScorecardMarkdown(scorecard, snapshot);
              toolCalls.push({
                name: "audit_checkpoints",
                args: { account_id: accountId, date_start: dateStart, date_stop: dateStop },
                rationale: `Audit checkpoints: ${scorecard.score}/100`,
              });
            } catch (error) {
              sections.push(
                `### Audit checkpoint scorecard\n- Could not compute: ${
                  error instanceof Error ? error.message : String(error)
                }. Mark tracking, learning-phase and audience checks as "not verified" instead of guessing. Ad set numbers were not loaded — say so in the ad set section; never invent them.`,
              );
            }
          }

          await input.onProgress?.({
            phase: "apply_framework",
            label: "Applying audit checklist…",
            stepId: "apply_framework",
          });
          sections.push(
            [
              "### Audit checklist (apply to evidence above)",
              META_AUDIT_FRAMEWORK,
              "",
              "### Writer instructions for this audit",
              "- Produce the full audit in chat using the Required report format headings, in order.",
              "- Lead with Fail checkpoints from the scorecard (most severe, most spend at stake first); never contradict a checkpoint result.",
              "- Quantify spend and call out what is working vs what needs improvement.",
              "- **REQUIRED: audit every ad set** listed in “Ad sets” inside section 4 (Active Campaigns): the 9-column ad set table from the report format (IDs, budgets and optimisation events go in the verdict bullets, not the table), then a short verdict per ad set (Scale / Keep / Fix / Pause) with its numbers and the reason. Cover learning status, budget vs results, frequency, audience/placement setup and its ads.",
              "- Spend, results and cost per result for the period come from the evidence above — never say they are unavailable when “Ad sets” or “Campaign performance” lists them.",
              "- **REQUIRED section: Landing pages** — use Website URLs + CTA types from “Ad CTA & destination inventory” and scores from “Landing page analysis”.",
              "- NEVER say destinations are unavailable because the campaign is paused or had $0 spend.",
              "- NEVER use workspace-document URLs (e.g. competitor copy docs) as the campaign destination.",
              "- If a destination URL is missing from Meta, say so and recommend fixing the CTA / Website URL in Ads Manager.",
              "- Include prioritized recommendations covering both ads/budgets AND landing pages.",
              "- Do NOT queue execute/optimize tools and do NOT claim you changed Meta.",
              "- Close with at most ONE next step (the single highest-impact fix) — no menu of options.",
            ].join("\n"),
          );

          try {
            const analysis = await provider.analyzeAccount(accountId);
            toolCalls.push({
              name: "analyze_account",
              args: { account_id: accountId },
              rationale: "Supplemental diagnostics",
            });
            sections.push(
              [
                "### Supplemental diagnostics",
                ...analysis.findings.map((f) => `- ${f}`),
                ...(analysis.recommended_actions.length
                  ? [
                      "",
                      "### Supplemental recommended actions",
                      ...analysis.recommended_actions.map((r) => `- ${r}`),
                    ]
                  : []),
              ].join("\n"),
            );
          } catch (error) {
            sections.push(
              `### Supplemental diagnostics\n- Failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
      }
    } catch (error) {
      sections.push(
        `### Campaigns\n- Failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // Goal-driven strategy: snapshot first (it supplies the current daily spend
  // the brief can fall back on), then the brief, then the plan engine. The
  // writer gets the engine's numbers and the three-level report method.
  // Recommend only — nothing here proposes or queues an execute tool.
  if (accountId && intent === "strategy") {
    await input.onProgress?.({
      phase: "fetch_overview",
      label: "Loading the account snapshot…",
      stepId: "fetch_overview",
    });
    try {
      if (!provider.getAuditSnapshot) {
        throw new Error("this Meta connection can't load an account snapshot");
      }
      const range = parseDateRangeFromText("last 30 days")!;
      const snapshot = await withCatalogCategories(
        input.clientId,
        await provider.getAuditSnapshot(accountId, {
          since: range.dateStart,
          until: range.dateStop,
          days: 30,
        }),
      );
      const goals = await turnGoals();
      const currentDailySpendCents = snapshot.totals
        ? Math.round(snapshot.totals.spendCents / snapshot.period.days)
        : null;
      const parsed = resolveStrategyBrief(input.request, input.history, {
        goals,
        currentDailySpendCents,
      });

      // Lead-gen clients plan on leads and cost per lead; ROAS never applies to them.
      const leadAsk = isLeadStrategy(goals.business_model, strategyAskTexts(input.request, input.history));
      const leadParsed = leadAsk ? resolveLeadBrief(input.request, input.history) : null;

      if (leadParsed) {
        if (!leadParsed.brief) {
          strategyBriefIncomplete = true;
          sections.push(
            [
              "### Strategy brief incomplete",
              `- Missing: ${leadParsed.missing.join(", ")}`,
              "Ask ONLY for the missing values below. Do NOT build a plan or invent numbers.",
              "Do NOT queue optimize or execute tools.",
              "",
              buildLeadClarifyingQuestion(),
            ].join("\n"),
          );
        } else {
          const leadBrief = leadParsed.brief;
          await input.onProgress?.({
            phase: "build_plan",
            label: "Sizing the budget for your lead goal…",
            stepId: "build_plan",
          });
          const scorecard = evaluateCheckpoints(snapshot, { goals });
          toolCalls.push({
            name: "audit_checkpoints",
            args: { account_id: accountId, date_start: range.dateStart, date_stop: range.dateStop },
            rationale: `Audit checkpoints: ${scorecard.score}/100`,
          });
          const leadPlan = buildLeadPlan({ snapshot, goals, brief: leadBrief });
          strategyPlanBuilt = true;
          sections.push(
            renderLeadStrategyEvidence(leadPlan, {
              score: scorecard,
              periodAssumed: leadParsed.periodAssumed,
              warnings: snapshot.warnings,
            }),
          );
          sections.push(
            ["### Strategy framework (write the report with these headings)", LEAD_STRATEGY_FRAMEWORK].join("\n"),
          );
          toolCalls.push({
            name: "strategy_plan",
            args: {
              account_id: accountId,
              goal: "leads",
              target_leads: leadBrief.targetLeads,
              period_days: leadBrief.periodDays,
              daily_budget_cents: leadBrief.dailyBudgetCents,
              target_cpl_cents: leadBrief.targetCplCents,
            },
            rationale: `Lead strategy plan: ${
              leadBrief.targetLeads != null ? `${leadBrief.targetLeads} leads / ${leadBrief.periodDays} days` : "budget projection"
            }, reference cost per lead ${leadPlan.reference.cplCents ?? "unavailable"}`,
          });
        }
      } else if (!parsed.brief) {
        strategyBriefIncomplete = true;
        sections.push(
          [
            "### Strategy brief incomplete",
            `- Missing: ${parsed.missing.join(", ")}`,
            "Ask ONLY for the missing values below. Do NOT build a plan or invent numbers.",
            "Do NOT queue optimize or execute tools.",
            "",
            buildStrategyClarifyingQuestion(parsed.missing),
          ].join("\n"),
        );
      } else {
        const brief = parsed.brief;
        const categoryWord = goals.business_model === "ecommerce" ? "category" : "service";
        const active = await activeClientServices(input.clientId);
        // A whole-account ask's stated target becomes the client's target ROAS (never a stretch or a category's).
        if (settings && !parsed.usedDefaults.includes("target_roas")) {
          await settings.saveStrategyTarget(brief.targetRoas, {
            texts: strategyAskTexts(input.request, input.history),
            categories: categoriesFromServices(active),
          });
        }
        await input.onProgress?.({
          phase: "pull_insights",
          label: `Matching spend & return to each ${categoryWord}…`,
          stepId: "pull_insights",
        });
        // A category the ask names but isn't set up yet is found on the website and added.
        const requested = await addCategoryFromRequest({
          clientId: input.clientId,
          request: input.request,
          kind: "strategy",
          active,
        });
        if (requested.evidence) sections.push(requested.evidence);
        // A margin stated for the category just added applies to it now.
        await settings?.applyPendingCategories(requested.services);
        const categories = categoriesFromServices(settings?.withServiceOverrides(requested.services) ?? requested.services);
        const attribution = attributeSpendToCategories(snapshot, categories);
        const scorecard = evaluateCheckpoints(snapshot, { goals });
        toolCalls.push({
          name: "audit_checkpoints",
          args: { account_id: accountId, date_start: range.dateStart, date_stop: range.dateStop },
          rationale: `Audit checkpoints: ${scorecard.score}/100`,
        });

        await input.onProgress?.({
          phase: "build_plan",
          label: "Building the plan…",
          stepId: "build_plan",
        });
        const { channels, channelWarnings } = await loadChannelPerformance(
          input.clientId,
          snapshot,
          categories,
          attribution,
        );
        const scoped = requested.scoped
          ? categories.filter((c) => c.id === requested.scoped!.id)
          : scopeCategoriesFromRequest(input.request, categories);
        const plan = buildStrategyPlan({
          snapshot,
          scorecard,
          categories,
          goals,
          brief,
          categoryWord,
          channels,
          scopeCategoryIds: scoped.length > 0 ? scoped.map((c) => c.id) : undefined,
        });
        strategyPlanBuilt = true;
        const cents = (value: number) => formatMoneyMajor(value / 100, snapshot.account.currency);
        const defaultsUsed: string[] = [];
        if (parsed.usedDefaults.includes("budget")) {
          defaultsUsed.push(
            goals.daily_account_cap_cents
              ? `Daily budget not stated: used the client's daily account cap (${cents(brief.dailyBudgetCents)}/day).`
              : `Daily budget not stated: used the current daily spend, averaged over the last ${snapshot.period.days} days (${cents(brief.dailyBudgetCents)}/day).`,
          );
        }
        if (parsed.usedDefaults.includes("target_roas")) {
          defaultsUsed.push(`Target ROAS not stated: used the client's target ROAS (${brief.targetRoas}×) from their goals.`);
        }
        sections.push(
          renderStrategyEvidence(plan, attribution, {
            currency: snapshot.account.currency,
            categoryWord,
            defaultsUsed,
            // The "Total budget" line says the period was assumed, so no separate default line.
            periodAssumed: parsed.usedDefaults.includes("period"),
            warnings: snapshot.warnings,
            channels,
            channelWarnings,
          }),
        );
        sections.push(["### Strategy framework (write the report with these headings)", STRATEGY_FRAMEWORK].join("\n"));
        toolCalls.push({
          name: "strategy_plan",
          args: {
            account_id: accountId,
            daily_budget_cents: brief.dailyBudgetCents,
            target_roas: brief.targetRoas,
            stretch_targets: brief.stretchTargets,
          },
          rationale: `Strategy plan: target ${brief.targetRoas}x, ${categories.length} ${categoryWord === "category" ? "categories" : "services"}, verdict ${plan.benchmark.realityCheck.verdict}`,
        });
      }
    } catch (error) {
      sections.push(
        `### Strategy plan\n- Could not build the plan: ${
          error instanceof Error ? error.message : String(error)
        }. Say the strategy could not be built and why; never invent spend, ROAS or an allocation.`,
      );
    }
  }

  // "How much went into bar stools, and what did it return?": spend and return
  // per category from the snapshot. Figures only, no plan or allocation.
  if (accountId && (intent === "general" || intent === "budget")) {
    const spendProgress = async (categoryWord: string) =>
      input.onProgress?.({
        phase: "pull_insights",
        label: `Matching spend & return to each ${categoryWord}…`,
        stepId: "pull_insights",
      });
    // The website scan below can be slow, so say what's happening first.
    const namesCategory = requestedCategoryPhrase(input.request, "spend") != null;
    if (namesCategory) {
      const goals = await turnGoals();
      await spendProgress(goals.business_model === "ecommerce" ? "category" : "service");
    }
    // A category the ask names but isn't set up yet is found on the website and added.
    const requested = await addCategoryFromRequest({
      clientId: input.clientId,
      request: input.request,
      kind: "spend",
      active: await activeClientServices(input.clientId).catch(() => []),
    });
    if (requested.evidence) sections.push(requested.evidence);
    await settings?.applyPendingCategories(requested.services);
    const categories = categoriesFromServices(settings?.withServiceOverrides(requested.services) ?? requested.services);
    if (categories.length && (requested.scoped || asksAboutCategorySpend(input.request, categories))) {
      const goals = await turnGoals();
      const categoryWord = goals.business_model === "ecommerce" ? "category" : "service";
      if (!namesCategory) await spendProgress(categoryWord);
      try {
        if (!provider.getAuditSnapshot) {
          throw new Error("this Meta connection can't load an account snapshot");
        }
        // The period the question names, in whole days, so revenue and spend cover the same dates.
        const range = completedDaysRange(input.request);
        const snapshot = await withCatalogCategories(
          input.clientId,
          await provider.getAuditSnapshot(accountId, {
            since: range.dateStart,
            until: range.dateStop,
            days: range.days,
          }),
        );
        const attribution = attributeSpendToCategories(snapshot, categories);
        const { channels, channelWarnings } = await loadChannelPerformance(
          input.clientId,
          snapshot,
          categories,
          attribution,
        );
        sections.push(
          renderCategorySpendEvidence(attribution, categories, {
            currency: snapshot.account.currency,
            categoryWord,
            periodDays: snapshot.period.days,
            accountSpendCents: snapshot.totals?.spendCents ?? null,
            warnings: snapshot.warnings,
            channels,
            channelWarnings,
            // A question about named categories uses GA4 for them, however few are set up.
            scoped: !!requested.scoped || scopeCategoriesFromRequest(input.request, categories).length > 0,
            rankBy: asksForReturnOnSpend(input.request) ? "return" : "revenue",
            period: { since: snapshot.period.since, until: snapshot.period.until },
          }),
        );
      } catch (error) {
        sections.push(
          `### Spend & return by ${categoryWord}\n- Could not load: ${
            error instanceof Error ? error.message : String(error)
          }. Say the figures are not available; never estimate them.`,
        );
      }
    }
  }

  // Questions read the health checks themselves (meta_account_health) when the
  // answer needs them; generic findings on every turn pulled answers off topic.
  if (accountId && intent === "export") {
    await input.onProgress?.({
      phase: "diagnose",
      label: "Running account diagnostics…",
      stepId: "diagnose",
    });
    try {
      const analysis = await provider.analyzeAccount(accountId);
      toolCalls.push({
        name: "analyze_account",
        args: { account_id: accountId },
        rationale: "Diagnostic audit",
      });
      sections.push(
        [
          "### Diagnostic findings",
          ...analysis.findings.map((f) => `- ${f}`),
          ...(analysis.recommended_actions.length
            ? [
                "",
                "### Recommended actions",
                ...analysis.recommended_actions.map((r) => `- ${r}`),
              ]
            : []),
        ].join("\n"),
      );
    } catch (error) {
      sections.push(
        `### Diagnostics\n- Failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // Performance questions outside an audit ("how is spend pacing?", "why is
  // CPA up this week?") get a light live snapshot — account totals plus active
  // campaigns — instead of the full multi-step audit.
  const asksAboutPerformance =
    /\b(perform\w*|spend|spent|spending|pacing|deliver\w*|results?|cpa|cpc|cpm|ctr|roas|cost per|conversions?|leads?|clicks?|impressions?|reach|frequency|doing|working|winning|losing|wasting|analy[sz]\w*|trend\w*)\b/i.test(
      input.request,
    );
  if (
    accountId &&
    campaignsPromise &&
    asksAboutPerformance &&
    (intent === "general" ||
      intent === "budget" ||
      intent === "list_campaigns")
  ) {
    await input.onProgress?.({
      phase: "pull_insights",
      label: "Pulling recent performance…",
      stepId: "diagnose",
    });
    const range =
      parseDateRangeFromText(input.request) ??
      parseDateRangeFromText("last 7 days")!;
    try {
      const campaigns = await campaignsPromise;
      const active = campaigns
        .filter((c) => c.status === "ACTIVE")
        .slice(0, 10);
      const [accountRow, campaignRows] = await Promise.all([
        provider.getAccountInsights
          ? provider
              .getAccountInsights(accountId, range.dateStart, range.dateStop)
              .catch(() => null)
          : Promise.resolve(null),
        mapWithConcurrency(active, INSIGHTS_CONCURRENCY, (c) =>
          provider
            .getCampaignInsights(accountId, c.id, range.dateStart, range.dateStop)
            .then((row) => ({ c, row }))
            .catch(() => ({ c, row: null as MetaInsights | null })),
        ),
      ]);
      if (accountRow) {
        toolCalls.push({
          name: "get_account_insights",
          args: {
            account_id: accountId,
            date_start: range.dateStart,
            date_stop: range.dateStop,
          },
          rationale: "Performance snapshot",
        });
      }
      for (const { c, row } of campaignRows) {
        if (!row) continue;
        toolCalls.push({
          name: "get_campaign_insights",
          args: {
            account_id: accountId,
            campaign_id: c.id,
            date_start: range.dateStart,
            date_stop: range.dateStop,
          },
          rationale: `Performance snapshot for ${c.name}`,
        });
      }
      sections.push(
        [
          `### Performance snapshot (${range.dateLabel}: ${range.dateStart} → ${range.dateStop})`,
          accountRow
            ? `- Account total: ${formatInsightMetrics(accountRow, money)}`
            : "- Account total: not returned by Meta",
          active.length
            ? `- Active campaigns (${active.length}${campaigns.filter((c) => c.status === "ACTIVE").length > active.length ? ", top 10 listed" : ""}):`
            : "- No ACTIVE campaigns in this account.",
          ...campaignRows.map(({ c, row }) =>
            row
              ? `  - ${c.name} (${c.id}) · ${formatInsightMetrics(row, money)}`
              : `  - ${c.name} (${c.id}): insights unavailable`,
          ),
          "Use these figures to answer; say when a figure the operator asked about is not here.",
        ].join("\n"),
      );
    } catch (error) {
      sections.push(
        `### Performance snapshot\n- Failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // "Is anything running?" / "any ad sets active under this campaign?" need
  // live ad set and ad statuses — the campaign list alone made the writer
  // guess (it once called a paused ad an active ad set).
  if (accountId && intent !== "audit" && asksAboutDeliveryStructure(input.request)) {
    await input.onProgress?.({
      phase: "delivery_structure",
      label: "Checking ad sets & ads on Meta…",
      stepId: "diagnose",
    });
    try {
      const campaigns = await (campaignsPromise ?? provider.listCampaigns(accountId));
      sections.push(
        await gatherDeliveryStructure({
          provider,
          accountId,
          campaigns,
          request: input.request,
          history: input.history,
          money,
          mapWithConcurrency,
        }),
      );
      toolCalls.push({
        name: "list_adsets",
        args: { account_id: accountId },
        rationale: "Live ad set and ad status",
      });
    } catch (error) {
      sections.push(
        `### Delivery structure\n- Failed to load ad sets/ads: ${
          error instanceof Error ? error.message : String(error)
        }. Say you couldn't check instead of guessing.`,
      );
    }
  }

  // Follow-up asks like "what's the landing page URL?" are not audit intent, so
  // fetch Meta destinations here too — otherwise the writer answers from chat
  // history and repeats an earlier wrong URL.
  const asksAboutLandingPage =
    /\b(landing\s*pages?|destination\s*url|website\s*url|lp\s*url|destination\s*link|lcp|page\s*speed|pagespeed|core\s*web\s*vitals?|load\s*time|page\s*weight|cta|call[\s-]*to[\s-]*action|book[\s_-]*(?:now|travel))\b/i.test(
      input.request,
    );
  if (
    accountId &&
    intent !== "audit" &&
    asksAboutLandingPage &&
    provider.getAdCreatives
  ) {
    await input.onProgress?.({
      phase: "landing_pages",
      label: "Fetching ad destinations & analysing landing pages…",
      stepId: "landing_pages",
    });
    try {
      const creatives = await provider.getAdCreatives(accountId, { limit: 50 });
      toolCalls.push({
        name: "get_meta_ad_creatives",
        args: { account_id: accountId, limit: 50 },
        rationale: "Ads Manager Website URLs for landing page answer",
      });

      const byUrl = new Map<string, { url: string; ads: string[] }>();
      for (const c of creatives) {
        const url = c.landing_page_url?.trim();
        if (!url || !/^https?:\/\//i.test(url)) continue;
        const key = url.toLowerCase();
        const label = `${c.ad_name ?? c.ad_id}${
          c.campaign_id ? ` · campaign ${c.campaign_id}` : ""
        }`;
        const existing = byUrl.get(key);
        if (existing) existing.ads.push(label);
        else byUrl.set(key, { url, ads: [label] });
      }

      sections.push(
        [
          buildVerifiedDestinationsMarker([...byUrl.values()].map((r) => r.url)),
          `### Meta ad destinations (live from Graph · ${creatives.length} ads)`,
          "SOURCE OF TRUTH = Ads Manager **Destination → Website URL**. Valid while PAUSED.",
          "Answer only with these URLs. Never reuse a URL from earlier chat turns or workspace documents.",
          ...creatives.slice(0, 25).map((c) => {
            const dest = c.landing_page_url?.trim();
            return `- **${c.ad_name ?? c.ad_id}** (${c.ad_id})${
              c.campaign_id ? ` · campaign ${c.campaign_id}` : ""
            } · CTA ${formatCtaForDisplay(c.call_to_action_type)} · Website URL: ${
              dest && /^https?:\/\//i.test(dest)
                ? `${dest}${
                    c.destination_source ? ` _(from ${c.destination_source})_` : ""
                  }`
                : "_not configured on this creative_"
            }`;
          }),
        ]
          .filter(Boolean)
          .join("\n"),
      );

      if (byUrl.size) {
        const analyses = await analyzeLandingPages(
          [...byUrl.values()].slice(0, 5).map((row) => ({
            url: row.url,
            role: "own" as const,
            adContext: null,
          })),
        );
        sections.push(formatLandingAnalysesForEvidence(analyses));
      }
    } catch (error) {
      sections.push(
        `### Meta ad destinations\n- Failed fetching destinations: ${
          error instanceof Error ? error.message : String(error)
        }\n- Say the fetch failed; never quote a URL from history or documents.`,
      );
    }
  }

  const scrapeUrl = extractUrlFromText(input.request);
  const shouldScrape =
    Boolean(scrapeUrl) &&
    intent !== "ad_copy" &&
    intent !== "copy_approved" &&
    intent !== "generate_creatives" &&
    (intent === "scrape_services" ||
      (intent === "create_campaign" &&
        /\b(scrape|services?|website)\b/i.test(input.request)));

  if (shouldScrape && scrapeUrl) {
    await input.onProgress?.({
      phase: "scrape_services",
      label: "Scraping website services…",
      stepId: "scrape_services",
    });
    try {
      const { scrapeWebsiteServices } = await import("@/lib/scraping/firecrawl");
      const scraped = await scrapeWebsiteServices(scrapeUrl);
      toolCalls.push({
        name: "scrape_website_services",
        args: { url: scrapeUrl },
        rationale: "Website service extraction for ad grouping",
      });
      const serviceLines = scraped.services.length
        ? scraped.services.map(
            (s) =>
              `- ${s.id} · ${s.name}${
                s.description ? ` — ${s.description}` : ""
              }`,
          )
        : ["- (no services extracted — ask operator to list them)"];
      sections.push(
        [
          "### Website scrape",
          `- URL: ${scraped.url}`,
          scraped.title ? `- Title: ${scraped.title}` : null,
          `- Source: ${scraped.source}`,
          "",
          "### Services / offerings",
          ...serviceLines,
          "",
          "Summarize these services in natural language for the operator. Append service_picker JSON only as a trailing appendix — never as the whole reply.",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    } catch (error) {
      sections.push(
        `### Website scrape\n- Failed for ${scrapeUrl}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (intent === "ad_copy") {
    await input.onProgress?.({
      phase: "generate_copy",
      label: "Generating ad copy variants…",
      stepId: "generate_copy",
    });
    try {
      const { generateMetaAdCopies, parseAdCopyBriefFromText } = await import(
        "@/lib/ads/ad-copy"
      );
      // Pull light client fields from DB/demo for brand voice
      let clientName = "Client";
      let brandVoice: string | undefined;
      let industry: string | undefined;
      let valueProposition: string | undefined;
      const config = getConfig();
      if (config.isDemoMode || !config.hasSupabase) {
        const client = getDemoStore().clients.find((c) => c.id === input.clientId);
        clientName = client?.name ?? clientName;
        brandVoice = client?.brand_voice ?? undefined;
        industry = client?.industry ?? undefined;
        valueProposition = client?.value_proposition ?? undefined;
      } else {
        const { createAdminClient } = await import("@/lib/supabase/admin");
        const supabase = createAdminClient();
        const { data } = await supabase
          .from("clients")
          .select("name, brand_voice, industry, value_proposition")
          .eq("id", input.clientId)
          .maybeSingle();
        if (data) {
          clientName = String(data.name ?? clientName);
          brandVoice =
            typeof data.brand_voice === "string" ? data.brand_voice : undefined;
          industry =
            typeof data.industry === "string" ? data.industry : undefined;
          valueProposition =
            typeof data.value_proposition === "string"
              ? data.value_proposition
              : undefined;
        }
      }

      const brief = parseAdCopyBriefFromText(input.request) ?? {
        offer: "Core offer",
        audience: "Target audience",
        variants: 3,
      };

      try {
        const docs = await loadDocuments();
        if (docs.length) {
          brief.reference_material = docs
            .slice(0, 4)
            .map(
              (d) =>
                `### ${d.filename} (${d.doc_kind})\n${(d.extracted_text || d.excerpt || "").slice(0, 4000)}`,
            )
            .join("\n\n");
        }
      } catch {
        // Documents optional
      }

      const hasEnough =
        Boolean(brief.offer && brief.audience) &&
        (/\b(offer|audience|landing|for |targeting|generate|write|draft|copy|recreate|competitor)\b/i.test(
          input.request,
        ) ||
          Boolean(brief.landing_page_url) ||
          Boolean(brief.reference_material) ||
          brief.offer !== "Core offer");

      if (!hasEnough) {
        sections.push(
          [
            "### Ad copy intake",
            "Brief is incomplete. Ask the operator for:",
            "1. Offer / product / service",
            "2. Audience",
            "3. Landing page URL",
            "4. Tone (optional)",
            "5. Must-include / must-avoid phrases (optional)",
            "6. How many variants (default 3)",
            "",
            "Do NOT invent Meta mutations yet. After they answer, generate copies and present a copy_picker.",
          ].join("\n"),
        );
      } else {
        const generated = await generateMetaAdCopies({
          clientName,
          brandVoice,
          industry,
          valueProposition,
          accountId,
          brief,
        });
        toolCalls.push({
          name: "generate_ad_copies",
          args: {
            client_name: clientName,
            offer: brief.offer,
            audience: brief.audience,
            landing_page_url: brief.landing_page_url,
            account_id: accountId ?? undefined,
            refresh: brief.refresh,
          },
          rationale:
            "Ad Copy Writing Room framework — Meta variants grounded in live creatives when available",
        });
        if (accountId && generated.grounded_in_live_creatives) {
          toolCalls.push({
            name: "get_meta_ad_creatives",
            args: { account_id: accountId, lookback_days: 30 },
            rationale: "Grounded copy against live Meta creatives",
          });
        }
        copyPicker = {
          copies: generated.variants.map((v) => ({
            id: v.id,
            angle: v.angle,
            primary_text: v.primary_text,
            headline: v.headline,
            description: v.description,
            cta: v.cta,
          })),
        };
        sections.push(
          [
            "### Ad copy variants",
            `- Copy guide: ${generated.framework_url}`,
            `- Draft engine: ${generated.source}`,
            `- Brand: ${clientName}`,
            generated.grounded_in_live_creatives
              ? `- Grounded in ${generated.live_creative_count} live Meta creative(s) via get_meta_ad_creatives`
              : accountId
                ? "- No live creatives returned — wrote net-new angles"
                : "- No mapped Meta account — wrote from brief only (map an account under Connections for live grounding)",
            brief.landing_page_url
              ? `- Landing: ${brief.landing_page_url}`
              : null,
            "",
            ...generated.variants.flatMap((v) => [
              `#### ${v.id} · ${v.angle}${v.test_first ? " · test first" : ""}`,
              `- Headline: ${v.headline}`,
              `- Primary text: ${v.primary_text}`,
              `- Description: ${v.description}`,
              `- CTA: ${v.cta}`,
              v.rationale ? `- Rationale: ${v.rationale}` : null,
              "",
            ]),
            "Present copies in natural language. Append copy_picker JSON appendix for the UI.",
            "Do NOT scrape website services or create ad sets from this step.",
            "Do NOT show targeting_picker, format_choice, or campaign intake.",
            "After the operator picks a variant: acknowledge and ask what they want next (campaign, images, script, etc.). Do not proceed until they ask.",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }
    } catch (error) {
      sections.push(
        `### Ad copy\n- Failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // Selected creative from this conversation → attach to campaign create
  // payloads. Scoped on purpose: a still approved for a previous campaign is
  // not a default for the one being briefed now.
  try {
    const { getSelectedCreativeDraftAsync, resolveImageUrlForAdspirer } =
      await import("@/lib/creatives/drafts");
    const selected = await (input.preloaded?.selectedCreative ??
      getSelectedCreativeDraftAsync(input.clientId, {
        conversationId: input.conversationId ?? null,
      }));
    if (selected) {
      const imageUrl = resolveImageUrlForAdspirer(selected);
      sections.push(
        [
          "### Selected creative (from Creatives)",
          `- Draft: ${selected.id}`,
          `- Headline: ${selected.headline}`,
          `- Primary text: ${selected.primary_text.slice(0, 200)}`,
          imageUrl ? `- image_url: ${imageUrl}` : "- image_url: (missing)",
          "",
          "Use this image_url in create_meta_image_campaign / create_ad Approvals JSON (image campaigns only).",
        ].join("\n"),
      );
    }
  } catch {
    // ignore
  }

  if (intent === "create_campaign") {
    const request = input.request ?? "";
    const format = detectCreativeFormat(request);
    const wantsVideo = format === "video";
    const wantsImage = format === "image";

    if (wantsVideo) {
      const url = extractUrlFromText(request);
      videoChoice = {
        landing_page_url: url ?? undefined,
      };
      sections.push(
        [
          "### Creative format",
          "Operator asked for a **video** campaign.",
          "Ask for a public video_url (MP4/MOV) or existing_video_id. Append video_choice UI.",
          "Queue create_meta_video_campaign (not image). Do not offer GPT Image generation.",
          url ? `Landing URL detected: ${url}` : "Ask for landing page URL.",
        ].join("\n"),
      );
    } else if (wantsImage) {
      if (!mentionsCreativeGeneration(request)) {
        const url = extractUrlFromText(request);
        imageChoice = {
          landing_page_url: url ?? undefined,
        };
        sections.push(
          [
            "### Creative format",
            "Operator asked for an **image** campaign.",
            "Ask: Image URL / Meta hash, OR generate stills. Append image_choice UI.",
            "Do not create without image_url.",
            url
              ? `Landing URL detected: ${url}`
              : "Ask for landing page URL for brand colour/logo analysis.",
          ].join("\n"),
        );
      }
    } else {
      formatChoice = {};
      sections.push(
        [
          "### Creative format (ask first)",
          "Ask whether this is an **image** or **video** ad/campaign before other brief fields.",
          "Append format_choice UI and stop until they pick.",
          "Image → later image_choice / create_meta_image_campaign.",
          "Video → later video_choice / create_meta_video_campaign (operator provides video URL or Meta video ID; no generation).",
        ].join("\n"),
      );
    }

    if (accountId && (wantsImage || wantsVideo)) {
      targetingPicker = { account_id: accountId };
      sections.push(
        [
          "### Advanced targeting",
          "Show the targeting_picker UI (custom audiences + detailed targeting dropdowns from Meta).",
          `Append: {"ui":"targeting_picker","account_id":"${accountId}"}`,
          "Do NOT ask audience or interest names in prose. Operator picks from dropdowns or skips.",
          "On confirm, pass custom_audiences / interests / behaviors / locations into create args.",
        ].join("\n"),
      );
    }
  }

  if (intent === "generate_creatives") {
    const url = extractUrlFromText(input.request);
    const copyFields = extractAdCopyFromText(input.request);
    imageChoice = {
      landing_page_url: url ?? undefined,
      brand_url: url ?? undefined,
      headline: copyFields.headline,
      primary_text: copyFields.primaryText,
    };
    sections.push(
      [
        "### Standalone image / creative generation",
        "Operator asked to generate ad images / creatives — not a full campaign.",
        url
          ? `Brand / reference URL detected: ${url} — the system will scrape brand colours/logo from it and render stills in this turn.`
          : "If a brand or company URL was given earlier in chat or on the client record, use it for brand colours/logo. Ask only if no URL is available.",
        copyFields.headline
          ? `Headline on file: ${copyFields.headline}`
          : "Use headline/primary_text from the request or approved copy when present.",
        copyFields.primaryText
          ? `Primary text on file: ${copyFields.primaryText.slice(0, 280)}${copyFields.primaryText.length > 280 ? "…" : ""}`
          : null,
        "Acknowledge briefly that brand scrape + GPT Image stills are starting.",
        "Do NOT invent 'here are N variations' or dump image_choice JSON as the whole reply — stills attach as creative cards after generation.",
        "Do NOT claim images are ready before generation completes.",
        "If workspace documents / competitor ads are in context, treat them as visual or messaging reference — recreate style for OUR brand; do not copy logos or trademarked artwork.",
        "After stills render: stop. Ask if they want to use one in a campaign — do not start targeting or campaign create.",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  if (intent === "copy_approved") {
    sections.push(
      [
        "### Ad copy approved",
        "Operator approved a copy variant for reuse.",
        "Acknowledge the selection briefly.",
        "Do NOT show targeting_picker, format_choice, image_choice, or video_choice.",
        "Do NOT queue create_meta_* or scrape services.",
        "Ask in one short sentence what they want to do with it next, then wait. No menu of options.",
      ].join("\n"),
    );
  }

  if (intent === "optimize" && accountId) {
    await input.onProgress?.({
      phase: "optimize",
      label: "Building optimize proposals…",
      stepId: "optimize",
    });
    try {
      const optimizeBrief = input.brief ?? rulesBrief(input.request, input.history ?? []);
      const { getClient } = await import("@/lib/approvals/service");
      const built = await buildOptimizeEvidence({
        provider,
        accountId,
        brief: optimizeBrief,
        currency: await getClient(input.clientId).then((c) => c.currency).catch(() => null),
        goals: await turnGoals(),
      });
      sections.push(...built.sections);
      toolCalls.push(...built.toolsRun);
      offered = built.offered;
      scopeEntityIds = built.scopeEntityIds;
      entityIndex = built.entityIndex;
      inventory = built.inventory;
      optimizeAppendix = built.appendix || undefined;

      // The ad picker is only for a creative refresh where the operator hasn't said which ad.
      if (
        optimizeBrief.focus.includes("creative") &&
        !optimizeBrief.queue.requested &&
        !built.adNamed &&
        built.ads.length
      ) {
        adPicker = {
          ads: built.ads.slice(0, 40).map((a) => ({
            id: a.id,
            name: a.name,
            status: a.status,
            creative_summary: a.creative_summary,
            adset_id: a.adset_id,
            campaign_id: a.campaign_id,
          })),
        };
        sections.push(
          [
            "### Ads inventory",
            ...built.ads.slice(0, 40).map(
              (a) => `- ${a.id} · ${a.name} · ${a.status}${a.creative_summary ? ` — ${a.creative_summary}` : ""}`,
            ),
            "",
            "Ad picker only if they still need to pick an ad for creative refresh.",
          ].join("\n"),
        );
      }
    } catch (error) {
      sections.push(
        `### Optimize\n- Failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else if (intent === "optimize" && !accountId) {
    sections.push(
      "### Optimize\n- No mapped Meta account. Connect Facebook, sync/map an ad account under Connections, then retry.",
    );
  }

  return {
    accountId,
    evidence: sections.join("\n\n"),
    toolCalls,
    offered,
    scopeEntityIds,
    entityIndex,
    inventory,
    optimizeAppendix,
    copyPicker,
    adPicker,
    imageChoice,
    formatChoice,
    videoChoice,
    targetingPicker,
    auditBriefingIncomplete,
    auditAppendix,
    strategyBriefIncomplete,
    strategyPlanBuilt,
  };
}

/** Factory for Mastra Agent instance (for advanced wiring). */
export async function createAdspirerMastraAgent(clientContext: string) {
  const config = getConfig();
  if (!config.hasAnthropic || !config.ANTHROPIC_API_KEY) {
    return null;
  }
  const { Agent } = await import("@mastra/core/agent");
  const { createAnthropic } = await import("@ai-sdk/anthropic");
  const anthropic = createAnthropic({ apiKey: config.ANTHROPIC_API_KEY });

  return new Agent({
    id: "adspirer-agent",
    name: "CampaignForge Agent",
    instructions: activeSystemPrompt(clientContext),
    model: anthropic(config.ANTHROPIC_MODEL),
  });
}
