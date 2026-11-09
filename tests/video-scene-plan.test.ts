import { describe, expect, it, vi } from "vitest";
import type { ApprovedClaim, CreativePlan, PlanIssue, ProviderCapabilities, SceneBrief } from "@/lib/video/pipeline-types";

vi.mock("@/lib/creatives/concept-writer", () => ({ pickModel: () => null }));

import {
  planCreative,
  planModelSchema,
  planPrompt,
  planSignature,
  redesignScene,
  sceneForShot,
  validatePlan,
  type PlanInput,
  type ValidateCtx,
} from "@/lib/video/scene-plan";

// ------------------------------------------------------------------ fixtures (made-up product, tests only)

const CAPS: ProviderCapabilities = {
  referenceImages: true,
  firstLastFrame: true,
  nativeAudio: true,
  ssml: false,
  phonemeDictionary: false,
  lipSync: "native_model_audio",
  transcription: true,
  visionReview: true,
  perspectiveScreenTracking: false,
  gaps: ["No perspective tracking of screens inside footage"],
};

const CLAIMS: ApprovedClaim[] = [
  {
    id: "claim_households",
    text: "10,000 households switched",
    kind: "number",
    figure: "10,000",
    evidence: "10,000 households switched",
    provenance: { source: "page_text", detail: "hero", confidence: "high" },
  },
];

const SCRIPT_SCENES: PlanInput["script"]["scenes"] = [
  { number: 1, line: "Our old kettle took forever to boil.", seconds: 3, speaker: "voiceover", keywords: [], stat: null, assetId: null, visual: "v1", camera: "c1", sound: "" },
  { number: 2, line: "So we found a faster way.", seconds: 3, speaker: "on_camera", keywords: [], stat: null, assetId: null, visual: "v2", camera: "c2", sound: "" },
  { number: 3, line: "It boils a litre in ninety seconds.", seconds: 3, speaker: "on_camera", keywords: [], stat: null, assetId: null, visual: "v3", camera: "c3", sound: "" },
  { number: 4, line: "Ten thousand households already switched.", seconds: 3, speaker: "voiceover", keywords: [], stat: "10,000", assetId: "asset_proof", visual: "v4", camera: "c4", sound: "" },
  { number: 5, line: "Order yours today.", seconds: 2, speaker: "voiceover", keywords: [], stat: null, assetId: null, visual: "v5", camera: "c5", sound: "" },
];

const INPUT: PlanInput = {
  brandName: "Tidewell",
  product: "Fast-boil kettle",
  audience: "Busy families",
  offer: "Free delivery this month",
  platform: "Instagram Reels",
  objective: "Drive orders",
  targetSeconds: 35,
  locale: "en-AU",
  script: { style: "UGC", character: "Maya, thirties", setting: "a home", scenes: SCRIPT_SCENES },
  assets: [{ id: "asset_proof", name: "Proof card", summary: "A card showing the household count", stats: [{ value: "10,000", label: "households" }] }],
  claims: CLAIMS,
  capabilities: CAPS,
  maxSeconds: 60,
};

const CTX: ValidateCtx = {
  scriptScenes: SCRIPT_SCENES,
  assetIds: ["asset_proof"],
  claimIds: ["claim_households"],
  maxSeconds: 60,
  capabilities: CAPS,
  claims: CLAIMS,
};

function brief(number: number, over: Partial<SceneBrief> = {}): SceneBrief {
  const line = SCRIPT_SCENES.find((s) => s.number === number)?.line ?? "";
  return {
    number,
    purpose: `Purpose of beat ${number}`,
    informationAdded: `Unique idea ${number}`,
    narration: line,
    subject: "subject",
    setting: "setting",
    action: "does one thing",
    framing: "medium shot",
    camera: "slow push in",
    lighting: "soft window light",
    style: "natural",
    characterId: null,
    environmentId: "e1",
    requiredAssets: [],
    overlays: [],
    screenTreatment: "none",
    seconds: 3,
    durationBasis: "narration length",
    entry: { mode: "cut", condition: "cut in" },
    exit: { condition: "action completes" },
    transition: { kind: "cut", rationale: "" },
    risks: ["drift"],
    acceptance: ["subject stays centred in frame"],
    ...over,
  };
}

