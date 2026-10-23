import type { AgentHistoryMessage } from "@/lib/agent/history";
import { parseComparisonRanges, parseNaturalDateRange } from "@/lib/agent/natural-dates";
import {
  extractHttpUrls,
  isCompetitorLandingSkip,
  isCompetitorLandingYesPending,
} from "@/lib/landing/urls";

export type AuditScope = "account" | "campaigns";

export type CompetitorLandingChoice = "unset" | "skip" | "provided";

export type AuditBrief = {
  scope: AuditScope | null;
  /** Free-text campaign names/ids the operator mentioned */
  campaignHints: string[];
  /** "the active campaign", "all live campaigns" — whatever is delivering now. */
  activeCampaigns: boolean;
  dateStart: string | null;
  dateStop: string | null;
  dateLabel: string | null;
  /** A comparison range the operator named ("Oct 19-20 vs Oct 17-18"); null means the previous period of the same length. */
  compareStart: string | null;
  compareStop: string | null;
  compareLabel: string | null;
  /** Whether competitor LPs should be compared */
  competitorLanding: CompetitorLandingChoice;
  /** Competitor landing page URLs from chat (Excel URLs merged at gather time) */
  competitorUrls: string[];
  missing: Array<"scope" | "campaigns" | "date_range" | "competitor_landing">;
  ready: boolean;
};

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * The window a question asks for, as whole days: "last N days" ends yesterday (today is a part
 * day, so GA4 and Meta would disagree on it), as does "this month". An explicit "today" or
 * "yesterday" is left as asked. No stated period means the last 30 whole days.
 */
export function completedDaysRange(text: string): { dateStart: string; dateStop: string; dateLabel: string; days: number } {
  const parsed = parseDateRangeFromText(text) ?? parseDateRangeFromText("last 30 days")!;
  const today = isoDate(startOfUtcDay(new Date()));
  const shift = (day: string, by: number) => {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + by);
    return isoDate(d);
  };
  let { dateStart, dateStop } = parsed;
  if (dateStop >= today && parsed.dateLabel !== "today") {
    if (/^last /.test(parsed.dateLabel)) {
      dateStart = shift(dateStart, -1);
      dateStop = shift(dateStop, -1);
    } else if (dateStart < today) {
      dateStop = shift(today, -1);
    }
  }
  const days = Math.round((Date.parse(`${dateStop}T00:00:00Z`) - Date.parse(`${dateStart}T00:00:00Z`)) / 86_400_000) + 1;
  return { dateStart, dateStop, dateLabel: parsed.dateLabel, days };
}

