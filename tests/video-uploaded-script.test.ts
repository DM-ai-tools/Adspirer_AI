import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalisedWords, restoreVerbatim, unusedText, verbatimCheck } from "@/lib/video/verbatim";

const SCRIPT = `TITLE: The Audit
[SCENE 1 - desk, close up]
PRESENTER: I thought my Google Ads were working fine.
Turns out I had no idea where the budget was actually going.
[SCENE 2 - screen recording]
VO: Traffic Radius ran a free audit and found the leaks straight away. They manage over $120 million in ad spend.
PRESENTER: So if you're spending on ads, get yours checked.`;

describe("keeping the operator's words", () => {
  it("recognises lines that are exactly the script's words, in order", () => {
    const lines = ["I thought my Google Ads were working fine.", "Turns out I had no idea where the budget was actually going.", "Traffic Radius ran a free audit and found the leaks straight away.", "They manage over $120 million in ad spend.", "So if you're spending on ads, get yours checked."];
    const r = verbatimCheck(SCRIPT, lines);
    expect(r.ok).toBe(true);
    expect(r.altered).toEqual([]);
  });

  it("spots a line the model has reworded, one word changed or one dropped", () => {
    const lines = ["I thought my Google Ads were doing fine.", "Turns out I had no idea where the budget was going.", "Traffic Radius ran a free audit and found the leaks straight away."];
    expect(verbatimCheck(SCRIPT, lines).altered).toEqual([0, 1]);
  });

  it("puts the exact words back in a line that drifted, with the original's spelling and punctuation", () => {
    const lines = ["I thought my Google Ads were doing fine.", "Turns out I had no idea where the budget was going."];
    const out = restoreVerbatim(SCRIPT, lines);
    expect(out.lines[0]).toBe("I thought my Google Ads were working fine.");
    expect(out.lines[1]).toBe("Turns out I had no idea where the budget was actually going.");
    expect(out.restored).toEqual([0, 1]);
    // and the restored lines now pass the check
    expect(verbatimCheck(SCRIPT, out.lines).ok).toBe(true);
  });

  it("leaves a line alone when it is already exact", () => {
    const out = restoreVerbatim(SCRIPT, ["I thought my Google Ads were working fine."]);
    expect(out.restored).toEqual([]);
  });

  it("does not repair a line that has nothing to do with the script, so invented words are never kept", () => {
    const out = restoreVerbatim(SCRIPT, ["Our award winning team guarantees tenfold returns every single month."]);
    expect(out.restored).toEqual([]);
    expect(out.spans[0]).toBeNull();
  });

  it("reports the parts that were treated as directions, so nothing is lost silently", () => {
    const lines = ["I thought my Google Ads were working fine.", "Turns out I had no idea where the budget was actually going.", "Traffic Radius ran a free audit and found the leaks straight away. They manage over $120 million in ad spend.", "So if you're spending on ads, get yours checked."];
    const spans = verbatimCheck(SCRIPT, lines).spans;
    const unused = unusedText(SCRIPT, spans, 3);
    expect(unused.join(" | ")).toContain("[SCENE 2 - screen recording]");
    expect(unused.join(" ")).not.toContain("budget was actually going");
  });

  it("compares words ignoring case and punctuation", () => {
    expect(normalisedWords("Hello, World!")).toEqual(["hello", "world"]);
  });
});

// ---- the whole path, with the model mocked
let scenesFromModel: Array<Record<string, unknown>> = [];
let changeFromModel: Record<string, unknown> = { understood: "", scene_changes: [], ad_copy: null };
const prompts: string[] = [];

vi.mock("@/lib/creatives/service", () => ({
  loadScope: async () => ({ client: { id: "c1", name: "Acme", brand_voice: null, brand_colors: ["#37ca37"], website_url: null, target_audience: null, value_proposition: "Profit-first ads" }, service: null, brief: null }),
}));
vi.mock("@/lib/brand/analyze-url", () => ({ analyzeBrandFromUrl: async () => ({ brand_name: "Acme", colors: ["#37ca37"], logo_url: null, title: "Acme", summary: "Acme.", page_excerpt: "Acme runs ads." }) }));
vi.mock("@/lib/creatives/uploaded-logo", () => ({ loadUploadedLogoDataUri: async () => null }));
vi.mock("@/lib/creatives/concept-writer", async (orig) => ({ ...(await orig<typeof import("@/lib/creatives/concept-writer")>()), pickModel: () => ({}) }));
vi.mock("ai", () => ({
  generateObject: async ({ prompt }: { prompt: string }) => {
    prompts.push(prompt);
    if (prompt.includes("THE OPERATOR'S SCRIPT")) {
      return { object: { title: "The Audit", angle_key: "hidden_cost", pain: "wasted spend", framework_key: "custom", style: "UGC", character: "A man in his 30s", setting: "Home office", hook_alternatives: ["a", "b", "c"], scenes: scenesFromModel } };
    }
    if (prompt.includes("THE OPERATOR'S REQUEST")) return { object: changeFromModel };
    if (prompt.includes("Current ad copy")) return { object: { primary_text: "MODEL WROTE THIS", headline: "Find the leak", description: "Free audit", cta: "Learn More" } };
    return { object: {} };
  },
}));

