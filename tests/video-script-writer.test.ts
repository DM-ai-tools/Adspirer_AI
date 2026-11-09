import { describe, expect, it } from "vitest";
import { buildWrittenScript, lockedScenes, scriptPrompt, trimToFit, writeScriptForAngle, writeScriptSet, writtenSchema, type WriteContext, type WrittenScript } from "@/lib/video/script-writer";
import type { VideoBrief, VideoScript } from "@/lib/video/script";
import type { AnglePlan, CreativeBrief } from "@/lib/video/script-types";

const source = (id: string, quote: string) => ({ id, kind: "page" as const, label: "Landing page", quote });

const creative: CreativeBrief = {
  version: 1,
  createdAt: "",
  company: { name: "Kestrel Roofing", source: "brand manifest" },
  offer: { name: "Storm damage roof inspection", description: "A same-week inspection with a written report", factIds: ["f3"] },
  conversion: { action: "Book a roof inspection", target: "kestrelroofing.example/inspect", benefit: "a written report with photos", factIds: ["f3"] },
  audience: { primary: "Homeowners after a hailstorm", situation: "They see granules in the gutter and do not know if the roof is damaged", factIds: ["f1"], inferred: false },
  mechanism: { plain: "A crew climbs the roof, photographs each damaged area and writes up what insurance needs", distinctive: true, factIds: ["f2"] },
  facts: [
    { id: "f1", text: "Hail damage is often invisible from the ground", category: "problem", source: source("p", "Hail damage is often invisible from the ground") },
    { id: "f2", text: "The crew photographs every damaged area and writes a report for your insurer", category: "mechanism", source: source("p", "We photograph every damaged area and write the report for your insurer") },
    { id: "f3", text: "Inspections are booked online and happen within the week", category: "conversion", source: source("p", "Book online. Inspections happen within the week.") },
  ],
  inferences: [],
  rejectedFacts: [],
  voice: { tone: "plain and practical", vocabulary: ["roof", "hail", "insurer"], avoid: [] },
  defaults: [],
  gaps: [],
  sourceQuality: "rich",
  limitation: null,
  injectionFlags: [],
};

const brief: VideoBrief = { brandName: "Kestrel Roofing", offerName: "Storm damage roof inspection", stats: [], images: [], targetSeconds: 30, style: "auto", locale: "en-AU" };

const ctx = (over: Partial<WriteContext> = {}): WriteContext => ({
  creative,
  brief,
  targetSeconds: 30,
  wordsPerSecond: 2.5,
  assetIds: [],
  claims: [],
  sourceText: "Hail damage is often invisible from the ground. We photograph every damaged area and write the report for your insurer. Book online. Inspections happen within the week.",
  facts: "Business: Kestrel Roofing",
  corpus: "Kestrel Roofing storm damage roof inspection",
  ...over,
});

const angle: AnglePlan = {
  id: "invisible",
  name: "Damage you cannot see from the ground",
  situation: "A homeowner finds granules in the gutter after hail",
  tension: "They cannot tell whether the roof is damaged, and insurers want proof",
  centralMessage: "You cannot judge hail damage from the ground, so someone has to go up and document it",
  hookPremise: "The gutter granules that look like nothing",
  support: { text: "The crew photographs every damaged area and writes the report for the insurer", factIds: ["f2"] },
  tone: "calm and practical",
  reasonToAct: "The report is what a claim needs",
  whyDifferent: "Starts from the evidence in the gutter, not from the cost of a new roof",
};

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

function raw(lines: string[], over: Partial<WrittenScript> = {}): WrittenScript {
  return {
    title: "Gutter granules",
    hook_candidates: [
      { line: lines[0]!, why: "Starts from what they see" },
      { line: "Granules in the gutter after a storm are a clue.", why: "A clue framing" },
      { line: "Look at what the hail left in your gutter.", why: "An instruction" },
      { line: "Hail does not always leave dents.", why: "A surprise that is supported" },
    ],
    chosen_hook: 0,
    hook_payoff: "The crew goes up and documents what the granules point to",
    style: "Documentary",
    dramatisation: true,
    character: null,
    setting: "A driveway after a storm, overcast light",
    scenes: lines.map((line, i) => ({ seconds: 4, visual: `Shot ${i + 1}`, camera: "static", speaker: "voiceover" as const, line, keywords: [], stat: null, asset_id: null, sound: "room tone" })),
    visual_direction: "Hands sorting granules from a gutter, then a crew member on a roof photographing a hail mark.",
    on_screen: ["written report"],
    cta: { spoken: "Book the inspection online.", label: "Book Now", target: "kestrelroofing.example/inspect", benefit: "a written report with photos" },
    sources: [{ claim: "The crew photographs every damaged area", fact_id: "f2" }, { claim: "not a real fact", fact_id: "nope" }],
    primary_text: "Granules in the gutter after hail are a clue. ".repeat(12),
    headline: "Check the roof you cannot see",
    description: "Written report",
    ...over,
  };
}