/** Parse relative / absolute date ranges from operator text. */
export function parseDateRangeFromText(text: string): {
  dateStart: string;
  dateStop: string;
  dateLabel: string;
} | null {
  const lower = text.toLowerCase();
  const today = startOfUtcDay(new Date());
  const stop = isoDate(today);

  const lastN = /\blast\s+(\d+)\s+days?\b/.exec(lower);
  if (lastN) {
    const n = Math.min(365, Math.max(1, Number(lastN[1])));
    const start = new Date(today);
    start.setUTCDate(start.getUTCDate() - (n - 1));
    return {
      dateStart: isoDate(start),
      dateStop: stop,
      dateLabel: `last ${n} days`,
    };
  }

  if (/\blast\s+week\b|\bpast\s+week\b/.test(lower)) {
    const start = new Date(today);
    start.setUTCDate(start.getUTCDate() - 6);
    return { dateStart: isoDate(start), dateStop: stop, dateLabel: "last 7 days" };
  }
  if (/\bpast\s+30\s+days\b|\blast\s+30\b/.test(lower)) {
    const start = new Date(today);
    start.setUTCDate(start.getUTCDate() - 29);
    return {
      dateStart: isoDate(start),
      dateStop: stop,
      dateLabel: "last 30 days",
    };
  }
  if (/\blast\s+90\s+days\b|\bpast\s+quarter\b|\blast\s+quarter\b/.test(lower)) {
    const start = new Date(today);
    start.setUTCDate(start.getUTCDate() - 89);
    return {
      dateStart: isoDate(start),
      dateStop: stop,
      dateLabel: "last 90 days",
    };
  }
  if (/\bthis\s+month\b/.test(lower)) {
    const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    return {
      dateStart: isoDate(start),
      dateStop: stop,
      dateLabel: "this month",
    };
  }
  if (/\byesterday\b/.test(lower)) {
    const y = new Date(today);
    y.setUTCDate(y.getUTCDate() - 1);
    const day = isoDate(y);
    return { dateStart: day, dateStop: day, dateLabel: "yesterday" };
  }
  if (/\btoday\b/.test(lower) && /\b(spend|audit|range|date)\b/.test(lower)) {
    return { dateStart: stop, dateStop: stop, dateLabel: "today" };
  }

  const isoRange =
    /\b(20\d{2}-\d{2}-\d{2})\s*(?:to|through|–|-|until)\s*(20\d{2}-\d{2}-\d{2})\b/i.exec(
      text,
    );
  if (isoRange) {
    return {
      dateStart: isoRange[1],
      dateStop: isoRange[2],
      dateLabel: `${isoRange[1]} → ${isoRange[2]}`,
    };
  }

  // "1st sept to 15th sept", "Sep 1-15", "01/09/2026 to 15/09/2026",
  // "September 2026", "last month"…
  return parseNaturalDateRange(text);
}

/** Words and punctuation that make up a date phrase ("from 9th sept to 12th sept", "last 7 days"). */
const DATE_WORDS =
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|\d{1,4}(?:st|nd|rd|th)?|to|and|from|till|until|through|thru|of|the|for|on|between|last|this|next|past|days?|weeks?|months?|quarter|year|today|yesterday|vs|versus|compared?|comparing|with|against|before|prior|previous|preceding|period)\b|[/\-–—.,]/gi;

/**
 * "for 16th sept and 17th sept", "for last 7 days", "for the same period" are
 * dates or filler, not campaign names — treating them as names made the
 * audit look for a campaign that doesn't exist and fetch nothing.
 */
function isNotACampaignName(hint: string): boolean {
  const h = hint.trim();
  // Only a hint that is nothing but a date — "TR | Lead Gen | Sep 2026" is a name.
  if (parseDateRangeFromText(h) && !h.replace(DATE_WORDS, "").trim()) return true;
  if (/^(that|which|currently|active|live|running|delivering)\b/i.test(h)) return true;
  if (/^(the\s+)?(same|whole|entire|full|this|that|previous|last|next)\b/i.test(h)) return true;
  if (/^(the\s+)?(audit|report|account|period|dates?|range|days?|weeks?|months?|time|it|me|us)\b/i.test(h)) return true;
  return false;
}

/** "the active campaign", "all live campaigns", "campaigns that are running". */
const ACTIVE_CAMPAIGNS =
  /\b(?:active|live|running|delivering|enabled)\s+(?:meta\s+|facebook\s+|fb\s+)?campaigns?\b|\bcampaigns?\s+(?:that\s+|which\s+)?(?:is\s+|are\s+)?(?:currently\s+)?(?:active|live|running|delivering)\b/;

