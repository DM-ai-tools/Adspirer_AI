import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { getObjectStorage } from "@/lib/storage/r2";
import { getProject } from "@/lib/video/projects";

type Ctx = { params: Promise<{ id: string; assetId: string }> };

/** An image the operator uploaded for the video, served to people with access to the client. */
export async function GET(_request: Request, ctx: Ctx) {
  const user = await getCurrentUser();
  assertAuthenticated(user);
  const { id, assetId } = await ctx.params;
  const project = await getProject(id);
  const asset = project?.assets.find((a) => a.id === assetId);
  if (!project || !asset) return new Response("Not found", { status: 404 });
  await assertClientAccess(user.id, project.client_id);
  const bytes = await getObjectStorage().get(asset.key);
  if (!bytes) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(bytes), { headers: { "Content-Type": asset.mime, "Cache-Control": "private, max-age=3600" } });
}
