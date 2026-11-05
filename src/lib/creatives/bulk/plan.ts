import { generateObject } from "ai";
import { z } from "zod";
import { ADSPIRER_META_CTAS } from "@/lib/adspirer/skills/ad-copywriting";
import { directionWithText, findSimilarOnImageText, pickModel } from "@/lib/creatives/concept-writer";
import { pickBulkAngles, STAGE_LABEL, type BulkAngle } from "@/lib/creatives/bulk/angles";
import { pickBulkStyles, type BulkStyle } from "@/lib/creatives/bulk/styles";

/** Images (and hooks) in one run. */
export const BULK_RUN_SIZE = 15;
/** Bodies reused across the hooks of one run. */
export const BULK_BODY_COUNT = 4;

export type BulkBrief = {
  brandName: string;
  voice?: string | null;
  colors?: string[] | null;
  imageryNotes?: string | null;
  pageExcerpt?: string | null;
  summary?: string | null;
  industry?: string | null;
  description?: string | null;
  valueProposition?: string | null;
  audience?: string | null;
  offerName: string;
  offerDescription?: string | null;
  landingPageUrl?: string | null;
  /** Operator's own notes on the offer, audience and proof. */
  notes?: string | null;
  /** Copy the operator already has; it seeds the bodies. */
  pastedCopy?: string | null;
};

const CTA_VALUES = ADSPIRER_META_CTAS as unknown as [string, ...string[]];

const messageMapSchema = z.object({
  pains: z.array(z.string()).describe("6-10 specific frustrations or problems the audience has, in their own words, each grounded in the facts"),
  desires: z.array(z.string()).describe("5-8 outcomes, hopes or dreams the audience wants"),
  objections: z.array(z.string()).describe("4-6 doubts that stop them buying"),
  proof: z.array(z.string()).describe("Real proof points taken from the page or notes only: results, numbers, credentials, customers. Never invented."),
  mechanism: z.string().describe("How the offer actually delivers its result, in one or two sentences"),
  audience: z.string(),
});
export type MessageMap = z.infer<typeof messageMapSchema>;

const bodiesSchema = z.object({
  bodies: z
    .array(
      z.object({
        id: z.string().describe("A, B, C, D"),
        format: z.enum(["demonstration", "proof", "education", "story"]),
        text: z
          .string()
          .describe("The primary text, 45-90 words. It must work after ANY opening hook: it shows, proves, teaches or tells the substance, and never opens with a hook of its own."),
      }),
    )
    .length(BULK_BODY_COUNT),
  ctas: z
    .array(z.object({ label: z.string().describe("Button text, 2-4 words, the page's own call to action where it has one"), cta: z.enum(CTA_VALUES) }))
    .min(1)
    .max(2),
});

const hookSchema = z.object({
  hooks: z.array(
    z.object({
      angle_key: z.string().describe("Exactly the angle key assigned to this hook"),
      targets: z.string().describe("The specific pain, hope, objection or belief this hook targets, in one sentence, taken from the message map"),
      post_headline: z.string().describe("The ad's headline, under 40 characters: this hook said as a headline"),
      body_id: z.string().describe("The id of the body that best proves or fulfils this hook"),
      primary_text: z
        .string()
        .describe("That body rephrased so it opens on this hook's pain or hope and flows from it, keeping the body's substance and facts. 45-90 words."),
      cta_index: z.number().int().min(0).max(1),
      on_image_text: z.object({
        headline: z.string().describe("3-7 words printed on the image: this hook"),
        highlights: z.array(z.string()).max(3).describe("0-3 short labels (1-3 words) from the facts; none may repeat on another image"),
        cta_label: z.string(),
      }),
      style: z.string().describe("The assigned style name, exactly"),
      creative_direction: z
        .string()
        .describe("80-140 words. Open with the VISUAL IDEA in one sentence (the metaphor, contrast or scene that makes the hook felt with the text covered), then the scene, camera, light, layers, where the words sit and how the brand colours are used (dominant first)."),
    }),
  ),
});

export type BulkHook = {
  angle: BulkAngle;
  targets: string;
  postHeadline: string;
  bodyId: string;
  primaryText: string;
  ctaIndex: number;
  onImage: { headline: string; highlights: string[]; cta_label: string };
  style: string;
  creativeDirection: string;
};

export type BulkBody = { id: string; format: string; text: string };
export type BulkCta = { label: string; cta: string };

export type BulkPlan = {
  messageMap: MessageMap;
  bodies: BulkBody[];
  ctas: BulkCta[];
  hooks: BulkHook[];
};

type RawHook = z.infer<typeof hookSchema>["hooks"][number];

