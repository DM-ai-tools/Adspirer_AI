import { timingSafeEqual } from "node:crypto";
import { runMonitorAllClients, type MonitorMode } from "@/lib/monitoring/scheduled";

export const maxDuration = 800;

/**
 * Scheduled monitoring over HTTP, for hosts without the Trigger.dev worker
 * (e.g. a Railway cron service): POST /api/cron/monitoring?mode=daily|hourly
 * with `Authorization: Bearer $CRON_SECRET`. Disabled when CRON_SECRET is unset.
 */
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  const given = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(secret ?? "");
  const ok = Boolean(secret) && a.length === b.length && timingSafeEqual(a, b);
  if (!ok) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const mode: MonitorMode = new URL(request.url).searchParams.get("mode") === "hourly" ? "hourly" : "daily";
  return Response.json(await runMonitorAllClients(mode));
}
