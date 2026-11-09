import { z } from "zod";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { getProject, type VideoProject } from "@/lib/video/projects";
import { buildBrief } from "@/lib/video/brief";
import { briefFacts, factsCorpus, MAX_SECONDS, type VideoBrief, type VideoScript } from "@/lib/video/script";
import { regenerateScene, rewriteAdCopy } from "@/lib/video/rewrite";
import { checkOnly, type VerifyContext } from "@/lib/video/verify";
import { retime } from "@/lib/video/timing";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";
import { requiredStatsForProject, withSpeech } from "@/lib/video/script-actions";
import { attachImageStats } from "@/lib/video/required-stats";

export const maxDuration = 120;
type Ctx = { params: Promise<{ id: string }> };

const sceneEdit = z.object({
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
  action: z.enum(["scene", "copy", "check"]),
  sceneNumber: z.number().int().optional(),
  /** What the operator wants changed, in their words. */
  feedback: z.string().max(1500).optional(),
  /** The problems the system showed for this scene or the ad copy, passed back to be fixed. */
  issues: z.array(z.string().max(600)).max(10).optional(),
  /** The script as it stands on screen, including edits that have not been saved. */
  draft: z.object({
    title: z.string().max(120),
    scenes: z.array(sceneEdit).min(2).max(16),
    adCopy: z.object({ primaryText: z.string().max(2200), headline: z.string().max(80), description: z.string().max(80), cta: z.string().max(40) }),
  }),
});

/** What the script was written from. Older projects without it read the site again once. */
async function contextFor(project: VideoProject): Promise<VerifyContext> {
  const brand = project.brand;
  if (brand?.facts && brand.corpus) {
    const brief = { locale: project.inputs.locale, images: project.assets.map((a) => ({ id: a.id })) } as unknown as VideoBrief;
    return { brief, facts: brand.facts, corpus: brand.corpus, assetIds: project.assets.map((a) => a.id), target: 0, claims: brand.manifest?.claims };
  }
  const { brief } = await buildBrief(project);
  return { brief, facts: briefFacts(brief), corpus: factsCorpus(brief), assetIds: brief.images.map((i) => i.id), target: 0, claims: brief.claims };
}

/** Rewrite one scene or the ad copy, from the operator's feedback and/or the problems found, and re-check the script. */
export async function POST(request: Request, ctx: Ctx) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const { id } = await ctx.params;
    const project = await getProject(id);
    if (!project) throw new Error("Video project not found");
    await assertClientAccess(user.id, project.client_id);
    const body = await parseBody(request, bodySchema);

    const original = project.scripts?.find((s) => s.id === body.scriptId) ?? (project.chosen_script?.id === body.scriptId ? project.chosen_script : null);
    if (!original) throw new Error("That script is not part of this project.");

    // The script as it is on screen: the original's angle and presenter with the operator's current scenes and copy.
    // Lengths follow the words: the client's seconds only matter for a scene with no speech.
    const scenes = retime(body.draft.scenes.map((s, i) => ({ ...s, number: i + 1 })));
    const cursor = scenes.length ? scenes[scenes.length - 1]!.end : 0;
    if (cursor > MAX_SECONDS) throw new Error(`The script runs ${cursor}s; the limit is ${MAX_SECONDS}s.`);
    let script: VideoScript = { ...original, title: body.draft.title, durationSeconds: cursor, scenes, adCopy: body.draft.adCopy, warnings: [] };

    const base = await contextFor(project);
    const vctx: VerifyContext = { ...base, target: cursor };
    const rewriteCtx = { facts: base.facts, assetIds: base.assetIds, locale: project.inputs.locale };

    let scene: VideoScript["scenes"][number] | null = null;
    let adCopy: VideoScript["adCopy"] | null = null;
    if (body.action === "scene") {
      if (!body.sceneNumber) throw new Error("sceneNumber is required");
      scene = await regenerateScene({ script, sceneNumber: body.sceneNumber, feedback: body.feedback, issues: body.issues, ctx: rewriteCtx });
      script = { ...script, scenes: script.scenes.map((s) => (s.number === scene!.number ? scene! : s)) };
    } else if (body.action === "copy") {
      adCopy = await rewriteAdCopy({ script, feedback: body.feedback, issues: body.issues, ctx: rewriteCtx });
      script = { ...script, adCopy };
    }

    const verification = await checkOnly(script, vctx);
    // The length and the spoken estimate for the words as they stand now.
    const speech = withSpeech(script, project.inputs.speechRate, original.speech?.requestedSeconds ?? project.inputs.targetSeconds).speech ?? null;
    const checked = attachImageStats(script, requiredStatsForProject(project));
    return jsonOk({ scene, adCopy, verification, speech, imageStats: checked.imageStats ?? [] });
  });
}
