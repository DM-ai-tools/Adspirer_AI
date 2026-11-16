import { describe, expect, it } from "vitest";
import { attachImageStats, lineStatesFigure, linkImageStats, pickMainStat, requiredStatsFrom, requiredStatsPrompt, spokenForms, statCoverage, statFixNote, statGaps } from "@/lib/video/required-stats";
import { firstMention, imageSpansFor } from "@/lib/video/image-timing";
import { buildOverlayFilter } from "@/lib/video/assemble";
import { insideSafeZone, layoutFor } from "@/lib/video/layout";
import { figureRoundsTo, normaliseFigure, sourceClaims } from "@/lib/video/claims";
import { repairText } from "@/lib/video/script-repairs";
import type { VideoScene, VideoScript } from "@/lib/video/script";

const images = [
  { id: "IMG", name: "results.png", stats: [{ value: "$797K", label: "cost" }, { value: "12.2M", label: "conversion value" }, { value: "15.36", label: "return on spend" }] },
  { id: "TWO", name: "reviews.png", stats: [{ value: "4.8", label: "average rating" }] },
];

describe("the one main stat of each image", () => {
  it("requires only the headline stat of each image, not every number printed in it", () => {
    const required = requiredStatsFrom(images);
    expect(required.map((r) => `${r.assetId}:${r.value}`)).toEqual(["IMG:15.36", "TWO:4.8"]);
    const many = requiredStatsFrom([{ id: "A", name: "a.png", stats: Array.from({ length: 9 }, (_, i) => ({ value: `${i + 10}%`, label: `m${i}` })) }]);
    expect(many).toHaveLength(1);
    expect(requiredStatsFrom([{ id: "A", name: "a.png", stats: [] }])).toEqual([]);
  });

  it("uses the stat the model (or the operator) chose when it is one of those read from the image", () => {
    const chosen = requiredStatsFrom([{ ...images[0]!, mainStat: { value: "12.2M", label: "conversion value" } }]);
    expect(chosen.map((r) => r.value)).toEqual(["12.2M"]);
    // a choice that is not one of the stats read from the image is ignored
    expect(requiredStatsFrom([{ ...images[0]!, mainStat: { value: "999", label: "invented" } }]).map((r) => r.value)).toEqual(["15.36"]);
    // spacing in the stat does not matter
    expect(pickMainStat([{ value: "255 %", label: "x" }, { value: "4", label: "y" }], { value: "255%", label: "x" })!.value).toBe("255 %");
  });

  it("falls back to the most outcome-like label, then the first stat printed", () => {
    expect(pickMainStat([{ value: "$1.27", label: "Avg. CPC" }, { value: "5.25", label: "Conv. value / cost" }, { value: "$13.5M", label: "Cost" }])!.value).toBe("5.25");
    expect(pickMainStat([{ value: "71.6M", label: "Conv. value" }, { value: "$13.5M", label: "Cost" }])!.value).toBe("71.6M");
    expect(pickMainStat([{ value: "10", label: "Impressions" }, { value: "20", label: "Clicks" }])!.value).toBe("10");
    expect(pickMainStat([])).toBeNull();
  });

  it("recognises a figure said as written or said another way", () => {
    expect(lineStatesFigure("Clients see 255% average ROI.", "255%")).toBe(true);
    expect(lineStatesFigure("That is 26.5 million in conversion value.", "26.5M")).toBe(true);
    expect(lineStatesFigure("Spend was 797 thousand dollars.", "$797K")).toBe(true);
    expect(lineStatesFigure("Clients see great returns.", "255%")).toBe(false);
    expect(lineStatesFigure("", "255%")).toBe(false);
  });

  const scene = (number: number, line: string, extra: Partial<VideoScene> = {}): VideoScene => ({ number, start: 0, end: 3, seconds: 3, visual: "v", camera: "c", speaker: "voiceover", line, keywords: [], stat: null, assetId: null, sound: "", ...extra });

  it("reports whether the main stat is said, shown with its image, and in which scene", () => {
    const cov = statCoverage({ scenes: [scene(1, "Hook."), scene(2, "That is a return of 15.36 on every dollar spent.", { assetId: "IMG" }), scene(3, "Rated 4.8 on average.")] }, requiredStatsFrom(images));
    const by = (v: string) => cov.find((c) => c.value === v)!;
    expect(by("15.36")).toMatchObject({ said: true, shown: true, scene: 2 });
    expect(by("4.8")).toMatchObject({ said: true, shown: false, scene: 3 });
    // the image's other figures are not required
    expect(cov).toHaveLength(2);
    const gaps = statGaps(statCoverage({ scenes: [scene(1, "Nothing here."), scene(2, "Rated 4.8.")] }, requiredStatsFrom(images)));
    expect(gaps.unsaid.map((c) => c.value)).toEqual(["15.36"]);
    expect(gaps.unshown.map((c) => c.value)).toEqual(["4.8"]);
  });

  it("tells the writer exactly what is missing, and says nothing when the main stat is covered", () => {
    const required = requiredStatsFrom(images);
    const note = statFixNote(statCoverage({ scenes: [scene(1, "Nothing here.")] }, required))!;
    expect(note).toMatch(/MAIN STAT THAT MUST BE SAID/);
    expect(note).toContain("15.36");
    expect(note).toMatch(/asset_id/);
    expect(note).not.toContain("$797K");
    const all = statCoverage({ scenes: [scene(1, "A return of 15.36 per dollar.", { assetId: "IMG" }), scene(2, "4.8 stars.", { assetId: "TWO" })] }, required);
    expect(statFixNote(all)).toBeNull();
  });

  it("links a scene that says the main stat to its image (even if another was put on it), without touching an edited scene", () => {
    const required = requiredStatsFrom(images);
    const out = linkImageStats([scene(1, "A return of 15.36 per dollar."), scene(2, "Rated 4.8.", { edited: true }), scene(3, "Return was 15.36.", { assetId: "TWO" })], required);
    expect(out[0]).toMatchObject({ assetId: "IMG", stat: "15.36" });
    expect(out[1]!.assetId).toBeNull();
    expect(out[2]).toMatchObject({ assetId: "IMG", stat: "15.36" });
  });

  it("makes the main stat mandatory in the prompt and says the other numbers are not required", () => {
    const p = requiredStatsPrompt(requiredStatsFrom(images))!;
    expect(p).toMatch(/MAIN STAT OF EACH/);
    expect(p).toMatch(/MANDATORY/);
    expect(p).toContain("image IMG");
    expect(p).toContain("15.36 return on spend");
    expect(p).not.toContain("$797K");
    expect(p).toMatch(/other numbers printed in an image are not/);
    expect(requiredStatsPrompt([])).toBeNull();
    expect(attachImageStats({ scenes: [] } as unknown as VideoScript, [])).toEqual({ scenes: [] });
  });
});

