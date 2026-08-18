/**
 * Adspirer's Ad Copy Writing Room skill, adapted for Meta inside this app.
 *
 * Source: https://www.adspirer.com/skills/ad-copywriting
 * Docs: https://www.adspirer.com/docs/agent-skills/skills
 *
 * Adspirer does not expose a Meta MCP "generate copy" mutation — the skill is
 * the framework. We follow it here, ground variants in live creatives from
 * `get_meta_ad_creatives`, then apply via create_meta_image_campaign / create_ad
 * through Approvals (PAUSED).
 */

export const ADSPIRER_AD_COPYWRITING_SOURCE =
  "https://www.adspirer.com/skills/ad-copywriting";

/** Meta CTA buttons from Adspirer's skill (fixed platform list). */
export const ADSPIRER_META_CTAS = [
  "Learn More",
  "Shop Now",
  "Sign Up",
  "Get Offer",
  "Download",
  "Book Now",
  "Contact Us",
  "Get Quote",
] as const;

/**
 * Distinct direct-response angles the skill requires — not rephrasings of one idea.
 */
export const ADSPIRER_COPY_ANGLES = [
  "price/value",
  "urgency/scarcity",
  "social proof",
  "pain-point / problem-agitate-solve",
  "aspirational outcome",
  "mechanism / how-it-works",
  "curiosity / pattern-interrupt",
] as const;

export function buildAdspirerMetaCopySystemPrompt(): string {
  return [
    "You are executing Adspirer's Ad Copy Writing Room skill for Meta (Facebook/Instagram).",
    `Skill source: ${ADSPIRER_AD_COPYWRITING_SOURCE}`,
    "This is copy WRITING (new variants), not copy editing of existing lines.",
    "",
    "Procedure (follow strictly):",
    "1. Restate offer + audience in your internal reasoning; do not invent a price/promo the brief does not state.",
    "2. Pick DISTINCT angles from: " + ADSPIRER_COPY_ANGLES.join("; ") + ".",
    "   Each variant must be a different angle with a one-line rationale tied to this offer/audience — not 3 phrasings of the same idea.",
    "3. Meta constraints (count characters, do not eyeball):",
    "   - primary_text: front-load the hook in the first ~90 characters (mobile feed truncates); keep the visible hook tight (~125 chars preferred) though up to 2200 is allowed.",
    "   - headline: ≤40 characters; must stand alone under the image.",
    "   - description: ≤30 characters; optional / often invisible on mobile — no load-bearing claims.",
    "   - cta: ONLY from Meta's fixed list: " + ADSPIRER_META_CTAS.join(", ") + ".",
    "4. Policy scrub before output:",
    "   - No unsubstantiated superlatives (#1, best, guaranteed) without proof in the brief.",
    "   - No fabricated urgency on evergreen offers.",
    "   - No personal-attribute call-outs (age/health struggles) that trip Special Ad Category rules.",
    "   - No ALL-CAPS or !!! spam punctuation.",
    "5. If LIVE ACCOUNT CREATIVES are provided, differentiate — do not restatement fatigued headlines/primary text.",
    "6. Prefer 1–2 variants you'd test first; still return the full requested set.",
    "",
    'Return ONLY JSON: {"variants":[{"id":"copy_1","angle":"","primary_text":"","headline":"","description":"","cta":"","rationale":"","test_first":false}]}',
    "No markdown fences. Every field required. test_first true on at most two variants.",
  ].join("\n");
}

export function formatLiveCreativesForCopyPrompt(
  creatives: Array<{
    ad_id: string;
    ad_name?: string;
    headline?: string | null;
    primary_text?: string | null;
    description?: string | null;
    call_to_action_type?: string | null;
    ctr?: number;
    frequency?: number;
    spend?: number;
  }>,
): string {
  if (!creatives.length) {
    return "No live Meta creatives returned from Adspirer for this account — write net-new angles.";
  }
  const lines = creatives.slice(0, 12).map((c, i) => {
    const metrics = [
      typeof c.ctr === "number" ? `CTR ${c.ctr.toFixed(2)}%` : null,
      typeof c.frequency === "number" ? `freq ${c.frequency.toFixed(1)}` : null,
      typeof c.spend === "number" ? `spend $${c.spend.toFixed(0)}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    return [
      `${i + 1}. ${c.ad_name ?? c.ad_id}${metrics ? ` (${metrics})` : ""}`,
      c.headline ? `   headline: ${c.headline}` : null,
      c.primary_text ? `   primary: ${c.primary_text.slice(0, 220)}` : null,
      c.description ? `   description: ${c.description}` : null,
      c.call_to_action_type ? `   cta: ${c.call_to_action_type}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  });
  return [
    "LIVE Meta creatives from Adspirer get_meta_ad_creatives (read-only).",
    "New variants MUST be genuinely differentiated from these — do not restate them:",
    ...lines,
  ].join("\n");
}
