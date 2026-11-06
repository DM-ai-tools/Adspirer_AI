import { z } from "zod";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { getProject } from "@/lib/video/projects";
import { advance, blockedReason, regenerateFrom, runGeneration, startGeneration, viewGeneration } from "@/lib/video/generation";
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

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start") }),
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
      const started = await startGeneration(project.id);
      runAfterResponse("video-generation", () => runGeneration(project.id));
      return jsonOk(viewGeneration(started));
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