describe("the prompt for one version", () => {
  it("gives the model this angle, the sourced facts and a word budget, and no sample copy to imitate", () => {
    const p = scriptPrompt(ctx(), angle);
    expect(p).toContain("Damage you cannot see from the ground");
    expect(p).toContain("A homeowner finds granules in the gutter after hail");
    expect(p).toContain("f2");
    expect(p).toMatch(/words of narration/);
    expect(p).toMatch(/never rely on the narrator speaking fast/i);
    // principles, not example lines: nothing in the prompt can be copied as a hook
    expect(p).not.toMatch(/Honestly\?/);
    expect(p).not.toMatch(/had no idea where half my/);
  });

  it("asks for several openings, a chosen one that is paid off, one real call to action and honest labelling", () => {
    const p = scriptPrompt(ctx(), angle);
    expect(p).toMatch(/several different opening lines/i);
    expect(p).toMatch(/paid off/i);
    expect(p).toMatch(/ONE primary call to action/);
    expect(p).toMatch(/dramatisation/i);
    expect(p).toMatch(/Do not invent limited availability, deadlines, discounts, guarantees or free offers/);
  });

  it("changes with the angle and the budget it is given", () => {
    const other: AnglePlan = { ...angle, id: "cost", name: "What waiting costs", situation: "A claim deadline is close", centralMessage: "Claims have time limits" };
    expect(scriptPrompt(ctx(), other)).toContain("What waiting costs");
    expect(scriptPrompt(ctx(), other)).not.toContain("Damage you cannot see from the ground");
    expect(scriptPrompt(ctx({ targetSeconds: 15 }), angle)).not.toBe(scriptPrompt(ctx({ targetSeconds: 45 }), angle));
  });

  it("keeps the operator's edited scenes and other versions' openings in view", () => {
    const previous = { scenes: [{ number: 1, line: "Mine.", visual: "v", camera: "c", speaker: "voiceover", seconds: 3, start: 0, end: 3, keywords: [], stat: null, assetId: null, sound: "", edited: true }, { number: 2, line: "Theirs.", visual: "v", camera: "c", speaker: "voiceover", seconds: 3, start: 3, end: 6, keywords: [], stat: null, assetId: null, sound: "" }] } as unknown as VideoScript;
    const p = scriptPrompt(ctx(), angle, { previous, avoidOpenings: ["Another version opens here."] });
    expect(p).toMatch(/approved by the operator: keep exactly/);
    expect(p).toContain("Another version opens here.");
    expect(lockedScenes(previous).map((s) => s.number)).toEqual([1]);
  });
});

