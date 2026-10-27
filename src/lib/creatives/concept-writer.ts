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
      hook: z.string(),
      primary_text: z.string(),
      headline: z.string().describe("Under 40 characters"),
      description: z.string(),
      cta: z.enum(CTA_VALUES),
      creative_direction: z
        .string()
        .describe(
          "A concrete art direction for the still: subject, setting, composition, lighting, and how the brand colours are used. It must visualise THIS ad's message for THIS business.",
        ),
      audience: z.string(),
      reasoning: z.string(),
    }),
  ),
});

function pickModel() {
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
          "The operator already wrote the post. Every concept uses EXACTLY this copy; only the visual differs:",
          supplied?.headline ? `Headline: ${supplied.headline}` : null,
          supplied?.primaryText ? `Primary text: ${supplied.primaryText}` : null,
        ]
          .filter(Boolean)
          .join("\n")
      : "Write each concept's copy yourself, grounded only in the facts above. Do not invent prices, statistics, awards or guarantees.",
    "",
    `Produce exactly ${input.count} concepts. Make them genuinely different from each other in subject, composition and setting, and choose those differences from what suits THIS business and THIS message; do not reuse a stock set of layouts. Each creative_direction must show the specific message of the post (what the viewer should understand in one glance), use the brand colours as the palette, and avoid rendering readable text, logos or UI.`,
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
    temperature: 0.8,
    system:
      "You are a senior paid-social creative director. You write Meta ad concepts and image art directions that are specific to one business and one message. You never pad with generic stock imagery ideas.",
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
    creative_direction: c.creative_direction,
    audience: c.audience,
    competitor_gap_addressed: c.label,
    reasoning: c.reasoning,
    created_at: ts,
  }));
}
