/**
 * Technical landing-page checks for paid traffic: does the URL load (status,
 * redirects, HTTPS), do UTMs and fbclid survive the redirects, how long is
 * the form, is the Meta pixel on the page, and how fast is it on mobile
 * (Google PageSpeed Insights). Thresholds follow Core Web Vitals.
 */

const TRACKING_PARAMS = { utm_source: "campaignforge_check", fbclid: "cf_check" };

export type PageChecks = {
  /** Final HTTP status; 0 when the page couldn't be reached. */
  status: number;
  redirects: number;
  https: boolean;
  /** UTMs and fbclid still on the final URL after redirects. */
  keepsTracking: boolean;
  finalUrl: string;
  html: string;
};

export type PageSpeed = {
  /** Lighthouse mobile performance score, 0–100. */
  performance: number | null;
  lcpMs: number | null;
  cls: number | null;
  /** Field data (real users); null when Google has none for the page. */
  inpMs: number | null;
  pageBytes: number | null;
};

export type HtmlSignals = {
  formFields: number;
  hasMetaPixel: boolean;
  hasViewport: boolean;
  hasTelLink: boolean;
};

/** Fetch the page as an ad click would, following redirects by hand. */
export async function fetchPageChecks(url: string, fetchImpl: typeof fetch = fetch): Promise<PageChecks> {
  const start = new URL(url);
  for (const [k, v] of Object.entries(TRACKING_PARAMS)) start.searchParams.set(k, v);
  let current = start.toString();
  let redirects = 0;
  try {
    for (;;) {
      const res = await fetchImpl(current, {
        redirect: "manual",
        headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) CampaignForge-LP-check" },
        signal: AbortSignal.timeout(15_000),
      });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location && redirects < 5) {
        current = new URL(location, current).toString();
        redirects += 1;
        continue;
      }
      const final = new URL(current);
      return {
        status: res.status,
        redirects,
        https: final.protocol === "https:",
        keepsTracking: Object.entries(TRACKING_PARAMS).every(([k, v]) => final.searchParams.get(k) === v),
        finalUrl: current,
        html: res.ok ? (await res.text()).slice(0, 500_000) : "",
      };
    }
  } catch {
    return { status: 0, redirects, https: current.startsWith("https:"), keepsTracking: false, finalUrl: current, html: "" };
  }
}

/** Form length, pixel, mobile viewport and click-to-call, from the raw HTML. */
export function pageHtmlSignals(html: string): HtmlSignals {
  const forms = html.match(/<form[\s\S]*?<\/form>/gi) ?? [];
  let formFields = 0;
  for (const form of forms) {
    const inputs = form.match(/<input\b[^>]*>/gi) ?? [];
    formFields += inputs.filter((i) => !/type\s*=\s*["']?(hidden|submit|button|image|reset)/i.test(i)).length;
    formFields += (form.match(/<select\b/gi) ?? []).length + (form.match(/<textarea\b/gi) ?? []).length;
  }
  return {
    formFields,
    hasMetaPixel: /connect\.facebook\.net\/[^"']*fbevents\.js|fbq\(\s*['"]init['"]/i.test(html),
    hasViewport: /<meta[^>]+name=["']viewport["']/i.test(html),
    hasTelLink: /href=["']tel:/i.test(html),
  };
}

/** Mobile metrics from a PageSpeed Insights v5 response. */
export function pageSpeedFromResponse(json: unknown): PageSpeed | null {
  const root = (json ?? {}) as {
    lighthouseResult?: {
      categories?: { performance?: { score?: number } };
      audits?: Record<string, { numericValue?: number }>;
    };
    loadingExperience?: { metrics?: Record<string, { percentile?: number }> };
  };
  const audits = root.lighthouseResult?.audits;
  if (!audits) return null;
  const numeric = (key: string) => {
    const v = audits[key]?.numericValue;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  const score = root.lighthouseResult?.categories?.performance?.score;
  const inp = root.loadingExperience?.metrics?.INTERACTION_TO_NEXT_PAINT?.percentile;
  return {
    performance: typeof score === "number" ? Math.round(score * 100) : null,
    lcpMs: numeric("largest-contentful-paint"),
    cls: numeric("cumulative-layout-shift"),
    inpMs: typeof inp === "number" ? inp : null,
    pageBytes: numeric("total-byte-weight"),
  };
}

/** Google PageSpeed Insights, mobile. Best effort: null when unavailable. */
export async function fetchPageSpeed(url: string, fetchImpl: typeof fetch = fetch): Promise<PageSpeed | null> {
  const api = new URL("https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
  api.searchParams.set("url", url);
  api.searchParams.set("strategy", "mobile");
  api.searchParams.set("category", "performance");
  if (process.env.PAGESPEED_API_KEY) api.searchParams.set("key", process.env.PAGESPEED_API_KEY);
  try {
    const res = await fetchImpl(api.toString(), { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return null;
    return pageSpeedFromResponse(await res.json());
  } catch {
    return null;
  }
}

/** 0–100 for speed from Core Web Vitals (good / needs improvement / poor). */
export function speedScore(speed: PageSpeed | null): number | null {
  if (!speed) return null;
  const band = (v: number | null, good: number, poor: number) => (v == null ? null : v <= good ? 100 : v <= poor ? 50 : 0);
  const parts = [band(speed.lcpMs, 2500, 4000), band(speed.cls, 0.1, 0.25), band(speed.inpMs, 200, 500)].filter(
    (v): v is number => v != null,
  );
  return parts.length ? Math.round(parts.reduce((a, b) => a + b, 0) / parts.length) : null;
}

/** 1–3 fields convert best; long forms lose people. null when there's no form. */
export function formScore(fields: number): number | null {
  if (fields === 0) return null;
  return fields <= 3 ? 100 : fields === 4 ? 70 : 40;
}

const WEIGHTS = { messageMatch: 25, speed: 25, mobile: 20, trust: 15, form: 15 } as const;

/** Weighted 0–100 over the parts that could be measured; null when none could. */
export function landingScore(parts: Record<keyof typeof WEIGHTS, number | null>): number | null {
  let total = 0;
  let weights = 0;
  for (const [key, weight] of Object.entries(WEIGHTS) as Array<[keyof typeof WEIGHTS, number]>) {
    const v = parts[key];
    if (v == null) continue;
    total += v * weight;
    weights += weight;
  }
  return weights ? Math.round(total / weights) : null;
}
