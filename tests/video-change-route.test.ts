import { describe, expect, it, vi } from "vitest";
import { retime } from "@/lib/video/timing";
import type { VideoScene, VideoScript } from "@/lib/video/script";
import type { VideoConcept } from "@/lib/video/script-types";

vi.mock("@/lib/security/auth", () => ({ getCurrentUser: async () => ({ id: "u1" }) }));
vi.mock("@/lib/authz/assert", () => ({ assertAuthenticated: () => undefined, assertClientAccess: async () => undefined }));
// The model is stubbed: the request always rewrites scene 2's words.
vi.mock("@/lib/video/change-request", async (orig) => ({
  ...(await orig<typeof import("@/lib/video/change-request")>()),
  planChange: async () => ({ scope: "scenes", scenes: [2], summary: "Scene 2 rewritten", edits: [{ scene: 2, lines: [{ voiceId: "narrator", text: "A new middle.", onCamera: false }] }], adCopy: null, problem: null }),
}));

const scene = (n: number, text: string): VideoScene => ({
  number: n,
  start: 0,
  end: 0,
  seconds: 0,
  visual: `visual ${n}`,
  camera: "c",
  speaker: "voiceover",
  line: text,
  keywords: [],
  stat: null,
  assetId: null,
  sound: "",
  lines: [{ voiceId: "narrator", text, onCamera: false }],
});

const script = (): VideoScript => {
  const scenes = retime([scene(1, "Hello there."), scene(2, "The middle."), scene(3, "Book now.")]);
  return {
    id: "script_a",
    title: "t",
    angle: { key: "a", name: "a", stage: "", kind: "custom" },
    pain: "",
    framework: { key: "custom", name: "" },
    style: "s",
    durationSeconds: scenes.at(-1)!.end,
    hookAlternatives: [],
    character: null,
    setting: "s",
    scenes,
    adCopy: { primaryText: "p", headline: "h", description: "d", cta: "Book Now" },
    warnings: [],
    voices: [{ id: "narrator", who: "narrator", description: "" }],
  };
};

const concept = { id: "concept_a", title: "A", format: "f", logline: "l", hook: "h", beats: [{ text: "b", seconds: 4 }, { text: "c", seconds: 4 }], whyItWorks: "w", brandLink: "b", look: "l", cast: [], settings: [], voices: [{ id: "narrator", who: "narrator", description: "" }], seconds: 8 } as VideoConcept;
const inputs = { stats: [], targetSeconds: 30, style: "auto", locale: "en-AU", format: "9:16" as const, priority: "balanced" as const };

describe("a change with unsaved edits on screen", () => {
  it("keeps the operator's unsaved edit to another scene", { timeout: 30_000 }, async () => {
    const { createProject, getProject, updateProject } = await import("@/lib/video/projects");
    const { POST } = await import("@/app/api/creatives/video/[id]/change/route");
    const project = await createProject({ clientId: "c-change", inputs });
    const s = script();
    await updateProject(project.id, { status: "scripts_ready", scripts: [s] });
    const draft = { title: s.title, scenes: s.scenes.map((x) => (x.number === 1 ? { ...x, line: "My own opening.", lines: [{ voiceId: "narrator", text: "My own opening.", onCamera: false }] } : x)), adCopy: s.adCopy };
    const res = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ scriptId: s.id, request: "rewrite the middle", draft }) }), { params: Promise.resolve({ id: project.id }) });
    expect(res.status).toBe(200);
    const saved = (await getProject(project.id))!.scripts![0]!;
    expect(saved.scenes.map((x) => x.line)).toEqual(["My own opening.", "A new middle.", "Book now."]);
    expect(saved.scenes[0]!.edited).toBe(true);
  });
});

describe("going back to concepts after a video was made", () => {
  it("is refused for a failed video that already has a confirmed script", { timeout: 30_000 }, async () => {
    const { createProject, getProject, updateProject } = await import("@/lib/video/projects");
    const { POST } = await import("@/app/api/creatives/video/[id]/concepts/route");
    const project = await createProject({ clientId: "c-failed", inputs });
    await updateProject(project.id, { status: "failed", chosen_script: script(), scripts: [script()], brand: { name: "A", colors: null, logoUrl: null, summary: null, concepts: [concept] } });
    const res = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "back" }) }), { params: Promise.resolve({ id: project.id }) });
    expect(res.ok).toBe(false);
    expect((await getProject(project.id))!.status).toBe("failed");
  });
});