describe("figures said the way a person rounds them", () => {
  it("accepts a precise figure rounded to within 1.5%, in the claim check and in the stat coverage", () => {
    const src = normaliseFigure("$13,580,509.69");
    expect(figureRoundsTo(normaliseFigure("$13.6 million"), src)).toBe(true);
    expect(figureRoundsTo(normaliseFigure("13.6M"), src)).toBe(true);
    expect(figureRoundsTo(normaliseFigure("$14 million"), src)).toBe(false);
    expect(figureRoundsTo(normaliseFigure("$13.2 million"), src)).toBe(false);
    // a short, exact figure must be said exactly
    expect(figureRoundsTo(normaliseFigure("5.3"), normaliseFigure("5.25"))).toBe(false);
    expect(figureRoundsTo(normaliseFigure("200%"), normaliseFigure("255%"))).toBe(false);
    const registry = [{ id: "c1", text: "Cost 13,580,509.69", kind: "number" as const, figure: "$13,580,509.69", evidence: "x", provenance: { source: "image_reading" as const, detail: "d", confidence: "high" as const } }];
    expect(sourceClaims([{ text: "About $13.6 million went through the account.", where: "Scene 2" }], registry).unsourced).toEqual([]);
    expect(sourceClaims([{ text: "About $20 million went through the account.", where: "Scene 2" }], registry).unsourced).toHaveLength(1);
    expect(lineStatesFigure("About $13.6 million went through this account.", "$13,580,509.69")).toBe(true);
    expect(lineStatesFigure("It returned 768 thousand conversions.", "767,628.34")).toBe(true);
    expect(lineStatesFigure("It returned 20 million.", "71,637,701.43")).toBe(false);
  });

  it("suggests the natural way to say a precise figure, and nothing for a short one", () => {
    expect(spokenForms("$13,580,509.69")).toContain("$13.6 million");
    expect(spokenForms("767,628.34")).toContain("768 thousand");
    expect(spokenForms("5.25")).toEqual([]);
    expect(spokenForms("255%")).toEqual([]);
  });

  it("tells the writer to round naturally and never to invent a period, an owner or a currency", () => {
    const p = requiredStatsPrompt(requiredStatsFrom([{ id: "I", name: "r.png", stats: [{ value: "$13,580,509.69", label: "Cost" }] }]), { I: "advertising performance over time" })!;
    expect(p).toContain("say as $13.6 million");
    expect(p).toContain("advertising performance over time");
    expect(p).toMatch(/do NOT add a period/);
    expect(p).toMatch(/our clients/);
  });
});

