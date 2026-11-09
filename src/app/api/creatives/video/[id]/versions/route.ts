import { z } from "zod";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { getProject, updateProject } from "@/lib/video/projects";
import { reviseVersion } from "@/lib/video/script-actions";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";

export const maxDuration = 300;
type Ctx = { params: Promise<{ id: string }> };

const sceneDraft = z.object({
  number: z.number().int(),
  seconds: z.number().min(2).max(30),
  visual: z.string().max(1200),
  camera: z.string().max(400),
  speaker: z.enum(["on_camera", "voiceover", "none"]),
  line: z.string().max(600),
  keywords: z.array(z.string().max(60)).max(3),
  stat: z.string().max(80).nullable(),
  assetId: z.string().nullable(),
  sound: z.string().max(400),
  originalLine: z.string().max(600).nullable().optional(),
});

const bodySchema = z.object({
  scriptId: z.string().min(1),
  action: z.enum(["regenerate", "rewrite_delivery", "change_angle", "retime"]),
  /** What the operator wants, in their words (a different direction, a different delivery). Optional. */
  instruction: z.string().max(1500).nullish(),
  /** For "retime": the new length in seconds. */
  seconds: z.number().int().min(15).max(60).nullish(),
  /** The script as it stands on screen, including edits not saved yet: scenes the operator changed are kept as they are. */
  draft: z
    .object({
      title: z.string().max(120).optional(),
      scenes: z.array(sceneDraft).min(2).max(16),
      adCopy: z.object({ primaryText: z.string().max(2200), headline: z.string().max(80), description: z.string().max(80), cta: z.string().max(40) }).optional(),
    })
    .nullish(),
});

/** Change ONE version (fresh draft, same angle said differently, a different angle, or a new length) and leave the other versions alone. */
export async function POST(request: Request, ctx: Ctx) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const { id } = await ctx.params;
    const project = await getProject(id);
    if (!project) throw new Error("Video project not found");
    await assertClientAccess(user.id, project.client_id);
    if (project.status !== "scripts_ready") throw new Error("Versions can only be changed while you are choosing a script.");
    const body = await parseBody(request, bodySchema);
    const scripts = await reviseVersion(project, { scriptId: body.scriptId, action: body.action, instruction: body.instruction ?? null, seconds: body.seconds ?? null, draft: body.draft ?? null });
    await updateProject(project.id, { scripts });
    return jsonOk({ scripts, scriptId: body.scriptId });
  });
}
