import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { logger } from "@/lib/observability/logger";
import { scanSiteCandidates, type ScanUnavailableReason, type SiteScanResult } from "@/lib/scraping/site-scan";
import type { CategoryCandidate } from "@/lib/scraping/site-map";
import { nowIso } from "@/lib/utils";
import type { ClientService } from "@/types";
import { categoriesFromServices, scopeCategoriesFromRequest, type StrategyCategory } from "./categories";
import { escapeRegExp, normalizeUrl } from "./category-match";

/**
 * Categories added straight from a chat question: when a strategy or
 * category-spend ask names a category that isn't set up, find it on the
 * client's website (the Services tab's "Scan website" scan) and add it.
 */

export type RequestKind = "strategy" | "spend";

/**
 * Where the phrase stops: "using", "with", "at", "over", "in the", "to", "and",
 * "by", the next "on" / "for" / "into", or punctuation.
 */
const PHRASE_END = String.raw`(?=\s+(?:using|with|at|over|in\s+the|to|and|by|on|for|into)\b|\s*[,?.!;:]|\s*$)`;
// The phrase sits inside a lookahead, so "for Q4 on bar stools" still reaches "on bar stools".
const STRATEGY_PHRASE = new RegExp(String.raw`\b(?:on|for|into)\s+(?=(.+?)${PHRASE_END})`, "gi");
const SPEND_PHRASE = new RegExp(
  String.raw`\b(?:spend|spent|spending|gone|went|put|invested)\s+(?:on|into)\s+(?=(.+?)${PHRASE_END})`,
  "gi",
);
const LEADING_ARTICLES = /^(?:(?:the|our|my|a|an|their|its)\s+)+/i;
/** First words that mean money, a period, a channel or the whole account, not a category. */
const NOT_A_CATEGORY = new Set([
  "meta", "facebook", "instagram", "google", "tiktok", "linkedin", "youtube", "microsoft", "bing",
  "ads", "ad", "advertising", "campaign", "campaigns", "creative", "creatives", "retargeting", "prospecting",
  "search", "shopping", "pmax", "display", "video", "account", "accounts", "budget", "roas", "spend",
  "next", "last", "this", "that", "these", "those", "each", "every", "all", "both", "it", "them", "us",
  "me", "everything", "today", "now", "day", "days", "week", "weeks", "month", "months", "quarter", "year",
]);

/**
 * The category a request clearly names: the words after "on" / "for" / "into"
 * (a category-spend ask needs "spent on" / "gone into"), up to the next
 * "using" / "with" / "at" / "over" / "in the" or punctuation. Money, periods
 * and channels ("on $500/day", "for the next 30 days", "spent on Meta") don't count.
 */
export function requestedCategoryPhrase(request: string, kind: RequestKind): string | null {
  const pattern = kind === "spend" ? SPEND_PHRASE : STRATEGY_PHRASE;
  for (const match of request.matchAll(pattern)) {
    const phrase = match[1]!.trim().replace(LEADING_ARTICLES, "").trim();
    if (!phrase || /[\d$€£¥%]/.test(phrase)) continue;
    const first = phrase.split(/\s+/)[0]!.toLowerCase();
    if (NOT_A_CATEGORY.has(first)) continue;
    return phrase;
  }
  return null;
}

/** One word, singular or plural: "stools" also matches "stool", "boxes" also "box". */
function wordPattern(word: string): string {
  const lower = word.toLowerCase();
  const stem = /(?:ss|x|ch|sh|z)es$/.test(lower)
    ? word.slice(0, -2)
    : /[^s]s$/.test(lower) && lower.length > 3
      ? word.slice(0, -1)
      : word;
  return /[a-z]$/i.test(stem) ? `${escapeRegExp(stem)}(?:es|s)?` : escapeRegExp(stem);
}

/** Whole-word, case-insensitive, plural-tolerant test for a full name in the text. */
function containsName(text: string, name: string): boolean {
  const words = name.trim().split(/[\s-]+/).filter(Boolean);
  if (!words.length) return false;
  return new RegExp(`(?<![a-z0-9])${words.map(wordPattern).join(String.raw`[\s-]+`)}(?![a-z0-9])`, "i").test(text);
}

/** The candidate whose full name the request contains; the longest such name wins. */
export function pickCandidateForRequest(
  request: string,
  candidates: CategoryCandidate[],
): CategoryCandidate | null {
  let winner: CategoryCandidate | null = null;
  for (const c of candidates) {
    if (containsName(request, c.name) && (!winner || c.name.trim().length > winner.name.trim().length)) {
      winner = c;
    }
  }
  return winner;
}

export type RequestedCategory =
  | { kind: "loaded" }
  | { kind: "none" }
  | { kind: "matched"; phrase: string; candidate: CategoryCandidate }
  | { kind: "not_found"; phrase: string }
  | { kind: "unavailable"; phrase: string; reason: ScanUnavailableReason };

/**
 * What a request's category resolves to. A loaded category that matches wins
 * and nothing is scanned; so does a request that names no category.
 */
export async function resolveRequestedCategory(input: {
  request: string;
  loaded: StrategyCategory[];
  kind: RequestKind;
  scan: () => Promise<SiteScanResult>;
}): Promise<RequestedCategory> {
  if (scopeCategoriesFromRequest(input.request, input.loaded).length) return { kind: "loaded" };
  const phrase = requestedCategoryPhrase(input.request, input.kind);
  if (!phrase) return { kind: "none" };
  const scanned = await input.scan();
  if (scanned.source === "unavailable") return { kind: "unavailable", phrase, reason: scanned.reason };
  const candidate = pickCandidateForRequest(input.request, scanned.candidates);
  return candidate ? { kind: "matched", phrase, candidate } : { kind: "not_found", phrase };
}

const SCAN_TTL_MS = 24 * 60 * 60 * 1000;
const scanCache = new Map<string, { at: number; result: SiteScanResult }>();

/** Clears remembered scans (tests). */
export function resetSiteScanCache(): void {
  scanCache.clear();
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
 * loaded yet: finds it on the client's website and stores it as a
 * `site_scan` service. Never throws; on an error the turn keeps the loaded services.
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
    });
    const site = client.website_url ?? "the website";
    switch (resolved.kind) {
      case "loaded":
      case "none":
        return { services: active };
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
      case "matched": {
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
          return {
            services: active,
            evidence: evidence(
              "### Category switched off",
              `**${existing.name}** is switched off on the Services tab; switch it on to plan on it.`,
              "Repeat the line above to the user exactly. Nothing was added.",
            ),
          };
        }
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
          average_order_value_cents: null,
          url_patterns: null,
          source: "site_scan",
          created_at: ts,
          updated_at: ts,
        });
        const where = added.landing_page_url ? ` (${added.landing_page_url})` : "";
        return {
          services: [...active, added],
          scoped: added,
          evidence: evidence(
            "### Category added from the question",
            `Added **${added.name}**${where} as a category for ${client.name}. Set its margin on the Services tab, or tell me ("${added.name.toLowerCase()} margin is 45%"), for sharper targets.`,
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
