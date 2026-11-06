import { z } from "zod";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { getProject } from "@/lib/video/projects";
import { advance, blockedReason, continueGeneration, regenerateFrom, runGeneration, startGeneration, stopGeneration, viewGeneration } from "@/lib/video/generation";
import { assembleVideo } from "@/lib/video/assemble";
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

export async function GET(_request: Request, ctx: Ctx) {
  return withApiHandler(async () => jsonOk(viewGeneration(await load(ctx))));
}

const finishing = z.object({ captions: z.boolean(), logo: z.boolean(), endCard: z.boolean() });

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
  z.object({ action: z.literal("regenerate"), fromClip: z.number().int().min(1) }),
]);

export async function POST(request: Request, ctx: Ctx) {
  return withApiHandler(async () => {
    const project = await load(ctx);
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

    if (body.action === "assemble") {
      if (!project.clips?.length || project.clips.some((c) => c.status !== "succeeded")) throw new Error("Every clip must be finished before they are joined.");
      if (project.status === "assembling") return jsonOk(viewGeneration(project));
      runAfterResponse("video-assembly", () => assembleVideo(project.id, body.finishing ?? {}));
      return jsonOk(viewGeneration({ ...project, status: "assembling" }));
    }

    if (body.action === "regenerate") {
      const next = await regenerateFrom(project.id, body.fromClip);
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