function parseScope(text: string): {
  scope: AuditScope | null;
  campaignHints: string[];
  activeCampaigns: boolean;
} {
  const lower = text.toLowerCase();
  const campaignHints: string[] = [];

  if (
    /\b(entire|whole|full|complete)\s+(ad\s+)?account\b/.test(lower) ||
    /\ball\s+campaigns\b/.test(lower) ||
    /\baccount[- ]wide\b/.test(lower) ||
    /\baudit\s+(the\s+)?(whole\s+|entire\s+)?account\b/.test(lower) ||
    (/\b(audit|review|diagnos|analy[sz])\b/.test(lower) &&
      /\b(ad\s+)?account\b/.test(lower) &&
      !/\bcampaigns?\b/.test(lower))
  ) {
    return { scope: "account", campaignHints: [], activeCampaigns: false };
  }

  const named = [
    ...text.matchAll(
      /\bcampaigns?\s+["“]?([^"”\n,]+?)["”]?(?=\s+and\s+|\s*,|\s*$|\s+for\b|\s+from\b|\s+last\b|\s+in\b)/gi,
    ),
  ];
  for (const m of named) {
    const hint = m[1]?.trim();
    if (hint && hint.length > 1 && !/^(the|all|my|our|this|these)$/i.test(hint) && !isNotACampaignName(hint)) {
      campaignHints.push(hint);
    }
  }

  const forNamed =
    /\b(?:for|on)\s+(?:the\s+)?(?:campaign\s+)?["“]?([A-Za-z0-9][^"”\n]{2,80}?)["”]?\s*(?=$|\.|,|\blast\b|\bfrom\b|\bto\b)/i.exec(
      text,
    );
  if (forNamed?.[1] && !/\baccount\b/i.test(forNamed[1]) && !isNotACampaignName(forNamed[1])) {
    const hint = forNamed[1].trim();
    if (
      hint.length > 2 &&
      !/^(this|that|these|those|it|them|me)$/i.test(hint) &&
      !campaignHints.some((h) => h.toLowerCase() === hint.toLowerCase())
    ) {
      campaignHints.push(hint);
    }
  }

  const ids = [...text.matchAll(/\b(120\d{10,})\b/g)].map((m) => m[1]);
  for (const id of ids) {
    if (!campaignHints.includes(id)) campaignHints.push(id);
  }

  const activeCampaigns = ACTIVE_CAMPAIGNS.test(lower);
  if (
    campaignHints.length ||
    activeCampaigns ||
    /\b(specific|particular|selected|these|those)\s+campaigns?\b/.test(lower)
  ) {
    return { scope: "campaigns", campaignHints, activeCampaigns };
  }

  if (/\bcampaigns?\b/.test(lower) && !/\baccount\b/.test(lower)) {
    return { scope: "campaigns", campaignHints, activeCampaigns };
  }

  return { scope: null, campaignHints: [], activeCampaigns: false };
}

function parseCompetitorLanding(text: string): {
  choice: CompetitorLandingChoice;
  urls: string[];
} {
  const urls = extractHttpUrls(text);
  if (urls.length) {
    return { choice: "provided", urls };
  }
  if (isCompetitorLandingSkip(text)) {
    return { choice: "skip", urls: [] };
  }
  // "yes" / "I'll upload" alone → still unset (need URLs or a file)
  if (isCompetitorLandingYesPending(text)) {
    return { choice: "unset", urls: [] };
  }
  return { choice: "unset", urls: [] };
}

function finalizeBrief(partial: {
  scope: AuditScope | null;
  campaignHints: string[];
  activeCampaigns: boolean;
  dateStart: string | null;
  dateStop: string | null;
  dateLabel: string | null;
  compareStart: string | null;
  compareStop: string | null;
  compareLabel: string | null;
  competitorLanding: CompetitorLandingChoice;
  competitorUrls: string[];
}): AuditBrief {
  const missing: AuditBrief["missing"] = [];
  if (!partial.scope) missing.push("scope");
  if (partial.scope === "campaigns" && partial.campaignHints.length === 0 && !partial.activeCampaigns) {
    missing.push("campaigns");
  }
  if (!partial.dateStart || !partial.dateStop) missing.push("date_range");
  // Competitor LPs are optional — do not block the initial audit.
  // Only treat as missing when they said they would provide URLs but none were found.
  if (
    partial.competitorLanding === "provided" &&
    partial.competitorUrls.length === 0
  ) {
    missing.push("competitor_landing");
  }

  return {
    ...partial,
    missing,
    ready: missing.length === 0,
  };
}

