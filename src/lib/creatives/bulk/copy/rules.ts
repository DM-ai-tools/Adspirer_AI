import { generateObject } from "ai";
import { z } from "zod";
import { pickModel } from "@/lib/creatives/concept-writer";
import { logger } from "@/lib/observability/logger";

/** What the operator's ad copy instructions boil down to, so every ad can be checked against them. */
export type Limit = { unit: "words" | "characters"; max: number };

export type CopyRules = {
  headline?: Limit;
  primary_text?: Limit;
  description?: Limit;
  /** Every inclusion, exclusion and structure point the instructions state, one short item each. */
  checklist: string[];
};

export type AdFields = { headline: string; primary_text: string; description: string | null };

export { COPY_FIELD_LIMITS } from "@/lib/creatives/bulk/copy/limits-ui";

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

const measure = (text: string, limit: Limit) => (limit.unit === "words" ? wordCount(text) : text.length);

const LABEL = { headline: "Headline", primary_text: "Primary text", description: "Description" } as const;

/** The numeric limits an ad's copy breaks, as plain sentences. Only fields that have a limit are checked (description only when present). */
export function limitProblems(copy: AdFields, rules: CopyRules): string[] {
  const out: string[] = [];
  for (const field of ["headline", "primary_text", "description"] as const) {
    const limit = rules[field];
    const text = copy[field];
    if (!limit || text === null) continue;
    const size = measure(text, limit);
    if (size > limit.max) out.push(`${LABEL[field]} is ${size} ${limit.unit}; your limit is ${limit.max}.`);
  }
  return out;
}

const limitSchema = z.object({ unit: z.enum(["words", "characters"]), max: z.number() }).nullable();

const rulesSchema = z.object({
  headline: limitSchema.describe("A length limit the operator stated for the headline, else null"),
  primary_text: limitSchema.describe("A length limit the operator stated for the primary text (the main ad body), else null"),
  description: limitSchema.describe("A length limit the operator stated for the link description, else null"),
  checklist: z.array(z.string()).describe("Every other thing the instructions require or forbid (what to include, what to avoid, structure, tone), one short imperative item each"),
});

const keep = (limit: { unit: "words" | "characters"; max: number } | null): Limit | undefined => (limit && Number.isFinite(limit.max) && limit.max > 0 ? { unit: limit.unit, max: Math.floor(limit.max) } : undefined);

/**
 * Read the operator's instructions into limits and a checklist (one model call). It copies only what was
 * actually stated: it never adds rules of its own. On any error, or with no model, there are no rules.
 */
export async function extractCopyRules(instructions: string, deps: { generate?: typeof generateObject } = {}): Promise<CopyRules> {
  const model = pickModel();
  if (!model || !instructions.trim()) return { checklist: [] };
  try {
    const { object } = await (deps.generate ?? generateObject)({
      model,
      schema: rulesSchema,
      temperature: 0,
      system: "You turn an operator's instructions for ad copy into a precise checklist. Copy only what they actually said: lengths they gave (and for which field), things to include, things to avoid, structure and tone. Never add a rule they did not state.",
      prompt: instructions.slice(0, 2000),
    });
    const headline = keep(object.headline);
    const primary_text = keep(object.primary_text);
    const description = keep(object.description);
    return {
      ...(headline ? { headline } : {}),
      ...(primary_text ? { primary_text } : {}),
      ...(description ? { description } : {}),
      checklist: object.checklist.map((c) => c.trim()).filter(Boolean),
    };
  } catch (error) {
    logger.warn("Could not read the ad copy instructions into rules", { error: error instanceof Error ? error.message : String(error) });
    return { checklist: [] };
  }
}
