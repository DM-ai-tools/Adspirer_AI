import type { AgentHistoryMessage } from "@/lib/agent/history";

export type AuditScope = "account" | "campaigns";

export type AuditBrief = {
  scope: AuditScope | null;
  /** Free-text campaign names/ids the operator mentioned */
  campaignHints: string[];
  dateStart: string | null;
  dateStop: string | null;
  dateLabel: string | null;
  missing: Array<"scope" | "campaigns" | "date_range">;
  ready: boolean;
};

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
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
  if (/\blast\s+month\b|\bpast\s+30\s+days\b|\blast\s+30\b/.test(lower)) {
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

  return null;
}

function parseScope(text: string): {
  scope: AuditScope | null;
  campaignHints: string[];
} {
  const lower = text.toLowerCase();
  const campaignHints: string[] = [];

  // Explicit account-wide
  if (
    /\b(entire|whole|full|complete)\s+(ad\s+)?account\b/.test(lower) ||
    /\ball\s+campaigns\b/.test(lower) ||
    /\baccount[- ]wide\b/.test(lower) ||
    /\baudit\s+(the\s+)?(whole\s+|entire\s+)?account\b/.test(lower) ||
    (/\b(audit|review|diagnos|analy[sz])\b/.test(lower) &&
      /\b(ad\s+)?account\b/.test(lower) &&
      !/\bcampaigns?\b/.test(lower))
  ) {
    return { scope: "account", campaignHints: [] };
  }

  // Named campaigns: "campaign X", "campaigns A and B"
  const named = [
    ...text.matchAll(
      /\bcampaigns?\s+["“]?([^"”\n,]+?)["”]?(?=\s+and\s+|\s*,|\s*$|\s+for\b|\s+from\b|\s+last\b|\s+in\b)/gi,
    ),
  ];
  for (const m of named) {
    const hint = m[1]?.trim();
    if (hint && hint.length > 1 && !/^(the|all|my|our|this|these)$/i.test(hint)) {
      campaignHints.push(hint);
    }
  }

  // "for TR AUDIT FINAL" style
  const forNamed =
    /\b(?:for|on)\s+(?:the\s+)?(?:campaign\s+)?["“]?([A-Za-z0-9][^"”\n]{2,80}?)["”]?\s*(?=$|\.|,|\blast\b|\bfrom\b|\bto\b)/i.exec(
      text,
    );
  if (forNamed?.[1] && !/\baccount\b/i.test(forNamed[1])) {
    const hint = forNamed[1].trim();
    if (
      hint.length > 2 &&
      !/^(this|that|these|those|it|them|me)$/i.test(hint) &&
      !campaignHints.some((h) => h.toLowerCase() === hint.toLowerCase())
    ) {
      campaignHints.push(hint);
    }
  }

  // Meta campaign ids
  const ids = [...text.matchAll(/\b(120\d{10,})\b/g)].map((m) => m[1]);
  for (const id of ids) {
    if (!campaignHints.includes(id)) campaignHints.push(id);
  }

  if (campaignHints.length || /\b(specific|particular|selected|these|those)\s+campaigns?\b/.test(lower)) {
    return { scope: "campaigns", campaignHints };
  }

  if (/\bcampaigns?\b/.test(lower) && !/\baccount\b/.test(lower)) {
    // Ambiguous: mentioned campaigns but not which — still campaigns scope
    return { scope: "campaigns", campaignHints };
  }

  return { scope: null, campaignHints: [] };
}

function mergeBriefs(parts: AuditBrief[]): AuditBrief {
  let scope: AuditScope | null = null;
  const campaignHints: string[] = [];
  let dateStart: string | null = null;
  let dateStop: string | null = null;
  let dateLabel: string | null = null;

  for (const part of parts) {
    if (part.scope) scope = part.scope;
    for (const h of part.campaignHints) {
      if (!campaignHints.some((x) => x.toLowerCase() === h.toLowerCase())) {
        campaignHints.push(h);
      }
    }
    if (part.dateStart && part.dateStop) {
      dateStart = part.dateStart;
      dateStop = part.dateStop;
      dateLabel = part.dateLabel;
    }
  }

  const missing: AuditBrief["missing"] = [];
  if (!scope) missing.push("scope");
  if (scope === "campaigns" && campaignHints.length === 0) {
    missing.push("campaigns");
  }
  if (!dateStart || !dateStop) missing.push("date_range");

  return {
    scope,
    campaignHints,
    dateStart,
    dateStop,
    dateLabel,
    missing,
    ready: missing.length === 0,
  };
}

function briefFromText(text: string): AuditBrief {
  const { scope, campaignHints } = parseScope(text);
  const range = parseDateRangeFromText(text);
  const missing: AuditBrief["missing"] = [];
  if (!scope) missing.push("scope");
  if (scope === "campaigns" && campaignHints.length === 0) {
    missing.push("campaigns");
  }
  if (!range) missing.push("date_range");

  return {
    scope,
    campaignHints,
    dateStart: range?.dateStart ?? null,
    dateStop: range?.dateStop ?? null,
    dateLabel: range?.dateLabel ?? null,
    missing,
    ready: missing.length === 0,
  };
}

/**
 * Resolve audit scope + date range from the latest message, filling gaps from
 * recent chat turns so short replies ("last 30 days") complete a prior brief.
 */
export function resolveAuditBrief(
  request: string,
  history: AgentHistoryMessage[] = [],
): AuditBrief {
  const recentUser = history
    .filter((m) => m.role === "user")
    .slice(-6)
    .map((m) => m.content);
  const parts = [...recentUser, request].map(briefFromText);
  return mergeBriefs(parts);
}

export function buildAuditClarifyingQuestion(brief: AuditBrief): string {
  const lines: string[] = [
    "I can run a **Meta Ads best-practice audit** — I just need a couple of details first:",
    "",
  ];

  if (brief.missing.includes("scope")) {
    lines.push(
      "1. **Scope** — should I audit the **entire ad account**, or only **specific campaign(s)**?",
    );
  }
  if (brief.missing.includes("campaigns")) {
    lines.push(
      `${brief.missing.includes("scope") ? "2" : "1"}. **Which campaigns?** Name them (or paste campaign IDs). I can list live campaigns if helpful.`,
    );
  }
  if (brief.missing.includes("date_range")) {
    const n =
      1 +
      (brief.missing.includes("scope") ? 1 : 0) +
      (brief.missing.includes("campaigns") ? 1 : 0);
    lines.push(
      `${n}. **Date range** — e.g. last 7 days, last 30 days, this month, or \`YYYY-MM-DD\` to \`YYYY-MM-DD\`.`,
    );
  }

  lines.push(
    "",
    "Reply with the missing piece(s) and I’ll run the full audit (spend, what’s working, what to improve, and recommendations). I won’t change any campaigns until you explicitly ask to **optimize**.",
  );
  return lines.join("\n");
}

/** Short replies that complete an in-progress audit brief (scope / dates / names). */
export function looksLikeAuditBriefReply(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 400) return false;
  if (parseDateRangeFromText(t)) return true;
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
