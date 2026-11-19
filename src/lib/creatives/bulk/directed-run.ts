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
import { briefLines } from "@/lib/creatives/bulk/plan";
import { loadRunBrief } from "@/lib/creatives/bulk/run-brief";
import { checkAndRepairCopy } from "@/lib/creatives/bulk/copy/check";
import { writeDirectedCopy } from "@/lib/creatives/bulk/copy/write-directed";
import { readDirectedMarker, type DirectedMeta } from "@/lib/creatives/directed/markers";

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
  /** How the ad copy should be written. When given, the copy is written from it (in the background); otherwise the printed words are the copy. */
  copyInstructions?: string | null;
  format: ImageFormat;
}): Promise<CreativeRun> {
  if (!input.directions.length) throw new Error("Add at least one direction.");
  if (input.directions.length > MAX_DIRECTIONS) throw new Error(`A run takes at most ${MAX_DIRECTIONS} directions; this has ${input.directions.length}. Split it into two runs.`);
  if (!getConfig().hasOpenAI) throw new Error("Image generation is not configured (OPENAI_API_KEY).");

  const { client } = await loadScope({ clientId: input.clientId, serviceId: input.serviceId ?? undefined });
  const instructions = input.copyInstructions?.trim() || null;
  const run = await createRun({
    clientId: input.clientId,
    serviceId: input.serviceId,
    createdBy: input.createdBy,
    landingPageUrl: input.landingPageUrl,
    inputs: {
      directed: true,
      pastedCopy: input.pastedCopy ?? null,
      ...(instructions ? { copyInstructions: instructions, copyStatus: "writing" as const, copyStartedAt: new Date().toISOString() } : {}),
    },
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
    // With instructions the pasted copy is a seed for the writer; the ads start from their printed words.
    pastedCopy: instructions ? null : input.pastedCopy,
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
  // The copy is written while the images render; the images never wait for it.
  const copyJob = run.inputs.copyInstructions?.trim() ? writeAndApplyDirectedCopy(runId) : Promise.resolve();
  await Promise.all([renderPending(runId), copyJob]);
}

/**
 * Write each ad's copy from the operator's instructions, check it against them, and put it on the drafts. Copy the
 * operator already edited by hand is left alone. Never throws: on failure each ad keeps the words printed on its
 * image and the run says so.
 */
async function writeAndApplyDirectedCopy(runId: string): Promise<void> {
  const run = await getRun(runId);
  const instructions = run?.inputs.copyInstructions?.trim();
  if (!run || !instructions) return;
  try {
    const { brief } = await loadRunBrief(run);
    const facts = briefLines(brief).join("\n");
    const drafts = await Promise.all(run.items.map((item) => getCreativeDraftAsync(item.draft_id)));
    const directions = drafts.map((d) => readDirectedMarker(d?.creative_direction));
    if (directions.some((d) => !d)) throw new Error("an image of this run is missing its direction");
    const written = await writeDirectedCopy({ directions: directions as DirectedMeta[], instructions, pastedCopy: run.inputs.pastedCopy, facts });
    const checked = await checkAndRepairCopy({
      instructions,
      ads: written.map((copy, i) => ({ id: run.items[i]!.draft_id, ...copy, fixedWords: (directions[i] as DirectedMeta).print.map((l) => l.text) })),
      facts,
    });
    // Read again: the operator may have edited an ad's copy while this was being written.
    const latest = (await getRun(runId)) ?? run;
    const items = latest.items.map((item) => ({ ...item, ...(checked.notes[item.draft_id] && !item.copy_edited ? { copy_note: checked.notes[item.draft_id] } : {}) }));
    for (const ad of checked.ads) {
      const item = latest.items.find((i) => i.draft_id === ad.id);
      const draft = await getCreativeDraftAsync(ad.id);
      if (!draft || item?.copy_edited) continue;
      await upsertCreativeDraftAsync({ ...draft, id: draft.id, headline: ad.headline, primary_text: ad.primary_text, description: ad.description });
    }
    await updateRun(runId, {
      items,
      inputs: { ...latest.inputs, copyRules: checked.rules, copyStatus: "ready", copyRepaired: checked.repaired.length, copyFlagged: Object.keys(checked.notes).length, copyMessage: null },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn("Directed bulk run: the ad copy could not be written", { runId, error: reason });
    const latest = (await getRun(runId)) ?? run;
    await updateRun(runId, {
      inputs: { ...latest.inputs, copyStatus: "failed", copyMessage: `The ad copy could not be written (${reason.slice(0, 160)}), so each ad keeps the words printed on its image.` },
    }).catch(() => undefined);
  }
}
