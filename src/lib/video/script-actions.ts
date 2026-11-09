import { effectiveClaims } from "@/lib/video/claims";
import { planAngles } from "@/lib/video/angles";
import { writeContextFor } from "@/lib/video/brief";
import { buildScriptSpeech, resolveWordsPerSecond } from "@/lib/video/duration";
import { editorialPass, refreshEditorial } from "@/lib/video/editorial";
import type { VideoProject } from "@/lib/video/projects";
import { checkScript, type VideoBrief, type VideoScene, type VideoScript } from "@/lib/video/script";
import { requiredStatsFrom } from "@/lib/video/required-stats";
import { repairScript } from "@/lib/video/script-repairs";
import { ensureMainStats, trimToFit, writeScriptForAngle, type WriteContext } from "@/lib/video/script-writer";
import type { AnglePlan } from "@/lib/video/script-types";
import { retime } from "@/lib/video/timing";

/**
 * What the operator can do to ONE version without touching the others:
 *  - regenerate: a fresh draft of the same idea
 *  - rewrite_delivery: the same angle and argument, said and shown differently
 *  - change_angle: a different angle, from the same verified facts
 *  - retime: shorten or expand to a new length
 * In every case scenes the operator edited are kept exactly, and the facts stay the verified ones.
 */
export type VersionAction = "regenerate" | "rewrite_delivery" | "change_angle" | "retime";

export type DraftScene = Pick<VideoScene, "number" | "seconds" | "visual" | "camera" | "speaker" | "line" | "keywords" | "stat" | "assetId" | "sound"> & { originalLine?: string | null };
export type Draft = { title?: string; scenes: DraftScene[]; adCopy?: VideoScript["adCopy"] };

const same = (a: string, b: string) => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

/** A scene the operator changed (its words, picture, camera, speaker or stat) is approved wording from then on. */
export function markEdited(original: VideoScript, scenes: DraftScene[]): VideoScene[] {
  return scenes.map((s) => {
    const before = original.scenes.find((o) => o.number === s.number);
    const changed = !before || !same(before.line, s.line) || !same(before.visual, s.visual) || !same(before.camera, s.camera) || before.speaker !== s.speaker || (before.stat ?? "") !== (s.stat ?? "");
    const base = before ?? ({ start: 0, end: 0 } as VideoScene);
    return { ...base, ...s, edited: Boolean(before?.edited) || changed, start: base.start, end: base.end };
  });
}

/** The speech estimate and the length recalculated for the words as they stand now. */
export function withSpeech(script: VideoScript, wordsPerSecond: number | null | undefined, requestedSeconds: number): VideoScript {
  const wps = resolveWordsPerSecond(wordsPerSecond);
  const scenes = retime(script.scenes.map((s) => ({ ...s })));
  const lines = scenes.map((s) => s.line).filter(Boolean);
  const ctaWords = script.cta?.spoken.trim().split(/\s+/).filter(Boolean).length;
  const previous = script.speech?.measuredSeconds ?? null;
  return {
    ...script,
    scenes,
    durationSeconds: scenes.length ? scenes[scenes.length - 1]!.end : 0,
    speech: { ...buildScriptSpeech(lines, requestedSeconds, wps, ctaWords ? { ctaWords } : undefined), measuredSeconds: previous },
  };
}

/** The operator's edits applied to a version: their scenes are marked approved, then length, speech and fact checks are redone for what changed. */
export function applyDraft(original: VideoScript, draft: Draft, ctx: { wordsPerSecond?: number | null; requestedSeconds: number; corpus: string; assetIds: string[]; claims?: Parameters<typeof checkScript>[1]["claims"] }): VideoScript {
  const scenes = markEdited(original, draft.scenes);
  const next = withSpeech({ ...original, title: draft.title ?? original.title, scenes, adCopy: draft.adCopy ?? original.adCopy }, ctx.wordsPerSecond, ctx.requestedSeconds);
  return { ...next, warnings: checkScript(next, { corpus: ctx.corpus, assetIds: ctx.assetIds, target: ctx.requestedSeconds, claims: ctx.claims }) };
}

/** The stats read from the project's uploaded images: each must be said in the script. */
export function requiredStatsForProject(project: Pick<VideoProject, "assets">) {
  return requiredStatsFrom(project.assets.map((a) => ({ id: a.id, name: a.name, stats: a.analysis?.stats ?? [], mainStat: a.analysis?.mainStat ?? null })));
}

/** The brief the writer needs, rebuilt from what is stored so a version can be changed without reading the site again. */
export function storedBrief(project: VideoProject): VideoBrief {
  const creative = project.brand!.brief!;
  const inputs = project.inputs;
  return {
    brandName: creative.company.name ?? "",
    voice: creative.voice.tone,
    colors: project.brand?.colors ?? null,
    offerName: creative.offer.name,
    offerDescription: creative.offer.description,
    landingPageUrl: inputs.landingPageUrl,
    instructions: inputs.instructions,
    offerDetails: inputs.offerDetails,
    stats: inputs.stats ?? [],
    images: project.assets.map((a) => ({ id: a.id, name: a.name, summary: a.analysis?.summary ?? a.caption, stats: a.analysis?.stats ?? [], mainStat: a.analysis?.mainStat ?? null })),
    targetSeconds: inputs.targetSeconds,
    style: inputs.style,
    locale: inputs.locale,
    claims: effectiveClaims(project.brand),
  };
}

