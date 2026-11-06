import { describe, expect, it } from "vitest";
import { classifyStyle, clipVisual, isScreenShot, STYLE_LOOKS, substituteForScreenShot, textRisk } from "@/lib/video/visual-rules";
import { buildClipPrompt } from "@/lib/video/clip-prompt";
import { checkScript } from "@/lib/video/script";
import type { VideoScene, VideoScript } from "@/lib/video/script";

describe("what the video model would have to spell", () => {
  it("flags dashboards, screens, charts, documents, signs and logos", () => {
    expect(textRisk("Full-screen capture of a Google Ads dashboard, slow zoom into the metrics")).toContain("a dashboard or interface");
    expect(textRisk("A bar chart climbs on a report")).toContain("a chart or document");
    expect(textRisk("Close-up of a shop sign reading OPEN")).toContain("a sign, label or written text");
    expect(textRisk("The brand logo fills the frame")).toContain("a logo or brand name");
  });
  it("leaves people, objects and a screen that is only a glow alone", () => {
    expect(textRisk("Medium close-up of a man at a desk, his face lit by a soft glow from a laptop angled away from the camera")).toEqual([]);
    expect(textRisk("A hand turns a coffee cup on a messy wooden desk, window light from the left")).toEqual([]);
  });
  it("recognises a shot that is mainly a screen, and films the person's reaction instead", () => {
    expect(isScreenShot("Screen recording of an audit dashboard, cursor highlighting wasteful campaigns")).toBe(true);
    expect(isScreenShot("Presenter at a desk looking at a laptop")).toBe(false);
    const swapped = clipVisual("Full-screen capture of a Google Ads dashboard", true, true);
    expect(swapped.changed).toBe(true);
    expect(swapped.text).toBe(substituteForScreenShot(true));
    expect(swapped.text).not.toMatch(/dashboard/i);
    expect(clipVisual("A hand turns a coffee cup", true, false)).toEqual({ text: "A hand turns a coffee cup", changed: false });
    expect(substituteForScreenShot(false)).toMatch(/angled away/);
  });
});

describe("the right look for the kind of video", () => {
  it("tells UGC, product, cinematic and motion styles apart", () => {
    expect(classifyStyle("UGC creator walkthrough")).toBe("ugc");
    expect(classifyStyle("Product demo with hero shots")).toBe("product");
    expect(classifyStyle("Motion graphics over footage")).toBe("motion");
    expect(classifyStyle("3D animated")).toBe("animated");
    expect(classifyStyle("Documentary interview")).toBe("documentary");
    expect(classifyStyle("Cinematic")).toBe("cinematic");
  });
  it("makes UGC look filmed on a phone and not studio polished", () => {
    expect(STYLE_LOOKS.ugc).toMatch(/phone/);
    expect(STYLE_LOOKS.ugc).toMatch(/Not studio lit/);
    expect(STYLE_LOOKS.motion).toMatch(/free of text/);
  });
});

const scene = (n: number, visual: string, extra: Partial<VideoScene> = {}): VideoScene => ({
  number: n,
  start: (n - 1) * 5,
  end: n * 5,
  seconds: 5,
  visual,
  camera: "Medium",
  speaker: "on_camera",
  line: "I thought it was fine, honestly.",
  keywords: [],
  stat: null,
  assetId: null,
  sound: "room tone",
  ...extra,
});

const script = (visuals: string[], style = "UGC creator walkthrough"): VideoScript =>
  ({
    id: "s",
    title: "t",
    angle: { key: "k", name: "A", stage: "S", kind: "pain" },
    pain: "p",
    framework: { key: "f", name: "F" },
    style,
    durationSeconds: 5 * visuals.length,
    hookAlternatives: ["a", "b", "c"],
    character: "A man in his 30s",
    setting: "A home office",
    scenes: visuals.map((v, i) => scene(i + 1, v)),
    adCopy: { primaryText: "x", headline: "h", description: "d", cta: "Learn More" },
    warnings: [],
  }) as VideoScript;

describe("the prompt sent for a clip", () => {
  const base = { clipNumber: 1, clipCount: 1, locale: "en-AU", refs: { presenter: true, location: true, previousFrame: false, previousVideo: false }, graphicSceneNumbers: [2] };

  it("never asks for a screen: a dashboard shot is filmed as the presenter's reaction", () => {
    const s = script(["Presenter at a desk, steady", "Full-screen capture of a Google Ads dashboard, slow zoom"]);
    const p = buildClipPrompt({ ...base, script: s, sceneNumbers: [1, 2] });
    const shots = p.split("\n").filter((l) => l.includes("Shot ")).join("\n");
    expect(shots).not.toMatch(/dashboard/i);
    expect(shots).toMatch(/laptop angled away/);
    expect(p).toContain("No readable text anywhere in the frame");
    expect(p).toContain("One clear action per shot");
  });
  it("uses the look for its kind of footage", () => {
    const ugc = buildClipPrompt({ ...base, script: script(["Presenter at a desk"], "UGC creator walkthrough"), sceneNumbers: [1], graphicSceneNumbers: [] });
    expect(ugc).toContain("filmed it on their phone");
    const product = buildClipPrompt({ ...base, script: script(["A bottle on a stone counter"], "Product showcase"), sceneNumbers: [1], graphicSceneNumbers: [] });
    expect(product).toContain("one hero object");
    expect(product).not.toContain("filmed it on their phone");
  });
});

describe("scripts that would make garbled footage are caught", () => {
  const ctx = { corpus: "", assetIds: [] as string[], target: 10 };
  it("warns on a scene that shows a dashboard, and not on one that shows a person", () => {
    const w = checkScript(script(["Presenter laughs at a desk", "Screen recording of the audit dashboard"]), ctx).join(" | ");
    expect(w).toMatch(/Scene 2 shows a dashboard or interface: AI video draws garbled text there/);
    expect(w).not.toMatch(/Scene 1 shows/);
  });
});
