import type { LanguageModel } from "ai";
import type { Task } from "@/types";
import { getConfig } from "@/lib/config";
import { getLiveAdspirerProvider, getProvider } from "@/lib/adspirer/client";
import { getDemoStore } from "@/lib/demo/store";
import { buildSystemPrompt } from "@/lib/agent/prompts";
import type { AgentHistoryMessage } from "@/lib/agent/history";
import { detectRequestIntent, mentionsCreativeGeneration } from "@/lib/agent/task-plan";
import {
  GENERIC_FALLBACK_REPLY,
  humanizeAgentReply,
  stripMachineJson,
} from "@/lib/agent/reply-format";
import { logger } from "@/lib/observability/logger";

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
  headline?: string;
  primary_text?: string;
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
  };
};

export async function runAdspirerAgent(input: {
  task: Task;
  clientContext: string;
  toolEvidence?: string;
  reportDraft?: string;
  reportTitle?: string;
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
  history?: AgentHistoryMessage[];
  correlationId?: string;
  onProgress?: (event: AgentProgressEvent) => void | Promise<void>;
};

function buildWriterMessages(input: WriterInput): {
  system: string;
  messages: Array<{ role: "assistant" | "user" | "system"; content: string }>;
} {
  const intent = detectRequestIntent(input.task.goal ?? input.task.title);
  const evidence = input.toolEvidence?.trim() || "(no live tool evidence yet)";
  const accountHint =
    evidence.match(/ID:\s*(act_[^\s]+)/)?.[1] ??
    evidence.match(/account_id["']?\s*[:=]\s*["']?(act_[^\s"']+)/i)?.[1];

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
      ]
        .filter(Boolean)
        .join("\n");

  return {
    system: buildSystemPrompt(input.clientContext),
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
  const { streamText } = await import("ai");
  const { system, messages } = buildWriterMessages(input);

  // `textStream` only forwards text deltas — it drops error parts and ends
  // cleanly, so a failed call would otherwise look like an empty success and get
  // reported as "Done". Capture the error here and rethrow it after the loop.
  let streamError: unknown = null;
  const result = streamText({
    model,
    system,
    messages,
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
      ? { title: input.reportTitle ?? "Meta Ops session report" }
      : undefined,
  };
}

function liveReplyPreview(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith("```json")) {
    // Don't stream raw JSON into the bubble — wait for humanized final text
    return "Writing reply…";
  }
  const stripped = stripMachineJson(text);
  if (stripped === GENERIC_FALLBACK_REPLY || stripped.length < 8) {
    return "Writing reply…";
  }
  if (stripped.length >= 24) return stripped;
  if (stripped.includes("?")) return stripped;
  return text.length > 0 ? text : "Writing reply…";
}

