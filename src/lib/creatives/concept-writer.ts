import { generateObject } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { ADSPIRER_META_CTAS } from "@/lib/adspirer/skills/ad-copywriting";
import type { CreativeConcept } from "@/lib/creatives/generator";
import { nowIso } from "@/lib/utils";

export type ConceptWriterInput = {
  clientId: string;
  serviceId: string | null;
  count: number;
  brand: {
    name: string;
    voice?: string | null;
    colors?: string[] | null;
    imageryNotes?: string | null;
    guidelines?: string | null;
    /** What the scraped brand/landing page actually says. */
    pageExcerpt?: string | null;
    summary?: string | null;
  };
  business: {
    industry?: string | null;
    description?: string | null;
    valueProposition?: string | null;
    audience?: string | null;
  };
  offer: {
    name: string;
    description?: string | null;
    landingPageUrl?: string | null;
  };
  /** Competitor / reference notes, e.g. from an uploaded document. */
  referenceBrief?: string | null;
  competitorOpportunities?: string[] | null;
  /** When the operator supplied the post copy, the images illustrate THAT post. */
  suppliedCopy?: {
    headline?: string | null;
    primaryText?: string | null;
  } | null;
};

const CTA_VALUES = ADSPIRER_META_CTAS as unknown as [string, ...string[]];

const conceptSchema = z.object({
  concepts: z.array(
    z.object({
      label: z.string().describe("2-4 word name for this variation"),
      style: z
        .string()
        .describe("The visual style of this still in 2-5 words (for example 'bold typographic poster' or 'cinematic product hero'). It must differ from every other concept's style."),
      hook: z.string(),
      primary_text: z.string(),
      headline: z.string().describe("Under 40 characters"),
      description: z.string(),
      cta: z.enum(CTA_VALUES),
      creative_direction: z
        .string()
        .describe(
          "A rich, specific art direction of 70-130 words for a finished, scroll-stopping ad: the visual idea or metaphor that makes THIS offer understood at a glance; the subject and setting; camera angle, lens and framing; lighting and mood; foreground/mid/background layers; where the headline, chips and button sit and how large; textures and finish; and exactly how the brand colours are used (dominant colour first). Never a vague mood description.",
        ),
      on_image_text: z
        .object({
          headline: z
            .string()
            .describe("3-7 words printed large on the image: the offer or the promise, in the page's own wording"),
          highlights: z
            .array(z.string())
            .max(3)
            .describe("1-3 keywords or proof points (a number, a result, a guarantee) taken from the page or copy, each 1-3 words, set apart as highlighted chips or accent-coloured words"),
          cta_label: z
            .string()
            .describe("The button text, 2-4 words, using the page's own call to action when it has one (for example Get My Free Audit)"),
        })
        .describe("The words that appear ON the image. Only wording from the page, the supplied copy or the facts above: never invented claims, prices or statistics."),
      audience: z.string(),
      reasoning: z.string(),
    }),
  ),
});

/** The on-image words, appended to the art direction so every later render and rework keeps them. */
export function directionWithText(
  direction: string,
  text: { headline: string; highlights: string[]; cta_label: string } | undefined,
): string {
  if (!text) return direction;
  const chips = text.highlights.map((h) => h.trim()).filter(Boolean);
  return [
    direction.trim(),
    `ON-IMAGE TEXT (typeset exactly as written, spelled correctly): headline "${text.headline.trim()}"${
      chips.length ? `; highlighted keywords ${chips.map((c) => `"${c}"`).join(", ")}` : ""
    }; call-to-action button "${text.cta_label.trim()}".`,
  ].join("\n");
}

export function pickModel() {
  const config = getConfig();
  if (config.hasAnthropic && config.ANTHROPIC_API_KEY) {
    return createAnthropic({ apiKey: config.ANTHROPIC_API_KEY })(
      config.ANTHROPIC_MODEL,
    );
  }
  if (config.hasOpenAI && config.OPENAI_API_KEY) {
    return createOpenAI({ apiKey: config.OPENAI_API_KEY })(config.OPENAI_MODEL);
  }
  return null;
}