function goodPlan(): Omit<CreativePlan, "validation"> {
  return {
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    basis: { product: INPUT.product, audience: INPUT.audience, offer: INPUT.offer, platform: INPUT.platform, objective: INPUT.objective, targetSeconds: 35, assetIds: ["asset_proof"] },
    narrative: { approach: "Kitchen impatience turns into a quick win", whyItFits: "Families watch muted on a phone", arc: ["wait", "switch", "proof", "ask"] },
    characters: [{ id: "maya", description: "Maya, thirties, grey cardigan", role: "narrator" }],
    environments: [
      { id: "e1", description: "A morning kitchen", sceneNumbers: [1] },
      { id: "e2", description: "A workbench in a garage", sceneNumbers: [2, 3] },
      { id: "e3", description: "A front porch at dusk", sceneNumbers: [4, 5] },
    ],
    scenes: [
      brief(1, {
        purpose: "Open on the shared frustration of waiting",
        informationAdded: "The pain of a slow morning routine",
        subject: "A dented steel kettle on a stovetop",
        setting: "A cramped morning kitchen with a steamed window",
        action: "A hand lifts the kettle lid and lets it fall",
        framing: "Tight close-up from above",
        environmentId: "e1",
      }),
      brief(2, {
        purpose: "Introduce the person who found the answer",
        informationAdded: "A credible neighbour recommends a fix",
        subject: "Maya holding a boxed kettle",
        setting: "A tidy garage workbench with pegboard behind",
        action: "She sets the box on the bench",
        framing: "Medium shot at eye level",
        camera: "Gentle handheld drift",
        characterId: "maya",
        environmentId: "e2",
        transition: { kind: "match_cut", rationale: "Her box lands where the next shot opens" },
      }),
      brief(3, {
        purpose: "Demonstrate speed with a visible steam plume",
        informationAdded: "The speed of the new kettle in use",
        subject: "The new kettle with steam rising",
        setting: "The same workbench, close to the socket",
        action: "Steam rises from the spout",
        framing: "Low angle close-up",
        characterId: "maya",
        environmentId: "e2",
        entry: { mode: "continue_previous", condition: "same bench, same hands, kettle already set down" },
      }),
      brief(4, {
        purpose: "Back the claim with verified proof",
        informationAdded: "Social proof from thousands of buyers",
        subject: "A row of front doors in a quiet suburb",
        setting: "A suburban street at dusk",
        action: "A courier places a parcel on a step",
        framing: "Wide establishing shot",
        camera: "Slow lateral track",
        environmentId: "e3",
        requiredAssets: [{ assetId: "asset_proof", use: "overlay_inset" }],
        overlays: [{ kind: "stat", text: "10,000", claimId: "claim_households" }],
        screenTreatment: "composite_verified_asset",
        seconds: 4,
      }),
      brief(5, {
        purpose: "Give one clear next step",
        informationAdded: "A simple call to order today",
        subject: "Maya at her front door smiling at the camera",
        setting: "A porch with warm lamp light at dusk",
        action: "She waves once",
        framing: "Medium close-up",
        characterId: "maya",
        environmentId: "e3",
        seconds: 2,
        overlays: [{ kind: "cta", text: "Order today" }],
      }),
    ],
  };
}

const clone = <T,>(x: T): T => structuredClone(x);
const mutate = (fn: (p: Omit<CreativePlan, "validation">) => void) => {
  const p = clone(goodPlan());
  fn(p);
  return p;
};
const codes = (issues: PlanIssue[], severity?: "error" | "warning") => issues.filter((i) => !severity || i.severity === severity).map((i) => i.code);
const scene = (p: Omit<CreativePlan, "validation">, n: number) => p.scenes.find((s) => s.number === n)!;

/** The shape the planning model returns for a plan. */
function toModel(p: Omit<CreativePlan, "validation">) {
  return {
    narrative: p.narrative,
    characters: p.characters,
    environments: p.environments,
    scenes: p.scenes.map((s) => ({
      ...s,
      overlays: s.overlays.map((o) => ({ kind: o.kind, text: o.text ?? null, claimId: o.claimId ?? null, assetId: o.assetId ?? null })),
    })),
  };
}

// ------------------------------------------------------------------ validator

