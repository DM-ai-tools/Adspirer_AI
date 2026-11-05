import { generateObject } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { ADSPIRER_META_CTAS } from "@/lib/adspirer/skills/ad-copywriting";
import type { CreativeConcept } from "@/lib/creatives/generator";
import { nowIso } from "@/lib/utils";
import { planCreativeSet, type CreativePlan } from "@/lib/creatives/creative-styles";

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
      angle: z.string().describe("The advertising angle this concept argues, as assigned (2-4 words)"),
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
          "A rich, specific art direction of 80-140 words for a finished, scroll-stopping ad. Open with the VISUAL IDEA in one sentence (the metaphor, contrast or scene that makes THIS offer understood at a glance with the text covered), then: the subject and setting; camera angle, lens and framing; lighting and mood; foreground/mid/background layers; where the headline, chips and button sit and how large; textures and finish; and exactly how the brand colours are used (dominant colour first). Never a vague mood description.",
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

export function buildConceptPrompt(input: ConceptWriterInput, plan?: CreativePlan[]): string {
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
          "The operator already wrote the post. The post copy below is fixed and goes out unchanged with every image, so primary_text and headline in every concept are exactly this. The WORDS PRINTED ON EACH IMAGE are a different matter and must differ from concept to concept (see the on-image rule below). Post copy:",
          supplied?.headline ? `Headline: ${supplied.headline}` : null,
          supplied?.primaryText ? `Primary text: ${supplied.primaryText}` : null,
        ]
          .filter(Boolean)
          .join("\n")
      : "Write each concept's copy yourself, grounded only in the facts above. Do not invent prices, statistics, awards or guarantees.",
    "",
    plan?.length
      ? [
          "ASSIGNED ANGLE FOR EACH CONCEPT (concept 1 uses the first line, and so on, in this order). The set must feel like different ads from different creative ideas, never one layout with new colours. Adapt the angle to what the page actually offers; only if an assigned angle truly cannot be argued from the facts above may you move to the closest one, and never repeat an angle within the set. Choose each concept's visual style yourself, to suit the business and that angle, and make every style in the set different:",
          ...plan.map(
            (p, i) =>
              `${i + 1}. ANGLE "${p.angle.name}": ${p.angle.brief}`,
          ),
          "Each creative_direction must show its angle through a different subject, composition, camera and colour emphasis from the others. In the copy, write each concept's hook in its angle's voice.",
        ].join("\n")
      : null,
    `CONCEPT FIRST — THE VISUAL IS THE AD. Before any words, find for each concept a surprising, specific visual idea that makes the message felt in one second with the text covered: a clever visual metaphor, a vivid before-and-after or contrast, a staged scene with real objects, a hero object doing something unexpected, an exaggerated or impossible-but-believable moment. Think like a top creative director chasing a Cannes-worthy static ad, not a layout designer filling a template. The idea should come from THIS business and THIS message (what the offer fixes, what the customer wants), never from a stock device, and no two concepts may share a visual idea. Give every image a real-looking, richly rendered scene: tactile materials, believable lighting and shadows, depth with foreground, subject and background, a deliberate colour grade in the brand palette. The picture takes roughly 60 to 70 percent of the frame; the words support it. Words are secondary and brief: a clear headline of three to seven words sized to support the picture (never a huge poster that swallows it), at most three short labels or chips that sit inside the scene as if part of it, and one button. No walls of badges, no row of stat boxes, no stock plant-and-arrow clichés. Everything printed is spelled exactly and readable at thumbnail size, with calm space around it.`,
    `ON-IMAGE WORDS MUST DIFFER BETWEEN CONCEPTS. Four images that print the same headline, the same chips and the same button are one ad four times, which is the failure to avoid. Each concept's on_image_text takes its own angle: a different headline wording and idea, different highlights (a different benefit, number, proof point, objection or feature from the facts above), and a different button label where the page allows. No two concepts may share a headline, and no highlight may repeat across the set. Draw on the page and offer, not only the supplied headline: pick the one idea that fits the angle, and keep the image uncluttered. Still never invent claims, prices or statistics.`,
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
  const plan = planCreativeSet(input.count);
  const write = (extra?: string) =>
    generateObject({
    model,
    schema: conceptSchema,
    temperature: 0.9,
    system:
      "You are an award-winning paid-social creative director who has made top-performing Meta static ads. You write ad concepts and image art directions that are specific to one business and one message, with a strong visual idea, real art direction (camera, light, layers, type hierarchy) and a distinct style per concept. You never fall back on generic stock imagery, flat templates or vague mood boards.",
    prompt: buildConceptPrompt(input, plan) + (extra ? `

${extra}` : ""),
  });
  let { object } = await write();
  // The same words on every image is the failure the operator sees first: ask once more, naming the clash.
  const clash = findSimilarOnImageText(object.concepts.map((c) => c.on_image_text));
  if (clash) {
    try {
      object = (await write(`Your previous attempt reused wording across images (${clash}). Rewrite so every concept's on-image headline, highlights and button are clearly different.`)).object;
    } catch {
      // keep the first set
    }
  }

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
      `STYLE: ${c.style?.trim() || "distinct"}. ANGLE: ${plan[index]?.angle.name ?? c.angle}. ${c.creative_direction}`,
      c.on_image_text,
    ),
    audience: c.audience,
    competitor_gap_addressed: c.label,
    reasoning: `${plan[index]?.angle.name ?? c.angle}: ${c.reasoning}`,
    created_at: ts,
  }));
}

const STOP = new Set(["the", "a", "an", "and", "or", "to", "for", "of", "in", "on", "your", "you", "with", "is", "it", "we", "our", "at", "by"]);

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w && !STOP.has(w)),
  );
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

/** Describes the first pair of concepts whose on-image words are too alike, or null when the set is varied. */
export function findSimilarOnImageText(
  texts: Array<{ headline: string; highlights: string[]; cta_label: string } | undefined>,
): string | null {
  for (let i = 0; i < texts.length; i += 1) {
    for (let j = i + 1; j < texts.length; j += 1) {
      const a = texts[i];
      const b = texts[j];
      if (!a || !b) continue;
      if (overlap(words(a.headline), words(b.headline)) >= 0.6) return `concepts ${i + 1} and ${j + 1} share a headline`;
      const chipsA = new Set(a.highlights.map((h) => h.trim().toLowerCase()));
      if (b.highlights.some((h) => chipsA.has(h.trim().toLowerCase()))) return `concepts ${i + 1} and ${j + 1} share a highlight`;
    }
  }
  return null;
}
