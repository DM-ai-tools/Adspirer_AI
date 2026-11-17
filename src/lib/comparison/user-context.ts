/**
 * What the operator said about the business around the comparison (a sale, a launch, stock, a
 * price change, a season), for section 11. Only clauses with one of these context phrases count,
 * matched after the comparison and date wording is taken out, so "compare sales results Oct vs
 * Sep" is not context. Returns those clauses in the operator's words, or null.
 */
const CONTEXT_PHRASES: RegExp[] = [
  /\b(?:ran|run|running|had|have|having|held|hold|holding|did|doing|started|ended|launched)\s+(?:a|an|our|the|its)?\s*(?:[^\s.,;!?]+\s+){0,3}sales?\b/i,
  /\bon\s+sale\b/i,
  /\bsales?\s+event\b/i,
  /\b(?:flash|clearance|summer|winter|seasonal|holiday|black\s+friday|festive)\s+sale\b/i,
  /\bpromo(?:s|tion|tions|tional)?\b/i,
  /\bdiscount(?:s|ed|ing)?\b/i,
  /\bout\s+of\s+stock\b/i,
  /\bstock\s+(?:issue|issues|problem|problems|shortage|shortages|ran\s+out|outage)\b/i,
  /\b(?:sold|selling)\s+out\b/i,
  /\bprices?\s+(?:increase|increases|increased|rise|rises|rose|drop|drops|dropped|cut|cuts|change|changes|changed)\b/i,
  /\b(?:raised|lowered|cut|changed|increased|dropped|reduced)\s+(?:our\s+|the\s+|its\s+)?prices?\b/i,
  /\blaunch(?:ed|es|ing)?\b/i,
  /\bholiday\w*\b/i,
  /\bseason(?:al|ality)?\b/i,
  /\bfestive\b/i,
  /\b(?:black\s+friday|cyber\s+monday|christmas|diwali|eid|easter|new\s+year)\b/i,
];

const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

/** Comparison and date wording, which never counts as context on its own. */
const COMPARISON_WORDING: RegExp[] = [
  /\b(?:compare[ds]?|comparing|comparison|versus|vs\.?|against|over|period[- ]over[- ]period|week[- ]over[- ]week|month[- ]over[- ]month|year[- ]over[- ]year)\b/gi,
  /\b(?:this|last|past|previous|prior|next)\s+(?:\d+\s+)?(?:days?|weeks?|months?|quarters?|years?|period)\b/gi,
  /\b\d{4}-\d{2}-\d{2}\b/g,
  new RegExp(`\\b${MONTH}\\b`, "gi"),
  /\b(?:sales|revenue|results|leads|purchases|spend|performance|numbers)\b/gi,
];

function withoutComparisonWording(clause: string): string {
  let out = clause;
  for (const re of COMPARISON_WORDING) out = out.replace(re, " ");
  return out.replace(/\s+/g, " ").trim();
}

export function comparisonUserContext(request: string): string | null {
  const clauses = request
    .split(/\s*(?:[.;!?\n]+|\s[—–-]\s|,)\s*/)
    .map((c) => c.trim())
    .filter(Boolean);
  const kept = clauses.filter((clause) => {
    const text = withoutComparisonWording(clause);
    // The clause must still say something once the comparison wording is gone, and say it with a context phrase.
    return text.length > 0 && CONTEXT_PHRASES.some((re) => re.test(clause) && re.test(text));
  });
  return kept.length ? kept.join("; ") : null;
}
