/**
 * Turning "use the stats from the landing page" into an instruction an image model can follow.
 *
 * The image model cannot open a web page, so an edit instruction that points at the page (or at a
 * link the operator pasted) used to reach it as words it could not act on, and nothing changed. This
 * step reads the page, finds what the operator pointed at, and rewrites the instruction with the
 * real words and numbers copied in, so the image editor is only ever told what to print and where.
 * Facts come from the page only: if the page does not hold what was asked for, the edit stops with
 * a plain explanation instead of the image model making something up.
 */
import { z } from "zod";
import { generateObject } from "ai";
import { logger } from "@/lib/observability/logger";
import { withModelFallback } from "@/lib/video/model-fallback";

/** Most page text given to the model. Long enough for a full landing page. */
export const PAGE_CHARS = 30_000;
const CACHE_MS = 10 * 60 * 1000;

/** Words that suggest the instruction leans on a web page. Cheap gate so plain edits cost nothing extra. */
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

type Fetched = { at: number; text: string; readable: boolean };
const cache = new Map<string, Fetched>();

/** Page text without image lines and link targets (a landing page can carry dozens of logo images). */
export function cleanPageText(markdown: string): string {
  return markdown
    .split("\n")
    .filter((line) => !/^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(line))
    .map((line) => line.replace(/\]\((?:https?:\/\/|#|\/)[^)]*\)/g, "]"))
    .filter((line) => line.trim())
    .join("\n");
}

async function readPage(url: string): Promise<Fetched> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;
  const { scrapeWebsiteServices } = await import("@/lib/scraping/firecrawl");
  const scraped = await scrapeWebsiteServices(url, { extractServices: false, maxChars: PAGE_CHARS * 2 });
  const text = cleanPageText(scraped.markdown ?? "").slice(0, PAGE_CHARS);
  const readable = scraped.source !== "heuristic" && text.length > 80;
  const out = { at: Date.now(), text, readable };
  if (readable) cache.set(url, out);
  return out;
}

export function clearPageCache(): void {
  cache.clear();
}

const resolveSchema = z.object({
  needs_page: z
    .boolean()
    .describe("False when the instruction is a purely visual change that asks for nothing from a web page (colours, layout, removing or moving things, wording the operator typed themselves)."),
  found: z.boolean().describe("When needs_page is true: true only if the page really contains what the operator asked for."),
  instruction: z
    .string()
    .describe("The operator's request rewritten as one self-contained instruction for an image editor, with the exact words, numbers and facts copied from the page. Never mention 'the page'."),
  facts: z.array(z.string()).max(12).describe("The exact snippets of the page you used, verbatim."),
  problem: z.string().describe("When found is false: one plain sentence on what the page does not contain. Otherwise an empty string."),
});

export type ResolvedInstruction = {
  /** What to send to the image model. The operator's own text when nothing was needed from a page. */
  instruction: string;
  /** The page text used, when a page was read. */
  usedPage: string | null;
  facts: string[];
};

function printedText(direction: string | null | undefined): string {
  return direction?.match(/ON-IMAGE TEXT[^:]*:\s*([^\n]+)/)?.[1]?.trim() ?? "";
}

/**
 * Resolve an edit instruction against the landing page (or a link in the instruction). Returns the
 * instruction unchanged when it does not lean on a page. Throws, with a message fit to show the
 * operator, when the page cannot be read or does not hold what they asked for.
 */
export async function resolveEditInstruction(input: {
  instruction: string;
  mode: "edit" | "full";
  landingPageUrl?: string | null;
  headline?: string | null;
  primaryText?: string | null;
  creativeDirection?: string | null;
}): Promise<ResolvedInstruction> {
  const instruction = input.instruction.trim();
  const own = (): ResolvedInstruction => ({ instruction, usedPage: null, facts: [] });
  if (!mayNeedPage(instruction)) return own();

  const url = urlInInstruction(instruction) ?? input.landingPageUrl ?? null;
  if (!url) {
    // Nothing to read. A request that obviously points at a page gets told why; anything else is just a normal edit.
    if (/\b(landing\s?page|web\s?page|website|the\s+page|the\s+site)\b/i.test(instruction)) {
      throw new Error("This image has no landing page to read from. Paste the page's link in your instruction and try again.");
    }
    return own();
  }

  let page: Fetched;
  try {
    page = await readPage(url);
  } catch (error) {
    throw new Error(`Could not open ${url} to read it (${error instanceof Error ? error.message : String(error)}).`);
  }
  if (!page.readable) throw new Error(`Could not read any text from ${url}. Check the link opens, or type the words you want on the image.`);

  const printed = printedText(input.creativeDirection);
  let object: z.infer<typeof resolveSchema>;
  try {
    object = await withModelFallback(
      async (model) =>
        (
          await generateObject({
            model,
            schema: resolveSchema,
            temperature: 0.1,
            system:
              "You prepare edit instructions for an image editor that can only see the image, never a web page. You work only from facts that are written on the page text you are given. You never invent numbers, names, customers, results or claims.",
            prompt: [
              `The operator's request about one ad image:\n"${instruction}"`,
              `\nThe ad as it is now: headline "${input.headline ?? ""}"${printed ? `; printed on the image: ${printed}` : ""}.`,
              input.primaryText ? `Ad copy: ${input.primaryText.slice(0, 500)}` : null,
              `\nPage text (${url}):\n${page.text}`,
              "\nDecide what the operator wants from the page and rewrite the request as ONE self-contained instruction the image editor can act on.",
              "Copy numbers, names and wording exactly as the page writes them (keep symbols such as $, + and %). Say exactly which element on the image shows which words. Keep every printed item short enough to read at a glance: a figure plus a 2-4 word label for stats, a short line for a quote.",
              "Use at most the number of items the operator asked for; if they gave no number, pick the 3 strongest, most credible ones. Prefer real results and numbers over slogans.",
              input.mode === "edit"
                ? "The editor will change ONLY what you describe and keep the rest of the image, so name the element to change and the exact words to print; do not ask for a new concept."
                : "The whole image will be redrawn from its brief with your rewritten instruction as the operator's feedback, so keep anything the operator said about the concept or style, and add the exact page words to show.",
              "If part of the request is not about the page (a colour, a layout, a different concept), keep that part in the instruction as the operator wrote it.",
              "If the page does not contain what the operator asked for, set found to false and say what is missing; do not substitute something else.",
            ]
              .filter(Boolean)
              .join("\n"),
          })
        ).object,
    );
  } catch (error) {
    logger.warn("Could not rewrite an edit instruction from the page", { error: error instanceof Error ? error.message : String(error) });
    throw new Error(`Could not work out what to take from ${url} (${error instanceof Error ? error.message : String(error)}).`);
  }

  if (!object.needs_page) return own();
  if (!object.found || !object.instruction.trim()) {
    throw new Error(object.problem.trim() || `The page at ${url} does not seem to contain what you asked for. Say which words or numbers to use, or point to another page.`);
  }
  return { instruction: object.instruction.trim(), usedPage: url, facts: object.facts };
}
