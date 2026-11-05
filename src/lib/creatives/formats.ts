/**
 * Ad image shapes. 4:5 fills the most of a feed; 9:16 fills Reels and
 * Stories. The image model renders each shape natively (1024×1280, 864×1536)
 * so the composition is made for the real frame; a 2:3 render that is
 * centre-cropped to the ratio is the fallback for models that refuse the size.
 */
export const IMAGE_FORMATS = ["1:1", "4:5", "9:16", "16:9", "1.91:1"] as const;
export type ImageFormat = (typeof IMAGE_FORMATS)[number];

const RATIO: Record<ImageFormat, number> = {
  "1:1": 1,
  "4:5": 4 / 5,
  "9:16": 9 / 16,
  "16:9": 16 / 9,
  "1.91:1": 1.91,
};

/**
 * What the picker shows. The image model takes any size whose edges are multiples of 16, with a
 * ratio of at most 3:1 and between roughly 0.65 and 8.3 megapixels, so every shape here is
 * rendered natively.
 */
export const IMAGE_FORMAT_OPTIONS: Array<{ value: ImageFormat; label: string; use: string }> = [
  { value: "4:5", label: "4:5 Portrait", use: "Facebook & Instagram feed (fills the most screen)" },
  { value: "1:1", label: "1:1 Square", use: "Feed, carousels, Marketplace" },
  { value: "9:16", label: "9:16 Vertical", use: "Reels, Stories" },
  { value: "16:9", label: "16:9 Landscape", use: "Video-style feed, in-stream, display" },
  { value: "1.91:1", label: "1.91:1 Wide", use: "Link ads, Audience Network" },
];

/** "reels" / "stories" / "vertical" → 9:16, "square" → 1:1; anything else → 4:5 (feed). */
export function parseImageFormat(value: unknown): ImageFormat {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  if ((IMAGE_FORMATS as readonly string[]).includes(v)) return v as ImageFormat;
  if (/reel|stor|vertical|9x16/.test(v)) return "9:16";
  if (/square|1x1/.test(v)) return "1:1";
  if (/1\.91|1,91|link ad/.test(v)) return "1.91:1";
  if (/16\s*[:x]\s*9|landscape|wide|horizontal/.test(v)) return "16:9";
  return "4:5";
}

export type GenerationSize =
  | "1024x1024"
  | "1024x1280"
  | "864x1536"
  | "1024x1536"
  | "1536x864"
  | "1824x960"
  | "1536x1024";

/** The size that is exactly the format's shape, so nothing important is ever cropped away. */
export function generationSize(format: ImageFormat): GenerationSize {
  if (format === "4:5") return "1024x1280";
  if (format === "9:16") return "864x1536";
  if (format === "16:9") return "1536x864";
  if (format === "1.91:1") return "1824x960";
  return "1024x1024";
}

/** Rendered 2:3 and centre-cropped: for image models that do not take the exact size. */
export const FALLBACK_SIZE: GenerationSize = "1024x1536";

/** The same fallback for the wide shapes: rendered 3:2 and cropped. */
export function fallbackSizeFor(format?: ImageFormat): GenerationSize {
  return format === "16:9" || format === "1.91:1" ? "1536x1024" : FALLBACK_SIZE;
}

/** The format a draft was made in, kept as a line in its art direction so reworks keep the shape. */
const ASPECT_MARKER = /^ASPECT: (\S+)$/m;

export function withAspectMarker(direction: string | null | undefined, format: ImageFormat): string {
  return [stripAspectMarker(direction), `ASPECT: ${format}`].filter(Boolean).join("\n");
}

export function stripAspectMarker(direction: string | null | undefined): string {
  return (direction ?? "")
    .split("\n")
    .filter((line) => !/^ASPECT: \S+$/.test(line.trim()))
    .join("\n")
    .trim();
}

export function readAspectMarker(direction: string | null | undefined): ImageFormat | null {
  const found = direction?.match(ASPECT_MARKER)?.[1];
  return found && (IMAGE_FORMATS as readonly string[]).includes(found) ? (found as ImageFormat) : null;
}

/** The largest centred box of the format's ratio inside width × height. */
export function cropBox(format: ImageFormat, width: number, height: number) {
  const ratio = RATIO[format];
  const fitWidth = Math.min(width, Math.round(height * ratio));
  const fitHeight = Math.min(height, Math.round(fitWidth / ratio));
  return {
    left: Math.floor((width - fitWidth) / 2),
    top: Math.floor((height - fitHeight) / 2),
    width: fitWidth,
    height: fitHeight,
  };
}

/** The composition rule for the image prompt. */
export function formatPromptRule(format: ImageFormat): string {
  const noDense = "No watermarks, no dense paragraphs of text on the image.";
  if (format === "9:16") {
    return `Vertical 9:16 composition for Instagram/Facebook Reels and Stories. Keep every word, the button and every key element at least 8% of the width away from the left and right edges, and nothing may touch any edge. Keep all text, the logo area and the product out of the top 14% and the bottom 35% of the frame — Meta overlays the account name, caption and buttons there. ${noDense}`;
  }
  if (format === "4:5") {
    return `Vertical 4:5 composition for the Instagram/Facebook feed. Keep every word, the call-to-action button and every key element at least 7% of the height away from the top and bottom edges and 7% of the width away from the sides; nothing may touch or run off an edge, and the whole button and every chip must be fully visible inside the frame. This safe margin overrides any position written in the art direction. ${noDense}`;
  }
  if (format === "16:9" || format === "1.91:1") {
    return `Horizontal ${format} composition for a wide feed, link-ad or in-stream placement. Use the width: headline and button on one side, the subject on the other, with the calm logo area in a corner. Keep every word, the button and every key element at least 6% of the height from the top and bottom and 5% of the width from the sides; nothing may touch or run off an edge. ${noDense}`;
  }
  return `Square 1:1 composition for Instagram feed. Keep every word, the button and every key element at least 6% away from every edge. ${noDense}`;
}
