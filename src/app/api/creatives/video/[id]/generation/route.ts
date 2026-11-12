import { z } from "zod";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { getProject } from "@/lib/video/projects";
import { burnInGraphics } from "@/lib/video/burn-in";
import { acceptBlockedFinal, advance, blockedReason, continueGeneration, regenerateFrom, resolveDecision, runGeneration, startGeneration, stopGeneration, viewGeneration } from "@/lib/video/generation";
import { assembleVideo } from "@/lib/video/assemble";
import { runAfterResponse } from "@/lib/api/background";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";

export const maxDuration = 300;
type Ctx = { params: Promise<{ id: string }> };

async function loadWithUser(ctx: Ctx) {
  const user = await getCurrentUser();
  assertAuthenticated(user);
  const { id } = await ctx.params;
  const project = await getProject(id);
  if (!project) throw new Error("Video project not found");
  await assertClientAccess(user.id, project.client_id);
  return { project, userId: user.id };
}

const load = async (ctx: Ctx) => (await loadWithUser(ctx)).project;

export async function GET(_request: Request, ctx: Ctx) {
  return withApiHandler(async () => jsonOk(viewGeneration(await load(ctx))));
}

/**
 * How the video is finished. Left out, or without a mode, it is a clean video: footage and sound
 * only. The three flags are honoured only together with `mode: "branded"`, so a request (or a setting
 * kept from an older video) that merely carries `captions: true` cannot put graphics into a clean export.
 */
const finishing = z.object({ mode: z.enum(["clean", "branded"]).optional(), captions: z.boolean().optional(), logo: z.boolean().optional(), endCard: z.boolean().optional() });

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), finishing: finishing.optional(), checkpoint: z.enum(["after_first", "each", "none"]).optional() }),
  /** Stop spending: clips already made are kept. */
  z.object({ action: z.literal("stop") }),
  /** Carry on after a pause (the clip just checked is approved) or after a stop. */
  z.object({ action: z.literal("continue") }),
  /** Join the clips again (after a failure, or with different captions, logo or end card). */
  z.object({ action: z.literal("assemble"), finishing: finishing.optional() }),
  /** The page calls this while it is open, so a video carries on after the first request's time runs out. */
  z.object({ action: z.literal("advance") }),
  /** What to do with a clip that did not pass its inspection: make it again (paid for), use it as it is, or inspect it again. */
  z.object({ action: z.literal("decide"), clip: z.number().int().min(1), choice: z.enum(["remake", "use", "inspect"]) }),
  /** Deliver an export the inspection blocked, as the operator's decision. */
  z.object({ action: z.literal("accept_final") }),
  /** Make an extra export of the finished clean video with the subtitles and/or the verified logo drawn in. */
  z.object({ action: z.literal("add_graphics"), captions: z.boolean(), logo: z.boolean() }),
  z.object({ action: z.literal("regenerate"), fromClip: z.number().int().min(1), /** From clip 1 only: make a new creative plan instead of keeping the approved one. */ replan: z.boolean().optional() }),
]);

export async function POST(request: Request, ctx: Ctx) {
  return withApiHandler(async () => {
    const { project, userId } = await loadWithUser(ctx);
    const body = await parseBody(request, bodySchema);

    if (body.action === "start") {
      if (project.status === "generating") return jsonOk(viewGeneration(project));
      const blocked = blockedReason(project);
      if (blocked) throw new Error(blocked);
      const started = await startGeneration(project.id, body.finishing, body.checkpoint);
      runAfterResponse("video-generation", () => runGeneration(project.id));
      return jsonOk(viewGeneration(started));
    }

    if (body.action === "stop") {
      if (project.status !== "generating" && project.status !== "paused") return jsonOk(viewGeneration(project));
      return jsonOk(viewGeneration(await stopGeneration(project.id)));
    }

    if (body.action === "continue") {
      const next = await continueGeneration(project.id);
      if (next.status === "generating") runAfterResponse("video-generation", () => runGeneration(project.id));
      return jsonOk(viewGeneration(next));
    }

    if (body.action === "decide") {
      // "use" is the operator's own decision to keep a clip the inspection did not approve: recorded with who made it and what was open.
      const next = await resolveDecision(project.id, body.clip, body.choice, userId);
      if (next.status === "generating") runAfterResponse("video-generation", () => runGeneration(project.id));
      return jsonOk(viewGeneration(next));
    }

    if (body.action === "accept_final") {
      return jsonOk(viewGeneration(await acceptBlockedFinal(project.id, userId)));
    }

    if (body.action === "add_graphics") {
      if (!project.final || project.final.state !== "done" || !project.final.key) throw new Error("Finish the video before adding a logo or subtitles.");
      if (!body.captions && !body.logo) throw new Error("Choose subtitles, the logo, or both.");
      if (project.final.withGraphics?.state === "running") return jsonOk(viewGeneration(project));
      const running = { ...project, final: { ...project.final, withGraphics: { state: "running" as const, stage: "Starting", error: null, key: null, captions: body.captions, logo: body.logo, startedAt: new Date().toISOString(), createdAt: null, bytes: null } } };
      runAfterResponse("video-graphics", () => burnInGraphics(project.id, { captions: body.captions, logo: body.logo }));
      return jsonOk(viewGeneration(running));
    }

    if (body.action === "assemble") {
      if (!project.clips?.length || project.clips.some((c) => c.status !== "succeeded")) throw new Error("Every clip must be finished before they are joined.");
      if (project.status === "assembling") return jsonOk(viewGeneration(project));
      runAfterResponse("video-assembly", () => assembleVideo(project.id, body.finishing ?? {}));
      return jsonOk(viewGeneration({ ...project, status: "assembling" }));
    }

    if (body.action === "regenerate") {
      // New clips are only paid for from a verified brand.
      const blocked = blockedReason(project);
      if (blocked && !project.plan?.creative) throw new Error(blocked);
      const next = await regenerateFrom(project.id, body.fromClip, { replan: body.replan });
      runAfterResponse("video-generation", () => runGeneration(project.id));
      return jsonOk(viewGeneration(next));
    }

    // advance: do one step now and answer with the state; keep going in the background if time allows.
    if (project.status === "generating") {
      await advance(project.id);
      runAfterResponse("video-generation", () => runGeneration(project.id, 200_000));
    }
    return jsonOk(viewGeneration((await getProject(project.id)) ?? project));
  });
}
