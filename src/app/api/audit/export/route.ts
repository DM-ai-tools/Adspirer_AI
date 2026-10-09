import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertAdmin } from "@/lib/authz/assert";
import { withApiHandler } from "@/lib/api/response";
import {
  TABULAR_CONTENT_TYPES,
  toCsv,
  toXlsx,
  type TabularColumn,
  type TabularFormat,
} from "@/lib/reports/tabular";
import type { AuditEvent } from "../route";

type Names = { clients: Map<string, string>; actors: Map<string, string> };

/** Client names and actor emails, so the file is readable without the app. */
async function resolveNames(events: AuditEvent[]): Promise<Names> {
  const clientIds = [...new Set(events.map((e) => e.client_id).filter(Boolean))] as string[];
  const actorIds = [...new Set(events.map((e) => e.actor_id).filter(Boolean))] as string[];
  const names: Names = { clients: new Map(), actors: new Map() };
  const config = getConfig();

  if (config.isDemoMode || !config.hasSupabase) {
    const store = getDemoStore();
    for (const c of store.clients) names.clients.set(c.id, c.name);
    for (const p of store.profiles) names.actors.set(p.id, p.email);
    return names;
  }

  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const [clients, profiles] = await Promise.all([
    clientIds.length
      ? supabase.from("clients").select("id, name").in("id", clientIds)
      : Promise.resolve({ data: [] as Array<{ id: string; name: string }> }),
    actorIds.length
      ? supabase.from("profiles").select("id, email").in("id", actorIds)
      : Promise.resolve({ data: [] as Array<{ id: string; email: string }> }),
  ]);
  for (const c of clients.data ?? []) names.clients.set(c.id, c.name);
  for (const p of profiles.data ?? []) names.actors.set(p.id, p.email);
  return names;
}

function safeTimeZone(tz: string | null): string {
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-AU", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

function formatTime(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // "2026-10-09 14:05" — sorts correctly as text and reads naturally.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

function humanType(type: string): string {
  return type
    .split(/[._]/)
    .filter(Boolean)
    .map((w, i) => (i === 0 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export async function GET(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    assertAdmin(user);

    const url = new URL(request.url);
    const format: TabularFormat = url.searchParams.get("format") === "xlsx" ? "xlsx" : "csv";
    const timeZone = safeTimeZone(url.searchParams.get("tz"));

    // Reuse the list handler so filters and access rules stay identical.
    const listUrl = new URL("/api/audit", url.origin);
    for (const [key, value] of url.searchParams.entries()) {
      if (key !== "format" && key !== "tz") listUrl.searchParams.set(key, value);
    }
    listUrl.searchParams.set("limit", url.searchParams.get("limit") ?? "1000");

    const { GET: listGet } = await import("../route");
    const listResponse = await listGet(new Request(listUrl.toString()));
    const payload = (await listResponse.json()) as {
      ok: boolean;
      data?: { events: AuditEvent[] };
      error?: { message: string };
    };
    if (!payload.ok || !payload.data) {
      throw new Error(payload.error?.message ?? "Failed to load audit events");
    }

    const events = payload.data.events;
    const names = await resolveNames(events);
    const columns: TabularColumn<AuditEvent>[] = [
      { header: `Time (${timeZone})`, value: (e) => formatTime(e.at, timeZone), width: 20 },
      { header: "Event", value: (e) => humanType(e.type), width: 24 },
      { header: "Client", value: (e) => (e.client_id ? names.clients.get(e.client_id) ?? e.client_id : ""), width: 26 },
      { header: "Actor", value: (e) => (e.actor_id ? names.actors.get(e.actor_id) ?? e.actor_id : "System"), width: 28 },
      { header: "Summary", value: (e) => e.summary, width: 70 },
      { header: "Event type", value: (e) => e.type, width: 22 },
      { header: "Event ID", value: (e) => e.id, width: 30 },
    ];

    const stamp = formatTime(new Date().toISOString(), timeZone).slice(0, 10);
    const filename = `spendsmith-audit-${stamp}.${format}`;
    const body =
      format === "xlsx"
        ? Buffer.from(toXlsx("Audit log", columns, events))
        : toCsv(columns, events);

    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": TABULAR_CONTENT_TYPES[format],
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  });
}
