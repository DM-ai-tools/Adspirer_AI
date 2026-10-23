import { formatCents } from "@/lib/api-client";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import type { GoogleCandidatesResult, GoogleCategoryCandidate } from "@/lib/google/category-candidates";
import { logger } from "@/lib/observability/logger";
import { scanSiteCandidates, type ScanUnavailableReason, type SiteScanResult } from "@/lib/scraping/site-scan";
import type { CategoryCandidate } from "@/lib/scraping/site-map";
import { nowIso } from "@/lib/utils";
import type { ClientService } from "@/types";
import { categoriesFromServices, GENERIC_NAMES, scopeCategoriesFromRequest, type StrategyCategory } from "./categories";
import { escapeRegExp, normalizeUrl } from "./category-match";

/**
 * Categories added straight from a chat question: when a strategy or
 * category-spend ask names a category that isn't set up, find it in the
 * client's GA4 / Search Console data, else on the client's website (the
 * Services tab's "Scan website" scan), and add it.
 */

export type RequestKind = "strategy" | "spend";

/**
 * Where the phrase stops: "using", "with", "at", "over", "in", "to", "and",
 * "by", a period word ("last", "this", "during", "since", "vs", "versus",
 * "compared"), the next "on" / "for" / "into", or punctuation.
 */
const PHRASE_END = String.raw`(?=\s+(?:using|with|at|over|in|to|and|by|last|this|during|since|vs|versus|compared|on|for|into)\b|\s*[,?.!;:]|\s*$)`;
// The phrase sits inside a lookahead, so "for Q4 on bar stools" still reaches "on bar stools".
const STRATEGY_PHRASE = new RegExp(String.raw`\b(?:on|for|into)\s+(?=(.+?)${PHRASE_END})`, "gi");
const SPEND_PHRASE = new RegExp(
  String.raw`\b(?:spend|spent|spending|gone|went|put|invested)\s+(?:on|into)\s+(?=(.+?)${PHRASE_END})`,
  "gi",
);
const LEADING_ARTICLES = /^(?:(?:the|our|my|a|an|their|its)\s+)+/i;
/** Phrases starting with these mean money, a period, a channel, an audience or the whole account, not a category. */
const NOT_A_CATEGORY = [
  "meta", "facebook", "instagram", "google", "tiktok", "linkedin", "youtube", "microsoft", "bing",
  "ads", "ad", "advertising", "campaign", "campaigns", "creative", "creatives", "retargeting", "prospecting",
  "search", "shopping", "pmax", "display", "video", "account", "accounts", "budget", "roas", "spend",
  "next", "last", "this", "that", "these", "those", "each", "every", "all", "both", "it", "them", "us",
  "me", "everything", "today", "now", "day", "days", "week", "weeks", "month", "months", "quarter", "year",
  "growth", "black friday", "new customers", "advantage+", "reels", "stories", "brand", "brand campaigns",
  "lookalikes", "leads", "sales",
];

/**
 * Seasons and periods ("for Christmas", "for the holidays", "for summer"). Only
 * the bare season (or "<season> sale/season/push…") counts, so "summer dresses"
 * is still a category.
 */
const SEASONS = [
  "christmas", "xmas", "holiday", "holidays", "holiday season", "easter", "summer", "winter", "spring",
  "autumn", "fall", "eofy", "end of financial year", "new year", "new years", "new year's", "boxing day",
  "cyber monday", "bfcm", "black friday", "mother's day", "mothers day", "father's day", "fathers day",
  "valentine's day", "valentines day", "valentines", "back to school", "q1", "q2", "q3", "q4", "peak season",
  "halloween", "thanksgiving", "diwali", "ramadan", "eid", "lunar new year", "chinese new year",
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
  "november", "december",
];
const SEASON_RE = new RegExp(
  String.raw`^(?:${SEASONS.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/'/g, "['’]")).join("|")})(?:\s+(?:sale|sales|season|period|campaign|campaigns|push|promo|promos|rush|quarter|peak|weekend|week))?$`,
  "i",
);

/** A phrase that names a season or period, not a category. */
export function namesSeason(phrase: string): boolean {
  return SEASON_RE.test(phrase.trim());
}

/** A phrase that means money, a period, a channel, an audience or the account, not a category. */
export function notACategoryPhrase(phrase: string): boolean {
  const lower = phrase.trim().toLowerCase();
  return NOT_A_CATEGORY.some((t) => lower === t || lower.startsWith(`${t} `)) || namesSeason(lower);
}

