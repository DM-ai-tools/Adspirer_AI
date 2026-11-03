/**
 * Find a site's own logo in its HTML when the brand scrape didn't return one.
 *
 * A logo is an <img> in the page header or navigation (or marked as the brand
 * logo, or carrying the brand's name as its alt text). The strips of customer
 * logos further down ("Brands we grow", "Client logo") are never the brand's own
 * mark and are skipped, as are tiny icons.
 */

const MAX_DATA_URI = 400_000;

const attr = (tag: string, name: string): string => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return (m?.[1] ?? m?.[2] ?? m?.[3] ?? "").trim();
};

const squash = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** The brand's own mark would never be described like this. */
const NOT_OWN_LOGO = /client|customer|partner|testimonial|trusted|trust-?bar|marquee|carousel|review|avatar|badge|award|press|featured|as-seen|sponsor/i;

function resolve(src: string, pageUrl: string): string | null {
  if (!src) return null;
  if (/^data:image\/(png|jpe?g|webp|svg\+xml|gif)/i.test(src)) return src.length <= MAX_DATA_URI ? src : null;
  try {
    const url = new URL(src, pageUrl);
    return /^https?:$/.test(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

/** The logo URL from structured data (schema.org Organization), when the site declares one. */
function logoFromJsonLd(html: string, pageUrl: string): string | null {
  for (const block of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = (node: unknown): string | null => {
        if (Array.isArray(node)) {
          for (const item of node) {
            const found = walk(item);
            if (found) return found;
          }
          return null;
        }
        if (node && typeof node === "object") {
          const obj = node as Record<string, unknown>;
          const logo = obj.logo;
          const raw = typeof logo === "string" ? logo : logo && typeof logo === "object" ? String((logo as Record<string, unknown>).url ?? "") : "";
          const resolved = raw ? resolve(raw, pageUrl) : null;
          if (resolved) return resolved;
          for (const value of Object.values(obj)) {
            const found = walk(value);
            if (found) return found;
          }
        }
        return null;
      };
      const found = walk(JSON.parse(block[1]!));
      if (found) return found;
    } catch {
      // malformed JSON-LD is common; ignore it
    }
  }
  return null;
}

export function extractLogoFromHtml(html: string, pageUrl: string, brandName?: string | null): string | null {
  const declared = logoFromJsonLd(html, pageUrl);
  if (declared) return declared;

  const brand = brandName ? squash(brandName) : "";
  // Where the header / nav sits, so images inside it can be told from those further down.
  const regions: Array<[number, number]> = [];
  for (const m of html.matchAll(/<(header|nav)\b[\s\S]*?<\/\1>/gi)) {
    regions.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }
  const firstMain = html.search(/<(main|section)\b/i);

  let best: { score: number; url: string } | null = null;
  let seen = 0;
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    if (seen++ >= 60) break;
    const tag = m[0];
    const at = m.index ?? 0;
    const src = attr(tag, "src") || attr(tag, "data-src");
    const alt = attr(tag, "alt");
    const marks = `${attr(tag, "class")} ${attr(tag, "id")} ${alt} ${src.startsWith("data:") ? "" : src}`;
    if (NOT_OWN_LOGO.test(marks)) continue;
    const width = Number(attr(tag, "width"));
    if (Number.isFinite(width) && width > 0 && width < 24) continue;

    let score = 0;
    if (regions.some(([from, to]) => at >= from && at <= to)) score += 5;
    if (/\b(site-?|brand-?|main-?|header-?|nav-?)?logo\b|brand-?mark|wordmark/i.test(marks)) score += 4;
    if (brand && alt && (squash(alt).includes(brand) || brand.includes(squash(alt)))) score += 3;
    // Before the first content section is where a header logo lives.
    if (firstMain >= 0 && at < firstMain) score += 1;
    if (score < 5) continue;
    const url = resolve(src, pageUrl);
    if (url && (!best || score > best.score)) best = { score, url };
  }
  return best?.url ?? null;
}
