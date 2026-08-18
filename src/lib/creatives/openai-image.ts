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
  size?: "1024x1024" | "1024x1536" | "1536x1024";
  quality?: "low" | "medium" | "high";
  logoUrl?: string | null;
}): Promise<OpenAIImageResult> {
  const config = getConfig();
  const model = config.OPENAI_IMAGE_MODEL || "gpt-image-2";
  const prompt = input.prompt.slice(0, 32000);
  const size = input.size ?? "1024x1024";
  const quality = input.quality ?? "medium";

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
    const res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        prompt,
        size,
        quality,
        n: 1,
      }),
      signal: AbortSignal.timeout(120_000),
    });

    const payload = (await res.json().catch(() => null)) as {
      data?: Array<{ b64_json?: string; url?: string }>;
      error?: { message?: string };
    } | null;

    if (!res.ok) {
      throw new Error(
        payload?.error?.message || `OpenAI image failed (${res.status})`,
      );
    }

    const first = payload?.data?.[0];
    let b64 = first?.b64_json ?? null;
    let imageUrl: string | null = first?.url ?? null;
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
}): string {
  const palette = input.colors?.filter(Boolean).slice(0, 4) ?? [];
  const [primary, secondary, tertiary] = palette;
  return [
    `Professional Meta (Facebook/Instagram) feed ad still for ${input.brandName}.`,
    `Offer/theme: ${input.serviceName}.`,
    input.headline ? `Ad headline to support visually (do not render tiny illegible text): ${input.headline}` : null,
    input.primaryText
      ? `Primary message mood: ${input.primaryText.slice(0, 280)}`
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
    input.logoUrl
      ? "Leave the top-left corner visually quiet for the official logo overlay. Do not invent, redraw, or render a logo."
      : "Do not invent or render a logo.",
    input.landingPageUrl ? `Landing page context: ${input.landingPageUrl}` : null,
    input.creativeDirection
      ? `ART DIRECTION — follow this exactly; it is what makes this variant different from the others: ${input.creativeDirection}`
      : "Clean commercial photography, shallow depth of field, premium lighting.",
    input.variantLabel ? `Variant style: ${input.variantLabel}.` : null,
    // Left unchecked the model converges on one house style for every variant.
    "Do not default to the generic layout of a laptop or dashboard on a desk with a rising green arrow and a city skyline unless the art direction explicitly asks for it. Commit fully to the stated art direction's composition and subject matter.",
    input.revisionNotes ? `Operator revision request: ${input.revisionNotes}` : null,
    "Square 1:1 composition for Instagram feed. No watermarks, no dense paragraphs of text on the image.",
  ]
    .filter(Boolean)
    .join(" ");
}

async function compositeOfficialLogo(
  sourceImage: Buffer,
  logoUrl: string,
): Promise<Buffer> {
  const logo = await loadLogoBuffer(logoUrl);
  const sharpModule = await import("sharp");
  const sharp = sharpModule.default;
  // Firecrawl usually hands back an SVG. Rasterizing at the default 72 dpi and
  // refusing to enlarge renders a postage-stamp logo, so vectors get a high
  // density and are allowed to scale up to the card.
  const resized = await sharp(logo, isSvg(logo) ? { density: 384 } : undefined)
    .resize({
      width: 180,
      height: 72,
      fit: "inside",
      withoutEnlargement: !isSvg(logo),
      background: { r: 255, g: 255, b: 255, alpha: 0 },
    })
    .png()
    .toBuffer({ resolveWithObject: true });

  const cardWidth = 220;
  const cardHeight = 104;
  const cardLeft = 36;
  const cardTop = 36;
  const logoLeft = cardLeft + Math.round((cardWidth - resized.info.width) / 2);
  const logoTop = cardTop + Math.round((cardHeight - resized.info.height) / 2);
  const card = Buffer.from(
    `<svg width="${cardWidth}" height="${cardHeight}" xmlns="http://www.w3.org/2000/svg"><rect width="${cardWidth}" height="${cardHeight}" rx="14" fill="white" fill-opacity="0.94"/></svg>`,
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
