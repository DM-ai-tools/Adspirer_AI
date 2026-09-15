/**
 * URL helpers for landing-page audit (own destinations + competitor LPs).
 */

const URL_RE =
  /https?:\/\/[^\s<>"'`)\]},]+/gi;

export function normalizeHttpUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/[.,);]+$/g, "");
  if (!trimmed) return null;
  try {
    const withProto = /^https?:\/\//i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    const u = new URL(withProto);
    if (!/^https?:$/i.test(u.protocol)) return null;
    // Drop tracking fragments that add noise; keep query (often material).
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

/** Extract unique http(s) URLs from free text / spreadsheet CSV dumps. */
export function extractHttpUrls(text: string, limit = 40): string[] {
  if (!text?.trim()) return [];
  const found = text.match(URL_RE) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of found) {
    const n = normalizeHttpUrl(raw);
    if (!n) continue;
    const key = n.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
    if (out.length >= limit) break;
  }
  return out;
}

/** True when the operator declines competitor LP comparison. */
export function isCompetitorLandingSkip(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  if (
    /^(no|nope|nah|skip|none|n\/a|na|without)\b/.test(t) &&
    t.length < 80
  ) {
    return true;
  }
  return (
    /\b(no|without|skip|don't|do not|dont)\b.{0,40}\bcompetitors?\b/.test(t) ||
    /\bcompetitors?\b.{0,40}\b(no|none|skip|n\/a)\b/.test(t) ||
    /\b(no competitors?|skip competitors?|without competitors?)\b/.test(t) ||
    /\bjust (my|our|the) (landing|pages?|audit)\b/.test(t) ||
    /\bno competitor landing\b/.test(t)
  );
}

/** Operator said they have competitor LPs but hasn't supplied URLs yet. */
export function isCompetitorLandingYesPending(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (extractHttpUrls(t).length > 0) return false;
  if (isCompetitorLandingSkip(t)) return false;
  return (
    /^(yes|yeah|yep|sure|ok|okay)\b/.test(t) ||
    /\b(i have|we have|yes[,.]?\s+(i|we)|competitor (urls?|links?|pages?))\b/.test(
      t,
    ) ||
    /\b(upload|excel|xlsx|csv|spreadsheet)\b/.test(t)
  );
}