describe("validatePlan", () => {
  it("accepts a good, varied plan", () => {
    const issues = validatePlan(goodPlan(), CTX);
    expect(codes(issues, "error")).toEqual([]);
    expect(codes(issues, "warning")).toEqual([]);
    expect(planModelSchema.safeParse(toModel(goodPlan())).success).toBe(true);
  });

  it("flags filler clichés as errors", () => {
    const patterns = [
      "Hands typing on a laptop keyboard",
      "A floating holographic dashboard of numbers",
      "A stock office montage of colleagues",
      "A glowing laptop screen in a dark room",
      "A cardboard UI object on a desk",
    ];
    for (const subject of patterns) {
      const issues = validatePlan(mutate((p) => (scene(p, 1).subject = subject)), CTX);
      expect(codes(issues, "error").some((c) => c.startsWith("filler_")), subject).toBe(true);
    }
  });

  it("lets a filler pattern through when the purpose justifies it, or when it is negated", () => {
    const justified = mutate((p) => {
      scene(p, 1).subject = "Hands typing on a laptop keyboard";
      scene(p, 1).purpose = "The keyboard is deliberately shown because the story is about the founder's late nights";
    });
    expect(codes(validatePlan(justified, CTX), "error").some((c) => c.startsWith("filler_"))).toBe(false);
    const negated = mutate((p) => (scene(p, 1).action = "A hand lifts the lid, with no floating dashboard anywhere"));
    expect(codes(validatePlan(negated, CTX), "error").some((c) => c.startsWith("filler_"))).toBe(false);
  });

  it("flags a setting repeated too many scenes in a row and by share", () => {
    const repeated = mutate((p) => {
      for (const n of [1, 2, 3, 4]) scene(p, n).environmentId = "e2";
      p.environments = [{ id: "e2", description: "bench", sceneNumbers: [1, 2, 3, 4] }, { id: "e3", description: "porch", sceneNumbers: [5] }];
      scene(p, 5).environmentId = "e3";
    });
    const issues = validatePlan(repeated, CTX);
    expect(codes(issues, "error")).toContain("environment_repeated");
    expect(codes(issues, "error")).toContain("environment_share");
  });

  it("treats near-identical setting text as the same place even with different ids", () => {
    const p = mutate((plan) => {
      for (const n of [1, 2, 3, 4]) {
        scene(plan, n).setting = "A modern open plan office with big windows";
        scene(plan, n).environmentId = `env_${n}`;
      }
      plan.environments = [1, 2, 3, 4].map((n) => ({ id: `env_${n}`, description: "office", sceneNumbers: [n] })).concat([{ id: "e3", description: "porch", sceneNumbers: [5] }]);
      scene(plan, 3).entry = { mode: "cut", condition: "cut" };
    });
    expect(codes(validatePlan(p, CTX), "error")).toContain("environment_repeated");
  });

  it("warns when the same framing on the same subject repeats back to back", () => {
    const p = mutate((plan) => {
      scene(plan, 2).framing = scene(plan, 1).framing;
      scene(plan, 2).subject = scene(plan, 1).subject;
    });
    expect(codes(validatePlan(p, CTX), "warning")).toContain("same_shot_repeated");
  });

  it("flags two scenes that add the same information", () => {
    const p = mutate((plan) => (scene(plan, 2).informationAdded = "The pain of a slow morning routine felt again"));
    expect(codes(validatePlan(p, CTX), "error")).toContain("filler_duplicate_information");
  });

  it("flags a screen or result scene with no screen treatment", () => {
    const p = mutate((plan) => {
      scene(plan, 3).purpose = "Show the dashboard result so the viewer believes it";
      scene(plan, 3).screenTreatment = "none";
    });
    expect(codes(validatePlan(p, CTX), "error")).toContain("screen_treatment_missing");
    const carrying = mutate((plan) => (scene(plan, 4).screenTreatment = "none"));
    expect(codes(validatePlan(carrying, CTX), "error")).toContain("screen_treatment_missing");
  });

  it("flags composite_verified_asset with no required asset", () => {
    const p = mutate((plan) => {
      scene(plan, 4).requiredAssets = [];
    });
    expect(codes(validatePlan(p, CTX), "error")).toContain("composite_without_asset");
  });

  it("accepts footage_without_screen for a screen scene", () => {
    const p = mutate((plan) => {
      scene(plan, 3).purpose = "Show that the report finally made sense to Maya";
      scene(plan, 3).screenTreatment = "footage_without_screen";
    });
    expect(codes(validatePlan(p, CTX), "error")).toEqual([]);
  });

  it("flags unknown asset and claim ids", () => {
    const p = mutate((plan) => {
      scene(plan, 4).requiredAssets = [{ assetId: "asset_missing", use: "overlay_full" }];
      scene(plan, 4).overlays = [{ kind: "stat", text: "10,000", claimId: "claim_nope" }, { kind: "image", assetId: "ghost" }];
    });
    const errs = codes(validatePlan(p, CTX), "error");
    expect(errs.filter((c) => c === "unknown_asset").length).toBe(2);
    expect(errs).toContain("unknown_claim");
  });

  it("flags a stat figure the referenced claim does not back", () => {
    const wrong = mutate((plan) => (scene(plan, 4).overlays = [{ kind: "stat", text: "12,000", claimId: "claim_households" }]));
    expect(codes(validatePlan(wrong, CTX), "error")).toContain("stat_unsupported");
    const none = mutate((plan) => (scene(plan, 4).overlays = [{ kind: "stat", text: "10,000" }]));
    expect(codes(validatePlan(none, CTX), "error")).toContain("stat_without_claim");
  });

  it("warns on more than one primary action", () => {
    for (const action of [
      "She picks up the mug, then pours water into it",
      "She waves while she smiles while she walks",
      "She opens the box and lifts the kettle and plugs it in and sits down",
    ]) {
      const p = mutate((plan) => (scene(plan, 2).action = action));
      expect(codes(validatePlan(p, CTX), "warning"), action).toContain("multi_action");
    }
  });

  it("warns on a risky action unless an acceptance check names the risk", () => {
    const risky = mutate((plan) => (scene(plan, 2).action = "She touches her face and smiles"));
    expect(codes(validatePlan(risky, CTX), "warning")).toContain("risk_face_touch");
    const covered = mutate((plan) => {
      scene(plan, 2).action = "She touches her face and smiles";
      scene(plan, 2).acceptance = ["Face features stay intact and undistorted while the hand touches it"];
    });
    expect(codes(validatePlan(covered, CTX), "warning")).not.toContain("risk_face_touch");
    for (const [action, code] of [
      ["She covers her mouth", "risk_cover_face"],
      ["Overlapping hands rest on the bench", "risk_overlap_hands"],
      ["He makes a rapid head turn toward the door", "risk_head_turn"],
      ["She counts on her fingers", "risk_finger_gesture"],
      ["He hands over the box", "risk_hand_over"],
    ] as const) {
      const p = mutate((plan) => (scene(plan, 2).action = action));
      expect(codes(validatePlan(p, CTX), "warning"), action).toContain(code);
    }
  });

  it("requires the narration to be the script line verbatim", () => {
    const p = mutate((plan) => (scene(plan, 1).narration = "Our old kettle was slow."));
    expect(codes(validatePlan(p, CTX), "error")).toContain("narration_mismatch");
    const spaced = mutate((plan) => (scene(plan, 1).narration = "  Our old kettle   took forever to boil. "));
    expect(codes(validatePlan(spaced, CTX), "error")).not.toContain("narration_mismatch");
  });

  it("flags a missing, duplicated or unknown scene brief", () => {
    const missing = mutate((plan) => (plan.scenes = plan.scenes.filter((s) => s.number !== 3)));
    expect(codes(validatePlan(missing, CTX), "error")).toContain("scene_missing");
    const dup = mutate((plan) => plan.scenes.push(brief(2)));
    expect(codes(validatePlan(dup, CTX), "error")).toContain("scene_duplicate");
    const unknown = mutate((plan) => plan.scenes.push(brief(9, { narration: "x" })));
    expect(codes(validatePlan(unknown, CTX), "error")).toContain("scene_unknown");
  });

  it("flags empty required fields", () => {
    const p = mutate((plan) => {
      scene(plan, 1).purpose = " ";
      scene(plan, 1).lighting = "";
    });
    const errs = codes(validatePlan(p, CTX), "error");
    expect(errs).toContain("empty_purpose");
    expect(errs).toContain("empty_lighting");
  });

  it("flags a duration shorter than the narration needs, and warns about dead holds", () => {
    const short = mutate((plan) => (scene(plan, 1).seconds = 1));
    expect(codes(validatePlan(short, CTX), "error")).toContain("duration_too_short");
    const long = mutate((plan) => (scene(plan, 5).seconds = 9));
    expect(codes(validatePlan(long, CTX), "warning")).toContain("duration_dead_hold");
  });

  it("flags continue_previous across different environments or characters, and on the first scene", () => {
    const across = mutate((plan) => (scene(plan, 2).entry = { mode: "continue_previous", condition: "same moment" }));
    expect(codes(validatePlan(across, CTX), "error")).toContain("continue_mismatch");
    const first = mutate((plan) => (scene(plan, 1).entry = { mode: "continue_previous", condition: "x" }));
    expect(codes(validatePlan(first, CTX), "error")).toContain("continue_first");
    const character = mutate((plan) => (scene(plan, 3).characterId = null));
    expect(codes(validatePlan(character, CTX), "error")).toContain("continue_mismatch");
  });

  it("flags a non-cut transition with no rationale, and warns on decorative transitions", () => {
    const bare = mutate((plan) => (scene(plan, 1).transition = { kind: "dissolve", rationale: "" }));
    expect(codes(validatePlan(bare, CTX), "error")).toContain("transition_no_rationale");
    const decor = mutate((plan) => {
      for (const s of plan.scenes) s.transition = { kind: "dissolve", rationale: "looks nice" };
    });
    expect(codes(validatePlan(decor, CTX), "warning")).toContain("decorative_transitions");
  });

  it("flags a total over the maximum", () => {
    expect(codes(validatePlan(goodPlan(), { ...CTX, maxSeconds: 10 }), "error")).toContain("over_max_seconds");
  });

  it("flags unknown character and environment ids and inconsistent environment scene numbers", () => {
    const ids = mutate((plan) => {
      scene(plan, 2).characterId = "nobody";
      scene(plan, 1).environmentId = "nowhere";
    });
    const errs = codes(validatePlan(ids, CTX), "error");
    expect(errs).toContain("unknown_character");
    expect(errs).toContain("unknown_environment");
    const nums = mutate((plan) => {
      plan.environments[0]!.sceneNumbers = [1, 7];
      plan.environments[1]!.sceneNumbers = [2];
    });
    const numErrs = codes(validatePlan(nums, CTX), "error");
    expect(numErrs).toContain("environment_scene_unknown");
    expect(numErrs).toContain("environment_scene_unlisted");
    const mism = mutate((plan) => (plan.environments[0]!.sceneNumbers = [1, 2]));
    expect(codes(validatePlan(mism, CTX), "error")).toContain("environment_scene_mismatch");
  });

  it("warns when acceptance or risks are empty", () => {
    const p = mutate((plan) => {
      scene(plan, 1).acceptance = [];
      scene(plan, 1).risks = [];
    });
    const warns = codes(validatePlan(p, CTX), "warning");
    expect(warns).toContain("no_acceptance");
    expect(warns).toContain("no_risks");
  });

  it("is deterministic and every issue explains what to change", () => {
    const p = mutate((plan) => {
      scene(plan, 1).subject = "Hands typing on a laptop keyboard";
      scene(plan, 2).narration = "different";
    });
    const a = validatePlan(p, CTX);
    expect(validatePlan(p, CTX)).toEqual(a);
    for (const i of a) {
      expect(i.code).toBeTruthy();
      expect(i.message.length).toBeGreaterThan(20);
    }
  });
});

