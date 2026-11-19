import { generateObject } from "ai";
import { z } from "zod";
import { pickModel } from "@/lib/creatives/concept-writer";
import { copyRulesBlock } from "@/lib/creatives/bulk/plan";
import { COPY_PRECEDENCE } from "@/lib/creatives/bulk/copy/check";
import { copyFromPrint, type PrintLine } from "@/lib/creatives/directed/markers";
import type { AdFields } from "@/lib/creatives/bulk/copy/rules";

const BATCH = 10;

const schema = z.object({
  ads: z.array(
    z.object({
      index: z.number().int().describe("The image number exactly as given"),
      headline: z.string().describe("The ad headline for the post (not the words printed on the image)"),
      primary_text: z.string().describe("The ad's primary text (the body that sits above the image)"),
      description: z.string().nullable().describe("The link description if the instructions ask for one, else null"),
    }),
  ),
});

const SYSTEM = "You are a direct-response copywriter for Meta ads. You write each ad's copy from the operator's instructions and the facts given, and never invent prices, statistics, awards, guarantees or customers.";

/**
 * Write the ad copy (headline, primary text, optional description) for each image of a directions run, from the
 * operator's instructions, the image's picture and printed words, the page's facts and any copy that already works
 * (as a seed). Batches of ten in file order; one result per direction. A direction the model leaves out or answers
 * blank falls back to its printed words, so every ad always has copy. Throws only when the model is unreachable for a
 * whole batch; the caller keeps the printed-words copy then.
 */
export async function writeDirectedCopy(
  input: { directions: Array<{ picture: string; print: PrintLine[] }>; instructions: string; pastedCopy?: string | null; facts: string },
  deps: { generate?: typeof generateObject } = {},
): Promise<AdFields[]> {
  const model = pickModel();
  if (!model) throw new Error("No language model is configured to write ad copy.");
  const generate = deps.generate ?? generateObject;
  const out: AdFields[] = input.directions.map((d) => {
    const fallback = copyFromPrint(d.print);
    return { headline: fallback.headline, primary_text: fallback.primary_text, description: null };
  });

  for (let start = 0; start < input.directions.length; start += BATCH) {
    const batch = input.directions.slice(start, start + BATCH);
    const { object } = await generate({
      model,
      schema,
      temperature: 0.5,
      system: SYSTEM,
      prompt: [
        "WRITE THE AD COPY for each image below: a headline, a primary text and, only if the instructions ask for one, a description. The words printed on the image are separate and are already fixed.",
        copyRulesBlock(input.instructions),
        COPY_PRECEDENCE.replace(" and report it in could_not with the rule and the reason", ""),
        "Never reword or contradict the words printed on an image: the ad copy may complement them but must agree with them.",
        input.facts ? `Facts you may use (nothing else):\n${input.facts.slice(0, 4000)}` : null,
        input.pastedCopy?.trim() ? `Copy that already works (use it as a seed for substance and voice, do not just repeat it):\n${input.pastedCopy.trim().slice(0, 2500)}` : null,
        batch
          .map((d, i) => `Image ${start + i + 1}: ${d.picture}\nWords printed on it: ${d.print.length ? d.print.map((l) => `"${l.text}"`).join(", ") : "(none)"}`)
          .join("\n\n"),
        `Return exactly one entry per image above (${batch.length}), using the image number as index.`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    });
    for (const ad of object.ads) {
      const at = ad.index - 1;
      if (at < start || at >= start + batch.length) continue;
      if (!ad.headline.trim() || !ad.primary_text.trim()) continue;
      out[at] = { headline: ad.headline.trim(), primary_text: ad.primary_text.trim(), description: ad.description?.trim() || null };
    }
  }
  return out;
}
