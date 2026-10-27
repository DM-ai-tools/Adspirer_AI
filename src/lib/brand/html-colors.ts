/**
 * Brand colours read straight from a page's own CSS variables.
 *
 * Sites declare their identity as variables such as `--primary` and
 * `--color-secondary`. Those are explicit brand intent, so they are a more
 * reliable source than guessing from rendered pixels, and they work when the
 * branding scrape comes back empty. Generic design tokens (`--red`, `--orange`)
 * are ignored on purpose.
 */

function normalizeHex(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  if (/^#[0-9a-f]{8}$/.test(v)) return v.slice(0, 7);
  return null;
}

/** How strongly a variable name says "this is a brand colour". 0 = not a brand colour. */
function scoreName(name: string): number {
  const n = name.toLowerCase();
  const shade = /(dark|light|hover|active|focus|muted|soft|tint|shade|alt)/.test(n);
  if (/primary/.test(n)) return shade ? 40 : 100;
  if (/secondary/.test(n)) return shade ? 38 : 90;
  if (/(accent|brand)/.test(n)) return shade ? 36 : 80;
  if (/(^|-)ink($|-)/.test(n)) return 45;
  return 0;
}

export function extractBrandColorsFromHtml(html: string): string[] {
  const found = new Map<string, number>();
  const add = (hex: string | null, score: number) => {
    if (!hex || score <= 0) return;
    found.set(hex, Math.max(found.get(hex) ?? 0, score));
  };

  for (const match of html.matchAll(/--([a-z0-9-]+)\s*:\s*(#[0-9a-f]{3,8})\b/gi)) {
    add(normalizeHex(match[2]!), scoreName(match[1]!));
  }
  const theme = html.match(/<meta[^>]+name=["']theme-color["'][^>]+content=["'](#[0-9a-f]{3,8})["']/i);
  if (theme) add(normalizeHex(theme[1]!), 30);

  return [...found.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([hex]) => hex)
    .slice(0, 5);
}

/** The page's own brand colours lead, then the others, without duplicates. */
export function mergeBrandColors(fromHtml: string[], others: string[]): string[] {
  return [...new Set([...fromHtml, ...others])].slice(0, 5);
}