// ------------------------------------------------------------------ prompt

describe("planPrompt", () => {
  it("hands the model the real inputs", () => {
    const prompt = planPrompt(INPUT);
    for (const needle of ["asset_proof", "claim_households", "Instagram Reels", "35 seconds", "Fast-boil kettle", "Busy families", "Free delivery this month", "Our old kettle took forever to boil.", "No perspective tracking"]) {
      expect(prompt, needle).toContain(needle);
    }
    expect(prompt).toContain("composite_verified_asset");
    expect(prompt).toContain("footage_without_screen");
    expect(prompt).toContain("continue_previous");
  });

  it("forces no storyboard and no scene count", () => {
    const prompt = planPrompt(INPUT);
    expect(prompt).not.toMatch(/\b\d+\s+scenes?\b/i);
    expect(prompt).not.toMatch(/\b(exactly|precisely)\s+\d+/i);
    expect(prompt).toMatch(/not default to a problem-and-solution/i);
    const lonely = planPrompt({ ...INPUT, script: { ...INPUT.script, scenes: SCRIPT_SCENES.slice(0, 2) } });
    expect(lonely).not.toMatch(/\b\d+\s+scenes?\b/i);
  });

  it("lists repair issues only when given", () => {
    expect(planPrompt(INPUT)).not.toContain("PREVIOUS PLAN");
    const repair: PlanIssue[] = [{ scene: 2, code: "multi_action", severity: "warning", message: "Keep ONE observable action." }];
    const prompt = planPrompt(INPUT, repair);
    expect(prompt).toContain("PREVIOUS PLAN");
    expect(prompt).toContain("Keep ONE observable action.");
    expect(prompt).toContain("scene 2");
  });
});

