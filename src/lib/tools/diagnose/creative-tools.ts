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
    const { startCreativeGenerationBackground, DEFAULT_VARIANT_COUNT } = await import(
      "@/lib/creatives/service"
    );
    const { runAfterResponse } = await import("@/lib/api/background");
    const { draftIds, run } = await startCreativeGenerationBackground({
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
    runAfterResponse("tool-creative-generation", run);

    return {
      status: "rendering",
      variations: draftIds.length,
      note: "Four placeholder cards are in the chat now. The brand is read, the concepts written and the images rendered in the background, with each stage shown on the cards and in the chat (the palette and whether a logo was found are posted when the site has been read). Tell the operator this in one sentence and stop; they pick one in the chat.",
    };
  },
});