function mergeBriefs(parts: AuditBrief[]): AuditBrief {
  let scope: AuditScope | null = null;
  const campaignHints: string[] = [];
  let activeCampaigns = false;
  let dateStart: string | null = null;
  let dateStop: string | null = null;
  let dateLabel: string | null = null;
  let compareStart: string | null = null;
  let compareStop: string | null = null;
  let compareLabel: string | null = null;
  let competitorLanding: CompetitorLandingChoice = "unset";
  const competitorUrls: string[] = [];

  for (const part of parts) {
    if (part.scope) scope = part.scope;
    if (part.activeCampaigns) activeCampaigns = true;
    for (const h of part.campaignHints) {
      if (!campaignHints.some((x) => x.toLowerCase() === h.toLowerCase())) {
        campaignHints.push(h);
      }
    }
    if (part.dateStart && part.dateStop) {
      dateStart = part.dateStart;
      dateStop = part.dateStop;
      dateLabel = part.dateLabel;
      // A later single range drops an earlier comparison.
      compareStart = part.compareStart;
      compareStop = part.compareStop;
      compareLabel = part.compareLabel;
    }
    if (part.competitorLanding === "skip") {
      competitorLanding = "skip";
    } else if (part.competitorLanding === "provided") {
      competitorLanding = "provided";
    }
    for (const u of part.competitorUrls) {
      if (!competitorUrls.some((x) => x.toLowerCase() === u.toLowerCase())) {
        competitorUrls.push(u);
      }
    }
  }

  if (competitorUrls.length && competitorLanding === "unset") {
    competitorLanding = "provided";
  }

  return finalizeBrief({
    scope,
    campaignHints,
    activeCampaigns,
    dateStart,
    dateStop,
    dateLabel,
    compareStart,
    compareStop,
    compareLabel,
    competitorLanding,
    competitorUrls,
  });
}

function briefFromText(text: string): AuditBrief {
  const { scope, campaignHints, activeCampaigns } = parseScope(text);
  // "A vs B" names both ranges; otherwise one range, compared with the period before.
  const pair = parseComparisonRanges(text);
  const range = pair?.current ?? parseDateRangeFromText(text);
  const competitor = parseCompetitorLanding(text);

  return finalizeBrief({
    scope,
    campaignHints,
    activeCampaigns,
    dateStart: range?.dateStart ?? null,
    dateStop: range?.dateStop ?? null,
    dateLabel: range?.dateLabel ?? null,
    compareStart: pair?.comparison.dateStart ?? null,
    compareStop: pair?.comparison.dateStop ?? null,
    compareLabel: pair?.comparison.dateLabel ?? null,
    competitorLanding: competitor.choice,
    competitorUrls: competitor.urls,
  });
}

/**
 * Resolve audit scope + date range + competitor LP choice from the latest
 * message, filling gaps from recent chat turns.
 */
export function resolveAuditBrief(
  request: string,
  history: AgentHistoryMessage[] = [],
): AuditBrief {
  const recentUser = history
    .filter((m) => m.role === "user")
    .slice(-8)
    .map((m) => m.content);
  const parts = [...recentUser, request].map(briefFromText);
  return mergeBriefs(parts);
}

/**
 * Merge URLs found in uploaded workspace documents (Excel/CSV/etc.) into the brief.
 */
export function applyCompetitorUrlsFromDocuments(
  brief: AuditBrief,
  documentTexts: string[],
): AuditBrief {
  const fromDocs = documentTexts.flatMap((t) => extractHttpUrls(t, 30));
  if (!fromDocs.length) return brief;
  const competitorUrls = [...brief.competitorUrls];
  for (const u of fromDocs) {
    if (!competitorUrls.some((x) => x.toLowerCase() === u.toLowerCase())) {
      competitorUrls.push(u);
    }
  }
  return finalizeBrief({
    ...brief,
    competitorLanding: "provided",
    competitorUrls,
  });
}