// ------------------------------------------------------------------ planCreative

describe("planCreative", () => {
  const fixedNow = () => "2026-02-02T00:00:00.000Z";

  it("returns a valid plan from a good first response", async () => {
    const generate = vi.fn(async () => toModel(goodPlan()));
    const plan = await planCreative(INPUT, { generate, now: fixedNow });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(plan.validation.ok).toBe(true);
    expect(plan.validation.checkedAt).toBe(fixedNow());
    expect(plan.basis.assetIds).toEqual(["asset_proof"]);
    expect(plan.basis.platform).toBe("Instagram Reels");
    expect(sceneForShot(plan, 3)?.number).toBe(3);
    expect(sceneForShot(plan, 99)).toBeUndefined();
  });

  it("repairs a bad first response using the issues in the second prompt", async () => {
    const bad = mutate((p) => (scene(p, 1).subject = "Hands typing on a laptop keyboard"));
    const prompts: string[] = [];
    const generate = vi.fn(async (prompt: string) => {
      prompts.push(prompt);
      return toModel(prompts.length === 1 ? bad : goodPlan());
    });
    const plan = await planCreative(INPUT, { generate, now: fixedNow });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(prompts[0]).not.toContain("PREVIOUS PLAN");
    expect(prompts[1]).toContain("PREVIOUS PLAN");
    expect(prompts[1]).toContain("interchangeable filler");
    expect(plan.validation.ok).toBe(true);
  });

  it("stops after maxRepairs and returns the failing plan with its issues", async () => {
    const bad = mutate((p) => (scene(p, 1).subject = "Hands typing on a laptop keyboard"));
    const generate = vi.fn(async () => toModel(bad));
    const plan = await planCreative(INPUT, { generate, maxRepairs: 1, now: fixedNow });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(plan.validation.ok).toBe(false);
    expect(plan.validation.issues.some((i) => i.severity === "error")).toBe(true);
    expect(plan.scenes).toHaveLength(5);
  });

  it("defaults to two repairs", async () => {
    const bad = mutate((p) => (scene(p, 1).subject = "Hands typing on a laptop keyboard"));
    const generate = vi.fn(async () => toModel(bad));
    await planCreative(INPUT, { generate, now: fixedNow });
    expect(generate).toHaveBeenCalledTimes(3);
  });

  it("returns an unusable plan as not ok when the model never matches the schema", async () => {
    const generate = vi.fn(async () => ({ nonsense: true }));
    const plan = await planCreative(INPUT, { generate, maxRepairs: 1, now: fixedNow });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(plan.validation.ok).toBe(false);
    expect(plan.validation.issues[0]?.code).toBe("schema_invalid");
  });

  it("sanitises ids and restores whitespace-different narration to the script's words", async () => {
    const odd = toModel(goodPlan());
    odd.characters[0]!.id = "Maya Jones!";
    for (const s of odd.scenes) if (s.characterId) s.characterId = "Maya Jones!";
    odd.scenes[0]!.narration = " Our old kettle   took forever to boil. ";
    const plan = await planCreative(INPUT, { generate: async () => odd, now: fixedNow });
    expect(plan.characters[0]!.id).toBe("maya_jones");
    expect(sceneForShot(plan, 2)!.characterId).toBe("maya_jones");
    expect(sceneForShot(plan, 1)!.narration).toBe("Our old kettle took forever to boil.");
    expect(plan.validation.ok).toBe(true);
  });

  it("throws a clear error when no model is configured and no generator is injected", async () => {
    await expect(planCreative(INPUT)).rejects.toThrow(/No language model is configured/);
  });

  it("gives different signatures for plans made from different inputs", async () => {
    const other: PlanInput = { ...INPUT, product: "Cold-brew bottle", audience: "Gym regulars" };
    const planB = mutate((p) => {
      p.narrative.approach = "A gym-bag ritual told through close sensory details";
      scene(p, 1).setting = "A locker room bench with a gym bag";
      scene(p, 1).subject = "A cold-brew bottle sweating in a gym bag";
      scene(p, 2).framing = "Over-the-shoulder shot";
    });
    const a = await planCreative(INPUT, { generate: async () => toModel(goodPlan()), now: fixedNow });
    const b = await planCreative(other, { generate: async () => toModel(planB), now: fixedNow });
    expect(planSignature(a)).not.toEqual(planSignature(b));
    expect(planSignature(a)).toEqual(planSignature(a));
    expect(b.basis.product).toBe("Cold-brew bottle");
  });
});

