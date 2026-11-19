import { generateObject } from "ai";
import { z } from "zod";
import { pickModel } from "@/lib/creatives/concept-writer";
import { IMAGE_FORMATS, parseImageFormat, type ImageFormat } from "@/lib/creatives/formats";
import { logger } from "@/lib/observability/logger";
import type { Direction, PrintLine } from "@/lib/creatives/directed/markers";

/** Most directions one chat message may carry; more than this is pointed to the bulk file. */
export const MAX_CHAT_DIRECTIONS = 5;

export type DetectionMode = "directed" | "open" | "variations" | "edit" | "unsure";

export type Detection = {
  mode: DetectionMode;
  directions: Direction[];
  format: ImageFormat | null;
  editInstruction: string | null;
  question: string | null;
  overflow: boolean;
};

const OPEN: Detection = { mode: "open", directions: [], format: null, editInstruction: null, question: null, overflow: false };

const schema = z.object({
  mode: z.enum(["directed", "open", "variations", "edit", "unsure"]),
  directions: z.array(
    z.object({
      picture: z.string().describe("The operator's picture instruction for ONE image, in their own words (tidy only spelling of filler like 'please')"),
      print: z
        .array(z.object({ role: z.string().nullable().describe("headline, sub-line, button, tagline… only if the operator named it, else null"), text: z.string().describe("The words to print, copied VERBATIM") }))
        .describe("The exact words to print on the image; empty when the operator gave none"),
    }),
  ),
  format: z.string().nullable().describe("Image shape if stated (4:5, 1:1, 9:16, 16:9, 1.91:1, reels, story, square…), else null"),
  edit_instruction: z.string().nullable().describe("For mode edit: the change to make, as the operator asked"),
  question: z.string().nullable().describe("For mode unsure: one short question that would settle it"),
});

export const DETECT_SYSTEM_PROMPT = [
  "You read one message an operator sent in an ad-workspace chat and decide whether it is an exact creative direction for an image.",
  "mode=directed: the message says what the image should show (a picture idea / scene / layout / style), with or without exact words to print. Return one direction per distinct image they describe, with the picture instruction and the words to print VERBATIM (never reworded, corrected, shortened or added to; keep capitals and punctuation). If the operator labels words (headline, button, sub-line) put the label in role.",
  "mode=open: any other request for ads or images, including a message that only supplies a headline or ad copy for the writer to build ideas around (a headline alone is open, not directed), questions, and anything unrelated to images.",
  "mode=variations: they ask for variations / more versions / alternatives of an image already made in this chat. mode=edit: they ask to change something about an image already made in this chat (put the change in edit_instruction). Use these two only if an image from a direction already exists in the chat (the prompt says whether it does).",
  "mode=unsure: it might be a direction but you cannot tell what to draw; give one short question.",
  `Never invent a picture instruction or any printed word the operator did not give. If a message contains more than ${MAX_CHAT_DIRECTIONS} directions, still return them all; the caller handles the limit.`,
  "Return ONE direction for one image. A message with a single direction that says 'give me 3 images of this' or 'make a few of these' is still one direction (extra versions are only made when the operator later asks for variations), never the same direction repeated.",
  "The brand colours and logo are always applied by the system; the operator's direction is only the visual idea, so never return anything about colours or logo placement as a separate field.",
].join("\n");

const clean = (s: string | null | undefined) => (s ?? "").trim();

/** A stated shape, or null when none was stated or it cannot be read (the chat's own default then applies). */
function readFormat(value: string | null): ImageFormat | null {
  const v = clean(value);
  if (!v) return null;
  if ((IMAGE_FORMATS as readonly string[]).includes(v)) return v as ImageFormat;
  // parseImageFormat answers 4:5 for anything it does not know, so only accept its answer when the text names a shape.
  return /reel|stor|vertical|9\s*[x:]\s*16|square|1\s*[x:]\s*1|1\.91|1,91|link ad|16\s*[:x]\s*9|landscape|wide|horizontal|4\s*[x:]\s*5|portrait|feed/i.test(v) ? parseImageFormat(v) : null;
}

/** What the model returned, made safe: blank pictures dropped, limits applied, impossible modes turned into open. */
export function normaliseDetection(rawValue: unknown, hasDirectedImage: boolean): Detection {
  const parsed = schema.safeParse(rawValue);
  if (!parsed.success) return OPEN;
  const raw = parsed.data;

  // The same direction twice ("give me 3 images of this") is one image: extras only come from asking for variations.
  const seen = new Set<string>();
  const directions: Direction[] = raw.directions
    .map((d) => {
      const print: PrintLine[] = d.print.filter((p) => clean(p.text)).map((p) => ({ role: clean(p.role) || null, text: p.text }));
      return { picture: clean(d.picture), print };
    })
    .filter((d) => d.picture)
    .filter((d) => {
      const key = JSON.stringify([d.picture, d.print]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  const format = readFormat(raw.format);
  const base = { directions: [] as Direction[], format, editInstruction: null as string | null, question: clean(raw.question) || null, overflow: false };

  switch (raw.mode) {
    case "directed": {
      if (raw.directions.length > MAX_CHAT_DIRECTIONS && directions.length > MAX_CHAT_DIRECTIONS) return { ...base, mode: "directed", overflow: true };
      if (!directions.length) return { ...base, mode: "unsure" };
      return { ...base, mode: "directed", directions };
    }
    case "variations":
      return hasDirectedImage ? { ...base, mode: "variations" } : OPEN;
    case "edit": {
      if (!hasDirectedImage) return OPEN;
      const instruction = clean(raw.edit_instruction);
      return instruction ? { ...base, mode: "edit", editInstruction: instruction } : { ...base, mode: "unsure" };
    }
    case "unsure":
      return { ...base, mode: "unsure" };
    default:
      return OPEN;
  }
}

/**
 * Decide, from the operator's own words, whether this message is an exact direction (and for what), a request
 * for variations of or an edit to an existing directed image, or anything else. Any failure, or no model
 * configured, means "open": the existing concept flow runs exactly as before.
 */
export async function detectDirection(
  input: { message: string; recent: string[]; hasDirectedImage: boolean },
  deps: { generate?: typeof generateObject } = {},
): Promise<Detection> {
  const model = pickModel();
  if (!model) return OPEN;
  const generate = deps.generate ?? generateObject;
  try {
    const { object } = await generate({
      model,
      schema,
      temperature: 0,
      system: DETECT_SYSTEM_PROMPT,
      prompt: [
        input.recent.length ? `Recent messages in this chat (oldest first):\n${input.recent.map((m) => `- ${m.slice(0, 500)}`).join("\n")}` : null,
        `An image made from an exact direction already exists in this chat: ${input.hasDirectedImage ? "yes" : "no"}.`,
        `The message to classify:\n${input.message.slice(0, 6000)}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    });
    return normaliseDetection(object, input.hasDirectedImage);
  } catch (error) {
    logger.warn("Direction detection failed; using the normal creative flow", { error: error instanceof Error ? error.message : String(error) });
    return OPEN;
  }
}
