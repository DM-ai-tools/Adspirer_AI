import { describe, expect, it, vi } from "vitest";
import { applyChange, planChange, undoChange, type ChangePlan } from "@/lib/video/change-request";
import type { VideoScene, VideoScript } from "@/lib/video/script";

const scene = (n: number, text: string, extra: Partial<VideoScene> = {}): VideoScene => ({
  number: n,
  start: (n - 1) * 4,
  end: n * 4,
  seconds: 4,
  visual: `visual ${n}`,
  camera: `camera ${n}`,
  speaker: "voiceover",
  line: text,
  keywords: [],
  stat: null,
  assetId: null,
  sound: `sound ${n}`,
  lines: text ? [{ voiceId: "narrator", text, onCamera: false }] : [],
  ...extra,
});

const script: VideoScript = {
  id: "script_concept_1",
  title: "The Hail Heist",
  angle: { key: "concept_1", name: "The Hail Heist", stage: "", kind: "custom" },
  pain: "",
  framework: { key: "concept_1", name: "" },
  style: "Cinematic heist",
  durationSeconds: 16,
  hookAlternatives: [],
  character: null,
  setting: "a roof",
  scenes: [scene(1, "Every job needs a plan."), scene(2, "They came at night."), scene(3, "", { speaker: "none" }), scene(4, "Book the inspection online.")],
  adCopy: { primaryText: "Hail is a quiet thief.", headline: "Catch the hail heist", description: "Book online", cta: "Book Now" },
  warnings: [],
  voices: [
    { id: "narrator", who: "narrator", description: "gravelly" },
    { id: "maya", who: "Maya the inspector", description: "calm" },
  ],
};

const plan = (over: Partial<ChangePlan>): ChangePlan => ({ scope: "scenes", scenes: [], summary: "", edits: [], adCopy: null, problem: null, ...over });

describe("applying a change", () => {
  it("rewrites every spoken line for a voiceover change and leaves every picture alone", () => {
    const out = applyChange(
      script,
      plan({
        scope: "voiceover",
        scenes: [1, 2, 4],
        summary: "Made the voiceover punchier",
        edits: [
          { scene: 1, lines: [{ voiceId: "narrator", text: "Every heist starts with a map.", onCamera: false }] },
          { scene: 2, lines: [{ voiceId: "narrator", text: "Tonight, the roof.", onCamera: false }] },
          { scene: 4, lines: [{ voiceId: "narrator", text: "Book the inspection online.", onCamera: false }] },
        ],
      }),
    );
    expect(out.scenes.map((s) => s.line)).toEqual(["Every heist starts with a map.", "Tonight, the roof.", "", "Book the inspection online."]);
    expect(out.scenes.map((s) => s.visual)).toEqual(script.scenes.map((s) => s.visual));
    expect(out.changeNote).toBe("Made the voiceover punchier");
  });

  it("changes only the named scene; the others keep their words, picture and voices", () => {
    const out = applyChange(script, plan({ scenes: [2], summary: "Scene 2 now has Maya", edits: [{ scene: 2, lines: [{ voiceId: "maya", text: "Found you.", onCamera: true }], visual: "Maya on the roof with a torch" }] }));
    const pick = (s: VideoScene) => ({ line: s.line, visual: s.visual, camera: s.camera, sound: s.sound, lines: s.lines });
    expect(pick(out.scenes[0]!)).toEqual(pick(script.scenes[0]!));
    expect(pick(out.scenes[2]!)).toEqual(pick(script.scenes[2]!));
    expect(pick(out.scenes[3]!)).toEqual(pick(script.scenes[3]!));
    expect(out.scenes[1]!.speaker).toBe("on_camera");
    expect(out.scenes[1]!.visual).toBe("Maya on the roof with a torch");
    expect(out.scenes[1]!.camera).toBe("camera 2");
  });

  it("gives a line said by an unknown voice to the scene's own voice", () => {
    const out = applyChange(script, plan({ scenes: [1], edits: [{ scene: 1, lines: [{ voiceId: "ghost", text: "Boo.", onCamera: false }] }] }));
    expect(out.scenes[0]!.lines![0]!.voiceId).toBe("narrator");
  });

  it("splits a scene the change made longer than 15 seconds", () => {
    const long = Array.from({ length: 70 }, (_, i) => `w${i}`).join(" ");
    const out = applyChange(script, plan({ scenes: [2], edits: [{ scene: 2, lines: [{ voiceId: "narrator", text: long, onCamera: false }] }] }));
    expect(out.scenes.every((s) => s.seconds <= 15)).toBe(true);
    expect(out.scenes.length).toBeGreaterThan(4);
  });

  it("changes the ad copy only when the change is about it, keeping its button", () => {
    const out = applyChange(script, plan({ scope: "ad_copy", adCopy: { primaryText: "New post", headline: "New headline", description: "New desc" } }));
    expect(out.adCopy).toEqual({ primaryText: "New post", headline: "New headline", description: "New desc", cta: "Book Now" });
    expect(out.scenes.map((s) => s.line)).toEqual(script.scenes.map((s) => s.line));
  });

  it("keeps the script as it was before, so the change can be undone exactly", () => {
    const out = applyChange(script, plan({ scenes: [1], edits: [{ scene: 1, lines: [{ voiceId: "narrator", text: "Changed.", onCamera: false }] }] }));
    const back = undoChange(out)!;
    expect(back).toEqual(script);
    expect(undoChange(script)).toBeNull();
  });

  it("changes nothing when the plan has a problem", () => {
    expect(applyChange(script, plan({ problem: "There is no scene 9.", edits: [{ scene: 1, lines: [] }] }))).toBe(script);
  });
});

