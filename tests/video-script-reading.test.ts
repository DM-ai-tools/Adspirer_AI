import fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { spokenBlocks } from "@/lib/video/spoken-blocks";
import { verbatimCheck } from "@/lib/video/verbatim";

// A real script an operator pasted ("The Resignation"): 9 headed scenes, 20 spoken lines said by three people,
// each line under "Dialogue — Name:" or "Name:" with the words in quotes, then a closing voiceover.
// It failed with "No object generated: response did not match schema" because the reader's schema allowed
// at most 16 scenes and a correct 20-scene answer was thrown away. The model output below is what it really returned.
const SCRIPT = fs.readFileSync("tests/fixtures/dialogue-script.txt", "utf8");
const REAL_OUTPUT = JSON.parse(fs.readFileSync("tests/fixtures/dialogue-script-model-output.json", "utf8")) as Record<string, unknown> & { scenes: Array<Record<string, unknown>> };

const SPOKEN = [
  "I quit! Two years of doing my marketing agency's job!",
  "Sorry — you work for your agency?",
  "No! I pay them! My Google Ads spend keeps climbing, but revenue doesn't!",
  "Who builds the growth strategy?",
  "Me.",
  "Who plans the campaigns?",
  "Me!",
  "Who writes the creative briefs?",
  "Me! Midnight! Sundays!",
  "We manage his account.",
  "Manage? He's running your entire marketing department!",
  "We send monthly reports.",
  "So he does the thinking, and you send a PDF?",
  "Exactly! And nobody can tell me what's actually working!",
  "That's not a growth partner. That's an expensive inbox.",
  "Bit harsh.",
  "Harsh? I run an online shop. I wrote my own Google Ads strategy last night!",
  "You too?",
  "Move over. I'm quitting with you!",
  "Your business needs a growth partner, not another job. Traffic Radius. Book your free strategy call and find out what's holding back your growth.",
];

describe("reading a script that labels who speaks", () => {
  it("finds every spoken line, one at a time, without the speaker's name", () => {
    const blocks = spokenBlocks(SCRIPT);
    expect(blocks.map((b) => b.text)).toEqual(SPOKEN);
  });
  it("tells a voiceover from a person on camera, and keeps the name", () => {
    const blocks = spokenBlocks(SCRIPT);
    expect(blocks[0]).toMatchObject({ speaker: "on_camera", name: "Founder" });
    expect(blocks[1]).toMatchObject({ speaker: "on_camera", name: "HR Manager" });
    expect(blocks.at(-1)).toMatchObject({ speaker: "voiceover" });
  });
  it("does not read a direction as speech", () => {
    const text = spokenBlocks(SCRIPT).map((b) => b.text).join(" ");
    expect(text).not.toMatch(/Visual direction|Camera direction|Sound:|Acting direction/i);
  });
});

// ---- the model call, with the real schema check the SDK does
type Behaviour = (call: number, prompt: string) => unknown;
let behaviour: Behaviour = () => REAL_OUTPUT;
const calls: string[] = [];

vi.mock("@/lib/creatives/concept-writer", async (orig) => ({ ...(await orig<typeof import("@/lib/creatives/concept-writer")>()), pickModel: () => ({}) }));
vi.mock("ai", () => ({
  generateObject: async ({ schema, prompt }: { schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: { message: string } } }; prompt: string }) => {
    calls.push(prompt);
    const out = behaviour(calls.length, prompt);
    if (out instanceof Error) throw out;
    const parsed = schema.safeParse(out);
    if (!parsed.success) throw Object.assign(new Error("No object generated: response did not match schema."), { name: "AI_NoObjectGeneratedError", cause: new Error(`Type validation failed: Error message: ${parsed.error?.message}`) });
    return { object: parsed.data };
  },
}));

const ctx = () => ({ facts: "Business: Traffic Radius", assetIds: [], locale: "en-AU", model: {} as never });
const spokenOf = (lines: string[]) => lines.filter((l) => l.trim());

