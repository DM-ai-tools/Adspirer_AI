import { z } from "zod";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { deleteProject, getProject, updateProject, type VideoProject } from "@/lib/video/projects";
import { projectName } from "@/lib/video/naming";
import { effectiveProject, viewGeneration } from "@/lib/video/generation";
import { getObjectStorage } from "@/lib/storage/r2";
import { operatorClaims, writeProjectScripts } from "@/lib/video/brief";
import { brandView } from "@/lib/video/brand-view";
import { markEdited, withSpeech } from "@/lib/video/script-actions";
import { checkScript, MAX_SECONDS, type VideoScript } from "@/lib/video/script";
import { previewPlan } from "@/lib/video/plan-view";
import { runAfterResponse } from "@/lib/api/background";
import { retime } from "@/lib/video/timing";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";

export const maxDuration = 300;
type Ctx = { params: Promise<{ id: string }> };

async function load(ctx: Ctx) {
  const user = await getCurrentUser();
  assertAuthenticated(user);
  const { id } = await ctx.params;
  const project = await getProject(id);
  if (!project) throw new Error("Video project not found");
  await assertClientAccess(user.id, project.client_id);
  return project;
}

function view(raw: VideoProject) {
  const project = effectiveProject(raw);
  const chosen = project.chosen_script;
  return {
    id: project.id,
    name: projectName(project),
    status: project.status,
    error: project.error,
    inputs: project.inputs,
    assets: project.assets.map((a) => ({
      id: a.id,
      name: a.name,
      summary: a.analysis?.summary ?? a.caption ?? "",
      kind: a.analysis?.kind ?? null,
      stats: a.analysis?.stats ?? [],
      analysed: Boolean(a.analysis),
      url: `/api/creatives/video/${project.id}/assets/${a.id}`,
    })),
    progress: project.progress ?? null,
    brand: project.brand ? { name: project.brand.name, colors: project.brand.colors, hasLogo: Boolean(project.brand.manifest?.logo) } : null,
    brandCheck: brandView(project),
    contextBrief: project.brand?.brief ?? null,
    angleLimitation: project.brand?.angleLimitation ?? null,
    wordsPerSecond: project.inputs.speechRate ?? null,
    creative: project.plan?.creative ?? null,
    capabilities: project.plan?.capabilities ?? null,
    scripts: project.scripts,
    chosenScript: chosen,
    plan: chosen ? previewPlan(chosen, project.inputs, project.assets.length) : null,
    generation: viewGeneration(project),
  };
}

export async function GET(_request: Request, ctx: Ctx) {
  return withApiHandler(async () => jsonOk(view(await load(ctx))));
}

const sceneEdit = z.object({
  number: z.number().int(),
  seconds: z.number().min(2).max(30),
  visual: z.string().min(1).max(1200),
  camera: z.string().max(400),
  speaker: z.enum(["on_camera", "voiceover", "none"]),
  line: z.string().max(600),
  keywords: z.array(z.string().max(60)).max(3),
  stat: z.string().max(80).nullable(),
  assetId: z.string().nullable(),
  sound: z.string().max(400),
  originalLine: z.string().max(600).nullable().optional(),
});

const confirmSchema = z.object({
  scriptId: z.string().min(1),
  edits: z.object({
    title: z.string().max(120),
    scenes: z.array(sceneEdit).min(2).max(16),
    adCopy: z.object({ primaryText: z.string().max(2200), headline: z.string().max(80), description: z.string().max(80), cta: z.string().max(40) }),
  }),
});

/** Confirm a script, with the operator's edits applied. Nothing is generated yet. */
export async function PATCH(request: Request, ctx: Ctx) {
  return withApiHandler(async () => {
    const project = await load(ctx);
    const body = await parseBody(request, confirmSchema);
    const original = project.scripts?.find((s) => s.id === body.scriptId);
    if (!original) throw new Error("That script is not part of this project.");

    // Lengths follow the words: the client's seconds only matter for a scene with no speech.
    // A scene the operator changed is approved wording: later rewrites keep it.
    const scenes = retime(markEdited(original, body.edits.scenes).map((s, i) => ({ ...s, number: i + 1 })));
    const cursor = scenes.length ? scenes[scenes.length - 1]!.end : 0;
    if (cursor > MAX_SECONDS) throw new Error(`The script runs ${cursor}s; the limit is ${MAX_SECONDS}s.`);
    const edited: VideoScript = {
      ...original,
      title: body.edits.title,
      durationSeconds: cursor,
      scenes,
      adCopy: body.edits.adCopy,
      warnings: [],
      // The review was of the version before these edits.
      verification: null,
    };
    // Numbers the operator typed count as theirs; the rest must come from the page, the inputs or the original script.
    const corpus = [JSON.stringify(project.inputs), project.brand?.summary ?? "", JSON.stringify(original), body.edits.scenes.map((s) => `${s.line} ${s.stat ?? ""}`).join(" ")].join("\n");
    // A figure the operator typed in the editor (not in the version written for them) is theirs, with that recorded as its source.
    const manifest = project.brand?.manifest ?? null;
    let claims = manifest?.claims;
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
    edited.warnings = checkScript(edited, { corpus, assetIds: project.assets.map((a) => a.id), target: cursor, claims });
    // Length and the spoken estimate follow the words as they now stand.
    const withLength = { ...withSpeech(edited, project.inputs.speechRate, original.speech?.requestedSeconds ?? project.inputs.targetSeconds), warnings: edited.warnings };
    const updated = await updateProject(project.id, { chosen_script: withLength, status: "confirmed", ...(brand !== project.brand ? { brand } : {}) });
    return jsonOk(view(updated));
  });
}

/** Delete a project and the images uploaded for it. */
export async function DELETE(_request: Request, ctx: Ctx) {
  return withApiHandler(async () => {
    const project = await load(ctx);
    const storage = getObjectStorage();
    await Promise.all(project.assets.map((a) => storage.delete(a.key).catch(() => undefined)));
    await deleteProject(project.id);
    return jsonOk({ deleted: true });
  });
}

/** Write a fresh set of three scripts. */
export async function POST(_request: Request, ctx: Ctx) {
  return withApiHandler(async () => {
    const project = await load(ctx);
    await updateProject(project.id, { status: "writing", error: null, scripts: null, chosen_script: null });
    runAfterResponse("video-scripts", () => writeProjectScripts(project.id));
    return jsonOk({ ok: true });
  });
}
