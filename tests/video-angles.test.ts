import { describe, expect, it, vi } from "vitest";
import { angleDistance, anglePlanSchema, anglePrompt, planAngles, selectDistinct, validateAngles } from "@/lib/video/angles";
import type { AnglePlan, BriefFact, CreativeBrief } from "@/lib/video/script-types";

vi.mock("@/lib/video/creative-brief", () => ({
  briefForPrompt: (brief: CreativeBrief) => `BRIEF-START offer=${brief.offer.name}\n${brief.facts.map((f) => `[${f.id}] ${f.text}`).join("\n")}\nBRIEF-END`,
}));

const fact = (id: string, text: string, category: BriefFact["category"] = "feature"): BriefFact => ({ id, text, category, source: { id: "s1", kind: "page", label: "Landing page", quote: text } });

function briefOf(facts: BriefFact[], overrides: Partial<CreativeBrief> = {}): CreativeBrief {
  return {
    version: 1,
    createdAt: "2026-01-01T00:00:00Z",
    company: { name: "Bluebird Bikes", source: "manifest" },
    offer: { name: "Monthly bike tune-up plan", description: "A mechanic services your bike every month", factIds: ["f1"] },
    conversion: { action: "Book the first tune-up", target: null, benefit: null, factIds: ["f1"] },
    audience: { primary: "city commuters who ride to work", situation: "riding a bike every day", factIds: [], inferred: true },
    mechanism: { plain: "A mechanic goes through a checklist on every visit", distinctive: false, factIds: ["f4"] },
    facts,
    inferences: [],
    rejectedFacts: [],
    voice: { tone: "friendly", vocabulary: [], avoid: [] },
    defaults: [],
    gaps: [],
    sourceQuality: "rich",
    limitation: null,
    injectionFlags: [],
    ...overrides,
  };
}

const FACTS = [
  fact("f1", "Book the first tune-up online in two minutes", "conversion"),
  fact("f2", "A mechanic services your bike every month", "mechanism"),
  fact("f3", "Repairs are included in the plan price", "price"),
  fact("f4", "Each service follows a checklist covering brakes, chain and tyres", "mechanism"),
  fact("f5", "The first inspection is free", "offer"),
];
const BRIEF = briefOf(FACTS);

const angle = (id: string, over: Partial<AnglePlan> = {}): AnglePlan => ({
  id,
  name: "name",
  situation: "daily commuter whose bike fails mid ride",
  tension: "cannot trust the bike to reach work on time",
  centralMessage: "A monthly tune-up keeps the bike reliable",
  hookPremise: "rider stuck at a red light while the gears skip",
  support: { text: "A mechanic services your bike every month", factIds: ["f2"] },
  tone: "relieved",
  reasonToAct: "Book the first tune-up",
  whyDifferent: "It starts from a breakdown in the street",
  ...over,
});

const A = angle("a", { name: "The red light skip" });
const B = angle("b", {
  name: "The winter bill",
  situation: "owner who ignores small noises until a part snaps",
  tension: "neglected small problems turn into expensive repairs",
  centralMessage: "Regular checks cost less than one big breakdown",
  hookPremise: "the hidden bill waiting at the end of winter",
  support: { text: "Repairs are included in the plan price", factIds: ["f3"] },
  tone: "wry",
});
const C = angle("c", {
  name: "Inside the service",
  situation: "curious beginner unsure what servicing involves",
  tension: "no idea what happens during a service",
  centralMessage: "Every service follows a clear checklist",
  hookPremise: "what a mechanic finds when a strangers bike is opened up",
  support: { text: "Checklist covers brakes, chain and tyres", factIds: ["f4"] },
  tone: "curious",
});
// A with one word swapped in every field and the same proof and tone: the same idea.
const A_SWAP = angle("a2", {
  name: "Red light trouble",
  situation: "everyday commuter whose bike breaks mid ride",
  tension: "cannot rely on the bike to reach work on time",
  centralMessage: "A monthly tune-up keeps the bike dependable",
  hookPremise: "rider waiting at a red light while the gears skip",
});

describe("anglePlanSchema", () => {
  it("requires every field and accepts a full angle", () => {
    const { id, ...rest } = A;
    void id;
    expect(anglePlanSchema.safeParse(rest).success).toBe(true);
    const { tone, ...missing } = rest;
    void tone;
    expect(anglePlanSchema.safeParse(missing).success).toBe(false);
  });
});

describe("angleDistance", () => {
  it("is near zero for a synonym swap", () => {
    expect(angleDistance(A, A).distance).toBe(0);
    const d = angleDistance(A, A_SWAP);
    expect(d.distance).toBeLessThan(0.3);
    expect(d.shared.length).toBeGreaterThan(3);
  });

  it("is large for different premises", () => {
    expect(angleDistance(A, B).distance).toBeGreaterThan(0.7);
    expect(angleDistance(B, C).distance).toBeGreaterThan(0.7);
  });
});

