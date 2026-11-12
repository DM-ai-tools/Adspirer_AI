import { generateObject } from "ai";
import { z } from "zod";
import { ADSPIRER_META_CTAS } from "@/lib/adspirer/skills/ad-copywriting";
import { logger } from "@/lib/observability/logger";
import { modelCandidates, withModelFallback } from "@/lib/video/model-fallback";
import { briefForPrompt } from "@/lib/video/creative-brief";
import { buildScriptSpeech, speechBudget } from "@/lib/video/duration";
import { checkScript, sceneSchema, type VideoBrief, type VideoScene, type VideoScript } from "@/lib/video/script";
import { retime } from "@/lib/video/timing";
import { HUMAN_VOICE, SYSTEM } from "@/lib/video/voice";
import { VISUAL_DIRECTION_RULES } from "@/lib/video/visual-rules";
import { attachImageStats, linkImageStats, requiredStatsFrom, requiredStatsPrompt, spokenForms, statFixNote, statGaps, type RequiredStat } from "@/lib/video/required-stats";
import { regenerateScene } from "@/lib/video/rewrite";
import type { ApprovedClaim } from "@/lib/video/pipeline-types";
import type { AnglePlan, CreativeBrief, HookCandidate, ScriptSource } from "@/lib/video/script-types";

const CTA_VALUES = ADSPIRER_META_CTAS as unknown as [string, ...string[]];

/** Everything a version is written from. */
export type WriteContext = {
  creative: CreativeBrief;
  /** The operator's inputs and uploaded images in the form the rest of the app uses. */
  brief: VideoBrief;
  targetSeconds: number;
  wordsPerSecond: number;
  assetIds: string[];
  claims: ApprovedClaim[];
  /** All source text (page, operator, images), for checking what a line states. */
  sourceText: string;
  facts: string;
  corpus: string;
  /** What the operator said the campaign is for and where it runs, when they said. */
  goal?: string | null;
  platform?: string | null;
};

/** What the model returns for one version: openings considered, the chosen one, the scenes, and the rest. */
export const writtenSchema = z.object({
  title: z.string().describe("A short working title"),
  hook_candidates: z
    .array(z.object({ line: z.string().describe("The opening line exactly as it would be spoken"), why: z.string().describe("What it makes the viewer recognise or wonder, and what in the script pays it off") }))
    .min(4)
    .max(8)
    .describe("Several different opening lines for THIS angle, considered before choosing. Each starts from a specific observation, tension, action or implication the viewer recognises."),
  chosen_hook: z.number().int().describe("Index of the strongest grounded candidate"),
  hook_payoff: z.string().describe("How the rest of the script pays off the curiosity the opening creates"),
  style: z.string().describe("The look, chosen for this idea (for example a demonstration, a documentary moment, a product close-up, a presenter to camera)"),
  dramatisation: z.boolean().describe("True when a presenter acts out a situation. Then the script must never imply they used the product, got results or are a customer."),
  character: z.string().nullable().describe("If a person appears: ONE precise description repeated in every clip. null if nobody appears."),
  setting: z.string().describe("Where it takes place and the light, consistent across the scenes that share it"),
  scenes: z.array(sceneSchema).min(3).max(12),
  visual_direction: z.string().describe("Two or three sentences for the whole video: what is filmed and shown, and how it serves this message. No readable dashboards, exact logos, complex anatomy or implausible actions."),
  on_screen: z.array(z.string()).max(4).describe("Words or figures worth showing on screen, each taken from the spoken lines or an approved claim"),
  cta: z.object({
    spoken: z.string().describe("The closing line that asks for the one next step the page really offers"),
    label: z.enum(CTA_VALUES).describe("The button label from Meta's list that matches that step"),
    target: z.string().nullable().describe("Where the step leads, as the page says"),
    benefit: z.string().nullable().describe("What the viewer gets by taking it, if the sources say"),
  }),
  sources: z.array(z.object({ claim: z.string().describe("A factual statement made in the script"), fact_id: z.string().describe("The id of the brief fact that supports it") })).max(16),
  primary_text: z.string().describe("The ad's primary text, 70 to 130 words, facts only. Line 1 is a standalone hook under 125 characters. Conversational, no dashes, no stock marketing words."),
  headline: z.string().describe("Under 40 characters"),
  description: z.string().describe("Under 30 characters"),
});

