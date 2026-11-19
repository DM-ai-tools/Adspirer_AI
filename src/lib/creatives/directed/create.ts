import { analyzeBrandFromUrl } from "@/lib/brand/analyze-url";
import { logger } from "@/lib/observability/logger";
import { loadScope } from "@/lib/creatives/service";
import { loadUploadedLogoDataUri } from "@/lib/creatives/uploaded-logo";
import { withAspectMarker, withRunMarker, type ImageFormat } from "@/lib/creatives/formats";
import { listCreativeDraftsAsync, upsertCreativeDraftAsync, type CreativeDraft } from "@/lib/creatives/drafts";
import { copyFromPrint, withDirectedMarker, type Direction } from "@/lib/creatives/directed/markers";

export type DirectedBrand = { brandName: string; colors: string[] | null; logoUrl: string | null; landingUrl: string | null };

/** The client's most recent earlier image that carries brand colours or a logo: where the brand comes from when no site is saved. */
async function latestBrandedDraft(clientId: string): Promise<CreativeDraft | null> {
  try {
    const drafts = await listCreativeDraftsAsync(clientId);
    return drafts.filter((d) => d.brand_colors?.length || d.logo_url).sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * The brand an image carries. The brand colours and logo are always applied; the picture instruction is only
 * the visual idea. Found, in order: the page the operator names, the service's or client's own site, and the
 * client's most recent earlier image (so a client with no website saved still gets its brand). Colours fall back
 * to the client's saved ones and the logo to an uploaded file. Never throws: an image is still made without a brand.
 */
export async function loadDirectedBrand(input: { clientId: string; serviceId?: string | null; landingUrl?: string | null; conversationId?: string | null }): Promise<DirectedBrand> {
  const { client, service } = await loadScope({ clientId: input.clientId, serviceId: input.serviceId ?? undefined });
  const earlier = input.landingUrl || service?.landing_page_url || client.website_url ? null : await latestBrandedDraft(input.clientId);
  const landing = input.landingUrl || service?.landing_page_url || undefined;
  const source = landing || client.website_url || earlier?.landing_page_url || undefined;
  let analysis: Awaited<ReturnType<typeof analyzeBrandFromUrl>> | null = null;
  if (source) {
    try {
      analysis = await analyzeBrandFromUrl(source);
    } catch (error) {
      logger.warn("Directed image: brand analysis failed; using the client's saved colours", { url: source, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const fromEarlier = earlier ?? (analysis ? null : await latestBrandedDraft(input.clientId));
  const colors = analysis?.colors?.length ? analysis.colors : client.brand_colors?.length ? client.brand_colors : (fromEarlier?.brand_colors ?? null);
  const logoUrl =
    analysis?.logo_url ??
    (await loadUploadedLogoDataUri({ clientId: input.clientId, conversationId: input.conversationId }).catch(() => null)) ??
    fromEarlier?.logo_url ??
    null;
  return { brandName: analysis?.brand_name || client.name, colors, logoUrl, landingUrl: landing ?? client.website_url ?? earlier?.landing_page_url ?? fromEarlier?.landing_page_url ?? null };
}

/** One draft per direction, in order. Rendering is started by the caller. */
export async function createDirectedDrafts(input: {
  clientId: string;
  serviceId?: string | null;
  conversationId?: string | null;
  taskId?: string | null;
  directions: Direction[];
  format: ImageFormat;
  brand: DirectedBrand;
  status?: "generating" | "pending";
  runId?: string;
  pastedCopy?: string | null;
  conceptPrefix?: string;
}): Promise<CreativeDraft[]> {
  const drafts: CreativeDraft[] = [];
  for (const [index, direction] of input.directions.entries()) {
    const copy = copyFromPrint(direction.print, input.pastedCopy);
    let creativeDirection = withAspectMarker(withDirectedMarker("", { picture: direction.picture, print: direction.print }), input.format);
    if (input.runId) creativeDirection = withRunMarker(creativeDirection, input.runId);
    drafts.push(
      await upsertCreativeDraftAsync({
        client_id: input.clientId,
        service_id: input.serviceId ?? null,
        conversation_id: input.conversationId ?? null,
        task_id: input.taskId ?? null,
        brief_id: null,
        concept: `${input.brand.brandName} — ${input.conceptPrefix ?? "Your direction"} ${index + 1}`,
        headline: copy.headline,
        primary_text: copy.primary_text,
        description: null,
        cta: null,
        creative_direction: creativeDirection,
        image_url: null,
        image_b64: null,
        image_mime: "image/png",
        image_model: null,
        image_prompt: null,
        image_status: input.status ?? "generating",
        image_error: null,
        landing_page_url: input.brand.landingUrl,
        brand_colors: input.brand.colors,
        logo_url: input.brand.logoUrl,
        revision_notes: null,
        status: "draft",
      }),
    );
  }
  return drafts;
}