describe("validateAngles", () => {
  const codes = (issues: ReturnType<typeof validateAngles>, severity?: "error" | "warning") => issues.filter((i) => !severity || i.severity === severity).map((i) => i.code);

  it("passes three genuinely different, grounded angles", () => {
    expect(validateAngles([A, B, C], BRIEF).filter((i) => i.severity === "error")).toEqual([]);
  });

  it("errors on a fact id that does not exist", () => {
    const issues = validateAngles([A, angle("x", { ...B, support: { text: "Backed by a study", factIds: ["f99"] } })], BRIEF);
    const e = issues.find((i) => i.code === "unknown_fact")!;
    expect(e.severity).toBe("error");
    expect(e.message).toContain("f99");
  });

  it("errors on synonym swapped duplicates", () => {
    expect(codes(validateAngles([A, A_SWAP, C], BRIEF), "error")).toContain("duplicate_angle");
  });

  it("warns when the same proof supports every angle, and when the tone is the same", () => {
    const same = [A, { ...B, support: { ...B.support, factIds: ["f2"] }, tone: "relieved" }, { ...C, support: { ...C.support, factIds: ["f2"] }, tone: "relieved" }];
    const issues = validateAngles(same, BRIEF);
    expect(issues.find((i) => i.code === "shared_proof")?.severity).toBe("warning");
    expect(issues.find((i) => i.code === "same_tone")?.severity).toBe("warning");
  });

  it("errors on missing fields", () => {
    const issues = validateAngles([angle("m", { hookPremise: "  ", tone: "" })], BRIEF);
    expect(issues.filter((i) => i.code === "missing_field").map((i) => i.message).join(" ")).toMatch(/hookPremise[\s\S]*tone|tone[\s\S]*hookPremise/);
    expect(codes(issues, "error")).toContain("missing_field");
  });

  it("errors on urgency or free language no fact supports, but allows it when a cited fact says it", () => {
    const urgent = validateAngles([angle("u", { reasonToAct: "Hurry, the offer ends Friday" })], BRIEF);
    expect(codes(urgent, "error")).toContain("unsupported_offer_term");
    const free = validateAngles([angle("p", { reasonToAct: "Your first inspection is free", support: { text: "The first inspection is free", factIds: ["f5"] } })], BRIEF);
    expect(codes(free, "error")).not.toContain("unsupported_offer_term");
    const freeNoFact = validateAngles([angle("q", { reasonToAct: "Everything is free" })], BRIEF);
    expect(codes(freeNoFact, "error")).toContain("unsupported_offer_term");
  });
});

describe("selectDistinct", () => {
  it("picks the most distinct angles and drops the repeat", () => {
    const { selected, limitation } = selectDistinct([A, A_SWAP, B, C], 3, BRIEF);
    expect(limitation).toBeNull();
    expect(selected).toHaveLength(3);
    expect(selected.map((s) => s.id)).toContain("b");
    expect(selected.map((s) => s.id)).toContain("c");
    expect(selected.filter((s) => s.id === "a" || s.id === "a2")).toHaveLength(1);
  });

  it("keeps `keep` first", () => {
    const { selected } = selectDistinct([A, B, C], 2, BRIEF, [C]);
    expect(selected[0]!.id).toBe("c");
    expect(selected).toHaveLength(2);
  });

  it("returns fewer, with a plain limitation, when the source supports one idea", () => {
    const thin = briefOf(FACTS.slice(0, 2), { sourceQuality: "thin", limitation: "The page says little beyond the plan itself." });
    const { selected, limitation } = selectDistinct([A, A_SWAP, angle("a3", { name: "again" })], 3, thin);
    expect(selected).toHaveLength(1);
    expect(limitation).toMatch(/1 genuinely different angle/);
    expect(limitation).toContain("page says little");
  });

  it("never selects an angle that depends on a fact that does not exist", () => {
    const bad = angle("bad", { ...B, support: { text: "x", factIds: ["nope"] } });
    const { selected } = selectDistinct([A, bad, C], 3, BRIEF);
    expect(selected.map((s) => s.id)).toEqual(expect.not.arrayContaining(["bad"]));
    expect(selected).toHaveLength(2);
  });
});

describe("anglePrompt", () => {
  it("contains the brief, forbids invented proof and has no fixed angle list or examples", () => {
    const p = anglePrompt(BRIEF, { candidates: 6 });
    expect(p).toContain("BRIEF-START");
    expect(p).toContain("[f2] A mechanic services your bike every month");
    expect(p).toMatch(/6 candidate angles/);
    expect(p).toMatch(/Only use fact ids that exist/);
    expect(p).toMatch(/Do not invent proof/);
    expect(p).toMatch(/same proof/i);
    expect(p).toMatch(/Changing an adjective is not a new angle/);
    expect(p).toMatch(/cannot support/);
    expect(p).not.toMatch(/problem aware|unaware|most aware|solution aware|awareness stage/i);
    expect(p).not.toMatch(/for example|e\.g\.|example angle/i);
  });

  it("includes avoid, keep and direction when given", () => {
    const p = anglePrompt(BRIEF, { candidates: 4, avoid: [B], keep: [C], direction: "talk about saving time" });
    expect(p).toContain("AVOID");
    expect(p).toContain(B.hookPremise);
    expect(p).toContain("KEEP");
    expect(p).toContain(C.hookPremise);
    expect(p).toContain("talk about saving time");
    expect(anglePrompt(BRIEF, { candidates: 4 })).not.toMatch(/AVOID|KEEP/);
  });
});

