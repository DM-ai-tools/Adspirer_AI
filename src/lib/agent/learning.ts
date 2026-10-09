import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { logger } from "@/lib/observability/logger";
import { nowIso } from "@/lib/utils";
import { newEntityId } from "@/lib/db/live-maps";

export type AgentLearning = {
  id: string;
  client_id: string;
  source: string;
  insight: string;
  evidence: Record<string, unknown> | null;
  weight: number;
  created_by: string | null;
  created_at: string;
};

export type AgentFeedback = {
  id: string;
  client_id: string;
  conversation_id: string | null;
  message_id: string | null;
  task_id: string | null;
  user_id: string;
  rating: "up" | "down";
  comment: string | null;
  created_at: string;
};

/**
 * Prior activity is evidence about taste, not a source of settings. Without
 * this the agent lifts the last campaign's landing page and budget into the
 * next brief and calls it context.
 */
const RESEARCH_SCOPE_RULE =
  "Scope rule: use the evidence below only for messaging quality, operator preferences, and mistakes to avoid. Landing page, budget, objective, audience, schedule, and creative for this campaign must come from the operator in this conversation — never inherited from a previous campaign.";

/** Keep prior URLs out of the memo so they cannot become this campaign's default. */
function redactUrls(text: string): string {
  return text.replace(/https?:\/\/\S+/gi, "(url withheld — ask the operator)");
}

type ResearchInput = {
  clientId: string;
  /** Request intent — the memo cache is keyed by client + intent. */
  intent: string;
  /** Pre-started evidence load (runs in parallel with other turn reads). */
  evidence?: Promise<string>;
};

/**
 * The memo summarises operator preferences, which change slowly. It is built
 * off the critical path: a turn uses the cached memo when there is one,
 * otherwise the raw evidence block right away, and the memo is refreshed in
 * the background for the next turn.
 */
const RESEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
const researchCache = new Map<string, { memo: string; at: number }>();
const researchRefreshing = new Set<string>();

function researchCacheKey(clientId: string, intent: string): string {
  return `${clientId}::${intent}`;
}

/** Cached memo for this client + intent, if fresh. Never triggers a fetch. */
export function peekCachedResearch(
  clientId: string,
  intent: string,
): string | null {
  const cached = researchCache.get(researchCacheKey(clientId, intent));
  if (cached && Date.now() - cached.at < RESEARCH_CACHE_TTL_MS) {
    return cached.memo;
  }
  return null;
}

/** Prior tasks, approvals, feedback and learnings as one redacted block. */
export async function loadResearchEvidence(clientId: string): Promise<string> {
  const [tasks, approvals, feedback, learnings] = await Promise.all([
    loadRecentTasks(clientId),
    loadRecentApprovals(clientId),
    loadRecentFeedback(clientId),
    loadLearnings(clientId),
  ]);

  const evidence = [
    "## Recent tasks",
    tasks.length
      ? tasks
          .map(
            (t) =>
              `- [${t.status}] ${t.title}${t.error ? ` · error: ${t.error}` : ""}`,
          )
          .join("\n")
      : "- (none yet)",
    "",
    "## Approval outcomes",
    approvals.length
      ? approvals
          .map(
            (a) =>
              `- ${a.tool_name} → ${a.status}${
                a.rationale ? ` · ${a.rationale.slice(0, 140)}` : ""
              }`,
          )
          .join("\n")
      : "- (none yet)",
    "",
    "## Operator feedback",
    feedback.length
      ? feedback
          .map(
            (f) =>
              `- ${f.rating.toUpperCase()}${f.comment ? `: ${f.comment}` : ""}`,
          )
          .join("\n")
      : "- (none yet)",
    "",
    "## Stored learnings",
    learnings.length
      ? learnings.map((l) => `- (${l.source}) ${l.insight}`).join("\n")
      : "- (none yet)",
  ].join("\n");

  return redactUrls(evidence);
}

function heuristicResearchBlock(evidenceBlocks: string): string {
  return [
    "## Context research (prior workspace activity)",
    RESEARCH_SCOPE_RULE,
    "",
    evidenceBlocks,
  ].join("\n");
}

