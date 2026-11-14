import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const run = vi.fn();
vi.mock("@/lib/monitoring/scheduled", () => ({ runMonitorAllClients: (mode: string) => run(mode) }));

import { POST, KEEPALIVE_MS } from "@/app/api/cron/monitoring/route";

const request = (mode: string) =>
  new Request(`https://x.test/api/cron/monitoring?mode=${mode}`, { method: "POST", headers: { authorization: "Bearer s3cret" } });

async function readAll(res: Response, onChunk: (text: string) => void): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let all = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return all;
    const text = decoder.decode(value);
    onChunk(text);
    all += text;
  }
}

describe("cron monitoring endpoint", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = "s3cret";
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    run.mockReset();
  });

  it("keeps a long run's connection alive, so Railway doesn't cut it at 5 idle minutes", async () => {
    // A daily run over 14 clients takes longer than Railway's 5-minute no-data limit.
    run.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ checked: 14, notified: 3, queued: 0 }), 6 * 60_000)));
    const res = await POST(request("daily"));
    expect(res.status).toBe(200);
    const chunks: string[] = [];
    const body = readAll(res, (t) => chunks.push(t));
    await vi.advanceTimersByTimeAsync(6 * 60_000 + 1);
    const text = await body;
    // A heartbeat at least every KEEPALIVE_MS, well under 5 minutes.
    expect(KEEPALIVE_MS).toBeLessThan(60_000);
    expect(chunks.filter((c) => c.trim() === "").length).toBeGreaterThanOrEqual(Math.floor((6 * 60_000) / KEEPALIVE_MS) - 1);
    // Whitespace before the summary is still valid JSON.
    expect(JSON.parse(text)).toEqual({ ok: true, checked: 14, notified: 3, queued: 0 });
    expect(run).toHaveBeenCalledWith("daily");
  });

  it("reports a run that throws in the body, marked as an error", async () => {
    run.mockRejectedValue(new Error("supabase down"));
    const text = await readAll(await POST(request("hourly")), () => {});
    expect(JSON.parse(text)).toMatchObject({ ok: false, level: "error", error: "supabase down" });
  });

  it("still refuses a wrong secret with 401", async () => {
    const res = await POST(new Request("https://x.test/api/cron/monitoring", { method: "POST", headers: { authorization: "Bearer nope" } }));
    expect(res.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });
});
