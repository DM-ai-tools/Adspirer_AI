import { z } from "zod";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { deleteProject, getProject, updateProject, type VideoProject } from "@/lib/video/projects";
import { projectName } from "@/lib/video/naming";
import { viewGeneration } from "@/lib/video/generation";
import { getObjectStorage } from "@/lib/storage/r2";
import { writeProjectScripts } from "@/lib/video/brief";
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

function view(project: VideoProject) {
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
    brand: project.brand ? { name: project.brand.name, colors: project.brand.colors, hasLogo: Boolean(project.brand.logoUrl) } : null,
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
    const scenes = retime(body.edits.scenes.map((s, i) => ({ ...s, number: i + 1 })));
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
    edited.warnings = checkScript(edited, { corpus, assetIds: project.assets.map((a) => a.id), target: cursor });
    const updated = await updateProject(project.id, { chosen_script: edited, status: "confirmed" });
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
