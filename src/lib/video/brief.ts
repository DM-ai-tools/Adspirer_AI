import { analyzeBrandFromUrl } from "@/lib/brand/analyze-url";
import { logger } from "@/lib/observability/logger";
import { loadScope } from "@/lib/creatives/service";
import { getObjectStorage } from "@/lib/storage/r2";
import { nameFromUrl } from "@/lib/video/naming";
import { resolveBrandManifest } from "@/lib/video/brand-resolve";
import { claimsFromFacts, findClaimsInText, mergeClaims } from "@/lib/video/claims";
import { defaultFetchAsset } from "@/lib/video/logo-verify";
import type { ApprovedClaim, BrandManifest } from "@/lib/video/pipeline-types";
import { getProject, listProjects, setProgress, updateProject, type VideoProject } from "@/lib/video/projects";
import { briefFacts, factsCorpus, MAX_SECONDS, type VideoBrief } from "@/lib/video/script";
import { fitToModel, conceptFromText } from "@/lib/video/fit-to-model";
import { buildCreativeBrief, buildSourceDocs, type BriefInput } from "@/lib/video/creative-brief";
import { planConcepts } from "@/lib/video/concepts";
import { editorialPass, refreshEditorial } from "@/lib/video/editorial";
import { resolveWordsPerSecond } from "@/lib/video/duration";
import { contactTokens, repairScript } from "@/lib/video/script-repairs";
import { requiredStatsFrom, spokenForms } from "@/lib/video/required-stats";
import { conceptAngle, normaliseVoices, splitLongScenes, syncSceneLines, trimToFit, writeScriptForAngle, writeScriptForConcept, type WriteContext } from "@/lib/video/script-writer";
import { storedBrief } from "@/lib/video/script-actions";
import type { AnglePlan, CreativeBrief, VideoConcept } from "@/lib/video/script-types";
import type { VideoScript } from "@/lib/video/script";
import { pickModel } from "@/lib/creatives/concept-writer";
import { styleForType, videoDirection } from "@/lib/video/video-types";
import { adCopyForUploaded, applyChangeRequest, assembleUploaded, structureUploadedScript } from "@/lib/video/uploaded-script";
import { analyzeAssets, assetCautions } from "@/lib/video/assets";
import { splitLabel } from "@/lib/video/evidence";
import { advanceProgress, initialProgress } from "@/lib/video/progress";