describe("planAngles", () => {
  const strip = ({ id, ...rest }: AnglePlan) => {
    void id;
    return rest;
  };

  it("takes the best three from a good first response", async () => {
    const generate = vi.fn(async () => ({ angles: [A, A_SWAP, B, C].map(strip), limitation: null }));
    const out = await planAngles(BRIEF, {}, { generate });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(out.angles).toHaveLength(3);
    expect(out.limitation).toBeNull();
    expect(out.considered).toHaveLength(4);
    expect(new Set(out.angles.map((a) => a.id)).size).toBe(3);
    expect(out.angles.every((a) => /^angle_\d+$/.test(a.id))).toBe(true);
  });

  it("repairs a bad first response, feeding the issues into the second prompt", async () => {
    const bad = { ...strip(B), support: { text: "Backed by a study", factIds: ["f99"] } };
    const prompts: string[] = [];
    const generate = vi.fn(async (prompt: string) => {
      prompts.push(prompt);
      return prompts.length === 1 ? { angles: [strip(A), bad, strip(A_SWAP)], limitation: null } : { angles: [strip(B), strip(C)], limitation: null };
    });
    const out = await planAngles(BRIEF, {}, { generate });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(prompts[1]).toContain("f99");
    expect(prompts[1]).toContain("same idea in different words");
    expect(prompts[1]).toContain("KEEP");
    expect(out.angles).toHaveLength(3);
    expect(out.angles.find((a) => a.support.factIds.includes("f99"))).toBeUndefined();
  });

  it("stops at maxRepairs and returns a limitation", async () => {
    const generate = vi.fn(async () => ({ angles: [strip(A), strip(A_SWAP)], limitation: null }));
    const out = await planAngles(BRIEF, { maxRepairs: 2 }, { generate });
    expect(generate).toHaveBeenCalledTimes(3);
    expect(out.angles).toHaveLength(1);
    expect(out.limitation).toMatch(/genuinely different/);

    const once = vi.fn(async () => ({ angles: [strip(A)], limitation: null }));
    await planAngles(BRIEF, { maxRepairs: 0 }, { generate: once });
    expect(once).toHaveBeenCalledTimes(1);
  });

  it("returns the model's limitation when only one angle is supportable, without padding", async () => {
    const generate = vi.fn(async () => ({ angles: [strip(A)], limitation: "The page supports one idea: keeping the bike reliable." }));
    const out = await planAngles(BRIEF, {}, { generate });
    expect(out.angles).toHaveLength(1);
    expect(out.limitation).toContain("The page supports one idea");
    expect(generate.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("never invents fact ids and ignores malformed candidates", async () => {
    const generate = vi.fn(async () => ({ angles: [strip(A), { name: "half" }, strip(B), strip(C)], limitation: null }));
    const out = await planAngles(BRIEF, {}, { generate });
    const known = new Set(FACTS.map((f) => f.id));
    for (const a of out.considered) for (const id of a.support.factIds) expect(known.has(id)).toBe(true);
    expect(out.angles).toHaveLength(3);
  });

  it("keeps the angles it was told to keep and does not call the model when they already fill the count", async () => {
    const generate = vi.fn(async () => ({ angles: [], limitation: null }));
    const out = await planAngles(BRIEF, { count: 2, keep: [A, B] }, { generate });
    expect(generate).not.toHaveBeenCalled();
    expect(out.angles.map((a) => a.id)).toEqual(["a", "b"]);
  });

  it("throws a clear error when the model call fails on the first try", async () => {
    await expect(planAngles(BRIEF, {}, { generate: async () => { throw new Error("no model"); } })).rejects.toThrow("no model");
  });
});

describe("angles that rest on assertions no fact backs", () => {
  it("rejects a guarantee, a ranking, a success-story angle or a customer count that no fact supports", () => {
    const bad = [
      angle("g", { name: "Guaranteed results", centralMessage: "Results are guaranteed" }),
      angle("r", { name: "The best bike shop", centralMessage: "The best service in town" }),
      angle("s", { name: "Client success stories", situation: "riders who share success stories" }),
      angle("c", { name: "Trusted by many", centralMessage: "Thousands of riders rely on us" }),
    ];
    for (const a of bad) {
      expect(validateAngles([a], BRIEF).some((i) => i.code === "unsupported_offer_term" && i.severity === "error")).toBe(true);
    }
  });

  it("allows one when a fact the angle relies on says it", () => {
    const withGuarantee = briefOf([...FACTS, fact("f6", "Every service carries a 30 day workmanship guarantee", "condition")]);
    const ok = angle("g", { name: "A guarantee on the work", centralMessage: "Every service carries a guarantee", support: { text: "A 30 day workmanship guarantee", factIds: ["f6"] } });
    expect(validateAngles([ok], withGuarantee).some((i) => i.code === "unsupported_offer_term")).toBe(false);
  });
});