describe("a script with more scenes than the old schema allowed", () => {
  beforeEach(() => {
    calls.length = 0;
    behaviour = () => REAL_OUTPUT;
  });

  it("is read: all 20 scenes come through with every word kept", async () => {
    const { structureUploadedScript } = await import("@/lib/video/uploaded-script");
    const split = await structureUploadedScript(SCRIPT, ctx());
    expect(split.structured.scenes).toHaveLength(20);
    expect(spokenOf(split.lines)).toEqual(SPOKEN);
    expect(verbatimCheck(SCRIPT, split.lines).ok).toBe(true);
    expect(split.usedRules).toBeFalsy();
  });

  it("accepts an answer whose lists are off the old limits and puts them right", async () => {
    behaviour = () => ({
      ...REAL_OUTPUT,
      hook_alternatives: ["only one"],
      scenes: REAL_OUTPUT.scenes.map((s, i) => ({ ...s, keywords: ["a", "b", "c", "d", "e"], seconds: i === 0 ? 40 : 1, speaker: i === 1 ? "HR Manager" : s.speaker })),
    });
    const { structureUploadedScript, assembleUploaded } = await import("@/lib/video/uploaded-script");
    const split = await structureUploadedScript(SCRIPT, ctx());
    const script = assembleUploaded({ structured: split.structured, lines: split.lines, restoredScenes: split.restoredScenes, removedScenes: split.removedScenes, unused: split.unused, assetIds: [] });
    expect(script.hookAlternatives).toHaveLength(3);
    expect(script.scenes.every((s) => s.keywords.length <= 3)).toBe(true);
    expect(script.scenes[1]!.speaker).toBe("on_camera");
    expect(script.scenes).toHaveLength(20);
  });

  it("asks again, naming what was wrong, when an answer does not fit", async () => {
    behaviour = (n) => (n === 1 ? { title: "x" } : REAL_OUTPUT);
    const { structureUploadedScript } = await import("@/lib/video/uploaded-script");
    const split = await structureUploadedScript(SCRIPT, ctx());
    expect(split.structured.scenes).toHaveLength(20);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[1]).toMatch(/rejected|did not fit|fix/i);
    expect(split.usedRules).toBeFalsy();
  });

  it("never fails: when the model cannot give a usable answer the script is split by rules, every line kept", async () => {
    behaviour = () => new Error("model is down");
    const { structureUploadedScript, assembleUploaded } = await import("@/lib/video/uploaded-script");
    const split = await structureUploadedScript(SCRIPT, ctx());
    expect(split.usedRules).toBe(true);
    expect(spokenOf(split.lines)).toEqual(SPOKEN);
    const script = assembleUploaded({ structured: split.structured, lines: split.lines, restoredScenes: split.restoredScenes, removedScenes: split.removedScenes, unused: split.unused, assetIds: [], warnings: ["rules"] });
    expect(script.scenes).toHaveLength(20);
    // each scene carries the script's own direction for its beat
    expect(script.scenes[0]!.visual).toMatch(/storms into the room/i);
    expect(script.scenes[0]!.camera).toMatch(/wide cinematic office shot/i);
    expect(script.scenes[0]!.sound).toMatch(/box impact/i);
    expect(script.scenes[19]!.visual).toMatch(/closed meeting room door/i);
    expect(script.scenes[19]!.speaker).toBe("voiceover");
    expect(script.warnings).toContain("rules");
    // the script's character and look notes are kept for the plan
    expect(script.character).toMatch(/Founder/);
    expect(script.character).toMatch(/HR Manager/);
    expect(script.style.length).toBeGreaterThan(10);
  });

  it("names who speaks at the start of each scene's picture when the model is not used", async () => {
    behaviour = () => new Error("down");
    const { structureUploadedScript } = await import("@/lib/video/uploaded-script");
    const split = await structureUploadedScript(SCRIPT, ctx());
    expect(split.structured.scenes[1]!.visual).toMatch(/^HR Manager/);
    expect(split.structured.scenes[2]!.visual).toMatch(/^Founder/);
  });
});

