import { describe, expect, it } from "vitest";
import {
  fetchPageChecks,
  landingScore,
  pageHtmlSignals,
  pageSpeedFromResponse,
} from "@/lib/landing/inspect";
import { analyzeLandingPage } from "@/lib/landing/analyze-page";

const html = `<!doctype html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<script>!function(f,b,e,v,n,t,s){}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','123');</script>
</head><body><h1>Book your implant consult</h1>
<form><input type="text" name="name"><input type="email" name="email"><input type="hidden" name="utm"><select name="when"></select><textarea name="msg"></textarea><button type="submit">Book</button></form>
<a href="tel:+61400000000">Call</a></body></html>`;

describe("pageHtmlSignals", () => {
  it("counts visible form fields and spots the pixel, viewport and click-to-call", () => {
    expect(pageHtmlSignals(html)).toEqual({ formFields: 4, hasMetaPixel: true, hasViewport: true, hasTelLink: true });
    expect(pageHtmlSignals("<html><body><p>Hi</p></body></html>")).toEqual({
      formFields: 0,
      hasMetaPixel: false,
      hasViewport: false,
      hasTelLink: false,
    });
  });
});

describe("fetchPageChecks", () => {
  const fakeFetch = (routes: Record<string, { status: number; location?: string; body?: string }>) =>
    (async (input: string | URL) => {
      const url = String(input);
      const key = Object.keys(routes).find((k) => url.startsWith(k));
      const r = key ? routes[key]! : { status: 404 };
      return new Response(r.body ?? "", { status: r.status, headers: r.location ? { location: r.location } : {} });
    }) as typeof fetch;

  it("follows redirects and reports whether tracking parameters survive", async () => {
    const checks = await fetchPageChecks(
      "http://example.com/lp",
      fakeFetch({
        "http://example.com/lp": { status: 301, location: "https://example.com/lp?utm_source=campaignforge_check&fbclid=cf_check" },
        "https://example.com/lp": { status: 200, body: html },
      }),
    );
    expect(checks).toMatchObject({ status: 200, redirects: 1, https: true, keepsTracking: true });
    expect(checks.html).toContain("<h1>");
  });

  it("flags redirects that drop the tracking parameters, and error pages", async () => {
    const dropped = await fetchPageChecks(
      "https://example.com/lp",
      fakeFetch({
        "https://example.com/lp": { status: 302, location: "https://example.com/home" },
        "https://example.com/home": { status: 200, body: "<html></html>" },
      }),
    );
    expect(dropped.keepsTracking).toBe(false);
    const missing = await fetchPageChecks("https://example.com/gone", fakeFetch({}));
    expect(missing.status).toBe(404);
  });
});

describe("pageSpeedFromResponse", () => {
  it("reads mobile LCP, CLS, INP, page weight and the performance score", () => {
    const psi = {
      lighthouseResult: {
        categories: { performance: { score: 0.62 } },
        audits: {
          "largest-contentful-paint": { numericValue: 3100 },
          "cumulative-layout-shift": { numericValue: 0.04 },
          "total-byte-weight": { numericValue: 2_600_000 },
        },
      },
      loadingExperience: { metrics: { INTERACTION_TO_NEXT_PAINT: { percentile: 180 } } },
    };
    expect(pageSpeedFromResponse(psi)).toEqual({ performance: 62, lcpMs: 3100, cls: 0.04, inpMs: 180, pageBytes: 2_600_000 });
  });
});

describe("landingScore", () => {
  it("weights message match 25, speed 25, mobile 20, trust 15, form 15", () => {
    expect(landingScore({ messageMatch: 100, speed: 100, mobile: 100, trust: 100, form: 100 })).toBe(100);
    expect(landingScore({ messageMatch: 0, speed: 100, mobile: 100, trust: 100, form: 100 })).toBe(75);
  });

  it("scores only the parts it could measure", () => {
    expect(landingScore({ messageMatch: 60, speed: null, mobile: null, trust: 100, form: null })).toBe(Math.round((60 * 25 + 100 * 15) / 40));
    expect(landingScore({ messageMatch: null, speed: null, mobile: null, trust: null, form: null })).toBeNull();
  });
});

describe("analyzeLandingPage", () => {
  it("combines the page text, technical checks, PageSpeed and a judged message match", async () => {
    const result = await analyzeLandingPage(
      { url: "https://example.com/lp", role: "own", adContext: "Book your implant consult this week" },
      {
        scrape: async () => ({ url: "https://example.com/lp", title: "Implants", markdown: "# Book your implant consult\nRated 4.9 by 300 patients. Book now.", services: [], source: "fetch" }),
        checks: async () => ({ status: 200, redirects: 0, https: true, keepsTracking: true, finalUrl: "https://example.com/lp", html }),
        pageSpeed: async () => ({ performance: 80, lcpMs: 2100, cls: 0.02, inpMs: 150, pageBytes: 900_000 }),
        judgeMatch: async () => "exact",
      },
    );
    expect(result.messageMatch).toBe("exact");
    expect(result.score100).toBeGreaterThanOrEqual(75);
    expect(result.score).toBe("strong");
    expect(result.findings.join("\n")).toMatch(/LCP 2\.1 s/);
    expect(result.findings.join("\n")).toMatch(/4 form fields/);
    expect(result.findings.join("\n")).toMatch(/Meta pixel: found/);
  });

  it("reports an error page instead of scoring it", async () => {
    const result = await analyzeLandingPage(
      { url: "https://example.com/gone", role: "own" },
      {
        scrape: async () => ({ url: "https://example.com/gone", title: "Not found", markdown: "Page not found", services: [], source: "fetch" }),
        checks: async () => ({ status: 404, redirects: 0, https: true, keepsTracking: false, finalUrl: "https://example.com/gone", html: "" }),
        pageSpeed: async () => null,
        judgeMatch: async () => "unknown",
      },
    );
    expect(result.score).toBe("needs_work");
    expect(result.findings.join("\n")).toMatch(/returns HTTP 404/);
  });
});
