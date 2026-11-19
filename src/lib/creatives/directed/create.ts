import { analyzeBrandFromUrl } from "@/lib/brand/analyze-url";
import { logger } from "@/lib/observability/logger";
import { loadScope } from "@/lib/creatives/service";
import { loadUploadedLogoDataUri } from "@/lib/creatives/uploaded-logo";
import { withAspectMarker, withRunMarker, type ImageFormat } from "@/lib/creatives/formats";
import { upsertCreativeDraftAsync, type CreativeDraft } from "@/lib/creatives/drafts";
import { copyFromPrint, withDirectedMarker, type Direction } from "@/lib/creatives/directed/markers";

export type DirectedBrand = { brandName: string; colors: string[] | null; logoUrl: string | null; landingUrl: string | null };

/**
 * The brand an image carries: the page's name, colours and logo when the page can be read, else the
 * client's own colours and an uploaded logo. Never throws: a directed image is still made without a brand.
 */
export async function loadDirectedBrand(input: { clientId: string; serviceId?: string | null; landingUrl?: string | null; conversationId?: string | null }): Promise<DirectedBrand> {
  const { client, service } = await loadScope({ clientId: input.clientId, serviceId: input.serviceId ?? undefined });
  const landing = input.landingUrl || service?.landing_page_url || undefined;
  const source = landing || client.website_url || undefined;
  let analysis: Awaited<ReturnType<typeof analyzeBrandFromUrl>> | null = null;
  if (source) {
    try {
      analysis = await analyzeBrandFromUrl(source);
    } catch (error) {
      logger.warn("Directed image: brand analysis failed; using the client's saved colours", { url: source, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const colors = analysis?.colors?.length ? analysis.colors : (client.brand_colors ?? null);
  const logoUrl = analysis?.logo_url ?? (await loadUploadedLogoDataUri({ clientId: input.clientId, conversationId: input.conversationId }).catch(() => null));
  return { brandName: analysis?.brand_name || client.name, colors, logoUrl, landingUrl: landing ?? null };
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
    let creativeDirection = withAspectMarker(withDirectedMarker("", { picture: direction.picture, print: direction.print, ...(direction.noLogo ? { noLogo: true } : {}) }), input.format);
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
