import { describe, expect, it, vi } from "vitest";
import { spokenBlocks } from "@/lib/video/spoken-blocks";
import { restoreVerbatim, verbatimCheck } from "@/lib/video/verbatim";

// A real script a person pasted: five labelled parts, each with VO, long visual directions, placeholders and an overlay.
const SCRIPT = `VO:
“Hey E-commerce Business owners! If your ad spend is going up but your sales aren’t…”
Visual Direction:
Start with the uploaded (E-commerce(less roas)) stat image as the opening visual.
Use a slow zoom-in to make it feel immediate and performance-led.
Uploaded Asset Placeholder:
[PLACEHOLDER: (E-commerce(less roas))]
Text Overlay:
“ROAS stuck? You’re not alone.”



[PROBLEM]
VO:
“Most E-com brands waste thousands every month because of broken tracking, bad creative, and no real scaling plan.”
Visual Direction:
Use AI-generated realistic visuals/video-style scenes for this section:
a realistic ad dashboard showing poor performance
broken tracking / pixel error warning
a tired white Australian founder sitting in an office with stress/frustration visible
subtle red warning-style visual cues
AI Visual Placeholder:
[AI VISUAL: Realistic broken tracking / Pixel Error dashboard]
[AI VISUAL: White Australian founder looking stressed in office]
Text Overlay:
“Wasted spend = lost growth”



[SOLUTION]
VO:
“We fix your tracking, build conversion funnels, and run ROAS-focused ad campaigns that actually scale.”
Visual Direction:
Use a mix of the uploaded stat card and AI-generated realistic visuals:
improving ad dashboards
creative testing scenes
order notifications / customer sales notifications
funnel-style visual flow from click to customer to repeat buyer
Use the uploaded (E-com 1(feeling sexy)) stat card as the proof anchor in this section.
Uploaded Asset Placeholder:
[PLACEHOLDER: (E-com 1(feeling sexy))]
AI Visual Placeholders:
[AI VISUAL: Improving ad dashboard]
[AI VISUAL: Creative testing scene]
[AI VISUAL: Order notifications popping up]
[AI VISUAL: Click → customer → repeat buyer funnel scene]
Text Overlay:
“From click → customer → repeat buyer”



[PROOF & CREDIBILITY]
VO:
“Our clients have scaled to 8-figures and doubled ROAS within year — with a strategy built for E-com growth.”
Visual Direction:
Show a clean split-screen before/after:
Before: uploaded (E-commerce(less roas)) stat card
After: uploaded (E-com 1(feeling sexy)) stat card
This section should rely on the proof visuals rather than AI-generated replacements.
Uploaded Asset Placeholders:
[PLACEHOLDER LEFT / BEFORE: (E-commerce(less roas))]
[PLACEHOLDER RIGHT / AFTER: (E-com 1(feeling sexy))]
Text Overlay:
“$12M+ in E-com sales generated”



[CALL TO ACTION]
VO:
“Book your free growth plan today. Let’s turn your ad spend into predictable profit.”
Visual Direction:
Use AI-generated realistic / motion-style visuals for:
CTA button animation
booking action visual
a premium branded end screen look
Use the Traffic Radius white logo in the final branded frame.
Uploaded Asset Placeholder:
[PLACEHOLDER: TR White logo]
AI Visual Placeholders:
[AI VISUAL: CTA button animation / booking visual]
[AI VISUAL: Clean branded end frame background]
Text Overlay:
“[Book Now] – Limited Spots This Month”`;

const VO = [
  "Hey E-commerce Business owners! If your ad spend is going up but your sales aren’t…",
  "Most E-com brands waste thousands every month because of broken tracking, bad creative, and no real scaling plan.",
  "We fix your tracking, build conversion funnels, and run ROAS-focused ad campaigns that actually scale.",
  "Our clients have scaled to 8-figures and doubled ROAS within year — with a strategy built for E-com growth.",
  "Book your free growth plan today. Let’s turn your ad spend into predictable profit.",
];

describe("a script with labelled voiceover and long directions between the lines", () => {
  it("finds all five spoken parts, with the script's own visual direction", () => {
    const blocks = spokenBlocks(SCRIPT);
    expect(blocks.map((b) => b.text)).toEqual(VO);
    expect(blocks.every((b) => b.speaker === "voiceover")).toBe(true);
    expect(blocks[0]!.visual).toContain("slow zoom-in");
    expect(blocks[1]!.visual).toContain("realistic ad dashboard");
    // overlays and placeholders are never spoken
    expect(blocks.map((b) => b.text).join(" ")).not.toMatch(/Wasted spend|PLACEHOLDER|Limited Spots/);
  });

  it("recognises every VO line however far the directions push it from the one before", () => {
    const check = verbatimCheck(SCRIPT, VO);
    expect(check.ok).toBe(true);
    expect(check.spans.every(Boolean)).toBe(true);
  });

  it("does not throw away the last two lines for being far from the ones before", () => {
    const out = restoreVerbatim(SCRIPT, VO);
    expect(out.restored).toEqual([]);
    expect(out.spans[3]).not.toBeNull();
    expect(out.spans[4]).not.toBeNull();
  });
});

