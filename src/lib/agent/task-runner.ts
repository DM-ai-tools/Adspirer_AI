import { nanoid } from "nanoid";
import type { Approval, Task, TaskStatus, ToolCall } from "@/types";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { AgentPausedError } from "@/lib/errors";
import { classify } from "@/lib/tools/policy";
import "@/lib/tools"; // ensure tools registered
import { createPendingApproval } from "@/lib/approvals/service";
import { estimateMetaBudgetImpactCents } from "@/lib/meta/normalize-approval-args";
import {
  runAdspirerAgent,
  gatherDiagnoseEvidence,
  type AgentProgressEvent,
  type AgentRunResult,
} from "@/lib/agent/adspirer-agent";
import {
  describeInteractivePayloads,
  GENERIC_FALLBACK_REPLY,
} from "@/lib/agent/reply-format";
import { buildClientContext } from "@/lib/agent/context-builder";
import { loadConversationHistory } from "@/lib/agent/history";
import {
  buildContextResearch,
  captureTaskLearning,
  saveLearning,
} from "@/lib/agent/learning";
import { generateConversationReport } from "@/lib/agent/report-generator";
import {
  activateStep,
  completeStepsThrough,
  failStep,
  detectRequestIntent,
  holdStepsForOperator,
  markRemainingSkipped,
  mentionsCreativeGeneration,
  planTaskSteps,
  setStepState,
  type TaskStep,
} from "@/lib/agent/task-plan";
import { nowIso } from "@/lib/utils";
import { logger, newCorrelationId } from "@/lib/observability/logger";
import { startCreativeGeneration } from "@/lib/creatives/service";
import { runAfterResponse } from "@/lib/api/background";
import {
  getSelectedCreativeDraftAsync,
  listCreativeDraftsAsync,
  resolveImageUrlForAdspirer,
  toPublicDraft,
} from "@/lib/creatives/drafts";
import {
  APPROVAL_PORTAL_CTA,
  mapTaskRow,
  newEntityId,
  toTaskUpsert,
  toToolCallInsert,
} from "@/lib/db/live-maps";

export type TaskProgressHandler = (
  event: AgentProgressEvent & { task: Task },
) => void | Promise<void>;

