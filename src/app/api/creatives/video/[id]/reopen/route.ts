import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { getProject, updateProject } from "@/lib/video/projects";
import { reopenCheck, reopenPatch } from "@/lib/video/script-actions";
import { jsonOk, withApiHandler } from "@/lib/api/response";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Reopen a confirmed script for last-minute changes. The confirmed version (with the operator's
 * edits) goes back to being the one on screen, and confirming it again is what makes it final.
 * Refused once any clip has been made from it.
 */
export async function POST(_request: Request, ctx: Ctx) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const { id } = await ctx.params;
    const project = await getProject(id);
    if (!project) throw new Error("Video project not found");
    await assertClientAccess(user.id, project.client_id);
    const check = reopenCheck(project);
    if (!check.ok) throw new Error(check.reason);
    await updateProject(project.id, reopenPatch(project));
    return jsonOk({ reopened: true, scriptId: project.chosen_script!.id });
  });
}
