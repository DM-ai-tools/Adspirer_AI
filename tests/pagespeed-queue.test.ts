import { describe, expect, it } from "vitest";
import { fetchPageSpeed, PAGESPEED_CONCURRENCY } from "@/lib/landing/inspect";

const lighthouse = {
  lighthouseResult: { categories: { performance: { score: 0.5 } }, audits: { "largest-contentful-paint": { numericValue: 3000 } } },
};
const ok = () => new Response(JSON.stringify(lighthouse), { status: 200 });

describe("PageSpeed runs", () => {
  it("runs at most a few at once, so 8 landing pages don't all time out together", async () => {
    let running = 0;
    let peak = 0;
    const fetchImpl = (async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 20));
      running -= 1;
      return ok();
    }) as unknown as typeof fetch;
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => fetchPageSpeed(`https://x.com/${i}`, fetchImpl)));
    expect(peak).toBe(PAGESPEED_CONCURRENCY);
    expect(results.every((r) => r?.lcpMs === 3000)).toBe(true);
  });

  it("retries once after a rate limit or a network failure", async () => {
    let calls = 0;
    const flaky = (async () => {
      calls += 1;
      if (calls === 1) return new Response("", { status: 429 });
      return ok();
    }) as unknown as typeof fetch;
    expect((await fetchPageSpeed("https://x.com", flaky))?.performance).toBe(50);
    expect(calls).toBe(2);

    let thrown = 0;
    const down = (async () => {
      thrown += 1;
      throw new Error("network");
    }) as unknown as typeof fetch;
    expect(await fetchPageSpeed("https://x.com", down)).toBeNull();
    expect(thrown).toBe(2);
  });

  it("doesn't retry when Google says the page itself is bad", async () => {
    let calls = 0;
    const bad = (async () => {
      calls += 1;
      return new Response("", { status: 400 });
    }) as unknown as typeof fetch;
    expect(await fetchPageSpeed("https://x.com", bad)).toBeNull();
    expect(calls).toBe(1);
  });
});