export type WrittenScript = z.infer<typeof writtenSchema>;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export type WriteOptions = {
  /** Another way of saying the same thing: keep the angle, facts and structure, change how it is delivered. */
  delivery?: string | null;
  /** The previous draft's problem with length, so the next one fixes it by editing, not by speaking faster. */
  fitNote?: string | null;
  /** The earlier version of this script: kept scenes the operator edited stay exactly as they are. */
  previous?: VideoScript | null;
  /** Other versions' openings, so this one does not echo them. */
  avoidOpenings?: string[];
  /** Operator wording to follow within the facts. */
  direction?: string | null;
  generate?: (prompt: string) => Promise<unknown>;
};

/** The scenes the operator edited: they are approved wording and are never rewritten. */
export function lockedScenes(previous: VideoScript | null | undefined): VideoScene[] {
  return (previous?.scenes ?? []).filter((s) => s.edited);
}

export function scriptPrompt(ctx: WriteContext, angle: AnglePlan, opts: WriteOptions = {}): string {
  const budget = speechBudget({ seconds: ctx.targetSeconds, wordsPerSecond: ctx.wordsPerSecond, ctaWords: 10 });
  const locked = lockedScenes(opts.previous);
  return [
    briefForPrompt(ctx.creative),
    "",
    "THE ANGLE FOR THIS VERSION (write this idea and no other):",
    `- Name: ${angle.name}`,
    `- The customer situation: ${angle.situation}`,
    `- The core tension, desire or objection: ${angle.tension}`,
    `- The central message: ${angle.centralMessage}`,
    `- What the opening is about: ${angle.hookPremise}`,
    `- What carries it (mechanism or proof, facts ${angle.support.factIds.join(", ") || "none"}): ${angle.support.text}`,
    `- Emotional tone: ${angle.tone}`,
    `- Why the viewer should act: ${angle.reasonToAct}`,
    "",
    `LENGTH: the video runs ${ctx.targetSeconds} seconds. At ${ctx.wordsPerSecond} spoken words a second with pauses and the closing line reserved, that is ${budget.min} to ${budget.max} words of narration in total (aim for about ${budget.target}). ${budget.notes.join(" ")} Write to this budget by choosing what matters; never rely on the narrator speaking fast, and never pad with filler. A short ad carries one sharp idea; a longer one earns its length with real development.`,
    "",
    "HOW TO WRITE IT:",
    "1. First consider several different opening lines for THIS angle and choose the strongest one that is fully supported. An opening starts from a specific observation, tension, action or implication the viewer recognises within a second or two, gives a reason to keep listening, and is paid off later in the script. No greeting, no label for the audience, no announcement that this is an ad, no unsupported contrarian claim, no manufactured urgency, no fear. Avoid the stock openers (asking if they are struggling, addressing business owners, today's fast-paced world, next level, unlock the power, this changes everything): do not swap them for another formula either.",
    "2. Every line must move the idea: create recognition, explain a cause, demonstrate the offer, give evidence, answer an objection, or motivate the next step. Do not follow a fixed formula. Bring the offer in where it helps the viewer understand the solution, not at the end as a rushed mention. Explain the mechanism in plain words from the facts: what the company actually does, not that it delivers better results.",
    "3. Use only the facts above. Use the proof that suits THIS angle and keep a result's own scope (whose, when). Do not paste every statistic. Do not invent limited availability, deadlines, discounts, guarantees or free offers. Record in `sources` which fact id supports each factual statement.",
    "4. The LAST scene's spoken line is the closing line (`cta.spoken`), word for word: it is what the viewer actually hears last. Close with ONE primary call to action that matches the page's real next step, and give a web address or phone number only exactly as the page does, saying what the viewer gets by taking it when the sources say. Do not default to a stock closer. Say that something is free, discounted, guaranteed or limited ONLY if a fact above says so, and then with the same conditions the fact gives (for example free only for a certain kind of customer): never turn a conditional offer into a general one, in the script, the closing line or the ad copy.",
    "5. If someone speaks to camera, they are a presenter. Set `dramatisation` true when they act out a situation, and never let them say or imply they used the product, got the results or are a customer unless the facts say so.",
    "6. Visuals serve the idea. Do not default to a frustrated person at a laptop followed by a smiling person at the same laptop. Choose demonstrations, real assets, simple physical actions, product details or places that belong to this offer and this customer.",
    ctx.goal ? `Campaign goal (from the operator): ${ctx.goal}` : null,
    ctx.platform ? `Platform (from the operator): ${ctx.platform}` : null,
    `Locale and spelling: ${ctx.brief.locale}. Preferred look: ${ctx.brief.style && ctx.brief.style !== "auto" ? ctx.brief.style : "choose what suits this idea"}.`,
    ctx.brief.direction ? `THE KIND OF VIDEO THE OPERATOR ASKED FOR (every script follows it; the angles and wording are still yours):\n${ctx.brief.direction}` : null,
    `Scene detail: each scene has its visual, camera, who speaks (on_camera = the presenter speaks to camera, voiceover = an unseen voice over the visuals, none), the exact line, up to 3 keywords from the line, a stat only if it is an approved claim or an operator stat, an uploaded image id only where it makes the point, and sound. The keywords, the stat and the image id are notes for whoever finishes the video by hand: the video itself shows no text, figure or screenshot, so the spoken line must make complete sense with nothing on screen and must never point at an image ("shown here", "as you can see", "on screen"). Use the uploaded images listed in the brief where they carry proof: set the stat exactly as printed and asset_id to the image it came from.`,
    requiredStatsPrompt(requiredStatsFrom(ctx.brief.images), Object.fromEntries(ctx.brief.images.map((i) => [i.id, i.summary]))),
    HUMAN_VOICE,
    VISUAL_DIRECTION_RULES,
    ctx.brief.stats.length ? `Operator stats (real, usable where the angle needs them): ${ctx.brief.stats.join("; ")}.` : null,
    ctx.brief.instructions ? `Operator's instructions (follow them within the facts): ${ctx.brief.instructions.slice(0, 1500)}` : null,
    opts.avoidOpenings?.length ? `Other versions open with these ideas; do not echo them: ${opts.avoidOpenings.map((o) => `"${o}"`).join(" | ")}` : null,
    opts.delivery ? `DELIVERY REWRITE: keep the angle, the facts and the argument. Change how it is said and shown: ${opts.delivery}` : null,
    opts.direction ? `The operator asks: ${opts.direction}` : null,
    opts.previous && (opts.delivery || opts.fitNote || locked.length)
      ? `THE PREVIOUS DRAFT, for reference:\n${opts.previous.scenes.map((s) => `${s.number}. "${s.line}"${s.edited ? " [approved by the operator: keep exactly]" : ""}`).join("\n")}`
      : null,
    locked.length ? `The operator edited scenes ${locked.map((s) => s.number).join(", ")}. Keep the same number of scenes and the same order, and leave those scenes' words and picture exactly as they are; write the rest around them.` : null,
    opts.fitNote ?? null,
    `Ad copy: write it like a short post from a person, not a brochure: 70 to 130 words, a standalone first line under 125 characters, two or three short paragraphs, the next step in plain words, facts only. Headline under 40 characters, description under 30.`,
  ]
    .filter((l): l is string => Boolean(l))
    .join("\n");
}

