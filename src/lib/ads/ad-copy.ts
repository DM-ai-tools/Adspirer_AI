import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { getConfig } from "@/lib/config";
import { getLiveAdspirerProvider, getProvider } from "@/lib/adspirer/client";
import {
  ADSPIRER_AD_COPYWRITING_SOURCE,
  ADSPIRER_META_CTAS,
  buildAdspirerMetaCopySystemPrompt,
  formatLiveCreativesForCopyPrompt,
} from "@/lib/adspirer/skills/ad-copywriting";
import type { MetaAdCreative } from "@/lib/adspirer/provider";
import { logger } from "@/lib/observability/logger";

export type MetaAdCopyVariant = {
  id: string;
  angle: string;
  primary_text: string;
  headline: string;
  description: string;
  cta: string;
  rationale: string;
  test_first?: boolean;
};

export type AdCopyBrief = {
  offer: string;
  audience: string;
  landing_page_url?: string;
  tone?: string;
  proof_points?: string[];
  must_include?: string[];
  must_avoid?: string[];
  objective?: string;
  variants?: number;
  /** When refreshing fatigued creatives, force differentiation against live ads. */
  refresh?: boolean;
  /** Competitor ads / uploaded docs to recreate or ground against. */
  reference_material?: string;
};

export type GenerateMetaAdCopiesResult = {
  variants: MetaAdCopyVariant[];
  /** Where the drafting model ran; framework is always Adspirer's skill. */
  source: "adspirer_skill+openai" | "adspirer_skill+heuristic";
  framework: "adspirer_ad_copywriting";
  framework_url: string;
  grounded_in_live_creatives: boolean;
  live_creative_count: number;
};

function normalizeCta(raw: string | undefined): string {
  const value = (raw ?? "Learn More").trim();
  const match = ADSPIRER_META_CTAS.find(
    (cta) => cta.toLowerCase() === value.toLowerCase(),
  );
  if (match) return match;
  // Meta enums sometimes arrive as LEARN_MORE
  const spaced = value.replace(/_/g, " ");
  const matchSpaced = ADSPIRER_META_CTAS.find(
    (cta) => cta.toLowerCase() === spaced.toLowerCase(),
  );
  return matchSpaced ?? "Learn More";
}

function clampHeadline(value: string): string {
  return value.trim().slice(0, 40);
}

function clampDescription(value: string): string {
  return value.trim().slice(0, 30);
}

