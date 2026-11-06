import { analyzeBrandFromUrl } from "@/lib/brand/analyze-url";
import { logger } from "@/lib/observability/logger";
import { loadScope } from "@/lib/creatives/service";
import { loadUploadedLogoDataUri } from "@/lib/creatives/uploaded-logo";
import { getProject, setProgress, updateProject, type VideoProject } from "@/lib/video/projects";
import { briefFacts, factsCorpus, writeVideoScripts, type VideoBrief } from "@/lib/video/script";
import { checkOnly, verifyAndFixAll } from "@/lib/video/verify";
import { pickModel } from "@/lib/creatives/concept-writer";
import { adCopyForUploaded, applyChangeRequest, assembleUploaded, structureUploadedScript } from "@/lib/video/uploaded-script";
import { analyzeAssets } from "@/lib/video/assets";
import { advanceProgress, initialProgress } from "@/lib/video/progress";

/** Read the brand and build the brief the script writer works from. */
export async function buildBrief(project: VideoProject): Promise<{ brief: VideoBrief; brand: NonNullable<VideoProject["brand"]> }> {
  const scope = await loadScope({ clientId: project.client_id, serviceId: project.service_id ?? undefined });
  const { client, service } = scope;
  const landing = project.inputs.landingPageUrl || service?.landing_page_url || undefined;
  const source = landing || client.website_url || undefined;

  let analysis: Awaited<ReturnType<typeof analyzeBrandFromUrl>> | null = null;
  if (source) {
    try {
      analysis = await analyzeBrandFromUrl(source);
    } catch (error) {
      logger.warn("Video project: brand analysis failed", { url: source, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const colors = analysis?.colors?.length ? analysis.colors : client.brand_colors;
  const logoUrl = analysis?.logo_url ?? (await loadUploadedLogoDataUri({ clientId: project.client_id }));
  const name = analysis?.brand_name || client.name;

  const brief: VideoBrief = {
    brandName: name,
    voice: analysis?.brand_voice || client.brand_voice,
    colors,
    imageryNotes: analysis?.imagery_notes,
    pageExcerpt: analysis?.page_excerpt,
    summary: analysis?.summary,
    industry: (client as { industry?: string | null }).industry,
    description: (client as { business_description?: string | null }).business_description,
    valueProposition: client.value_proposition,
    audience: client.target_audience,
    offerName: service?.name ?? client.value_proposition ?? analysis?.title ?? name,
    offerDescription: service?.description,
    landingPageUrl: landing,
    instructions: project.inputs.instructions,
    offerDetails: project.inputs.offerDetails,
    stats: project.inputs.stats ?? [],
    images: project.assets.map((a) => ({ id: a.id, name: a.name, summary: a.analysis?.summary ?? a.caption, stats: a.analysis?.stats ?? [] })),
    targetSeconds: project.inputs.targetSeconds,
    style: project.inputs.style,
    locale: project.inputs.locale,
  };
  return { brief, brand: { name, colors: colors ?? null, logoUrl, summary: analysis?.summary ?? null } };
}

/** Background job: read the brand and the uploaded images, write the three scripts, save them. */
export async function writeProjectScripts(projectId: string): Promise<void> {
  let project = await getProject(projectId);
  if (!project) return;
  let progress = initialProgress();
  await setProgress(projectId, progress);
  const stage = async (next: Parameters<typeof advanceProgress>[1]) => {
    progress = advanceProgress(progress, next);
    await setProgress(projectId, progress);
  };
  try {
    // The site and the uploaded images are read at the same time; the images' stats go into the brief.
    if (project.assets.length) {
      project = await updateProject(projectId, { assets: await analyzeAssets(project.assets) });
    }
    const { brief, brand } = await buildBrief(project);

    if (project.inputs.mode === "upload" && project.inputs.scriptText) {
      await writeFromUploadedScript({ project, brief, brand, stage });
      await stage("done");
      return;
    }

    const written = await writeVideoScripts(brief, (s) => stage(s));
    // Nothing is shown until each script has been checked against the facts and weak scenes are fixed.
    await stage("verifying");
    const target = Math.min(Math.max(Math.round(brief.targetSeconds), 15), 60);
    const scripts = await verifyAndFixAll(written.scripts, {
      brief,
      facts: briefFacts(brief),
      corpus: factsCorpus(brief, [JSON.stringify(written.messageMap)]),
      assetIds: brief.images.map((i) => i.id),
      target,
    });
    const facts = briefFacts(brief);
    await updateProject(projectId, {
      brand: { ...brand, facts, corpus: factsCorpus(brief, [JSON.stringify(written.messageMap)]) },
      scripts,
      status: "scripts_ready",
      error: null,
    });
    await stage("done");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Video script writing failed", { projectId, error: message });
    await updateProject(projectId, { status: "failed", error: message }).catch(() => undefined);
  }
}

/**
 * The operator brought their own script. It is split into scenes with its words untouched, given
 * visuals and ad copy, any change they asked for is applied (and only that), and it is reviewed but
 * never rewritten on its own: fixing is left to the operator.
 */
async function writeFromUploadedScript(input: { project: VideoProject; brief: VideoBrief; brand: NonNullable<VideoProject["brand"]>; stage: (s: "understanding" | "writing" | "verifying") => Promise<void> }) {
  const { project, brief, brand, stage } = input;
  const model = pickModel();
  if (!model) throw new Error("No language model is configured to read your script (set ANTHROPIC_API_KEY or OPENAI_API_KEY).");
  const scriptText = project.inputs.scriptText!;
  const facts = briefFacts(brief);
  const ctx = { facts, assetIds: brief.images.map((i) => i.id), locale: brief.locale, model };

  await stage("understanding");
  const split = await structureUploadedScript(scriptText, ctx);
  let script = assembleUploaded({ structured: split.structured, lines: split.lines, restoredScenes: split.restoredScenes, removedScenes: split.removedScenes, unused: split.unused, assetIds: ctx.assetIds });

  await stage("writing");
  script = { ...script, adCopy: await adCopyForUploaded({ script, provided: project.inputs.adCopyText?.trim() || null, ctx }) };
  if (project.inputs.changeRequest?.trim()) script = await applyChangeRequest(script, project.inputs.changeRequest.trim(), ctx);

  await stage("verifying");
  // The script's own numbers and claims are the operator's: they count as facts for the check.
  const corpus = `${factsCorpus(brief)}\n${scriptText}\n${project.inputs.adCopyText ?? ""}\n${project.inputs.changeRequest ?? ""}`;
  const verification = await checkOnly(script, { brief, facts, corpus, assetIds: ctx.assetIds, target: script.durationSeconds });
  script = { ...script, warnings: verification.issues.map((i) => i.problem), verification };

  await updateProject(project.id, {
    brand: { ...brand, facts, corpus },
    scripts: [script],
    status: "scripts_ready",
    error: null,
  });
}