describe("the same site written another way", () => {
  it("puts back the page's own address when the writer shortened its subdomain", () => {
    const r = repairText("Book your audit at TrafficRadius.net.au today.", "Start at googleaudit.trafficradius.com.au or call us.");
    expect(r.text).toBe("Book your audit at googleaudit.trafficradius.com.au today.");
    // the page's own parent domain is the same site and is left alone
    expect(repairText("Visit TrafficRadius.com.au.", "Start at googleaudit.trafficradius.com.au").changes).toEqual([]);
    expect(repairText("Book at unrelated.example today.", "Start at googleaudit.trafficradius.com.au").changes).toEqual([]);
  });
});

describe("when the stat image is on screen", () => {
  const word = (text: string, start: number) => ({ text, start, end: start + 0.3, matched: true });
  const windows = [
    { number: 1, start: 0, end: 4 },
    { number: 2, start: 4, end: 9 },
    { number: 3, start: 9, end: 13 },
    { number: 4, start: 13, end: 18 },
  ];
  const scenes = [
    { number: 1, assetId: null, stat: null },
    { number: 2, assetId: "IMG", stat: "$797K" },
    { number: 3, assetId: "IMG", stat: null },
    { number: 4, assetId: null, stat: null },
  ];
  const words = new Map([
    [2, [word("We", 4.2), word("spent", 4.5), word("$797K", 6.4), word("and", 7)]],
    [3, [word("the", 9.2), word("return", 9.5), word("15.36", 10.5)]],
  ]);

  it("finds when a figure is first said, including its written start", () => {
    expect(firstMention(words.get(2)!, "$797K")).toBe(6.4);
    expect(firstMention([word("26.5", 3), word("million", 3.4)], "26.5M")).toBe(3);
    expect(firstMention(words.get(2)!, "999")).toBeNull();
  });

  it("arrives just before the figure is said, not at the start of the scene", () => {
    const [span] = imageSpansFor({ scenes, windows, words, figuresByAsset: { IMG: ["$797K", "15.36"] }, totalSeconds: 18 });
    expect(span!.start).toBeGreaterThan(5.5);
    expect(span!.start).toBeLessThan(6.4);
  });

  it("is one continuous showing across consecutive scenes that use the image, and leaves after the point", () => {
    const spans = imageSpansFor({ scenes, windows, words, figuresByAsset: { IMG: ["$797K", "15.36"] }, totalSeconds: 18 });
    expect(spans).toHaveLength(1);
    expect(spans[0]!.scenes).toEqual([2, 3]);
    expect(spans[0]!.end).toBeGreaterThanOrEqual(13);
    expect(spans[0]!.end).toBeLessThanOrEqual(13.6);
  });

  it("stays long enough to read, and never past the end of the video", () => {
    const short = imageSpansFor({ scenes: [{ number: 1, assetId: "IMG", stat: "$797K" }], windows: [{ number: 1, start: 0, end: 1.5 }], words: new Map([[1, [word("$797K", 0.2)]]]), figuresByAsset: {}, totalSeconds: 6 });
    expect(short[0]!.end - short[0]!.start).toBeGreaterThanOrEqual(2.8 - 1e-9);
    const late = imageSpansFor({ scenes: [{ number: 1, assetId: "IMG", stat: "$797K" }], windows: [{ number: 1, start: 4, end: 5 }], words: new Map([[1, [word("$797K", 4.2)]]]), figuresByAsset: {}, totalSeconds: 5.5 });
    expect(late[0]!.end).toBeLessThanOrEqual(5.5);
  });

  it("shows two different images one after the other, never together", () => {
    const spans = imageSpansFor({
      scenes: [{ number: 1, assetId: "IMG", stat: "$797K" }, { number: 2, assetId: "TWO", stat: "4.8" }],
      windows: [{ number: 1, start: 0, end: 5 }, { number: 2, start: 5, end: 10 }],
      words: new Map([[1, [word("$797K", 1)]], [2, [word("4.8", 5.2)]]]),
      figuresByAsset: {},
      totalSeconds: 10,
    });
    expect(spans).toHaveLength(2);
    expect(spans[1]!.start).toBeGreaterThanOrEqual(spans[0]!.end);
  });

  it("fades the image in and out and eases it up as it arrives, while other overlays stay as they were", () => {
    const f = buildOverlayFilter([
      { x: 10, y: 20, start: 0, end: 5 },
      { x: 30, y: 400, start: 6, end: 13, fade: 0.3, slide: 30 },
    ]);
    expect(f).toContain("[0:v][1:v]overlay=x=10:y=20:format=auto:enable='between(t,0.00,5.00)'[v1]");
    expect(f).toContain("[2:v]format=rgba,fade=t=in:st=6.00:d=0.3:alpha=1,fade=t=out:st=12.70:d=0.3:alpha=1[f1]");
    expect(f).toContain("[v1][f1]overlay=x=30:y='400+if(lt(t,6.30),(6.30-t)*100,0)'");
    expect(f).toContain("enable='between(t,6.00,13.00)'");
  });

  it("keeps the image card inside the area Reels and Stories leave free", () => {
    const l = layoutFor("9:16");
    expect(insideSafeZone(l, l.imageY, l.imageMaxH + 0.04)).toBe(true);
  });
});