function defaultGenerate(): (prompt: string) => Promise<unknown> {
  return async (prompt) => {
    const candidates = modelCandidates();
    if (!candidates.length) throw new Error("No language model is configured to write scripts (set ANTHROPIC_API_KEY or OPENAI_API_KEY).");
    return withModelFallback(async (model) => (await generateObject({ model, schema: writtenSchema, temperature: 0.85, system: SYSTEM, prompt })).object, candidates);
  };
}

/** Turn the model's draft into a VideoScript: timed scenes, the chosen opening, sources, speech estimate and warnings. Pure. */
export function buildWrittenScript(raw: WrittenScript, angle: AnglePlan, ctx: WriteContext, previous?: VideoScript | null): VideoScript {
  const locked = new Map(lockedScenes(previous).map((s) => [s.number, s]));
  const scenes: VideoScene[] = retime(
    raw.scenes.map((sc, i) => {
      const keep = locked.get(i + 1);
      if (keep) return { ...keep, number: i + 1 };
      return {
        number: i + 1,
        seconds: sc.seconds,
        visual: sc.visual,
        camera: sc.camera,
        speaker: sc.speaker,
        line: sc.line.trim(),
        keywords: sc.keywords.map((k) => k.trim()).filter(Boolean),
        stat: sc.stat?.trim() || null,
        assetId: sc.asset_id && ctx.assetIds.includes(sc.asset_id) ? sc.asset_id : null,
        sound: sc.sound,
      };
    }),
  );

  // A scene that says a figure from an uploaded image shows that image, even if the writer forgot to set it.
  const required = requiredStatsFrom(ctx.brief.images);
  const linked = linkImageStats(scenes, required);
  scenes.splice(0, scenes.length, ...linked);

  // The closing line is what the video actually says last: if the scenes do not end on it, the last scene says it (unless the operator edited that scene).
  const closing = raw.cta.spoken.trim();
  const last = scenes[scenes.length - 1];
  if (closing && last && !last.edited && !norm(last.line).includes(norm(closing))) scenes[scenes.length - 1] = { ...last, line: closing, speaker: last.speaker === "none" ? "voiceover" : last.speaker };

  // The chosen opening is the first spoken line; if the model's scenes drifted from it, the scene is what is actually said.
  const firstLine = scenes.find((s) => s.line.trim())?.line.trim() ?? "";
  const candidates: HookCandidate[] = raw.hook_candidates.map((c, i) => ({ line: c.line.trim(), why: c.why, chosen: i === raw.chosen_hook }));
  let chosen = candidates.find((c) => c.chosen);
  if (!chosen || !norm(firstLine).startsWith(norm(chosen.line).slice(0, Math.max(12, Math.floor(norm(chosen.line).length * 0.6))))) {
    const match = candidates.find((c) => norm(firstLine).startsWith(norm(c.line).slice(0, 12)));
    for (const c of candidates) c.chosen = c === match;
    chosen = match;
    if (!chosen) {
      chosen = { line: firstLine, why: "The opening as written in the script.", chosen: true };
      candidates.unshift(chosen);
    }
  }
  const alternatives = candidates.filter((c) => !c.chosen).map((c) => c.line);
  while (alternatives.length < 3) alternatives.push(chosen.line);

  const facts = new Map(ctx.creative.facts.map((f) => [f.id, f]));
  const sources: ScriptSource[] = [];
  for (const s of raw.sources) {
    const f = facts.get(s.fact_id);
    if (f && !sources.some((x) => x.claim === s.claim && x.factId === s.fact_id)) sources.push({ claim: s.claim, factId: f.id, source: f.source });
  }

  const lines = scenes.map((s) => s.line).filter(Boolean);
  const speech = buildScriptSpeech(lines, ctx.targetSeconds, ctx.wordsPerSecond, { ctaWords: raw.cta.spoken.trim().split(/\s+/).filter(Boolean).length });
  const cursor = scenes.length ? scenes[scenes.length - 1]!.end : 0;
  const script: VideoScript = {
    id: `script_${angle.id}`,
    title: raw.title,
    angle: { key: angle.id, name: angle.name, stage: "", kind: "custom" },
    pain: angle.tension,
    framework: { key: angle.id, name: "" },
    style: raw.style,
    durationSeconds: cursor,
    hookAlternatives: alternatives.slice(0, 3),
    character: raw.character?.trim() || null,
    setting: raw.setting,
    scenes,
    adCopy: { primaryText: raw.primary_text, headline: raw.headline, description: raw.description, cta: raw.cta.label },
    warnings: [],
    angleDetail: angle,
    differentiator: angle.whyDifferent,
    hook: { line: chosen.line, candidates, payoff: raw.hook_payoff },
    visualDirection: raw.visual_direction,
    onScreen: raw.on_screen,
    cta: { spoken: raw.cta.spoken, label: raw.cta.label, target: raw.cta.target, benefit: raw.cta.benefit },
    speech,
    sources,
    dramatisation: raw.dramatisation,
  };
  script.warnings = checkScript(script, { corpus: ctx.corpus, assetIds: ctx.assetIds, target: ctx.targetSeconds, claims: ctx.claims });
  return attachImageStats(script, required);
}

