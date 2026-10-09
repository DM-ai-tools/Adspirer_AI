import { z } from "zod";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { getCurrentUser } from "@/lib/security/auth";
import {
  assertAuthenticated,
  assertClientAccess,
  getAccessibleClientIds,
} from "@/lib/authz/assert";
import { isAdmin } from "@/lib/security/roles";
import { createTask, runTask } from "@/lib/agent/task-runner";
import { toPublicTask } from "@/lib/agent/task-public";
import type { Task } from "@/types";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";

const createSchema = z.object({
  clientId: z.string().min(1),
  request: z.string().min(1),
  conversationId: z.string().min(1).optional(),
  run: z.boolean().optional(),
});

export async function GET(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);

    const url = new URL(request.url);
    const clientId = url.searchParams.get("clientId");
    const status = url.searchParams.get("status");

    const config = getConfig();
    if (config.isDemoMode || !config.hasSupabase) {
      const store = getDemoStore();
      let tasks = store.tasks;
      if (clientId) {
        await assertClientAccess(user.id, clientId);
        tasks = tasks.filter((t) => t.client_id === clientId);
      } else if (!isAdmin(user.profile)) {
        const allowed = new Set(
          store.userClientAccess
            .filter((a) => a.user_id === user.id)
            .map((a) => a.client_id),
        );
        tasks = tasks.filter((t) => allowed.has(t.client_id));
      }
      if (status) tasks = tasks.filter((t) => t.status === status);
      return jsonOk({ tasks: tasks.map((t) => toPublicTask(t)) });
    }

    const { createAdminClient } = await import("@/lib/supabase/admin");
    const supabase = createAdminClient();
    let query = supabase.from("tasks").select("*").order("created_at", {
      ascending: false,
    });
    if (clientId) {
      await assertClientAccess(user.id, clientId);
      query = query.eq("client_id", clientId);
    } else {
      const allowed = await getAccessibleClientIds(user);
      if (allowed) query = query.in("client_id", allowed);
    }
    if (status) query = query.eq("status", status);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return jsonOk({
      tasks: ((data ?? []) as Task[]).map((t) => toPublicTask(t)),
    });
  });
}

export async function POST(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);

    const body = await parseBody(request, createSchema);
    await assertClientAccess(user.id, body.clientId);

    const task = await createTask({
      clientId: body.clientId,
      createdBy: user.id,
      title: body.request.slice(0, 120),
      goal: body.request,
      conversationId: body.conversationId ?? null,
    });

    // Default: enqueue and run. Execute tools still go through approvals.
    const shouldRun = body.run !== false;
    const result = shouldRun ? await runTask(task.id) : task;
    return jsonOk({ task: toPublicTask(result) }, 201);
  });
}
