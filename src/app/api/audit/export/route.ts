import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertAdmin } from "@/lib/authz/assert";
import { withApiHandler } from "@/lib/api/response";
import type { AuditEvent } from "../route";

function toCsv(events: AuditEvent[]): string {
  const header = ["id", "at", "type", "client_id", "actor_id", "summary"];
  const rows = events.map((e) =>
    [
      e.id,
      e.at,
      e.type,
      e.client_id ?? "",
      e.actor_id ?? "",
      e.summary.replace(/"/g, '""'),
    ]
      .map((v) => `"${v}"`)
      .join(","),
  );
  return [header.join(","), ...rows].join("\n");
}

export async function GET(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    assertAdmin(user);

    // Reuse list endpoint logic via internal fetch to keep filters consistent.
    const url = new URL(request.url);
    const listUrl = new URL("/api/audit", url.origin);
    for (const [key, value] of url.searchParams.entries()) {
      listUrl.searchParams.set(key, value);
    }
    listUrl.searchParams.set("limit", url.searchParams.get("limit") ?? "1000");

    // Call handler data path directly to avoid cookie/auth recursion issues.
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

    const csv = toCsv(payload.data.events);
    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="adspirer-audit-${new Date()
          .toISOString()
          .slice(0, 10)}.csv"`,
      },
    });
  });
}