/** Build the memo with a small model and cache it for the next turn. */
async function refreshResearchMemo(
  clientId: string,
  intent: string,
  evidenceBlocks: string,
): Promise<void> {
  const config = getConfig();
  if (!config.hasOpenAI || !config.OPENAI_API_KEY) return;
  const key = researchCacheKey(clientId, intent);
  if (researchRefreshing.has(key)) return;
  researchRefreshing.add(key);
  try {
    const openai = createOpenAI({ apiKey: config.OPENAI_API_KEY });
    const { text } = await generateText({
      model: openai(config.OPENAI_MODEL),
      temperature: 0.2,
      maxOutputTokens: 500,
      system: [
        "You prepare a brief context-research memo for a Meta Ads operator agent.",
        "Scope: what the operator liked or rejected, and how to raise content quality — messaging angles, copy and creative that earned approval, phrasing or claims to avoid, and process mistakes worth not repeating.",
        "Never carry campaign settings forward. Do not output a landing page URL, budget, objective, audience, schedule, campaign name, or image to reuse: each campaign is briefed fresh and those must be asked, not assumed.",
        "Use only the provided evidence. Output 4–8 bullet insights about quality and preference.",
        "If evidence is thin, say so plainly instead of inventing defaults.",
      ].join(" "),
      // No request text: the memo is reused across turns of this kind, so it
      // must not carry one request's specifics into another.
      prompt: [
        `Kind of request this memo will support: ${intent}`,
        "",
        "Evidence from this client workspace:",
        evidenceBlocks,
      ].join("\n"),
    });
    const memo = [
      "## Context research (learned before analysis)",
      RESEARCH_SCOPE_RULE,
      "",
      text.trim(),
    ].join("\n");
    researchCache.set(key, { memo, at: Date.now() });
  } catch (error) {
    logger.warn("Context research memo refresh failed", {
      error: error instanceof Error ? error.message : String(error),
      clientId,
    });
  } finally {
    researchRefreshing.delete(key);
  }
}

/**
 * Research block for this turn. Never waits on a model call: returns the
 * cached memo, or the raw evidence immediately while the memo is rebuilt in
 * the background.
 */
export async function buildContextResearch(
  input: ResearchInput,
): Promise<string> {
  const cached = peekCachedResearch(input.clientId, input.intent);
  if (cached) return cached;

  const evidenceBlocks = await (input.evidence ??
    loadResearchEvidence(input.clientId));

  const config = getConfig();
  if (config.hasOpenAI && config.OPENAI_API_KEY) {
    const { runAfterResponse } = await import("@/lib/api/background");
    runAfterResponse("research-memo", () =>
      refreshResearchMemo(input.clientId, input.intent, evidenceBlocks),
    );
  }
  return heuristicResearchBlock(evidenceBlocks);
}

export async function recordFeedback(input: {
  clientId: string;
  userId: string;
  rating: "up" | "down";
  conversationId?: string | null;
  messageId?: string | null;
  taskId?: string | null;
  comment?: string | null;
}): Promise<AgentFeedback> {
  const row: AgentFeedback = {
    id: newEntityId(),
    client_id: input.clientId,
    conversation_id: input.conversationId ?? null,
    message_id: input.messageId ?? null,
    task_id: input.taskId ?? null,
    user_id: input.userId,
    rating: input.rating,
    comment: input.comment ?? null,
    created_at: nowIso(),
  };

  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    const store = getDemoStore() as unknown as {
      agentFeedback?: AgentFeedback[];
    };
    if (!store.agentFeedback) store.agentFeedback = [];
    store.agentFeedback.push(row);
  } else {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const supabase = createAdminClient();
    const { error } = await supabase.from("agent_feedback").insert({
      id: row.id,
      client_id: row.client_id,
      conversation_id: row.conversation_id,
      message_id: row.message_id,
      task_id: row.task_id,
      user_id: row.user_id,
      rating: row.rating,
      comment: row.comment,
      created_at: row.created_at,
    });
    if (error) {
      // Table may not be migrated yet — keep feedback on the message metadata.
      logger.warn("agent_feedback insert failed; storing on message metadata", {
        error: error.message,
      });
      if (input.messageId) {
        const { data: message } = await supabase
          .from("messages")
          .select("metadata")
          .eq("id", input.messageId)
          .maybeSingle();
        const metadata = {
          ...((message?.metadata as Record<string, unknown> | null) ?? {}),
          feedback: {
            rating: input.rating,
            comment: input.comment ?? null,
            at: row.created_at,
          },
        };
        await supabase
          .from("messages")
          .update({ metadata })
          .eq("id", input.messageId);
      }
    }
  }

  // Turn strong feedback into a durable learning immediately.
  if (input.comment?.trim() || input.rating === "down") {
    await saveLearning({
      clientId: input.clientId,
      source: `feedback_${input.rating}`,
      insight:
        input.comment?.trim() ||
        (input.rating === "up"
          ? "Operator marked a similar response as helpful — prefer this style/approach."
          : "Operator marked a similar response as unhelpful — avoid repeating that approach."),
      createdBy: input.userId,
      evidence: {
        messageId: input.messageId,
        taskId: input.taskId,
        rating: input.rating,
      },
    });
  }

  return row;
}