export function buildConceptPrompt(input: ConceptWriterInput): string {
  const supplied = input.suppliedCopy;
  const hasCopy = Boolean(supplied?.headline || supplied?.primaryText);
  const lines = [
    `Business: ${input.brand.name}`,
    input.business.industry ? `Industry: ${input.business.industry}` : null,
    input.business.description ? `What they do: ${input.business.description}` : null,
    input.business.valueProposition ? `Value proposition: ${input.business.valueProposition}` : null,
    input.business.audience ? `Audience: ${input.business.audience}` : null,
    input.brand.voice ? `Brand voice: ${input.brand.voice}` : null,
    input.brand.colors?.length ? `Brand colours (from their site): ${input.brand.colors.join(", ")}` : null,
    input.brand.imageryNotes ? `Brand imagery notes: ${input.brand.imageryNotes}` : null,
    input.brand.guidelines ? `Brand guidelines: ${input.brand.guidelines.slice(0, 600)}` : null,
    input.brand.summary ? `Brand summary: ${input.brand.summary}` : null,
    `Offer being advertised: ${input.offer.name}${input.offer.description ? ` — ${input.offer.description}` : ""}`,
    input.offer.landingPageUrl ? `Landing page: ${input.offer.landingPageUrl}` : null,
    input.competitorOpportunities?.length
      ? `Gaps competitors leave open: ${input.competitorOpportunities.slice(0, 4).join("; ")}`
      : null,
    input.referenceBrief ? `Reference notes: ${input.referenceBrief.slice(0, 800)}` : null,
    input.brand.pageExcerpt ? `\nWhat their site says:\n${input.brand.pageExcerpt.slice(0, 2500)}` : null,
    "",
    hasCopy
      ? [
          "The operator already wrote the post. Every concept uses EXACTLY this copy; only the visual differs (the on-image headline is this headline cut to its core words, the highlights and button come from this copy):",
          supplied?.headline ? `Headline: ${supplied.headline}` : null,
          supplied?.primaryText ? `Primary text: ${supplied.primaryText}` : null,
        ]
          .filter(Boolean)
          .join("\n")
      : "Write each concept's copy yourself, grounded only in the facts above. Do not invent prices, statistics, awards or guarantees.",
    "",
    `Produce exactly ${input.count} concepts. Each must use a DIFFERENT visual style, chosen from what suits THIS business and message, drawing on a wide range such as: bold typographic poster with oversized headline; cinematic product or subject hero with dramatic lighting; candid lifestyle / user-generated feel photo; 3D-rendered objects or isometric scene; editorial magazine collage with cut-outs and torn paper; flat graphic illustration with big shapes; proof-led hero stat with a supporting visual; testimonial or quote card; before/after or versus split screen; visual metaphor for the problem and its fix; sticker / pop-art / hand-drawn annotation style; macro close-up with shallow depth of field; dark luxe glow versus bright high-key clean. Pick styles that fit the audience and keep the set varied, never five takes on one layout. Each creative_direction must show the specific message of the post (what the viewer should understand in one glance), use the brand colours as the palette (the dominant colour must be the first one listed), and carry the ad's own words ON the image as designed typography: a large headline, the keywords or proof points that matter picked out as highlighted chips or accent-coloured words, and a clear call-to-action button, all taken from the page and the copy (never invented), so the image sells on its own. No UI screenshots. Carry the brand's look from the notes above (light or dark scheme, typography feel, imagery style) so the still reads as this brand at a glance. The brand's real logo is supplied separately, so never describe, position or invent a logo; the image model places it where the layout wants it, so just leave one calm corner or strip free of text and key elements (about a fifth of the width). Keep every word, chip and the button well inside the frame, at least 8% from every edge, with the button above the bottom margin; never write "bottom edge" or "bleeding off" in a direction.`,
  ];
  return lines.filter((line) => line !== null).join("\n");
}

/**
 * Author the concepts (copy and art direction) with the LLM from the business
 * context, so no ad type, angle or image direction is hardcoded.
 */
export async function writeCreativeConcepts(
  input: ConceptWriterInput,
): Promise<CreativeConcept[]> {
  const model = pickModel();
  if (!model) {
    throw new Error(
      "No language model is configured to write creative concepts (set ANTHROPIC_API_KEY or OPENAI_API_KEY).",
    );
  }
  const { object } = await generateObject({
    model,
    schema: conceptSchema,
    temperature: 0.9,
    system:
      "You are an award-winning paid-social creative director who has made top-performing Meta static ads. You write ad concepts and image art directions that are specific to one business and one message, with a strong visual idea, real art direction (camera, light, layers, type hierarchy) and a distinct style per concept. You never fall back on generic stock imagery, flat templates or vague mood boards.",
    prompt: buildConceptPrompt(input),
  });

  const supplied = input.suppliedCopy;
  const ts = nowIso();
  return object.concepts.slice(0, input.count).map((c, index) => ({
    id: `concept_${input.clientId}_${index + 1}`,
    client_id: input.clientId,
    service_id: input.serviceId,
    concept: `${input.brand.name} — ${c.label}`,
    hook: c.hook,
    // Supplied copy is the post the images must illustrate; never rewrite it.
    primary_text: supplied?.primaryText?.trim() || c.primary_text,
    headline: supplied?.headline?.trim() || c.headline,
    description: c.description,
    cta: c.cta,
    creative_direction: directionWithText(
      c.style?.trim() ? `STYLE: ${c.style.trim()}. ${c.creative_direction}` : c.creative_direction,
      c.on_image_text,
    ),
    audience: c.audience,
    competitor_gap_addressed: c.label,
    reasoning: c.reasoning,
    created_at: ts,
  }));
}