describe("the image is on screen only while its main stat is said", () => {
  const scene = (number: number, line: string, extra: Partial<VideoScene> = {}): VideoScene => ({ number, start: 0, end: 3, seconds: 3, visual: "v", camera: "c", speaker: "voiceover", line, keywords: [], stat: null, assetId: null, sound: "", ...extra });
  const required = requiredStatsFrom([{ id: "IMG", name: "results.png", stats: [{ value: "5.25", label: "Conv. value / cost" }] }]);

  it("takes the image off every scene that does not say the stat, and the big-stat card with it", () => {
    const out = linkImageStats(
      [scene(1, "Most agencies stay vague.", { assetId: "IMG" }), scene(2, "Clients see 5.25 back for every dollar spent.", { assetId: "IMG", stat: "5.25" }), scene(3, "Book your audit today.", { assetId: "IMG", stat: "5.25" })],
      required,
    );
    expect(out.map((s) => s.assetId)).toEqual([null, "IMG", null]);
    expect(out[2]!.stat).toBeNull();
    expect(out[1]!.stat).toBe("5.25");
  });

  it("leaves an image with no required stat, an edited scene, and a different stat card alone", () => {
    const out = linkImageStats([scene(1, "Hello.", { assetId: "OTHER" }), scene(2, "Hello again.", { assetId: "IMG", edited: true }), scene(3, "Plain.", { assetId: "IMG", stat: "99%" })], required);
    expect(out[0]!.assetId).toBe("OTHER");
    expect(out[1]!.assetId).toBe("IMG");
    expect(out[2]).toMatchObject({ assetId: null, stat: "99%" });
  });
});
