import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { getObjectStorage } from "@/lib/storage/r2";
import { getProject } from "@/lib/video/projects";
import { streamVideo } from "@/lib/video/stream";

type Ctx = { params: Promise<{ id: string; n: string }> };

/** A finished clip, for the player and for download. */
export async function GET(request: Request, ctx: Ctx) {
  const user = await getCurrentUser();
  assertAuthenticated(user);
  const { id, n } = await ctx.params;
  const project = await getProject(id);
  const clip = project?.clips?.find((c) => c.number === Number(n));
  if (!project || !clip?.videoKey) return new Response("Not found", { status: 404 });
  await assertClientAccess(user.id, project.client_id);
  const bytes = await getObjectStorage().get(clip.videoKey);
  if (!bytes) return new Response("Not found", { status: 404 });
  return streamVideo(request, bytes, `clip-${clip.number}.mp4`);
}
