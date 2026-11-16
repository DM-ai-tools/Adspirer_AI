import { z } from "zod";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { deleteProject, getProject, updateProject, type VideoProject } from "@/lib/video/projects";
import { projectName } from "@/lib/video/naming";
import { effectiveProject, viewGeneration } from "@/lib/video/generation";
import { getObjectStorage } from "@/lib/storage/r2";
import { writeProjectScripts } from "@/lib/video/brief";
import { brandView } from "@/lib/video/brand-view";
import { logoState } from "@/lib/video/brand-resolve";
import { assetCautions, purposeOf } from "@/lib/video/assets";
import { splitLabel } from "@/lib/video/evidence";
import { confirmScript } from "@/lib/video/script-actions";
import { pickMainStat } from "@/lib/video/required-stats";
import { previewPlan } from "@/lib/video/plan-view";
import { runAfterResponse } from "@/lib/api/background";
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

async function view(raw: VideoProject) {
  const project = effectiveProject(raw);
  const chosen = project.chosen_script;
  // Read from storage now: the screen shows a logo as verified only while its file can actually be loaded.
  const logo = await logoState(project.brand?.manifest, project.inputs.brandChoice?.logoApprovedKey);
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
      mainStat: pickMainStat(a.analysis?.stats ?? [], a.analysis?.mainStat),
      analysed: Boolean(a.analysis),
      url: `/api/creatives/video/${project.id}/assets/${a.id}`,
      downloadUrl: `/api/creatives/video/${project.id}/assets/${a.id}?download=1`,
      purpose: purposeOf(a),
      version: a.version ?? 1,
      sha256: a.sha256 ?? null,
      /** Each figure with the label the image itself prints, and separately any label added on top of it. */
      labels: (a.analysis?.stats ?? []).map((s) => ({ value: s.value, ...splitLabel(s) })),
      dateRange: a.analysis?.dateRange ?? null,
      annotations: a.analysis?.annotations ?? [],
      cautions: assetCautions(a).map((c) => c.message),
    })),
    progress: project.progress ?? null,
    brand: project.brand ? { name: project.brand.name, colors: project.brand.colors, hasLogo: logo.saved && logo.accessible } : null,
    brandCheck: brandView(project, logo),
    contextBrief: project.brand?.brief ?? null,
    angleLimitation: project.brand?.angleLimitation ?? null,
    concepts: project.brand?.concepts ?? [],
    conceptLimitation: project.brand?.conceptLimitation ?? null,
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
  return withApiHandler(async () => jsonOk(await view(await load(ctx))));
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
  lines: z.array(z.object({ voiceId: z.string().max(40), text: z.string().max(600), onCamera: z.boolean() })).max(2).optional(),
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
    const { chosen, brand } = confirmScript(project, body);
    const updated = await updateProject(project.id, { chosen_script: chosen, status: "confirmed", ...(brand !== project.brand ? { brand } : {}) });
    return jsonOk(await view(updated));
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
