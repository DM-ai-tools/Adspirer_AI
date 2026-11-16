import { effectiveClaims } from "@/lib/video/claims";
import { planAngles } from "@/lib/video/angles";
import { operatorClaims, writeContextFor } from "@/lib/video/brief";
import { buildScriptSpeech, resolveWordsPerSecond } from "@/lib/video/duration";
import { editorialPass, refreshEditorial } from "@/lib/video/editorial";
import type { VideoProject } from "@/lib/video/projects";
import { checkScript, MAX_SECONDS, type VideoBrief, type VideoScene, type VideoScript } from "@/lib/video/script";
import { requiredStatsFrom } from "@/lib/video/required-stats";
import { repairScript } from "@/lib/video/script-repairs";
import { splitLongScenes, syncSceneLines, trimToFit, writeScriptForAngle, type WriteContext } from "@/lib/video/script-writer";
import type { AnglePlan } from "@/lib/video/script-types";
import { MAX_SCENE_SECONDS, retime } from "@/lib/video/timing";
import { videoDirection } from "@/lib/video/video-types";

/**
 * What the operator can do to ONE version without touching the others:
 *  - regenerate: a fresh draft of the same idea
 *  - rewrite_delivery: the same angle and argument, said and shown differently
 *  - change_angle: a different angle, from the same verified facts
 *  - retime: shorten or expand to a new length
 * In every case scenes the operator edited are kept exactly, and the facts stay the verified ones.
 */
export type VersionAction = "regenerate" | "rewrite_delivery" | "change_angle" | "retime";

export type DraftScene = Pick<VideoScene, "number" | "seconds" | "visual" | "camera" | "speaker" | "line" | "keywords" | "stat" | "assetId" | "sound"> & { originalLine?: string | null; lines?: VideoScene["lines"] };
export type Draft = { title?: string; scenes: DraftScene[]; adCopy?: VideoScript["adCopy"] };

const same = (a: string, b: string) => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