describe("any text at all", () => {
  beforeEach(() => {
    calls.length = 0;
    behaviour = () => new Error("model is down");
  });

  it("plain sentences with no labels become scenes with all the words", async () => {
    const text = "Most business owners pay an agency and still do the thinking themselves. Here is what changes when a real growth partner takes over. Book your free strategy call today and find out what is holding your growth back.";
    const { structureUploadedScript } = await import("@/lib/video/uploaded-script");
    const split = await structureUploadedScript(text, ctx());
    expect(split.usedRules).toBe(true);
    expect(split.structured.scenes.length).toBeGreaterThanOrEqual(2);
    expect(spokenOf(split.lines).join(" ")).toBe(text);
  });

  it("a script with a scene heading style of its own is split at the headings", async () => {
    const text = ["TITLE: The Audit", "[SCENE 1 - desk, close up]", "PRESENTER: I thought my Google Ads were working fine.", "[SCENE 2 - screen]", "VO: Traffic Radius ran a free audit and found the leaks straight away."].join("\n");
    const { structureUploadedScript } = await import("@/lib/video/uploaded-script");
    const split = await structureUploadedScript(text, ctx());
    expect(split.structured.scenes).toHaveLength(2);
    expect(split.structured.title).toBe("The Audit");
    expect(split.lines).toEqual(["I thought my Google Ads were working fine.", "Traffic Radius ran a free audit and found the leaks straight away."]);
    expect(split.structured.scenes[1]!.speaker).toBe("voiceover");
  });
});

describe("a change request that does not fit the old limits", () => {
  it("accepts more than 16 scene changes and a button name it does not know", async () => {
    behaviour = (_n, p) => (p.includes("THE OPERATOR'S SCRIPT") ? REAL_OUTPUT : { understood: "x", scene_changes: Array.from({ length: 20 }, (_, i) => ({ scene: i + 1, line: null, visual: "same", camera: null, keywords: null, stat: null, sound: null })), ad_copy: { primary_text: null, headline: "Hi", description: null, cta: "Chat With Us Now" } });
    calls.length = 0;
    const { structureUploadedScript, assembleUploaded, applyChangeRequest } = await import("@/lib/video/uploaded-script");
    const split = await structureUploadedScript(SCRIPT, ctx());
    const script = assembleUploaded({ structured: split.structured, lines: split.lines, restoredScenes: [], removedScenes: [], unused: [], assetIds: [] });
    const changed = await applyChangeRequest(script, "make every picture brighter", ctx());
    expect(changed.scenes).toHaveLength(20);
    expect(changed.scenes[19]!.visual).toBe("same");
    expect(changed.adCopy.headline).toBe("Hi");
    expect(changed.adCopy.cta).toBe(script.adCopy.cta);
  });
});

describe("the two-minute cap", () => {
  it("keeps every line of the 20-line script: it runs about 71 seconds, which now fits", async () => {
    behaviour = (_n, p) => (p.includes("THE OPERATOR'S SCRIPT") ? REAL_OUTPUT : {});
    const { MAX_SECONDS } = await import("@/lib/video/script");
    const { structureUploadedScript, assembleUploaded } = await import("@/lib/video/uploaded-script");
    const { fitToModel } = await import("@/lib/video/fit-to-model");
    expect(MAX_SECONDS).toBe(120);
    const split = await structureUploadedScript(SCRIPT, ctx());
    const script = assembleUploaded({ structured: split.structured, lines: split.lines, restoredScenes: [], removedScenes: [], unused: [], assetIds: [] });
    const out = await fitToModel(script, { maxSeconds: MAX_SECONDS, repicture: async () => ({}) });
    expect(out.script.scenes).toHaveLength(20);
    expect(out.adaptations.join(" ")).not.toMatch(/left out/);
  });
});
