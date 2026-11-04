import { cropToFormat, FALLBACK_SIZE, formatPromptRule, type GenerationSize, type ImageFormat } from "@/lib/creatives/formats";
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
    // The logo goes to the model as a clean reference (its own plain background removed), so it
    // is placed where this layout wants it and reads against what is behind it. If that is not
    // possible, a plain render is made and the real logo is pasted on afterwards.
    let logoPng: Buffer | null = null;
    if (input.logoUrl && config.OPENAI_LOGO_MODE !== "paste") {
      try {
        const loaded = await loadLogoBuffer(input.logoUrl);
        logoPng = (await prepareLogo(loaded, { isSvg: isSvg(loaded) })).png;
      } catch (error) {
        logger.warn("Logo could not be prepared as a reference image", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const request = async (renderSize: string, withLogo: boolean) => {
      const finalPrompt = `${prompt} ${logoInstruction(withLogo ? "attached" : input.logoUrl ? "overlay" : "none", input.format)}`.slice(0, 32000);
      let response: Response;
      if (withLogo && logoPng) {
        const form = new FormData();
        form.set("model", model);
        form.set("prompt", finalPrompt);
        form.set("size", renderSize);
        form.set("quality", quality);
        form.set("n", "1");
        form.append("image[]", new Blob([new Uint8Array(logoPng)], { type: "image/png" }), "logo.png");
        response = await fetch("https://api.openai.com/v1/images/edits", {
          method: "POST",
          headers: { Authorization: `Bearer ${config.OPENAI_API_KEY}` },
          body: form,
          signal: AbortSignal.timeout(240_000),
        });
      } else {
        response = await fetch("https://api.openai.com/v1/images/generations", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ model, prompt: finalPrompt, size: renderSize, quality, n: 1 }),
          signal: AbortSignal.timeout(240_000),
        });
      }
      const body = (await response.json().catch(() => null)) as {
        data?: Array<{ b64_json?: string; url?: string }>;
        error?: { message?: string };
      } | null;
      return { res: response, payload: body };
    };
    /** A model that does not take the exact portrait size gets a 2:3 render that is cropped to shape. */
    const withSizeFallback = async (withLogo: boolean) => {
      let out = await request(size, withLogo);
      if (!out.res.ok && size !== "1024x1024" && size !== FALLBACK_SIZE && /size/i.test(out.payload?.error?.message ?? "")) {
        out = await request(FALLBACK_SIZE, withLogo);
      }
      return out;
    };

    let usedReference = false;
    let attempt: Awaited<ReturnType<typeof request>> | null = null;
    if (logoPng) {
      try {
        const withLogo = await withSizeFallback(true);
        if (withLogo.res.ok) {
          attempt = withLogo;
          usedReference = true;
        } else {
          logger.warn("Image edit with logo reference was refused; falling back", { status: withLogo.res.status });
        }
      } catch (error) {
        logger.warn("Image edit with logo reference failed; falling back", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (!attempt) attempt = await withSizeFallback(false);
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
    if (input.logoUrl && !usedReference) {
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

/** The sentences about the logo, which depend on how it reaches the image. */
function logoInstruction(mode: "attached" | "overlay" | "none", format?: ImageFormat): string {
  if (mode === "attached") {
    return `LOGO: the attached image is this brand's official logo on a transparent background. Place it exactly once, wherever it sits most naturally in this layout (a corner, the footer, or beside the headline; never over the main subject or the call-to-action), small but clearly legible at about 16-24% of the frame width${format === "9:16" ? ", below the top 14% and above the bottom 35% of the frame" : ""}. Reproduce it faithfully: same shapes, colours and lettering, fully visible and uncropped, at full opacity; do not redraw, restyle, recolour or replace it. Make sure it reads against what is behind it: on a light area use it as it is; on a dark or busy area give it a clean white rounded badge or panel that belongs to the design, or place it in a calm area. Never put it inside a black or dark box and never add a dark rectangle behind it. Keep it at least 6% away from every edge.`;
  }
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

async function compositeOfficialLogo(
  sourceImage: Buffer,
  logoUrl: string,
  placement: { topFraction?: number } = {},
): Promise<Buffer> {
  const loaded = await loadLogoBuffer(logoUrl);
  // Rasterise vectors large and drop the logo's own plain backdrop, so no box shows on the ad.
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

  const left = margin;
  const top = Math.round(height * (placement.topFraction ?? 0)) + margin;
  const logoWidth = resized.info.width;
  const logoHeight = resized.info.height;

  // What the logo will sit on decides how it is shown: straight on, or on a plate of the opposite tone.
  const behind = await sharp(sourceImage)
    .extract({
      left: Math.min(left, width - 1),
      top: Math.min(top, height - 1),
      width: Math.max(1, Math.min(logoWidth, width - left)),
      height: Math.max(1, Math.min(logoHeight, height - top)),
    })
    .stats();
  const [r = 128, g = 128, b = 128] = behind.channels.map((c) => c.mean);
  const treatment = chooseLogoTreatment(0.299 * r + 0.587 * g + 0.114 * b, logo.luminance);

  const layers: Array<{ input: Buffer; left: number; top: number }> = [];
  if (treatment.kind === "plate") {
    const pad = Math.round(logoHeight * 0.28);
    const plateWidth = logoWidth + pad * 2;
    const plateHeight = logoHeight + pad * 2;
    layers.push({
      input: Buffer.from(
        `<svg width="${plateWidth}" height="${plateHeight}" xmlns="http://www.w3.org/2000/svg"><rect width="${plateWidth}" height="${plateHeight}" rx="${Math.round(plateHeight * 0.22)}" fill="${treatment.color}" fill-opacity="0.96"/></svg>`,
      ),
      left: Math.max(0, left - pad),
      top: Math.max(0, top - pad),
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
