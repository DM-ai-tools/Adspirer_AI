import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { mapTaskRow, toTaskUpsert } from "@/lib/db/live-maps";
import { nowIso } from "@/lib/utils";
import type { Task } from "@/types";

export type WorkflowCreativesState = {
  request?: {
    landing_page_url?: string | null;
    headline?: string | null;
    primary_text?: string | null;
    service_id?: string | null;
    brief_id?: string | null;
  };
  draft_ids?: string[];
  selected_draft_id?: string | null;
  selected_image_url?: string | null;
  last_event_at?: string | null;
};

export type WorkflowAgentState = Record<string, unknown> & {
  creatives?: WorkflowCreativesState;
  pending_approval_ids?: string[];
  pending_approval_id?: string | null;
};

export async function getTaskById(taskId: string): Promise<Task | null> {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    return getDemoStore().tasks.find((t) => t.id === taskId) ?? null;
  }
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("tasks")
    .select("*")
    .eq("id", taskId)
    .maybeSingle();
  return data ? mapTaskRow(data as Record<string, unknown>) : null;
}

export async function patchTaskAgentState(
  taskId: string,
  patch: Partial<WorkflowAgentState>,
): Promise<Task | null> {
  const task = await getTaskById(taskId);
  if (!task) return null;
  task.agent_state = {
    ...(task.agent_state ?? {}),
    ...patch,
    creatives: {
      ...((task.agent_state?.creatives as WorkflowCreativesState | undefined) ??
        {}),
      ...(patch.creatives ?? {}),
    },
  };
  task.updated_at = nowIso();
  return saveTask(task);
}

export async function saveTask(task: Task): Promise<Task> {
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

export function readCreativesState(
  agentState: Record<string, unknown> | null | undefined,
): WorkflowCreativesState {
  return (agentState?.creatives as WorkflowCreativesState | undefined) ?? {};
}
