import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { getConfig } from "@/lib/config";
import { logger } from "@/lib/observability/logger";
import { scrapeWebsiteServices } from "@/lib/scraping/firecrawl";

export type BrandUrlAnalysis = {
  url: string;
  title?: string;
  brand_name?: string;
  brand_voice?: string;
  colors: string[];
  logo_url: string | null;
  logo_description: string | null;
  imagery_notes: string | null;
  summary: string;
  source: "firecrawl_branding" | "openai+scrape" | "scrape_only" | "heuristic";
};

/**
 * Scrape a landing URL and extract brand colours / logo cues for creative gen.
 */
export async function analyzeBrandFromUrl(
  url: string,
): Promise<BrandUrlAnalysis> {
  const scraped = await scrapeWebsiteServices(url);
  const markdown = (scraped.markdown ?? "").slice(0, 8000);
  const config = getConfig();
  const branding = scraped.branding;

  if (scraped.source === "firecrawl" && branding) {
    // Ordered by how much of the ad each should drive. `link` is deliberately
    // last: it is often an unrelated one-off hue that would otherwise outrank
    // the real background once the prompt truncates the palette.
    const ranked = [
      branding.colors?.primary,
      branding.colors?.accent,
      branding.colors?.secondary,
      branding.colors?.background,
      branding.colors?.textPrimary,
      branding.colors?.link,
    ]
      .filter((color): color is string => Boolean(color))
      .map(normalizeHexColor)
      .filter((color): color is string => Boolean(color))
      .filter((color, index, all) => all.indexOf(color) === index);

    // The first colour becomes the dominant one in the image prompt, and
    // Firecrawl sometimes reports a near-white or near-black as "primary".
    // Lead with an actual hue and keep the neutrals as supporting tones.
    const colors = [
      ...ranked.filter((color) => !isNeutral(color)),
      ...ranked.filter(isNeutral),
    ].slice(0, 5);
    const logo =
      branding.images?.logo ??
      branding.logo ??
      branding.images?.favicon ??
      null;
    const personality = [
      branding.personality?.tone,
      branding.personality?.energy,
    ]
      .filter(Boolean)
      .join(", ");
    const fontFamilies = (branding.fonts ?? [])
      .map((font) => font.family)
      .filter((family): family is string => Boolean(family))
      .filter((family, index, all) => all.indexOf(family) === index);
    const brandName = cleanBrandName(scraped.title);

    return {
      url: scraped.url,
      title: scraped.title,
      brand_name: brandName,
      brand_voice: personality || undefined,
      colors,
      logo_url: logo,
      logo_description: logo
        ? `Official logo extracted by Firecrawl from ${scraped.url}`
        : null,
      imagery_notes: [
        personality ? `Brand personality: ${personality}` : null,
        fontFamilies.length
          ? `Typography: ${fontFamilies.slice(0, 3).join(", ")}`
          : null,
        branding.colorScheme
          ? `${branding.colorScheme} visual color scheme`
          : null,
      ]
        .filter(Boolean)
        .join(". ") || null,
      summary: `Firecrawl branding: ${colors.length} brand colors${logo ? " and official logo" : ""} extracted from ${scraped.url}.`,
      source: "firecrawl_branding",
    };
  }

  const logoGuess =
    markdown.match(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+\.(?:png|jpg|jpeg|svg|webp)[^)\s]*)\)/i)?.[2] ??
    markdown.match(/(https?:\/\/[^\s)"']+(?:logo|brand)[^\s)"']*\.(?:png|jpg|jpeg|svg|webp))/i)?.[1] ??
    null;

  if (config.hasOpenAI && config.OPENAI_API_KEY && markdown.trim()) {
    try {
      const openai = createOpenAI({ apiKey: config.OPENAI_API_KEY });
      const { text } = await generateText({
        model: openai(config.OPENAI_MODEL),
        temperature: 0.2,
        maxOutputTokens: 900,
        system: [
          "Extract brand identity from website markdown for Meta ad creatives.",
          'Return ONLY JSON: {"brand_name":"","brand_voice":"","colors":["#hex",...],"logo_url":null,"logo_description":"","imagery_notes":"","summary":""}',
          "colors: up to 5 hex codes that fit the brand (infer from described UI if needed).",
          "logo_url: absolute https URL if present in the markdown, else null.",
        ].join(" "),
        prompt: [
          `URL: ${scraped.url}`,
          scraped.title ? `Title: ${scraped.title}` : null,
          `Possible logo guess: ${logoGuess ?? "none"}`,
          "",
          "## Page markdown",
          markdown,
        ]
          .filter(Boolean)
          .join("\n"),
      });
      const parsed = JSON.parse(stripFence(text)) as Partial<BrandUrlAnalysis>;
      const colors = Array.isArray(parsed.colors)
        ? parsed.colors
            .map((c) => String(c).trim())
            .filter((c) => /^#?[0-9a-fA-F]{3,8}$/.test(c))
            .map((c) => (c.startsWith("#") ? c : `#${c}`))
            .slice(0, 5)
        : [];
      return {
        url: scraped.url,
        title: scraped.title,
        brand_name: parsed.brand_name ? String(parsed.brand_name) : scraped.title,
        brand_voice: parsed.brand_voice ? String(parsed.brand_voice) : undefined,
        colors,
        logo_url:
          (typeof parsed.logo_url === "string" && parsed.logo_url.startsWith("http")
            ? parsed.logo_url
            : null) ?? logoGuess,
        logo_description: parsed.logo_description
          ? String(parsed.logo_description)
          : null,
        imagery_notes: parsed.imagery_notes
          ? String(parsed.imagery_notes)
          : null,
        summary: parsed.summary
          ? String(parsed.summary)
          : `Brand cues from ${scraped.url}`,
        source: "openai+scrape",
      };
    } catch (error) {
      logger.warn("Brand URL OpenAI analysis failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    url: scraped.url,
    title: scraped.title,
    brand_name: scraped.title,
    // No invented palette: the app's own teal masquerading as a brand colour is
    // worse than saying nothing, because the caller can still fall back to the
    // colours the operator saved on the client.
    colors: [],
    logo_url: logoGuess,
    logo_description: null,
    imagery_notes: scraped.services.slice(0, 3).map((s) => s.name).join(", ") || null,
    summary: `Scraped ${scraped.url} (${scraped.source}). Limited brand extraction without OpenAI.`,
    source: scraped.markdown ? "scrape_only" : "heuristic",
  };
}

function stripFence(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

/** Greys, near-whites and near-blacks: usable as tones, useless as the brand hue. */
function isNeutral(hex: string): boolean {
  const full =
    hex.length === 4
      ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
      : hex;
  const r = parseInt(full.slice(1, 3), 16);
  const g = parseInt(full.slice(3, 5), 16);
  const b = parseInt(full.slice(5, 7), 16);
  if ([r, g, b].some(Number.isNaN)) return true;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const saturation = max === 0 ? 0 : (max - min) / max;
  const lightness = (max + min) / 2 / 255;
  return saturation < 0.25 || lightness > 0.9 || lightness < 0.08;
}

function normalizeHexColor(value: string): string | null {
  const color = value.trim();
  if (!/^#?[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?$/.test(color)) return null;
  return (color.startsWith("#") ? color : `#${color}`).toLowerCase();
}

function cleanBrandName(title?: string): string | undefined {
  if (!title) return undefined;
  return title
    .split(/\s+[|–—-]\s+/)[0]
    ?.trim()
    .slice(0, 100);
}