/** The original bytes of the logo the operator saved for the client, as a data URI (never resized or re-encoded). */
async function clientLogoOriginal(clientId: string): Promise<string | null> {
  try {
    const { loadDocumentsForContext } = await import("@/lib/documents/service");
    const { pickLogoDocument } = await import("@/lib/creatives/uploaded-logo");
    const doc = pickLogoDocument(await loadDocumentsForContext({ clientId, conversationId: null }), null, undefined);
    if (!doc?.storage_key) return null;
    const bytes = await getObjectStorage().get(doc.storage_key);
    return bytes ? `data:${doc.mime_type || "image/png"};base64,${bytes.toString("base64")}` : null;
  } catch (error) {
    logger.warn("Video project: the client's saved logo could not be read", { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/** Figures the operator wrote themselves (an uploaded script, a typed change) count as theirs, with that recorded as the source. */
export function operatorClaims(texts: string[], detail: string, startAt = 1): ApprovedClaim[] {
  const out: ApprovedClaim[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    for (const found of findClaimsInText(text)) {
      const key = found.figure.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: `claim_op_${startAt + out.length}`, text: found.text.trim(), kind: "number", figure: found.figure, evidence: found.text.trim(), provenance: { source: "operator", detail, confidence: "high" } });
    }
  }
  return out;
}

/**
 * Check the brand and build the manifest: the verified public name, the original logo, colours,
 * offer, CTA and the claims that have a source. Everything the script and the video use about the
 * brand comes from here; internal labels (project titles, file names, page titles) are kept apart.
 */
export async function buildBrandForProject(
  project: VideoProject,
  analysis: Awaited<ReturnType<typeof analyzeBrandFromUrl>> | null,
  scope: Awaited<ReturnType<typeof loadScope>>,
  extraClaims: ApprovedClaim[] = [],
): Promise<BrandManifest> {
  const { client, service } = scope;
  const landing = project.inputs.landingPageUrl || service?.landing_page_url || undefined;
  const source = landing || client.website_url || null;
  const choice = project.inputs.brandChoice ?? {};
  let logoUpload: { bytes: Buffer; name: string } | null = null;
  if (choice.logoUploadKey) {
    const bytes = await getObjectStorage().get(choice.logoUploadKey);
    if (bytes) logoUpload = { bytes, name: choice.logoUploadName ?? "uploaded logo" };
  } else if (choice.logoUrl) {
    // A logo the operator picked from what the page offered: fetched untouched and verified like any other file.
    try {
      const fetched = await defaultFetchAsset(choice.logoUrl);
      logoUpload = { bytes: fetched.bytes, name: choice.logoUrl };
    } catch (error) {
      logger.warn("Video project: the logo the operator picked could not be fetched", { url: choice.logoUrl, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const internalLabels: Array<{ value: string; where: string }> = [
    { value: project.id, where: "video project id" },
    ...(service?.name ? [{ value: service.name, where: "the service (offer) name saved in the app" }] : []),
    ...(project.inputs.scriptFileName ? [{ value: project.inputs.scriptFileName, where: "the uploaded script's file name" }] : []),
    ...project.assets.map((a) => ({ value: a.name, where: "an uploaded image's file name" })),
  ];
  const manifest = await resolveBrandManifest({
    clientId: project.client_id,
    projectId: project.id,
    sourceUrl: source,
    scrape: analysis,
    client: { name: client.name, websiteUrl: client.website_url, colors: client.brand_colors, valueProposition: client.value_proposition, audience: client.target_audience },
    internalLabels,
    offer: { name: service?.name ?? null, description: service?.description ?? null },
    operator: { brandName: choice.name ?? null, offer: choice.offer ?? null, cta: choice.cta ?? null, allowTextOnly: Boolean(choice.allowTextOnly), logoUpload },
    stats: project.inputs.stats ?? [],
    assets: project.assets,
    offerDetails: project.inputs.offerDetails,
    instructions: project.inputs.instructions,
    clientLogoDataUri: await clientLogoOriginal(project.client_id),
  });
  const known = new Set(manifest.claims.map((c) => c.id));
  return extraClaims.length ? { ...manifest, claims: [...manifest.claims, ...extraClaims.filter((c) => !known.has(c.id))] } : manifest;
}

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
  // Figures the operator typed into the script editor earlier stay theirs when the brand is checked again.
  const typed = project.brand?.manifest?.claims.filter((c) => c.id.startsWith("claim_op_")) ?? [];
  const manifest = await buildBrandForProject(project, analysis, scope, typed);
  const colors = manifest.colors.value.length ? manifest.colors.value : client.brand_colors;
  // The public name, and only the public name. If none is verified yet the writer is told so and the video is blocked until it is.
  const name = manifest.name.value || nameFromUrl(source ?? null) || "the business";

  const brief: VideoBrief = {
    brandName: name,
    voice: analysis?.brand_voice || client.brand_voice,
    colors,
    imageryNotes: analysis?.imagery_notes,
    pageExcerpt: analysis?.page_excerpt,
    pageText: analysis?.page_text,
    summary: analysis?.summary,
    industry: (client as { industry?: string | null }).industry,
    description: (client as { business_description?: string | null }).business_description,
    valueProposition: client.value_proposition,
    audience: client.target_audience,
    offerName: manifest.offer.value ?? service?.name ?? client.value_proposition ?? name,
    offerDescription: service?.description,
    landingPageUrl: landing,
    instructions: project.inputs.instructions,
    offerDetails: project.inputs.offerDetails,
    stats: project.inputs.stats ?? [],
    // Each image goes to the writer with what has to be settled about its figures (a relabelled figure, a time claim its period does not support, an unnamed currency), so those are not repeated silently.
    images: project.assets.map((a) => {
      const cautions = assetCautions(a).map((c) => c.message);
      const period = a.analysis?.dateRange ? ` Period shown: ${a.analysis.dateRange}.` : "";
      return { id: a.id, name: a.name, summary: `${a.analysis?.summary ?? a.caption}${period}${cautions.length ? ` BEFORE USING ITS FIGURES: ${cautions.join(" ")}` : ""}`, stats: (a.analysis?.stats ?? []).map((s) => ({ value: s.value, label: splitLabel(s).label })), mainStat: a.analysis?.mainStat ? { value: a.analysis.mainStat.value, label: splitLabel(a.analysis.mainStat).label } : null };
    }),
    targetSeconds: project.inputs.targetSeconds,
    style: styleForType(project.inputs.videoType) ?? project.inputs.style,
    direction: videoDirection(project.inputs),
    locale: project.inputs.locale,
    claims: manifest.claims,
  };
  return { brief, brand: { name: manifest.name.value ?? "", colors: colors ?? null, logoUrl: null, summary: analysis?.summary ?? null, manifest } };
}

/** What the creative brief is built from: the verified brand, the page text, the operator's own words and images. */
export function briefInputFor(project: VideoProject, brief: VideoBrief, manifest: BrandManifest | null | undefined): BriefInput {
  const inputs = project.inputs;
  return {
    brandName: manifest?.name.value ?? null,
    manifest: { offer: manifest?.offer.value ?? null, cta: manifest?.cta.value ?? null, audience: manifest?.audience.value ?? null, claims: manifest?.claims ?? [] },
    pageUrl: brief.landingPageUrl ?? null,
    pageText: brief.pageText ?? brief.pageExcerpt ?? null,
    operator: { offerDetails: brief.offerDetails, instructions: brief.instructions, stats: brief.stats, audience: inputs.audience, tone: inputs.tone, goal: inputs.goal, platform: inputs.platform },
    images: brief.images,
    client: { industry: brief.industry, description: brief.description, valueProposition: brief.valueProposition, audience: brief.audience, voice: brief.voice },
    targetSeconds: brief.targetSeconds,
    locale: brief.locale,
  };
}

/** Everything one version is written from, rebuilt from what is stored (no second read of the site). */
export function writeContextFor(project: VideoProject, creative: CreativeBrief, brief: VideoBrief): WriteContext {
  // What a line may state: the facts that were verified against their sources, and the operator's own material. The raw page is deliberately not
  // in this text: a superlative, guarantee or scarcity claim the page merely prints is not evidence and must not pass as supported.
  const docs = buildSourceDocs(briefInputFor(project, brief, project.brand?.manifest));
  const pageText = docs.find((d) => d.kind === "page")?.text ?? "";
  // Web addresses and phone numbers are trusted from the page itself (and its own address): a changed one sends the viewer somewhere else.
  const contacts = [brief.landingPageUrl ?? "", ...contactTokens(pageText)];
  // The figures from the operator's images, and how a person naturally rounds them ("13.6 million" for 13,580,509.69), may be said.
  const rounded = requiredStatsFrom(brief.images).flatMap((r) => spokenForms(r.value));
  const sourceText = [...creative.facts.flatMap((f) => [f.text, f.source.quote]), ...docs.filter((d) => d.kind !== "page").map((d) => d.text), ...contacts, ...rounded].join("\n");
  return {
    creative,
    brief,
    targetSeconds: Math.min(Math.max(Math.round(brief.targetSeconds), 15), 60),
    wordsPerSecond: resolveWordsPerSecond(project.inputs.speechRate),
    assetIds: brief.images.map((i) => i.id),
    claims: brief.claims ?? [],
    sourceText,
    facts: briefFacts(brief),
    corpus: factsCorpus(brief, [JSON.stringify(creative.facts.map((f) => f.text))]),
    goal: project.inputs.goal,
    platform: project.inputs.platform,
  };
}

/**
 * The editorial pass for a set of versions: the checks and the model review, targeted rewrites of
 * weak lines (bounded), and a comparison of the versions against one another. A version that is
 * essentially a duplicate, or states something unsupported, is rewritten whole from its own angle.
 */
export async function editScripts(scripts: VideoScript[], ctx: WriteContext, angles: AnglePlan[]): Promise<VideoScript[]> {
  const { scripts: edited } = await editorialPass(
    scripts,
    { brief: ctx.creative, angles, facts: ctx.facts, claims: ctx.claims, sourceText: ctx.sourceText, wordsPerSecond: ctx.wordsPerSecond, targetSeconds: ctx.targetSeconds, assetIds: ctx.assetIds, locale: ctx.brief.locale, maxPasses: 2 },
    {
      rewriteScript: async (script, issues, others) => {
        const angle = script.angleDetail ?? angles.find((a) => a.id === script.angle.key);
        if (!angle) return script;
        return writeScriptForAngle(ctx, angle, {
          previous: script,
          avoidOpenings: others.map((o) => o.hook?.line).filter((l): l is string => Boolean(l)),
          direction: `Fix these problems and keep what already works: ${issues.map((i) => `${i.problem} (${i.fix})`).join(" ")}`,
        });
      },
    },
  );
  // The editor's scene rewrites can lengthen a script again: whatever is still well over its length is cut, never shipped.
  // The report must describe the text as it now stands, so it is checked again after the corrections and the cut.
  const editorialCtx = { brief: ctx.creative, angles, facts: ctx.facts, claims: ctx.claims, sourceText: ctx.sourceText, wordsPerSecond: ctx.wordsPerSecond, targetSeconds: ctx.targetSeconds, assetIds: ctx.assetIds, locale: ctx.brief.locale };
  return edited.map((s) => refreshEditorial(trimToFit(repairScript(s, ctx.sourceText), ctx), editorialCtx));
}

/** Background job: read the brand, build the creative brief and show three concepts (or read the operator's own script or concept). */
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

    if (project.inputs.mode === "upload" && (project.inputs.scriptText?.trim() || project.inputs.conceptText?.trim())) {
      await writeFromUploadedScript({ project, brief, brand, stage });
      await stage("done");
      return;
    }

    // What the page really says, with sources, and what is missing.
    await stage("understanding");
    const creative = await buildCreativeBrief(briefInputFor(project, brief, brand.manifest));
    // The figures in the brief's verified facts are sourced: they join the claims the script and the video are checked against.
    const withFacts = mergeClaims(brief.claims ?? [], claimsFromFacts(creative.facts));
    brief.claims = withFacts;
    if (brand.manifest) brand.manifest = { ...brand.manifest, claims: mergeClaims(brand.manifest.claims, withFacts) };
    const facts = briefFacts(brief);
    if (creative.sourceQuality === "insufficient") {
      // Writing from this would mean inventing: ask for what is essential instead.
      const asks = creative.gaps.filter((g) => g.essential).map((g) => g.ask);
      await updateProject(projectId, {
        brand: { ...brand, facts, corpus: factsCorpus(brief), brief: creative },
        status: "needs_context",
        error: asks.length ? asks.join(" ") : (creative.limitation ?? "There is not enough source material to write from without inventing things."),
      });
      await stage("done");
      return;
    }

    // Three concepts are shown first; the full script is written only for the one the operator picks.
    await stage("writing");
    const ctx = writeContextFor(project, creative, brief);
    const avoid = await conceptHistory(project.client_id, projectId);
    const planned = await planConcepts(creative, { targetSeconds: ctx.targetSeconds, direction: brief.direction ?? null, avoid });
    await updateProject(projectId, {
      brand: { ...brand, facts, corpus: ctx.corpus, brief: creative, concepts: planned.concepts, shownConcepts: planned.concepts.map((c) => c.logline), conceptLimitation: planned.limitation },
      scripts: null,
      status: "concepts_ready",
      error: null,
    });
    await stage("done");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Video script writing failed", { projectId, error: message });
    await updateProject(projectId, { status: "failed", error: message }).catch(() => undefined);
  }
}

/** How many ideas made for the same client are passed on to be avoided. */
const HISTORY_LIMIT = 30;

/** The loglines of concepts shown on the client's other video projects, newest projects first. */
export async function conceptHistory(clientId: string, excludeProjectId: string): Promise<string[]> {
  try {
    const projects = await listProjects(clientId, 40);
    return projects
      .filter((p) => p.id !== excludeProjectId)
      .flatMap((p) => [...(p.brand?.shownConcepts ?? [])].reverse())
      .slice(0, HISTORY_LIMIT);
  } catch (error) {
    logger.warn("Video concepts: earlier ideas for the client could not be read", { error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

/**
 * The finishing pass for a script written from a concept: a silent editorial review (one bounded
 * pass; nothing it finds is shown or blocks), brand-truth repairs, the length cut, and the scene
 * cap. Who says what is brought back in step wherever the words changed.
 */
export async function polishConceptScript(script: VideoScript, ctx: WriteContext, concept: VideoConcept): Promise<VideoScript> {
  const angle = conceptAngle(concept);
  let edited = script;
  try {
    const out = await editorialPass(
      [script],
      { brief: ctx.creative, angles: [angle], facts: ctx.facts, claims: ctx.claims, sourceText: ctx.sourceText, wordsPerSecond: ctx.wordsPerSecond, targetSeconds: ctx.targetSeconds, assetIds: ctx.assetIds, locale: ctx.brief.locale, maxPasses: 1 },
      {
        rewriteScript: async (current, issues) =>
          writeScriptForConcept(ctx, concept, { previous: current, direction: `Fix these problems and keep what already works: ${issues.map((i) => `${i.problem} (${i.fix})`).join(" ")}` }),
      },
    );
    edited = out.scripts[0] ?? script;
  } catch (error) {
    logger.warn("Video concept script: the editorial pass could not run; keeping the draft", { error: error instanceof Error ? error.message : String(error) });
  }
  const repaired = repairScript(edited, ctx.sourceText);
  const synced = { ...repaired, scenes: repaired.scenes.map(syncSceneLines), voices: repaired.voices ?? script.voices, concept };
  return splitLongScenes(trimToFit(synced, ctx));
}

/** Background job: write the full script for the concept the operator picked. Other scripts already written are kept. */
export async function writeConceptScript(projectId: string, conceptId: string): Promise<void> {
  const project = await getProject(projectId);
  if (!project) return;
  try {
    const creative = project.brand?.brief;
    const concept = project.brand?.concepts?.find((c) => c.id === conceptId);
    if (!creative || !concept) throw new Error("That concept is no longer on this project. Ask for new concepts.");
    let progress = advanceProgress(initialProgress(), "writing");
    await setProgress(projectId, progress);
    const ctx = writeContextFor(project, creative, storedBrief(project));
    const written = await writeScriptForConcept(ctx, concept);
    progress = advanceProgress(progress, "verifying");
    await setProgress(projectId, progress);
    const script = await polishConceptScript(written, ctx, concept);
    const latest = (await getProject(projectId)) ?? project;
    const scripts = [...(latest.scripts ?? []).filter((s) => s.id !== script.id), script];
    await updateProject(projectId, { scripts, status: "scripts_ready", error: null });
    await setProgress(projectId, advanceProgress(progress, "done"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Video concept script could not be written", { projectId, conceptId, error: message });
    // Back to the concepts with the reason, so the operator can pick again rather than start over.
    await updateProject(projectId, { status: "concepts_ready", error: `The script could not be written: ${message}` }).catch(() => undefined);
  }
}

/**
 * Background job: the operator asked for a change to the idea itself. The script is rewritten from
 * its concept with their request as direction; the script as it was is kept so the change can be undone.
 */
export async function rewriteConceptScript(projectId: string, scriptId: string, request: string): Promise<void> {
  const project = await getProject(projectId);
  if (!project) return;
  try {
    const creative = project.brand?.brief;
    const current = project.scripts?.find((s) => s.id === scriptId);
    if (!creative || !current?.concept) throw new Error("This script has no concept to rewrite from.");
    const concept = current.concept;
    const ctx = writeContextFor(project, creative, storedBrief(project));
    const written = await writeScriptForConcept(ctx, concept, { previous: current, direction: `Rewrite this script around the operator's change to the idea, keeping the concept's strengths: ${request}` });
    const polished = await polishConceptScript(written, ctx, concept);
    const before = { ...current };
    delete before.previousVersion;
    const next = { ...polished, id: current.id, previousVersion: before, changeNote: `Rewritten around your change: ${request.trim().slice(0, 160)}` };
    const latest = (await getProject(projectId)) ?? project;
    await updateProject(projectId, { scripts: (latest.scripts ?? []).map((s) => (s.id === scriptId ? next : s)), status: "scripts_ready", error: null });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Video concept script could not be rewritten", { projectId, error: message });
    await updateProject(projectId, { status: "scripts_ready", error: `The change could not be made: ${message}` }).catch(() => undefined);
  }
}

/** Background job: three new concepts, never repeating one already shown here or for this client before. */
export async function moreConcepts(projectId: string, feedback: string | null): Promise<void> {
  const project = await getProject(projectId);
  if (!project) return;
  try {
    const creative = project.brand?.brief;
    if (!creative || !project.brand) throw new Error("This project has no brief to write concepts from. Start a new video.");
    const shown = project.brand.shownConcepts ?? [];
    const avoid = [...shown, ...(await conceptHistory(project.client_id, projectId))];
    const brief = storedBrief(project);
    const planned = await planConcepts(creative, { targetSeconds: Math.min(Math.max(Math.round(brief.targetSeconds), 15), 60), direction: brief.direction ?? null, avoid, feedback });
    await updateProject(projectId, {
      brand: { ...project.brand, concepts: planned.concepts, shownConcepts: [...shown, ...planned.concepts.map((c) => c.logline)], conceptLimitation: planned.limitation },
      status: "concepts_ready",
      error: null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("New video concepts could not be made", { projectId, error: message });
    await updateProject(projectId, { status: "concepts_ready", error: `New concepts could not be made: ${message}` }).catch(() => undefined);
  }
}

/**
 * The operator brought their own concept, their own script, or both.
 *  - A script is split into scenes with its words untouched and given visuals (following their
 *    concept when they gave one), ad copy, and any change they asked for (and only that).
 *  - A concept without a script is read as the chosen concept and its script is written from it;
 *    their own text counts as a source, so a thin page never stops it.
 * Either way it is then fitted to what the video model can make, and every adaptation is reported.
 */
async function writeFromUploadedScript(input: { project: VideoProject; brief: VideoBrief; brand: NonNullable<VideoProject["brand"]>; stage: (s: "understanding" | "writing" | "verifying") => Promise<void> }) {
  const { project, brief, brand, stage } = input;
  const conceptText = project.inputs.conceptText?.trim() || null;
  if (!project.inputs.scriptText?.trim() && conceptText) return writeFromOperatorConcept({ project, brief, brand, stage, conceptText });
  const model = pickModel();
  if (!model) throw new Error("No language model is configured to read your script (set ANTHROPIC_API_KEY or OPENAI_API_KEY).");
  const scriptText = project.inputs.scriptText!;
  const facts = briefFacts(brief);
  const direction = [brief.direction, conceptText ? `THE OPERATOR'S OWN CONCEPT FOR THIS VIDEO (the visuals follow it):\n${conceptText}` : null].filter(Boolean).join("\n\n") || null;
  const ctx = { facts, assetIds: brief.images.map((i) => i.id), locale: brief.locale, model, direction };

  await stage("understanding");
  const split = await structureUploadedScript(scriptText, ctx);
  let script = assembleUploaded({ structured: split.structured, lines: split.lines, restoredScenes: split.restoredScenes, removedScenes: split.removedScenes, addedScenes: split.addedScenes, unused: split.unused, assetIds: ctx.assetIds });
  // The type the operator chose decides the look, whatever the reader inferred from the script.
  const chosenStyle = styleForType(project.inputs.videoType);
  if (chosenStyle) script = { ...script, style: chosenStyle };

  await stage("writing");
  script = { ...script, adCopy: await adCopyForUploaded({ script, provided: project.inputs.adCopyText?.trim() || null, ctx }) };
  if (project.inputs.changeRequest?.trim()) script = await applyChangeRequest(script, project.inputs.changeRequest.trim(), ctx);

  await stage("verifying");
  // The script's own numbers and claims are the operator's: they count as facts.
  const corpus = `${factsCorpus(brief)}\n${scriptText}\n${conceptText ?? ""}\n${project.inputs.adCopyText ?? ""}\n${project.inputs.changeRequest ?? ""}`;
  const fitted = await fitToModel(normaliseVoices(script), { maxSeconds: MAX_SECONDS });

  await updateProject(project.id, {
    brand: { ...brand, facts, corpus },
    scripts: [{ ...fitted.script, adaptations: fitted.adaptations }],
    status: "scripts_ready",
    error: null,
  });
}

/** The operator gave a concept and no script: it becomes the chosen concept and its script is written, then fitted to the model. */
async function writeFromOperatorConcept(input: { project: VideoProject; brief: VideoBrief; brand: NonNullable<VideoProject["brand"]>; stage: (s: "understanding" | "writing" | "verifying") => Promise<void>; conceptText: string }) {
  const { project, brief, brand, stage, conceptText } = input;
  await stage("understanding");
  const creative = await buildCreativeBrief(briefInputFor(project, brief, brand.manifest));
  const withFacts = mergeClaims(brief.claims ?? [], [...claimsFromFacts(creative.facts), ...operatorClaims([conceptText], "your concept")]);
  brief.claims = withFacts;
  if (brand.manifest) brand.manifest = { ...brand.manifest, claims: mergeClaims(brand.manifest.claims, withFacts) };
  const base = writeContextFor(project, creative, brief);
  // The operator's own concept is a source: what it says about the business may be said.
  const ctx: WriteContext = { ...base, sourceText: `${base.sourceText}\n${conceptText}`, corpus: `${base.corpus}\n${conceptText}`, facts: `${base.facts}\nThe operator's own concept: ${conceptText}` };
  const concept = await conceptFromText(conceptText, { targetSeconds: ctx.targetSeconds });

  await stage("writing");
  const written = await writeScriptForConcept(ctx, concept, { direction: "This is the operator's own concept: keep their idea, story, characters and any lines they wrote." });
  await stage("verifying");
  const polished = await polishConceptScript(written, ctx, concept);
  const fitted = await fitToModel(polished, { maxSeconds: MAX_SECONDS });
  await updateProject(project.id, {
    brand: { ...brand, facts: ctx.facts, corpus: ctx.corpus, brief: creative, concepts: [concept], shownConcepts: [concept.logline] },
    scripts: [{ ...fitted.script, source: "uploaded", adaptations: fitted.adaptations }],
    status: "scripts_ready",
    error: null,
  });
}
