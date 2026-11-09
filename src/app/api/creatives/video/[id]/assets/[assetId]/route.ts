import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { getObjectStorage } from "@/lib/storage/r2";
import { z } from "zod";
import { getProject, updateProject } from "@/lib/video/projects";
import { pickMainStat } from "@/lib/video/required-stats";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";

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

const mainStatBody = z.object({ value: z.string().min(1).max(60) });

/**
 * Choose which of the stats read from an image is its main stat: the one the script must say. Only a
 * stat that was actually read from the image can be chosen.
 */
export async function PATCH(request: Request, ctx: Ctx) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const { id, assetId } = await ctx.params;
    const project = await getProject(id);
    const asset = project?.assets.find((a) => a.id === assetId);
    if (!project || !asset) throw new Error("That image is not part of this project.");
    await assertClientAccess(user.id, project.client_id);
    const body = await parseBody(request, mainStatBody);
    const stats = asset.analysis?.stats ?? [];
    const wanted = body.value.replace(/\s+/g, "").toLowerCase();
    const chosen = stats.find((s) => s.value.replace(/\s+/g, "").toLowerCase() === wanted);
    if (!chosen || !asset.analysis) throw new Error("Choose one of the stats read from this image.");
    const assets = project.assets.map((a) => (a.id === assetId && a.analysis ? { ...a, analysis: { ...a.analysis, mainStat: chosen } } : a));
    await updateProject(project.id, { assets });
    return jsonOk({ id: assetId, mainStat: pickMainStat(stats, chosen) });
  });
}
