import { getConfig } from "@/lib/config";
import { analyzeBrandFromUrl } from "@/lib/brand/analyze-url";
import { logger } from "@/lib/observability/logger";
import { loadScope } from "@/lib/creatives/service";
import { loadUploadedLogoDataUri } from "@/lib/creatives/uploaded-logo";
import { generateImageForDraft } from "@/lib/creatives/generate-draft-image";
import { withAspectMarker, withRunMarker, type ImageFormat } from "@/lib/creatives/formats";
import {
  getCreativeDraftAsync,
  isRenderStalled,
  listCreativeDraftsAsync,
  upsertCreativeDraftAsync,
  type CreativeDraft,
} from "@/lib/creatives/drafts";
import { nanoid } from "nanoid";
import { readPageText } from "@/lib/creatives/page-text";
import { findClientResults, type ClientResult } from "@/lib/creatives/bulk/results";
import { BULK_RUN_SIZE, directionForHook, writeBulkPlan, type BulkBrief } from "@/lib/creatives/bulk/plan";
import {
  describeStyleImages,
  hasStyleGuide,
  loadStyleImages,
  logStyleFailure,
  prepareStyleImages,
  saveStyleImages,
  type StyleGuide,
} from "@/lib/creatives/bulk/style-reference";
import {
  claimLease,
  createRun,
  getRun,
  listRuns,
  releaseLease,
  updateRun,
  type CreativeRun,
  type RunItem,
} from "@/lib/creatives/bulk/runs";

/** Renders in flight at once. Enough to finish a run in a few minutes, few enough to stay inside the image API's rate limits. */
export const RENDER_CONCURRENCY = 4;
/** No new render is started after this long into one worker's turn, so it can finish inside the route's 300s. */
export const RENDER_BUDGET_MS = 200_000;

