/**
 * Understanding an edit request before the image model sees it.
 *
 * The image model only draws what it is told, literally. Operators write requests the way they talk:
 * "make it punchier", "the numbers look off", "use the stats from the landing page", "different
 * concept". So every request is first read by a language model that can SEE the current image and
 * knows the ad's message. It works out what exactly has to change (which element, what the new
 * words or the new visual idea should be, when the operator did not say) and writes one precise
 * instruction for the image model. If the request leans on a web page (the landing page, or a link
 * the operator pasted), the page is read and the real words and numbers are copied in; a page that
 * does not hold what was asked for stops the edit with a plain reason instead of letting the image
 * model invent it.
 */
import { z } from "zod";
import { generateObject } from "ai";
import { logger } from "@/lib/observability/logger";
import { withModelFallback } from "@/lib/video/model-fallback";
import { readPageText, cleanPageText, clearPageCache } from "@/lib/creatives/page-text";

export { cleanPageText, clearPageCache };

/** Words that suggest the instruction leans on a web page. Used only when the interpreter itself is unavailable. */
const POINTS_AT_PAGE =
  /\b(landing|web\s?page|web\s?site|site|page|section|testimonials?|stats?|statistics|case\s?stud(?:y|ies)|faq|pricing)\b/i;
const URL_IN_TEXT = /https?:\/\/[^\s)"'<>]+/i;

export function urlInInstruction(instruction: string): string | null {
  return URL_IN_TEXT.exec(instruction)?.[0]?.replace(/[.,;:!?]+$/, "") ?? null;
}

/** True when the instruction may need something from a web page. */
export function mayNeedPage(instruction: string): boolean {
  return Boolean(urlInInstruction(instruction)) || POINTS_AT_PAGE.test(instruction);
}

export type ResolvedInstruction = {
  /** What to send to the image model. */
  instruction: string;
  /** One plain line on what the app understood and will change, shown to the operator. */
  summary: string;
  /** The page used, when one was read. */
  usedPage: string | null;
  facts: string[];
};

// ------------------------------------------------------------------ step 1: understand the request

const understandSchema = z.object({
  needs_page: z
    .boolean()
    .describe("True when the request depends on content that lives on a web page (the landing page or a link the operator gave): its stats, results, testimonials, wording, a section, prices. False for anything that can be done from the image and the request alone."),
  instruction: z
    .string()
    .describe("ONE self-contained instruction for the image editor: which element changes and exactly how, with the exact words to print or the exact visual to draw. When the operator did not specify the words or the idea, YOU decide them. Never mention 'the page' here when needs_page is true; it is filled in from the page next."),
  summary: z.string().describe("One short plain sentence for the operator: what you understood and what will change (e.g. 'Rewriting the headline to lead with the cost of waiting')."),
});

function mediaPartFor(image: Buffer | null | undefined): Promise<{ type: "image"; image: Uint8Array; mediaType: string } | null> {
  if (!image) return Promise.resolve(null);
  return (async () => {
    try {
      const sharp = (await import("sharp")).default;
      const small = await sharp(image).resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
      return { type: "image" as const, image: new Uint8Array(small), mediaType: "image/jpeg" };
    } catch {
      return null;
    }
  })();
}

function printedText(direction: string | null | undefined): string {
  return direction?.match(/ON-IMAGE TEXT[^:]*:\s*([^\n]+)/)?.[1]?.trim() ?? "";
}

function modeRule(mode: "edit" | "full"): string {
  return mode === "edit"
    ? "The editor will change ONLY what you describe and keep the rest of the image exactly as it is. So decide the smallest change that really delivers what the operator wants: name the element (the headline, one chip, the button, the background, the figure...) and say exactly what it becomes. If the operator did not give the words, write them: short, in the ad's own message and brand voice, never inventing facts, numbers, prices or claims. If they asked for something vague ('punchier', 'more premium', 'cleaner'), pick one concrete change that does it. If the request is really a new concept, do the closest targeted version and say so in the summary."
    : "The whole image will be redrawn from its brief with your instruction as the operator's feedback. If they asked for a different concept or look without saying what, decide the new visual idea concretely (the scene, the subject, the composition, the mood) so it is clearly different from the current image yet true to the ad's message; if they asked for specific changes, keep everything they did not mention. Never invent facts, numbers, prices or claims.";
}

type Understood = z.infer<typeof understandSchema>;

async function understand(input: {
  instruction: string;
  mode: "edit" | "full";
  image: Buffer | null | undefined;
  pageUrl: string | null;
  brandName?: string | null;
  headline?: string | null;
  primaryText?: string | null;
  creativeDirection?: string | null;
}): Promise<Understood> {
  const picture = await mediaPartFor(input.image);
  const printed = printedText(input.creativeDirection);
  const text = [
    `The operator's request about one ad image:\n"${input.instruction}"`,
    `\nThe ad: ${input.brandName ? `${input.brandName}. ` : ""}Headline "${input.headline ?? ""}"${printed ? `; printed on the image: ${printed}` : ""}.${input.primaryText ? ` Ad copy: ${input.primaryText.slice(0, 500)}` : ""}`,
    picture ? "The image as it is now is attached." : null,
    input.pageUrl ? `A web page is available to read: ${input.pageUrl}` : "No web page is available for this image.",
    `\n${modeRule(input.mode)}`,
    "Work out what the operator actually wants, even if they did not say it exactly. Keep any part of the request that is about colour, layout or style as they wrote it.",
  ]
    .filter(Boolean)
    .join("\n");
  const content: Array<{ type: "text"; text: string } | { type: "image"; image: Uint8Array; mediaType: string }> = [{ type: "text", text }];
  if (picture) content.push(picture);
  return withModelFallback(
    async (model) =>
      (
        await generateObject({
          model,
          schema: understandSchema,
          temperature: 0.3,
          system: "You are the creative director who turns an operator's rough feedback on an ad image into a precise brief for an image editor. The editor can only see the image and your instruction, never a web page. You never invent numbers, names, customers, results or claims.",
          messages: [{ role: "user", content }],
        })
      ).object,
  );
}

