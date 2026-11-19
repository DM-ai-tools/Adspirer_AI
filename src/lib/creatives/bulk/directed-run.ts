import { getConfig } from "@/lib/config";
import { logger } from "@/lib/observability/logger";
import { loadScope } from "@/lib/creatives/service";
import type { ImageFormat } from "@/lib/creatives/formats";
import { getCreativeDraftAsync, upsertCreativeDraftAsync } from "@/lib/creatives/drafts";
import { createDirectedDrafts, loadDirectedBrand } from "@/lib/creatives/directed/create";
import { MAX_DIRECTIONS } from "@/lib/creatives/directed/file";
import type { Direction } from "@/lib/creatives/directed/markers";
import { createRun, getRun, updateRun, type CreativeRun, type RunItem } from "@/lib/creatives/bulk/runs";
import { renderPending } from "@/lib/creatives/bulk/run";

/**
 * A bulk run made straight from the operator's directions: one image per direction, in order, each following
 * its own picture instruction and printed words. The hook planner is not used. Nothing slow happens here, so
 * the screen can open on the run at once; the brand is read and the images render in `planAndRenderDirected`.
 */
export async function startDirectedBulkRun(input: {
  clientId: string;
  serviceId?: string | null;
  createdBy?: string | null;
  landingPageUrl?: string | null;
  directions: Direction[];
  pastedCopy?: string | null;
  format: ImageFormat;
}): Promise<CreativeRun> {
  if (!input.directions.length) throw new Error("Add at least one direction.");
  if (input.directions.length > MAX_DIRECTIONS) throw new Error(`A run takes at most ${MAX_DIRECTIONS} directions; this has ${input.directions.length}. Split it into two runs.`);
  if (!getConfig().hasOpenAI) throw new Error("Image generation is not configured (OPENAI_API_KEY).");

  const { client } = await loadScope({ clientId: input.clientId, serviceId: input.serviceId ?? undefined });
  const run = await createRun({
    clientId: input.clientId,
    serviceId: input.serviceId,
    createdBy: input.createdBy,
    landingPageUrl: input.landingPageUrl,
    inputs: { directed: true, pastedCopy: input.pastedCopy ?? null },
    format: input.format,
  });
  const drafts = await createDirectedDrafts({
    clientId: input.clientId,
    serviceId: input.serviceId,
    directions: input.directions,
    format: input.format,
    brand: { brandName: client.name, colors: client.brand_colors ?? null, logoUrl: null, landingUrl: input.landingPageUrl ?? null },
    status: "pending",
    runId: run.id,
    pastedCopy: input.pastedCopy,
    conceptPrefix: "Direction",
  });
  const items: RunItem[] = drafts.map((d, i) => ({ draft_id: d.id, angle_key: null, angle_name: `Direction ${i + 1}`, stage: null, kind: null, targets: null, body_id: null, cta_label: null }));
  return updateRun(run.id, { items });
}

/** Read the brand once, put it on every draft of the run, then render them. */
export async function planAndRenderDirected(runId: string): Promise<void> {
  const run = await getRun(runId);
  if (!run) return;
  try {
    const brand = await loadDirectedBrand({ clientId: run.client_id, serviceId: run.service_id, landingUrl: run.landing_page_url });
    for (const item of run.items) {
      const draft = await getCreativeDraftAsync(item.draft_id);
      if (!draft) continue;
      await upsertCreativeDraftAsync({
        ...draft,
        id: draft.id,
        concept: `${brand.brandName} — ${item.angle_name ?? "Direction"}`,
        brand_colors: brand.colors,
        logo_url: brand.logoUrl,
        landing_page_url: brand.landingUrl,
      });
    }
    await updateRun(run.id, { status: "rendering" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Directed bulk run could not start", { runId, error: message });
    await updateRun(run.id, { status: "failed", error: message }).catch(() => undefined);
    return;
  }
  await renderPending(runId);
}