/** Run `work` over `items`, never more than `limit` at once, and stop starting new ones when `shouldStop()` says so. */
export async function runPool<T>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<void>,
  shouldStop: () => boolean = () => false,
): Promise<void> {
  const queue = [...items];
  const worker = async () => {
    for (;;) {
      if (shouldStop()) return;
      const next = queue.shift();
      if (next === undefined) return;
      await work(next);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

/** Drafts of this run still waiting for a render (or left mid-render by a worker that died). */
export function pendingDrafts(drafts: CreativeDraft[]): CreativeDraft[] {
  return drafts.filter(
    (d) => d.image_status === "pending" || (d.image_status === "generating" && isRenderStalled(d)),
  );
}

async function runDrafts(run: CreativeRun): Promise<CreativeDraft[]> {
  const ids = new Set(run.items.map((i) => i.draft_id));
  const all = await listCreativeDraftsAsync(run.client_id);
  return all.filter((d) => ids.has(d.id));
}

/**
 * Create the run and its 15 placeholder drafts. Nothing slow happens here, so the screen can open
 * on the run at once; reading the brand, writing the copy and rendering follow in the background.
 */
export async function startBulkRun(input: {
  clientId: string;
  serviceId?: string | null;
  createdBy?: string | null;
  landingPageUrl?: string | null;
  notes?: string | null;
  pastedCopy?: string | null;
  /** The operator's own words on the look they want, and any style rules. */
  styleDirection?: string | null;
  /** Reference images as data URIs. Checked and stored before the run is created. */
  styleImages?: string[];
  /** Make every image follow the reference, not just the first few. */
  styleMatchAll?: boolean;
  format: ImageFormat;
}): Promise<CreativeRun> {
  const config = getConfig();
  if (!config.hasOpenAI) throw new Error("Image generation is not configured (OPENAI_API_KEY).");
  // Bad images are refused before anything is created, so a failed start leaves no half-made run.
  const styleImages = input.styleImages?.length ? await prepareStyleImages(input.styleImages) : [];
  const styleImageKeys = styleImages.length ? await saveStyleImages(`ref_${nanoid(10)}`, styleImages) : [];
  const run = await createRun({
    clientId: input.clientId,
    serviceId: input.serviceId,
    createdBy: input.createdBy,
    landingPageUrl: input.landingPageUrl,
    inputs: {
      notes: input.notes ?? null,
      pastedCopy: input.pastedCopy ?? null,
      styleDirection: input.styleDirection?.trim() || null,
      styleImageKeys,
      styleMatchAll: Boolean(input.styleMatchAll),
    },
    format: input.format,
  });
  const items: RunItem[] = [];
  for (let i = 0; i < BULK_RUN_SIZE; i += 1) {
    const draft = await upsertCreativeDraftAsync({
      client_id: input.clientId,
      service_id: input.serviceId ?? null,
      conversation_id: null,
      task_id: null,
      brief_id: null,
      concept: `Hook ${i + 1}`,
      headline: "Writing the hook…",
      primary_text: "",
      description: null,
      cta: null,
      creative_direction: withRunMarker(withAspectMarker("", input.format), run.id),
      image_url: null,
      image_b64: null,
      image_mime: "image/png",
      image_model: null,
      image_prompt: null,
      image_status: "pending",
      image_error: null,
      landing_page_url: input.landingPageUrl ?? null,
      brand_colors: null,
      logo_url: null,
      revision_notes: null,
      status: "draft",
    });
    items.push({ draft_id: draft.id, angle_key: null, angle_name: null, stage: null, kind: null, targets: null, body_id: null, cta_label: null });
  }
  return updateRun(run.id, { items });
}

/**
 * The operator's style for this run, or null when they gave none. Uploaded images are read once
 * and the brief kept on the run. If the images cannot be read the run only carries on when there
 * are also words to go on; otherwise it stops with a clear message instead of quietly ignoring
 * the reference the operator chose.
 */
export async function resolveStyleGuide(run: CreativeRun): Promise<StyleGuide | null> {
  const direction = run.inputs.styleDirection?.trim() || null;
  let imageBrief = run.inputs.styleBrief?.trim() || null;
  const keys = run.inputs.styleImageKeys ?? [];
  if (!imageBrief && keys.length) {
    try {
      const images = await loadStyleImages(keys);
      if (!images.length) throw new Error("the uploaded images could not be found");
      imageBrief = await describeStyleImages(images);
      await updateRun(run.id, { inputs: { ...run.inputs, styleBrief: imageBrief } });
    } catch (error) {
      logStyleFailure(error);
      if (!direction) {
        const why = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not read the reference image (${why}). Try again, or describe the style in words.`);
      }
    }
  }
  const guide: StyleGuide = { imageBrief, direction, matchAll: Boolean(run.inputs.styleMatchAll) };
  return hasStyleGuide(guide) ? guide : null;
}

/** The client results written on a page, or none when the page cannot be read or holds none. Never throws. */
async function findResultsOnPage(url: string): Promise<ClientResult[]> {
  try {
    const page = await readPageText(url);
    return page.readable ? await findClientResults(page.text) : [];
  } catch (error) {
    logger.warn("Bulk run: could not look for client results on the landing page", { url, error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

/** Read the brand, write the run's copy, and fill the placeholder drafts. Then render. */
export async function planAndRender(runId: string): Promise<void> {
  const run = await getRun(runId);
  if (!run) return;
  try {
    const scope = await loadScope({ clientId: run.client_id, serviceId: run.service_id ?? undefined });
    const { client, service } = scope;
    const landing = run.landing_page_url || service?.landing_page_url || undefined;
    const brandSource = landing || client.website_url || undefined;
    // Real client results and stats on the landing page, read alongside the brand analysis. Two or
    // three images of the run showcase them; a page with none (or one that cannot be read) simply
    // reserves nothing.
    const resultsLookup = landing ? findResultsOnPage(landing) : Promise.resolve<ClientResult[]>([]);

    let analysis: Awaited<ReturnType<typeof analyzeBrandFromUrl>> | null = null;
    if (brandSource) {
      try {
        analysis = await analyzeBrandFromUrl(brandSource);
      } catch (error) {
        logger.warn("Bulk run: brand analysis failed; images will be unbranded", {
          url: brandSource,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const colors = analysis?.colors?.length ? analysis.colors : client.brand_colors;
    const logoUrl = analysis?.logo_url ?? (await loadUploadedLogoDataUri({ clientId: run.client_id }));
    const brandName = analysis?.brand_name || client.name;

    const brief: BulkBrief = {
      brandName,
      voice: analysis?.brand_voice || client.brand_voice,
      colors,
      imageryNotes: analysis?.imagery_notes,
      pageExcerpt: analysis?.page_excerpt,
      summary: analysis?.summary,
      industry: (client as { industry?: string | null }).industry,
      description: (client as { business_description?: string | null }).business_description,
      valueProposition: client.value_proposition,
      audience: client.target_audience,
      offerName: service?.name ?? client.value_proposition ?? analysis?.title ?? brandName,
      offerDescription: service?.description,
      landingPageUrl: landing,
      notes: run.inputs.notes,
      pastedCopy: run.inputs.pastedCopy,
      results: await resultsLookup,
    };

    // Angles earlier runs for this client used are held back, so a second run reaches for new ones.
    const earlier = (await listRuns(run.client_id, 6)).filter((r) => r.id !== run.id).flatMap((r) => r.items.map((i) => i.angle_key ?? ""));
    const styleGuide = await resolveStyleGuide(run);
    const plan = await writeBulkPlan(brief, BULK_RUN_SIZE, earlier.filter(Boolean), styleGuide);

    const items: RunItem[] = [];
    for (const [index, slot] of run.items.entries()) {
      const hook = plan.hooks[index];
      const existing = await getCreativeDraftAsync(slot.draft_id);
      if (!existing) continue;
      if (!hook) {
        await upsertCreativeDraftAsync({ ...existing, id: existing.id, headline: "No hook for this slot", image_status: "failed", image_error: "The writer did not return a hook for this slot.", status: "failed" });
        items.push(slot);
        continue;
      }
      const cta = plan.ctas[hook.ctaIndex] ?? plan.ctas[0];
      await upsertCreativeDraftAsync({
        ...existing,
        id: existing.id,
        concept: `${brandName} — ${hook.angle.name}`,
        headline: hook.postHeadline,
        primary_text: hook.primaryText,
        description: hook.targets,
        cta: cta?.cta ?? null,
        creative_direction: withRunMarker(withAspectMarker(directionForHook(hook), run.image_format), run.id),
        brand_colors: colors ?? null,
        logo_url: logoUrl,
        landing_page_url: landing ?? null,
      });
      items.push({
        draft_id: slot.draft_id,
        angle_key: hook.angle.key,
        angle_name: hook.angle.name,
        stage: hook.angle.stage,
        kind: hook.angle.kind,
        targets: hook.targets,
        body_id: hook.bodyId,
        cta_label: cta?.label ?? null,
      });
    }
    await updateRun(run.id, { status: "rendering", items, message_map: plan.messageMap, bodies: plan.bodies, ctas: plan.ctas });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Bulk run planning failed", { runId, error: message });
    await updateRun(run.id, { status: "failed", error: message }).catch(() => undefined);
    return;
  }
  await renderPending(runId);
}

/**
 * Render what is still waiting, a few at a time, within one worker's turn. Safe to call again:
 * a lease means only one worker renders a run at once, and what is left stays pending for the next call.
 */
export async function renderPending(runId: string, options: { budgetMs?: number } = {}): Promise<{ started: number; remaining: number }> {
  if (!(await claimLease(runId))) {
    const run = await getRun(runId);
    return { started: 0, remaining: run ? pendingDrafts(await runDrafts(run)).length : 0 };
  }
  const startedAt = Date.now();
  const budget = options.budgetMs ?? RENDER_BUDGET_MS;
  let started = 0;
  try {
    const run = await getRun(runId);
    if (!run) return { started: 0, remaining: 0 };
    const todo = pendingDrafts(await runDrafts(run)).filter((d) => d.status !== "failed" && d.primary_text);
    const brandName = todo[0]?.concept.split("—")[0]?.trim();
    await runPool(
      todo,
      RENDER_CONCURRENCY,
      async (draft) => {
        started += 1;
        try {
          await generateImageForDraft(draft.id, brandName, null, run.image_format);
        } catch (error) {
          logger.warn("Bulk render failed", { draftId: draft.id, error: error instanceof Error ? error.message : String(error) });
        }
      },
      () => Date.now() - startedAt > budget,
    );
  } finally {
    await releaseLease(runId);
  }
  const run = await getRun(runId);
  const remaining = run ? pendingDrafts(await runDrafts(run)).filter((d) => d.primary_text).length : 0;
  if (run && remaining === 0 && run.status === "rendering") await updateRun(runId, { status: "done" });
  return { started, remaining };
}