// ---- the whole analysis, with the model mocked
let modelScenes: Array<Record<string, unknown>> = [];
const prompts: string[] = [];
vi.mock("@/lib/creatives/concept-writer", async (orig) => ({ ...(await orig<typeof import("@/lib/creatives/concept-writer")>()), pickModel: () => ({}) }));
vi.mock("ai", () => ({
  generateObject: async ({ prompt }: { prompt: string }) => {
    prompts.push(prompt);
    return { object: { title: "ROAS stuck", angle_key: "hidden_cost", pain: "ad spend up, sales flat", framework_key: "custom", style: "Motion graphics", character: null, setting: "Dark brand frame", hook_alternatives: ["a", "b", "c"], scenes: modelScenes } };
  },
}));

const scene = (line: string, extra: Record<string, unknown> = {}) => ({ line, speaker: "voiceover", visual: "v", camera: "c", keywords: [], stat: null, asset_id: null, sound: "s", seconds: 4, ...extra });
const ctx = () => ({ facts: "f", assetIds: [], locale: "en-AU", model: {} as never });

describe("analysing that script", () => {
  it("tells the model every spoken part it must keep", async () => {
    modelScenes = VO.map((l) => scene(l));
    prompts.length = 0;
    const { structureUploadedScript } = await import("@/lib/video/uploaded-script");
    await structureUploadedScript(SCRIPT, ctx());
    expect(prompts[0]).toContain("labels 5 spoken parts");
    expect(prompts[0]).toContain("4. Our clients have scaled to 8-figures");
    expect(prompts[0]).toContain("5. Book your free growth plan today.");
  });

  it("keeps all five voiceovers when the model splits them faithfully", async () => {
    modelScenes = VO.map((l) => scene(l));
    const { structureUploadedScript } = await import("@/lib/video/uploaded-script");
    const split = await structureUploadedScript(SCRIPT, ctx());
    expect(split.lines).toEqual(VO);
    expect(split.removedScenes).toEqual([]);
    expect(split.addedScenes).toEqual([]);
  });

  it("puts back the voiceover of scenes the model left out, in place, with the script's own visual", async () => {
    // The model stopped after three scenes, as happened with the pasted script.
    modelScenes = VO.slice(0, 3).map((l) => scene(l));
    const { structureUploadedScript, assembleUploaded } = await import("@/lib/video/uploaded-script");
    const split = await structureUploadedScript(SCRIPT, ctx());
    expect(split.lines).toEqual(VO);
    expect(split.addedScenes).toEqual([4, 5]);
    const script = assembleUploaded({ structured: split.structured, lines: split.lines, restoredScenes: split.restoredScenes, removedScenes: split.removedScenes, addedScenes: split.addedScenes, unused: split.unused, assetIds: [] });
    expect(script.scenes.map((s) => s.line)).toEqual(VO);
    expect(script.scenes[3]!.visual).toContain("split-screen before/after");
    expect(script.scenes[4]!.visual).toContain("CTA button animation");
    expect(script.scenes.every((s) => s.speaker === "voiceover" && s.seconds >= 2)).toBe(true);
    expect(script.handling?.addedScenes).toEqual([4, 5]);
  });

  it("puts a skipped part back between the scenes either side of it", async () => {
    modelScenes = [VO[0]!, VO[1]!, VO[3]!, VO[4]!].map((l) => scene(l));
    const { structureUploadedScript } = await import("@/lib/video/uploaded-script");
    const split = await structureUploadedScript(SCRIPT, ctx());
    expect(split.lines).toEqual(VO);
    expect(split.addedScenes).toEqual([3]);
  });

  it("restores a reworded voiceover to the exact words, with the scene numbers right after insertions", async () => {
    modelScenes = [scene(VO[0]!), scene("Most e-commerce brands waste thousands every month."), scene(VO[2]!)];
    const { structureUploadedScript } = await import("@/lib/video/uploaded-script");
    const split = await structureUploadedScript(SCRIPT, ctx());
    // the part the model cut short is completed in the same scene, so the sentence is not split in two
    expect(split.lines).toEqual(VO);
    expect(split.restoredScenes).toEqual([2]);
    expect(split.addedScenes).toEqual([4, 5]);
  });
});