/** A scene the operator changed (its words, picture, camera, speaker or stat) is approved wording from then on. */
export function markEdited(original: VideoScript, scenes: DraftScene[]): VideoScene[] {
  return scenes.map((s) => {
    const before = original.scenes.find((o) => o.number === s.number);
    const changed =
      !before ||
      !same(before.line, s.line) ||
      !same(before.visual, s.visual) ||
      !same(before.camera, s.camera) ||
      before.speaker !== s.speaker ||
      (before.stat ?? "") !== (s.stat ?? "") ||
      (s.lines !== undefined && JSON.stringify(s.lines) !== JSON.stringify(before.lines ?? []));
    const base = before ?? ({ start: 0, end: 0 } as VideoScene);
    // Who says what follows the words as they now stand: an edit of the words keeps the voice that said them.
    return syncSceneLines({ ...base, ...s, lines: s.lines ?? base.lines, edited: Boolean(before?.edited) || changed, start: base.start, end: base.end });
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
    direction: videoDirection(inputs),
    locale: inputs.locale,
    claims: effectiveClaims(project.brand),
  };
}

export type ConfirmInput = { scriptId: string; edits: { title: string; scenes: DraftScene[]; adCopy: VideoScript["adCopy"] } };

/**
 * Confirm a script with the operator's edits applied. Lengths follow the words; a scene the
 * operator changed is approved wording from then on; a figure they typed counts as theirs. Nothing
 * else blocks: the script is not inspected again here, only the video is.
 */
export function confirmScript(project: VideoProject, body: ConfirmInput): { chosen: VideoScript; brand: VideoProject["brand"] } {
  // Only a script that is ready can be confirmed: never while a concept, a script or a change is still being written.
  if (project.status !== "scripts_ready") throw new Error(project.status === "writing" ? "Still working on the last request. Wait for it to finish, then confirm." : "This script can't be confirmed now.");
  const original = project.scripts?.find((s) => s.id === body.scriptId);
  if (!original) throw new Error("That script is not part of this project.");
  const marked = retime(markEdited(original, body.edits.scenes).map((s, i) => ({ ...s, number: i + 1 })));
  const longScenes = marked.filter((s) => s.seconds > MAX_SCENE_SECONDS).map((s) => s.number);
  // A scene longer than one clip (an older script, or words the operator added) is split at sentences, every word kept.
  const split = splitLongScenes({ ...original, scenes: marked });
  const scenes = split.scenes;
  const cursor = scenes.length ? scenes[scenes.length - 1]!.end : 0;
  if (cursor > MAX_SECONDS) throw new Error(`The script runs ${cursor}s; the limit is ${MAX_SECONDS}s.`);
  const splitNote = longScenes.length ? [`Scene ${longScenes.join(", ")} ran longer than ${MAX_SCENE_SECONDS} seconds, the longest one clip can be, so it was split at its sentences. Every word is kept.`] : [];
  const edited: VideoScript = { ...original, title: body.edits.title, durationSeconds: cursor, scenes, adCopy: body.edits.adCopy, warnings: [], verification: null };
  const corpus = [JSON.stringify(project.inputs), project.brand?.summary ?? "", JSON.stringify(original), body.edits.scenes.map((s) => `${s.line} ${s.stat ?? ""}`).join(" ")].join("\n");
  // A figure the operator typed in the editor (not in the version written for them) is theirs, with that recorded as its source.
  const manifest = project.brand?.manifest ?? null;
  let claims = manifest ? effectiveClaims(project.brand) : undefined;
  let brand = project.brand;
  if (manifest && claims) {
    const originalText = [...original.scenes.map((s) => `${s.line} ${s.stat ?? ""}`), original.adCopy.primaryText, original.adCopy.headline].join("\n");
    const editedTexts = [...body.edits.scenes.map((s) => `${s.line} ${s.stat ?? ""}`), body.edits.adCopy.primaryText, body.edits.adCopy.headline];
    const typed = operatorClaims(editedTexts, "typed by you in the script editor", claims.length + 1).filter((c) => !originalText.includes(c.figure ?? "\u0000"));
    const known = new Set(claims.map((c) => (c.figure ?? c.text).toLowerCase()));
    const added = typed.filter((c) => !known.has((c.figure ?? c.text).toLowerCase()));
    if (added.length) {
      claims = [...claims, ...added];
      brand = { ...project.brand!, manifest: { ...manifest, claims } };
    }
  }
  edited.warnings = [...splitNote, ...checkScript(edited, { corpus, assetIds: project.assets.map((a) => a.id), target: cursor, claims })];
  const chosen = { ...withSpeech(edited, project.inputs.speechRate, original.speech?.requestedSeconds ?? project.inputs.targetSeconds), warnings: edited.warnings };
  return { chosen, brand };
}

/**
 * A confirmed script can be reopened for last-minute changes until a clip has been made from it:
 * nothing has been paid for, so nothing is lost. Once clips exist, changing the script would leave
 * them out of step with it, so the clips are made again instead.
 */
export function reopenCheck(project: Pick<VideoProject, "status" | "chosen_script" | "clips" | "final">): { ok: true } | { ok: false; reason: string } {
  if (!project.chosen_script) return { ok: false, reason: "There is no confirmed script to edit." };
  if (project.status !== "confirmed" && project.status !== "failed") {
    return { ok: false, reason: project.status === "scripts_ready" ? "The script is already open for editing." : "Video is already being made from this script. Stop it first, or make the clips again after changing the script." };
  }
  const started = (project.clips ?? []).some((c) => c.status !== "waiting" || c.attempts > 0 || Boolean(c.videoKey) || Boolean(c.taskId));
  if (started || project.final) return { ok: false, reason: "Clips have already been made from this script, so it can no longer be edited here. Use Make again on a clip after changing it." };
  return { ok: true };
}

/** What reopening does to the project: back to choosing and editing, with the confirmed (edited) version in place of its original, and no half-prepared generation left behind. */
export function reopenPatch(project: Pick<VideoProject, "chosen_script" | "scripts">): Partial<VideoProject> {
  const chosen = project.chosen_script!;
  const scripts = project.scripts ?? [];
  const next = scripts.some((s) => s.id === chosen.id) ? scripts.map((s) => (s.id === chosen.id ? chosen : s)) : [...scripts, chosen];
  return { status: "scripts_ready", scripts: next, plan: null, clips: null, final: null, error: null };
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
    { brief: creative, angles: [angle!], facts: ctx.facts, claims: ctx.claims, sourceText: ctx.sourceText, wordsPerSecond: ctx.wordsPerSecond, targetSeconds: ctx.targetSeconds, assetIds: ctx.assetIds, locale: brief.locale, maxPasses: 2, compareWith: others },
    {
      rewriteScript: async (script, issues) =>
        write(ctx, angle!, { previous: script, avoidOpenings, direction: `Fix these problems and keep what already works: ${issues.map((i) => `${i.problem} (${i.fix})`).join(" ")}` }),
    },
  );
  const cut = trimToFit(repairScript(edited[0] ?? written, ctx.sourceText), ctx);
  const result = refreshEditorial(cut, { brief: creative, angles: [angle!], facts: ctx.facts, claims: ctx.claims, sourceText: ctx.sourceText, wordsPerSecond: ctx.wordsPerSecond, targetSeconds: ctx.targetSeconds, assetIds: ctx.assetIds, locale: brief.locale });
  return scripts.map((s) => (s.id === found.id ? { ...result, id: found.id } : s));
}