const sc = (line: string, extra: Record<string, unknown> = {}) => ({ line, speaker: "on_camera", visual: "v", camera: "c", keywords: [], stat: null, asset_id: null, sound: "s", seconds: 3, ...extra });
const ctx = () => ({ facts: "f", assetIds: [], locale: "en-AU", model: {} as never });

describe("structuring an uploaded script", () => {
  beforeEach(() => {
    prompts.length = 0;
    changeFromModel = { understood: "", scene_changes: [], ad_copy: null };
  });

  it("keeps the words when the model splits them faithfully", async () => {
    scenesFromModel = [sc("I thought my Google Ads were working fine."), sc("Turns out I had no idea where the budget was actually going."), sc("Traffic Radius ran a free audit and found the leaks straight away. They manage over $120 million in ad spend.", { speaker: "voiceover", stat: "$120 million" }), sc("So if you're spending on ads, get yours checked.")];
    const { structureUploadedScript, assembleUploaded } = await import("@/lib/video/uploaded-script");
    const split = await structureUploadedScript(SCRIPT, ctx());
    expect(split.restoredScenes).toEqual([]);
    const script = assembleUploaded({ structured: split.structured, lines: split.lines, restoredScenes: split.restoredScenes, removedScenes: split.removedScenes, unused: split.unused, assetIds: [] });
    expect(script.source).toBe("uploaded");
    expect(script.scenes.map((s) => s.line).join(" ")).toBe(
      "I thought my Google Ads were working fine. Turns out I had no idea where the budget was actually going. Traffic Radius ran a free audit and found the leaks straight away. They manage over $120 million in ad spend. So if you're spending on ads, get yours checked.",
    );
    // lengths follow the words, and the directions were not turned into speech
    expect(script.scenes.every((s) => s.seconds >= 2)).toBe(true);
    expect(script.scenes.map((s) => s.line).join(" ")).not.toMatch(/SCENE|PRESENTER|VO:/);
    expect(split.unused.join(" ")).toContain("SCENE 2");
  });

  it("restores the operator's exact words when the model tidies them, and says which scenes", async () => {
    scenesFromModel = [sc("I thought my Google Ads were doing fine."), sc("Turns out I had no idea where the budget was going."), sc("Traffic Radius ran a free audit and found the leaks straight away."), sc("They manage over $120 million in ad spend."), sc("So if you are spending on ads, get yours checked.")];
    const { structureUploadedScript } = await import("@/lib/video/uploaded-script");
    const split = await structureUploadedScript(SCRIPT, ctx());
    expect(split.lines[0]).toBe("I thought my Google Ads were working fine.");
    expect(split.lines[1]).toBe("Turns out I had no idea where the budget was actually going.");
    expect(split.lines[4]).toBe("So if you're spending on ads, get yours checked.");
    expect(split.restoredScenes).toEqual([1, 2, 5]);
    // the model was asked a second time, naming what it had changed
    expect(prompts.filter((p) => p.includes("THE OPERATOR'S SCRIPT")).length).toBe(2);
    expect(prompts[1]).toContain("changed the operator's words");
  });

  it("removes a line the model made up", async () => {
    scenesFromModel = [sc("I thought my Google Ads were working fine."), sc("Our award winning team guarantees tenfold returns every single month."), sc("Turns out I had no idea where the budget was actually going.")];
    const { structureUploadedScript, assembleUploaded } = await import("@/lib/video/uploaded-script");
    const split = await structureUploadedScript(SCRIPT, ctx());
    expect(split.removedScenes).toEqual([2]);
    const script = assembleUploaded({ structured: split.structured, lines: split.lines, restoredScenes: split.restoredScenes, removedScenes: split.removedScenes, unused: split.unused, assetIds: [] });
    expect(script.scenes[1]!.line).toBe("");
    expect(script.scenes[1]!.speaker).toBe("none");
    expect(JSON.stringify(script)).not.toContain("tenfold");
  });

  it("uses the operator's ad copy exactly and writes only what is missing around it", async () => {
    scenesFromModel = [sc("I thought my Google Ads were working fine."), sc("Turns out I had no idea where the budget was actually going.")];
    const { structureUploadedScript, assembleUploaded, adCopyForUploaded } = await import("@/lib/video/uploaded-script");
    const split = await structureUploadedScript(SCRIPT, ctx());
    const script = assembleUploaded({ structured: split.structured, lines: split.lines, restoredScenes: [], removedScenes: [], unused: [], assetIds: [] });
    const mine = "My own primary text.\n\nSecond paragraph, exactly as I wrote it.";
    const copy = await adCopyForUploaded({ script, provided: mine, ctx: ctx() });
    expect(copy.primaryText).toBe(mine);
    expect(copy.headline).toBe("Find the leak");
    // with none given, it is written
    expect((await adCopyForUploaded({ script, provided: null, ctx: ctx() })).primaryText).toBe("MODEL WROTE THIS");
  });
});

