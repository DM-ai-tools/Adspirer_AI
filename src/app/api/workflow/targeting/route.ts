import { z } from "zod";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { getTaskById, saveTask } from "@/lib/workflow/state";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";
import { nowIso } from "@/lib/utils";

const itemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});

const locationSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  key: z.string().optional(),
  type: z.string().optional(),
  country_code: z.string().nullish(),
  radius: z.number().positive().max(80).nullish(),
  distance_unit: z.enum(["kilometer", "mile"]).nullish(),
});

const bodySchema = z.object({
  clientId: z.string().min(1),
  taskId: z.string().min(1),
  targeting: z.object({
    custom_audiences: z.array(itemSchema).default([]),
    excluded_custom_audiences: z.array(itemSchema).default([]),
    interests: z.array(itemSchema).default([]),
    behaviors: z.array(itemSchema).default([]),
    locations: z.array(locationSchema).default([]),
  }),
});

/**
 * POST /api/workflow/targeting
 * Persist advanced targeting on the task so Approvals / creative-select can reuse it.
 */
export async function POST(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const body = await parseBody(request, bodySchema);
    await assertClientAccess(user.id, body.clientId);

    const task = await getTaskById(body.taskId);
    if (!task || task.client_id !== body.clientId) {
      throw new Error("Task not found for this client");
    }

    task.agent_state = {
      ...(task.agent_state ?? {}),
      campaign_targeting: body.targeting,
    };
    task.updated_at = nowIso();
    await saveTask(task);
    return jsonOk({ taskId: task.id, targeting: body.targeting });
  });
}
