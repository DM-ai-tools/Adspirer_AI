import path from "node:path";
import { splitStat } from "@/lib/video/captions";

/**
 * The things drawn over the video, as transparent PNGs: captions, a big stat, an uploaded image and
 * the logo. Text is set with Pango from a bundled font, so it looks the same on any server. The logo
 * and uploaded images are the real pixels, only scaled.
 */

const FONT_BOLD = path.join(process.cwd(), "public", "fonts", "Inter-Bold.ttf");
const FONT_SEMI = path.join(process.cwd(), "public", "fonts", "Inter-SemiBold.ttf");

export type Piece = { png: Buffer; width: number; height: number };

async function sharpLib() {
  return (await import("sharp")).default;
}

/** Text as a transparent image. `markup` is Pango markup (spans with a foreground colour). */
async function text(markup: string, options: { size: number; width: number; bold?: boolean }): Promise<Piece> {
  const sharp = await sharpLib();
  const png = await sharp({
    text: {
      text: markup,
      font: `Inter ${options.bold === false ? "SemiBold" : "Bold"} ${options.size}`,
      fontfile: options.bold === false ? FONT_SEMI : FONT_BOLD,
      rgba: true,
      width: options.width,
      align: "center",
      spacing: 4,
    },
  })
    .png()
    .toBuffer();
  const meta = await sharp(png).metadata();
  return { png, width: meta.width ?? options.width, height: meta.height ?? options.size };
}

function roundRect(width: number, height: number, radius: number, fill: string, opacity = 1, stroke?: { colour: string; width: number }): Buffer {
  const s = stroke ? `stroke="${stroke.colour}" stroke-width="${stroke.width}"` : "";
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect x="${stroke ? stroke.width / 2 : 0}" y="${stroke ? stroke.width / 2 : 0}" width="${width - (stroke ? stroke.width : 0)}" height="${height - (stroke ? stroke.width : 0)}" rx="${radius}" fill="${fill}" fill-opacity="${opacity}" ${s}/></svg>`,
  );
}

/** A dark rounded panel with the given pieces centred on it. */
async function onPanel(parts: Array<{ piece: Piece; gap: number }>, options: { width: number; padX: number; padY: number; radius: number; fill: string; opacity: number; stroke?: { colour: string; width: number } }): Promise<Piece> {
  const sharp = await sharpLib();
  const inner = parts.reduce((t, p) => t + p.piece.height + p.gap, 0) - (parts.length ? parts[parts.length - 1]!.gap : 0);
  const width = Math.max(options.width, Math.max(...parts.map((p) => p.piece.width)) + options.padX * 2);
  const height = inner + options.padY * 2;
  let y = options.padY;
  const layers = parts.map((p) => {
    const layer = { input: p.piece.png, left: Math.round((width - p.piece.width) / 2), top: Math.round(y) };
    y += p.piece.height + p.gap;
    return layer;
  });
  const png = await sharp(roundRect(width, height, options.radius, options.fill, options.opacity, options.stroke)).composite(layers).png().toBuffer();
  return { png, width, height };
}

/** One caption phrase on a soft dark pill so it reads over any footage. */
export async function captionPiece(markup: string, frameWidth: number): Promise<Piece> {
  const t = await text(markup, { size: Math.round(frameWidth * 0.058), width: Math.round(frameWidth * 0.8) });
  return onPanel([{ piece: t, gap: 0 }], { width: 0, padX: Math.round(frameWidth * 0.035), padY: Math.round(frameWidth * 0.02), radius: Math.round(frameWidth * 0.03), fill: "#000000", opacity: 0.55 });
}

/** A big number with its label, on a card with an accent edge. */
export async function statPiece(stat: string, frameWidth: number, accent: string): Promise<Piece> {
  const { value, label } = splitStat(stat);
  const big = await text(`<span foreground="${accent}">${esc(value)}</span>`, { size: Math.round(frameWidth * 0.115), width: Math.round(frameWidth * 0.74) });
  const parts: Array<{ piece: Piece; gap: number }> = [{ piece: big, gap: Math.round(frameWidth * 0.008) }];
  if (label) parts.push({ piece: await text(`<span foreground="#FFFFFF">${esc(label)}</span>`, { size: Math.round(frameWidth * 0.04), width: Math.round(frameWidth * 0.74), bold: false }), gap: 0 });
  return onPanel(parts, { width: Math.round(frameWidth * 0.5), padX: Math.round(frameWidth * 0.05), padY: Math.round(frameWidth * 0.028), radius: Math.round(frameWidth * 0.04), fill: "#0B0F14", opacity: 0.82, stroke: { colour: accent, width: 5 } });
}

/** An uploaded image, scaled to fit, with rounded corners and a white edge. Never redrawn. */
export async function imagePiece(source: Buffer, maxWidth: number, maxHeight: number): Promise<Piece> {
  const sharp = await sharpLib();
  const border = 8;
  const scaled = await sharp(source).rotate().resize({ width: maxWidth - border * 2, height: maxHeight - border * 2, fit: "inside", withoutEnlargement: false }).png().toBuffer({ resolveWithObject: true });
  const w = scaled.info.width + border * 2;
  const h = scaled.info.height + border * 2;
  const radius = Math.round(Math.min(w, h) * 0.04);
  const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${scaled.info.width}" height="${scaled.info.height}"><rect width="100%" height="100%" rx="${radius}"/></svg>`);
  const rounded = await sharp(scaled.data).composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
  const png = await sharp(roundRect(w, h, radius + 4, "#FFFFFF", 1)).composite([{ input: rounded, left: border, top: border }]).png().toBuffer();
  return { png, width: w, height: h };
}