const RANK_WORDS = "best|top|most|worst|least|highest|lowest|biggest|leading|popular|trending";
const RANK_QUALIFIERS = [
  "selling", "sellers?", "performing", "performers?", "sold", "converting", "converters?", "rated", "reviewed",
  "viewed", "purchased", "bought", "popular", "profitable", "earning", "grossing", "revenue", "roas", "spend(?:ing)?",
  "value", String.raw`\d+`,
].join("|");
const RANK_NOUNS = String.raw`products?|items?|skus?|categor(?:y|ies)|collections?|ads?|campaigns?|ad\s*sets?|creatives?|pages?|ones?|things?|stuff|lines?|brands?`;
/**
 * A ranking or superlative ("best selling products", "top 10 products", "best sellers",
 * "most popular items", "worst performing ads", "highest ROAS products"): a ranking word
 * alone, or followed by a ranking qualifier, a number or a generic noun. "Top hats" and
 * "tops" stay categories.
 */
const RANKING_RE = new RegExp(
  String.raw`^(?:best[\s-]*sellers?(?![a-z])|(?:${RANK_WORDS})(?:$|[\s-]+(?:${RANK_QUALIFIERS}|${RANK_NOUNS})(?![a-z])))`,
  "i",
);

/** A phrase that ranks things rather than naming a category ("best selling products", "top 10 items"). */
export function isRankingPhrase(phrase: string): boolean {
  return RANKING_RE.test(phrase.trim().replace(LEADING_ARTICLES, ""));
}

/** A phrase that names the client itself ("a 10x plan for During Days"). */
export function namesClient(phrase: string, clientName: string | null | undefined): boolean {
  const name = clientName?.trim().toLowerCase();
  return Boolean(name) && phrase.toLowerCase().includes(name!);
}

/** Collections that hold everything (or a promotion), never one category. */
export const GENERIC_COLLECTIONS = new Set([
  ...GENERIC_NAMES,
  "sale", "sales", "new", "new arrivals", "frontpage", "home", "best sellers", "best-sellers", "all products", "shop all",
  "best selling products", "best-selling-products", "best selling", "best-selling", "bestsellers", "bestseller",
  "trending", "featured", "popular", "new in", "clearance", "collections", "all",
]);

export type PhraseSpan = { phrase: string; start: number; end: number };

/**
 * The phrase a request names a category with, and where it sits in the request.
 * With `clientName`, a phrase naming the client is skipped too.
 */
export function requestedCategorySpan(
  request: string,
  kind: RequestKind,
  clientName?: string | null,
): PhraseSpan | null {
  const pattern = kind === "spend" ? SPEND_PHRASE : STRATEGY_PHRASE;
  for (const match of request.matchAll(pattern)) {
    const raw = match[1]!;
    const article = raw.match(LEADING_ARTICLES)?.[0] ?? "";
    const phrase = raw.slice(article.length).trim();
    if (!phrase || /[\d$€£¥%]/.test(phrase)) continue;
    if (notACategoryPhrase(phrase) || isRankingPhrase(phrase) || namesClient(phrase, clientName)) continue;
    const start = match.index! + match[0].length + article.length;
    return { phrase, start, end: start + phrase.length };
  }
  return null;
}

/**
 * The category a request clearly names: the words after "on" / "for" / "into"
 * (a category-spend ask needs "spent on" / "gone into"), up to the next
 * "using" / "with" / "at" / "over" / "in", a period word, or punctuation. Money,
 * periods, channels and audiences ("on $500/day", "for the next 30 days",
 * "spent on Meta", "spent on retargeting") don't count.
 */
export function requestedCategoryPhrase(request: string, kind: RequestKind, clientName?: string | null): string | null {
  return requestedCategorySpan(request, kind, clientName)?.phrase ?? null;
}

