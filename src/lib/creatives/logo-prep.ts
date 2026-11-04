/**
 * Getting a brand logo ready to sit on an ad.
 *
 * Logos scraped from sites are very often a flat image with an opaque white (or other plain)
 * background. Pasted as is, that background reads as a box on the ad, and treating the mostly
 * white image as a "light logo" put a black plate behind it. So the plain background is removed
 * first (the logo becomes transparent, cropped to its own shape), and how it sits on the ad is
 * decided from the colours actually behind it.
 */

type Rgba = Uint8Array | Uint8ClampedArray | Buffer;

/** Distance in RGB at or under which a pixel counts as the background. */
const BACKGROUND_TOLERANCE = 28;
/** Pixels between the tolerance and this distance are feathered, so edges stay smooth. */
const FEATHER_UNTIL = 70;
const CORNER_AGREEMENT = 24;

const dist = (r1: number, g1: number, b1: number, r2: number, g2: number, b2: number) =>
  Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);

/**
 * Make a logo's plain, opaque background transparent. Only background connected to the image
 * edge is removed, so a white letter inside the mark stays. Returns false (and changes nothing)
 * when the logo is already transparent or its corners are not one flat colour.
 * `data` is RGBA, 4 bytes a pixel, and is changed in place.
 */
export function keyOutBackground(data: Rgba, width: number, height: number): boolean {
  if (width < 2 || height < 2) return false;
  const at = (x: number, y: number) => (y * width + x) * 4;
  const corners = [at(0, 0), at(width - 1, 0), at(0, height - 1), at(width - 1, height - 1)];
  if (corners.some((i) => (data[i + 3] ?? 255) < 200)) return false; // already transparent there

  const [r0, g0, b0] = [data[corners[0]!]!, data[corners[0]! + 1]!, data[corners[0]! + 2]!];
  for (const i of corners.slice(1)) {
    if (dist(r0, g0, b0, data[i]!, data[i + 1]!, data[i + 2]!) > CORNER_AGREEMENT) return false;
  }

  const seen = new Uint8Array(width * height);
  const queue: number[] = [];
  const push = (x: number, y: number) => {
    const k = y * width + x;
    if (seen[k]) return;
    seen[k] = 1;
    queue.push(k);
  };
  for (let x = 0; x < width; x += 1) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    push(0, y);
    push(width - 1, y);
  }

  let removed = 0;
  while (queue.length) {
    const k = queue.pop()!;
    const i = k * 4;
    const d = dist(r0, g0, b0, data[i]!, data[i + 1]!, data[i + 2]!);
    if (d > FEATHER_UNTIL) continue;
    if (d <= BACKGROUND_TOLERANCE) {
      data[i + 3] = 0;
    } else {
      // Anti-aliased edge: partly background, partly the logo.
      data[i + 3] = Math.round(((d - BACKGROUND_TOLERANCE) / (FEATHER_UNTIL - BACKGROUND_TOLERANCE)) * (data[i + 3] ?? 255));
      // The edge colour is blended with the background; it stays, but only where it is part of the logo.
    }
    removed += 1;
    const x = k % width;
    const y = (k - x) / width;
    if (x > 0) push(x - 1, y);
    if (x < width - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < height - 1) push(x, y + 1);
  }
  // Almost nothing connected to the edge was background: this was not a flat backdrop.
  return removed > width * height * 0.02;
}

/** The box that holds every visible pixel, or null when nothing is visible. */
export function contentBox(data: Rgba, width: number, height: number, minAlpha = 12) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((data[(y * width + x) * 4 + 3] ?? 0) > minAlpha) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Average brightness (0-255) of the logo's visible pixels. */
export function visibleLuminance(data: Rgba, minAlpha = 40): number {
  let total = 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if ((data[i + 3] ?? 0) < minAlpha) continue;
    total += 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
    count += 1;
  }
  return count ? total / count : 128;
}

export type LogoTreatment = { kind: "direct" } | { kind: "plate"; color: string };

/** Contrast between logo and what is behind it that is enough to read it with no backing. */
const READABLE_CONTRAST = 95;

/**
 * How a logo sits on the spot it is pasted onto: straight on when it reads there, otherwise on a
 * plate of the opposite tone. A dark logo gets a white plate, never a black one.
 */
export function chooseLogoTreatment(backgroundLuminance: number, logoLuminance: number): LogoTreatment {
  if (Math.abs(backgroundLuminance - logoLuminance) >= READABLE_CONTRAST) return { kind: "direct" };
  return { kind: "plate", color: logoLuminance < 140 ? "#ffffff" : "#1f2430" };
}

/**
 * A logo as a transparent PNG cropped to its own shape, plus its average brightness. `isSvg`
 * lets vectors be rasterised large.
 */
export async function prepareLogo(
  logo: Buffer,
  options: { isSvg?: boolean; maxSize?: number } = {},
): Promise<{ png: Buffer; luminance: number; backgroundRemoved: boolean }> {
  const sharp = (await import("sharp")).default;
  const maxSize = options.maxSize ?? 768;
  const { data, info } = await sharp(logo, options.isSvg ? { density: 384 } : undefined)
    .resize({ width: maxSize, height: maxSize, fit: "inside", withoutEnlargement: !options.isSvg })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // A flat single-colour image would be keyed out entirely; keep it as it is in that case.
  const keyed = Buffer.from(data);
  let backgroundRemoved = keyOutBackground(keyed, info.width, info.height);
  let pixels: Buffer = keyed;
  let box = contentBox(keyed, info.width, info.height);
  if (!box) {
    backgroundRemoved = false;
    pixels = data;
    box = contentBox(data, info.width, info.height);
  }
  const luminance = visibleLuminance(pixels);
  let image = sharp(pixels, { raw: { width: info.width, height: info.height, channels: 4 } });
  if (box && (box.width < info.width || box.height < info.height)) {
    image = image.extract(box);
  }
  return { png: await image.png().toBuffer(), luminance, backgroundRemoved };
}
