import { describe, expect, it, vi } from "vitest";
import { warningsToIssues, verifyAndFix, checkOnly, type VerifyContext } from "@/lib/video/verify";
import { regenerateScene } from "@/lib/video/rewrite";
import type { VideoScript, VideoBrief } from "@/lib/video/script";

vi.mock("@/lib/creatives/concept-writer", async (orig) => ({ ...(await orig<typeof import("@/lib/creatives/concept-writer")>()), pickModel: () => ({}) }));

let reviewIssues: Array<Record<string, unknown>> = [];
const prompts: string[] = [];

vi.mock("ai", () => ({
  generateObject: async ({ prompt }: { prompt: string }) => {
    prompts.push(prompt);
    if (prompt.includes("strict reviewer")) return { object: { score: 6, summary: "Strong hook, weak middle.", issues: reviewIssues } };
    if (prompt.includes("Rewrite ONLY scene")) {
      return { object: { visual: "Presenter shrugs at the camera", camera: "Close-up", speaker: "on_camera", line: "Honestly, I'd no idea where it was going.", keywords: ["no idea"], stat: null, asset_id: null, sound: "quiet" } };
    }
    if (prompt.includes("Current ad copy")) {
      return { object: { primary_text: "I'd no idea where my budget was going.", headline: "Find the leak", description: "Free audit", cta: "Learn More" } };
    }
    return { object: {} };
  },
}));

const scene = (number: number, seconds: number, line: string) => ({
  number,
  start: 0,
  end: 0,
  seconds,
  visual: "A presenter at a desk",
  camera: "Medium",
  speaker: "on_camera" as const,
  line,
  keywords: [],
  stat: null,
  assetId: null,
  sound: "beat",
});

const COPY = [
  "I thought my Google Ads were fine. They weren't.",
  "",
  "Every month the budget went out and the leads came in, so I never looked closer. Then I got a free audit and found where nearly a third of it was leaking into clicks that never turn into customers.",
  "",
  "Traffic Radius tracks every dollar back to revenue, not just clicks, so you can see what's actually working. Over 1,500 brands use them to stop guessing and start growing.",
  "",
  "Grab a free audit and see where yours is going.",
].join("\n");

function script(lines: string[]): VideoScript {
  let t = 0;
  const scenes = lines.map((l, i) => {
    const secs = i === 0 ? 3 : 8;
    const s = scene(i + 1, secs, l);
    s.start = t;
    t += secs;
    s.end = t;
    return s;
  });
  return {
    id: "s1",
    title: "t",
    angle: { key: "pain", name: "Pain", stage: "Problem aware", kind: "pain" },
    pain: "wasted spend",
    framework: { key: "pas", name: "PAS" },
    style: "UGC",
    durationSeconds: t,
    hookAlternatives: ["a", "b", "c"],
    character: "A man in his 30s, grey tee",
    setting: "Home office",
    scenes,
    adCopy: { primaryText: COPY, headline: "h", description: "d", cta: "Learn More" },
    warnings: [],
  };
}

const ctx: VerifyContext = {
  brief: { locale: "en-AU" } as VideoBrief,
  facts: "Traffic Radius, 1,500 brands",
  corpus: "Traffic Radius 1,500 brands",
  assetIds: [],
  target: 35,
};

const NATURAL = ["I thought my ads were fine.", "Turns out I'd no idea where the money went.", "Then we ran a free audit and it showed us.", "It's not a big job, honestly.", "So I'd say give it a go."];

