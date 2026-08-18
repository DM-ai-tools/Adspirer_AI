import { getConfig } from "@/lib/config";
import { logger } from "@/lib/observability/logger";

export type ScrapedService = {
  id: string;
  name: string;
  description?: string;
  url?: string;
};

export type FirecrawlBrandingProfile = {
  colorScheme?: "light" | "dark" | string;
  logo?: string | null;
  colors?: {
    primary?: string | null;
    secondary?: string | null;
    accent?: string | null;
    background?: string | null;
    textPrimary?: string | null;
    textSecondary?: string | null;
    link?: string | null;
  };
  fonts?: Array<{ family?: string; role?: string }>;
  images?: {
    logo?: string | null;
    favicon?: string | null;
    ogImage?: string | null;
  };
  personality?: {
    tone?: string | null;
    energy?: string | null;
    targetAudience?: string | null;
  };
};

export type WebsiteScrapeResult = {
  url: string;
  title?: string;
  markdown?: string;
  branding?: FirecrawlBrandingProfile | null;
  services: ScrapedService[];
  source: "firecrawl" | "fetch" | "heuristic";
};

/**
 * Scrape a website and extract likely services/offerings.
 * Prefers Firecrawl when FIRECRAWL_API_KEY is set; otherwise falls back to fetch + heuristics.
 */
export async function scrapeWebsiteServices(
  url: string,
): Promise<WebsiteScrapeResult> {
  const normalized = normalizeUrl(url);
  const config = getConfig();

  if (config.FIRECRAWL_API_KEY) {
    try {
      const scraped = await scrapeWithFirecrawl(
        normalized,
        config.FIRECRAWL_API_KEY,
      );
      const services = await extractServices(scraped.markdown ?? "", normalized);
      return {
        url: normalized,
        title: scraped.title,
        markdown: scraped.markdown?.slice(0, 12_000),
        branding: scraped.branding ?? null,
        services,
        source: "firecrawl",
      };
    } catch (error) {
      logger.warn("Firecrawl scrape failed; falling back to fetch", {
        error: error instanceof Error ? error.message : String(error),
        url: normalized,
      });
    }
  }

  const fetched = await scrapeWithFetch(normalized);
  const services = await extractServices(fetched.markdown ?? "", normalized);
  return {
    url: normalized,
    title: fetched.title,
    markdown: fetched.markdown?.slice(0, 12_000),
    services,
    source: fetched.source,
  };
}

function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

async function scrapeWithFirecrawl(
  url: string,
  apiKey: string,
): Promise<{
  title?: string;
  markdown?: string;
  branding?: FirecrawlBrandingProfile | null;
}> {
  const response = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url,
      formats: ["markdown", "branding"],
      onlyMainContent: true,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const payload = (await response.json().catch(() => null)) as {
    success?: boolean;
    data?: {
      markdown?: string;
      metadata?: { title?: string };
      branding?: FirecrawlBrandingProfile;
    };
    error?: string;
  } | null;
  if (!response.ok || !payload?.success) {
    throw new Error(payload?.error ?? `Firecrawl failed (${response.status})`);
  }
  return {
    markdown: payload.data?.markdown,
    title: payload.data?.metadata?.title,
    branding: payload.data?.branding ?? null,
  };
}

async function scrapeWithFetch(
  url: string,
): Promise<{ title?: string; markdown?: string; source: "fetch" | "heuristic" }> {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "AdspirerAIBot/1.0" },
      signal: AbortSignal.timeout(12_000),
    });
    const html = await response.text();
    const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return {
      title,
      markdown: text.slice(0, 12_000),
      source: "fetch",
    };
  } catch {
    return {
      title: undefined,
      markdown: `Unable to fetch ${url}. Ask the operator to paste service names manually.`,
      source: "heuristic",
    };
  }
}

async function extractServices(
  content: string,
  pageUrl: string,
): Promise<ScrapedService[]> {
  const config = getConfig();
  if (config.hasOpenAI && config.OPENAI_API_KEY && content.trim().length > 40) {
    try {
      const { generateText } = await import("ai");
      const { createOpenAI } = await import("@ai-sdk/openai");
      const openai = createOpenAI({ apiKey: config.OPENAI_API_KEY });
      const { text } = await generateText({
        model: openai(config.OPENAI_MODEL),
        temperature: 0.1,
        maxOutputTokens: 700,
        system:
          "Extract business services/offerings from website content. Return ONLY JSON: {\"services\":[{\"name\":\"\",\"description\":\"\"}]} with 3-12 items. No markdown.",
        prompt: `Website: ${pageUrl}\n\nContent:\n${content.slice(0, 9000)}`,
      });
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]) as {
          services?: Array<{ name?: string; description?: string }>;
        };
        const services = (parsed.services ?? [])
          .filter((s) => s.name?.trim())
          .map((s, i) => ({
            id: `svc_${i + 1}`,
            name: String(s.name).trim(),
            description: s.description?.trim(),
            url: pageUrl,
          }));
        if (services.length) return services;
      }
    } catch (error) {
      logger.warn("Service extraction via OpenAI failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return heuristicServices(content, pageUrl);
}

function heuristicServices(content: string, pageUrl: string): ScrapedService[] {
  const candidates = content
    .split(/[\n•|-]+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 3 && l.length < 80)
    .filter((l) =>
      /service|solution|offer|product|consult|design|marketing|ads|seo|web|care|treatment|package/i.test(
        l,
      ),
    )
    .slice(0, 8);

  if (candidates.length) {
    return candidates.map((name, i) => ({
      id: `svc_${i + 1}`,
      name,
      url: pageUrl,
    }));
  }

  return [
    {
      id: "svc_1",
      name: "Core offering",
      description: "Primary service from homepage (confirm with operator)",
      url: pageUrl,
    },
    {
      id: "svc_2",
      name: "Secondary offering",
      description: "Secondary service / package (confirm with operator)",
      url: pageUrl,
    },
  ];
}
