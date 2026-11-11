/**
 * An operator's own style for a bulk run: reference images, a description in words, or both.
 *
 * Without one, a run draws a different catalogue style for every image (see styles.ts). With one,
 * the run follows the operator's taste instead:
 *  - "match all" on: every image is made in the reference style (each still gets its own idea);
 *  - otherwise: the first few follow the reference closely and the rest are variations of it, so
 *    the operator gets range that is still recognisably their taste.
 * The operator's words are firm rules in both cases and win over any assigned style.
 *
 * The image generator takes text only, so uploaded images are first read by a vision model and
 * written up as a style brief; the brief, not the picture, is what the generator is steered by.
 */
import { z } from "zod";
import { generateObject } from "ai";
import { logger } from "@/lib/observability/logger";
import { withModelFallback } from "@/lib/video/model-fallback";
import type { BulkAngle } from "@/lib/creatives/bulk/angles";
import { pickBulkStyles, REFERENCE_CLOSE_COUNT, STYLE_IMAGE_LIMIT, type BulkStyle } from "@/lib/creatives/bulk/styles";

export type StyleGuide = {
  /** What the uploaded images show, written up as a style brief. Null when none were uploaded. */
  imageBrief: string | null;
  /** The operator's own words: the look they want and any rules. */
  direction: string | null;
  /** True when every image in the run must follow the reference. */
  matchAll: boolean;
};

export function hasStyleGuide(guide?: StyleGuide | null): guide is StyleGuide {
  return Boolean(guide && (guide.imageBrief?.trim() || guide.direction?.trim()));
}