const APOSTROPHE = /['’]/;

/**
 * One word, singular or plural: "stools" also matches "stool", "boxes" "box",
 * "accessories" "accessory". "Men's" is matched as written (either apostrophe).
 */
function wordPattern(word: string): string {
  if (APOSTROPHE.test(word)) return word.split(APOSTROPHE).map(escapeRegExp).join("['’]");
  const lower = word.toLowerCase();
  // "Hoodies" → hoodie, "Accessories" → accessory.
  if (lower.length > 4 && lower.endsWith("ies")) return `${escapeRegExp(word.slice(0, -3))}(?:y|ie|ies)`;
  if (lower.length > 2 && /[^aeiou]y$/.test(lower)) return `${escapeRegExp(word.slice(0, -1))}(?:y|ies)`;
  const stem = /(?:ss|x|ch|sh|z)es$/.test(lower)
    ? word.slice(0, -2)
    : /[^s]s$/.test(lower) && lower.length > 3
      ? word.slice(0, -1)
      : word;
  return /[a-z]$/i.test(stem) ? `${escapeRegExp(stem)}(?:es|s)?` : escapeRegExp(stem);
}

/** Where a full name sits in the text: whole-word, case-insensitive, plural-tolerant. */
function nameOccurrences(text: string, name: string): Array<{ start: number; end: number }> {
  const words = name.trim().split(/[\s-]+/).filter(Boolean);
  if (!words.length) return [];
  const re = new RegExp(`(?<![a-z0-9])${words.map(wordPattern).join(String.raw`[\s-]+`)}(?![a-z0-9])`, "gi");
  return [...text.matchAll(re)].map((m) => ({ start: m.index!, end: m.index! + m[0].length }));
}

/**
 * Two category names with the same words, singular or plural, any case
 * ("Bar Stool" and "bar stools"); the whole name, not a part of it.
 */
export function sameCategoryName(a: string, b: string): boolean {
  const text = a.trim();
  return text !== "" && nameOccurrences(text, b).some((h) => h.start === 0 && h.end === text.length);
}

/**
 * The candidate whose full name the request contains; the longest such name
 * wins. With a phrase span, the name must overlap the phrase ("on stools for
 * the outdoor kitchen" is about Stools); a name may run past the phrase, so
 * "tables and chairs" still finds Tables and Chairs. Generic collections
 * (All, Sale, New Arrivals, …) never win.
 */
export function pickCandidateForRequest<T extends { name: string }>(
  request: string,
  candidates: T[],
  span?: PhraseSpan,
): T | null {
  let winner: T | null = null;
  for (const c of candidates) {
    const name = c.name.trim();
    if (!name || GENERIC_COLLECTIONS.has(name.toLowerCase())) continue;
    const hits = nameOccurrences(request, name);
    const inPhrase = span ? hits.some((h) => h.start < span.end && h.end > span.start) : hits.length > 0;
    if (inPhrase && (!winner || name.length > winner.name.trim().length)) winner = c;
  }
  return winner;
}

export type RequestedCategory =
  | { kind: "loaded" }
  | { kind: "none" }
  | { kind: "switched_off"; service: ClientService }
  | { kind: "matched"; phrase: string; candidate: CategoryCandidate }
  | { kind: "matched_google"; phrase: string; candidate: GoogleCategoryCandidate; currency: string | null }
  | { kind: "not_found"; phrase: string }
  | { kind: "unavailable"; phrase: string; reason: ScanUnavailableReason };

/**
 * What a request's category resolves to. Nothing is scanned when a loaded
 * category matches, the request names no category, the phrase is the
 * client's own name, or the phrase names a category that is switched off.
 * Google's candidates (GA4 / Search Console) come before the website scan;
 * Google unavailable or without a match falls through to the scan.
 */
export async function resolveRequestedCategory(input: {
  request: string;
  loaded: StrategyCategory[];
  kind: RequestKind;
  scan: () => Promise<SiteScanResult>;
  /** The client's categories from GA4 and Search Console, read before the scan. */
  google?: () => Promise<GoogleCandidatesResult>;
  /** The client's name: "a 10x plan for During Days" names the client, not a category. */
  clientName?: string;
  /** The client's inactive services. */
  switchedOff?: ClientService[];
}): Promise<RequestedCategory> {
  if (scopeCategoriesFromRequest(input.request, input.loaded).length) return { kind: "loaded" };
  const span = requestedCategorySpan(input.request, input.kind, input.clientName);
  if (!span) return { kind: "none" };
  const off = pickCandidateForRequest(input.request, input.switchedOff ?? [], span);
  if (off) return { kind: "switched_off", service: off };
  if (input.google) {
    const google = await input.google();
    if (google.source === "google") {
      const hit = pickCandidateForRequest(input.request, google.candidates, span);
      if (hit) return { kind: "matched_google", phrase: span.phrase, candidate: hit, currency: google.currency };
    }
  }
  const scanned = await input.scan();
  if (scanned.source === "unavailable") return { kind: "unavailable", phrase: span.phrase, reason: scanned.reason };
  const candidate = pickCandidateForRequest(input.request, scanned.candidates, span);
  return candidate ? { kind: "matched", phrase: span.phrase, candidate } : { kind: "not_found", phrase: span.phrase };
}

const SCAN_TTL_MS = 24 * 60 * 60 * 1000;
const scanCache = new Map<string, { at: number; result: SiteScanResult }>();
const googleCache = new Map<string, { at: number; result: GoogleCandidatesResult }>();

/** Clears remembered scans and Google candidates (tests). */
export function resetSiteScanCache(): void {
  scanCache.clear();
  googleCache.clear();
}

/** The client's Google candidates, remembered per client and website for 24 hours. Failures aren't remembered. */
export async function cachedGoogleCandidates(
  clientId: string,
  websiteUrl: string | null,
  existing: ClientService[],
): Promise<GoogleCandidatesResult> {
  const key = `${clientId}\u0000${websiteUrl ?? ""}`;
  const hit = googleCache.get(key);
  if (hit && Date.now() - hit.at < SCAN_TTL_MS) return hit.result;
  // Loaded on use: the candidates module imports this one for its name matching.
  const { googleCategoryCandidates } = await import("@/lib/google/category-candidates");
  const result = await googleCategoryCandidates({ clientId, existing, websiteUrl });
  if (result.source === "google") googleCache.set(key, { at: Date.now(), result });
  else googleCache.delete(key);
  return result;
}

/** The site scan, remembered per client and website for 24 hours. Failed scans aren't remembered. */
export async function cachedSiteScan(
  clientId: string,
  siteUrl: string | null,
  existing: ClientService[],
): Promise<SiteScanResult> {
  const key = `${clientId}\u0000${siteUrl ?? ""}`;
  const hit = scanCache.get(key);
  if (hit && Date.now() - hit.at < SCAN_TTL_MS) return hit.result;
  const result = await scanSiteCandidates({ siteUrl, existing, clientId });
  if (result.source === "firecrawl") scanCache.set(key, { at: Date.now(), result });
  else scanCache.delete(key);
  return result;
}

async function loadClient(clientId: string): Promise<{ name: string; website_url: string | null }> {
  const { getClient } = await import("@/lib/approvals/service");
  const client = await getClient(clientId);
  return { name: client.name, website_url: client.website_url ?? null };
}

async function insertService(service: ClientService): Promise<ClientService> {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    getDemoStore().clientServices.push(service);
    return service;
  }
  const { id: _id, ...insertRow } = service;
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { data, error } = await createAdminClient()
    .from("client_services")
    .insert(insertRow)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data as ClientService;
}

