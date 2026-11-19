import { generateObject } from "ai";
import { z } from "zod";
import { pickModel } from "@/lib/creatives/concept-writer";
import { extensionOf, extractDocumentText } from "@/lib/documents/extract-text";
import type { Direction, PrintLine } from "@/lib/creatives/directed/markers";

/** The most directions one bulk file may hold. A longer file is refused, never cut. */
export const MAX_DIRECTIONS = 30;

export type ParsedDirection = Direction & { unsure: boolean; note: string | null };

const MAX_FILE_CHARS = 80_000;
const TEXT_EXT = new Set([".txt"]);
const READER_EXT = new Set([".md", ".markdown", ".csv", ".docx", ".pdf", ".xlsx"]);

const parsedSchema = z.object({
  directions: z.array(
    z.object({
      picture: z.string().describe("The picture instruction for this one image, in the file's own words; empty string if the item gives none"),
      print: z.array(z.object({ role: z.string().nullable(), text: z.string() })).describe("The words to print on this image, copied VERBATIM from the file, one entry per line or element; empty if none"),
      no_logo: z.boolean(),
      unsure: z.boolean().describe("True if you could not tell where this item starts or ends, what the picture is, or which words are meant to be printed"),
      note: z.string().nullable().describe("Why you are unsure, in a few words, else null"),
    }),
  ),
});

export const PARSE_SYSTEM_PROMPT = [
  "You split a creative-directions file into one item per IMAGE, in the order they appear in the file.",
  "Each item has a picture instruction (what the image shows: scene, subject, style, layout, colours) and the exact words to print on the image (headline, sub-line, button and so on).",
  "Rules: one item per image, in file order. Never merge two images, drop one, reorder, or invent one. Copy every printed word VERBATIM (same capitals, spelling, punctuation and numbers): never reword, correct or shorten them. Never invent a picture instruction or any printed word.",
  "A header row, title, preamble or notes that are not an image are not items. A table row or numbered section is one item. If an item has words but no picture instruction, still return it with an empty picture and unsure=true.",
  "Mark unsure=true (with a short note) for any item you had to guess about. no_logo is true only if the file says that image has no logo.",
].join("\n");

const clean = (s: string | null | undefined) => (s ?? "").trim();

/** What the model returned, made safe: order kept, words untouched, only completely empty items dropped. */
export function normaliseParsed(rawValue: unknown): ParsedDirection[] {
  const parsed = parsedSchema.safeParse(rawValue);
  if (!parsed.success) return [];
  const out: ParsedDirection[] = [];
  for (const d of parsed.data.directions) {
    const print: PrintLine[] = d.print.filter((p) => clean(p.text)).map((p) => ({ role: clean(p.role) || null, text: p.text }));
    const picture = clean(d.picture);
    if (!picture && !print.length) continue;
    out.push({
      picture,
      print,
      ...(d.no_logo ? { noLogo: true } : {}),
      unsure: d.unsure || !picture,
      note: clean(d.note) || (picture ? null : "No clear picture instruction was found for this one."),
    });
  }
  return out;
}

async function textOf(file: { name: string; bytes: Buffer }): Promise<string> {
  const ext = extensionOf(file.name);
  if (TEXT_EXT.has(ext)) return file.bytes.toString("utf8");
  if (!READER_EXT.has(ext)) throw new Error("That file type isn't supported. Use txt, md, csv, docx, pdf or xlsx.");
  return (await extractDocumentText({ filename: file.name, buffer: file.bytes })).text;
}

/**
 * Read a directions file into one item per direction, in order. The operator confirms (and can edit) the list
 * before anything renders, so unsure items are flagged, not guessed away. A file with more directions than a
 * run allows is refused with a message, never truncated.
 */
export async function parseDirectionsFile(file: { name: string; bytes: Buffer }, deps: { generate?: typeof generateObject } = {}): Promise<ParsedDirection[]> {
  const text = (await textOf(file)).trim();
  if (!text) throw new Error("The file has no readable text.");
  const model = pickModel();
  if (!model) throw new Error("A language model isn't configured, so the file can't be read into directions.");

  const { object } = await (deps.generate ?? generateObject)({
    model,
    schema: parsedSchema,
    temperature: 0,
    maxOutputTokens: 16000,
    system: PARSE_SYSTEM_PROMPT,
    prompt: `The file "${file.name}":\n\n${text.slice(0, MAX_FILE_CHARS)}`,
  });
  const items = normaliseParsed(object);
  if (!items.length) throw new Error("I couldn't find any directions in that file. Each image needs a picture instruction and, if you want words on it, the words to print.");
  if (items.length > MAX_DIRECTIONS) throw new Error(`This file has ${items.length} directions; the most for one run is ${MAX_DIRECTIONS}. Split it and upload the parts.`);
  return items;
}