describe("the verifier", () => {
  it("turns rule warnings into issues tied to their scene, worst first", () => {
    const issues = warningsToIssues(["Scene 2 sounds like an ad, not a person (stock marketing words).", "Scene 3 states \"9,999\", which is not in your page or inputs.", "The ad copy is short (12 words); aim for 70 to 130."]);
    expect(issues.map((i) => i.scene)).toEqual([2, 3, null]);
    expect(issues[1]!.severity).toBe("high");
    expect(issues[1]!.area).toBe("claims");
    expect(issues[2]!.area).toBe("copy");
  });

  it("passes a clean script without rewriting anything", async () => {
    reviewIssues = [];
    prompts.length = 0;
    const out = await verifyAndFix(script(NATURAL), ctx);
    expect(out.verification!.verdict).toBe("passed");
    expect(out.verification!.score).toBe(6);
    expect(out.verification!.fixes).toEqual([]);
    expect(prompts.some((p) => p.includes("Rewrite ONLY scene"))).toBe(false);
  });

  it("rewrites a scene that sounds like an ad, and says what it fixed", async () => {
    reviewIssues = [];
    prompts.length = 0;
    const lines = [...NATURAL];
    lines[1] = "Discover the game-changing solution that will unlock your ad potential.";
    const out = await verifyAndFix(script(lines), ctx);
    expect(out.scenes[1]!.line).toBe("Honestly, I'd no idea where it was going.");
    // length, time slot and the other scenes are untouched
    expect(out.scenes[1]!.seconds).toBeGreaterThanOrEqual(2);
    expect(out.scenes[1]!.end).toBe(out.scenes[1]!.start + out.scenes[1]!.seconds);
    expect(out.scenes[2]!.start).toBe(out.scenes[1]!.end);
    expect(out.durationSeconds).toBe(out.scenes[out.scenes.length - 1]!.end);
    expect(out.scenes[0]!.line).toBe(NATURAL[0]);
    expect(out.verification!.fixes.map((f) => f.target)).toEqual(["Scene 2"]);
    expect(out.verification!.verdict).toBe("fixed");
  });

  it("acts on the AI reviewer's findings too, limited to the worst few scenes", async () => {
    reviewIssues = [1, 2, 3, 4, 5].map((n) => ({ scene: n, severity: n === 4 ? "high" : "medium", area: "flow", problem: `Scene ${n} drifts off the story.`, fix: "Tie it back to the pain." }));
    prompts.length = 0;
    const out = await verifyAndFix(script(NATURAL), ctx);
    const rewritten = out.verification!.fixes.filter((f) => f.target.startsWith("Scene"));
    expect(rewritten).toHaveLength(3);
    expect(rewritten.map((f) => f.target)).toContain("Scene 4");
  });

  it("rewrites weak ad copy when the reviewer flags it", async () => {
    reviewIssues = [{ scene: null, severity: "medium", area: "copy", problem: "The body repeats the hook.", fix: "Add the proof." }];
    const out = await verifyAndFix(script(NATURAL), ctx);
    expect(out.verification!.fixes.map((f) => f.target)).toContain("Ad copy");
    expect(out.adCopy.headline).toBe("Find the leak");
  });

  it("checkOnly reports without changing anything", async () => {
    reviewIssues = [{ scene: 2, severity: "medium", area: "tone", problem: "Sounds like a slogan.", fix: "Say it plainly." }];
    prompts.length = 0;
    const v = await checkOnly(script(NATURAL), ctx);
    expect(v.verdict).toBe("needs_review");
    expect(v.issues.find((i) => i.scene === 2)?.problem).toBe("Sounds like a slogan.");
    expect(prompts.some((p) => p.includes("Rewrite ONLY scene"))).toBe(false);
  });
});

describe("rewriting one scene", () => {
  it("keeps its time slot, passes the operator's feedback and the problems found, and fits the words to the seconds", async () => {
    prompts.length = 0;
    const s = script(NATURAL);
    const out = await regenerateScene({ script: s, sceneNumber: 3, feedback: "make it less salesy", issues: ["Scene 3 sounds like an ad."], ctx: { facts: "f", assetIds: [], locale: "en-AU" } });
    expect(out.number).toBe(3);
    expect(out.start).toBe(11);
    expect(out.end).toBe(out.start + out.seconds);
    const p = prompts[prompts.length - 1]!;
    expect(p).toContain("make it less salesy");
    expect(p).toContain("Scene 3 sounds like an ad.");
    expect(p).toContain("at most 35 words");
    expect(p).toContain("HOW THE SPOKEN LINES MUST SOUND");
  });
});