export function buildAuditClarifyingQuestion(brief: AuditBrief): string {
  const lines: string[] = [
    "I can run a **Meta Ads best-practice audit** (including your ad destination / landing pages) — I just need a couple of details first:",
    "",
  ];

  let n = 0;
  const step = (text: string) => {
    n += 1;
    lines.push(`${n}. ${text}`);
  };

  if (brief.missing.includes("scope")) {
    step(
      "**Scope** — should I audit the **entire ad account**, or only **specific campaign(s)**?",
    );
  }
  if (brief.missing.includes("campaigns")) {
    step(
      "**Which campaigns?** Name them (or paste campaign IDs). I can list live campaigns if helpful.",
    );
  }
  if (brief.missing.includes("date_range")) {
    step(
      "**Date range** — e.g. last 7 days, last 30 days, this month, or `YYYY-MM-DD` to `YYYY-MM-DD`.",
    );
  }
  if (brief.missing.includes("competitor_landing")) {
    step(
      [
        "**Competitor landing pages** — you said you wanted to compare, but I don’t have URLs yet.",
        "   - **Paste** competitor landing page URLs, or",
        "   - **Upload an Excel/CSV** (paperclip) with landing page / URL columns, or",
        "   - Reply **skip** to continue without competitor comparison.",
      ].join("\n"),
    );
  }

  lines.push(
    "",
    "Reply with the missing piece(s) and I’ll run the full audit (spend, creatives, **your Meta landing pages**, what’s working, what to improve, recommendations). Competitor LP comparison is optional — you can add URLs later. I won’t change any campaigns until you explicitly ask to **optimize**.",
  );
  return lines.join("\n");
}

/** Short replies that complete an in-progress audit brief (scope / dates / LPs). */
export function looksLikeAuditBriefReply(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 800) return false;
  if (parseDateRangeFromText(t)) return true;
  if (extractHttpUrls(t).length > 0) return true;
  if (isCompetitorLandingSkip(t)) return true;
  if (isCompetitorLandingYesPending(t)) return true;
  if (
    /\b(entire|whole|full|complete)\s+(ad\s+)?account\b/i.test(t) ||
    /\ball\s+campaigns\b/i.test(t) ||
    /\baccount[- ]wide\b/i.test(t)
  ) {
    return true;
  }
  if (/\bcampaigns?\b/i.test(t) && t.length < 200) return true;
  if (/\b(120\d{10,})\b/.test(t)) return true;
  return false;
}

/** Match operator campaign hints against live campaign names/ids. */
export function matchCampaignsByHints<T extends { id: string; name: string }>(
  campaigns: T[],
  hints: string[],
): T[] {
  if (!hints.length) return [];
  const matched: T[] = [];
  for (const hint of hints) {
    const h = hint.trim().toLowerCase();
    if (!h) continue;
    const exactId = campaigns.find((c) => c.id === hint.trim());
    if (exactId) {
      if (!matched.some((m) => m.id === exactId.id)) matched.push(exactId);
      continue;
    }
    const byName = campaigns.filter((c) => {
      const n = c.name.toLowerCase();
      return n === h || n.includes(h) || h.includes(n);
    });
    for (const c of byName) {
      if (!matched.some((m) => m.id === c.id)) matched.push(c);
    }
  }
  return matched;
}

/**
 * The campaigns a campaign-scoped audit covers: the ones named, plus every
 * campaign that is on when the operator asked for "the active campaign(s)".
 */
export function resolveAuditCampaigns<T extends { id: string; name: string; status: string }>(
  campaigns: T[],
  brief: Pick<AuditBrief, "campaignHints" | "activeCampaigns">,
): T[] {
  const matched = matchCampaignsByHints(campaigns, brief.campaignHints);
  if (brief.activeCampaigns) {
    for (const c of campaigns) {
      if (c.status === "ACTIVE" && !matched.some((m) => m.id === c.id)) matched.push(c);
    }
  }
  return matched;
}
