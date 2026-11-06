import { describe, expect, it, vi } from "vitest";
import { advanceProgress, initialProgress, SCRIPT_STAGES, viewProgress } from "@/lib/video/progress";
import { describeEvent, mmss, overlayEvents, withTimes } from "@/lib/video/overlays";
import { briefFacts, type VideoBrief } from "@/lib/video/script";
import type { VideoAsset } from "@/lib/video/projects";

vi.mock("@/lib/creatives/concept-writer", async (orig) => ({ ...(await orig<typeof import("@/lib/creatives/concept-writer")>()), pickModel: () => ({}) }));
vi.mock("@/lib/storage/r2", () => ({ getObjectStorage: () => ({ get: async (key: string) => (key === "missing" ? null : Buffer.from([1, 2, 3])) }) }));
vi.mock("ai", () => ({
  generateObject: async () => ({
    object: {
      kind: "stats_screenshot",
      summary: "A Google Ads results dashboard",
      stats: [{ value: "255%", label: "average client ROI" }, { value: "$120M+", label: "revenue tracked" }],
      hasFace: false,
    },
  }),
}));

describe("script progress", () => {
  const at = (stage: Parameters<typeof advanceProgress>[1], secondsAgo: number) => {
    const started = new Date(Date.now() - 30_000).toISOString();
    return { ...advanceProgress({ stage: "reading", startedAt: started, stageStartedAt: started }, stage), stageStartedAt: new Date(Date.now() - secondsAgo * 1000).toISOString() };
  };

  it("starts near zero and ends at 100", () => {
    expect(viewProgress(null).percent).toBeLessThan(5);
    expect(viewProgress(advanceProgress(initialProgress(), "done")).percent).toBe(100);
  });
  it("moves forward as stages complete and never goes backwards", () => {
    const seen = SCRIPT_STAGES.map((s) => viewProgress(at(s.key, 0)).percent);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
    expect(seen[0]).toBeLessThan(seen[seen.length - 1]!);
  });
  it("creeps inside a stage but never reaches the next stage's start before the server says so", () => {
    const writing = SCRIPT_STAGES.find((s) => s.key === "writing")!;
    const late = viewProgress(at("writing", 500)).percent;
    expect(late).toBeGreaterThan(writing.from);
    expect(late).toBeLessThan(writing.to);
  });
  it("gives a time left that shrinks, and admits when it is running long", () => {
    const early = viewProgress(at("writing", 1)).secondsLeft!;
    const later = viewProgress(at("writing", 25)).secondsLeft!;
    expect(later).toBeLessThan(early);
    const slow = viewProgress(at("writing", 300));
    expect(slow.slow).toBe(true);
    expect(slow.secondsLeft).toBeNull();
  });
});

describe("overlays: what appears on screen and when", () => {
  const scenes = withTimes([
    { number: 1, seconds: 3, line: "a", keywords: ["working fine"], stat: null, assetId: null },
    { number: 2, seconds: 6, line: "b", keywords: [], stat: null, assetId: "img_1" },
    { number: 3, seconds: 8, line: "c", keywords: ["free audit"], stat: "$120M+", assetId: "img_1" },
  ]);
  it("works out start and end from the lengths", () => {
    expect(scenes.map((s) => [s.start, s.end])).toEqual([[0, 3], [3, 9], [9, 17]]);
    expect(mmss(75)).toBe("1:15");
  });
  it("lists highlights, stats and images in time order, with the stat tied to its image", () => {
    const events = overlayEvents(scenes);
    expect(events.map((e) => e.kind)).toEqual(["keyword", "image", "stat", "keyword"]);
    const lines = events.map((e) => describeEvent(e, (id) => (id === "img_1" ? "Results" : undefined)));
    expect(lines[2]).toBe("0:09-0:17 · Scene 3 · Big stat on screen: “$120M+”, shown with your image “Results”");
    expect(lines[0]).toContain("Word highlighted: “working fine”");
  });
});

describe("uploaded images are read automatically", () => {
  const asset = (over: Partial<VideoAsset> = {}): VideoAsset => ({ id: "img_1", name: "results.png", caption: "", role: "show", key: "k", mime: "image/png", ...over });

  it("pulls the stats and a description out of the image, and marks it to highlight", async () => {
    const { analyzeAssets } = await import("@/lib/video/assets");
    const [out] = await analyzeAssets([asset()]);
    expect(out!.analysis!.stats.map((s) => s.value)).toEqual(["255%", "$120M+"]);
    expect(out!.caption).toBe("A Google Ads results dashboard");
    expect(out!.role).toBe("highlight");
  });
  it("carries on when an image cannot be read", async () => {
    const { analyzeAssets } = await import("@/lib/video/assets");
    const [out] = await analyzeAssets([asset({ key: "missing" })]);
    expect(out!.analysis).toBeNull();
    expect(out!.role).toBe("show");
  });
  it("puts the image's stats in the facts the script is written from, so they pass the fact check", () => {
    const brief = {
      brandName: "Acme",
      offerName: "Audits",
      stats: [],
      images: [{ id: "img_1", name: "results.png", summary: "A results dashboard", stats: [{ value: "255%", label: "average client ROI" }] }],
      targetSeconds: 35,
      style: "auto",
      locale: "en-AU",
    } as VideoBrief;
    const facts = briefFacts(brief);
    expect(facts).toContain("id img_1");
    expect(facts).toContain("255% average client ROI");
  });
});
