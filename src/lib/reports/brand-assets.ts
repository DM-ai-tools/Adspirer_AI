import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Traffic Radius brand for every exported report (PDF, Word, HTML, Excel). Server-only: it reads
 * the logo files. The colours are in `REPORT_THEME` (template.ts), which is safe anywhere.
 *
 * The logo is the original file from trafficradius.com.au (wp-content/uploads/2024/06/
 * Traffic-Radius-Logo.png), trimmed of its transparent margin and capped at 1200 px wide. The mark
 * is the three bars cut from that same file. Both have dark lettering on transparent, so they are
 * always placed on white.
 */
export const BRAND = {
  name: "Traffic Radius",
  site: "trafficradius.com.au",
  url: "https://trafficradius.com.au",
  tagline: "Growing Your Business the Smart Way!",
  /** Width ÷ height of each file, for sizing without reading it. */
  logoAspect: 1200 / 262,
  markAspect: 123 / 191,
} as const;

const cache = new Map<string, Buffer | null>();

function load(file: string): Buffer | null {
  if (!cache.has(file)) {
    try {
      cache.set(file, readFileSync(path.join(process.cwd(), "public", "brand", file)));
    } catch {
      // A missing file must never stop a report: the renderers fall back to the name in text.
      cache.set(file, null);
    }
  }
  return cache.get(file) ?? null;
}

export const brandLogo = () => load("traffic-radius-logo.png");
export const brandMark = () => load("traffic-radius-mark.png");
