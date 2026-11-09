import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { getObjectStorage } from "@/lib/storage/r2";
import { getProject } from "@/lib/video/projects";

type Ctx = { params: Promise<{ id: string }> };

/** The verified logo, exactly as saved, for the brand check on screen. */
export async function GET(_request: Request, ctx: Ctx) {
  const user = await getCurrentUser();
  assertAuthenticated(user);
  const { id } = await ctx.params;
  const project = await getProject(id);
  const logo = project?.brand?.manifest?.logo;
  if (!project || !logo) return new Response("Not found", { status: 404 });
  await assertClientAccess(user.id, project.client_id);
  const bytes = await getObjectStorage().get(logo.storageKey);
  if (!bytes) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(bytes), { headers: { "Content-Type": logo.mime, "Cache-Control": "private, max-age=3600" } });
}
