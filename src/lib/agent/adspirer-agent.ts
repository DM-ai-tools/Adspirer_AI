import type { LanguageModel } from "ai";
import type { Task } from "@/types";
import { getConfig } from "@/lib/config";
import { getLiveAdspirerProvider, getProvider, resolveProvider } from "@/lib/adspirer/client";
import type {
  MetaAdsProvider,
  MetaAdCreative,
  MetaCampaign,
  MetaInsights,
} from "@/lib/adspirer/provider";
import { getDemoStore } from "@/lib/demo/store";
import { buildSystemPrompt } from "@/lib/agent/prompts";
import { buildSystemPromptV2 } from "@/lib/agent/prompts-v2";
import type { AgentHistoryMessage } from "@/lib/agent/history";
import { detectRequestIntent, detectRequestIntentWithHistory, mentionsCreativeGeneration } from "@/lib/agent/task-plan";
import {
  wantsQueueApprovals,
} from "@/lib/agent/optimize-queue";
import { buildFullOptimizeProposals } from "@/lib/agent/optimize-proposals";
import {
  buildAuditClarifyingQuestion,
  matchCampaignsByHints,
  resolveAuditBrief,
  applyCompetitorUrlsFromDocuments,
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
import { getWorkspaceContext } from "@/lib/runtime/workspace-context";
import { resolvePrimaryAccountId } from "@/lib/adspirer/resolve-meta-account";

function activeSystemPrompt(clientContext: string): string {
  return getWorkspaceContext()?.version === "v2"
    ? buildSystemPromptV2(clientContext)
    : buildSystemPrompt(clientContext);
}

function isWorkspaceV2(): boolean {
  return getWorkspaceContext()?.version === "v2";
}

/** V2 → OAuth Meta Graph; V1 → Adspirer MCP when available, else mode provider. */
async function resolveAgentProvider(): Promise<MetaAdsProvider> {
  if (isWorkspaceV2()) {
    return resolveProvider("meta_direct");
  }
  return getLiveAdspirerProvider() ?? getProvider();
}

function noMappedAccountMessage(): string {
  return isWorkspaceV2()
    ? "No granted Meta account is mapped to this client. Connect Facebook, sync accounts under Connections, then Add as client / Map — and select that client in Workspace V2."
    : "No granted Meta account is mapped to this client. Map one under Connections (Adspirer).";
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
  correlationId?: string;
  onProgress?: (event: AgentProgressEvent) => void | Promise<void>;
}): Promise<AgentRunResult> {
  const config = getConfig();

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
    label: input.reportDraft
      ? "Formatting report for display…"
      : "Writing report from live results…",
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
  correlationId?: string;
  onProgress?: (event: AgentProgressEvent) => void | Promise<void>;
};