const MAX_FIT_ATTEMPTS = 3;

const wordsIn = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;

function fitNote(script: VideoScript): string | null {
  const sp = script.speech;
  if (!sp || sp.fit === "fits") return null;
  const gap = Math.abs(Math.round(sp.estimatedSeconds - sp.requestedSeconds));
  const perScene = script.scenes.filter((s) => s.line.trim()).map((s) => `scene ${s.number}: ${wordsIn(s.line)} words`).join(", ");
  const over = Math.max(sp.words - sp.budgetWords.max, 0);
  return sp.fit === "long"
    ? `THE LAST DRAFT RAN LONG: ${sp.words} words, about ${Math.round(sp.estimatedSeconds)} seconds spoken against ${sp.requestedSeconds}, so about ${gap} seconds over (the budget is ${sp.budgetWords.min} to ${sp.budgetWords.max} words in total, including the closing line). The draft's scenes: ${perScene}. You must cut at least ${over} words: remove whole scenes or sentences that the argument can do without, and shorten the rest; keep the opening, its payoff and the next step. Count the words of your new draft before answering. Do not make the narrator speak faster.`
    : `THE LAST DRAFT RAN SHORT: ${sp.words} words, about ${Math.round(sp.estimatedSeconds)} seconds spoken against ${sp.requestedSeconds}, so about ${gap} seconds under (budget ${sp.budgetWords.min} to ${sp.budgetWords.max} words). Improve the substance: develop the mechanism, the situation or the proof from the facts. Do not add filler or repeat yourself.`;
}

