import { describe, expect, it } from "vitest";
import { attachImageStats, lineStatesFigure, linkImageStats, pickMainStat, requiredStatsFrom, requiredStatsPrompt, spokenForms, statCoverage, statFixNote, statGaps } from "@/lib/video/required-stats";
import { firstMention, imageSpansFor } from "@/lib/video/image-timing";
import { buildOverlayFilter } from "@/lib/video/assemble";
import { insideSafeZone, layoutFor } from "@/lib/video/layout";
import { figureRoundsTo, normaliseFigure, sourceClaims } from "@/lib/video/claims";
import { repairText } from "@/lib/video/script-repairs";
import { buildWrittenScript, scriptPrompt, trimToFit, writeScriptForAngle, type WriteContext, type WrittenScript } from "@/lib/video/script-writer";
import type { VideoScene, VideoScript } from "@/lib/video/script";
import type { AnglePlan, CreativeBrief } from "@/lib/video/script-types";

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

describe("writing with a mandatory main stat", () => {
  const prov = { id: "p", kind: "page" as const, label: "Landing page", quote: "We audit Google Ads accounts" };
  const creative = { version: 1, createdAt: "", company: { name: "Acme", source: "m" }, offer: { name: "Ad audit", description: "", factIds: ["f1"] }, conversion: { action: "Book an audit", target: null, benefit: null, factIds: [] }, audience: { primary: "Shop owners", situation: "", factIds: [], inferred: true }, mechanism: null, facts: [{ id: "f1", text: "We audit Google Ads accounts", category: "mechanism", source: prov }], inferences: [], rejectedFacts: [], voice: { tone: "plain", vocabulary: [], avoid: [] }, defaults: [], gaps: [], sourceQuality: "rich", limitation: null, injectionFlags: [] } as CreativeBrief;
  const ctx = (): WriteContext => ({
    creative,
    brief: { brandName: "Acme", offerName: "Ad audit", stats: [], images: images.map((i) => ({ ...i, summary: "results" })), targetSeconds: 30, style: "auto", locale: "en-AU" } as never,
    targetSeconds: 30,
    wordsPerSecond: 2.5,
    assetIds: ["IMG", "TWO"],
    claims: [],
    sourceText: "We audit Google Ads accounts. $797K 12.2M 15.36 4.8",
    facts: "",
    corpus: "$797K 12.2M 15.36 4.8",
  });
  const angle: AnglePlan = { id: "a", name: "A", situation: "s", tension: "t", centralMessage: "m", hookPremise: "h", support: { text: "audit", factIds: ["f1"] }, tone: "plain", reasonToAct: "r", whyDifferent: "d" };
  const words = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(" ");
  const raw = (lines: string[]): WrittenScript => ({
    title: "t",
    hook_candidates: [lines[0]!, "b one two three", "c one two three", "d one two three"].map((line) => ({ line, why: "w" })),
    chosen_hook: 0,
    hook_payoff: "p",
    style: "Documentary",
    dramatisation: true,
    character: null,
    setting: "s",
    scenes: lines.map((line) => ({ seconds: 4, visual: "v", camera: "c", speaker: "voiceover" as const, line, keywords: [], stat: null, asset_id: null, sound: "" })),
    visual_direction: "v",
    on_screen: [],
    cta: { spoken: "Book an audit.", label: "Book Now", target: null, benefit: null },
    sources: [],
    primary_text: "x",
    headline: "h",
    description: "d",
  });

  it("puts the main stat of each image into the prompt as a requirement", () => {
    const p = scriptPrompt(ctx(), angle);
    expect(p).toMatch(/MAIN STAT OF EACH OF THE OPERATOR'S IMAGES \(MANDATORY\)/);
    expect(p).toContain("15.36 return on spend");
    expect(p).toContain("4.8 average rating");
  });

  it("links the image to the scene that says its main stat and records the coverage", () => {
    const lines = [`${words(12, "a")} opener.`, `The return on spend was 15.36 ${words(10, "b")}.`, `Rated 4.8 ${words(10, "c")}.`, `${words(14, "d")} Book an audit.`];
    const s = buildWrittenScript(raw(lines), angle, ctx());
    expect(s.scenes[1]!).toMatchObject({ assetId: "IMG" });
    expect(s.scenes[2]!).toMatchObject({ assetId: "TWO" });
    expect(s.imageStats).toHaveLength(2);
    expect(s.imageStats!.every((c) => c.said && c.shown)).toBe(true);
  });

  it("does not ask for the image's other numbers: a draft that says only the main stat is complete", async () => {
    const prompts: string[] = [];
    const lines = [`${words(14, "a")}.`, `The return on spend was 15.36 ${words(10, "b")}.`, `Rated 4.8 ${words(12, "c")}.`, `${words(10, "d")} Book an audit.`];
    await writeScriptForAngle(ctx(), angle, { generate: async (p) => (prompts.push(p), raw(lines)) });
    expect(prompts).toHaveLength(1);
  });

  it("asks again, naming the missing main stat, when a draft leaves it out", async () => {
    const prompts: string[] = [];
    const missing = [`${words(16, "a")}.`, `${words(14, "b")}.`, `Rated 4.8 ${words(16, "c")}.`, `${words(12, "d")} Book an audit.`];
    const full = [`${words(14, "a")}.`, `The return on spend was 15.36 ${words(10, "b")}.`, `Rated 4.8 ${words(12, "c")}.`, `${words(10, "d")} Book an audit.`];
    const drafts = [raw(missing), raw(full)];
    const script = await writeScriptForAngle(ctx(), angle, { generate: async (p) => (prompts.push(p), drafts.shift() ?? raw(full)) });
    expect(prompts[1]).toMatch(/MAIN STAT THAT MUST BE SAID/);
    expect(prompts[1]).toContain("15.36");
    expect(script.imageStats!.every((c) => c.said)).toBe(true);
  });

  it("never cuts a scene that carries an image stat when trimming for length", () => {
    const lines = [`${words(8, "a")}.`, `The return on spend was 15.36 ${words(40, "b")}.`, `${words(40, "c")}.`, `${words(40, "d")}.`, `${words(8, "e")} Book an audit.`];
    const s = buildWrittenScript(raw(lines), angle, ctx());
    expect(s.scenes[1]!.assetId).toBe("IMG");
    const out = trimToFit(s, { targetSeconds: 30, wordsPerSecond: 2.5 });
    expect(out.scenes.some((x) => x.assetId === "IMG")).toBe(true);
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

describe("making sure the main stat is said", () => {
  const scene = (number: number, line: string, extra: Partial<VideoScene> = {}): VideoScene => ({ number, start: 0, end: 3, seconds: 3, visual: "v", camera: "c", speaker: "voiceover", line, keywords: [], stat: null, assetId: null, sound: "", ...extra });
  const required = requiredStatsFrom([{ id: "IMG", name: "results.png", stats: [{ value: "5.25", label: "Conv. value / cost" }] }]);
  const base = (scenes: VideoScene[]) => ({ id: "s", title: "t", scenes, cta: { spoken: "Book an audit.", label: "Book Now", target: null, benefit: null }, speech: { requestedSeconds: 30 }, warnings: [], adCopy: { primaryText: "x", headline: "h", description: "d", cta: "Book Now" } }) as unknown as VideoScript;
  const ctx = { facts: "", assetIds: ["IMG"], targetSeconds: 30, wordsPerSecond: 2.5, brief: { locale: "en-AU" } };

  it("rewrites one scene to say it, shows the image there, and records the coverage", async () => {
    const { ensureMainStats } = await import("@/lib/video/script-writer");
    const calls: Array<{ n: number; feedback: string }> = [];
    const out = await ensureMainStats(base([scene(1, "Hook."), scene(2, "Middle one.", { assetId: "IMG" }), scene(3, "Middle two."), scene(4, "Book an audit.")]), required, ctx, {
      rewriteScene: async ({ sceneNumber, feedback, script }) => (calls.push({ n: sceneNumber, feedback }), { ...script.scenes[sceneNumber - 1]!, line: "In the account shown here, every dollar of cost returned 5.25 in conversion value." }),
    });
    expect(calls).toHaveLength(1);
    // the scene that already carried the image is the one that says it
    expect(calls[0]!.n).toBe(2);
    expect(calls[0]!.feedback).toContain("5.25");
    expect(calls[0]!.feedback).toMatch(/do not add a period, whose it is/);
    expect(out.scenes[1]).toMatchObject({ assetId: "IMG", stat: "5.25" });
    expect(out.imageStats![0]).toMatchObject({ said: true, shown: true, scene: 2 });
  });

  it("does nothing when the main stat is already said, and never touches the opening, the closing line or an edited scene", async () => {
    const { ensureMainStats } = await import("@/lib/video/script-writer");
    let called = 0;
    const said = await ensureMainStats(base([scene(1, "Hook."), scene(2, "That is 5.25 back per dollar."), scene(3, "Book an audit.")]), required, ctx, { rewriteScene: async () => (called += 1, scene(2, "x")) });
    expect(called).toBe(0);
    expect(said.imageStats![0]!.said).toBe(true);

    const calls: number[] = [];
    await ensureMainStats(base([scene(1, "Hook."), scene(2, "Mine.", { edited: true }), scene(3, "Middle."), scene(4, "Book an audit.")]), required, ctx, {
      rewriteScene: async ({ sceneNumber }) => (calls.push(sceneNumber), scene(sceneNumber, "Still nothing.")),
    });
    expect(calls.every((n) => n === 3)).toBe(true);
  });

  it("tries at most twice, then leaves the stat reported as missing instead of faking it", async () => {
    const { ensureMainStats } = await import("@/lib/video/script-writer");
    let calls = 0;
    const out = await ensureMainStats(base([scene(1, "Hook."), scene(2, "Middle one."), scene(3, "Middle two."), scene(4, "Book an audit.")]), required, ctx, {
      rewriteScene: async ({ sceneNumber }) => (calls += 1, scene(sceneNumber, "A line that never says the figure.")),
    });
    expect(calls).toBe(2);
    expect(out.imageStats![0]).toMatchObject({ said: false });
  });

  it("leaves an uploaded script's own words alone", async () => {
    const { ensureMainStats } = await import("@/lib/video/script-writer");
    let called = 0;
    const s = { ...base([scene(1, "Mine."), scene(2, "Also mine."), scene(3, "Done.")]), source: "uploaded" } as VideoScript;
    await ensureMainStats(s, required, ctx, { rewriteScene: async () => (called += 1, scene(2, "x")) });
    expect(called).toBe(0);
  });
});
