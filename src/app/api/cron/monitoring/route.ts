import { timingSafeEqual } from "node:crypto";
import { runMonitorAllClients, type MonitorMode } from "@/lib/monitoring/scheduled";

export const maxDuration = 800;

/**
 * A space is sent this often while the run works. Railway closes a request that has
 * transferred no data for 5 minutes (502), and the daily run over every client takes longer
 * than that — the summary used to arrive only at the end, after Railway had given up.
 */
export const KEEPALIVE_MS = 20_000;

/**
 * Scheduled monitoring over HTTP, for hosts without the Trigger.dev worker
 * (e.g. a Railway cron service): POST /api/cron/monitoring?mode=daily|hourly
 * with `Authorization: Bearer $CRON_SECRET`. Disabled when CRON_SECRET is unset.
 *
 * The 200 goes out at once and the body is streamed: spaces while clients are checked, then
 * one JSON line — `{"ok":true,"checked":…}`, or `{"ok":false,"level":"error","error":…}` if the
 * run threw (each client's own failure is already logged and skipped inside the run). Leading
 * spaces are valid JSON whitespace, so the body still parses as one JSON value.
 */
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  const given = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(secret ?? "");
  const ok = Boolean(secret) && a.length === b.length && timingSafeEqual(a, b);
  if (!ok) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const mode: MonitorMode = new URL(request.url).searchParams.get("mode") === "hourly" ? "hourly" : "daily";

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const beat = setInterval(() => controller.enqueue(encoder.encode(" ")), KEEPALIVE_MS);
      try {
        const result = await runMonitorAllClients(mode);
        controller.enqueue(encoder.encode(`${JSON.stringify({ ok: true, ...result })}\n`));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        controller.enqueue(encoder.encode(`${JSON.stringify({ ok: false, level: "error", error: message })}\n`));
      } finally {
        clearInterval(beat);
        controller.close();
      }
    },
  });
  return new Response(body, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
