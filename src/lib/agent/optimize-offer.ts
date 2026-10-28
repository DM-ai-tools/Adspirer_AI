import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { mapTaskRow } from "@/lib/db/live-maps";
import type { OfferedProposal } from "@/lib/agent/optimize-evidence";
import type { StoredOffer } from "@/lib/agent/queue-selection";
import type { BriefPeriod } from "@/lib/agent/request-brief";
import { nowIso } from "@/lib/utils";
import type { Task } from "@/types";

/**
 * The numbered list a turn showed, kept on the task (`tasks.agent_state` is
 * jsonb, so no migration). A later "queue #2" is resolved against this list,
 * not against whatever a fresh build would number #2 today.
 */

const KEY = "optimize_offer";
/** How many of the conversation's latest tasks to look through for a list. */
const LOOKBACK_TASKS = 10;

/** Set the list on the task (the caller saves the task). */
export function saveOptimizeOffer(
  task: Task,
  offer: { items: OfferedProposal[]; period: BriefPeriod | null; scopeMentions: string[] },
): void {
  const stored: StoredOffer = { createdAt: nowIso(), ...offer };
  task.agent_state = { ...(task.agent_state ?? {}), [KEY]: stored };
}

/** A turn that showed a list (even an empty one) is the latest word on what can be queued. */
function hasOffer(task: Pick<Task, "agent_state">): boolean {
  return task.agent_state?.[KEY] != null;
}

function readOffer(task: Pick<Task, "agent_state">): StoredOffer | null {
  const raw = task.agent_state?.[KEY] as Partial<StoredOffer> | undefined;
  if (!raw || !Array.isArray(raw.items) || raw.items.length === 0) return null;
  return {
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    items: raw.items as OfferedProposal[],
    period: raw.period ?? null,
    scopeMentions: Array.isArray(raw.scopeMentions) ? raw.scopeMentions : [],
  };
}

/** The most recent list shown in this conversation, not counting `excludeTaskId`. */
export async function loadLastOptimizeOffer(
  conversationId: string | null | undefined,
  excludeTaskId?: string,
): Promise<StoredOffer | null> {
  if (!conversationId) return null;
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    const tasks = getDemoStore()
      .tasks.filter((t) => t.conversation_id === conversationId && t.id !== excludeTaskId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, LOOKBACK_TASKS);
    for (const task of tasks) if (hasOffer(task)) return readOffer(task);
    return null;
  }
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { data, error } = await createAdminClient()
    .from("tasks")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(LOOKBACK_TASKS + 1);
  if (error) throw new Error(error.message);
  for (const row of data ?? []) {
    const task = mapTaskRow(row as Record<string, unknown>);
    if (task.id === excludeTaskId) continue;
    if (hasOffer(task)) return readOffer(task);
  }
  return null;
}
