import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { getObjectStorage } from "@/lib/storage/r2";
import { getProject } from "@/lib/video/projects";
import { projectName } from "@/lib/video/naming";
import { streamVideo } from "@/lib/video/stream";

type Ctx = { params: Promise<{ id: string }> };

/**
 * The finished video, for the player and for download. A video that failed a critical check is
 * never served as the finished video: only `?review=1` shows it, to see what failed, and it is not
 * offered for download. `?subtitles=srt|vtt` serves the subtitle file timed to this export's audio,
 * and `?file=transcript|plan|plan-json` the transcript and the placement plan handed over beside a
 * clean video. None of those is inside the MP4.
 */
export async function GET(request: Request, ctx: Ctx) {
  const user = await getCurrentUser();
  assertAuthenticated(user);
  const { id } = await ctx.params;
  const project = await getProject(id);
  const final = project?.final;
  if (!project || !final) return new Response("Not found", { status: 404 });
  await assertClientAccess(user.id, project.client_id);
  const slug = projectName(project).replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "video-ad";
  const params = new URL(request.url).searchParams;
  const storage = getObjectStorage();

  const subtitles = params.get("subtitles");
  if (subtitles === "srt" || subtitles === "vtt") {
    if (final.state !== "done" || !final.subtitles) return new Response("Not found", { status: 404 });
    const bytes = await storage.get(subtitles === "srt" ? final.subtitles.srtKey : final.subtitles.vttKey);
    if (!bytes) return new Response("Not found", { status: 404 });
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": subtitles === "srt" ? "application/x-subrip; charset=utf-8" : "text/vtt; charset=utf-8",
        "Content-Disposition": `attachment; filename="${slug}.${subtitles}"`,
      },
    });
  }

  const file = params.get("file");
  if (file === "transcript" || file === "plan" || file === "plan-json") {
    if (final.state !== "done" || !final.deliverables) return new Response("Not found", { status: 404 });
    const d = final.deliverables;
    const bytes = await storage.get(file === "transcript" ? d.transcriptKey : file === "plan" ? d.planTextKey : d.planJsonKey);
    if (!bytes) return new Response("Not found", { status: 404 });
    const name = file === "transcript" ? `${slug}-transcript.txt` : file === "plan" ? `${slug}-placement-plan.txt` : `${slug}-placement-plan.json`;
    return new Response(new Uint8Array(bytes), {
      headers: { "Content-Type": file === "plan-json" ? "application/json; charset=utf-8" : "text/plain; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"` },
    });
  }

  if (params.get("review") === "1") {
    if (!final.reviewKey) return new Response("Not found", { status: 404 });
    const bytes = await storage.get(final.reviewKey);
    if (!bytes) return new Response("Not found", { status: 404 });
    // Inline only: no filename, so the player shows it but the page offers no download of an unapproved file.
    return streamVideo(request, bytes, null);
  }

  if (final.state !== "done" || !final.key) return new Response("This video has not passed its checks.", { status: 409 });
  const bytes = await storage.get(final.key);
  if (!bytes) return new Response("Not found", { status: 404 });
  return streamVideo(request, bytes, final.mode === "clean" ? `${slug}-clean.mp4` : `${slug}.mp4`);
}