/**
 * Join the model's hooks to the angles that were assigned. Every assigned angle ends up with
 * exactly one hook, in assigned order; a hook for an angle that was not assigned, or a repeat, is
 * dropped. Returns null for angles the model skipped (the caller can retry those).
 */
export function matchHooksToAngles(
  assigned: BulkAngle[],
  raw: RawHook[],
  bodies: BulkBody[],
  ctaCount: number,
  styles?: Map<string, BulkStyle>,
): { hooks: BulkHook[]; missing: BulkAngle[] } {
  const byKey = new Map<string, RawHook>();
  for (const h of raw) if (!byKey.has(h.angle_key)) byKey.set(h.angle_key, h);
  const bodyIds = new Set(bodies.map((b) => b.id));
  const hooks: BulkHook[] = [];
  const missing: BulkAngle[] = [];
  for (const angle of assigned) {
    const h = byKey.get(angle.key);
    if (!h) {
      missing.push(angle);
      continue;
    }
    hooks.push({
      angle,
      targets: h.targets,
      postHeadline: h.post_headline,
      // A body id the model invented falls back to the first, so the hook always has a body to prove it.
      bodyId: bodyIds.has(h.body_id) ? h.body_id : bodies[0]!.id,
      primaryText: h.primary_text,
      ctaIndex: Math.min(Math.max(h.cta_index, 0), Math.max(ctaCount - 1, 0)),
      onImage: h.on_image_text,
      // The style was assigned in code, so a run cannot drift back to one look whatever the model writes.
      style: styles?.get(angle.key)?.name ?? h.style,
      creativeDirection: h.creative_direction,
    });
  }
  return { hooks, missing };
}

/** The art direction stored on the draft: style, angle, the visual idea and the printed words. */
export function directionForHook(hook: BulkHook): string {
  return directionWithText(
    `STYLE: ${hook.style}. ANGLE: ${hook.angle.name} (${STAGE_LABEL[hook.angle.stage]}, targets: ${hook.targets}). ${hook.creativeDirection}`,
    hook.onImage,
  );
}

const CONCEPT_FIRST =
  "CONCEPT FIRST — THE VISUAL IS THE AD. For each hook find a surprising, specific visual idea that makes it felt in one second with the text covered: a clever metaphor, a vivid contrast, a staged scene of real objects, a hero object doing something unexpected. Think like a top creative director, not a layout designer. The idea comes from THIS business and THIS hook, never a stock device, and no two hooks may share a visual idea or a style. Render-ready realism: tactile materials, believable light and depth, a deliberate colour grade in the brand palette. The picture takes 60-70% of the frame; words support it: a short headline sized to complement the scene, at most three small labels set into it, and one button. No rows of badges, no stat boxes, no clip-art. Everything printed is spelled exactly and readable at thumbnail size.";

function briefLines(b: BulkBrief): string[] {
  return [
    `Business: ${b.brandName}`,
    b.industry ? `Industry: ${b.industry}` : null,
    b.description ? `What they do: ${b.description}` : null,
    b.valueProposition ? `Value proposition: ${b.valueProposition}` : null,
    b.audience ? `Audience: ${b.audience}` : null,
    b.voice ? `Brand voice: ${b.voice}` : null,
    b.colors?.length ? `Brand colours (from their site): ${b.colors.join(", ")}` : null,
    b.imageryNotes ? `Brand imagery notes: ${b.imageryNotes}` : null,
    b.summary ? `Brand summary: ${b.summary}` : null,
    `Offer being advertised: ${b.offerName}${b.offerDescription ? ` — ${b.offerDescription}` : ""}`,
    b.landingPageUrl ? `Landing page: ${b.landingPageUrl}` : null,
    b.notes ? `Operator notes: ${b.notes.slice(0, 1500)}` : null,
    b.pageExcerpt ? `\nWhat their site says:\n${b.pageExcerpt.slice(0, 3000)}` : null,
  ].filter((l): l is string => l !== null);
}

const SYSTEM =
  "You are a direct-response creative strategist who builds paid-social ad batches the way a high-volume testing team does: many sharply different hooks over a few reusable bodies and a simple call to action. You work only from the facts given and never invent prices, statistics, awards, guarantees or customers.";

/**
 * Write a run: the message map, the shared bodies and CTAs, then `count` hooks, each for its own
 * angle. Three model calls for the whole run, not one per image.
 */
