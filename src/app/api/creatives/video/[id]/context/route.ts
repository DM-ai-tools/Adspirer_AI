import { z } from "zod";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { getProject, updateProject } from "@/lib/video/projects";
import { writeProjectScripts } from "@/lib/video/brief";
import { editBriefDefaults } from "@/lib/video/creative-brief";
import { initialProgress } from "@/lib/video/progress";
import { runAfterResponse } from "@/lib/api/background";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";

export const maxDuration = 300;
type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  /** The optional creative inputs (the defaults in force are shown on screen and can be changed here). */
  audience: z.string().max(400).nullish(),
  tone: z.string().max(200).nullish(),
  goal: z.string().max(300).nullish(),
  platform: z.string().max(120).nullish(),
  speechRate: z.number().min(1.8).max(3.2).nullish(),
  /** Missing context the operator is supplying so the scripts can be written without inventing anything. */
  offerDetails: z.string().max(4000).nullish(),
  instructions: z.string().max(4000).nullish(),
  landingPageUrl: z.string().url().nullish(),
  /** Write the scripts again with these inputs. */
  rewrite: z.boolean().default(false),
});

/**
 * Edit what the scripts are written from: the visible defaults (audience, tone, goal, platform,
 * speech rate) and any missing context. With `rewrite` the three scripts are written again from the
 * updated inputs; without it only the stored defaults change.
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

    const set = <T,>(next: T | null | undefined, prior: T | null | undefined) => (next === undefined ? (prior ?? null) : (typeof next === "string" ? (next.trim() || null) : next));
    const inputs = {
      ...project.inputs,
      audience: set(body.audience, project.inputs.audience),
      tone: set(body.tone, project.inputs.tone),
      goal: set(body.goal, project.inputs.goal),
      platform: set(body.platform, project.inputs.platform),
      speechRate: body.speechRate === undefined ? (project.inputs.speechRate ?? null) : body.speechRate,
      offerDetails: body.offerDetails === undefined ? project.inputs.offerDetails : [project.inputs.offerDetails, body.offerDetails].filter(Boolean).join("\n\n") || null,
      instructions: body.instructions === undefined ? project.inputs.instructions : [project.inputs.instructions, body.instructions].filter(Boolean).join("\n\n") || null,
      landingPageUrl: body.landingPageUrl === undefined ? project.inputs.landingPageUrl : body.landingPageUrl,
    };

    if (body.rewrite) {
      await updateProject(project.id, { inputs, status: "writing", error: null, scripts: null, chosen_script: null, progress: initialProgress() });
      runAfterResponse("video-scripts", () => writeProjectScripts(project.id));
      return jsonOk({ rewriting: true });
    }
    const brief = project.brand?.brief;
    const brand = brief && project.brand ? { ...project.brand, brief: editBriefDefaults(brief, { audience: inputs.audience, platform: inputs.platform, tone: inputs.tone, goal: inputs.goal }) } : project.brand;
    await updateProject(project.id, { inputs, ...(brand ? { brand } : {}) });
    return jsonOk({ rewriting: false });
  });
}
