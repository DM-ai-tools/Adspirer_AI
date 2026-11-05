import { cropToFormat } from "@/lib/creatives/crop-to-format";
import { fallbackSizeFor, formatPromptRule, type GenerationSize, type ImageFormat } from "@/lib/creatives/formats";
import { getConfig } from "@/lib/config";
import { logger } from "@/lib/observability/logger";
import { chooseLogoTreatment, prepareLogo } from "@/lib/creatives/logo-prep";

export type OpenAIImageResult = {
  imageUrl: string | null;
  b64: string | null;
  mime: string;
  model: string;
  prompt: string;
  status: "succeeded" | "failed" | "skipped";
  error?: string;
};

/**
 * Generate a brand-aligned still via OpenAI Images API (GPT Image 2).
 * Default model: gpt-image-2 (override with OPENAI_IMAGE_MODEL).
 */
export async function generateOpenAIImage(input: {
  prompt: string;
  size?: GenerationSize;
  quality?: "low" | "medium" | "high";
  logoUrl?: string | null;
  /** Crop the render to this shape (before the logo goes on). */
  format?: ImageFormat;
}): Promise<OpenAIImageResult> {
  const config = getConfig();
  const model = config.OPENAI_IMAGE_MODEL || "gpt-image-2";
  const prompt = input.prompt.slice(0, 32000);
  const size = input.size ?? "1024x1024";
  const quality = input.quality ?? config.OPENAI_IMAGE_QUALITY ?? "high";

  if (!config.OPENAI_API_KEY) {
    return {
      imageUrl: null,
      b64: null,
      mime: "image/png",
      model,
      prompt,
      status: "skipped",
      error: "OPENAI_API_KEY not configured",
    };
  }

  try {
    // The model NEVER sees or draws the logo: image models redraw logos with wrong shapes and
    // lettering. It is told to leave a calm area free, and the brand's real logo pixels are
    // composited onto the finished render, at the calmest spot, afterwards.
    const finalPrompt = `${prompt} ${logoInstruction(input.logoUrl ? "overlay" : "none", input.format)}`.slice(0, 32000);
    const request = async (renderSize: string) => {
      const response = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model, prompt: finalPrompt, size: renderSize, quality, n: 1 }),
        signal: AbortSignal.timeout(240_000),
      });
      const body = (await response.json().catch(() => null)) as {
        data?: Array<{ b64_json?: string; url?: string }>;
        error?: { message?: string };
      } | null;
      return { res: response, payload: body };
    };
    /** A model that does not take the exact portrait size gets a 2:3 render that is cropped to shape. */
    let attempt = await request(size);
    const fallbackSize = fallbackSizeFor(input.format);
    if (!attempt.res.ok && size !== "1024x1024" && size !== fallbackSize && /size/i.test(attempt.payload?.error?.message ?? "")) {
      attempt = await request(fallbackSize);
    }
    const { res, payload } = attempt;

    if (!res.ok) {
      throw new Error(
        payload?.error?.message || `OpenAI image failed (${res.status})`,
      );
    }

    const first = payload?.data?.[0];
    let b64 = first?.b64_json ?? null;
    let imageUrl: string | null = first?.url ?? null;
    if (input.format && input.format !== "1:1") {
      try {
        const raw =
          b64 ??
          (imageUrl
            ? Buffer.from(await (await fetch(imageUrl, { signal: AbortSignal.timeout(30_000) })).arrayBuffer()).toString("base64")
            : null);
        if (raw) {
          b64 = await cropToFormat(raw, input.format);
          imageUrl = `data:image/png;base64,${b64}`;
        }
      } catch (error) {
        logger.warn("Image crop failed", { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (input.logoUrl) {
      try {
        const sourceImage = b64
          ? Buffer.from(b64, "base64")
          : imageUrl
            ? Buffer.from(
                await (
                  await fetch(imageUrl, {
                    signal: AbortSignal.timeout(30_000),
                  })
                ).arrayBuffer(),
              )
            : null;
        if (sourceImage) {
          const branded = await compositeOfficialLogo(sourceImage, input.logoUrl, input.format);
          b64 = branded.toString("base64");
          imageUrl = `data:image/png;base64,${b64}`;
        }
      } catch (error) {
        logger.warn("Official logo overlay failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (!imageUrl && b64) {
      imageUrl = `data:image/png;base64,${b64}`;
    }

    if (!imageUrl) {
      throw new Error("OpenAI image response had no url or b64_json");
    }

    return {
      imageUrl,
      b64,
      mime: "image/png",
      model,
      prompt,
      status: "succeeded",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("OpenAI image generation failed", { error: message, model });
    return {
      imageUrl: null,
      b64: null,
      mime: "image/png",
      model,
      prompt,
      status: "failed",
      error: message,
    };
  }
}

/** The sentences about the logo, which depend on how it reaches the image. */
function logoInstruction(mode: "overlay" | "none", format?: ImageFormat): string {
  if (mode === "overlay") {
    return `LOGO SPACE: the brand's real logo is added to this image afterwards, so leave one calm, uncluttered area free in a corner (top-left preferred; ${format === "9:16" ? "below the top 14% of the frame" : "top-right is the alternative"}), about 26% of the frame wide and 14% tall, with no text, chip, button, face or busy detail in it (background colour, soft glow or gradient may continue through it). Do NOT draw, write, invent, imitate or placeholder any logo, wordmark, brand name badge or brand mark anywhere in the image.`;
  }
  return "Do not invent or render a logo.";
}

/**
 * What separates an ad that stops the scroll from a plain stock still. It is stated for every
 * render so the model builds a finished, layered ad, not a flat picture with a caption.
 */
const CRAFT_BRIEF =
  "CRAFT — this must look like a finished, art-directed, award-calibre static ad, never a plain template, flat graphic or clip-art. A single, surprising VISUAL IDEA carries the ad and reads in under a second even with the text covered: a vivid metaphor, contrast or staged scene built from real-looking objects. Render it with photographic or premium 3D realism: tactile materials (glass, metal, fabric, paper, leaves, liquid), believable light, shadows, reflections and depth of field, distinct foreground, subject and background layers, a rich deliberate colour grade and razor-crisp detail. The picture dominates (about two thirds of the frame); the type supports it: a clear headline sized to complement the scene, not to overpower it, a few small labels set into the scene, and one clean button, all with high contrast, proper kerning and large enough to read at thumbnail size. Anatomy, hands, screens and objects must look correct and realistic. Keep it uncluttered: no rows of badges, no piles of tiny icons, no cheap stock imagery, no watermarks.";

export function buildBrandImagePrompt(input: {
  brandName: string;
  serviceName: string;
  brandVoice?: string | null;
  colors?: string[] | null;
  creativeDirection?: string | null;
  headline?: string | null;
  primaryText?: string | null;
  logoDescription?: string | null;
  logoUrl?: string | null;
  landingPageUrl?: string | null;
  revisionNotes?: string | null;
  variantLabel?: string | null;
  format?: ImageFormat;
}): string {
  const palette = input.colors?.filter(Boolean).slice(0, 4) ?? [];
  const [primary, secondary, tertiary] = palette;
  return [
    `Art-directed, scroll-stopping Meta (Facebook/Instagram) ad creative for ${input.brandName}, at the level of a top agency's paid-social work.`,
    `Offer/theme: ${input.serviceName}.`,
    CRAFT_BRIEF,
    input.headline || input.primaryText
      ? `THE POST THIS IMAGE ACCOMPANIES — the picture itself must make this message understood at a glance, through a visual idea that shows its subject and benefit, not a generic mood. ${input.headline ? `Headline: "${input.headline}". ` : ""}${input.primaryText ? `Primary text: "${input.primaryText.slice(0, 400)}". ` : ""}Show the headline clearly legible and well sized, as a supporting element of the scene.`
      : null,
    input.brandVoice ? `Brand mood/voice: ${input.brandVoice}.` : null,
    // Hex codes listed as "accents" get treated as a loose suggestion and the
    // model reverts to stock beige/blue, so state the palette as a rule and
    // assign each colour a job.
    palette.length
      ? [
          `BRAND PALETTE — bind the image to these exact colours, sampled from the brand's own site: ${palette.join(", ")}.`,
          `Use ${primary} as the dominant colour across roughly half the frame (background field, main surface, or the subject's key styling).`,
          secondary
            ? `Use ${secondary} for the strongest supporting element or accent shape.`
            : null,
          tertiary ? `Use ${tertiary} sparingly for contrast and detail.` : null,
          "Every other colour must be a neutral or a tint/shade of the palette. Do not introduce an unrelated hue, and do not fall back to generic stock beige, teal, or corporate blue.",
        ]
          .filter(Boolean)
          .join(" ")
      : null,
    input.logoDescription ? `Brand identity note: ${input.logoDescription}.` : null,
    input.landingPageUrl ? `Landing page context: ${input.landingPageUrl}` : null,
    input.creativeDirection
      ? `ART DIRECTION — follow this exactly; it is what makes this variant different from the others: ${input.creativeDirection}`
      : null,
    input.creativeDirection?.includes("STYLE:")
      ? "The STYLE named in the art direction decides the medium and look of this image (a phone photo, a 3D render, an illustration, a collage, a poster, a comparison layout…). Make it unmistakably in that style, and do not default to a generic polished-photograph look."
      : null,
    input.creativeDirection?.includes("ON-IMAGE TEXT")
      ? "TEXT ON THE IMAGE — set the ON-IMAGE TEXT from the art direction as high-contrast, perfectly legible typography that supports the picture rather than dominating it: the headline clear and well sized, the highlighted keywords as a few small chips or accent words placed naturally in the scene, and the call-to-action as a solid rounded button. Spell every word exactly as given. Put no other words on the image: no extra slogans, no lorem ipsum, no gibberish, no fake UI text."
      : null,
    input.variantLabel ? `Variant name: ${input.variantLabel}. Commit fully to the art direction's style so this variation looks clearly different from its siblings.` : null,
    input.revisionNotes ? `Operator revision request: ${input.revisionNotes}` : null,
    formatPromptRule(input.format ?? "1:1"),
  ]
    .filter(Boolean)
    .join(" ");
}

/** Where on the render the logo may go, as fractions of the frame, with a small bias to the first. */
export function logoCandidates(format?: ImageFormat): Array<{ x: number; y: number; bias: number }> {
  // Reels/Stories: Meta covers the top 14% (account name) and the bottom ~35% (reply bar), so stay in between.
  if (format === "9:16") {
    return [
      { x: 0.05, y: 0.15, bias: 0 },
      { x: 0.95, y: 0.15, bias: 3 },
      { x: 0.05, y: 0.62, bias: 6 },
    ];
  }
  return [
    { x: 0.05, y: 0.05, bias: 0 },
    { x: 0.95, y: 0.05, bias: 3 },
    { x: 0.05, y: 0.95, bias: 6 },
    { x: 0.95, y: 0.95, bias: 8 },
  ];
}

async function compositeOfficialLogo(
  sourceImage: Buffer,
  logoUrl: string,
  format?: ImageFormat,
): Promise<Buffer> {
  const loaded = await loadLogoBuffer(logoUrl);
  // Rasterise vectors large and drop the logo's own plain backdrop, so no box shows on the ad.
  // These are the brand's exact pixels; only scaled, never redrawn.
  const logo = await prepareLogo(loaded, { isSvg: isSvg(loaded) });
  const sharp = (await import("sharp")).default;
  const meta = await sharp(sourceImage).metadata();
  const width = meta.width ?? 1024;
  const height = meta.height ?? width;
  // Everything scales with the image, so the logo is as legible on a tall still as on a square one.
  const margin = Math.round(width * 0.05);
  const boxWidth = Math.round(width * 0.24);
  const boxHeight = Math.round(width * 0.12);
  const resized = await sharp(logo.png)
    .resize({ width: boxWidth, height: boxHeight, fit: "inside", withoutEnlargement: false })
    .png()
    .toBuffer({ resolveWithObject: true });
  const logoWidth = resized.info.width;
  const logoHeight = resized.info.height;
  const pad = Math.round(logoHeight * 0.28);

  // Look at each allowed spot (the logo plus its possible plate) and take the calmest: lowest
  // variation in colour means no text, face or detail there to collide with.
  let best: { left: number; top: number; luminance: number; score: number } | null = null;
  for (const c of logoCandidates(format)) {
    const left = Math.max(0, Math.min(width - logoWidth, c.x < 0.5 ? margin : width - margin - logoWidth));
    const top = Math.max(0, Math.min(height - logoHeight, c.y < 0.5 ? Math.round(height * c.y) : height - margin - logoHeight));
    const region = {
      left: Math.max(0, left - pad),
      top: Math.max(0, top - pad),
      width: Math.max(1, Math.min(width - Math.max(0, left - pad), logoWidth + pad * 2)),
      height: Math.max(1, Math.min(height - Math.max(0, top - pad), logoHeight + pad * 2)),
    };
    // Cut the region out first: stats() would otherwise read the whole image.
    const stats = await sharp(await sharp(sourceImage).extract(region).png().toBuffer()).stats();
    const [r = 128, g = 128, b = 128] = stats.channels.map((ch) => ch.mean);
    const spread = stats.channels.slice(0, 3).reduce((sum, ch) => sum + ch.stdev, 0) / 3;
    const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
    const score = spread + c.bias;
    if (!best || score < best.score) best = { left, top, luminance, score };
  }
  const { left, top, luminance } = best!;

  // What the logo will sit on decides how it is shown: straight on, or on a plate of the opposite tone.
  const treatment = chooseLogoTreatment(luminance, logo.luminance);
  const layers: Array<{ input: Buffer; left: number; top: number }> = [];
  if (treatment.kind === "plate") {
    const plateWidth = logoWidth + pad * 2;
    const plateHeight = logoHeight + pad * 2;
    const plateLeft = Math.max(0, Math.min(width - plateWidth, left - pad));
    const plateTop = Math.max(0, Math.min(height - plateHeight, top - pad));
    layers.push({
      input: Buffer.from(
        `<svg width="${plateWidth}" height="${plateHeight}" xmlns="http://www.w3.org/2000/svg"><rect width="${plateWidth}" height="${plateHeight}" rx="${Math.round(plateHeight * 0.22)}" fill="${treatment.color}" fill-opacity="0.96"/></svg>`,
      ),
      left: plateLeft,
      top: plateTop,
    });
  }
  layers.push({ input: resized.data, left, top });
  return sharp(sourceImage).composite(layers).png().toBuffer();
}

function isSvg(buffer: Buffer): boolean {
  return /<svg[\s>]/i.test(buffer.subarray(0, 512).toString("utf8"));
}

async function loadLogoBuffer(logoUrl: string): Promise<Buffer> {
  if (logoUrl.startsWith("data:")) {
    // Firecrawl ships SVG logos as `data:image/svg+xml;utf8,<percent-encoded>`,
    // so the media type can carry parameters other than base64. Matching only
    // `;base64` threw here and the overlay was skipped for every brand.
    const match = logoUrl.match(/^data:([^,]*),([\s\S]+)$/);
    if (!match) throw new Error("Invalid Firecrawl logo data URI");
    const [, mediaType = "", payload = ""] = match;
    return /(^|;)base64($|;)/i.test(mediaType)
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload), "utf8");
  }

  const parsed = new URL(logoUrl);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Unsupported Firecrawl logo URL");
  }
  const response = await fetch(parsed, {
    signal: AbortSignal.timeout(30_000),
    headers: { "User-Agent": "AdspirerAIBot/1.0" },
  });
  if (!response.ok) {
    throw new Error(`Logo download failed (${response.status})`);
  }
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > 5_000_000) throw new Error("Logo exceeds 5 MB");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > 5_000_000) throw new Error("Logo exceeds 5 MB");
  return buffer;
}