export async function writeBulkPlan(brief: BulkBrief, count = BULK_RUN_SIZE, avoidAngles: string[] = []): Promise<BulkPlan> {
  const model = pickModel();
  if (!model) throw new Error("No language model is configured to write ad copy (set ANTHROPIC_API_KEY or OPENAI_API_KEY).");
  const facts = briefLines(brief).join("\n");

  // 1. What the audience feels and wants, from the facts.
  const { object: messageMap } = await generateObject({
    model,
    schema: messageMapSchema,
    temperature: 0.4,
    system: SYSTEM,
    prompt: `${facts}\n\nBuild the message map for this offer: the audience's pains, desires and objections, the real proof points, and the mechanism. Ground every item in the facts above.`,
  });

  // 2. A few bodies that can sit behind any hook, and the CTAs.
  const { object: bodyPack } = await generateObject({
    model,
    schema: bodiesSchema,
    temperature: 0.6,
    system: SYSTEM,
    prompt: [
      facts,
      `\nMessage map:\n${JSON.stringify(messageMap)}`,
      brief.pastedCopy ? `\nThe operator's own copy (base body A on it, keeping its substance and claims):\n${brief.pastedCopy.slice(0, 2500)}` : null,
      `\nWrite exactly ${BULK_BODY_COUNT} distinct bodies (primary texts): one demonstration of how it works, one proof-led, one educational, one story. They are reused behind many different hooks, so none opens with a hook of its own and each stands on real facts. Then write 1-2 CTAs, using the page's own call to action where it has one.`,
    ]
      .filter(Boolean)
      .join("\n"),
  });
  const bodies: BulkBody[] = bodyPack.bodies.map((b, i) => ({ id: String.fromCharCode(65 + i), format: b.format, text: b.text }));
  const ctas: BulkCta[] = bodyPack.ctas.map((c) => ({ label: c.label, cta: c.cta }));

  // 3. One hook per assigned angle, no angle twice.
  const assigned = pickBulkAngles(count, { avoid: avoidAngles });
  const styles = new Map(pickBulkStyles(assigned).map((style, i) => [assigned[i]!.key, style] as const));
  const writeHooks = async (angles: BulkAngle[], extra?: string) => {
    const { object } = await generateObject({
      model,
      schema: hookSchema,
      temperature: 0.9,
      system: SYSTEM,
      prompt: [
        facts,
        `\nMessage map:\n${JSON.stringify(messageMap)}`,
        `\nBodies (reused behind the hooks):\n${bodies.map((b) => `${b.id} [${b.format}]: ${b.text}`).join("\n")}`,
        `\nCTAs: ${ctas.map((c, i) => `${i}: ${c.label}`).join("; ")}`,
        `\nWrite ${angles.length} hooks, one for EACH assigned angle below, using the exact angle_key. Each hook targets a different pain, hope, objection or belief, so the set tests genuinely different reasons a prospect might care, not rewordings. Pick for each the body that best proves or fulfils it (a "how we cut setup time" hook must sit on a body that shows that), and rephrase that body so it flows from the hook, keeping its facts.`,
        angles
          .map((a, i) => {
            const st = styles.get(a.key)!;
            return `${i + 1}. key "${a.key}" · ${a.name} · ${STAGE_LABEL[a.stage]} · targets a ${a.kind}: ${a.brief}\n   ASSIGNED STYLE "${st.name}": ${st.brief}`;
          })
          .join("\n"),
        "Every hook is made in its ASSIGNED STYLE, so the run looks like a set of genuinely different ads: the visual idea is yours, the treatment (lighting, medium, layout, mood) is the style's. Write the creative_direction in that style and set style to its name exactly.",
        `\nON-IMAGE WORDS MUST DIFFER: no two hooks share a headline wording or an on-image label, and no label repeats across the run.`,
        CONCEPT_FIRST,
        extra ?? null,
      ]
        .filter(Boolean)
        .join("\n"),
    });
    return object.hooks;
  };

  let matched = matchHooksToAngles(assigned, await writeHooks(assigned), bodies, ctas.length, styles);
  // Anything the model skipped gets one more try on its own.
  if (matched.missing.length) {
    const again = matchHooksToAngles(matched.missing, await writeHooks(matched.missing), bodies, ctas.length, styles);
    const done = new Map([...matched.hooks, ...again.hooks].map((h) => [h.angle.key, h]));
    matched = { hooks: assigned.map((a) => done.get(a.key)).filter((h): h is BulkHook => Boolean(h)), missing: again.missing };
  }
  let hooks = matched.hooks;

  // The same words on several images is the failure to avoid: ask once more for the clashing set.
  const clash = findSimilarOnImageText(hooks.map((h) => h.onImage));
  if (clash) {
    try {
      const retry = matchHooksToAngles(
        assigned,
        await writeHooks(assigned, `Your previous attempt reused wording across images (${clash}). Rewrite so every hook's headline and labels are clearly different.`),
        bodies,
        ctas.length,
        styles,
      );
      if (retry.hooks.length >= hooks.length) hooks = retry.hooks;
    } catch {
      // keep the first set
    }
  }

  if (!hooks.length) throw new Error("The ad copy writer returned no usable hooks. Try again.");
  return { messageMap, bodies, ctas, hooks };
}
