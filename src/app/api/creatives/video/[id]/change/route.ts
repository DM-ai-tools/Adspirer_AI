import { z } from "zod";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { getProject, updateProject } from "@/lib/video/projects";
import { applyChange, planChange, undoChange } from "@/lib/video/change-request";
import { applyDraft } from "@/lib/video/script-actions";
import type { VideoScript } from "@/lib/video/script";

/** Undo goes back to the script as it was saved before this request. */
function undoBase(script: VideoScript): VideoScript {
  const before = { ...script };
  delete before.previousVersion;
  return before;
}
import { rewriteConceptScript } from "@/lib/video/brief";
import { runAfterResponse } from "@/lib/api/background";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";

export const maxDuration = 300;
type Ctx = { params: Promise<{ id: string }> };

const draftSceneLine = z.object({ voiceId: z.string().max(40), text: z.string().max(600), onCamera: z.boolean() });
const draftScene = z.object({
  number: z.number().int(),
  seconds: z.number().min(0).max(60),
  visual: z.string().max(1200),
  camera: z.string().max(400),
  speaker: z.enum(["on_camera", "voiceover", "none"]),
  line: z.string().max(600),
  keywords: z.array(z.string().max(60)).max(3),
  stat: z.string().max(80).nullable(),
  assetId: z.string().nullable(),
  sound: z.string().max(400),
  originalLine: z.string().max(600).nullable().optional(),
  lines: z.array(draftSceneLine).max(2).optional(),
});
/** What is on screen now, including edits not saved yet: the change is made on top of it, so those edits are kept. */
const draftSchema = z.object({
  title: z.string().max(120),
  scenes: z.array(draftScene).min(1).max(30),
  adCopy: z.object({ primaryText: z.string().max(2200), headline: z.string().max(80), description: z.string().max(80), cta: z.string().max(40) }),
});

const bodySchema = z.union([
  z.object({ scriptId: z.string().min(1), request: z.string().min(3).max(2000), draft: draftSchema.optional() }),
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

    // Unsaved edits on screen are applied first (each changed scene is the operator's from then on), then the change.
    const base = body.draft ? applyDraft(script, body.draft, { wordsPerSecond: project.inputs.speechRate, requestedSeconds: script.speech?.requestedSeconds ?? project.inputs.targetSeconds, corpus: project.brand?.corpus ?? "", assetIds: project.assets.map((a) => a.id) }) : script;
    const plan = await planChange(base, body.request, { facts: project.brand?.facts ?? "" });
    if (plan.problem) return jsonOk({ changed: false, problem: plan.problem });
    if (plan.scope === "concept") {
      await updateProject(id, { status: "writing", error: null, ...(base !== script ? { scripts: replace(base) } : {}) });
      runAfterResponse("video-concept-rewrite", () => rewriteConceptScript(id, script.id, body.request));
      return jsonOk({ changed: true, started: true, summary: plan.summary || "Rewriting the script around the new idea." });
    }
    const next = { ...applyChange(base, plan), previousVersion: undoBase(script) };
    await updateProject(id, { scripts: replace(next) });
    return jsonOk({ changed: true, summary: next.changeNote });
  });
}