describe("changes the operator asks for", () => {
  it("touches only what the request mentions, and keeps the original wording to put back", async () => {
    scenesFromModel = [sc("I thought my Google Ads were working fine."), sc("Turns out I had no idea where the budget was actually going."), sc("So if you're spending on ads, get yours checked.")];
    changeFromModel = { understood: "Make the last line shorter", scene_changes: [{ scene: 3, line: "Get your ads checked.", visual: null, camera: null, keywords: null, stat: null, sound: null }], ad_copy: null };
    const { structureUploadedScript, assembleUploaded, applyChangeRequest } = await import("@/lib/video/uploaded-script");
    const split = await structureUploadedScript(SCRIPT, ctx());
    const script = assembleUploaded({ structured: split.structured, lines: split.lines, restoredScenes: [], removedScenes: [], unused: [], assetIds: [] });
    const changed = await applyChangeRequest(script, "Make the last line shorter", ctx());
    expect(changed.scenes[0]!.line).toBe(script.scenes[0]!.line);
    expect(changed.scenes[1]!.line).toBe(script.scenes[1]!.line);
    expect(changed.scenes[2]!.line).toBe("Get your ads checked.");
    expect(changed.scenes[2]!.originalLine).toBe("So if you're spending on ads, get yours checked.");
    expect(changed.handling!.changes).toEqual([{ target: "Scene 3 words", was: "So if you're spending on ads, get yours checked.", now: "Get your ads checked." }]);
    // the length follows the new, shorter line
    expect(changed.scenes[2]!.seconds).toBeLessThanOrEqual(script.scenes[2]!.seconds);
  });

  it("changes nothing when the model returns nothing for a request that touches nothing", async () => {
    scenesFromModel = [sc("I thought my Google Ads were working fine."), sc("Turns out I had no idea where the budget was actually going.")];
    changeFromModel = { understood: "", scene_changes: [], ad_copy: null };
    const { structureUploadedScript, assembleUploaded, applyChangeRequest } = await import("@/lib/video/uploaded-script");
    const split = await structureUploadedScript(SCRIPT, ctx());
    const script = assembleUploaded({ structured: split.structured, lines: split.lines, restoredScenes: [], removedScenes: [], unused: [], assetIds: [] });
    const out = await applyChangeRequest(script, "keep it", ctx());
    expect(out.scenes.map((s) => s.line)).toEqual(script.scenes.map((s) => s.line));
    expect(out.handling!.changes).toEqual([]);
  });
});


const MY_COPY = ["My own copy.", "", "Exactly as I wrote it."].join("\n");

describe("a project made from an uploaded script", () => {
  it("is read, split and reviewed, never rewritten on its own, and the operator's ad copy is used as given", async () => {
    prompts.length = 0;
    scenesFromModel = [sc("I thought my Google Ads were doing fine."), sc("Turns out I had no idea where the budget was actually going."), sc("Traffic Radius ran a free audit and found the leaks straight away. They manage over $120 million in ad spend.", { speaker: "voiceover" }), sc("So if you're spending on ads, get yours checked.")];
    changeFromModel = { understood: "", scene_changes: [], ad_copy: null };
    const { createProject, getProject } = await import("@/lib/video/projects");
    const { writeProjectScripts } = await import("@/lib/video/brief");
    const project = await createProject({
      clientId: "c1",
      inputs: { landingPageUrl: "https://acme.test", stats: [], targetSeconds: 35, style: "auto", locale: "en-AU", format: "9:16", priority: "balanced", mode: "upload", scriptText: SCRIPT, adCopyText: MY_COPY, changeRequest: null },
    });
    await writeProjectScripts(project.id);
    const done = (await getProject(project.id))!;
    expect(done.status).toBe("scripts_ready");
    expect(done.scripts).toHaveLength(1);
    const script = done.scripts![0]!;
    expect(script.source).toBe("uploaded");
    expect(script.adCopy.primaryText).toBe(MY_COPY);
    // the model had reworded scene 1: the operator's words were put back
    expect(script.scenes[0]!.line).toBe("I thought my Google Ads were working fine.");
    expect(script.handling!.restoredScenes).toContain(1);
    expect(script.verification).toBeTruthy();
    // nothing was rewritten by the verifier
    expect(prompts.some((p) => p.includes("Rewrite ONLY scene"))).toBe(false);
    expect(done.progress?.stage).toBe("done");
  });
});
