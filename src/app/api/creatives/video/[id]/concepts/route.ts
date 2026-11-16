import { z } from "zod";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { getProject, updateProject } from "@/lib/video/projects";
import { moreConcepts, writeConceptScript } from "@/lib/video/brief";
import { runAfterResponse } from "@/lib/api/background";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";

export const maxDuration = 300;
type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.discriminatedUnion("action", [
  /** Write the full voiceover and scenes for this concept. */
  z.object({ action: z.literal("pick"), conceptId: z.string().min(1) }),
  /** Three new concepts, optionally steered by what the operator wants different. */
  z.object({ action: z.literal("more"), feedback: z.string().max(1000).optional() }),
  /** Back to the concepts on show, keeping every script already written. */
  z.object({ action: z.literal("back") }),
  /** Open a script already written (from the concepts screen): it can then be changed and confirmed. */
  z.object({ action: z.literal("open"), scriptId: z.string().min(1) }),
]);

/** While a concept can still be chosen: before a script is confirmed. */
const OPEN = new Set(["concepts_ready", "scripts_ready", "failed"]);

export async function POST(request: Request, ctx: Ctx) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const { id } = await ctx.params;
    const project = await getProject(id);
    if (!project) throw new Error("Video project not found");
    await assertClientAccess(user.id, project.client_id);
    const body = await parseBody(request, bodySchema);
    if (!project.brand?.concepts?.length) throw new Error("This video has no concepts. Write the script again to get some.");
    // A failed video that already had a script confirmed (and maybe clips) is not sent back to concepts from here.
    if (!OPEN.has(project.status) || (project.status === "failed" && project.chosen_script)) throw new Error(project.status === "writing" ? "Still working on the last request. Wait for it to finish." : "A script is already confirmed for this video. Edit the script to change it.");

    if (body.action === "open") {
      if (!project.scripts?.some((s) => s.id === body.scriptId)) throw new Error("That script is not part of this video.");
      await updateProject(id, { status: "scripts_ready", error: null });
      return jsonOk({ ok: true });
    }
    if (body.action === "back") {
      await updateProject(id, { status: "concepts_ready", error: null });
      return jsonOk({ ok: true });
    }
    if (body.action === "pick") {
      if (!project.brand.concepts.some((c) => c.id === body.conceptId)) throw new Error("That concept is no longer on this video. Pick one of those shown.");
      await updateProject(id, { status: "writing", error: null });
      runAfterResponse("video-concept-script", () => writeConceptScript(id, body.conceptId));
      return jsonOk({ started: true });
    }
    await updateProject(id, { status: "writing", error: null });
    runAfterResponse("video-more-concepts", () => moreConcepts(id, body.feedback?.trim() || null));
    return jsonOk({ started: true });
  });
}
