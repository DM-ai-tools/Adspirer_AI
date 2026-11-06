import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { getObjectStorage } from "@/lib/storage/r2";
import { getProject } from "@/lib/video/projects";

type Ctx = { params: Promise<{ id: string; n: string }> };

/** A finished clip, for the player and for download. Supports byte ranges so the player can seek. */
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

  const headers: Record<string, string> = { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600" };
  if (new URL(request.url).searchParams.has("download")) headers["Content-Disposition"] = `attachment; filename="clip-${clip.number}.mp4"`;

  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
  if (range) {
    const total = bytes.length;
    const start = range[1] ? Math.min(Number(range[1]), total - 1) : 0;
    const end = range[2] ? Math.min(Number(range[2]), total - 1) : total - 1;
    const slice = bytes.subarray(start, end + 1);
    return new Response(new Uint8Array(slice), { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${total}`, "Content-Length": String(slice.length) } });
  }
  return new Response(new Uint8Array(bytes), { headers: { ...headers, "Content-Length": String(bytes.length) } });
}
