import type { Client, ClientService, CompetitorBrief } from "@/types";
import { nowIso } from "@/lib/utils";

export type CreativeConcept = {
  id: string;
  client_id: string;
  service_id: string | null;
  concept: string;
  hook: string;
  primary_text: string;
  headline: string;
  description: string;
  cta: string;
  creative_direction: string;
  audience: string;
  competitor_gap_addressed: string;
  reasoning: string;
  created_at: string;
};

/**
 * Structurally different layouts, not just different wording. Each entry has to
 * produce a visibly distinct image even when the ad copy is identical, so they
 * differ by composition, subject and whether photography is used at all.
 */
export const VISUAL_ANGLES = [
  {
    key: "hero_subject",
    label: "Hero subject",
    direction:
      "Single hero subject centred against generous empty space, natural directional daylight, shallow depth of field, photographic. Minimal on-image text.",
  },
  {
    key: "data_proof",
    label: "Data proof",
    direction:
      "Flat graphic composition built from UI cards, an upward trend chart and two large numeric proof points on a solid brand-colour field. No photography, no people.",
  },
  {
    key: "split_contrast",
    label: "Split contrast",
    direction:
      "Hard vertical split-screen: desaturated grey 'before' half on the left against a vivid brand-coloured 'after' half on the right. Symmetrical, graphic, one short caption per side.",
  },
  {
    key: "human_candid",
    label: "Human candid",
    direction:
      "Candid documentary photograph of real people working, off-centre framing, warm tones, environment blurred behind them. No posed stock smiles, no laptops centred in frame.",
  },
  {
    key: "bold_type",
    label: "Bold typographic",
    direction:
      "Typography-led poster with one oversized headline filling the frame on a flat brand-colour background, a single small geometric accent shape, very high contrast. No photography.",
  },
] as const;

export function visualAngleForIndex(index: number) {
  return VISUAL_ANGLES[index % VISUAL_ANGLES.length]!;
}

/**
 * Build N variants that share the operator's ad copy but differ visually.
 * Used when the operator already supplied headline + primary text, or when no
 * service record exists to derive messaging angles from.
 */
export function buildVisualVariantConcepts(input: {
  clientId: string;
  serviceId: string | null;
  brandName: string;
  serviceName: string;
  headline: string;
  primaryText: string;
  description?: string | null;
  cta?: string | null;
  baseDirection?: string | null;
  audience?: string | null;
  count: number;
}): CreativeConcept[] {
  const count = Math.min(Math.max(input.count, 1), VISUAL_ANGLES.length);
  const ts = nowIso();

  return Array.from({ length: count }, (_, index) => {
    const angle = visualAngleForIndex(index);
    return {
      id: `concept_${input.clientId}_${index + 1}`,
      client_id: input.clientId,
      service_id: input.serviceId,
      concept: `${input.brandName} — ${angle.label}`,
      hook: input.primaryText.slice(0, 120),
      primary_text: input.primaryText,
      headline: input.headline,
      description: input.description ?? input.serviceName,
      cta: input.cta ?? "Learn More",
      creative_direction: [input.baseDirection, angle.direction]
        .filter(Boolean)
        .join(" "),
      audience: input.audience ?? "Target audience",
      competitor_gap_addressed: angle.label,
      reasoning: `Visual variation ${index + 1} of ${count} (${angle.label}) using the supplied ad copy.`,
      created_at: ts,
    };
  });
}

/**
 * Generate structured ad concepts from brand + service + competitor brief.
 * Does not invent Meta performance numbers; gaps come from persisted briefs.
 */
export function generateCreativeConcepts(input: {
  client: Client;
  service: ClientService;
  brief: CompetitorBrief | null;
  count?: number;
}): CreativeConcept[] {
  const count = Math.min(Math.max(input.count ?? 3, 1), 5);
  const brand = input.client.name;
  const service = input.service.name;
  const voice = input.client.brand_voice ?? "Clear, trustworthy, benefit-led";
  const audience =
    input.client.target_audience ?? "Qualified prospects in the service area";
  const gaps = input.brief?.opportunities?.filter(Boolean) ?? [];
  const overused = input.brief?.messaging_themes?.slice(0, 2) ?? [
    "Generic confidence messaging",
  ];
  const ts = nowIso();

  const angles = [
    {
      label: "Transparency",
      hook: `Know exactly what ${service.toLowerCase()} involves — before you commit.`,
      headline: "Clear scope. Honest timelines.",
      cta: "Get a clear quote",
    },
    {
      label: "Proof",
      hook: "Measurable results, not promises.",
      headline: `${brand}: proof over promises.`,
      cta: "See the results",
    },
    {
      label: "Lasting value",
      hook: "Not a quick fix — a result that holds.",
      headline: "Outcomes you can plan around.",
      cta: "Get your plan",
    },
    {
      label: "Local trust",
      hook: "Work with a team that actually answers.",
      headline: "Trusted locally. Built around you.",
      cta: "Meet the team",
    },
    {
      label: "Offer clarity",
      hook: `What your first ${service.toLowerCase()} engagement really looks like.`,
      headline: "Your first step, demystified.",
      cta: "Book a walkthrough",
    },
  ];

  return angles.slice(0, count).map((angle, index) => {
    const visual = visualAngleForIndex(index);
    const gap = gaps[index] ?? gaps[0] ?? angle.label;
    return {
      id: `concept_${input.client.id}_${input.service.id}_${index + 1}`,
      client_id: input.client.id,
      service_id: input.service.id,
      concept: `${service} — ${angle.label}`,
      hook: angle.hook,
      primary_text: [
        angle.hook,
        "",
        `${brand} helps ${audience.toLowerCase()} with ${service.toLowerCase()}.`,
        input.service.description
          ? `Service note: ${input.service.description}`
          : null,
      ]
        .filter(Boolean)
        .join("\n"),
      headline: angle.headline,
      description: `${service} at ${brand} — ${gap}.`,
      cta: angle.cta,
      creative_direction: visual.direction,
      audience,
      competitor_gap_addressed: gap,
      reasoning: input.brief
        ? `Derived from competitor brief for ${service}: addresses gap “${gap}” while avoiding overused angles like “${overused[0]}”. Rendered as a ${visual.label.toLowerCase()} layout. Brand voice: ${voice}.`
        : `No fresh competitor brief found; uses brand context and safe differentiation heuristics. Rendered as a ${visual.label.toLowerCase()} layout. Re-run competitor research for stronger evidence.`,
      created_at: ts,
    };
  });
}
