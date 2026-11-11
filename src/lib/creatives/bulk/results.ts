/**
 * Client results and stats found on the landing page, for the images of a bulk run that exist only
 * to showcase them.
 *
 * Two or three images of a run are reserved for real proof: a case-study result (a client's industry
 * and what they achieved) or a headline stat ("1,500+ businesses"). They are only ever taken from
 * the page. A figure the model reports that is not actually written on the page is dropped, so a
 * made-up number can never reach an ad. A page with no results reserves nothing and the run is the
 * usual fifteen angles.
 */
import { z } from "zod";
import { generateObject } from "ai";
import { withModelFallback } from "@/lib/video/model-fallback";
import type { BulkAngle } from "@/lib/creatives/bulk/angles";

/** Images of a run reserved for client results, at most. */
export const RESULT_SLOTS_MAX = 3;
export const RESULT_KEY_PREFIX = "client_result_";

export type ClientResult = {
  /** A client's outcome ("case_result") or a figure about the business as a whole ("company_stat"). */
  kind: "case_result" | "company_stat";
  /** The client's industry, or who the stat is about ("Australian businesses"). Used to picture it. */
  industry: string;
  /** The client's name, only when the page names them. */
  client: string | null;
  /** The figure and what it measures, exactly as the page writes it. */
  stat: string;
  /** Timeframe, spend or other context from the page. */
  detail: string;
};

const schema = z.object({
  results: z
    .array(
      z.object({
        kind: z.enum(["case_result", "company_stat"]),
        industry: z.string().describe("The client's industry in 1-4 words (e.g. 'e-commerce fashion', 'dental clinics'), or who a company stat is about. Empty if the page does not say."),
        client: z.string().nullable().describe("The client's name ONLY if the page names them; otherwise null"),
        stat: z.string().describe("The figure and what it measures, copied exactly as the page writes it, e.g. '$26.5M Sales Revenue' or '7.61× ROAS'"),
        detail: z.string().describe("Context from the page for that figure, copied or tightly condensed: timeframe, ad spend, what was done. Empty if none."),
      }),
    )
    .max(10),
});

/** Number tokens in a stat, with their unit ("$26.5M" gives "26.5M", "1,500+" gives "1,500+", "15.36× ROAS" gives "15.36×"). */
function numberTokens(text: string): string[] {
  return text.match(/(?:\d[\d,.]*\d|\d)(?:[KMBkmb](?![A-Za-z])|[%×x+])?/g) ?? [];
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * True when every number in the stat is written on the page as a whole figure with the same unit:
 * "$30M" is not on a page that says "30-minute", and "500" is not inside "1,500".
 */
export function groundedIn(stat: string, pageText: string): boolean {
  const tokens = numberTokens(stat);
  if (!tokens.length) return false;
  const flat = pageText.replace(/\s+/g, " ");
  return tokens.every((t) => new RegExp(`(?<![\\d.,])${escapeRegex(t)}(?!\\d|[.,]\\d)`).test(flat));
}

/** Pull the client results and stats out of a page's text. Returns only figures that are written on the page. */
export async function findClientResults(pageText: string): Promise<ClientResult[]> {
  if (pageText.trim().length < 80) return [];
  const object = await withModelFallback(
    async (model) =>
      (
        await generateObject({
          model,
          schema,
          temperature: 0,
          system: "You extract proof points from a web page. You only report figures that are written on the page, copied exactly. You never estimate, round, combine or invent numbers.",
          prompt: [
            `Page text:\n${pageText}`,
            "\nList the client results and stats this page states.",
            "- case_result: what a client achieved (revenue, leads, ROAS, cost per lead, growth), ideally with their industry. Prefer these.",
            "- company_stat: a figure about the business as a whole (businesses served, ad spend managed, years, rating).",
            "Only include items with a real figure. Do not include prices, offers, deadlines, discounts or guarantees; those are not results. Copy the figure and its label exactly as the page writes them. Best, most credible and most specific first. If the page has no such figures, return an empty list.",
          ].join("\n"),
        })
      ).object,
  );
  const seen = new Set<string>();
  return object.results
    .map((r) => ({ ...r, stat: r.stat.trim(), detail: r.detail.trim(), industry: r.industry.trim(), client: r.client?.trim() || null }))
    .filter((r) => r.stat && groundedIn(r.stat, pageText))
    .filter((r) => {
      const key = numberTokens(r.stat).join("|");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/**
 * The results a run showcases, at most three: client results before business-wide stats, and
 * different industries before a second result from the same one, so the images do not all picture
 * the same kind of business.
 */
export function chooseResults(results: ClientResult[]): ClientResult[] {
  const ordered = [...results.filter((r) => r.kind === "case_result"), ...results.filter((r) => r.kind === "company_stat")];
  const picked: ClientResult[] = [];
  const industries = new Set<string>();
  for (const r of ordered) {
    const industry = r.industry.trim().toLowerCase();
    if (picked.length < RESULT_SLOTS_MAX && r.kind === "case_result" && (!industry || !industries.has(industry))) {
      picked.push(r);
      if (industry) industries.add(industry);
    }
  }
  for (const r of ordered) if (picked.length < RESULT_SLOTS_MAX && !picked.includes(r)) picked.push(r);
  return picked;
}

export function isResultAngle(angle: Pick<BulkAngle, "key">): boolean {
  return angle.key.startsWith(RESULT_KEY_PREFIX);
}

/** One angle per chosen result. The brief carries the exact figure so the hook writer cannot drift from it. */
export function resultAngles(results: ClientResult[]): BulkAngle[] {
  return chooseResults(results).map((r, i) => ({
    key: `${RESULT_KEY_PREFIX}${i + 1}`,
    name: r.kind === "case_result" ? `Client result: ${r.stat}` : `Proof in numbers: ${r.stat}`,
    stage: "most_aware" as const,
    kind: "proof" as const,
    brief: [
      `SHOWCASE THIS REAL RESULT from the landing page: "${r.stat}"${r.detail ? ` (${r.detail})` : ""}.`,
      r.industry ? `It is about ${r.industry}${r.client ? ` (${r.client})` : ""}.` : null,
      "Show that industry or audience in a creative, recognisable visual and make the figure the hero of the image, copied exactly. Add no other numbers.",
    ]
      .filter(Boolean)
      .join(" "),
  }));
}

/** The results as lines for the writer's facts. */
export function resultFacts(results: ClientResult[]): string | null {
  const chosen = chooseResults(results);
  if (!chosen.length) return null;
  return `Real client results and stats on the landing page (the only figures that may be shown as proof):\n${chosen
    .map((r) => `- ${r.stat}${r.detail ? ` (${r.detail})` : ""}${r.industry ? ` [${r.industry}]` : ""}`)
    .join("\n")}`;
}