/** The reference, written once for the hook writer. */
export function referenceBlock(guide: StyleGuide): string {
  return [
    "REFERENCE STYLE (the look this operator wants; every style assignment below points back to it):",
    guide.imageBrief ? `What their reference image(s) show:\n${guide.imageBrief}` : null,
    guide.direction
      ? `The operator's own words (FIRM RULES: where they conflict with an assigned style or any default look, the operator's words win):\n${guide.direction.slice(0, 1500)}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
}

// ------------------------------------------------------------------ which image gets which style

/** The ways a variation can move away from the reference while staying in its family. */
export const VARIATION_AXES: Array<{ name: string; change: string }> = [
  { name: "new setting", change: "place the idea in a different real-world setting or backdrop from the reference." },
  { name: "closer crop", change: "frame much closer on one telling detail or the key part of the subject." },
  { name: "wider scene", change: "pull back to show a wider scene, with the subject smaller in the frame." },
  { name: "different subject", change: "apply the same treatment to a different subject or object that stands for the idea." },
  { name: "different layout", change: "arrange subject and words in a clearly different layout (off-centre, split or stacked)." },
  { name: "different angle", change: "shoot or draw it from a clearly different viewpoint (overhead, low, or side-on)." },
  { name: "colour shift", change: "let a different brand colour lead, keeping the same contrast and grade." },
  { name: "different moment", change: "show a different moment of the story: before, during or after." },
  { name: "different focus", change: "if the reference centres a person, centre an object instead, and the other way round." },
  { name: "stripped back", change: "strip it back: fewer elements, more empty space, one strong focal point." },
  { name: "richer scene", change: "make it richer: more layered elements and depth, still with one clear focal point." },
];

const REFERENCE_STYLE: BulkStyle = {
  key: "reference",
  name: "Reference style",
  family: "reference",
  fits: [],
  brief:
    "Follow the REFERENCE STYLE closely: its medium, lighting, composition habits, colour treatment, mood and graphic language. Only the idea, the subject and the words change.",
};

function variationStyle(axis: (typeof VARIATION_AXES)[number]): BulkStyle {
  return {
    key: `reference_${axis.name.replace(/\s+/g, "_")}`,
    name: `Reference variation, ${axis.name}`,
    family: "reference",
    fits: [],
    brief: `Clearly the same family as the REFERENCE STYLE (same medium, lighting, colour treatment, mood and graphic language), but ${axis.change}`,
  };
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** How many of `total` images follow the reference closely. */
export function closeMatchCount(total: number, matchAll: boolean): number {
  return matchAll ? total : Math.min(REFERENCE_CLOSE_COUNT, total);
}

/**
 * The style for each angle, by angle key. With no guide this is the usual catalogue draw. With one,
 * the first images follow the reference and the rest are variations that each move a different way
 * (different setting, crop, angle and so on), so they do not all repeat the same picture.
 */
export function assignStyles(angles: BulkAngle[], guide?: StyleGuide | null, random: () => number = Math.random): Map<string, BulkStyle> {
  if (!hasStyleGuide(guide)) return new Map(pickBulkStyles(angles, random).map((style, i) => [angles[i]!.key, style] as const));
  const close = closeMatchCount(angles.length, guide.matchAll);
  const axes = shuffled(VARIATION_AXES, random);
  return new Map(
    angles.map((angle, i) => [angle.key, i < close ? REFERENCE_STYLE : variationStyle(axes[(i - close) % axes.length]!)] as const),
  );
}

// ------------------------------------------------------------------ reading the uploaded images

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const STORED_MAX_SIDE = 1280;

/** Decode uploaded data URIs into JPEGs of a sane size. Throws a plain message for anything that is not a readable image. */
export async function prepareStyleImages(dataUris: string[]): Promise<Buffer[]> {
  const sharp = (await import("sharp")).default;
  const out: Buffer[] = [];
  for (const uri of dataUris.slice(0, STYLE_IMAGE_LIMIT)) {
    const match = /^data:image\/(?:png|jpe?g|webp);base64,([\s\S]+)$/i.exec(uri);
    if (!match) throw new Error("A reference image is not a JPG, PNG or WebP file.");
    const bytes = Buffer.from(match[1]!, "base64");
    if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES) throw new Error("A reference image is empty or too large (8 MB at most).");
    try {
      out.push(
        await sharp(bytes)
          .rotate()
          .resize({ width: STORED_MAX_SIDE, height: STORED_MAX_SIDE, fit: "inside", withoutEnlargement: true })
          .flatten({ background: "#ffffff" })
          .jpeg({ quality: 82 })
          .toBuffer(),
      );
    } catch {
      throw new Error("A reference image could not be read. Try a different JPG, PNG or WebP file.");
    }
  }
  return out;
}

/** Keep the prepared images where the background worker can read them. Returns their storage keys. */
export async function saveStyleImages(prefix: string, images: Buffer[]): Promise<string[]> {
  const { getObjectStorage } = await import("@/lib/storage/r2");
  const storage = getObjectStorage();
  const keys: string[] = [];
  for (const [i, image] of images.entries()) {
    const key = `creatives/style-references/${prefix}/image-${i + 1}.jpg`;
    await storage.put(key, image, "image/jpeg");
    keys.push(key);
  }
  return keys;
}

export async function loadStyleImages(keys: string[]): Promise<Buffer[]> {
  const { getObjectStorage } = await import("@/lib/storage/r2");
  const storage = getObjectStorage();
  const out: Buffer[] = [];
  for (const key of keys) {
    const bytes = await storage.get(key);
    if (bytes) out.push(bytes);
  }
  return out;
}

const styleSchema = z.object({
  medium: z.string().describe("What the pictures are made as: phone photo, studio photo, 3D render, flat illustration, collage, poster and so on, in one sentence"),
  composition: z.string().describe("How the frame is built: framing, where the subject sits, use of space, layout habits"),
  lighting: z.string().describe("Light and atmosphere: direction, softness, contrast, time of day, depth of field"),
  colour_treatment: z
    .string()
    .describe("How colour is handled: saturation, contrast, warm or cool, how restrained. Do NOT name exact brand hues; the advertiser's own brand colours are applied separately"),
  type_and_graphics: z.string().describe("How any words and graphic elements look: type weight and style, placement, shapes, badges, borders. Do not quote the words themselves"),
  mood: z.string().describe("The feeling it gives and the kind of audience it speaks to"),
  subject_matter: z.string().describe("The kind of subject it shows (people, objects, scenes) in general terms, never named brands or products"),
  signature: z.array(z.string()).min(2).max(6).describe("The traits that make this look recognisable. Every image in the same family must keep these"),
  flexible: z.array(z.string()).max(5).describe("What can change without losing the look: subject, setting, crop, colour emphasis"),
});

/** Write the reference images up as a style brief. With several images, what they share. */
export async function describeStyleImages(images: Buffer[]): Promise<string> {
  if (!images.length) throw new Error("There are no reference images to read.");
  const content: Array<{ type: "text"; text: string } | { type: "image"; image: Uint8Array; mediaType: string }> = [
    {
      type: "text",
      text: [
        `These ${images.length === 1 ? "is one reference image" : `are ${images.length} reference images`} an advertiser likes and wants new ads to look like.`,
        "Describe only HOW they are made, so a designer who cannot see them could recreate the look for a different business.",
        images.length > 1 ? "Describe what the images share; ignore what differs." : null,
        "Never name or copy a brand, logo, product, person or any readable words in them; describe those only as kinds (a bold headline, a product on a plinth).",
        "Be concrete and visual. Avoid vague words like 'modern' or 'clean' on their own.",
      ]
        .filter(Boolean)
        .join(" "),
    },
  ];
  images.forEach((bytes, i) => {
    if (images.length > 1) content.push({ type: "text", text: `Reference image ${i + 1}:` });
    content.push({ type: "image", image: new Uint8Array(bytes), mediaType: "image/jpeg" });
  });
  const object = await withModelFallback(
    async (model) => (await generateObject({ model, schema: styleSchema, temperature: 0.2, messages: [{ role: "user", content }] })).object,
  );
  return formatStyleBrief(object);
}

export function formatStyleBrief(s: z.infer<typeof styleSchema>): string {
  return [
    `Medium: ${s.medium}`,
    `Composition: ${s.composition}`,
    `Light: ${s.lighting}`,
    `Colour treatment: ${s.colour_treatment}`,
    `Type and graphics: ${s.type_and_graphics}`,
    `Mood: ${s.mood}`,
    `Typical subjects: ${s.subject_matter}`,
    `Signature traits (always keep): ${s.signature.join("; ")}`,
    s.flexible.length ? `Free to change: ${s.flexible.join("; ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function logStyleFailure(error: unknown): void {
  logger.warn("Bulk run: could not read the reference images", { error: error instanceof Error ? error.message : String(error) });
}
