/**
 * Keeping the ad copy true to an edited image.
 *
 * When one image of a bulk run is edited, the post's headline, primary text and description were
 * written for the image as it was. A new on-image headline, new stats, a different concept or a new
 * offer leave the copy saying something the picture no longer says. So after every edit a language
 * model looks at the NEW image next to the current copy and rewrites only what no longer fits,
 * keeping the copy's substance, facts and voice. Copy that still matches is left exactly as it is.
 * The same look also reads back the words now printed on the image, so the art direction's
 * ON-IMAGE TEXT line (used by the export and by later edits and regenerations) stays true.
 */
import { z } from "zod";
import { generateObject } from "ai";
import { withModelFallback } from "@/lib/video/model-fallback";
import { onImageTextLine } from "@/lib/creatives/concept-writer";

export type AdCopy = { headline: string; primary_text: string; description: string | null };

export type OnImageText = { headline: string; highlights: string[]; cta_label: string };

export type RealignedCopy = AdCopy & {
  /** The words printed on the edited image, read off it. Null when none could be read. */
  onImage: OnImageText | null;
  /** False when the copy already matched the image and was left as it was. */
  changed: boolean;
  /** One short plain line for the operator on what changed in the copy. Empty when nothing did. */
  note: string;
};

const schema = z.object({
  matches: z
    .boolean()
    .describe("True when the current copy already fits the edited image: same message, same offer, same facts and numbers, nothing that contradicts or ignores what the image now says. Then the copy is kept as it is."),
  headline: z.string().describe("The post headline, under 40 characters. Exactly the current one when it still fits."),
  primary_text: z
    .string()
    .describe("The primary text, 45-90 words. Exactly the current one when it still fits; otherwise the current text reworked so it opens on and supports what the image now says, keeping its substance, facts and voice."),
  description: z.string().describe("The link description, under 30 characters, or an empty string when there is none and none is needed. Exactly the current one when it still fits."),
  on_image: z
    .object({
      headline: z.string().describe("The main headline printed on the image, spelled exactly as it appears. Empty if there is none."),
      highlights: z.array(z.string()).max(3).describe("The small labels, chips or accent words printed on the image, exactly as they appear (0-3)."),
      cta_label: z.string().describe("The words on the call-to-action button printed on the image, exactly as they appear. Empty if there is none."),
    })
    .describe("The words printed on the edited image, read off it exactly. Do not include the logo or the brand name."),
  note: z.string().describe("When the copy changed: one short plain sentence on what changed and why (e.g. 'Headline and opening line now lead with the 1,500+ businesses stat shown on the image'). Empty when it matches."),
});

export function buildRealignPrompt(input: {
  instruction: string;
  understood: string;
  copy: AdCopy;
  brandName?: string | null;
  facts?: string[];
}): string {
  return [
    `An ad image was just edited. The operator asked: "${input.instruction}"`,
    `What was changed on the image: ${input.understood}`,
    input.brandName ? `Brand: ${input.brandName}` : null,
    input.facts?.length ? `Facts taken from the landing page for this edit (usable in the copy, word for word): ${input.facts.map((f) => `"${f}"`).join("; ")}` : null,
    "The edited image is attached.",
    `\nThe ad's current copy:\nHeadline: ${input.copy.headline}\nPrimary text: ${input.copy.primary_text}\nDescription: ${input.copy.description ?? "(none)"}`,
    "\nThe copy runs next to this image in the feed, so the two must tell one story: the copy should pick up the message, offer, numbers and promise the image now shows, and must never contradict it (old stats, an old offer, a headline about something no longer on the image).",
    "If the copy still fits, set matches to true and return it exactly as it is. Otherwise change only what no longer fits: keep everything that is still true, the facts, the call to action and the voice. Never invent numbers, prices, customers, results or claims; use only what is in the current copy, on the image, or in the facts above.",
  ]
    .filter(Boolean)
    .join("\n");
}

async function imagePart(image: Buffer): Promise<{ type: "image"; image: Uint8Array; mediaType: string }> {
  const sharp = (await import("sharp")).default;
  const small = await sharp(image).resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
  return { type: "image", image: new Uint8Array(small), mediaType: "image/jpeg" };
}

/** Read the edited image and return the copy that matches it. Throws when the model cannot be reached. */
export async function realignCopy(input: {
  image: Buffer;
  instruction: string;
  understood: string;
  copy: AdCopy;
  brandName?: string | null;
  facts?: string[];
}): Promise<RealignedCopy> {
  const picture = await imagePart(input.image);
  const out = await withModelFallback(
    async (model) =>
      (
        await generateObject({
          model,
          schema,
          temperature: 0.3,
          system: "You are the copywriter who keeps a Meta ad's copy in step with its image. You change as little as needed, keep the brand voice, and never invent facts, numbers, results or claims.",
          messages: [{ role: "user", content: [{ type: "text", text: buildRealignPrompt(input) }, picture] }],
        })
      ).object,
  );

  const headline = out.headline.trim();
  const primary = out.primary_text.trim();
  const printed = out.on_image.headline.trim()
    ? { headline: out.on_image.headline.trim(), highlights: out.on_image.highlights.map((h) => h.trim()).filter(Boolean), cta_label: out.on_image.cta_label.trim() }
    : null;
  if (out.matches || !headline || !primary) return { ...input.copy, onImage: printed, changed: false, note: "" };
  const description = out.description.trim() || null;
  const changed = headline !== input.copy.headline || primary !== input.copy.primary_text || description !== (input.copy.description ?? null);
  return { headline, primary_text: primary, description, onImage: printed, changed, note: changed ? out.note.trim() || "Ad copy updated to match the image." : "" };
}

/**
 * The art direction with its ON-IMAGE TEXT line replaced by what is now printed. Only an existing
 * line is replaced (drafts without one never had their words fixed); everything else, markers
 * included, stays exactly where it was.
 */
export function replaceOnImageText(direction: string | null, text: OnImageText | null): string | null {
  if (!direction || !text) return direction;
  const lines = direction.split("\n");
  const at = lines.findIndex((l) => l.trim().startsWith("ON-IMAGE TEXT"));
  if (at < 0) return direction;
  lines[at] = onImageTextLine(text);
  return lines.join("\n");
}
