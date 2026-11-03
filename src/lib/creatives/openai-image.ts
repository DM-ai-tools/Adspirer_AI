import { cropToFormat, FALLBACK_SIZE, formatPromptRule, type GenerationSize, type ImageFormat } from "@/lib/creatives/formats";
import { getConfig } from "@/lib/config";
import { logger } from "@/lib/observability/logger";

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
  size?: GenerationSize | "1536x1024";
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
    // The model never draws the logo: it would be redrawn, cropped with the frame and
    // unreadable on a dark ad. A plain render is made with the top-left kept clear, and
    // the brand's real logo is placed there afterwards on a plate that contrasts with it.
    const render = async (renderSize: string) => {
      const response = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          prompt: `${prompt} ${logoInstruction(input.logoUrl ? "overlay" : "none", input.format)}`.slice(0, 32000),
          size: renderSize,
          quality,
          n: 1,
        }),
        signal: AbortSignal.timeout(240_000),
      });
      const body = (await response.json().catch(() => null)) as {
        data?: Array<{ b64_json?: string; url?: string }>;
        error?: { message?: string };
      } | null;
      return { res: response, payload: body };
    };

    let { res, payload } = await render(size);
    // A model that does not take the exact portrait size gets a 2:3 render that is cropped to shape.
    if (!res.ok && size !== "1024x1024" && size !== FALLBACK_SIZE && /size/i.test(payload?.error?.message ?? "")) {
      ({ res, payload } = await render(FALLBACK_SIZE));
    }

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
          const branded = await compositeOfficialLogo(
            sourceImage,
            input.logoUrl,
            // Reels/Stories: below the top 14% Meta covers with the account name.
            input.format === "9:16" ? { topFraction: 0.14 } : {},
          );
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

/** The one sentence about the logo. The real logo is placed on the finished image, so the model only keeps room for it. */
function logoInstruction(mode: "overlay" | "none", format?: ImageFormat): string {
  if (mode === "overlay") {
    return `Leave the top ${format === "9:16" ? "28%" : "16%"} of the frame free of any text, chip or button (background, glow and imagery may continue through it) and keep the top-left corner clear, because the brand's real logo is placed there afterwards. Do not draw, invent or imitate any logo or brand mark.`;
  }
  return "Do not invent or render a logo.";
}

/**
 * What separates an ad that stops the scroll from a plain stock still. It is stated for every
 * render so the model builds a finished, layered ad, not a flat picture with a caption.
 */
const CRAFT_BRIEF =
  "CRAFT — this must look like a finished, professionally designed static ad, never a plain photo or flat template: one unmistakable focal point that reads in under a second at thumbnail size; real depth with distinct foreground, subject and background layers; deliberate lighting with believable shadows, reflections and highlights; rich materials and texture (grain, glass, gloss, fabric, paper, metal) where they suit the style; confident, generous negative space; a clear type hierarchy (huge headline, small supporting text, one bold button) set with proper kerning and contrast; premium colour grading and crisp edges. No clutter, no clip-art, no generic handshake or laptop-on-desk stock imagery, no watermarks.";

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
      ? `THE POST THIS IMAGE ACCOMPANIES — the image must make this message understood at a glance, showing its subject and benefit, not a generic mood. ${input.headline ? `Headline: "${input.headline}". ` : ""}${input.primaryText ? `Primary text: "${input.primaryText.slice(0, 400)}". ` : ""}Show the headline large and legible; never as small text.`
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
    input.creativeDirection?.includes("ON-IMAGE TEXT")
      ? "TEXT ON THE IMAGE — design this like a finished paid-social ad, not a stock photo: set the ON-IMAGE TEXT from the art direction as bold, high-contrast, perfectly legible typography; the headline large, the highlighted keywords as accent-coloured words or rounded chips in the brand palette, and the call-to-action as a solid rounded button. Spell every word exactly as given. Put no other words on the image: no extra slogans, no lorem ipsum, no gibberish, no fake UI text."
      : null,
    input.variantLabel ? `Variant name: ${input.variantLabel}. Commit fully to the art direction's style so this variation looks clearly different from its siblings.` : null,
    input.revisionNotes ? `Operator revision request: ${input.revisionNotes}` : null,
    formatPromptRule(input.format ?? "1:1"),
  ]
    .filter(Boolean)
    .join(" ");
}

/** True when the logo's visible pixels are mostly light, so it needs a dark plate to be read. */
async function isLightLogo(png: Buffer): Promise<boolean> {
  const sharp = (await import("sharp")).default;
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let total = 0;
  let count = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    if ((data[i + 3] ?? 255) < 40) continue;
    total += 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
    count += 1;
  }
  return count > 0 && total / count > 190;
}

async function compositeOfficialLogo(
  sourceImage: Buffer,
  logoUrl: string,
  placement: { topFraction?: number } = {},
): Promise<Buffer> {
  const logo = await loadLogoBuffer(logoUrl);
  const sharpModule = await import("sharp");
  const sharp = sharpModule.default;
  const meta = await sharp(sourceImage).metadata();
  const width = meta.width ?? 1024;
  // Everything scales with the image, so the logo is as legible on a 1536px still as on a 1024px one.
  const margin = Math.round(width * 0.04);
  const cardWidth = Math.round(width * 0.3);
  const cardHeight = Math.round(cardWidth * 0.4);
  const pad = Math.round(cardHeight * 0.16);
  // Firecrawl usually hands back an SVG. Rasterizing at the default 72 dpi and
  // refusing to enlarge renders a postage-stamp logo, so vectors get a high
  // density and are allowed to scale up to the card.
  const resized = await sharp(logo, isSvg(logo) ? { density: 384 } : undefined)
    .resize({
      width: cardWidth - pad * 2,
      height: cardHeight - pad * 2,
      fit: "inside",
      withoutEnlargement: !isSvg(logo),
      background: { r: 255, g: 255, b: 255, alpha: 0 },
    })
    .png()
    .toBuffer({ resolveWithObject: true });

  const light = await isLightLogo(resized.data);
  const cardLeft = margin;
  const cardTop = Math.round((meta.height ?? width) * (placement.topFraction ?? 0)) + margin;
  const logoLeft = cardLeft + Math.round((cardWidth - resized.info.width) / 2);
  const logoTop = cardTop + Math.round((cardHeight - resized.info.height) / 2);
  const card = Buffer.from(
    `<svg width="${cardWidth}" height="${cardHeight}" xmlns="http://www.w3.org/2000/svg"><rect width="${cardWidth}" height="${cardHeight}" rx="${Math.round(cardHeight * 0.18)}" fill="${light ? "#15181d" : "#ffffff"}" fill-opacity="0.96"/></svg>`,
  );

  return sharp(sourceImage)
    .composite([
      { input: card, left: cardLeft, top: cardTop },
      { input: resized.data, left: logoLeft, top: logoTop },
    ])
    .png()
    .toBuffer();
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
