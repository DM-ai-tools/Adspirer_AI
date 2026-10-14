import { z } from "zod";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { listOpenAlerts, updateAlert } from "@/lib/monitoring/alert-store";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";

type RouteContext = { params: Promise<{ clientId: string }> };

const bodySchema = z.discriminatedUnion("action", [
  z.object({ key: z.string().min(1), action: z.literal("acknowledge") }),
  z.object({ key: z.string().min(1), action: z.literal("snooze"), days: z.number().int().min(1).max(30).default(3) }),
]);

/** Open scheduled-monitoring alerts for a client. */
export async function GET(_request: Request, context: RouteContext) {
  return withApiHandler(async () => {
    const { clientId } = await context.params;
    const user = await getCurrentUser();
    assertAuthenticated(user);
    await assertClientAccess(user.id, clientId);
    return jsonOk({ alerts: await listOpenAlerts(clientId) });
  });
}

/** Acknowledge or snooze one alert. */
export async function POST(request: Request, context: RouteContext) {
  return withApiHandler(async () => {
    const { clientId } = await context.params;
    const user = await getCurrentUser();
    assertAuthenticated(user);
    await assertClientAccess(user.id, clientId);
    const body = await parseBody(request, bodySchema);
    await updateAlert(
      clientId,
      body.key,
      body.action === "acknowledge" ? { action: "acknowledge", userId: user.id } : { action: "snooze", days: body.days, userId: user.id },
    );
    return jsonOk({ alerts: await listOpenAlerts(clientId) });
  });
}
