/**
 * Lightweight landing-page quality analysis for Meta audit
 * (own destination URLs + optional competitor LPs).
 */

import { scrapeWebsiteServices } from "@/lib/scraping/firecrawl";
import { logger } from "@/lib/observability/logger";

export type LandingPageRole = "own" | "competitor";

export type LandingPageAnalysis = {
  url: string;
  role: LandingPageRole;
  title?: string;
  source: string;
  score: "strong" | "ok" | "needs_work" | "unknown";
  messageMatch: "exact" | "partial" | "weak" | "unknown";
  findings: string[];
  suggestions: string[];
  signals: {
    hasCtaLanguage: boolean;
    hasFormCue: boolean;
    hasPhoneCue: boolean;
    hasTrustCue: boolean;
    wordCount: number;
    h1Guess: string | null;
  };
  /** Ad creative text used for message-match when role=own */
  adContext?: string | null;
};

const CTA_RE =
  /\b(buy|shop|sign[- ]?up|get started|book|apply|subscribe|contact|learn more|get a quote|download|register|claim|try|start free)\b/i;
const FORM_RE =
  /\b(form|email|phone|submit|first name|last name|zip|postcode|newsletter)\b/i;
const PHONE_RE = /\b(\+?\d[\d\s().-]{7,}\d|tel:)\b/i;
const TRUST_RE =
  /\b(review|testimonial|rated|rating|stars?|guarantee|secure|trusted|customers?|as seen|award)\b/i;

function guessH1(markdown: string): string | null {
  const mdH1 = /^#\s+(.+)$/m.exec(markdown);
  if (mdH1?.[1]?.trim()) return mdH1[1].trim().slice(0, 120);
  const line = markdown
    .split(/\n/)
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .find((l) => l.length > 12 && l.length < 140 && !/^https?:/i.test(l));
  return line ?? null;
}

function messageMatchScore(
  pageText: string,
  adContext: string | null | undefined,
): LandingPageAnalysis["messageMatch"] {
  if (!adContext?.trim() || pageText.length < 40) return "unknown";
  const page = pageText.toLowerCase();
  const tokens = adContext
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 3)
    .slice(0, 24);
  if (!tokens.length) return "unknown";
  const hits = tokens.filter((t) => page.includes(t)).length;
  const ratio = hits / tokens.length;
  if (ratio >= 0.45) return "exact";
  if (ratio >= 0.2) return "partial";
  return "weak";
}

function scoreFromSignals(input: {
  wordCount: number;
  hasCta: boolean;
  hasForm: boolean;
  hasTrust: boolean;
  messageMatch: LandingPageAnalysis["messageMatch"];
  fetchFailed: boolean;
}): LandingPageAnalysis["score"] {
  if (input.fetchFailed || input.wordCount < 30) return "unknown";
  let pts = 0;
  if (input.hasCta) pts += 2;
  if (input.hasForm || input.hasTrust) pts += 1;
  if (input.wordCount >= 120) pts += 1;
  if (input.messageMatch === "exact") pts += 2;
  else if (input.messageMatch === "partial") pts += 1;
  else if (input.messageMatch === "weak") pts -= 1;
  if (pts >= 5) return "strong";
  if (pts >= 3) return "ok";
  return "needs_work";
}