const UNAVAILABLE_TEXT = {
  not_configured: "the website scan isn't set up",
  no_website: "the client has no website set",
  scan_failed: "the website scan failed",
} as const;

function evidence(heading: string, line: string, instruction: string): string {
  return [heading, `- ${line}`, instruction].join("\n");
}

const switchedOff = (service: ClientService) =>
  evidence(
    "### Category switched off",
    `**${service.name}** is switched off on the Services tab; switch it on to plan on it.`,
    "Repeat the line above to the user exactly. Nothing was added.",
  );

/** The evidence headings whose line the reply must open with. */
export const CATEGORY_NOTICE_HEADINGS = [
  "### Category added from the question",
  "### Category not found",
  "### Category switched off",
] as const;

/** The line under a category notice section in the evidence ("Added **Bar Stools** …"), if any. */
export function categoryNoticeLine(evidenceText: string | null | undefined): string | null {
  if (!evidenceText) return null;
  for (const heading of CATEGORY_NOTICE_HEADINGS) {
    const at = evidenceText.indexOf(`${heading}\n- `);
    if (at < 0) continue;
    const from = at + heading.length + 3;
    const end = evidenceText.indexOf("\n", from);
    return evidenceText.slice(from, end < 0 ? undefined : end).trim();
  }
  return null;
}

export type CategoryFromRequest = {
  /** Active services for the turn, including one added from the request. */
  services: ClientService[];
  /** The service the request named when it was added (or found switched on) here. */
  scoped?: ClientService;
  /** An evidence section for the writer, when something was added or couldn't be. */
  evidence?: string;
};