describe("turning the draft into a version", () => {
  const lines = ["Granules in the gutter after hail are not nothing.", "Hail damage is often invisible from the ground.", "So a crew goes up, photographs every damaged area and writes the report your insurer needs.", "Book the inspection online."];

  it("records the opening that was chosen and what the others were", () => {
    const s = buildWrittenScript(raw(lines), angle, ctx());
    expect(s.hook!.line).toBe(lines[0]);
    expect(s.hook!.candidates.filter((c) => c.chosen)).toHaveLength(1);
    expect(s.hookAlternatives).toHaveLength(3);
    expect(s.hookAlternatives).not.toContain(lines[0]);
    expect(s.hook!.payoff).toMatch(/documents/);
  });

  it("uses what is actually spoken first if the model's chosen opening drifted from the scenes", () => {
    const s = buildWrittenScript(raw(["Something quite different from any candidate.", ...lines.slice(1)]), angle, ctx());
    expect(s.hook!.line).toBe("Something quite different from any candidate.");
    expect(s.hook!.candidates.filter((c) => c.chosen)).toHaveLength(1);
  });

  it("keeps a source only when its fact exists, with the quote from the page", () => {
    const s = buildWrittenScript(raw(lines), angle, ctx());
    expect(s.sources).toHaveLength(1);
    expect(s.sources![0]!.factId).toBe("f2");
    expect(s.sources![0]!.source.quote).toMatch(/photograph every damaged area/);
  });

  it("carries the angle, what makes it different, the visual direction, the on-screen words and the real call to action", () => {
    const s = buildWrittenScript(raw(lines), angle, ctx());
    expect(s.angle.name).toBe(angle.name);
    expect(s.differentiator).toBe(angle.whyDifferent);
    expect(s.visualDirection).toMatch(/granules/);
    expect(s.onScreen).toEqual(["written report"]);
    expect(s.cta).toMatchObject({ label: "Book Now", target: "kestrelroofing.example/inspect" });
    expect(s.adCopy.cta).toBe("Book Now");
    expect(s.dramatisation).toBe(true);
  });

  it("estimates the spoken length against the length asked for", () => {
    const short = buildWrittenScript(raw(lines), angle, ctx());
    expect(short.speech!.requestedSeconds).toBe(30);
    expect(short.speech!.words).toBeGreaterThan(20);
    const long = buildWrittenScript(raw([words(40), words(40), words(40), words(40)]), angle, ctx());
    expect(long.speech!.fit).toBe("long");
    expect(long.speech!.estimatedSeconds).toBeGreaterThan(30);
  });

  it("keeps a scene the operator edited exactly as it was", () => {
    const previous = { scenes: [{ number: 2, line: "My own words here.", visual: "my visual", camera: "mine", speaker: "voiceover", seconds: 4, start: 4, end: 8, keywords: [], stat: null, assetId: null, sound: "", edited: true }] } as unknown as VideoScript;
    const s = buildWrittenScript(raw(lines), angle, ctx(), previous);
    expect(s.scenes[1]!.line).toBe("My own words here.");
    expect(s.scenes[1]!.visual).toBe("my visual");
    expect(s.scenes[1]!.edited).toBe(true);
    expect(s.scenes[0]!.line).toBe(lines[0]);
  });

  it("flags a figure that no approved claim backs", () => {
    const s = buildWrittenScript(raw(["Granules in the gutter after hail are not nothing.", "Over 5000 roofs were checked last year.", "Hail damage is often invisible.", "Book online."]), angle, ctx({ claims: [] }));
    expect(s.warnings.join(" ")).toMatch(/5000|recorded source|not in your page/i);
  });

  it("validates against the schema the model is asked for", () => {
    expect(() => writtenSchema.parse(raw(lines))).not.toThrow();
  });
});

describe("fitting the length by editing, not by speeding up", () => {
  const good = ["Granules in the gutter after hail are not nothing.", "Hail damage is often invisible from the ground.", "A crew photographs every damaged area for your insurer.", "Book the inspection online."];

  it("edits a long draft down and tells the writer by how much", async () => {
    const prompts: string[] = [];
    const drafts = [raw([words(45), words(45), words(45), words(45)]), raw([words(18), words(18), words(18), `${words(14)} Book the inspection online.`])];
    const script = await writeScriptForAngle(ctx(), angle, { generate: async (p) => (prompts.push(p), drafts.shift()) });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toMatch(/RAN LONG/);
    expect(prompts[1]).toMatch(/Do not make the narrator speak faster/);
    expect(script.speech!.fit).not.toBe("long");
  });

  it("develops a thin draft instead of padding it", async () => {
    const prompts: string[] = [];
    const drafts = [raw(["Hail.", "Roof.", "Book."]), raw(good)];
    await writeScriptForAngle(ctx({ targetSeconds: 45 }), angle, { generate: async (p) => (prompts.push(p), drafts.shift() ?? raw(good)) });
    expect(prompts[1]).toMatch(/RAN SHORT/);
    expect(prompts[1]).toMatch(/Do not add filler/);
  });

  it("stops after a bounded number of attempts and returns the best it has, with its honest estimate", async () => {
    let calls = 0;
    const script = await writeScriptForAngle(ctx(), angle, { generate: async () => (calls += 1, raw([words(60), words(60), words(60), words(60)])) });
    expect(calls).toBe(4);
    expect(script.speech!.fit).toBe("long");
  });
});

describe("writing three versions", () => {
  const angles: AnglePlan[] = [angle, { ...angle, id: "b", name: "B" }, { ...angle, id: "c", name: "C" }];
  const lines = ["Granules in the gutter after hail are not nothing.", "Hail damage is often invisible from the ground.", "A crew photographs every damaged area for your insurer.", "Book the inspection online."];

  it("writes each angle on its own, so one failing does not lose the others", async () => {
    const prompts: string[] = [];
    const out = await writeScriptSet(ctx(), angles, {
      generate: async (p) => {
        prompts.push(p);
        if (p.includes("Name: B")) throw new Error("model timed out");
        return raw(lines);
      },
    });
    expect(out.scripts.map((s) => s.angle.name)).toEqual([angle.name, "C"]);
    expect(out.failures).toEqual([{ angle: "B", error: "model timed out" }]);
    // each version was written from its own angle only
    expect(prompts.filter((p) => p.includes("Name: C") && p.includes("Name: B"))).toHaveLength(0);
  });

  it("does not stamp any version with a named copywriting formula or an awareness stage", async () => {
    const out = await writeScriptSet(ctx(), angles, { generate: async () => raw(lines) });
    for (const s of out.scripts) {
      expect(s.framework.name).toBe("");
      expect(s.angle.stage).toBe("");
      expect(s.angle.kind).toBe("custom");
    }
  });
});