export async function analyzeLandingPage(input: {
  url: string;
  role: LandingPageRole;
  adContext?: string | null;
}): Promise<LandingPageAnalysis> {
  const url = input.url;
  try {
    const scraped = await scrapeWebsiteServices(url);
    const body = (scraped.markdown ?? "").trim();
    const fetchFailed =
      scraped.source === "heuristic" && /unable to fetch/i.test(body);
    const hasCtaLanguage = CTA_RE.test(body);
    const hasFormCue = FORM_RE.test(body);
    const hasPhoneCue = PHONE_RE.test(body);
    const hasTrustCue = TRUST_RE.test(body);
    const wordCount = body.split(/\s+/).filter(Boolean).length;
    const h1Guess = guessH1(body);
    const match = messageMatchScore(body, input.adContext);
    const findings: string[] = [];
    const suggestions: string[] = [];

    if (fetchFailed) {
      findings.push("Could not fetch page content (blocked or timeout).");
      suggestions.push(
        "Open the URL manually or paste key page copy so we can re-score message match.",
      );
    } else {
      findings.push(
        `Title: ${scraped.title ?? "(none)"} · ~${wordCount} words · source ${scraped.source}`,
      );
      if (h1Guess) findings.push(`Likely H1 / hero: “${h1Guess}”`);
      findings.push(
        `CTA language: ${hasCtaLanguage ? "yes" : "weak/absent"} · Form cues: ${
          hasFormCue ? "yes" : "no"
        } · Trust cues: ${hasTrustCue ? "yes" : "no"} · Phone: ${
          hasPhoneCue ? "yes" : "no"
        }`,
      );
      if (input.role === "own" && input.adContext) {
        findings.push(`Ad→page message match: ${match}`);
      }

      if (!hasCtaLanguage) {
        suggestions.push(
          "Add a clear above-the-fold CTA that mirrors the ad button (Learn more / Sign up / Book).",
        );
      }
      if (!hasFormCue && !hasPhoneCue && input.role === "own") {
        suggestions.push(
          "Ensure lead capture (form or click-to-call) is obvious without scrolling on mobile.",
        );
      }
      if (!hasTrustCue) {
        suggestions.push(
          "Add trust signals above the fold (reviews, logos, guarantee) to lift paid conversion.",
        );
      }
      if (match === "weak") {
        suggestions.push(
          "Rewrite hero headline/offer to echo the ad primary text and headline (message match).",
        );
      }
      if (wordCount < 80) {
        suggestions.push(
          "Page content looks thin — confirm this is the final destination (not a redirect interstitial).",
        );
      }
      if (input.role === "competitor" && hasCtaLanguage && hasTrustCue) {
        suggestions.push(
          "Competitor LP shows strong CTA + trust — mirror structure on our destination without copying claims.",
        );
      }
    }

    const score = scoreFromSignals({
      wordCount,
      hasCta: hasCtaLanguage,
      hasForm: hasFormCue,
      hasTrust: hasTrustCue,
      messageMatch: match,
      fetchFailed,
    });

    return {
      url,
      role: input.role,
      title: scraped.title,
      source: scraped.source,
      score,
      messageMatch: match,
      findings,
      suggestions: suggestions.slice(0, 5),
      signals: {
        hasCtaLanguage,
        hasFormCue,
        hasPhoneCue,
        hasTrustCue,
        wordCount,
        h1Guess,
      },
      adContext: input.adContext ?? null,
    };
  } catch (error) {
    logger.warn("Landing page analysis failed", {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      url,
      role: input.role,
      source: "error",
      score: "unknown",
      messageMatch: "unknown",
      findings: [
        `Analysis failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
      suggestions: ["Retry the URL or paste the page content in chat."],
      signals: {
        hasCtaLanguage: false,
        hasFormCue: false,
        hasPhoneCue: false,
        hasTrustCue: false,
        wordCount: 0,
        h1Guess: null,
      },
      adContext: input.adContext ?? null,
    };
  }
}

export async function analyzeLandingPages(
  pages: Array<{
    url: string;
    role: LandingPageRole;
    adContext?: string | null;
  }>,
): Promise<LandingPageAnalysis[]> {
  const results = await Promise.all(
    pages.map((p) => analyzeLandingPage(p)),
  );
  return results;
}

export function formatLandingAnalysesForEvidence(
  analyses: LandingPageAnalysis[],
): string {
  if (!analyses.length) {
    return "### Landing page analysis\n- No destination URLs available to analyze.";
  }
  const own = analyses.filter((a) => a.role === "own");
  const competitors = analyses.filter((a) => a.role === "competitor");
  const blocks: string[] = ["### Landing page analysis"];

  if (own.length) {
    blocks.push("#### Own ad destinations (from Meta creatives)");
    for (const a of own) {
      blocks.push(
        [
          `- **${a.url}** · score: ${a.score} · message match: ${a.messageMatch}`,
          ...a.findings.map((f) => `  - ${f}`),
          ...a.suggestions.map((s) => `  - Suggestion: ${s}`),
        ].join("\n"),
      );
    }
  }
  if (competitors.length) {
    blocks.push("#### Competitor landing pages");
    for (const a of competitors) {
      blocks.push(
        [
          `- **${a.url}** · score: ${a.score}`,
          ...a.findings.map((f) => `  - ${f}`),
          ...a.suggestions.map((s) => `  - Suggestion: ${s}`),
        ].join("\n"),
      );
    }
    blocks.push(
      [
        "#### Competitive LP takeaways (writer)",
        "- Contrast our destinations vs competitor pages on CTA clarity, offer visibility, trust, and form friction.",
        "- Suggest concrete copy/layout changes for OUR pages — do not invent competitor legal claims.",
      ].join("\n"),
    );
  } else {
    blocks.push(
      "#### Competitor landing pages\n- Operator skipped competitor LP comparison (or none provided).",
    );
  }

  blocks.push(
    [
      "#### Writer requirements",
      "- Add a **Landing pages** section to the audit: destinations found, scores, message match, and prioritized LP suggestions.",
      "- Tie LP issues to campaigns/ads that use each URL when known.",
    ].join("\n"),
  );

  return blocks.join("\n\n");
}