function stripFalseQueuedClaims(summary: string): string {
  return summary
    .replace(/\bqueued in Approvals\b/gi, "not yet queued")
    .replace(/### What's next[\s\S]*?(?=\n##|\n\*\*|$)/i, "")
    .trim();
}

/** Variants produced per inline creative request. */
const CREATIVE_VARIANT_COUNT = 3;

/**
 * Keep the reply honest on turns where no batch was started: rewrite prose that
 * claims stills are already rendering. Questions survive untouched — the image
 * picker's "should I generate creatives?" is an offer, not a claim.
 */
function stripUnstartedGenerationClaims(summary: string): string {
  const claim =
    /\b(?:generating|rendering|producing|creating)\b[^.\n]{0,60}\b(?:images?|stills?|visuals?|creatives?|variations?)\b/i;
  let changed = false;

  const lines = summary.split("\n").map((line) => {
    if (line.includes("?") || !claim.test(line)) return line;
    changed = true;
    return /\bstage\b/i.test(line)
      ? line
          .replace(claim, "waiting on your image choice")
          .replace(/\s+now(?=[\s.…]*$)/i, "")
      : null;
  });

  if (!changed) return summary;

  return [
    ...lines.filter((line): line is string => line !== null),
    "",
    "No stills are rendering yet — choose an option below (or paste an image URL) and I'll start them.",
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The reply text is written before preflight pickers are attached, so a turn that
 * ends up showing the image-choice buttons could still sign off with the generic
 * "Done — let me know what you'd like next." Describe what is on screen instead.
 */
function describeAttachedUi(
  summary: string,
  ui: AgentRunResult["ui"],
): string {
  const trimmed = summary.trim();
  if (trimmed && trimmed !== GENERIC_FALLBACK_REPLY) return summary;
  return describeInteractivePayloads(ui ?? {}) ?? summary;
}

/** Is the turn parked on something the operator has to answer or pick? */
function awaitsOperator(result: AgentRunResult): boolean {
  const ui = result.ui;
  return Boolean(
    ui?.formatChoice ||
      ui?.targetingPicker ||
      ui?.videoChoice ||
      ui?.imageChoice ||
      ui?.copyPicker?.copies?.length ||
      ui?.adPicker?.ads?.length ||
      ui?.servicePicker?.services?.length ||
      ui?.creativePicker?.drafts?.length ||
      result.summary.includes("?"),
  );
}

/**
 * Generation now happens inline in the chat, so drop any leftover model prose
 * that tells the operator to open the Creatives page and copy an image_url.
 */
function stripCreativesHandoff(summary: string): string {
  return summary
    .split("\n")
    .filter((line) => {
      if (
        /\bcreatives\b/i.test(line) &&
        /\b(open|go to|head to|visit|navigate|sidebar)\b/i.test(line)
      ) {
        return false;
      }
      if (/paste\b[^\n]*\bimage_url\b/i.test(line)) return false;
      if (/\breturn (here|to this chat)\b/i.test(line)) return false;
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function appendApprovalCta(summary: string): string {
  const next = [
    "",
    "---",
    "### What's next",
    "1. Open **Approvals** and approve (or edit) the queued action(s).",
    "2. After execution, you’ll see proof IDs — entities stay **PAUSED** (not published).",
    "3. Reply here to continue the next stage (website scrape, ad sets, ads, etc.).",
  ].join("\n");
  if (summary.includes("What's next") || summary.includes("Approvals")) {
    return summary.includes("What's next") ? summary : `${summary.trim()}${next}`;
  }
  return `${summary.trim()}\n\n---\n${APPROVAL_PORTAL_CTA}${next}`;
}

export async function createTask(input: {
  clientId: string;
  createdBy: string;
  title: string;
  goal?: string | null;
  conversationId?: string | null;
}): Promise<Task> {
  const ts = nowIso();
  const config = getConfig();
  const task: Task = {
    id:
      config.isDemoMode || !config.hasSupabase
        ? `task_${nanoid(10)}`
        : newEntityId(),
    client_id: input.clientId,
    conversation_id: input.conversationId ?? null,
    created_by: input.createdBy,
    title: input.title,
    goal: input.goal ?? null,
    status: "queued",
    agent_state: {
      phase: "queued",
      steps: planTaskSteps(input.goal ?? input.title),
    },
    error_message: null,
    paused_at: null,
    completed_at: null,
    created_at: ts,
    updated_at: ts,
  };

  await saveTask(task);
  return task;
}

export async function runTask(
  taskId: string,
  options?: { onProgress?: TaskProgressHandler },
): Promise<Task> {
  const task = await getTask(taskId);
  if (task.status === "paused") {
    throw new AgentPausedError("Resume the task before running", {
      taskId,
    });
  }
  if (task.status === "cancelled") {
    throw new Error("Cannot run a cancelled task");
  }

  const correlationId = newCorrelationId();
  const log = logger.child({ correlationId, taskId, clientId: task.client_id });

  let steps: TaskStep[] = planTaskSteps(task.goal ?? task.title).map((s) =>
    s.id === "queued" ? { ...s, state: "done" } : s,
  );

  task.status = "running";
  task.agent_state = {
    ...(task.agent_state ?? {}),
    phase: "running",
    statusLabel: "Starting…",
    steps,
    correlationId,
  };
  task.updated_at = nowIso();
  await saveTask(task);
  await options?.onProgress?.({
    phase: "running",
    label: "Starting…",
    task,
  });

  const emit = async (event: AgentProgressEvent) => {
    if (event.stepId) {
      steps = activateStep(steps, event.stepId);
    }
    task.agent_state = {
      ...(task.agent_state ?? {}),
      phase: event.phase,
      statusLabel: event.label,
      steps,
      ...(event.summary != null ? { summary: event.summary } : {}),
      ...(event.ui != null ? { ui: event.ui } : {}),
    };
    task.updated_at = nowIso();
    if (
      event.delta == null ||
      (event.summary?.length ?? 0) % 240 < (event.delta?.length ?? 0)
    ) {
      await saveTask(task);
    }
    await options?.onProgress?.({ ...event, task });
  };

  try {
    await emit({
      phase: "research",
      label: "Researching prior context & learnings…",
      stepId: "research",
    });

    const [context, historyRaw, research] = await Promise.all([
      buildClientContext(task.client_id, {
        conversationId: task.conversation_id,
      }),
      loadConversationHistory(task.conversation_id),
      buildContextResearch({
        clientId: task.client_id,
        request: task.goal ?? task.title,
      }),
    ]);
    steps = completeStepsThrough(steps, "research");
    const history = historyRaw.filter((m) => {
      if (m.role === "assistant" && !m.content.trim()) return false;
      return true;
    });
    if (history.at(-1)?.role === "user") {
      history.pop();
    }

    // Fetch Meta evidence BEFORE writing the answer (fixes "fetching…" placeholders).
    const gathered = await gatherDiagnoseEvidence({
      clientId: task.client_id,
      request: task.goal ?? task.title,
      conversationId: task.conversation_id,
      onProgress: emit,
    });

    for (const call of gathered.toolCalls) {
      const safety = classify(call.name);
      const toolCall = await recordToolCall(task, call.name, safety, call.args);
      toolCall.completed_at = nowIso();
      toolCall.result = { queued_by: "preflight" };
      await saveToolCall(toolCall, task.client_id);
    }

    if (gathered.toolCalls.some((c) => c.name === "scrape_website_services")) {
      steps = completeStepsThrough(steps, "scrape_services");
      await saveLearning({
        clientId: task.client_id,
        source: "builder_stage_b",
        insight:
          "After campaign proof (or when a website URL is provided), scrape services and present a picker before creating ad sets/ads.",
        createdBy: task.created_by,
        evidence: { taskId: task.id, tools: gathered.toolCalls.map((c) => c.name) },
      });
    }

    const intent = detectRequestIntent(task.goal ?? task.title);
    const wantsInlineCreatives =
      intent === "generate_creatives" ||
      (intent === "create_campaign" &&
        mentionsCreativeGeneration(task.goal ?? task.title));

    let reportDraft: string | undefined;
    let reportTitle: string | undefined;

    if (intent === "export") {
      if (steps.some((s) => s.id === "gather")) {
        steps = completeStepsThrough(steps, "gather");
      }
      await emit({
        phase: "draft_report",
        label: "Drafting report with OpenAI…",
        stepId: "draft_report",
      });
      const generated = await generateConversationReport({
        request: task.goal ?? task.title,
        clientContext: `${context}\n\n${research}`,
        history,
        metaEvidence: gathered.evidence,
      });
      reportDraft = generated.markdown;
      reportTitle = generated.title;
      if (steps.some((s) => s.id === "draft_report")) {
        steps = completeStepsThrough(steps, "draft_report");
      }
      await saveLearning({
        clientId: task.client_id,
        source: "report_generated",
        insight: `Generated ${generated.source} session report titled "${generated.title}" from chat + Meta evidence.`,
        createdBy: task.created_by,
        evidence: { taskId: task.id, source: generated.source },
      });
    }

    const agentResult = await runAdspirerAgent({
      task,
      clientContext: `${context}\n\n${research}`,
      toolEvidence: gathered.evidence,
      reportDraft,
      reportTitle,
      history,
      correlationId,
      onProgress: emit,
    });

    // Prefer structured pickers from preflight evidence when the model forgets the appendix
    if (gathered.copyPicker?.copies?.length) {
      agentResult.ui = {
        ...(agentResult.ui ?? {}),
        copyPicker: agentResult.ui?.copyPicker ?? gathered.copyPicker,
      };
    }
    if (gathered.adPicker?.ads?.length) {
      agentResult.ui = {
        ...(agentResult.ui ?? {}),
        adPicker: agentResult.ui?.adPicker ?? gathered.adPicker,
      };
    }
    if (gathered.imageChoice && !wantsInlineCreatives && !gathered.formatChoice) {
      agentResult.ui = {
        ...(agentResult.ui ?? {}),
        imageChoice: agentResult.ui?.imageChoice ?? gathered.imageChoice,
      };
    }
    if (gathered.formatChoice && !gathered.imageChoice && !gathered.videoChoice) {
      agentResult.ui = {
        ...(agentResult.ui ?? {}),
        formatChoice: agentResult.ui?.formatChoice ?? gathered.formatChoice,
        // Format not chosen yet — don't show image/video asset pickers.
        imageChoice: undefined,
        videoChoice: undefined,
      };
    }
    if (gathered.videoChoice) {
      agentResult.ui = {
        ...(agentResult.ui ?? {}),
        videoChoice: agentResult.ui?.videoChoice ?? gathered.videoChoice,
        // Video path: don't also show the image generate picker.
        imageChoice: undefined,
        formatChoice: undefined,
      };
    }
    if (gathered.targetingPicker?.account_id) {
      agentResult.ui = {
        ...(agentResult.ui ?? {}),
        targetingPicker:
          agentResult.ui?.targetingPicker ?? gathered.targetingPicker,
      };
    }
    agentResult.summary = describeAttachedUi(
      agentResult.summary,
      agentResult.ui,
    );

    steps = completeStepsThrough(steps, "write_report");
    if (intent === "ad_copy") {
      if (gathered.copyPicker?.copies?.length) {
        steps = completeStepsThrough(steps, "generate_copy");
        if (steps.some((s) => s.id === "pick_copy")) {
          steps = activateStep(steps, "pick_copy");
        }
      } else if (steps.some((s) => s.id === "intake")) {
        steps = activateStep(steps, "intake");
      }
    }
    if (intent === "copy_approved") {
      if (gathered.targetingPicker?.account_id) {
        steps = completeStepsThrough(steps, "advanced_targeting");
        if (steps.some((s) => s.id === "advanced_targeting")) {
          steps = activateStep(steps, "advanced_targeting");
        }
      } else if (steps.some((s) => s.id === "creative_asset")) {
        steps = activateStep(steps, "creative_asset");
      }
    }
    if (intent === "optimize") {
      if (gathered.adPicker?.ads?.length) {
        steps = completeStepsThrough(steps, "list_ads");
        steps = activateStep(steps, "pick_ad");
      }
      if (
        gathered.evidence.includes("### Budget optimize") ||
        gathered.evidence.includes("### Creative fatigue")
      ) {
        steps = completeStepsThrough(steps, "optimize");
      }
    }
    if (intent === "create_campaign") {
      if (agentResult.toolCalls.some((c) => c.name.includes("create"))) {
        steps = completeStepsThrough(steps, "intake");
        if (steps.some((s) => s.id === "queue_create")) {
          steps = activateStep(steps, "queue_create");
        }
      } else if (steps.some((s) => s.id === "intake")) {
        steps = activateStep(steps, "intake");
      }
    }

    const shouldGenerateCreatives =
      wantsInlineCreatives &&
      Boolean(task.conversation_id) &&
      !agentResult.failure;

    if (shouldGenerateCreatives) {
      const conversationId = task.conversation_id!;
      steps = activateStep(steps, "generate_creatives");
      await emit({
        phase: "generating_creatives",
        label: "Analyzing brand & drafting concepts…",
        stepId: "generate_creatives",
        summary:
          "Pulling brand colours from your landing page and drafting creative concepts — GPT Image stills start right after.",
      });
      const urlMatch = (task.goal ?? task.title).match(/https?:\/\/[^\s)]+/i);
      try {
        // A follow-up message while stills are still rendering must not stack a
        // second batch on top — surface the running one instead.
        const inFlight = (
          await listCreativeDraftsAsync(task.client_id, {
            conversationId,
          })
        ).filter((d) => d.image_status === "generating");

        let cards: ReturnType<typeof toPublicDraft>[];
        let rendering: boolean;

        if (inFlight.length) {
          cards = inFlight.map(toPublicDraft);
          rendering = true;
        } else {
          const { result, runImages } = await startCreativeGeneration({
            clientId: task.client_id,
            conversationId,
            taskId: task.id,
            landingPageUrl:
              urlMatch?.[0] ?? agentResult.ui?.imageChoice?.landing_page_url,
            headline: agentResult.ui?.imageChoice?.headline,
            primaryText: agentResult.ui?.imageChoice?.primary_text,
            count: CREATIVE_VARIANT_COUNT,
            generateImages: true,
          });
          if (runImages) {
            runAfterResponse("chat-creative-images", runImages);
          }
          cards = result.concepts;
          rendering = Boolean(runImages);
          await emit({
            phase: "generating_creatives",
            label: rendering
              ? "Rendering creative stills…"
              : "Creative concepts ready",
            stepId: "generate_creatives",
            summary: rendering
              ? `Rendering ${cards.length} creative variation${cards.length === 1 ? "" : "s"} — they appear below as each still finishes.`
              : `Drafted ${cards.length} concept${cards.length === 1 ? "" : "s"}.`,
          });
        }

        // Offering "paste a URL or generate?" contradicts a batch that is
        // already rendering, and it was the button the operator kept clicking.
        const uiWithoutChoice = { ...(agentResult.ui ?? {}) };
        delete uiWithoutChoice.imageChoice;
        agentResult.ui = {
          ...uiWithoutChoice,
          creativePicker: {
            drafts: cards,
            status: rendering ? "generating" : "concepts_ready",
          },
        };

        const count = cards.length;
        agentResult.summary = [
          stripCreativesHandoff(agentResult.summary),
          "",
          rendering
            ? `Rendering ${count} creative variation${count === 1 ? "" : "s"} — same ad copy, different visual treatment. They fill in below as each still finishes (30–90s each). Generation runs on the server, so you can move to Creatives or Approvals and come back without losing it. Then pick one with **Use for campaign**, or **Rework** it.`
            : `Drafted ${count} creative concept${count === 1 ? "" : "s"}, but no stills were rendered because OpenAI image credentials are not configured.`,
        ].join("\n");
        steps = completeStepsThrough(steps, "generate_creatives");
        if (steps.some((s) => s.id === "pick_creative")) {
          steps = activateStep(steps, "pick_creative");
        }
        await emit({
          phase: "generating_creatives",
          label: rendering
            ? "Rendering creative stills…"
            : "Creative concepts ready",
          stepId: "generate_creatives",
          summary: agentResult.summary,
          ui: agentResult.ui ?? undefined,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        log.warn("Inline creative generation failed", { error: message });
        agentResult.summary = [
          stripCreativesHandoff(agentResult.summary),
          "",
          `**Creative generation failed:** ${message}`,
          "Nothing was generated. Ask me to try again, or check the OpenAI image credentials.",
        ].join("\n");
        steps = failStep(steps, "generate_creatives");
      }
    } else {
      agentResult.summary = stripUnstartedGenerationClaims(agentResult.summary);
    }
    if (agentResult.ui?.servicePicker?.services?.length) {
      if (steps.some((s) => s.id === "pick_services")) {
        steps = activateStep(steps, "pick_services");
      }
      await saveLearning({
        clientId: task.client_id,
        source: "builder_service_picker",
        insight: `Presented services for ad grouping: ${agentResult.ui.servicePicker.services
          .map((s) => s.name)
          .slice(0, 8)
          .join(", ")}`,
        createdBy: task.created_by,
        evidence: {
          taskId: task.id,
          services: agentResult.ui.servicePicker.services,
        },
      });
    }

    task.agent_state = {
      ...(task.agent_state ?? {}),
      steps,
      summary: agentResult.summary,
      ui: agentResult.ui ?? null,
      report: agentResult.report ?? null,
    };

    // Process execute proposals from the grounded answer only.
    const pendingApprovalIds: string[] = [];
    let approvalSummary = agentResult.summary;
    const selectedCreative = await getSelectedCreativeDraftAsync(
      task.client_id,
      { conversationId: task.conversation_id },
    ).catch(() => null);
    const selectedImageUrl = selectedCreative
      ? resolveImageUrlForAdspirer(selectedCreative)
      : null;

    for (const call of agentResult.toolCalls) {
      const safety = classify(call.name);
      const args =
        selectedImageUrl &&
        ["create_ad", "create_meta_image_campaign", "create_meta_video_campaign", "create_adset"].includes(
          call.name,
        )
          ? { ...call.args, image_url: selectedImageUrl }
          : call.args;
      const toolCall = await recordToolCall(task, call.name, safety, args);

      if (safety === "blocked") {
        toolCall.error_message = "Tool blocked by policy gate";
        toolCall.completed_at = nowIso();
        await saveToolCall(toolCall, task.client_id);
        continue;
      }

      if (safety === "diagnose") {
        // Already gathered in preflight — skip duplicate live calls.
        toolCall.completed_at = nowIso();
        toolCall.result = { skipped: "already_ran_in_preflight" };
        await saveToolCall(toolCall, task.client_id);
        continue;
      }

      if (safety === "execute") {
        const executionBackend =
          typeof task.agent_state?.execution_backend === "string"
            ? task.agent_state.execution_backend
            : null;
        const proposedArgsWithBackend = executionBackend
          ? { ...args, __provider_backend: executionBackend }
          : args;
        if (steps.some((s) => s.id === "approval")) {
          steps = activateStep(steps, "approval");
        }
        if (steps.some((s) => s.id === "queue_create")) {
          steps = activateStep(steps, "queue_create");
        }
        if (steps.some((s) => s.id === "queue_adsets_ads")) {
          steps = activateStep(steps, "queue_adsets_ads");
        }
        const approval = await createPendingApproval({
          clientId: task.client_id,
          taskId: task.id,
          toolCallId: toolCall.id,
          toolName: call.name,
          proposedArgs: proposedArgsWithBackend,
          rationale: call.rationale ?? approvalSummary,
          budgetImpactCents: estimateBudgetImpact(call.name, args),
          requestedBy: task.created_by,
        });

        toolCall.approval_id = approval.id;
        toolCall.completed_at = nowIso();
        await saveToolCall(toolCall, task.client_id);
        pendingApprovalIds.push(approval.id);
      }
    }

    const summaryClaimsQueued =
      /\bqueued\b.*\bapprovals?\b/i.test(agentResult.summary) ||
      agentResult.summary.includes("What's next");
    if (summaryClaimsQueued && pendingApprovalIds.length === 0) {
      approvalSummary = [
        stripFalseQueuedClaims(agentResult.summary),
        "",
        "**Could not queue approvals** — structured tool JSON was missing or blocked.",
        "Ask me to queue `create_adset` / `create_ad` again and I'll retry with valid payloads.",
      ].join("\n");
    } else if (pendingApprovalIds.length > 0) {
      approvalSummary = appendApprovalCta(agentResult.summary);
    }

    if (pendingApprovalIds.length > 0) {
      if (steps.some((s) => s.id === "approval")) {
        steps = setStepState(steps, "approval", "active");
      }
      task.status = "waiting_approval";
      task.agent_state = {
        ...(task.agent_state ?? {}),
        phase: "awaiting_approval",
        statusLabel: "Waiting for approval",
        last_tool: agentResult.toolCalls.find(
          (c) => classify(c.name) === "execute",
        )?.name,
        pending_approval_id: pendingApprovalIds[0],
        pending_approval_ids: pendingApprovalIds,
        summary: approvalSummary,
        ui: agentResult.ui ?? null,
        steps,
      };
      task.updated_at = nowIso();
      await saveTask(task);

      log.info("Task waiting on approval", {
        approvalIds: pendingApprovalIds,
        count: pendingApprovalIds.length,
      });

      await options?.onProgress?.({
        phase: "awaiting_approval",
        label:
          pendingApprovalIds.length > 1
            ? `Waiting for ${pendingApprovalIds.length} approvals`
            : "Waiting for approval",
        summary: approvalSummary,
        task,
      });

      await captureTaskLearning({
        clientId: task.client_id,
        taskId: task.id,
        status: task.status,
        summary: approvalSummary,
        userId: task.created_by,
      });

      await saveLearning({
        clientId: task.client_id,
        source: "builder_stage_execute_queued",
        insight:
          "Campaign/ad creates must be queued to Approvals (PAUSED). After execute, report proof IDs then continue website → services → ad sets/ads.",
        createdBy: task.created_by,
        evidence: {
          taskId: task.id,
          approvalIds: pendingApprovalIds,
          tools: agentResult.toolCalls.map((c) => c.name),
        },
      });

      return task;
    }

    // A turn that ends on a question has not finished its plan: park the current
    // step and leave the rest pending. Flipping everything to "done" made the
    // checklist claim a campaign was created while the brief was still being
    // collected — and it kept a spinner on a step nobody had started.
    // The model never answered, so the plan did not advance. Recording it as
    // done would show a checklist of delivered work that never ran.
    if (agentResult.failure) {
      steps = markRemainingSkipped(
        steps.map((s) =>
          s.state === "active" ? { ...s, state: "error" as const } : s,
        ),
      );
      task.status = "error";
      task.error_message = agentResult.failure.detail || "Model call failed";
      task.agent_state = {
        ...(task.agent_state ?? {}),
        phase: "error",
        statusLabel: "Model call failed",
        summary: agentResult.summary,
        messages: agentResult.messages,
        error: task.error_message,
        ui: null,
        steps,
      };
      task.updated_at = nowIso();
      await saveTask(task);
      await options?.onProgress?.({
        phase: "error",
        label: "Model call failed",
        summary: agentResult.summary,
        task,
      });
      log.error("Task failed on provider error", {
        kind: agentResult.failure.kind,
      });
      return task;
    }

    const waiting = !agentResult.report && awaitsOperator(agentResult);
    const rendering = agentResult.ui?.creativePicker?.status === "generating";
    // Only a stage still in progress gets parked; a finished audit that ends on
    // "want me to pause it?" has genuinely completed its checklist.
    const holdPlan = waiting && steps.some((s) => s.state === "active");

    if (holdPlan) {
      steps = holdStepsForOperator(steps);
    } else {
      // The stage that ran closes out; stages this turn never reached are
      // skipped, not done, so a later stage cannot be read as delivered.
      steps = steps.map((s) =>
        s.state === "active"
          ? { ...s, state: "done" as const }
          : s.state === "pending"
            ? { ...s, state: "skipped" as const }
            : s,
      );
      steps = setStepState(steps, "complete", "done");
    }

    const finalLabel = agentResult.report
      ? "Ready to download"
      : rendering
        ? "Rendering stills…"
        : waiting
          ? "Waiting on your reply"
          : "Complete";

    task.status = "done";
    task.completed_at = nowIso();
    task.agent_state = {
      ...(task.agent_state ?? {}),
      phase: "completed",
      statusLabel: finalLabel,
      summary: agentResult.summary,
      messages: agentResult.messages,
      ui: agentResult.ui ?? null,
      report: agentResult.report ?? null,
      steps,
    };
    task.updated_at = nowIso();
    await saveTask(task);
    await captureTaskLearning({
      clientId: task.client_id,
      taskId: task.id,
      status: task.status,
      summary: agentResult.summary,
      userId: task.created_by,
    });
    await options?.onProgress?.({
      phase: "completed",
      label: finalLabel,
      summary: agentResult.summary,
      task,
    });
    return task;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Task failed";
    steps = markRemainingSkipped(
      steps.map((s) =>
        s.state === "active" ? { ...s, state: "error" as const } : s,
      ),
    );
    task.status = "error";
    task.error_message = message;
    task.agent_state = {
      ...(task.agent_state ?? {}),
      phase: "error",
      statusLabel: "Error",
      error: message,
      steps,
    };
    task.updated_at = nowIso();
    await saveTask(task);
    await captureTaskLearning({
      clientId: task.client_id,
      taskId: task.id,
      status: task.status,
      error: message,
      userId: task.created_by,
    });
    log.error("Task failed", { error: message });
    throw error;
  }
}

export async function pauseTask(taskId: string): Promise<Task> {
  const task = await getTask(taskId);
  if (!["queued", "running", "waiting_approval"].includes(task.status)) {
    throw new Error(`Cannot pause task in status ${task.status}`);
  }
  task.status = "paused";
  task.paused_at = nowIso();
  task.agent_state = { ...(task.agent_state ?? {}), phase: "paused" };
  task.updated_at = nowIso();
  return saveTask(task);
}

export async function resumeTask(taskId: string): Promise<Task> {
  const task = await getTask(taskId);
  if (task.status !== "paused") {
    throw new Error(`Cannot resume task in status ${task.status}`);
  }
  task.status = "queued";
  task.paused_at = null;
  task.agent_state = { ...(task.agent_state ?? {}), phase: "queued" };
  task.updated_at = nowIso();
  await saveTask(task);
  return runTask(taskId);
}

export async function cancelTask(taskId: string): Promise<Task> {
  const task = await getTask(taskId);
  const terminal: TaskStatus[] = ["done", "cancelled"];
  if (terminal.includes(task.status)) {
    return task;
  }
  task.status = "cancelled";
  task.agent_state = { ...(task.agent_state ?? {}), phase: "cancelled" };
  task.updated_at = nowIso();

  // Cancel related pending approvals in demo store
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    for (const a of getDemoStore().approvals) {
      if (a.task_id === taskId && a.status === "pending") {
        a.status = "cancelled";
        a.updated_at = nowIso();
      }
    }
  }

  return saveTask(task);
}

function estimateBudgetImpact(
  toolName: string,
  args: Record<string, unknown>,
): number | null {
  if (toolName === "update_adset_budget") {
    const next = Number(args.daily_budget_cents ?? 0);
    const prev = Number(args.previous_daily_budget_cents ?? 0);
    if (!Number.isFinite(next)) return null;
    return Math.max(0, next - (Number.isFinite(prev) ? prev : 0));
  }
  return estimateMetaBudgetImpactCents(toolName, args);
}

async function recordToolCall(
  task: Task,
  toolName: string,
  safety: ReturnType<typeof classify>,
  args: Record<string, unknown>,
): Promise<ToolCall> {
  const config = getConfig();
  const toolCall: ToolCall = {
    id:
      config.isDemoMode || !config.hasSupabase
        ? `toolcall_${nanoid(10)}`
        : newEntityId(),
    task_id: task.id,
    conversation_id: task.conversation_id,
    tool_name: toolName,
    safety_class: safety,
    arguments: args,
    result: null,
    error_message: null,
    approval_id: null,
    started_at: nowIso(),
    completed_at: null,
  };
  await saveToolCall(toolCall, task.client_id);
  return toolCall;
}

export async function getTask(taskId: string): Promise<Task> {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    const task = getDemoStore().tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return task;
  }
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("tasks")
    .select("*")
    .eq("id", taskId)
    .single();
  if (error || !data) throw new Error(`Task not found: ${taskId}`);
  return mapTaskRow(data as Record<string, unknown>);
}

async function saveTask(task: Task): Promise<Task> {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    const store = getDemoStore();
    const idx = store.tasks.findIndex((t) => t.id === task.id);
    if (idx >= 0) store.tasks[idx] = task;
    else store.tasks.push(task);
    return task;
  }
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("tasks")
    .upsert(toTaskUpsert(task))
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return mapTaskRow(data as Record<string, unknown>);
}

async function saveToolCall(
  toolCall: ToolCall,
  clientId: string,
): Promise<void> {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    const store = getDemoStore();
    const idx = store.toolCalls.findIndex((t) => t.id === toolCall.id);
    if (idx >= 0) store.toolCalls[idx] = toolCall;
    else store.toolCalls.push(toolCall);
    return;
  }
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("tool_calls")
    .upsert(toToolCallInsert(toolCall, clientId));
  if (error) throw new Error(error.message);
}

export type { Approval };