// ------------------------------------------------------------------ redesignScene

describe("redesignScene", () => {
  it("redesigns one scene, keeping narration, seconds and the rest of the plan", async () => {
    const base = await planCreative(INPUT, { generate: async () => toModel(goodPlan()), now: () => "t0" });
    const original = sceneForShot(base, 2)!;
    const replacement = {
      ...toModel(goodPlan()).scenes[1]!,
      number: 99,
      narration: "Totally different words",
      seconds: 9,
      subject: "The boxed kettle on a bench, no person in frame",
      action: "The lid of the box slides open on its own weight",
      framing: "Top-down close-up",
      characterId: null,
    };
    const generate = vi.fn(async (_prompt: string) => ({ scene: replacement, newEnvironment: null }));
    const next = await redesignScene(INPUT, base, 2, ["Her hands warped while she set the box down"], { generate, now: () => "t1" });
    const prompt = generate.mock.calls[0]![0];
    expect(prompt).toContain("Her hands warped");
    expect(prompt).toContain("REDESIGN ONE SCENE");

    const redone = sceneForShot(next, 2)!;
    expect(redone.number).toBe(2);
    expect(redone.narration).toBe(original.narration);
    expect(redone.seconds).toBe(original.seconds);
    expect(redone.action).toBe("The lid of the box slides open on its own weight");
    expect(redone.characterId).toBeNull();
    // everything else is untouched
    for (const n of [1, 3, 4, 5]) expect(sceneForShot(next, n)).toEqual(sceneForShot(base, n));
    expect(next.narrative).toEqual(base.narrative);
    expect(next.validation.checkedAt).toBe("t1");
  });

  it("adds a new environment when the redesign needs one and re-validates", async () => {
    const base = await planCreative(INPUT, { generate: async () => toModel(goodPlan()), now: () => "t0" });
    const replacement = { ...toModel(goodPlan()).scenes[0]!, environmentId: "e9", setting: "A bright laundromat counter" };
    const next = await redesignScene(INPUT, base, 1, ["Steam looked fake"], {
      generate: async () => ({ scene: replacement, newEnvironment: { id: "e9", description: "A laundromat" } }),
      now: () => "t1",
    });
    expect(next.environments.find((e) => e.id === "e9")?.sceneNumbers).toEqual([1]);
    expect(next.environments.find((e) => e.id === "e1")).toBeUndefined();
    expect(next.validation.ok).toBe(true);
  });

  it("keeps the plan and reports an issue when the model returns something unusable", async () => {
    const base = await planCreative(INPUT, { generate: async () => toModel(goodPlan()), now: () => "t0" });
    const next = await redesignScene(INPUT, base, 2, ["x"], { generate: async () => ({}), now: () => "t1" });
    expect(next.scenes).toEqual(base.scenes);
    expect(next.validation.ok).toBe(false);
    expect(next.validation.issues.some((i) => i.code === "schema_invalid")).toBe(true);
  });

  it("throws for a scene that is not in the plan", async () => {
    const base = await planCreative(INPUT, { generate: async () => toModel(goodPlan()), now: () => "t0" });
    await expect(redesignScene(INPUT, base, 42, [], { generate: async () => ({}) })).rejects.toThrow(/not in the plan/);
  });
});
