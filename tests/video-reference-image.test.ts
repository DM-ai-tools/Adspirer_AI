import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "@/lib/config";

// Seedream 5.0 Pro took 121s for one 2K PNG when measured live; the old 60s client timeout cut every call off
// (the server still finished, and billed, each image). A place only fixes layout and light, so it is made smaller.

let bodies: Array<Record<string, unknown>> = [];
let timeouts: number[] = [];

beforeEach(() => {
  process.env.ARK_API_KEY = "test-key";
  resetConfigCache();
  bodies = [];
  timeouts = [];
  const real = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
    timeouts.push(ms);
    return real(ms);
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ data: [{ url: "https://ark.example/img.png" }] }), { status: 200 });
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.ARK_API_KEY;
  resetConfigCache();
});

describe("reference images", () => {
  it("wait long enough for the image model, which can take two minutes", async () => {
    const { createReferenceImage } = await import("@/lib/video/seedream");
    await createReferenceImage("seedance-2-5", "presenter", "a woman in her 40s");
    expect(Math.max(...timeouts)).toBeGreaterThanOrEqual(200_000);
  });

  it("keep the person at full size and make a place smaller, because a place only fixes layout and light", async () => {
    const { createReferenceImage } = await import("@/lib/video/seedream");
    await createReferenceImage("seedance-2-5", "presenter", "a woman in her 40s");
    await createReferenceImage("seedance-2-5", "location", "a bright office");
    expect(bodies[0]!.size).toBe("2K");
    expect(bodies[1]!.size).toBe("1K");
  });

  it("let a caller choose how long to wait for one request", async () => {
    const { arkRequest } = await import("@/lib/video/seedance");
    await arkRequest("k", "/x", {}, { timeoutMs: 123_000 });
    expect(timeouts).toContain(123_000);
    await arkRequest("k", "/x", {});
    expect(timeouts).toContain(60_000);
  });
});