describe("understanding a change request", () => {
  it("refuses a change to a scene that does not exist, and says so", async () => {
    const generate = vi.fn(async () => ({
      scope: "scenes",
      scenes: [9],
      summary: "Rewrote scene 9",
      problem: "",
      edits: [{ scene: 9, lines: [{ voice_id: "narrator", text: "x", on_camera: false }], visual: null, camera: null, sound: null }],
      ad_copy: null,
    }));
    const out = await planChange(script, "make scene 9 funnier", { facts: "Business: Kestrel" }, { generate });
    expect(out.problem).toMatch(/scene 9/i);
    expect(out.problem).toMatch(/4 scenes/);
  });

  it("drops edits to scenes the request did not touch", async () => {
    const generate = vi.fn(async () => ({
      scope: "scenes",
      scenes: [2],
      summary: "Scene 2 rewritten",
      problem: "",
      edits: [
        { scene: 2, lines: [{ voice_id: "maya", text: "Found you.", on_camera: true }], visual: null, camera: null, sound: null },
        { scene: 3, lines: null, visual: "something else", camera: null, sound: null },
      ],
      ad_copy: null,
    }));
    const out = await planChange(script, "let Maya say something in scene 2", { facts: "" }, { generate });
    expect(out.edits.map((e) => e.scene)).toEqual([2]);
    expect(out.edits[0]!.lines).toEqual([{ voiceId: "maya", text: "Found you.", onCamera: true }]);
  });

  it("gives the model the numbered scenes, the voices and the request", async () => {
    const generate = vi.fn(async (p: string) => ({ scope: "scenes", scenes: [], summary: p ? "" : "", problem: "Not clear what to change.", edits: [], ad_copy: null }));
    await planChange(script, "make it funnier", { facts: "Business: Kestrel" }, { generate });
    const prompt = generate.mock.calls[0]![0];
    expect(prompt).toContain("make it funnier");
    expect(prompt).toContain("Maya the inspector");
    expect(prompt).toMatch(/2\. .*They came at night\./);
  });

  it("never picks the concept scope for a script that has no concept", async () => {
    const generate = vi.fn(async () => ({ scope: "concept", scenes: [], summary: "A new idea", problem: "", edits: [], ad_copy: null }));
    const out = await planChange(script, "a totally different idea", { facts: "" }, { generate });
    expect(out.scope).not.toBe("concept");
    expect(out.problem).toMatch(/idea/i);
  });
});