async function loadLiveCreatives(
  accountId?: string | null,
): Promise<MetaAdCreative[]> {
  if (!accountId) return [];
  try {
    const provider = getLiveAdspirerProvider() ?? getProvider();
    if (!provider.getAdCreatives) return [];
    return await provider.getAdCreatives(accountId, {
      lookback_days: 30,
      limit: 20,
    });
  } catch (error) {
    logger.warn("Adspirer get_meta_ad_creatives failed during copy grounding", {
      accountId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Generate Meta-ready ad copy variants using Adspirer's Ad Copy Writing Room
 * skill, grounded in live account creatives when an account is mapped.
 *
 * Mutations still go through Adspirer create tools + Approvals (PAUSED).
 * See: https://www.adspirer.com/skills/ad-copywriting
 */
export async function generateMetaAdCopies(input: {
  clientName: string;
  brandVoice?: string | null;
  industry?: string | null;
  valueProposition?: string | null;
  brief: AdCopyBrief;
  /** Mapped Meta act_… id — pulls live creatives via Adspirer. */
  accountId?: string | null;
}): Promise<GenerateMetaAdCopiesResult> {
  const count = Math.min(Math.max(input.brief.variants ?? 3, 1), 5);
  const config = getConfig();
  const liveCreatives = await loadLiveCreatives(input.accountId);
  const liveBlock = formatLiveCreativesForCopyPrompt(liveCreatives);

  if (config.hasOpenAI && config.OPENAI_API_KEY) {
    try {
      const openai = createOpenAI({ apiKey: config.OPENAI_API_KEY });
      const { text } = await generateText({
        model: openai(config.OPENAI_MODEL),
        temperature: 0.55,
        maxOutputTokens: 2400,
        system: buildAdspirerMetaCopySystemPrompt(),
        prompt: [
          `Brand: ${input.clientName}`,
          input.industry ? `Industry: ${input.industry}` : null,
          input.brandVoice ? `Brand voice: ${input.brandVoice}` : null,
          input.valueProposition
            ? `Value prop: ${input.valueProposition}`
            : null,
          `Offer / product: ${input.brief.offer}`,
          `Audience: ${input.brief.audience}`,
          input.brief.objective
            ? `Campaign objective: ${input.brief.objective}`
            : null,
          input.brief.tone ? `Tone: ${input.brief.tone}` : null,
          input.brief.landing_page_url
            ? `Landing page: ${input.brief.landing_page_url}`
            : null,
          input.brief.proof_points?.length
            ? `Proof points: ${input.brief.proof_points.join("; ")}`
            : null,
          input.brief.must_include?.length
            ? `Must include: ${input.brief.must_include.join("; ")}`
            : null,
          input.brief.must_avoid?.length
            ? `Must avoid: ${input.brief.must_avoid.join("; ")}`
            : null,
          input.brief.refresh
            ? "Mode: fatigue REFRESH — differentiate hard against live creatives."
            : "Mode: net-new launch copy (still differentiate if live creatives exist).",
          input.brief.reference_material
            ? [
                "SOURCE / COMPETITOR REFERENCE (recreate messaging for OUR brand; do not invent claims; do not clone trademarks):",
                input.brief.reference_material.slice(0, 6000),
              ].join("\n")
            : null,
          `Generate ${count} distinct-angle variants.`,
          "",
          liveBlock,
        ]
          .filter(Boolean)
          .join("\n"),
      });

      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]) as {
          variants?: Array<Partial<MetaAdCopyVariant>>;
        };
        const variants = (parsed.variants ?? [])
          .filter((v) => v.primary_text && v.headline)
          .slice(0, count)
          .map((v, i) => ({
            id: v.id?.trim() || `copy_${i + 1}`,
            angle: String(v.angle ?? `Angle ${i + 1}`),
            primary_text: String(v.primary_text),
            headline: clampHeadline(String(v.headline)),
            description: clampDescription(
              String(v.description ?? v.headline ?? ""),
            ),
            cta: normalizeCta(v.cta ? String(v.cta) : undefined),
            rationale: String(v.rationale ?? ""),
            test_first: Boolean(v.test_first),
          }));
        if (variants.length) {
          return {
            variants,
            source: "adspirer_skill+openai",
            framework: "adspirer_ad_copywriting",
            framework_url: ADSPIRER_AD_COPYWRITING_SOURCE,
            grounded_in_live_creatives: liveCreatives.length > 0,
            live_creative_count: liveCreatives.length,
          };
        }
      }
    } catch (error) {
      logger.warn(
        "Adspirer-skill OpenAI ad copy generation failed; using heuristic",
        {
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  return {
    variants: heuristicCopies(input, count, liveCreatives),
    source: "adspirer_skill+heuristic",
    framework: "adspirer_ad_copywriting",
    framework_url: ADSPIRER_AD_COPYWRITING_SOURCE,
    grounded_in_live_creatives: liveCreatives.length > 0,
    live_creative_count: liveCreatives.length,
  };
}

function heuristicCopies(
  input: {
    clientName: string;
    brandVoice?: string | null;
    valueProposition?: string | null;
    brief: AdCopyBrief;
  },
  count: number,
  liveCreatives: MetaAdCreative[],
): MetaAdCopyVariant[] {
  const offer = input.brief.offer;
  const brand = input.clientName;
  const audience = input.brief.audience;
  const vp = input.valueProposition ?? offer;
  const avoidHeadlines = new Set(
    liveCreatives
      .map((c) => c.headline?.trim().toLowerCase())
      .filter(Boolean) as string[],
  );

  const angles: Array<Omit<MetaAdCopyVariant, "id">> = [
    {
      angle: "pain-point / problem-agitate-solve",
      primary_text: `Tired of guessing with ${offer.toLowerCase()}? ${brand} gives ${audience.toLowerCase()} a clear path — ${vp}.`,
      headline: clampHeadline(`Stop guessing on ${offer}`),
      description: clampDescription(offer),
      cta: "Learn More",
      rationale:
        "Problem-agitate-solve angle from Adspirer Ad Copy Writing Room.",
      test_first: true,
    },
    {
      angle: "social proof",
      primary_text: `Teams like yours trust ${brand} for ${offer.toLowerCase()}. See why ${audience.toLowerCase()} switch — ${vp}.`,
      headline: clampHeadline(`Trusted for ${offer}`),
      description: clampDescription("See why teams switch"),
      cta: "Learn More",
      rationale: "Social-proof angle; peer validation without fabricated claims.",
    },
    {
      angle: "aspirational outcome",
      primary_text: `Imagine ${audience.toLowerCase()} getting ${vp.toLowerCase()} without the usual friction. ${brand} makes ${offer.toLowerCase()} practical.`,
      headline: clampHeadline(`Get to ${vp}`.slice(0, 40)),
      description: clampDescription("A clearer next step"),
      cta: "Learn More",
      rationale: "Outcome-led angle for feed scrollers scanning for results.",
      test_first: true,
    },
    {
      angle: "mechanism / how-it-works",
      primary_text: `Here's how ${brand} handles ${offer.toLowerCase()}: a simple flow built for ${audience.toLowerCase()}. ${vp}.`,
      headline: clampHeadline(`How ${brand} works`),
      description: clampDescription("See the simple flow"),
      cta: "Learn More",
      rationale: "Mechanism angle — reduces skepticism with process clarity.",
    },
    {
      angle: "price/value",
      primary_text: `Get more from ${offer.toLowerCase()} without the bloat. ${brand} focuses on ${vp.toLowerCase()} for ${audience.toLowerCase()}.`,
      headline: clampHeadline(`More value, less waste`),
      description: clampDescription("Value without bloat"),
      cta: "Shop Now",
      rationale: "Value angle when price mechanics are not specified in brief.",
    },
  ];

  return angles
    .filter((a) => !avoidHeadlines.has(a.headline.toLowerCase()))
    .slice(0, count)
    .map((a, i) => ({
      id: `copy_${i + 1}`,
      ...a,
    }));
}

/** Parse a free-text operator brief into structured fields when possible. */
export function parseAdCopyBriefFromText(text: string): AdCopyBrief | null {
  const offer =
    text.match(/(?:offer|product|service)\s*[:=]\s*(.+)/i)?.[1]?.trim() ||
    text.match(/for\s+(.+?)(?:\s+targeting|\s+audience|$)/i)?.[1]?.trim();
  const audience =
    text.match(/(?:audience|targeting)\s*[:=]\s*(.+)/i)?.[1]?.trim() ||
    "Prospective customers";
  const landing =
    text.match(/https?:\/\/[^\s)>"']+/i)?.[0]?.replace(/[.,;:]+$/, "") ||
    undefined;
  if (!offer && !/ad copy|headline|primary text|write copy/i.test(text)) {
    return null;
  }
  return {
    offer: offer || "Core offer",
    audience,
    landing_page_url: landing,
    variants: 3,
    refresh: /\b(refresh|fatigue|stale|new copy for existing)\b/i.test(text),
  };
}