async function runMockAgent(input: {
  task: Task;
  clientContext: string;
  toolEvidence?: string;
  reportDraft?: string;
  reportTitle?: string;
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
      report: { title: input.reportTitle ?? "Meta Ops session report" },
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
        `I drafted **${copies.length} Meta ad copy variants**. Pick one below to queue via Approvals.`,
        "",
        ...copies.map(
          (c) =>
            `**${c.id} · ${c.angle}**\n- Headline: ${c.headline}\n- Primary: ${c.primary_text}`,
        ),
        "",
        "After you approve a variant I’ll ask only for missing campaign fields, then queue create tools (PAUSED).",
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

export async function resolvePrimaryAccountId(
  clientId: string,
): Promise<string | null> {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    const account = getDemoStore().connectedMetaAccounts.find(
      (a) => a.client_id === clientId && a.access_status === "granted",
    );
    return account?.meta_account_id ?? null;
  }
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("connected_meta_accounts")
    .select("external_account_id")
    .eq("mapped_client_id", clientId)
    .eq("access_status", "granted")
    .limit(1)
    .maybeSingle();
  return (data?.external_account_id as string | undefined) ?? null;
}

/** Collect live Meta evidence before the LLM writes the report. */
export async function gatherDiagnoseEvidence(input: {
  clientId: string;
  request: string;
  conversationId?: string | null;
  onProgress?: (event: AgentProgressEvent) => void | Promise<void>;
}): Promise<{
  accountId: string | null;
  evidence: string;
  toolCalls: AgentToolCallProposal[];
  copyPicker?: CopyPickerUi;
  adPicker?: AdPickerUi;
  imageChoice?: ImageChoiceUi;
  formatChoice?: FormatChoiceUi;
  videoChoice?: VideoChoiceUi;
}> {
  const intent = detectRequestIntent(input.request);
  const accountId = await resolvePrimaryAccountId(input.clientId);
  const toolCalls: AgentToolCallProposal[] = [];
  const sections: string[] = [];
  let copyPicker: CopyPickerUi | undefined;
  let adPicker: AdPickerUi | undefined;
  let imageChoice: ImageChoiceUi | undefined;
  let formatChoice: FormatChoiceUi | undefined;
  let videoChoice: VideoChoiceUi | undefined;

  if (
    !accountId &&
    intent !== "ad_copy" &&
    intent !== "scrape_services" &&
    intent !== "optimize"
  ) {
    return {
      accountId: null,
      evidence:
        "No granted Meta account is mapped to this client. Map one under Adspirer Connection.",
      toolCalls,
    };
  }

  const provider = getLiveAdspirerProvider() ?? getProvider();

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
        sections.push("### Campaigns\n- No campaigns returned from Adspirer.");
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
    (intent === "audit" ||
      intent === "budget" ||
      intent === "general" ||
      intent === "export")
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

  const scrapeUrl = extractUrlFromText(input.request);
  const shouldScrape =
    Boolean(scrapeUrl) &&
    (intent === "scrape_services" ||
      intent === "create_campaign" ||
      /\b(scrape|services?|website|landing)\b/i.test(input.request));

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

      const hasEnough =
        Boolean(brief.offer && brief.audience) &&
        (/\b(offer|audience|landing|for |targeting|generate|write|draft|copy)\b/i.test(
          input.request,
        ) ||
          Boolean(brief.landing_page_url) ||
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
            `- Framework: Adspirer Ad Copy Writing Room (${generated.framework_url})`,
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
            "Ask which variant to use, then queue create_meta_image_campaign, create_meta_video_campaign, or create_ad via Approvals using that copy (PAUSED). Adspirer applies the create — do not invent Graph API calls.",
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
      sections.push(
        [
          "### Advanced targeting (after brief, before creative)",
          "Offer custom audiences + detailed targeting pickers (names, not raw IDs).",
          `Append: {"ui":"targeting_picker","account_id":"${accountId}"}`,
          "Operator can skip. On confirm, pass custom_audiences / interests / behaviors / locations into create args.",
        ].join("\n"),
      );
    }
  }

  if (intent === "optimize" && accountId) {
    await input.onProgress?.({
      phase: "list_ads",
      label: "Listing Meta ads…",
      stepId: "list_ads",
    });
    try {
      const ads = await provider.listAds(accountId);
      toolCalls.push({
        name: "list_ads",
        args: { account_id: accountId },
        rationale: "Ads for optimize picker",
      });
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
          "Present ad_picker UI. Wait for operator to pick an ad before deeper optimize calls.",
        ].join("\n"),
      );

      const known = ads.find((a) => input.request.includes(a.id));

      if (
        known ||
        /\b(run optimize|optimize selected|after pick)\b/i.test(input.request)
      ) {
        const adId = known?.id;
        await input.onProgress?.({
          phase: "optimize",
          label: "Running Adspirer optimize tools…",
          stepId: "optimize",
        });
        if (provider.detectCreativeFatigue) {
          const fatigue = await provider.detectCreativeFatigue(accountId);
          toolCalls.push({
            name: "detect_meta_creative_fatigue",
            args: { account_id: accountId },
            rationale: "Creative fatigue",
          });
          sections.push(
            `### Creative fatigue\n${fatigue.text}${
              adId ? `\n\nFocus ad: ${adId} (${known?.name ?? ""})` : ""
            }`,
          );
        }
        if (provider.optimizeBudget) {
          const budget = await provider.optimizeBudget(accountId);
          toolCalls.push({
            name: "optimize_meta_budget",
            args: { account_id: accountId },
            rationale: "Budget optimize",
          });
          sections.push(`### Budget optimize\n${budget.text}`);
        }
        if (provider.optimizePlacements) {
          const placements = await provider.optimizePlacements(accountId);
          toolCalls.push({
            name: "optimize_meta_placements",
            args: { account_id: accountId },
            rationale: "Placement optimize",
          });
          sections.push(`### Placement optimize\n${placements.text}`);
        }
        sections.push(
          [
            "### Operator next steps",
            adId
              ? `Selected ad ${adId}: summarize Adspirer recommendations and queue any EXECUTE changes via Approvals.`
              : "After they pick an ad, re-run optimize focused on that ad.",
            "For creative refresh: open Creatives, generate from copy, Use for campaign, then queue create_ad with new image_url (PAUSED).",
          ].join("\n"),
        );
      }
    } catch (error) {
      sections.push(
        `### Optimize\n- Failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  } else if (intent === "optimize" && !accountId) {
    sections.push(
      "### Optimize\n- No mapped Meta account. Connect Adspirer and map an account first.",
    );
  }

  return {
    accountId,
    evidence: sections.join("\n\n"),
    toolCalls,
    copyPicker,
    adPicker,
    imageChoice,
    formatChoice,
    videoChoice,
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
    instructions: buildSystemPrompt(clientContext),
    model: anthropic(config.ANTHROPIC_MODEL),
  });
}