/**
 * Write one version for one angle. The draft is measured against the duration budget and, if it
 * does not fit, edited again (at most twice): the length is fixed by editing, never by speeding up
 * the narrator. Scenes the operator edited are kept exactly.
 */
export async function writeScriptForAngle(ctx: WriteContext, angle: AnglePlan, opts: WriteOptions = {}): Promise<VideoScript> {
  const generate = opts.generate ?? defaultGenerate();
  let script: VideoScript | null = null;
  let note = opts.fitNote ?? null;
  let previous = opts.previous ?? null;
  for (let attempt = 0; attempt <= MAX_FIT_ATTEMPTS; attempt += 1) {
    const raw = writtenSchema.parse(await generate(scriptPrompt(ctx, angle, { ...opts, fitNote: note, previous })));
    script = buildWrittenScript(raw, angle, ctx, opts.previous);
    // Length and the mandatory image stats are both fixed by editing, in the same bounded loop.
    const next = [fitNote(script), statFixNote(script.imageStats ?? [])].filter(Boolean).join(" ") || null;
    if (!next) break;
    note = next;
    previous = script;
  }
  // If the model keeps ignoring the budget, cut scenes ourselves rather than ship a length that misleads.
  return trimToFit(script!, ctx);
}

/**
 * Last resort for a draft that is still well over its length after the model has been asked to
 * edit it: drop the wordiest middle scene, one at a time, until it fits. The opening scene, the
 * closing scene and any scene the operator edited are never dropped, and at least three scenes stay.
 * What was cut is recorded in the script's warnings.
 */
export function trimToFit(script: VideoScript, ctx: Pick<WriteContext, "targetSeconds" | "wordsPerSecond">): VideoScript {
  let current = script;
  const cut: number[] = [];
  const over = (s: VideoScript) => (s.speech?.estimatedSeconds ?? 0) > s.speech!.requestedSeconds * 1.12;
  const without = (s: VideoScript, index: number): VideoScript => {
    const kept = s.scenes.filter((_, i) => i !== index).map((x, i) => ({ ...x, number: i + 1 }));
    const timed = retime(kept);
    const lines = timed.map((x) => x.line).filter(Boolean);
    return { ...s, scenes: timed, durationSeconds: timed.length ? timed[timed.length - 1]!.end : 0, speech: buildScriptSpeech(lines, s.speech!.requestedSeconds, ctx.wordsPerSecond, { ctaWords: wordsIn(s.cta?.spoken ?? "") }) };
  };
  while (current.speech && over(current) && current.scenes.length > 3) {
    const firstSpoken = current.scenes.findIndex((s) => s.line.trim());
    const candidates = current.scenes.map((s, i) => ({ s, i })).filter(({ s, i }) => i !== firstSpoken && i !== current.scenes.length - 1 && !s.edited && !s.assetId && !s.stat && s.line.trim());
    if (!candidates.length) break;
    // The cut that lands closest to the length asked for, and none at all if every cut would be further off than the draft already is
    // (a cut must never trade a script that is a little long for one that is far too short).
    const requested = current.speech.requestedSeconds;
    const gap = (s: VideoScript) => Math.abs((s.speech?.estimatedSeconds ?? 0) - requested);
    const tries = candidates.map((c) => ({ c, next: without(current, c.i) })).sort((a, b) => gap(a.next) - gap(b.next));
    const best = tries[0]!;
    if (gap(best.next) >= gap(current)) break;
    cut.push(best.c.s.number);
    current = best.next;
  }
  if (!cut.length) return script;
  return { ...current, warnings: [...current.warnings, `The draft ran past the length asked for, so ${cut.length === 1 ? `scene ${cut[0]} was` : `scenes ${cut.join(", ")} were`} cut to fit.`] };
}

