import { cropBox, type ImageFormat } from "@/lib/creatives/formats";

// Kept apart from formats.ts, which client components import: sharp must never reach the browser bundle.
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