describe("cutting a draft that stays too long", () => {
  const long = () => buildWrittenScript(raw([words(8), words(40), words(40), words(40), words(8)]), angle, ctx());

  it("drops the wordiest middle scenes, never the opening or the closing one, and says what it cut", () => {
    const script = long();
    expect(script.speech!.fit).toBe("long");
    const cut = trimToFit(script, { targetSeconds: 30, wordsPerSecond: 2.5 });
    expect(cut.scenes.length).toBeLessThan(script.scenes.length);
    expect(cut.scenes[0]!.line).toBe(script.scenes[0]!.line);
    expect(cut.scenes[cut.scenes.length - 1]!.line).toBe(script.scenes[script.scenes.length - 1]!.line);
    expect(cut.scenes.map((s) => s.number)).toEqual(cut.scenes.map((_, i) => i + 1));
    expect(cut.warnings.join(" ")).toMatch(/cut to fit/);
    expect(cut.speech!.estimatedSeconds).toBeLessThan(script.speech!.estimatedSeconds);
  });

  it("never cuts a scene the operator edited, and leaves a script that already fits alone", () => {
    const script = long();
    const protectedScenes = { ...script, scenes: script.scenes.map((s) => ({ ...s, edited: true })) };
    expect(trimToFit(protectedScenes, { targetSeconds: 30, wordsPerSecond: 2.5 }).scenes).toHaveLength(script.scenes.length);
    const fits = buildWrittenScript(raw([words(18), words(18), words(18), words(18)]), angle, ctx());
    expect(trimToFit(fits, { targetSeconds: 30, wordsPerSecond: 2.5 })).toBe(fits);
  });
});

describe("the closing line is what is actually said last", () => {
  it("puts the closing line into the last scene when the scenes did not end on it", () => {
    const s = buildWrittenScript(raw(["Granules in the gutter after hail are not nothing.", "Hail damage is often invisible from the ground.", "A crew photographs every damaged area for your insurer.", "And that is the story."]), angle, ctx());
    expect(s.scenes[s.scenes.length - 1]!.line).toBe("Book the inspection online.");
    expect(s.cta!.spoken).toBe("Book the inspection online.");
  });
  it("leaves the last scene alone when it already ends on the closing line, or when the operator edited it", () => {
    const ok = buildWrittenScript(raw(["Opening line here.", "Middle line one.", "Middle line two.", "So you can book the inspection online."]), angle, ctx());
    expect(ok.scenes[3]!.line).toBe("So you can book the inspection online.");
    const previous = { scenes: [0, 1, 2, 3].map((i) => ({ number: i + 1, line: `Mine ${i}.`, visual: "v", camera: "c", speaker: "voiceover", seconds: 3, start: 0, end: 3, keywords: [], stat: null, assetId: null, sound: "", edited: i === 3 })) } as unknown as VideoScript;
    const kept = buildWrittenScript(raw(["Opening line here.", "Middle line one.", "Middle line two.", "Anything."]), angle, ctx(), previous);
    expect(kept.scenes[3]!.line).toBe("Mine 3.");
  });
});

describe("a cut must not trade a little long for far too short", () => {
  it("stops cutting when the next cut would land further from the length than the draft already is", () => {
    // 5 scenes, 66 words: slightly long for 20s. Dropping any whole 20-word scene would leave ~13s, further off than the draft is.
    const s = buildWrittenScript(raw([words(6), words(20), words(20), words(20), words(6)]), angle, ctx({ targetSeconds: 20 }));
    expect(s.speech!.fit).toBe("long");
    const out = trimToFit(s, { targetSeconds: 20, wordsPerSecond: 2.5 });
    const gap = (x: VideoScript) => Math.abs(x.speech!.estimatedSeconds - 20);
    expect(gap(out)).toBeLessThanOrEqual(gap(s));
  });
  it("picks the cut that lands closest to the length asked for", () => {
    const s = buildWrittenScript(raw([words(8), words(40), words(12), words(40), words(8)]), angle, ctx());
    const out = trimToFit(s, { targetSeconds: 30, wordsPerSecond: 2.5 });
    expect(out.scenes.length).toBeLessThan(s.scenes.length);
    expect(Math.abs(out.speech!.estimatedSeconds - 30)).toBeLessThan(Math.abs(s.speech!.estimatedSeconds - 30));
  });
});
