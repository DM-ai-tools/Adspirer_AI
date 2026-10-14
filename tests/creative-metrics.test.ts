import { describe, expect, it, vi } from "vitest";
import { assessFatigue, hookRate, holdRate } from "@/lib/creative/fatigue";
import { evaluateCheckpoints } from "@/lib/audit/checkpoints";
import { demoMetaAuditSnapshot } from "@/lib/audit/meta-audit-data";
import { MetaGraphProviderV2 } from "@/lib/meta/provider-v2";

describe("assessFatigue (one rule for optimiser, audit and monitoring)", () => {
  const base = { impressions: 5000, frequency7d: 3.6, ctrNow: 0.7, ctrBefore: 1.0 };
  it("is fatigued when 7-day frequency is over the limit and link CTR fell 20%+ from the week before", () => {
    expect(assessFatigue(base).fatigued).toBe(true);
    expect(assessFatigue(base).reason).toMatch(/30%/);
  });
  it("is not fatigued when CTR held up, frequency is under the limit, or there's too little data", () => {
    expect(assessFatigue({ ...base, ctrNow: 0.95 }).fatigued).toBe(false);
    expect(assessFatigue({ ...base, frequency7d: 2.4 }).fatigued).toBe(false);
    expect(assessFatigue({ ...base, impressions: 400 }).fatigued).toBe(false);
  });
  it("uses the client's frequency limit, and a CTR floor when there's no earlier week", () => {
    expect(assessFatigue({ ...base, frequency7d: 2.8 }, { frequencyMax: 2.5 }).fatigued).toBe(true);
    expect(assessFatigue({ ...base, ctrBefore: null, ctrNow: 0.5 }).fatigued).toBe(true);
    expect(assessFatigue({ ...base, ctrBefore: null, ctrNow: 1.2 }).fatigued).toBe(false);
  });
});

describe("video hook and hold rate", () => {
  it("hook = 3-second plays ÷ impressions; hold = ThruPlays ÷ 3-second plays", () => {
    expect(hookRate({ impressions: 10_000, videoViews3s: 2_800 })).toBeCloseTo(28);
    expect(holdRate({ videoViews3s: 2_800, thruplays: 1_120 })).toBeCloseTo(40);
    expect(hookRate({ impressions: 0, videoViews3s: 0 })).toBeNull();
  });

  it("audit C7 flags live video ads whose hook rate is under 25%", () => {
    const snap = demoMetaAuditSnapshot("act_1", "Demo", 7);
    snap.ads = snap.ads.map((a) =>
      a.id === "ad_2" && a.performance
        ? { ...a, performance: { ...a.performance, impressions: 10_000, videoViews3s: 1_500, thruplays: 500 } }
        : a.id === "ad_1" && a.performance
          ? { ...a, performance: { ...a.performance, impressions: 10_000, videoViews3s: 3_200, thruplays: 1_600 } }
          : a,
    );
    const c7 = evaluateCheckpoints(snap).checkpoints.find((c) => c.id === "C7")!;
    expect(c7.status).toBe("warn");
    expect(c7.evidence).toMatch(/Implants – Doctor intro \(hook 15%/);
    expect(c7.evidence).not.toMatch(/Before\/After video \(hook/);
  });
});

describe("detectCreativeFatigue uses the shared rule and never empties an ad set", () => {
  function provider(rows: { now: Array<Record<string, unknown>>; before: Array<Record<string, unknown>> }, ads: Array<Record<string, unknown>>) {
    const p = new MetaGraphProviderV2("t");
    const get = vi.fn(async (path: string, params: Record<string, unknown> = {}) => {
      if (path === "act_1") return { currency: "USD" };
      if (path === "act_1/ads") return { data: ads };
      if (path === "act_1/insights") {
        const range = JSON.parse(String(params.time_range ?? "{}")) as { until?: string };
        const isNow = range.until === new Date().toISOString().slice(0, 10);
        return { data: isNow ? rows.now : rows.before };
      }
      throw new Error(`unexpected ${path}`);
    });
    (p as unknown as { graph: unknown }).graph = { get, post: vi.fn() };
    return p;
  }
  const ad = (id: string, adset: string) => ({ id, name: `Ad ${id}`, adset_id: adset, campaign_id: "c1", status: "ACTIVE", effective_status: "ACTIVE" });
  const row = (id: string, adset: string, ctr: number, freq: number) => ({
    ad_id: id, ad_name: `Ad ${id}`, adset_id: adset, impressions: "5000", spend: "50", frequency: String(freq), inline_link_click_ctr: String(ctr),
  });

  it("pauses a fatigued ad that has a live sibling, but not an ad set's only live ad", async () => {
    const p = provider(
      {
        now: [row("a1", "s1", 0.6, 3.8), row("a2", "s1", 1.1, 2.0), row("b1", "s2", 0.5, 4.0)],
        before: [row("a1", "s1", 1.0, 3.0), row("a2", "s1", 1.1, 2.0), row("b1", "s2", 1.0, 3.0)],
      },
      [ad("a1", "s1"), ad("a2", "s1"), ad("b1", "s2")],
    );
    const result = await p.detectCreativeFatigue("act_1");
    const proposals = (result.structured?.proposals ?? []) as Array<{ args: { ad_id: string } }>;
    expect(proposals.map((x) => x.args.ad_id)).toEqual(["a1"]);
    expect(result.text).toMatch(/b1.*only live ad/);
  });
});
