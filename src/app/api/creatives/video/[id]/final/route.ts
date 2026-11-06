import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { getObjectStorage } from "@/lib/storage/r2";
import { getProject } from "@/lib/video/projects";
import { projectName } from "@/lib/video/naming";
import { streamVideo } from "@/lib/video/stream";

type Ctx = { params: Promise<{ id: string }> };

/** The finished video, for the player and for download. */
export async function GET(request: Request, ctx: Ctx) {
  const user = await getCurrentUser();
  assertAuthenticated(user);
  const { id } = await ctx.params;
  const project = await getProject(id);
  if (!project?.final?.key) return new Response("Not found", { status: 404 });
  await assertClientAccess(user.id, project.client_id);
  const bytes = await getObjectStorage().get(project.final.key);
  if (!bytes) return new Response("Not found", { status: 404 });
  const slug = projectName(project).replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "video-ad";
  return streamVideo(request, bytes, `${slug}.mp4`);
}
