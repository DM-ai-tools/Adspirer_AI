import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "@/lib/config";
import { checkScript, MAX_WORDS_PER_SECOND, type VideoScript } from "@/lib/video/script";
import { previewPlan } from "@/lib/video/plan-view";
import { retime } from "@/lib/video/timing";

vi.mock("@/lib/creatives/service", () => ({
  loadScope: async () => ({
    client: { id: "c1", name: "Acme", brand_voice: null, brand_colors: ["#37ca37"], website_url: null, target_audience: "AU shops", value_proposition: "Profit-first Google Ads" },
    service: null,
    brief: null,
  }),
}));
vi.mock("@/lib/brand/analyze-url", () => ({
  analyzeBrandFromUrl: async () => ({ brand_name: "Acme", colors: ["#37ca37"], logo_url: null, title: "Acme", summary: "Acme runs Google Ads with 255% average client ROI.", page_excerpt: "255% average client ROI. 1,500 brands." }),
}));
vi.mock("@/lib/creatives/uploaded-logo", () => ({ loadUploadedLogoDataUri: async () => null }));
vi.mock("@/lib/creatives/concept-writer", async (orig) => ({ ...(await orig<typeof import("@/lib/creatives/concept-writer")>()), pickModel: () => ({}) }));

const GOOD_COPY = [
  "I thought my Google Ads were fine. They weren't.",
  "",
  "Every month the budget went out and the leads came in, so I never looked closer. Then I got a free audit and found where nearly a third of it was leaking into clicks that never turn into customers.",
  "",
  "Traffic Radius tracks every dollar back to revenue, not just clicks, so you can see what's actually working. Over 1,500 brands use them to stop guessing and start growing.",
  "",
  "Grab a free audit and see where yours is going.",
].join("\n");

const scene = (seconds: number, line = "", extra: Record<string, unknown> = {}) => ({
  seconds,
  visual: "A creator at a desk",
  camera: "Medium, handheld",
  speaker: "voiceover" as const,
  line,
  keywords: [],
  stat: null,
  asset_id: null,
  sound: "light beat",
  ...extra,
});

beforeEach(() => {
  resetConfigCache();
});

function baseScript() {
  const ctx = { corpus: "255% average client ROI 1,500 brands", assetIds: ["img_1"], target: 35 };
  const raw = [scene(3, "Stop wasting spend."), scene(10, "Brands see 255% ROI."), scene(10, "Join 1,500 brands."), scene(12, "Book a free call.")];
  const scenes = retime(raw.map((r, i) => ({ number: i + 1, start: 0, end: 0, visual: r.visual, camera: r.camera, speaker: r.speaker, line: r.line, keywords: r.keywords, stat: r.stat, assetId: r.asset_id, sound: r.sound, seconds: r.seconds })));
  const script = {
    id: "s1",
    title: "t",
    angle: { key: "a", name: "a", stage: "", kind: "custom" },
    pain: "p",
    framework: { key: "custom", name: "" },
    style: "UGC",
    durationSeconds: scenes.at(-1)!.end,
    hookAlternatives: ["a", "b", "c"],
    character: null,
    setting: "s",
    scenes,
    adCopy: { primaryText: GOOD_COPY, headline: "h", description: "d", cta: "Learn More" },
    warnings: [],
  } as VideoScript;
  return { script, ctx };
}

describe("checkScript", () => {

  it("passes a script whose numbers come from the facts and whose pace is speakable", () => {
    const { script, ctx } = baseScript();
    expect(script.durationSeconds).toBe(script.scenes.reduce((t, x) => t + x.seconds, 0));
    expect(checkScript(script, ctx)).toEqual([]);
  });
  it("flags an invented number, a rushed line, a missing image and a late hook", () => {
    const { script, ctx } = baseScript();
    script.scenes[1]!.line = "We have saved clients 9,999 dollars every single month for every single client always.";
    script.scenes[1]!.seconds = 3;
    script.scenes[2]!.assetId = "img_missing";
    script.scenes[0]!.seconds = 8;
    const warnings = checkScript(script, ctx).join(" | ");
    expect(warnings).toMatch(/9,999/);
    expect(warnings).toMatch(/too fast/);
    expect(warnings).toMatch(/not uploaded/);
    expect(warnings).toMatch(/first 2-3 seconds/);
    expect(MAX_WORDS_PER_SECOND).toBeGreaterThan(2);
  });
});

describe("previewPlan", () => {
  it("shows the model, clips and cost for a confirmed script before anything is generated", () => {
    const scripts = [baseScript().script];
    const plan = previewPlan(scripts[0]!, { format: "9:16", priority: "balanced" }, 0);
    expect(plan.totalSeconds).toBe(scripts[0]!.durationSeconds);
    expect(plan.clips.length).toBeGreaterThanOrEqual(1);
    expect(plan.estimatedUsd).toBeGreaterThan(1);
    expect(plan.reasons.length).toBeGreaterThan(0);
  });
});
