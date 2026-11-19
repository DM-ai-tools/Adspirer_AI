import { analyzeBrandFromUrl } from "@/lib/brand/analyze-url";
import { logger } from "@/lib/observability/logger";
import { loadScope } from "@/lib/creatives/service";
import { loadUploadedLogoDataUri } from "@/lib/creatives/uploaded-logo";
import { readPageText } from "@/lib/creatives/page-text";
import { findClientResults, type ClientResult } from "@/lib/creatives/bulk/results";
import type { BulkBrief } from "@/lib/creatives/bulk/plan";
import type { CreativeRun } from "@/lib/creatives/bulk/runs";

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

/**
 * What a run knows about the business: the brand read from the landing page or site, the client's own facts, the
 * operator's notes and pasted copy, and their ad copy instructions. Shared by the hook planner and by directions
 * runs, so both write copy from the same facts.
 */
export async function loadRunBrief(run: CreativeRun): Promise<{ brief: BulkBrief; colors: string[] | null; logoUrl: string | null; brandName: string; landing: string | undefined }> {
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
  const colors = analysis?.colors?.length ? analysis.colors : (client.brand_colors ?? null);
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
    copyInstructions: run.inputs.copyInstructions,
    results: await resultsLookup,
  };
  return { brief, colors, logoUrl, brandName, landing };
}
