import { z } from "zod";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { getProject, updateProject } from "@/lib/video/projects";
import { applyChange, planChange, undoChange } from "@/lib/video/change-request";
import { rewriteConceptScript } from "@/lib/video/brief";
import { runAfterResponse } from "@/lib/api/background";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";

export const maxDuration = 300;
type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.union([
  z.object({ scriptId: z.string().min(1), request: z.string().min(3).max(2000) }),
  z.object({ scriptId: z.string().min(1), action: z.literal("undo") }),
]);

/**
 * Change a script by saying what to change, or undo the last change. A change to the voiceover,
 * some scenes or the ad copy is applied at once; a change to the idea itself rewrites the script
 * from the concept in the background.
 */
export async function POST(request: Request, ctx: Ctx) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const { id } = await ctx.params;
    const project = await getProject(id);
    if (!project) throw new Error("Video project not found");
    await assertClientAccess(user.id, project.client_id);
    const body = await parseBody(request, bodySchema);
    if (project.status !== "scripts_ready") throw new Error(project.status === "writing" ? "Still working on the last request. Wait for it to finish." : "This script can't be changed now. Edit the script first.");
    const scripts = project.scripts ?? [];
    const script = scripts.find((s) => s.id === body.scriptId);
    if (!script) throw new Error("That script is not part of this project.");
    const replace = (next: typeof script) => scripts.map((s) => (s.id === script.id ? next : s));

    if ("action" in body) {
      const previous = undoChange(script);
      if (!previous) throw new Error("There is no earlier version of this script to go back to.");
      await updateProject(id, { scripts: replace(previous) });
      return jsonOk({ undone: true });
    }

    const plan = await planChange(script, body.request, { facts: project.brand?.facts ?? "" });
    if (plan.problem) return jsonOk({ changed: false, problem: plan.problem });
    if (plan.scope === "concept") {
      await updateProject(id, { status: "writing", error: null });
      runAfterResponse("video-concept-rewrite", () => rewriteConceptScript(id, script.id, body.request));
      return jsonOk({ changed: true, started: true, summary: plan.summary || "Rewriting the script around the new idea." });
    }
    const next = applyChange(script, plan);
    await updateProject(id, { scripts: replace(next) });
    return jsonOk({ changed: true, summary: next.changeNote });
  });
}