/** The logo on a white rounded badge, so it reads over any footage. The logo is the real file, only scaled. */
export async function logoPiece(logoPng: Buffer, frameWidth: number, widthFraction: number): Promise<Piece> {
  const sharp = await sharpLib();
  const target = Math.round(frameWidth * widthFraction);
  const padX = Math.round(target * 0.12);
  const padY = Math.round(target * 0.09);
  const inner = await sharp(logoPng).resize({ width: target - padX * 2, height: Math.round(target * 0.4), fit: "inside" }).png().toBuffer({ resolveWithObject: true });
  const w = inner.info.width + padX * 2;
  const h = inner.info.height + padY * 2;
  const png = await sharp(roundRect(w, h, Math.round(h * 0.28), "#FFFFFF", 0.94)).composite([{ input: inner.data, left: padX, top: padY }]).png().toBuffer();
  return { png, width: w, height: h };
}

/** The closing card: brand colour, the logo big on a white card, and the call to action as a button. */
export async function endCardPng(width: number, height: number, options: { background: string; accent: string; logoPng: Buffer | null; brandName: string; cta: string }): Promise<Buffer> {
  const sharp = await sharpLib();
  const layers: Array<{ input: Buffer; left: number; top: number }> = [];
  let y = Math.round(height * 0.3);
  if (options.logoPng) {
    const logo = await logoPiece(options.logoPng, width, 0.62);
    layers.push({ input: logo.png, left: Math.round((width - logo.width) / 2), top: y });
    y += logo.height + Math.round(height * 0.06);
  } else {
    const name = await text(`<span foreground="#FFFFFF">${esc(options.brandName)}</span>`, { size: Math.round(width * 0.09), width: Math.round(width * 0.8) });
    layers.push({ input: name.png, left: Math.round((width - name.width) / 2), top: y });
    y += name.height + Math.round(height * 0.06);
  }
  if (options.cta) {
    const label = await text(`<span foreground="#101820">${esc(options.cta)}</span>`, { size: Math.round(width * 0.05), width: Math.round(width * 0.6) });
    const button = await onPanel([{ piece: label, gap: 0 }], { width: Math.round(width * 0.44), padX: Math.round(width * 0.06), padY: Math.round(width * 0.025), radius: Math.round(width * 0.04), fill: options.accent, opacity: 1 });
    layers.push({ input: button.png, left: Math.round((width - button.width) / 2), top: y });
  }
  return sharp({ create: { width, height, channels: 4, background: options.background } }).composite(layers).png().toBuffer();
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
