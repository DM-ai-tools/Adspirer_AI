import { generateObject } from "ai";
import { z } from "zod";
import { pickModel } from "@/lib/creatives/concept-writer";
import { logger } from "@/lib/observability/logger";
import { extractCopyRules, limitProblems, type AdFields, type CopyRules } from "@/lib/creatives/bulk/copy/rules";

/** One ad's copy. `fixedWords` are words printed on its image (directions runs): context only, never part of the copy and never changed. */
export type CopyAd = AdFields & { id: string; fixedWords?: string[] };

export type CheckResult = {
  ads: CopyAd[];
  /** Per ad id: what it still does not follow. Only ads that fail or cannot comply have one. */
  notes: Record<string, string>;
  /** Ids whose copy was rewritten. */
  repaired: string[];
  rules: CopyRules;
};

/** The order that settles a collision between the operator's instructions and the facts or the printed words. */
export const COPY_PRECEDENCE =
  "When rules collide, follow this order: (1) never invent a fact, price, statistic, award, guarantee or customer; (2) never change or contradict the words printed on the image; (3) follow the operator's instructions. If an instruction cannot be met without breaking (1) or (2), do not force it: keep the best copy you can and report it in could_not with the rule and the reason.";

const judgeSchema = z.object({
  results: z.array(z.object({ id: z.string(), failed: z.array(z.string()).describe("The checklist items this ad does NOT meet, copied exactly. Empty when it meets them all.") })),
});

const repairSchema = z.object({
  ads: z.array(
    z.object({
      id: z.string().describe("Exactly the ad id"),
      headline: z.string(),
      primary_text: z.string(),
      description: z.string().nullable(),
      could_not: z.array(z.object({ rule: z.string(), reason: z.string() })).describe("Rules that cannot be met without inventing a fact or changing printed words, each with the reason. Empty when you met them all."),
    }),
  ),
});

const SYSTEM = "You are a meticulous ad copy editor for Meta ads. You follow the operator's instructions exactly, work only from the facts given, and never invent claims.";

const show = (ad: CopyAd) => `[${ad.id}]\nHeadline: ${ad.headline}\nPrimary text: ${ad.primary_text}${ad.description !== null ? `\nDescription: ${ad.description}` : ""}`;

/**
 * Check every ad's copy against the operator's instructions and rewrite only the ones that miss, once.
 * Length limits are checked in code; the other points by one model judge. Never throws and never blocks a
 * run: on any model error the copy is kept as it is, and what is still known to be wrong is noted per ad.
 */
