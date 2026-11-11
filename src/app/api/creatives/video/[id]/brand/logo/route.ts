import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { getProject } from "@/lib/video/projects";
import { loadManifestLogo, restoreManifestLogo } from "@/lib/video/brand-resolve";
import { logoFileName } from "@/lib/video/assemble";

type Ctx = { params: Promise<{ id: string }> };

/**
 * The verified logo, exactly as saved: for the brand check on screen and, with `?download=1`, as
 * the original file to add to a clean video by hand. Served from storage by this route on every
 * request (no expiring address is ever handed out). If storage has lost the file it is put back from
 * where it came from, but only when what comes back is the same file.
 */
export async function GET(request: Request, ctx: Ctx) {
  const user = await getCurrentUser();
  assertAuthenticated(user);
  const { id } = await ctx.params;
  const project = await getProject(id);
  const manifest = project?.brand?.manifest;
  const logo = manifest?.logo;
  if (!project || !manifest || !logo) return new Response("Not found", { status: 404 });
  await assertClientAccess(user.id, project.client_id);
  let bytes = await loadManifestLogo(manifest);
  if (!bytes && (await restoreManifestLogo(manifest, { uploadKey: project.inputs.brandChoice?.logoUploadKey }))) bytes = await loadManifestLogo(manifest);
  if (!bytes) return new Response("The logo file is no longer in storage. Check the brand again or upload the logo.", { status: 404 });
  const headers: Record<string, string> = { "Content-Type": logo.mime, "Cache-Control": "private, max-age=300" };
  if (new URL(request.url).searchParams.has("download")) headers["Content-Disposition"] = `attachment; filename="${(logoFileName(manifest) ?? "logo").replace(/[^\w .()-]/g, "_")}"`;
  return new Response(new Uint8Array(bytes), { headers });
}
