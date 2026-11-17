import type { AgentHistoryMessage } from "@/lib/agent/history";
import { businessTypeOf } from "@/lib/analysis/shared-rules";
import type { AuditAd, MetaAuditSnapshot } from "@/lib/audit/meta-audit-data";
import type { ResolvedGoals } from "@/lib/clients/goals";

/**
 * What the strategy knows about the business, so it asks the client as little as possible.
 *
 * Each profile item is settled in this order:
 *   1. the operator said it in chat → "stated" (the writer uses their words);
 *   2. the account's own data answers it → "fromData", with the source, listed under Assumptions;
 *   3. a sensible default exists → "assumed", listed under Assumptions;
 *   4. otherwise, and only when the answer would change a target or an action → "ask" (at most three).
 * Items saved in the client's goals are already in "Profile known" and never appear here.
 */

export type ProfileItem = { item: string; value: string; source: string };
export type ProfileQuestion = { item: string; question: string; why: string };
export type ProfileResolution = {
  stated: string[];
  fromData: ProfileItem[];
  assumed: ProfileItem[];
  ask: ProfileQuestion[];
};

type Money = (cents: number) => string;

const MAX_QUESTIONS = 3;

/** What the operator's own words already cover. Checked over the request and their earlier messages only. */
const STATED: Record<string, RegExp> = {
  "what they sell": /industry|sector|niche|we sell|we are an? /i,
  offer: /\boffer|discount|promo/i,
  "risk appetite": /risk|aggressive|conservative|cautious/i,
  constraints: /constraint|can'?t|cannot|only (?:in|sell|ship|target)|limit(?:ed)? to/i,
  "creative assets": /creative|videos?\b|images?\b|assets|ugc/i,
  owners: /owner|agency|in-house|who will/i,
  goal: /\b(?:cpa|cpl|roas|cost per (?:purchase|lead|sale|result))\b/i,
  timeframe: /\bin\s+\d+\s*(?:days?|weeks?|months?)\b|\bby (?:the )?end of\b|\bby (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i,
  budget: /budget|\$\s?\d[\d,]*\s*(?:\/|per|a)\s*(?:day|month)/i,
  margin: /margin/i,
  "lead quality": /crm|qualified|lead quality|close rate/i,
};

function statedInChat(request: string, history: AgentHistoryMessage[]): Set<string> {
  const chat = [request, ...history.filter((m) => m.role === "user").map((m) => m.content)].join("\n");
  return new Set(Object.entries(STATED).filter(([, re]) => re.test(chat)).map(([item]) => item));
}

const spend = (p: { spendCents: number } | null | undefined) => p?.spendCents ?? 0;

/** Ad set name parts that describe the audience or the build, not what is sold. */
const AUDIENCE_PART =
  /\b(?:retarget\w*|remarket\w*|prospect\w*|broad|interests?|lookalike|lal|advantage\+?|audiences?|visitors?|engagers?|custom audiences?|cold|warm|dpa|asc|cbo|abo|\d+\s*-\s*\d+|\d+d)\b/i;

/** "Implants – Broad AU 30-65" → "Implants"; "Retargeting – Website visitors 30d" → nothing. */
function productPart(name: string): string | null {
  const parts = name
    .split(/\s+[–—|-]\s+|:\s+/)
    .map((p) => p.trim())
    .filter((p) => p && !AUDIENCE_PART.test(p));
  return parts[0] ?? null;
}

function formatWord(format: string | null): string {
  const f = (format ?? "").toUpperCase();
  if (f === "VIDEO") return "video";
  if (f === "DYNAMIC") return "dynamic";
  if (f === "CAROUSEL") return "carousel";
  return "image";
}

function creativeSummary(ads: AuditAd[]): string | null {
  if (!ads.length) return null;
  const live = ads.filter((a) => a.status === "ACTIVE");
  const counts = new Map<string, number>();
  for (const a of live) counts.set(formatWord(a.format), (counts.get(formatWord(a.format)) ?? 0) + 1);
  const mix = [...counts.entries()].map(([f, n]) => `${n} ${f}`).join(", ");
  const pausedVideos = ads.filter((a) => a.status !== "ACTIVE" && formatWord(a.format) === "video").length;
  const head = live.length ? `${live.length} live ad${live.length === 1 ? "" : "s"} (${mix})` : "no live ads";
  return pausedVideos ? `${head}; ${pausedVideos} paused video ad${pausedVideos === 1 ? "" : "s"} available` : head;
}

/** The first one or two sentences of the top-spending ad's copy: what the ads lead with. */
function offerFromCopy(ads: AuditAd[]): ProfileItem | null {
  const top = [...ads].filter((a) => a.copy && a.copy.trim()).sort((a, b) => spend(b.performance) - spend(a.performance))[0];
  if (!top?.copy) return null;
  const flat = top.copy.replace(/\s+/g, " ").trim();
  const value = flat.length > 160 ? `${flat.slice(0, 157).trimEnd()}…` : flat;
  return { item: "offer", value: `the ads lead with: "${value}"`, source: `copy of the top-spending ad "${top.name}"` };
}

export function resolveProfile(input: {
  snapshot: MetaAuditSnapshot;
  goals: ResolvedGoals;
  request: string;
  history: AgentHistoryMessage[];
  money: Money;
  /** The client's saved services or categories, when any. */
  services?: string[];
}): ProfileResolution {
  const { snapshot, goals, money } = input;
  const stated = statedInChat(input.request, input.history ?? []);
  const type = businessTypeOf(snapshot, goals.business_model);
  const totals = snapshot.totals;
  const days = Math.max(1, snapshot.period.days);
  const window = `the account's last ${days} days`;

  const fromData: ProfileItem[] = [];
  const assumed: ProfileItem[] = [];
  const ask: ProfileQuestion[] = [];
  const open = (item: string) => !stated.has(item);

  // What they sell: saved services first, else the names of the ad sets that spent.
  if (open("what they sell")) {
    const services = (input.services ?? []).map((s) => s.trim()).filter(Boolean);
    if (services.length) {
      fromData.push({ item: "what they sell", value: services.slice(0, 6).join(", "), source: "the client's saved services" });
    } else {
      const names = [...snapshot.adSets]
        .filter((a) => spend(a.performance) > 0)
        .sort((a, b) => spend(b.performance) - spend(a.performance))
        .map((a) => productPart(a.name))
        .filter((n): n is string => !!n)
        .filter((n, i, all) => all.indexOf(n) === i)
        .slice(0, 4);
      if (names.length) fromData.push({ item: "what they sell", value: names.join(", "), source: "the ad set names that took spend" });
      else assumed.push({ item: "what they sell", value: snapshot.account.name, source: "the ad account's name" });
    }
  }

  if (open("offer")) {
    const offer = offerFromCopy(snapshot.ads);
    if (offer) fromData.push(offer);
    else assumed.push({ item: "offer", value: "no special offer; the ads lead with the product", source: "no ad copy was returned" });
  }

  if (open("creative assets")) {
    const creative = creativeSummary(snapshot.ads);
    if (creative) fromData.push({ item: "creative assets", value: creative, source: "the ads in the account" });
  }

  if (open("constraints")) {
    const countries = [...new Set([...(goals.allowed_countries ?? []), ...snapshot.adSets.flatMap((a) => a.countries ?? [])])];
    if (countries.length) fromData.push({ item: "constraints", value: `delivery limited to ${countries.join(", ")}`, source: "ad set targeting" });
    else assumed.push({ item: "constraints", value: "none beyond the current targeting", source: "default" });
  }

  // A target to plan to: the client's saved one is in Profile known; else hold or beat today's numbers.
  const hasResults = (totals?.results ?? 0) > 0;
  if (open("goal") && goals.target_cpa_cents == null && goals.target_roas == null) {
    if (hasResults && totals) {
      const cost = totals.costPerResultCents != null ? money(totals.costPerResultCents) : null;
      const value =
        type === "leadgen"
          ? `hold or beat ${cost ?? "the current cost"} per lead`
          : type === "ecom" && totals.roas != null
            ? `hold or beat ROAS ${totals.roas.toFixed(2)}× and ${cost ?? "the current cost"} per purchase`
            : `hold or beat ${cost ?? "the current cost"} per ${totals.resultLabel.toLowerCase().replace(/s$/, "") || "result"}`;
      fromData.push({ item: "goal", value, source: window });
    } else {
      ask.push({
        item: "goal",
        question: "What should the plan aim for: a cost per result, a ROAS, or a number of results a month?",
        why: "the account has no results to set a target from",
      });
    }
  }

  if (open("budget") && goals.daily_account_cap_cents == null && goals.monthly_cap_cents == null && totals) {
    fromData.push({
      item: "budget",
      value: `current spend about ${money(Math.round(totals.spendCents / days))} per day; kept as the ceiling and raised only in the plan's steps`,
      source: window,
    });
  }

  if (open("risk appetite")) {
    assumed.push({
      item: "risk appetite",
      value: `controlled growth: budget steps of at most ±${goals.max_budget_change_pct}% every 3–4 days`,
      source: "the client's budget guardrail and Meta's learning phase",
    });
  }
  if (open("timeframe")) {
    assumed.push({ item: "timeframe", value: "a 90-day plan (Now 0–7 days, Next 8–30 days, Later 31–90 days)", source: "default" });
  }
  if (open("owners")) {
    assumed.push({
      item: "owners",
      value: "this app queues budget and status changes through Approvals; the media buyer does the rest",
      source: "default",
    });
  }

  // The questions that change the plan. Margin sets break-even ROAS; lead quality decides what a good lead costs.
  if ((type === "ecom" || type === "hybrid") && open("margin") && goals.gross_margin_pct == null) {
    const aovCents =
      totals?.purchaseValueCents != null && (totals.purchases ?? 0) > 0
        ? Math.round(totals.purchaseValueCents / (totals.purchases as number))
        : goals.average_value_cents ?? null;
    ask.unshift({
      item: "margin",
      question: "What is your gross margin on a typical order?",
      why: `it sets the ROAS at which sales break even${aovCents != null ? `; average order value is ${money(aovCents)}` : ""}`,
    });
  }
  if ((type === "leadgen" || type === "hybrid") && open("lead quality")) {
    ask.splice(type === "hybrid" ? 1 : 0, 0, {
      item: "lead quality",
      question: "Of the leads Meta reports, roughly how many become qualified leads or sales?",
      why: "so the plan aims at qualified leads, not just cheap ones",
    });
  }

  return {
    stated: [...stated],
    fromData,
    assumed,
    ask: ask.slice(0, MAX_QUESTIONS),
  };
}