// ------------------------------------------------------------------ step 2: fill in from the page

const pageSchema = z.object({
  found: z.boolean().describe("True only if the page really contains what the operator asked for."),
  instruction: z
    .string()
    .describe("The instruction rewritten with the exact words, numbers and facts copied from the page. Self-contained. Never mention 'the page'."),
  facts: z.array(z.string()).max(12).describe("The exact snippets of the page you used, verbatim."),
  problem: z.string().describe("When found is false: one plain sentence on what the page does not contain. Otherwise an empty string."),
});

async function fillFromPage(input: { original: string; understood: Understood; mode: "edit" | "full"; url: string; pageText: string }): Promise<z.infer<typeof pageSchema>> {
  return withModelFallback(
    async (model) =>
      (
        await generateObject({
          model,
          schema: pageSchema,
          temperature: 0.1,
          system: "You prepare edit instructions for an image editor that can only see the image, never a web page. You work only from facts that are written on the page text you are given. You never invent numbers, names, customers, results or claims.",
          prompt: [
            `The operator's request:\n"${input.original}"`,
            `\nThe instruction as understood so far (without the page):\n"${input.understood.instruction}"`,
            `\nPage text (${input.url}):\n${input.pageText}`,
            "\nRewrite the instruction so every word, number and fact that should come from the page is copied exactly as the page writes it (keep symbols such as $, + and %). Say exactly which element on the image shows which words. Keep every printed item short enough to read at a glance: a figure plus a 2-4 word label for stats, a short line for a quote.",
            "Use at most the number of items the operator asked for; if they gave no number, pick the 3 strongest, most credible ones. Prefer real results and numbers over slogans.",
            modeRule(input.mode),
            "If part of the request is not about the page (a colour, a layout, a different concept), keep that part as the operator wrote it.",
            "If the page does not contain what the operator asked for, set found to false and say what is missing; do not substitute something else.",
          ].join("\n"),
        })
      ).object,
  );
}

const failureText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Work out what an edit request means and return the instruction for the image model. Throws, with a
 * message fit to show the operator, when the request needs a page that cannot be read or does not
 * hold what they asked for. If the interpreter itself cannot be reached, a request that clearly does
 * not lean on a page is passed on as written so editing still works.
 */
export async function resolveEditInstruction(input: {
  instruction: string;
  mode: "edit" | "full";
  /** The image as it is now, so the interpreter can see what "the button on the right" is. */
  image?: Buffer | null;
  landingPageUrl?: string | null;
  brandName?: string | null;
  headline?: string | null;
  primaryText?: string | null;
  creativeDirection?: string | null;
}): Promise<ResolvedInstruction> {
  const instruction = input.instruction.trim();
  const url = urlInInstruction(instruction) ?? input.landingPageUrl ?? null;

  let understood: Understood;
  try {
    understood = await understand({ ...input, instruction, image: input.image, pageUrl: url });
  } catch (error) {
    logger.warn("Could not interpret an edit request", { error: failureText(error) });
    if (mayNeedPage(instruction)) throw new Error(`Could not work out what to take from ${url ?? "the page"} (${failureText(error)}).`);
    return { instruction, summary: "Sent exactly as you wrote it (the app could not interpret it first).", usedPage: null, facts: [] };
  }

  const clean = understood.instruction.trim() || instruction;
  const summary = understood.summary.trim() || "Changing what you asked for.";
  if (!understood.needs_page) return { instruction: clean, summary, usedPage: null, facts: [] };

  if (!url) throw new Error("This image has no landing page to read from. Paste the page's link in your instruction and try again.");
  let page;
  try {
    page = await readPageText(url);
  } catch (error) {
    throw new Error(`Could not open ${url} to read it (${failureText(error)}).`);
  }
  if (!page.readable) throw new Error(`Could not read any text from ${url}. Check the link opens, or type the words you want on the image.`);

  let filled;
  try {
    filled = await fillFromPage({ original: instruction, understood, mode: input.mode, url, pageText: page.text });
  } catch (error) {
    logger.warn("Could not rewrite an edit instruction from the page", { error: failureText(error) });
    throw new Error(`Could not work out what to take from ${url} (${failureText(error)}).`);
  }
  if (!filled.found || !filled.instruction.trim()) {
    throw new Error(filled.problem.trim() || `The page at ${url} does not seem to contain what you asked for. Say which words or numbers to use, or point to another page.`);
  }
  return { instruction: filled.instruction.trim(), summary, usedPage: url, facts: filled.facts };
}
