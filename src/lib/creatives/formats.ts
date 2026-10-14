/**
 * Ad image shapes. 4:5 fills the most of a feed; 9:16 fills Reels and
 * Stories. The image model renders square or 2:3 portrait, so portrait
 * formats are rendered at 1024×1536 and centre-cropped to the exact ratio.
 */
export const IMAGE_FORMATS = ["1:1", "4:5", "9:16"] as const;
export type ImageFormat = (typeof IMAGE_FORMATS)[number];

const RATIO: Record<ImageFormat, number> = { "1:1": 1, "4:5": 4 / 5, "9:16": 9 / 16 };

/** "reels" / "stories" / "vertical" → 9:16, "square" → 1:1; anything else → 4:5 (feed). */
export function parseImageFormat(value: unknown): ImageFormat {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  if ((IMAGE_FORMATS as readonly string[]).includes(v)) return v as ImageFormat;
  if (/reel|stor|vertical|9x16/.test(v)) return "9:16";
  if (/square|1x1/.test(v)) return "1:1";
  return "4:5";
}

export function generationSize(format: ImageFormat): "1024x1024" | "1024x1536" {
  return format === "1:1" ? "1024x1024" : "1024x1536";
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

/** Crop a base64 image to the format (PNG out). */
export async function cropToFormat(b64: string, format: ImageFormat): Promise<string> {
  const sharp = (await import("sharp")).default;
  const input = Buffer.from(b64, "base64");
  const meta = await sharp(input).metadata();
  if (!meta.width || !meta.height) return b64;
  const box = cropBox(format, meta.width, meta.height);
  if (box.width === meta.width && box.height === meta.height) return b64;
  const out = await sharp(input).extract(box).png().toBuffer();
  return out.toString("base64");
}

/** The composition rule for the image prompt. */
export function formatPromptRule(format: ImageFormat): string {
  if (format === "9:16") {
    return "Vertical 9:16 composition for Instagram/Facebook Reels and Stories. Keep all text, the logo area and the product out of the top 14% and the bottom 35% of the frame — Meta overlays the account name, caption and buttons there. No watermarks, no dense paragraphs of text on the image.";
  }
  if (format === "4:5") {
    return "Vertical 4:5 composition for the Instagram/Facebook feed, subject centred with breathing room at the edges. No watermarks, no dense paragraphs of text on the image.";
  }
  return "Square 1:1 composition for Instagram feed. No watermarks, no dense paragraphs of text on the image.";
}
