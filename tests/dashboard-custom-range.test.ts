import { describe, expect, it, vi } from "vitest";
import {
  buildAccountDashboard,
  demoAccountDashboard,
  parseCustomRange,
} from "@/lib/meta/account-dashboard";
import type { MetaGraphClient } from "@/lib/meta/graph-client";
import { getDemoStore } from "@/lib/demo/store";

vi.mock("@/lib/security/auth", () => ({ getCurrentUser: vi.fn() }));
import { getCurrentUser } from "@/lib/security/auth";

const today = new Date("2026-10-15T06:00:00Z");

describe("custom date range", () => {
  it("accepts a valid range and rejects bad ones with a clear reason", () => {
    expect(parseCustomRange("2026-09-01", "2026-09-20", today)).toEqual({ since: "2026-09-01", until: "2026-09-20" });
    expect(() => parseCustomRange("2026-09-20", "2026-09-01", today)).toThrow(/on or before/);
    expect(() => parseCustomRange("09/01/2026", "2026-09-20", today)).toThrow(/YYYY-MM-DD/);
    expect(() => parseCustomRange("2026-10-10", "2026-10-30", today)).toThrow(/future/);
    expect(() => parseCustomRange("2025-01-01", "2026-09-20", today)).toThrow(/366 days/);
    expect(() => parseCustomRange("2023-01-01", "2023-02-01", today)).toThrow(/37 months/);
  });

  it("asks Meta for exactly those dates instead of a preset", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const graph = {
      async get(path: string, params: Record<string, unknown> = {}) {
        if (path.endsWith("/insights")) {
          calls.push(params);
          return { data: [] };
        }
        if (path.endsWith("/campaigns") || path.endsWith("/adsets")) return { data: [] };
        return { name: "A", currency: "USD", timezone_name: "UTC", account_status: 1, amount_spent: "0" };
      },
    } as unknown as MetaGraphClient;
    const dash = await buildAccountDashboard(graph, "act_1", "custom", { since: "2026-09-01", until: "2026-09-20" });
    const ranged = calls.filter((c) => c.date_preset !== "maximum");
    expect(ranged.length).toBeGreaterThan(0);
    for (const c of ranged) {
      expect(c.date_preset).toBeUndefined();
      expect(JSON.parse(String(c.time_range))).toEqual({ since: "2026-09-01", until: "2026-09-20" });
    }
    expect(dash.range).toMatchObject({ key: "custom", since: "2026-09-01", until: "2026-09-20", days: 20 });
  });

  it("demo data covers the chosen dates", () => {
    const dash = demoAccountDashboard("act_1", "Demo", "custom", { since: "2026-09-01", until: "2026-09-20" });
    expect(dash.range).toMatchObject({ key: "custom", since: "2026-09-01", until: "2026-09-20", days: 20 });
    expect(dash.daily).toHaveLength(20);
  });

  it("the API takes since/until for a custom range and refuses one without them", async () => {
    const admin = getDemoStore().profiles.find((p) => p.role === "admin")!;
    vi.mocked(getCurrentUser).mockResolvedValue({ id: admin.id, email: admin.email, profile: admin });
    const client = getDemoStore().clients[0]!;
    const { GET } = await import("@/app/api/dashboard/meta/route");
    const ok = await GET(new Request(`http://x/api/dashboard/meta?clientId=${client.id}&range=custom&since=2026-09-01&until=2026-09-20`));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { state: string; dashboard?: { range: { days: number } } };
    if (body.state === "ok") expect(body.dashboard!.range.days).toBe(20);
    const bad = await GET(new Request(`http://x/api/dashboard/meta?clientId=${client.id}&range=custom`));
    expect(bad.status).toBe(400);
  });
});