export type ReviseInput = { scriptId: string; action: VersionAction; draft?: Draft | null; instruction?: string | null; seconds?: number | null };

/** Change one version and return the full list of versions with it replaced. The others are never rewritten. */
export async function reviseVersion(project: VideoProject, input: ReviseInput, deps: { write?: typeof writeScriptForAngle } = {}): Promise<VideoScript[]> {
  const creative = project.brand?.brief;
  if (!creative) throw new Error("These scripts were written before the creative brief existed. Write the scripts again to use this.");
  const scripts = project.scripts ?? [];
  const found = scripts.find((s) => s.id === input.scriptId);
  if (!found) throw new Error("That script is not part of this project.");
  const others = scripts.filter((s) => s.id !== found.id);
  const write = deps.write ?? writeScriptForAngle;

  let seconds = Math.min(Math.max(Math.round(project.inputs.targetSeconds), 15), 60);
  if (input.action === "retime") {
    if (!input.seconds) throw new Error("Say how long it should be.");
    seconds = Math.min(Math.max(Math.round(input.seconds), 15), 60);
  }
  const brief: VideoBrief = { ...storedBrief(project), targetSeconds: seconds };
  const ctx: WriteContext = writeContextFor(project, creative, brief);
  // The operator's unsaved edits count: their scenes are approved and survive.
  const current = input.draft ? applyDraft(found, input.draft, { wordsPerSecond: project.inputs.speechRate, requestedSeconds: ctx.targetSeconds, corpus: ctx.corpus, assetIds: ctx.assetIds, claims: ctx.claims }) : found;
  const required = requiredStatsFrom(brief.images);
  const avoidOpenings = others.map((o) => o.hook?.line).filter((l): l is string => Boolean(l));

  let angle: AnglePlan | undefined = current.angleDetail ?? project.brand?.angles?.find((a) => a.id === current.angle.key);
  let written: VideoScript;
  if (input.action === "change_angle") {
    const keep = others.map((o) => o.angleDetail).filter((a): a is AnglePlan => Boolean(a));
    const planned = await planAngles(creative, { count: keep.length + 1, keep, avoid: angle ? [angle] : [], direction: input.instruction ?? null });
    const fresh = planned.angles.find((a) => !keep.some((k) => k.id === a.id));
    if (!fresh) throw new Error(planned.limitation ?? "No other angle fits this page without inventing things.");
    angle = fresh;
    // A different idea starts clean: scenes edited for the old one do not apply.
    written = await write(ctx, fresh, { avoidOpenings, direction: input.instruction ?? null });
  } else {
    if (!angle) throw new Error("This version has no recorded angle. Write the scripts again to use this.");
    const delivery =
      input.action === "rewrite_delivery"
        ? (input.instruction?.trim() || "Say the same argument in different words, with a different sentence rhythm and different things on screen.")
        : input.action === "retime"
          ? `Adapt this version to ${seconds} seconds. ${seconds < current.durationSeconds ? "Shorten it by cutting what the argument can do without." : "Expand it by developing the substance from the facts, not by adding filler."} Keep the angle, the facts and every scene the operator approved.`
          : null;
    written = await write(ctx, angle, {
      previous: current,
      avoidOpenings,
      delivery,
      direction: input.action === "regenerate" ? ["Write a fresh draft of this idea with a different opening from the previous one.", input.instruction].filter(Boolean).join(" ") : null,
    });
  }

  // The new version is edited against the facts, its voice, its length and the untouched versions, which are compared with but never changed.
  const { scripts: edited } = await editorialPass(
    [written],
    { brief: creative, angles: [angle!], facts: ctx.facts, claims: ctx.claims, sourceText: ctx.sourceText, wordsPerSecond: ctx.wordsPerSecond, targetSeconds: ctx.targetSeconds, assetIds: ctx.assetIds, locale: brief.locale, maxPasses: 2, compareWith: others, requiredStats: required },
    {
      rewriteScript: async (script, issues) =>
        write(ctx, angle!, { previous: script, avoidOpenings, direction: `Fix these problems and keep what already works: ${issues.map((i) => `${i.problem} (${i.fix})`).join(" ")}` }),
    },
  );
  const cut = trimToFit(repairScript(edited[0] ?? written, ctx.sourceText), ctx);
  const withStats = await ensureMainStats(cut, required, ctx);
  const result = refreshEditorial(withStats, { brief: creative, angles: [angle!], facts: ctx.facts, claims: ctx.claims, sourceText: ctx.sourceText, wordsPerSecond: ctx.wordsPerSecond, targetSeconds: ctx.targetSeconds, assetIds: ctx.assetIds, locale: brief.locale, requiredStats: required });
  return scripts.map((s) => (s.id === found.id ? { ...result, id: found.id } : s));
}
