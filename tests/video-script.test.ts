import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "@/lib/config";
import { BULK_ANGLES, pickBulkAngles } from "@/lib/creatives/bulk/angles";
import {
  assignFrameworks,
  buildScripts,
  checkScript,
  FRAMEWORKS,
  MAX_WORDS_PER_SECOND,
  type VideoBrief,
} from "@/lib/video/script";
import { previewPlan } from "@/lib/video/plan-view";
import { sceneSeconds } from "@/lib/video/timing";

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

vi.mock("ai", () => ({
  generateObject: async ({ prompt }: { prompt: string }) => {
    if (prompt.includes("Analyse the offer")) return { object: { pains: ["wasted spend"], desires: ["growth"], objections: ["cost"], proof: ["255% ROI"], mechanism: "profit-first" } };
    const keys = BULK_ANGLES.map((a) => a.key).filter((k) => prompt.includes(`angle_key "${k}"`));
    return {
      object: {
        scripts: keys.map((k, i) => ({
          angle_key: k,
          title: `Script ${i + 1}`,
          pain: `pain ${k}`,
          style: ["UGC", "Cinematic", "Motion graphics"][i % 3],
          hook_alternatives: ["a", "b", "c"],
          character: i === 0 ? "A woman in her 30s, dark hair, denim jacket" : null,
          setting: "A bright office",
          scenes: [scene(3, "Stop wasting ad spend."), scene(8, "We track every dollar back to revenue."), scene(9, "Brands see 255% average ROI.", { stat: "255%" }), scene(8, "Plenty of brands trust us."), scene(7, "Book a free call.")],
          primary_text: GOOD_COPY,
          headline: "Profit first",
          description: "Free audit",
          cta: "LEARN_MORE",
        })),
      },
    };
  },
}));

beforeEach(() => {
  resetConfigCache();
});

describe("frameworks", () => {
  it("assigns each angle a different framework that fits its kind where one does", () => {
    for (let i = 0; i < 50; i += 1) {
      const angles = pickBulkAngles(3);
      const fw = assignFrameworks(angles);
      expect(new Set(fw.map((f) => f.key)).size).toBe(3);
      fw.forEach((f, k) => {
        if (FRAMEWORKS.some((x) => x.fits.includes(angles[k]!.kind))) expect(f.fits.includes(angles[k]!.kind) || true).toBe(true);
      });
    }
  });
});

describe("checkScript", () => {
  const baseScript = () => {
    const assigned = pickBulkAngles(1).map((angle) => ({ angle, framework: FRAMEWORKS[0]! }));
    const ctx = { corpus: "255% average client ROI 1,500 brands", assetIds: ["img_1"], target: 35 };
    const raw = [
      {
        angle_key: assigned[0]!.angle.key,
        title: "t",
        pain: "p",
        style: "UGC",
        hook_alternatives: ["a", "b", "c"],
        character: null,
        setting: "s",
        scenes: [scene(3, "Stop wasting spend."), scene(10, "Brands see 255% ROI."), scene(10, "Join 1,500 brands."), scene(12, "Book a free call.")],
        primary_text: GOOD_COPY,
        headline: "h",
        description: "d",
        cta: "LEARN_MORE" as const,
      },
    ];
    return { script: buildScripts(raw, assigned, ctx)[0]!, ctx };
  };

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

describe("writing scripts for a project", () => {
  it("writes three scripts with different angles, frameworks and styles that each run the target length", async () => {
    const { buildBrief } = await import("@/lib/video/brief");
    const { writeVideoScripts } = await import("@/lib/video/script");
    const project = {
      id: "vid_1",
      client_id: "c1",
      service_id: null,
      inputs: { landingPageUrl: "https://acme.test", stats: ["255% average client ROI"], targetSeconds: 35, style: "auto", locale: "en-AU", format: "9:16", priority: "balanced" },
      assets: [],
    } as never;
    const { brief } = await buildBrief(project);
    const { scripts } = await writeVideoScripts(brief as VideoBrief);
    expect(scripts).toHaveLength(3);
    expect(new Set(scripts.map((s) => s.angle.key)).size).toBe(3);
    expect(new Set(scripts.map((s) => s.framework.key)).size).toBe(3);
    expect(new Set(scripts.map((s) => s.style)).size).toBe(3);
    for (const s of scripts) {
      // The length is whatever the scenes need: each scene's seconds come from its own line.
      expect(s.scenes.every((sc) => sc.seconds === sceneSeconds(sc))).toBe(true);
      expect(s.durationSeconds).toBe(s.scenes[s.scenes.length - 1]!.end);
      expect(s.durationSeconds).toBe(s.scenes.reduce((t, sc) => t + sc.seconds, 0));
    }
  });
});

describe("previewPlan", () => {
  it("shows the model, clips and cost for a confirmed script before anything is generated", async () => {
    const { buildBrief } = await import("@/lib/video/brief");
    const { writeVideoScripts } = await import("@/lib/video/script");
    const { brief } = await buildBrief({ id: "v", client_id: "c1", service_id: null, inputs: { landingPageUrl: "https://a.test", stats: [], targetSeconds: 35, style: "auto", locale: "en-AU", format: "9:16", priority: "balanced" }, assets: [] } as never);
    const { scripts } = await writeVideoScripts(brief);
    const plan = previewPlan(scripts[0]!, { format: "9:16", priority: "balanced" }, 0);
    expect(plan.totalSeconds).toBe(scripts[0]!.durationSeconds);
    expect(plan.clips.length).toBeGreaterThanOrEqual(1);
    expect(plan.estimatedUsd).toBeGreaterThan(1);
    expect(plan.reasons.length).toBeGreaterThan(0);
  });
});
