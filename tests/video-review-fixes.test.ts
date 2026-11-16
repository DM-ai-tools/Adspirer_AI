import { describe, expect, it, vi } from "vitest";
import type { VideoScene, VideoScript } from "@/lib/video/script";
import type { VideoConcept } from "@/lib/video/script-types";
import { retime } from "@/lib/video/timing";

vi.mock("@/lib/security/auth", () => ({ getCurrentUser: async () => ({ id: "u1" }) }));
vi.mock("@/lib/authz/assert", () => ({ assertAuthenticated: () => undefined, assertClientAccess: async () => undefined }));

const words = (n: number, tag = "w") => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(" ");

const scene = (n: number, line: string, extra: Partial<VideoScene> = {}): VideoScene => ({
  number: n,
  start: 0,
  end: 0,
  seconds: 0,
  visual: `visual ${n}`,
  camera: "c",
  speaker: line ? "voiceover" : "none",
  line,
  keywords: [],
  stat: null,
  assetId: null,
  sound: "",
  ...extra,
});

const scriptOf = (scenes: VideoScene[], over: Partial<VideoScript> = {}): VideoScript => {
  const timed = retime(scenes);
  return {
    id: "script_x",
    title: "t",
    angle: { key: "a", name: "a", stage: "", kind: "custom" },
    pain: "",
    framework: { key: "custom", name: "" },
    style: "s",
    durationSeconds: timed.at(-1)!.end,
    hookAlternatives: [],
    character: null,
    setting: "s",
    scenes: timed,
    adCopy: { primaryText: "p", headline: "h", description: "d", cta: "Learn More" },
    warnings: [],
    ...over,
  };
};

const concept: VideoConcept = {
  id: "concept_a",
  title: "A",
  format: "trailer",
  logline: "Idea A",
  hook: "h",
  beats: [{ text: "b", seconds: 5 }],
  whyItWorks: "w",
  brandLink: "l",
  look: "l",
  cast: [],
  settings: [],
  voices: [{ id: "narrator", who: "narrator", description: "" }],
  seconds: 20,
};

describe("opening a written script from the concepts screen", () => {
  it("puts the project back on the script so it can be changed and confirmed", { timeout: 30_000 }, async () => {
    const { createProject, getProject, updateProject } = await import("@/lib/video/projects");
    const { POST } = await import("@/app/api/creatives/video/[id]/concepts/route");
    const project = await createProject({ clientId: "c-open", inputs: { stats: [], targetSeconds: 30, style: "auto", locale: "en-AU", format: "9:16", priority: "balanced" } });
    await updateProject(project.id, {
      status: "concepts_ready",
      brand: { name: "Acme", colors: null, logoUrl: null, summary: null, concepts: [concept] },
      scripts: [scriptOf([scene(1, "Hello there."), scene(2, "Book now.")], { id: "script_concept_a", concept })],
    });
    const res = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "open", scriptId: "script_concept_a" }) }), { params: Promise.resolve({ id: project.id }) });
    expect(res.status).toBe(200);
    expect((await getProject(project.id))!.status).toBe("scripts_ready");
  });
});

describe("repairs keep who says what", () => {
  it("repairs each voice's words on their own", async () => {
    const { repairScript } = await import("@/lib/video/script-repairs");
    const s = scriptOf([
      scene(1, "Is this the best part? Book a call.", {
        speaker: "on_camera",
        lines: [
          { voiceId: "maya", text: "Is this the best part?", onCamera: true },
          { voiceId: "narrator", text: "Book a call.", onCamera: false },
        ],
      }),
    ]);
    const out = repairScript(s, "Book a call with us.");
    expect(out.scenes[0]!.lines).toEqual([
      { voiceId: "maya", text: "Is this the part?", onCamera: true },
      { voiceId: "narrator", text: "Book a call.", onCamera: false },
    ]);
    expect(out.scenes[0]!.line).toBe("Is this the part? Book a call.");
  });

  it("keeps the speakers when an edit changed the words inside one of them", async () => {
    const { syncSceneLines } = await import("@/lib/video/script-writer");
    const synced = syncSceneLines({
      line: "Found you at last. Book the inspection online today.",
      speaker: "on_camera",
      lines: [
        { voiceId: "maya", text: "Found you.", onCamera: true },
        { voiceId: "narrator", text: "Book the inspection online today.", onCamera: false },
      ],
    } as VideoScene);
    expect(synced.lines).toEqual([
      { voiceId: "maya", text: "Found you at last.", onCamera: true },
      { voiceId: "narrator", text: "Book the inspection online today.", onCamera: false },
    ]);
  });
});

describe("confirming", () => {
  const project = (status: string, script: VideoScript) =>
    ({ id: "p", client_id: "c", status, inputs: { stats: [], targetSeconds: 30, locale: "en-AU" }, assets: [], brand: null, scripts: [script] }) as never;

  it("splits an older script's long scene instead of refusing it", async () => {
    const { confirmScript } = await import("@/lib/video/script-actions");
    const s = scriptOf([scene(1, "Hello."), scene(2, `${words(25, "a")}. ${words(25, "b")}.`), scene(3, "Book now.")]);
    expect(s.scenes[1]!.seconds).toBeGreaterThan(15);
    const { chosen } = confirmScript(project("scripts_ready", s), { scriptId: s.id, edits: { title: s.title, scenes: s.scenes, adCopy: s.adCopy } });
    expect(chosen.scenes.every((x) => x.seconds <= 15)).toBe(true);
    expect(chosen.scenes.map((x) => x.line).join(" ")).toBe(s.scenes.map((x) => x.line).join(" "));
    expect(chosen.warnings.join(" ")).toMatch(/split/i);
  });

  it("only confirms a script that is ready, not while something is being written", async () => {
    const { confirmScript } = await import("@/lib/video/script-actions");
    const s = scriptOf([scene(1, "Hello."), scene(2, "Book now.")]);
    expect(() => confirmScript(project("writing", s), { scriptId: s.id, edits: { title: s.title, scenes: s.scenes, adCopy: s.adCopy } })).toThrow(/still working|wait/i);
  });
});

describe("a change naming a scene that does not exist", () => {
  it("is refused before the model is asked, whatever the model would have done", async () => {
    const { planChange } = await import("@/lib/video/change-request");
    const generate = vi.fn(async () => ({ scope: "voiceover", scenes: [1], summary: "Funnier", problem: "", edits: [{ scene: 1, lines: [{ voice_id: "narrator", text: "Ha.", on_camera: false }], visual: null, camera: null, sound: null }], ad_copy: null }));
    const s = scriptOf([scene(1, "Hello."), scene(2, "Hi."), scene(3, "Book now.")]);
    const plan = await planChange(s, "make scene 9 funnier", { facts: "" }, { generate });
    expect(plan.problem).toMatch(/scene 9/);
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("fitting a script that is a little long", () => {
  it("drops the smallest middle scene that brings it under the limit, not the longest", async () => {
    const { fitToModel } = await import("@/lib/video/fit-to-model");
    const s = scriptOf([scene(1, words(35, "a")), scene(2, words(35, "b")), scene(3, words(12, "c")), scene(4, words(35, "d")), scene(5, words(35, "e"))]);
    expect(s.durationSeconds).toBeGreaterThan(60);
    expect(s.durationSeconds - s.scenes[2]!.seconds).toBeLessThanOrEqual(60);
    const out = await fitToModel(s, { maxSeconds: 60, repicture: async () => ({}) });
    expect(out.script.scenes.map((x) => x.line)).toEqual([words(35, "a"), words(35, "b"), words(35, "d"), words(35, "e")]);
  });
});
