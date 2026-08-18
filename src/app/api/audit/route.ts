import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { getCurrentUser } from "@/lib/security/auth";
import {
  assertAuthenticated,
  assertAdmin,
  assertClientAccess,
} from "@/lib/authz/assert";
import { isAdmin } from "@/lib/security/roles";
import { jsonOk, withApiHandler } from "@/lib/api/response";

export type AuditEvent = {
  id: string;
  at: string;
  type: string;
  client_id: string | null;
  actor_id: string | null;
  summary: string;
  payload: Record<string, unknown>;
};

function sortEvents(events: AuditEvent[]): AuditEvent[] {
  return events.sort(
    (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
  );
}

function buildDemoAuditEvents(): AuditEvent[] {
  const store = getDemoStore();
  const events: AuditEvent[] = [];

  for (const a of store.approvals) {
    events.push({
      id: `audit_approval_${a.id}`,
      at: a.updated_at,
      type: `approval.${a.status}`,
      client_id: a.client_id,
      actor_id: a.reviewed_by ?? a.requested_by,
      summary: `${a.tool_name} → ${a.status}`,
      payload: {
        approvalId: a.id,
        toolName: a.tool_name,
        status: a.status,
        budgetImpactCents: a.budget_impact_cents,
      },
    });
  }

  for (const t of store.toolCalls) {
    const task = store.tasks.find((x) => x.id === t.task_id);
    events.push({
      id: `audit_tool_${t.id}`,
      at: t.completed_at ?? t.started_at,
      type: `tool.${t.safety_class}`,
      client_id: task?.client_id ?? null,
      actor_id: task?.created_by ?? null,
      summary: `${t.tool_name} (${t.safety_class})`,
      payload: {
        toolCallId: t.id,
        toolName: t.tool_name,
        safetyClass: t.safety_class,
        approvalId: t.approval_id,
      },
    });
  }

  for (const task of store.tasks) {
    events.push({
      id: `audit_task_${task.id}_${task.status}`,
      at: task.updated_at,
      type: `task.${task.status}`,
      client_id: task.client_id,
      actor_id: task.created_by,
      summary: `${task.title} → ${task.status}`,
      payload: {
        taskId: task.id,
        status: task.status,
        error: task.error_message,
      },
    });
  }

  return sortEvents(events);
}

async function buildLiveAuditEvents(limit: number): Promise<AuditEvent[]> {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();

  // Fetch more than limit from each source so merges still fill the page.
  const perSource = Math.min(Math.max(limit, 50), 250);

  const [
    { data: approvals },
    { data: toolCalls },
    { data: tasks },
  ] = await Promise.all([
    supabase
      .from("approvals")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(perSource),
    supabase
      .from("tool_calls")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(perSource),
    supabase
      .from("tasks")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(perSource),
  ]);

  const events: AuditEvent[] = [];

  for (const a of (approvals ?? []) as Array<Record<string, unknown>>) {
    events.push({
      id: `audit_approval_${a.id}`,
      at: String(a.updated_at ?? a.created_at),
      type: `approval.${a.status}`,
      client_id: (a.client_id as string) ?? null,
      actor_id:
        (a.reviewed_by as string | null) ??
        (a.requested_by as string | null),
      summary: `${String(a.tool_name ?? "tool")} → ${String(a.status)}`,
      payload: {
        approvalId: a.id,
        toolName: a.tool_name,
        status: a.status,
        budgetImpactCents: a.budget_impact_cents ?? null,
      },
    });
  }

  for (const t of (toolCalls ?? []) as Array<Record<string, unknown>>) {
    events.push({
      id: `audit_tool_${t.id}`,
      at: String(t.completed_at ?? t.started_at ?? t.created_at),
      type: `tool.${String(t.tool_type ?? t.status ?? "call")}`,
      client_id: (t.client_id as string) ?? null,
      actor_id: null,
      summary: `${String(t.tool_name)} (${String(t.tool_type ?? t.status)})`,
      payload: {
        toolCallId: t.id,
        toolName: t.tool_name,
        safetyClass: t.tool_type,
        status: t.status,
        approvalId: t.approval_id,
        error: t.error,
      },
    });
  }

  for (const task of (tasks ?? []) as Array<Record<string, unknown>>) {
    events.push({
      id: `audit_task_${task.id}_${task.status}`,
      at: String(task.updated_at ?? task.created_at),
      type: `task.${String(task.status)}`,
      client_id: (task.client_id as string) ?? null,
      actor_id: (task.user_id as string | null) ?? null,
      summary: `${String(task.title)} → ${String(task.status)}`,
      payload: {
        taskId: task.id,
        status: task.status,
        error: task.error_message,
      },
    });
  }

  return sortEvents(events);
}

export async function GET(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);

    const url = new URL(request.url);
    const clientId = url.searchParams.get("clientId");
    const type = url.searchParams.get("type");
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const limit = Math.min(
      Number(url.searchParams.get("limit") ?? 100) || 100,
      500,
    );

    if (clientId) {
      await assertClientAccess(user.id, clientId);
    } else if (!isAdmin(user.profile)) {
      assertAdmin(user); // operators must scope by client
    }

    const config = getConfig();
    let events: AuditEvent[];

    if (config.isDemoMode || !config.hasSupabase) {
      events = buildDemoAuditEvents();
      if (!isAdmin(user.profile)) {
        const allowed = new Set(
          getDemoStore()
            .userClientAccess.filter((a) => a.user_id === user.id)
            .map((a) => a.client_id),
        );
        events = events.filter(
          (e) => e.client_id && allowed.has(e.client_id),
        );
      }
    } else {
      events = await buildLiveAuditEvents(limit);
    }

    if (clientId) events = events.filter((e) => e.client_id === clientId);
    if (type) {
      const needle = type.toLowerCase();
      events = events.filter((e) => e.type.toLowerCase().includes(needle));
    }
    if (from) {
      const fromTs = new Date(from).getTime();
      events = events.filter((e) => new Date(e.at).getTime() >= fromTs);
    }
    if (to) {
      const toTs = new Date(to).getTime();
      events = events.filter((e) => new Date(e.at).getTime() <= toTs);
    }

    return jsonOk({ events: events.slice(0, limit) });
  });
}
