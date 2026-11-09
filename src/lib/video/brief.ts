import { analyzeBrandFromUrl } from "@/lib/brand/analyze-url";
import { logger } from "@/lib/observability/logger";
import { loadScope } from "@/lib/creatives/service";
import { getObjectStorage } from "@/lib/storage/r2";
import { nameFromUrl } from "@/lib/video/naming";
import { resolveBrandManifest } from "@/lib/video/brand-resolve";
import { findClaimsInText } from "@/lib/video/claims";
import { defaultFetchAsset } from "@/lib/video/logo-verify";
import type { ApprovedClaim, BrandManifest } from "@/lib/video/pipeline-types";
import { getProject, setProgress, updateProject, type VideoProject } from "@/lib/video/projects";
import { briefFacts, factsCorpus, type VideoBrief } from "@/lib/video/script";
import { checkOnly } from "@/lib/video/verify";
import { buildCreativeBrief, buildSourceDocs, type BriefInput } from "@/lib/video/creative-brief";
import { planAngles } from "@/lib/video/angles";
import { editorialPass, refreshEditorial } from "@/lib/video/editorial";
import { resolveWordsPerSecond } from "@/lib/video/duration";
import { contactTokens, repairScript } from "@/lib/video/script-repairs";
import { trimToFit, writeScriptForAngle, writeScriptSet, type WriteContext } from "@/lib/video/script-writer";
import type { AnglePlan, CreativeBrief } from "@/lib/video/script-types";
import type { VideoScript } from "@/lib/video/script";
import { pickModel } from "@/lib/creatives/concept-writer";
import { adCopyForUploaded, applyChangeRequest, assembleUploaded, structureUploadedScript } from "@/lib/video/uploaded-script";
import { analyzeAssets } from "@/lib/video/assets";
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
    images: project.assets.map((a) => ({ id: a.id, name: a.name, summary: a.analysis?.summary ?? a.caption, stats: a.analysis?.stats ?? [] })),
    targetSeconds: project.inputs.targetSeconds,
    style: project.inputs.style,
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
  const sourceText = [...creative.facts.flatMap((f) => [f.text, f.source.quote]), ...docs.filter((d) => d.kind !== "page").map((d) => d.text), ...contacts].join("\n");
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

const SCRIPT_VERSIONS = 3;

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

/** Background job: read the brand and the uploaded images, build the creative brief, plan three different angles, write each, edit them, save them. */
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

    // What the page really says, with sources, and what is missing.
    await stage("understanding");
    const creative = await buildCreativeBrief(briefInputFor(project, brief, brand.manifest));
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

    await stage("writing");
    const ctx = writeContextFor(project, creative, brief);
    const planned = await planAngles(creative, { count: SCRIPT_VERSIONS });
    if (!planned.angles.length) throw new Error(planned.limitation ?? "No angle could be built from this page. Add details about the offer and try again.");
    const written = await writeScriptSet(ctx, planned.angles);
    if (!written.scripts.length) throw new Error(`The scripts could not be written: ${written.failures.map((f) => f.error).join("; ") || "no model answered"}`);

    // Nothing is shown until each version has been edited against the facts, its voice, its length and the other versions.
    await stage("verifying");
    const scripts = await editScripts(written.scripts, ctx, planned.angles);
    await updateProject(projectId, {
      brand: { ...brand, facts, corpus: ctx.corpus, brief: creative, angles: planned.angles, angleLimitation: planned.limitation },
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
  let script = assembleUploaded({ structured: split.structured, lines: split.lines, restoredScenes: split.restoredScenes, removedScenes: split.removedScenes, addedScenes: split.addedScenes, unused: split.unused, assetIds: ctx.assetIds });

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