export async function saveLearning(input: {
  clientId: string;
  source: string;
  insight: string;
  createdBy?: string | null;
  evidence?: Record<string, unknown> | null;
  weight?: number;
}): Promise<void> {
  const insight = input.insight.trim();
  if (!insight) return;

  const row: AgentLearning = {
    id: newEntityId(),
    client_id: input.clientId,
    source: input.source,
    insight: insight.slice(0, 800),
    evidence: input.evidence ?? null,
    weight: input.weight ?? 1,
    created_by: input.createdBy ?? null,
    created_at: nowIso(),
  };

  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    const store = getDemoStore() as unknown as {
      agentLearnings?: AgentLearning[];
    };
    if (!store.agentLearnings) store.agentLearnings = [];
    store.agentLearnings.unshift(row);
    store.agentLearnings = store.agentLearnings.slice(0, 100);
    return;
  }

  try {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const supabase = createAdminClient();
    const { error } = await supabase.from("agent_learnings").insert({
      id: row.id,
      client_id: row.client_id,
      source: row.source,
      insight: row.insight,
      evidence: row.evidence,
      weight: row.weight,
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.created_at,
    });
    if (error) {
      logger.warn("Failed to persist agent learning", { error: error.message });
    }
  } catch (error) {
    logger.warn("agent_learnings unavailable", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function captureTaskLearning(input: {
  clientId: string;
  taskId: string;
  status: string;
  summary?: string | null;
  error?: string | null;
  userId?: string | null;
}): Promise<void> {
  if (input.status === "waiting_approval" && input.summary) {
    await saveLearning({
      clientId: input.clientId,
      source: "task_proposal",
      insight: `When similar asks appear, a useful proposal pattern was: ${input.summary.slice(0, 280)}`,
      createdBy: input.userId,
      evidence: { taskId: input.taskId, status: input.status },
    });
  }
  if (input.status === "error" && input.error) {
    await saveLearning({
      clientId: input.clientId,
      source: "task_error",
      insight: `Avoid repeating this failure mode: ${input.error.slice(0, 280)}`,
      createdBy: input.userId,
      evidence: { taskId: input.taskId, status: input.status },
      weight: 1.2,
    });
  }
  // Successful replies are not saved as learnings: feeding the agent's own
  // wording back into context made it repeat its boilerplate.
}

async function loadRecentTasks(clientId: string) {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    return getDemoStore()
      .tasks.filter((t) => t.client_id === clientId)
      .slice()
      .sort(
        (a, b) =>
          new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
      )
      .slice(0, 8)
      .map((t) => ({
        title: t.title,
        status: t.status,
        error: t.error_message,
        summary:
          typeof t.agent_state?.summary === "string"
            ? t.agent_state.summary
            : null,
      }));
  }

  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("tasks")
    // Only the summary — not the whole agent_state blob (steps, ui, reports).
    .select("title,status,error_message,summary:agent_state->>summary,updated_at")
    .eq("client_id", clientId)
    .order("updated_at", { ascending: false })
    .limit(8);

  return ((data ?? []) as Array<Record<string, unknown>>).map((t) => ({
    title: String(t.title),
    status: String(t.status),
    error: (t.error_message as string | null) ?? null,
    summary: typeof t.summary === "string" ? t.summary : null,
  }));
}

async function loadRecentApprovals(clientId: string) {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    return getDemoStore()
      .approvals.filter((a) => a.client_id === clientId)
      .slice()
      .sort(
        (a, b) =>
          new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
      )
      .slice(0, 8)
      .map((a) => ({
        tool_name: a.tool_name,
        status: a.status,
        rationale: a.rationale,
      }));
  }

  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("approvals")
    .select("tool_name,status,rationale,updated_at")
    .eq("client_id", clientId)
    .order("updated_at", { ascending: false })
    .limit(8);

  return (data ?? []).map((a) => ({
    tool_name: String(a.tool_name),
    status: String(a.status),
    rationale: (a.rationale as string | null) ?? null,
  }));
}

async function loadRecentFeedback(clientId: string): Promise<AgentFeedback[]> {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    const store = getDemoStore() as unknown as {
      agentFeedback?: AgentFeedback[];
    };
    return (store.agentFeedback ?? [])
      .filter((f) => f.client_id === clientId)
      .slice(-10)
      .reverse();
  }

  try {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("agent_feedback")
      .select("*")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false })
      .limit(10);
    if (error) return [];
    return (data ?? []) as AgentFeedback[];
  } catch {
    return [];
  }
}

async function loadLearnings(clientId: string): Promise<AgentLearning[]> {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    const store = getDemoStore() as unknown as {
      agentLearnings?: AgentLearning[];
    };
    return (store.agentLearnings ?? [])
      .filter((l) => l.client_id === clientId && l.source !== "task_success")
      .slice(0, 12);
  }

  try {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("agent_learnings")
      .select("*")
      .eq("client_id", clientId)
      .neq("source", "task_success")
      .order("created_at", { ascending: false })
      .limit(12);
    if (error) return [];
    return (data ?? []) as AgentLearning[];
  } catch {
    return [];
  }
}