/**
 * Adds the category a strategy or category-spend request names when it isn't
 * loaded yet: finds it in the client's GA4 / Search Console data (stored as an
 * `import` service with its order value), else on the client's website
 * (stored as a `site_scan` service). Never throws; on an error the turn keeps the loaded services.
 */
export async function addCategoryFromRequest(input: {
  clientId: string;
  request: string;
  kind: RequestKind;
  /** The client's active services. */
  active: ClientService[];
}): Promise<CategoryFromRequest> {
  const { clientId, request, kind, active } = input;
  // Cheap checks first: the client and the scan load only when the request needs them.
  if (scopeCategoriesFromRequest(request, categoriesFromServices(active)).length) return { services: active };
  if (!requestedCategoryPhrase(request, kind)) return { services: active };
  try {
    const client = await loadClient(clientId);
    const { listClientServices } = await import("@/lib/clients/ensure-services");
    const all = await listClientServices(clientId);
    const resolved = await resolveRequestedCategory({
      request,
      loaded: categoriesFromServices(active),
      kind,
      scan: () => cachedSiteScan(clientId, client.website_url, all),
      google: () => cachedGoogleCandidates(clientId, client.website_url, all),
      clientName: client.name,
      switchedOff: all.filter((s) => !s.is_active),
    });
    const site = client.website_url ?? "the website";
    switch (resolved.kind) {
      case "loaded":
      case "none":
        return { services: active };
      case "switched_off":
        return { services: active, evidence: switchedOff(resolved.service) };
      case "not_found":
        return {
          services: active,
          evidence: evidence(
            "### Category not found",
            `Couldn't find "${resolved.phrase}" on ${site}; add it on the Services tab.`,
            "Repeat the line above to the user exactly. Nothing was added.",
          ),
        };
      case "unavailable":
        return {
          services: active,
          evidence: evidence(
            "### Category not found",
            `Couldn't look for "${resolved.phrase}" on ${site} (${UNAVAILABLE_TEXT[resolved.reason]}); add it on the Services tab.`,
            "Repeat the line above to the user exactly. Nothing was added.",
          ),
        };
      case "matched":
      case "matched_google": {
        const { candidate } = resolved;
        // Already stored (by name, or by its page): never add a second row.
        const page = candidate.landing_page_url ? normalizeUrl(candidate.landing_page_url) : null;
        const existing = all.find(
          (s) =>
            s.name.trim().toLowerCase() === candidate.name.trim().toLowerCase() ||
            (page != null && s.landing_page_url != null && normalizeUrl(s.landing_page_url) === page),
        );
        if (existing) {
          if (existing.is_active) return { services: active, scoped: existing };
          return { services: active, evidence: switchedOff(existing) };
        }
        const fromGoogle = resolved.kind === "matched_google" ? resolved.candidate : null;
        const ts = nowIso();
        const added = await insertService({
          id: crypto.randomUUID(),
          client_id: clientId,
          name: candidate.name,
          description: null,
          keywords: null,
          landing_page_url: candidate.landing_page_url,
          priority: 0,
          is_active: true,
          gross_margin_pct: null,
          average_order_value_cents: fromGoogle?.average_order_value_cents ?? null,
          url_patterns: null,
          source: fromGoogle ? "import" : "site_scan",
          created_at: ts,
          updated_at: ts,
        });
        const where = added.landing_page_url ? ` (${added.landing_page_url})` : "";
        const from =
          resolved.kind !== "matched_google"
            ? ""
            : resolved.candidate.revenueCents > 0
              ? `, from GA4 (${formatCents(resolved.candidate.revenueCents, resolved.currency ?? "USD")} revenue, last 90 days)`
              : ", from Search Console";
        return {
          services: [...active, added],
          scoped: added,
          evidence: evidence(
            "### Category added from the question",
            `Added **${added.name}**${where} as a category for ${client.name}${from}. Set its margin on the Services tab, or tell me ("${added.name.toLowerCase()} margin is 45%"), for sharper targets.`,
            "Repeat the line above to the user exactly, near the top of the reply.",
          ),
        };
      }
    }
  } catch (error) {
    logger.warn("Category from request: couldn't add", {
      clientId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { services: active };
  }
}
