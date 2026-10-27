import { z } from "zod";
import { registerTool } from "@/lib/tools/registry";
import { IMAGE_FORMATS } from "@/lib/creatives/formats";

export const generateAdImagesTool = registerTool({
  name: "generate_ad_images",
  description:
    "Analyse a business website (brand colours, logo, what the business does, via Firecrawl) and render 4 on-brand image variations of an ad. The images are written from that business context and from the post copy, so pass the headline and primary text whenever they exist. Returns immediately; the stills fill in inside the chat as each one finishes and the operator picks one. Needs the business URL: if you do not have it from the chat or client context, ask the operator for it instead of calling this.",
  inputSchema: z.object({
    brand_url: z
      .string()
      .url()
      .describe("The business website the operator gave (https)."),
    landing_page_url: z.string().url().optional(),
    headline: z.string().optional(),
    primary_text: z.string().optional(),
    reference_notes: z
      .string()
      .optional()
      .describe("Anything the operator said about the look, or reference ads."),
    format: z.enum(IMAGE_FORMATS).optional(),
  }),
  async execute(args, ctx) {
    const { startCreativeGeneration, DEFAULT_VARIANT_COUNT } = await import(
      "@/lib/creatives/service"
    );
    const { runAfterResponse } = await import("@/lib/api/background");
    const { result, runImages } = await startCreativeGeneration({
      clientId: ctx.clientId,
      conversationId: ctx.conversationId ?? undefined,
      taskId: ctx.taskId ?? undefined,
      brandUrl: args.brand_url,
      landingPageUrl: args.landing_page_url ?? args.brand_url,
      headline: args.headline,
      primaryText: args.primary_text,
      referenceBrief: args.reference_notes,
      imageFormat: args.format,
      count: DEFAULT_VARIANT_COUNT,
      generateImages: true,
      analyzeBrand: true,
    });
    if (runImages) runAfterResponse("tool-creative-images", runImages);

    const brand = result.brandAnalysis;
    return {
      status: runImages ? "rendering" : "concepts_only",
      variations: result.drafts.length,
      image_model: result.imageModel,
      brand: brand
        ? {
            name: brand.brand_name ?? brand.title ?? null,
            colors: brand.colors,
            logo_found: Boolean(brand.logo_url),
            source: brand.source,
          }
        : null,
      concepts: result.drafts.map((d) => ({
        id: d.id,
        concept: d.concept,
        headline: d.headline,
      })),
      note: runImages
        ? "Stills are rendering and appear in the chat as each finishes (30-90s). Tell the operator this, mention the palette and logo you found, and stop: they pick one in the chat."
        : "No image credentials are configured, so only concepts were drafted.",
    };
  },
});
