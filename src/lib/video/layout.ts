/**
 * Where things go on the finished video. Reels and Stories cover the top 14% (account name) and the
 * bottom 35% (caption and buttons), so everything that must be read stays between them. Pure.
 */

export type FinalFormat = "9:16" | "4:5" | "1:1";

export function finalSize(format: FinalFormat): { width: number; height: number } {
  if (format === "4:5") return { width: 1080, height: 1350 };
  if (format === "1:1") return { width: 1080, height: 1080 };
  return { width: 1080, height: 1920 };
}

export type Layout = {
  /** Vertical centres as fractions of the height. */
  captionY: number;
  statY: number;
  imageY: number;
  imageMaxW: number;
  imageMaxH: number;
  logo: { x: number; y: number; width: number };
  /** The band that must stay free of anything that matters, as fractions of the height. */
  safe: { top: number; bottom: number };
};

export function layoutFor(format: FinalFormat): Layout {
  if (format === "9:16") {
    return { captionY: 0.605, statY: 0.255, imageY: 0.44, imageMaxW: 0.84, imageMaxH: 0.23, logo: { x: 0.05, y: 0.15, width: 0.2 }, safe: { top: 0.14, bottom: 0.35 } };
  }
  if (format === "4:5") {
    return { captionY: 0.8, statY: 0.2, imageY: 0.47, imageMaxW: 0.8, imageMaxH: 0.3, logo: { x: 0.05, y: 0.04, width: 0.22 }, safe: { top: 0.06, bottom: 0.06 } };
  }
  return { captionY: 0.8, statY: 0.2, imageY: 0.47, imageMaxW: 0.8, imageMaxH: 0.32, logo: { x: 0.05, y: 0.04, width: 0.22 }, safe: { top: 0.06, bottom: 0.06 } };
}

/** True when a box of this height, centred at this fraction, stays out of the covered bands. */
export function insideSafeZone(layout: Layout, centreY: number, heightFraction: number): boolean {
  const top = centreY - heightFraction / 2;
  const bottom = centreY + heightFraction / 2;
  return top >= layout.safe.top && bottom <= 1 - layout.safe.bottom;
}

/** The brand colour to highlight words with: a vivid one that reads on a dark pill, else a warm yellow. */
export function accentColour(colours: string[] | null | undefined): string {
  for (const c of colours ?? []) {
    const m = c.trim().match(/^#?([0-9a-f]{6})$/i);
    if (!m) continue;
    const n = parseInt(m[1]!, 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const sat = Math.max(r, g, b) - Math.min(r, g, b);
    if (lum > 95 && sat > 60) return `#${m[1]!.toUpperCase()}`;
  }
  return "#FFD84D";
}

/** A dark or brand-coloured background for the end card. */
export function endCardBackground(colours: string[] | null | undefined): string {
  for (const c of colours ?? []) {
    const m = c.trim().match(/^#?([0-9a-f]{6})$/i);
    if (!m) continue;
    const n = parseInt(m[1]!, 16);
    const lum = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
    if (lum < 150) return `#${m[1]!.toUpperCase()}`;
  }
  return "#101820";
}