function buildWriterMessages(input: WriterInput): {
  system: string;
  messages: Array<{ role: "assistant" | "user" | "system"; content: string }>;
} {
  const intent = detectRequestIntentWithHistory(
    input.task.goal ?? input.task.title,
    input.history ?? [],
  );
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
          "- If competitor LPs were not provided, finish the own-LP audit and optionally invite them to paste competitor URLs later.",
          "- End by inviting the operator to ask to optimize a specific campaign, ad copy, or landing page when ready.",
        ]
      : intent === "audit"
        ? [
            "- This is an audit request: clarify scope (account vs campaigns) and date range if missing, otherwise audit from evidence.",
            "- Landing page analysis of Meta destinations is part of the initial audit — do not defer it.",
            "- Recommendations only — wait for an explicit optimize ask before mutations.",
          ]
        : [];

  const optimizeRules =
    intent === "optimize"
      ? [
          "- Operator asked to optimize (or queue optimizations for Approvals).",
          "- ONLY mark items as Ready to queue if they appear in Ready-to-queue EXECUTE proposals JSON.",
          "- Typical queueable tools: update_adset_budget, resume_campaign, pause_ad, create_adset (broad/Advantage+).",
          "- Creative refresh / Pixel verification stay waiting until the operator provides image / Pixel ID — never claim those were queued.",
          "- When queuing: do NOT show ad_picker. Confirm separate Approvals cards for each tool.",
          "- NEVER invent a 'known limitation' that tool calls did not fire.",
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
    : [
        `Operator request: ${input.task.goal ?? input.task.title}`,
        `Detected intent: ${intent}`,
        accountHint ? `Primary Meta account_id: ${accountHint}` : "",
        "",
        "## Live tool evidence (already fetched — use this; do NOT say you are still fetching)",
        evidence,
        "",
        "Write the final operator-facing answer NOW using the evidence above.",
        "Rules:",
        "- Reply in natural language + light markdown (headings, bullets). Sound like a normal chat assistant.",
        "- NEVER make the entire reply a JSON object/array or a wrapper like {\"message\":...}.",
        "- JSON is only an optional appendix at the very end for tool proposals or service_picker.",
        "- Never say \"fetching data\", \"stand by\", or \"results incoming\".",
        "- Prefer concrete findings, tables, and recommendations from the evidence.",
        "- If evidence is thin/failed, say exactly what failed and what the operator should check (Adspirer connection / Meta account mapping).",
        "- If proposing execute change(s), explain in prose first, then append one JSON block per tool at the end:",
        '```json\n{"tool":"create_meta_image_campaign"|"create_meta_video_campaign","args":{...},"rationale":"..."}\n```',
        "- For scrape/services: list services in prose, then append service_picker JSON at the end (not instead of prose).",
        "- When you queue Approvals, include a clear What's next checklist so the operator knows the workflow is paused for human review — not stuck.",
        "- Mention Approvals portal when proposing execute actions. Never claim Meta mutations applied yet.",
        "- If they asked for Word/PDF export, deliver a complete markdown report and tell them to use Export Word / Export PDF under the message.",
        ...auditRules,
        ...optimizeRules,
      ]
        .filter(Boolean)
        .join("\n");

  return {
    system: activeSystemPrompt(input.clientContext),
    messages: [
      ...(input.history ?? []).map((m) => ({
        role: m.role,
        content: m.content,
      })),
      { role: "user" as const, content: userTurn },
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
  const { system, messages } = buildWriterMessages(input);

  const evidence = input.toolEvidence ?? "";
  const auditToolsEnabled = evidence.includes("### Diagnose tools");

  let tools: Awaited<ReturnType<typeof import("./diagnose-tools-ai").buildAuditDiagnoseToolSet>> | undefined;
  if (auditToolsEnabled) {
    const { buildAuditDiagnoseToolSet } = await import(
      "@/lib/agent/diagnose-tools-ai"
    );
    tools = buildAuditDiagnoseToolSet({
      clientId: input.task.client_id,
      userId: input.task.created_by,
      taskId: input.task.id,
      conversationId: input.task.conversation_id,
      correlationId: input.correlationId,
    });
  }

  // `textStream` only forwards text deltas — it drops error parts and ends
  // cleanly, so a failed call would otherwise look like an empty success and get
  // reported as "Done". Capture the error here and rethrow it after the loop.
  let streamError: unknown = null;
  const result = streamText({
    model,
    system,
    messages,
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

  let text = "";
  for await (const delta of result.textStream) {
    text += delta;
    const preview = liveReplyPreview(text);
    await input.onProgress?.({
      phase: "write_report",
      label: input.reportDraft ? "Formatting report…" : "Writing report…",
      stepId: "write_report",
      delta,
      summary: preview,
    });
  }

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
    label: "Writing report…",
    stepId: "write_report",
    summary: display,
    delta: "",
  });

  return {
    summary: display,
    messages: [{ role: "assistant", content: display }],
    toolCalls: input.reportDraft ? [] : humanized.toolCalls,
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
        },
    report: input.reportDraft
      ? {
          title: input.reportTitle ?? "Meta Ops session report",
          data: input.reportData,
        }
      : undefined,
  };
}

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
  correlationId?: string;
  onProgress?: (event: AgentProgressEvent) => void | Promise<void>;
}): Promise<AgentRunResult> {
  await input.onProgress?.({
    phase: "write_report",
    label: input.reportDraft ? "Formatting report…" : "Preparing summary…",
    stepId: "write_report",
  });

  const intent = detectRequestIntent(input.task.goal ?? input.task.title);
  const evidence = input.toolEvidence?.trim();

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
      "I'm scoped to **Meta Ads operations** for the selected client — audits, delivery, budgets, and approval-gated changes.",
      "",
      "Try: “Audit this account”, “List campaigns”, or “Propose a budget increase”.",
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
      "I can create a **PAUSED** Meta image or video campaign on the connected account via Adspirer.",
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
          "Pick an ad below (or reply with the ad id), then I’ll run Adspirer optimize tools.",
        ].join("\n")
      : (evidence ?? "No ads found to optimize yet.");
    if (humanized?.adPicker?.ads?.length) {
      ui = { adPicker: humanized.adPicker };
    }
  } else {
    const humanized = evidence
      ? humanizeAgentReply(evidence)
      : null;
    summary = humanized?.display
      ? [
          humanized.display,
          "",
          "Use **Export Word** / **Export PDF** under this message if you need a file.",
          "If you want an execute change (budget/pause/create campaign), ask me to propose it for Approvals.",
        ].join("\n")
      : [
          "### Meta Ads report",
          "I couldn't gather live Meta data for this client yet.",
          "Check Adspirer Connection → synced Meta accounts are mapped to this client, then ask again to audit.",
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

function formatInsightMetrics(i: MetaInsights): string {
  const parts = [
    `spend $${i.spend.toFixed(2)}`,
    `${i.impressions.toLocaleString()} imps`,
    `${i.clicks.toLocaleString()} clicks`,
    `CTR ${i.ctr.toFixed(2)}%`,
    `CPC $${i.cpc.toFixed(2)}`,
  ];
  if (i.reach != null) parts.push(`reach ${i.reach.toLocaleString()}`);
  if (i.frequency != null) parts.push(`freq ${i.frequency.toFixed(2)}`);
  if (i.conversions != null) parts.push(`conv ${i.conversions}`);
  if (i.cost_per_conversion != null) {
    parts.push(`CPA $${i.cost_per_conversion.toFixed(2)}`);
  }
  return parts.join(" · ");
}

/** Collect live Meta evidence before the LLM writes the report. */
export async function gatherDiagnoseEvidence(input: {
  clientId: string;
  request: string;
  conversationId?: string | null;
  history?: AgentHistoryMessage[];
  /** Pre-resolved intent (supports audit brief follow-ups). */
  intent?: ReturnType<typeof detectRequestIntent>;
  onProgress?: (event: AgentProgressEvent) => void | Promise<void>;
}): Promise<{
  accountId: string | null;
  evidence: string;
  toolCalls: AgentToolCallProposal[];
  /** Concrete execute tools ready to queue when the operator asks for Approvals. */
  executeProposals?: AgentToolCallProposal[];
  copyPicker?: CopyPickerUi;
  adPicker?: AdPickerUi;
  imageChoice?: ImageChoiceUi;
  formatChoice?: FormatChoiceUi;
  videoChoice?: VideoChoiceUi;
  targetingPicker?: TargetingPickerUi;
  /** True when audit needs scope/dates/campaigns before full analysis. */
  auditBriefingIncomplete?: boolean;
}> {
  const intent = input.intent ?? detectRequestIntent(input.request);
  const accountId = await resolvePrimaryAccountId(input.clientId);
  const toolCalls: AgentToolCallProposal[] = [];
  const executeProposals: AgentToolCallProposal[] = [];
  const sections: string[] = [];
  let copyPicker: CopyPickerUi | undefined;
  let adPicker: AdPickerUi | undefined;
  let imageChoice: ImageChoiceUi | undefined;
  let formatChoice: FormatChoiceUi | undefined;
  let videoChoice: VideoChoiceUi | undefined;
  let targetingPicker: TargetingPickerUi | undefined;
  let auditBriefingIncomplete = false;

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

  if (
    !accountId &&
    intent !== "ad_copy" &&
    intent !== "generate_creatives" &&
    intent !== "scrape_services" &&
    intent !== "optimize" &&
    intent !== "copy_approved"
  ) {
    return {
      accountId: null,
      evidence: noMappedAccountMessage(),
      toolCalls,
    };
  }

  let provider: MetaAdsProvider;
  try {
    provider = await resolveAgentProvider();
  } catch (error) {
    return {
      accountId,
      evidence: `### Provider\n- Failed to resolve Meta access: ${
        error instanceof Error ? error.message : String(error)
      }${
        isWorkspaceV2()
          ? "\n- Connect Facebook OAuth in Workspace V2 / Connections, then retry."
          : ""
      }`,
      toolCalls,
    };
  }

  if (intent === "out_of_scope") {
    return { accountId, evidence: "Request appears out of Meta Ads scope.", toolCalls };
  }

  if (accountId) {
    await input.onProgress?.({
      phase: "fetch_overview",
      label: "Fetching account overview…",
      stepId: "fetch_overview",
    });
    try {
      const overview = await provider.getAccountOverview(accountId);
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

  if (
    accountId &&
    (intent === "audit" ||
      intent === "list_campaigns" ||
      intent === "budget" ||
      intent === "general" ||
      intent === "export")
  ) {
    await input.onProgress?.({
      phase: "list_campaigns",
      label: "Listing Meta campaigns…",
      stepId: "list_campaigns",
    });
    try {
      const campaigns = await provider.listCampaigns(accountId);
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
              ? ` · daily $${(c.daily_budget_cents / 100).toFixed(0)}`
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
          const docs = await loadDocumentsForContext({
            clientId: input.clientId,
            conversationId: input.conversationId,
          });
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
          matchedCampaigns = matchCampaignsByHints(campaigns, brief.campaignHints);
          if (brief.campaignHints.length && matchedCampaigns.length === 0) {
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
              `- Campaign hints: ${brief.campaignHints.join(", ") || "(none)"}`,
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
              `- Competitor LPs: ${
                brief.competitorLanding === "skip"
                  ? "skipped"
                  : `${brief.competitorUrls.length} URL(s) provided`
              }`,
            ]
              .filter(Boolean)
              .join("\n"),
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
                `### Account spend (${dateLabel})\n- ${formatInsightMetrics(accountInsights)}`,
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
              : campaigns
                  .filter((c) => c.status === "ACTIVE" || c.status === "PAUSED")
                  .slice(0, 20);

          const insightLines: string[] = [];
          let totalSpend = 0;
          for (const c of insightTargets) {
            try {
              const row = await provider.getCampaignInsights(
                accountId,
                c.id,
                dateStart,
                dateStop,
              );
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
                `- ${c.name} (${c.id}) · ${c.status} · ${c.objective} · ${formatInsightMetrics(row)}`,
              );
            } catch (error) {
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
              `- Sum of listed campaign spend: $${totalSpend.toFixed(2)}`,
              "",
              ...insightLines,
            ].join("\n"),
          );

          // Light ad sample for creative pillar (LLM can deepen via tools)
          try {
            const ads = await provider.listAds(accountId);
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
            let creatives: MetaAdCreative[] = [];

            if (provider.getAdCreatives) {
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
                creatives = [...byAd.values()];
              } else {
                creatives = await provider.getAdCreatives(accountId, {
                  limit: 50,
                });
              }
            }

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
              const cta = c.call_to_action_type?.trim() || "UNKNOWN";
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
              } · ${c.creative_type ?? "creative"} · CTA: \`${cta}\` · Website URL: ${
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
              const ctas = [...new Set(row.ctaTypes)].join(", ") || "n/a";
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
              "- Produce the full audit in chat using the checklist required sections.",
              "- Quantify spend and call out what is working vs what needs improvement.",
              "- **REQUIRED section: Landing pages** — use Website URLs + CTA types from “Ad CTA & destination inventory” and scores from “Landing page analysis”.",
              "- NEVER say destinations are unavailable because the campaign is paused or had $0 spend.",
              "- NEVER use workspace-document URLs (e.g. competitor copy docs) as the campaign destination.",
              "- If a destination URL is missing from Meta, say so and recommend fixing the CTA / Website URL in Ads Manager.",
              "- Include prioritized recommendations covering both ads/budgets AND landing pages.",
              "- Do NOT queue execute/optimize tools and do NOT claim you changed Meta.",
              "- End by inviting the operator to say which campaign, ad copy, or landing page to optimize when they are ready.",
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
                "",
                "### Supplemental recommended actions",
                ...analysis.recommended_actions.map((r) => `- ${r}`),
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

  if (
    accountId &&
    intent !== "audit" &&
    (intent === "budget" || intent === "general" || intent === "export")
  ) {
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
          "",
          "### Recommended actions",
          ...analysis.recommended_actions.map((r) => `- ${r}`),
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

  // Follow-up asks like "what's the landing page URL?" are not audit intent, so
  // fetch Meta destinations here too — otherwise the writer answers from chat
  // history and repeats an earlier wrong URL.
  const asksAboutLandingPage =
    /\b(landing\s*page|destination\s*url|website\s*url|lp\s*url|destination\s*link)\b/i.test(
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
            } · CTA \`${c.call_to_action_type ?? "UNKNOWN"}\` · Website URL: ${
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
        const { loadDocumentsForContext } = await import(
          "@/lib/documents/service"
        );
        const docs = await loadDocumentsForContext({
          clientId: input.clientId,
          conversationId: input.conversationId ?? null,
        });
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
            "Adspirer Ad Copy Writing Room skill — Meta variants grounded in live creatives when available",
        });
        if (accountId && generated.grounded_in_live_creatives) {
          toolCalls.push({
            name: "get_meta_ad_creatives",
            args: { account_id: accountId, lookback_days: 30 },
            rationale: "Grounded copy against live Meta creatives via Adspirer",
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
              ? `- Grounded in ${generated.live_creative_count} live Meta creative(s) via Adspirer get_meta_ad_creatives`
              : accountId
                ? "- No live creatives returned — wrote net-new angles"
                : "- No mapped Meta account — wrote from brief only (map account in Admin → Adspirer for live grounding)",
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
    const selected = await getSelectedCreativeDraftAsync(input.clientId, {
      conversationId: input.conversationId ?? null,
    });
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
    const wantsVideo = /\b(video|reel|reels|mp4|mov)\b/i.test(request);
    const wantsImage =
      /\b(image|still|static|jpg|png|jpeg)\b/i.test(request) && !wantsVideo;

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
        "Do NOT invent 'here are 3 variations' or dump image_choice JSON as the whole reply — stills attach as creative cards after generation.",
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
        "Suggest 2–3 optional next steps (create campaign, generate images, write script) and wait for their choice.",
      ].join("\n"),
    );
  }

  if (intent === "optimize" && accountId) {
    const queueNow = wantsQueueApprovals(input.request);
    await input.onProgress?.({
      phase: "optimize",
      label: "Building optimize proposals…",
      stepId: "optimize",
    });
    try {
      const ads = await provider.listAds(accountId);
      toolCalls.push({
        name: "list_ads",
        args: { account_id: accountId },
        rationale: "Ads inventory for optimize",
      });

      const known = ads.find((a) => input.request.includes(a.id));
      // Only show ad picker when the operator still needs to pick an ad for
      // creative-focused work — never after / during an Approvals queue turn.
      if (!queueNow && !known) {
        adPicker = {
          ads: ads.slice(0, 40).map((a) => ({
            id: a.id,
            name: a.name,
            status: a.status,
            creative_summary: a.creative_summary,
            adset_id: a.adset_id,
            campaign_id: a.campaign_id,
          })),
        };
      }

      sections.push(
        [
          "### Ads inventory",
          ...ads.slice(0, 40).map(
            (a) =>
              `- ${a.id} · ${a.name} · ${a.status}${
                a.creative_summary ? ` — ${a.creative_summary}` : ""
              }`,
          ),
          "",
          known
            ? `Operator focused ad: ${known.id} (${known.name}).`
            : queueNow
              ? "Approvals queue turn — do NOT show ad_picker UI."
              : "Ad picker only if they still need to pick an ad for creative refresh.",
          isWorkspaceV2()
            ? "V2: optimize from live Meta Graph evidence; EXECUTE mutations go through Approvals."
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );

      const bundle = await buildFullOptimizeProposals({
        provider,
        accountId,
      });
      // Also record diagnose tools for audit trail
      toolCalls.push(
        {
          name: "optimize_meta_budget",
          args: { account_id: accountId },
          rationale: "Budget optimize",
        },
        {
          name: "detect_meta_creative_fatigue",
          args: { account_id: accountId },
          rationale: "Creative fatigue",
        },
        {
          name: "optimize_meta_placements",
          args: { account_id: accountId },
          rationale: "Placement optimize",
        },
      );

      executeProposals.push(...bundle.proposals);

      sections.push(
        [
          "### Queueable optimizations (ONLY these may be marked Ready to queue)",
          ...(bundle.queueableLines.length
            ? bundle.queueableLines
            : ["- (none — live Meta data did not yield concrete mutate args)"]),
          "",
          "### Needs operator input (NOT Ready to queue — do not claim Approvals will show these)",
          ...bundle.blockedLines,
        ].join("\n"),
      );

      if (executeProposals.length) {
        sections.push(
          [
            "### Ready-to-queue EXECUTE proposals (structured)",
            "Use these exact tool payloads. Do not invent different tools or IDs.",
            "```json",
            JSON.stringify(
              executeProposals.map((p) => ({
                tool: p.name,
                args: p.args,
                rationale: p.rationale,
              })),
              null,
              2,
            ),
            "```",
            queueNow
              ? "Operator asked to send/queue for Approvals — the system will queue EVERY proposal above as separate Approvals items. Confirm in prose. Do NOT show ad_picker. Do NOT invent Reactivate/Advantage+/broad-ad-set rows that are not in this JSON."
              : "Present only these as Ready to queue. Ask if they want them sent to Approvals. Creative refresh / Pixel stay waiting.",
          ].join("\n"),
        );
      } else {
        sections.push(
          [
            "### Ready-to-queue EXECUTE proposals",
            "- No concrete execute mutations yet. Do not invent a fake Approvals queue or a 'known limitation'.",
          ].join("\n"),
        );
      }

      sections.push(
        [
          "### Operator next steps",
          queueNow
            ? "Confirm each queued tool appears under Approvals (separate cards). Nothing is live until executed."
            : "Summarize queueable vs blocked. If they ask to send for approval, queue only the structured EXECUTE tools.",
        ].join("\n"),
      );
    } catch (error) {
      sections.push(
        `### Optimize\n- Failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  } else if (intent === "optimize" && !accountId) {
    sections.push(
      isWorkspaceV2()
        ? "### Optimize\n- No mapped Meta account. Connect Facebook, sync/map an ad account under Connections, then retry."
        : "### Optimize\n- No mapped Meta account. Connect Adspirer and map an account first.",
    );
  }

  return {
    accountId,
    evidence: sections.join("\n\n"),
    toolCalls,
    executeProposals: executeProposals.length ? executeProposals : undefined,
    copyPicker,
    adPicker,
    imageChoice,
    formatChoice,
    videoChoice,
    targetingPicker,
    auditBriefingIncomplete,
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
    name: "Adspirer Agent",
    instructions: activeSystemPrompt(clientContext),
    model: anthropic(config.ANTHROPIC_MODEL),
  });
}