export async function checkAndRepairCopy(
  input: { instructions: string; ads: CopyAd[]; facts: string },
  deps: { generate?: typeof generateObject; rules?: CopyRules } = {},
): Promise<CheckResult> {
  const unchanged = (rules: CopyRules): CheckResult => ({ ads: input.ads, notes: {}, repaired: [], rules });
  if (!input.instructions.trim() || !input.ads.length) return unchanged({ checklist: [] });
  const generate = deps.generate ?? generateObject;
  const rules = deps.rules ?? (await extractCopyRules(input.instructions, { generate }));
  const model = pickModel();
  if (!model) return unchanged(rules);

  // 1. What each ad breaks: length limits in code, the rest by one judge call.
  const problems = new Map<string, string[]>();
  const add = (id: string, items: string[]) => {
    if (items.length) problems.set(id, [...(problems.get(id) ?? []), ...items]);
  };
  for (const ad of input.ads) add(ad.id, limitProblems(ad, rules));
  /** The checklist items each ad does not meet, by one model call; null when the judge cannot be reached. */
  const judge = async (ads: CopyAd[]): Promise<Map<string, string[]> | null> => {
    try {
      const { object } = await generate({
        model,
        schema: judgeSchema,
        temperature: 0,
        system: SYSTEM,
        prompt: [
          "JUDGE THESE ADS against the checklist. For each ad list the checklist items it does NOT meet (copied exactly); an ad that meets every item gets an empty list. Judge only what the checklist says.",
          `Checklist:\n${rules.checklist.map((c) => `- ${c}`).join("\n")}`,
          ads.map(show).join("\n\n"),
        ].join("\n\n"),
      });
      const valid = new Set(rules.checklist);
      return new Map(object.results.filter((r) => ads.some((a) => a.id === r.id)).map((r) => [r.id, r.failed.filter((f) => valid.has(f))] as const));
    } catch (error) {
      logger.warn("Ad copy judge failed", { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  };
  if (rules.checklist.length) {
    const judged = await judge(input.ads);
    for (const [id, failed] of judged ?? []) add(id, failed.map((f) => `Does not meet: ${f}`));
  }
  if (!problems.size) return unchanged(rules);

  // 2. Rewrite only the ads that miss, in one call.
  const failing = input.ads.filter((a) => problems.has(a.id));
  let rewritten = new Map<string, z.infer<typeof repairSchema>["ads"][number]>();
  try {
    const { object } = await generate({
      model,
      schema: repairSchema,
      temperature: 0.3,
      system: SYSTEM,
      prompt: [
        "REPAIR THESE ADS so they follow the operator's instructions. Change only what is needed; keep what already works, the facts and the voice.",
        `Operator's instructions:\n${input.instructions.slice(0, 2000)}`,
        COPY_PRECEDENCE,
        input.facts ? `Facts you may use (nothing else):\n${input.facts.slice(0, 4000)}` : "No facts were given: use only what is already in the ads.",
        failing
          .map((ad) => [show(ad), ad.fixedWords?.length ? `Printed on the image (never change these words, never contradict them): ${ad.fixedWords.map((w) => `"${w}"`).join(", ")}` : null, `What this ad misses:\n${problems.get(ad.id)!.map((p) => `- ${p}`).join("\n")}`].filter(Boolean).join("\n"))
          .join("\n\n"),
        `A length limit is always met by shortening, so never report a length limit in could_not: shorten the copy instead.`,
        `Return every ad above, with its exact id. An ad has a description only if one is shown; otherwise return null for it.`,
      ].join("\n\n"),
    });
    rewritten = new Map(object.ads.map((a) => [a.id, a]));
  } catch (error) {
    logger.warn("Ad copy repair failed; the copy is kept as it was", { error: error instanceof Error ? error.message : String(error) });
  }

  // 2b. A length limit is always met by shortening. An ad still over one gets a last pass that only shortens it.
  const apply = (ad: CopyAd, r: z.infer<typeof repairSchema>["ads"][number] | undefined): CopyAd => {
    if (!r || !r.headline.trim() || !r.primary_text.trim()) return ad;
    return { ...ad, headline: r.headline.trim(), primary_text: r.primary_text.trim(), description: ad.description === null ? null : (r.description?.trim() ?? ad.description) };
  };
  const stillOver = failing.filter((ad) => limitProblems(apply(ad, rewritten.get(ad.id)), rules).length);
  if (stillOver.length) {
    try {
      const { object } = await generate({
        model,
        schema: repairSchema,
        temperature: 0.2,
        system: SYSTEM,
        prompt: [
          "SHORTEN THESE ADS TO FIT. Each is still over a length limit. Cut words until it fits: keep the meaning and the facts, drop the least important words, and never explain. Do not change anything else.",
          COPY_PRECEDENCE,
          stillOver
            .map((ad) => {
              const current = apply(ad, rewritten.get(ad.id));
              const over = limitProblems(current, rules).map((p) => `- ${p}`).join("\n");
              return [show(current), ad.fixedWords?.length ? `Printed on the image (never change): ${ad.fixedWords.map((w) => `"${w}"`).join(", ")}` : null, `Over the limit:\n${over}`].filter(Boolean).join("\n");
            })
            .join("\n\n"),
          "Return every ad above with its exact id and an empty could_not.",
        ].join("\n\n"),
      });
      for (const r of object.ads) if (stillOver.some((a) => a.id === r.id) && r.headline.trim() && r.primary_text.trim()) rewritten.set(r.id, { ...r, could_not: rewritten.get(r.id)?.could_not ?? [] });
    } catch (error) {
      logger.warn("Ad copy shorten pass failed; the copy is kept as it was", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  // 2c. The repair model may claim it could not follow a rule the new copy in fact meets. A claim only becomes a note
  // when a second check of the new copy agrees (or cannot be run): otherwise good ads would carry false warnings.
  const claimed = failing.filter((ad) => (rewritten.get(ad.id)?.could_not ?? []).some((c) => c.rule.trim()));
  const disproved = new Set<string>();
  if (claimed.length && rules.checklist.length) {
    const again = await judge(claimed.map((ad) => apply(ad, rewritten.get(ad.id))));
    for (const ad of claimed) if (again && !(again.get(ad.id)?.length)) disproved.add(ad.id);
  }

  // 3. Apply what came back, re-check the limits in code, and note what is still wrong.
  const repaired: string[] = [];
  const notes: Record<string, string> = {};
  const ads = input.ads.map((ad) => {
    const r = rewritten.get(ad.id);
    let next = ad;
    if (r && r.headline.trim() && r.primary_text.trim()) {
      next = { ...ad, headline: r.headline.trim(), primary_text: r.primary_text.trim(), description: ad.description === null ? null : (r.description?.trim() ?? ad.description) };
      if (next.headline !== ad.headline || next.primary_text !== ad.primary_text || next.description !== ad.description) repaired.push(ad.id);
    }
    if (!problems.has(ad.id)) return next;
    const parts: string[] = [];
    const still = limitProblems(next, rules);
    if (still.length) parts.push(`Did not fully follow your instructions: ${still.join(" ")}`);
    // A length limit is always met by shortening: a report that one could not be followed is dropped when the code finds it met.
    const couldNot = disproved.has(ad.id) ? [] : (r?.could_not ?? []).filter((c) => c.rule.trim() && !(/\b(words?|characters?|chars?|length|long|short)\b/i.test(c.rule) && !still.length));
    if (couldNot.length) parts.push(couldNot.map((c) => `Could not follow: ${c.rule.trim()}, because ${c.reason.trim().replace(/[.\s]+$/, "")}.`).join(" "));
    if (parts.length) notes[ad.id] = parts.join(" ");
    return next;
  });
  return { ads, notes, repaired, rules };
}