/**
 * The main stat of an image is mandatory. If the editing passes have still not got it into a script,
 * one scene is rewritten to say it (the scene that already shows that image, else a middle scene),
 * at most twice per stat. Scenes the operator edited are never touched; if nothing can be done the
 * stat stays reported as missing. The coverage is recorded on the result.
 */
export async function ensureMainStats(
  script: VideoScript,
  required: RequiredStat[],
  ctx: Pick<WriteContext, "facts" | "assetIds" | "targetSeconds" | "wordsPerSecond"> & { brief: Pick<VideoBrief, "locale"> },
  deps: { rewriteScene?: (input: { script: VideoScript; sceneNumber: number; feedback: string }) => Promise<VideoScene> } = {},
): Promise<VideoScript> {
  if (!required.length || script.source === "uploaded") return attachImageStats(script, required);
  const rewrite =
    deps.rewriteScene ??
    (async ({ script: s, sceneNumber, feedback }) => regenerateScene({ script: s, sceneNumber, feedback, ctx: { facts: ctx.facts, assetIds: ctx.assetIds, locale: ctx.brief.locale } }));
  // The scenes the writer put each image on, before the image is taken off the scenes that do not say its stat: the rewrite goes where the image already was.
  const carriers = new Map(required.map((r) => [r.assetId, script.scenes.filter((s) => s.assetId === r.assetId && !s.edited).map((s) => s.number)]));
  let current = attachImageStats({ ...script, scenes: linkImageStats(script.scenes, required) }, required);
  for (const gap of statGaps(current.imageStats ?? []).unsaid) {
    const need = required.find((r) => r.assetId === gap.assetId && r.value === gap.value);
    if (!need) continue;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const spoken = current.scenes.filter((s) => s.line.trim());
      const candidates = spoken.filter((s) => !s.edited && s.number !== spoken[0]?.number && s.number !== spoken[spoken.length - 1]?.number);
      const carried = candidates.find((s) => (carriers.get(need.assetId) ?? []).includes(s.number));
      const target = carried ?? candidates[Math.floor(candidates.length / 2)];
      if (!target) break;
      try {
        const forms = spokenForms(need.value);
        const next = await rewrite({
          script: current,
          sceneNumber: target.number,
          feedback: `This scene must say the main figure from the operator's image: ${need.value}${need.label ? ` (${need.label})` : ""}. Say it naturally as part of the point this scene is making${forms[0] ? `, for example as ${forms[0]}` : ""}, as digits. Describe it only as what the source shows (for example "in one account's results"), in words that make sense with no image on screen: never "shown here" or "as you can see"; do not add a period, whose it is, or any comparison. Keep the scene short.`,
        });
        const scenes = current.scenes.map((s) => (s.number === target.number ? { ...next, number: s.number, start: s.start, assetId: need.assetId, stat: need.value } : s));
        const timed = retime(scenes);
        current = attachImageStats(
          { ...current, scenes: timed, durationSeconds: timed.length ? timed[timed.length - 1]!.end : 0, speech: buildScriptSpeech(timed.map((s) => s.line).filter(Boolean), current.speech?.requestedSeconds ?? ctx.targetSeconds, ctx.wordsPerSecond, { ctaWords: wordsIn(current.cta?.spoken ?? "") }) },
          required,
        );
      } catch (error) {
        logger.warn("Could not rewrite a scene to say the main stat", { error: error instanceof Error ? error.message : String(error) });
        break;
      }
      if (!statGaps(current.imageStats ?? []).unsaid.some((g) => g.assetId === need.assetId)) break;
    }
  }
  return current;
}

/** Write a version for each angle, in parallel and independently, so one failing does not lose the others. */
export async function writeScriptSet(ctx: WriteContext, angles: AnglePlan[], opts: { generate?: WriteOptions["generate"] } = {}): Promise<{ scripts: VideoScript[]; failures: Array<{ angle: string; error: string }> }> {
  const results = await Promise.all(
    angles.map(async (angle) => {
      try {
        return { script: await writeScriptForAngle(ctx, angle, { generate: opts.generate, avoidOpenings: [] }) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("A script version could not be written", { angle: angle.name, error: message });
        return { failure: { angle: angle.name, error: message } };
      }
    }),
  );
  return { scripts: results.flatMap((r) => (r.script ? [r.script] : [])), failures: results.flatMap((r) => (r.failure ? [r.failure] : [])) };
}
