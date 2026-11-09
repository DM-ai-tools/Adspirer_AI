/**
 * Approved claims: the only figures a video may show or speak. A registry is built from what the
 * operator typed, what uploaded images printed, and the numeric sentences of the operator's own
 * text and the landing page. Every figure used in a script is then compared with the registry by its
 * NORMALISED value ("$12M+" is 12,000,000 dollars, "doubled" is 2x), never by a loose substring.
 */
import type { ApprovedClaim, Provenance } from "@/lib/video/pipeline-types";

// ------------------------------------------------------------------ figures

export type NormalisedFigure = {
  value: number | null;
  currency: string | null;
  unit: "percent" | "multiple" | "count" | "money" | "none";
  text: string;
};

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
};

const MAGNITUDE: Record<string, number> = {
  k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, mn: 1e6, mil: 1e6, million: 1e6, millions: 1e6, b: 1e9, bn: 1e9, billion: 1e9, billions: 1e9, t: 1e12, trillion: 1e12, lakh: 1e5, lakhs: 1e5, crore: 1e7, crores: 1e7, hundred: 100,
};

const MULTIPLE_WORDS: Record<string, number> = { doubled: 2, double: 2, twice: 2, tripled: 3, triple: 3, thrice: 3, quadrupled: 4, quadruple: 4, halved: 0.5 };

const CURRENCY_SYMBOL = /(?:A\$|AU\$|AUD|C\$|CA\$|CAD|NZ\$|NZD|US\$|USD|S\$|SGD|HK\$|HKD|\$|€|£|¥|₹|EUR|GBP|INR)/;
const CURRENCY_WORD: Record<string, string> = { dollar: "$", dollars: "$", bucks: "$", usd: "$", euro: "€", euros: "€", pound: "£", pounds: "£", rupee: "₹", rupees: "₹", aud: "$", cad: "$" };

function symbolToCurrency(sym: string): string {
  const s = sym.toUpperCase();
  if (s === "$" || s === "US$" || s === "USD" || s === "A$" || s === "AU$" || s === "AUD" || s === "C$" || s === "CA$" || s === "CAD" || s === "NZ$" || s === "NZD" || s === "S$" || s === "SGD" || s === "HK$" || s === "HKD") return "$";
  if (s === "€" || s === "EUR") return "€";
  if (s === "£" || s === "GBP") return "£";
  if (s === "₹" || s === "INR") return "₹";
  return sym;
}

const NUM = String.raw`(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?`;

function parseNumber(int: string, frac?: string): number {
  return Number(`${int.replace(/,/g, "")}${frac ? `.${frac}` : ""}`);
}

function magnitudeOf(word: string | undefined): number {
  if (!word) return 1;
  return MAGNITUDE[word.toLowerCase()] ?? 1;
}

/** Whole numbers spelled as words ("eight", "twenty five") to digits, or null. */
function wordsToNumber(s: string): number | null {
  const parts = s.toLowerCase().split(/[\s-]+/).filter(Boolean);
  if (parts.length === 0) return null;
  let total = 0;
  for (const p of parts) {
    const v = NUMBER_WORDS[p];
    if (v === undefined) return null;
    total = p === "hundred" && total > 0 ? total * 100 : total + v;
  }
  return total;
}

export function normaliseFigure(figure: string): NormalisedFigure {
  const text = figure.replace(/\s+/g, " ").trim().toLowerCase();
  const none = (): NormalisedFigure => ({ value: null, currency: null, unit: "none", text });
  if (!text) return none();
  // "+", "over", "more than", "up to", "~" do not change the figure.
  const t = text.replace(/\b(?:over|more than|up to|at least|around|about|nearly|almost|approximately)\b/g, " ").replace(/[+~]/g, " ").replace(/\s+/g, " ").trim();

  // Words: doubled, tripled, ...
  const word = /^(doubled|double|twice|tripled|triple|thrice|quadrupled|quadruple|halved)$/.exec(t);
  if (word) return { value: MULTIPLE_WORDS[word[1]!]!, currency: null, unit: "multiple", text };
  const fold = new RegExp(`^${NUM}[\\s-]?fold$`).exec(t);
  if (fold) return { value: parseNumber(fold[1]!, fold[2]), currency: null, unit: "multiple", text };
  const foldWord = /^([a-z]+)[\s-]?fold$/.exec(t);
  if (foldWord && NUMBER_WORDS[foldWord[1]!] !== undefined) return { value: NUMBER_WORDS[foldWord[1]!]!, currency: null, unit: "multiple", text };
  const times = new RegExp(`^${NUM}\\s?times$`).exec(t);
  if (times) return { value: parseNumber(times[1]!, times[2]), currency: null, unit: "multiple", text };

  // N-figure(s): the lowest value with that many digits.
  const figures = /^([a-z0-9]+)[\s-]?figures?$/.exec(t);
  if (figures) {
    const n = /^\d+$/.test(figures[1]!) ? Number(figures[1]) : wordsToNumber(figures[1]!);
    if (n !== null && n >= 2 && n <= 15) return { value: Math.pow(10, n - 1), currency: null, unit: "money", text };
  }

  // percent
  const pct = new RegExp(`^${NUM}\\s?(?:%|percent\\b|per cent\\b)`).exec(t);
  if (pct) return { value: parseNumber(pct[1]!, pct[2]), currency: null, unit: "percent", text };

  // multiple: 2x, 3.55x roas
  const mult = new RegExp(`^${NUM}\\s?[x×](?:\\b|\\s|$)`).exec(t);
  if (mult) return { value: parseNumber(mult[1]!, mult[2]), currency: null, unit: "multiple", text };

  // money: symbol first ($12M, A$1.5k, USD 20 million) ...
  const symFirst = new RegExp(`^(${CURRENCY_SYMBOL.source})\\s?${NUM}\\s?(k|m|mm|mn|mil|million|millions|b|bn|billion|billions|t|trillion|thousand|lakh|lakhs|crore|crores)?\\b`, "i").exec(figure.replace(/\s+/g, " ").trim().replace(/\b(?:over|more than|up to|at least|around|about|nearly|almost|approximately)\b\s*/gi, ""));
  if (symFirst) {
    const value = parseNumber(symFirst[2]!, symFirst[3]) * magnitudeOf(symFirst[4]);
    return { value, currency: symbolToCurrency(symFirst[1]!), unit: "money", text };
  }
  // ... or currency word after (12 million dollars, 500 usd)
  const wordAfter = new RegExp(`^${NUM}\\s?(k|m|mm|mn|mil|million|millions|b|bn|billion|billions|thousand|lakh|crore)?\\s?(dollars?|bucks|usd|aud|cad|euros?|pounds?|rupees?)\\b`).exec(t);
  if (wordAfter) {
    const value = parseNumber(wordAfter[1]!, wordAfter[2]) * magnitudeOf(wordAfter[3]);
    return { value, currency: CURRENCY_WORD[wordAfter[4]!] ?? null, unit: "money", text };
  }

  // plain counts: 1,500  1.5k  12 million  3 hundred
  const count = new RegExp(`^${NUM}\\s?(k|m|mm|mn|mil|million|millions|b|bn|billion|billions|thousand|hundred|lakh|crore)?$`).exec(t);
  if (count) return { value: parseNumber(count[1]!, count[2]) * magnitudeOf(count[3]), currency: null, unit: "count", text };
  const spelled = wordsToNumber(t);
  if (spelled !== null) return { value: spelled, currency: null, unit: "count", text };

  // fall back: the first number in it
  const any = new RegExp(NUM).exec(t);
  if (any) return { value: parseNumber(any[1]!, any[2]), currency: null, unit: "count", text };
  return none();
}

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/** Same figure, once written differently ("$12M+" = "12 million dollars", "doubled" = "2x" = "100% increase"). */
export function figuresEquivalent(a: NormalisedFigure, b: NormalisedFigure): boolean {
  if (a.value === null || b.value === null) return a.value === null && b.value === null && a.text !== "" && a.text === b.text;
  if (a.unit === b.unit) {
    if (!nearlyEqual(a.value, b.value)) return false;
    if (a.unit === "money") return !a.currency || !b.currency || a.currency === b.currency;
    return true;
  }
  const pair = (m: NormalisedFigure, p: NormalisedFigure) => m.unit === "multiple" && p.unit === "percent" && nearlyEqual((m.value as number - 1) * 100, p.value as number);
  return pair(a, b) || pair(b, a);
}

// ------------------------------------------------------------------ finding claims in prose

const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const ORDINAL_CONTEXT = /\b(?:step|steps|stage|phase|tip|reason|number|no|part|point|day|week|month|scene|slide|option|level|rule|way|item|question|chapter|episode|page|figure|fig|#)\s*\.?\s*$/i;
const COUNTING_NOUN = /^\s*(?:\+|clients?|customers?|leads?|sales|orders?|users?|businesses|brands?|campaigns?|ads?|products?|stores?|members?|reviews?|stars?|years?|projects?|employees|people|followers|subscribers|downloads|installs|conversions|bookings|appointments)\b/i;

/** Ranges already claimed by an earlier, more specific pattern. */
function overlaps(taken: Array<[number, number]>, start: number, end: number): boolean {
  return taken.some(([s, e]) => start < e && end > s);
}

function clauseAround(text: string, start: number, end: number): string {
  // Sentence boundaries first.
  let s = start;
  while (s > 0 && !/[.!?\n]/.test(text[s - 1]!)) s--;
  // Skip a decimal point or an abbreviation dot: "3.55x" has no boundary in it.
  let e = end;
  while (e < text.length && !(/[.!?\n]/.test(text[e]!) && !(text[e] === "." && /\d/.test(text[e + 1] ?? "")))) e++;
  let clause = text.slice(s, Math.min(text.length, e + 1)).trim();
  if (clause.length > 160) {
    let a = start;
    while (a > s && !/[,;:—]/.test(text[a - 1]!)) a--;
    let b = end;
    while (b < e && !/[,;:—]/.test(text[b]!)) b++;
    clause = text.slice(a, b).trim();
  }
  return clause.replace(/\s+/g, " ");
}

/**
 * Find the figures in a text that a viewer would read as claims, each with the clause around it.
 *
 * Counted as claims: currency amounts ($12M+, 12 million dollars), percentages (255%), multiples (3.55x,
 * 10x, tenfold), "N-figure(s)" ("eight-figure"), "doubled / tripled / quadrupled / halved", and bare numbers.
 * NOT counted: plain years (1900-2099 with no comma, unless followed by "+" or a counting noun such as
 * "2000 clients"); numbers glued to letters (GA4, H264, v2); dates and times (3 March, 9am, 10:30); phone
 * and ID style digit groups; bare integers of 5 or more digits without a comma, "+" or counting noun; and
 * the digits 1 to 3 used as list ordinals ("Step 1", "no. 2", "1.", "2)", "#3"). Spelled-out numbers
 * ("three clients") are not flagged: only the quantitative words listed above are.
 */
export function findClaimsInText(text: string): Array<{ figure: string; text: string }> {
  const found: Array<{ start: number; end: number; figure: string }> = [];
  const taken: Array<[number, number]> = [];
  const add = (start: number, end: number, figure: string) => {
    if (overlaps(taken, start, end)) return;
    taken.push([start, end]);
    found.push({ start, end, figure: figure.trim() });
  };
  const mag = "(?:k|m|mm|mn|mil|million|millions|b|bn|billion|billions|t|trillion|thousand|lakh|lakhs|crore|crores)";

  // 1. money with a symbol: A$1.5k, $12M+, USD 20 million
  const sym = new RegExp(`(?<![\\w])(?:${CURRENCY_SYMBOL.source})\\s?${NUM}(?:\\s?${mag}\\b)?\\+?`, "gi");
  for (const m of text.matchAll(sym)) add(m.index!, m.index! + m[0].length, m[0]);
  // 2. money in words: 12 million dollars
  const words = new RegExp(`(?<![\\w$€£])${NUM}(?:\\s?${mag})?\\s?(?:dollars?|bucks|usd|aud|euros?|pounds?|rupees?)\\b\\+?`, "gi");
  for (const m of text.matchAll(words)) add(m.index!, m.index! + m[0].length, m[0]);
  // 3. percentages
  const pct = new RegExp(`(?<![\\w.])${NUM}\\s?(?:%|percent\\b|per cent\\b)`, "gi");
  for (const m of text.matchAll(pct)) add(m.index!, m.index! + m[0].length, m[0]);
  // 4. multiples: 3.55x, 10X, 5 times, tenfold
  const mul = new RegExp(`(?<![\\w.])${NUM}\\s?[x×](?![\\w])`, "gi");
  for (const m of text.matchAll(mul)) add(m.index!, m.index! + m[0].length, m[0]);
  const fold = new RegExp(`\\b(?:${NUM}|(?:one|two|three|four|five|six|seven|eight|nine|ten|twenty|fifty|hundred))[\\s-]?fold\\b`, "gi");
  for (const m of text.matchAll(fold)) add(m.index!, m.index! + m[0].length, m[0]);
  const times = new RegExp(`(?<![\\w.])${NUM}\\s?times\\s+(?=more|as|bigger|faster|higher|greater|the)`, "gi");
  for (const m of text.matchAll(times)) add(m.index!, m.index! + m[0].trimEnd().length, m[0]);
  // 5. N-figure(s)
  const fig = /\b(?:(\d{1,2})|(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve))[\s-]figures?\b/gi;
  for (const m of text.matchAll(fig)) add(m.index!, m.index! + m[0].length, m[0]);
  // 6. doubled / tripled / ...
  const dbl = /\b(?:doubled|tripled|quadrupled|halved)\b/gi;
  for (const m of text.matchAll(dbl)) add(m.index!, m.index! + m[0].length, m[0]);
  // 7. bare numbers
  const bare = new RegExp(`(?<![\\w.$€£#:/-])${NUM}(?:\\s?${mag}\\b)?(\\+?)(?![\\w]|[.:]\\d)`, "gi");
  for (const m of text.matchAll(bare)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (overlaps(taken, start, end)) continue;
    const raw = m[0];
    const hasComma = m[1]!.includes(",");
    const hasFrac = m[2] !== undefined;
    const hasMag = new RegExp(`\\s?${mag}$`, "i").test(raw.replace(/\+$/, "")) && /[a-z]$/i.test(raw.replace(/\+$/, ""));
    const plus = m[3] === "+";
    const intDigits = m[1]!.replace(/,/g, "");
    const n = Number(intDigits);
    const after = text.slice(end, end + 40);
    const before = text.slice(Math.max(0, start - 20), start);
    // time and dates
    if (/^\s?(?:am|pm|a\.m\.|p\.m\.)\b/i.test(after)) continue;
    if (new RegExp(`^\\s?(?:${MONTHS})\\b`, "i").test(after)) continue;
    if (new RegExp(`(?:${MONTHS})\\.?\\s*$`, "i").test(before)) continue;
    if (/^[-/]\d/.test(after) || /\d[-/]$/.test(before)) continue;
    // phone / id style groups: digits then a separator and more digits
    if (/^[ -]\d{3,4}\b/.test(after)) continue;
    if (/\d{3,4}[ -]$/.test(before)) continue;
    const bareInt = !hasComma && !hasFrac && !hasMag;
    // years
    if (bareInt && intDigits.length === 4 && n >= 1900 && n <= 2099 && !plus && !COUNTING_NOUN.test(after)) continue;
    // long digit runs
    if (bareInt && intDigits.length >= 5 && !plus && !COUNTING_NOUN.test(after)) continue;
    // list ordinals: Step 1, no. 2, "1." at line start, "2)", "#3"
    if (bareInt && n >= 1 && n <= 3 && !plus) {
      if (ORDINAL_CONTEXT.test(before)) continue;
      if (/^\s?[.)]\s/.test(after) || /^\s?[.)]$/.test(after)) continue;
      if (/(?:^|\n)\s*$/.test(text.slice(Math.max(0, start - 8), start)) && /^[.)]/.test(after)) continue;
    }
    add(start, end, raw);
  }

  found.sort((a, b) => a.start - b.start);
  return found.map((f) => ({ figure: f.figure, text: clauseAround(text, f.start, f.end) }));
}

// ------------------------------------------------------------------ the registry

export type ClaimRegistryInput = {
  stats: string[];
  assets: Array<{ id: string; name: string; analysis?: { stats: Array<{ value: string; label: string }> } | null }>;
  offerDetails?: string | null;
  instructions?: string | null;
  pageExcerpt?: string | null;
  pageUrl?: string | null;
  extra?: Array<{ text: string; provenance: Provenance }>;
};

const STOP = new Set(["a", "an", "the", "of", "in", "on", "for", "to", "and", "with", "by", "from", "at", "our", "your", "we", "you", "is", "are", "was", "were", "has", "have", "had", "over", "more", "than"]);

/** Words that describe the video being made, not the business: "make it 30 seconds" is not a claim. */
const PRODUCTION_RE = /\b(?:seconds?|secs?|scenes?|aspect|9:16|4:5|1:1|fps|duration|clips?|resolution|reels?|length|words?|captions?|subtitles?)\b/i;

function claimKey(figure: string, text: string): string {
  const n = normaliseFigure(figure);
  const numeric = n.value === null ? `text:${n.text}` : `${n.unit}:${n.unit === "money" ? n.currency ?? "" : ""}:${n.value}`;
  const label = text
    .toLowerCase()
    .replace(figure.toLowerCase(), " ")
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP.has(w))
    .slice(0, 6)
    .sort()
    .join(" ");
  return `${numeric}|${label}`;
}

export function buildClaimRegistry(input: ClaimRegistryInput): ApprovedClaim[] {
  const claims: ApprovedClaim[] = [];
  const seen = new Set<string>();
  const push = (c: Omit<ApprovedClaim, "id">, key?: string) => {
    const k = key ?? claimKey(c.figure ?? c.text, c.text);
    if (seen.has(k)) return;
    seen.add(k);
    claims.push({ ...c, id: `claim_${claims.length + 1}` });
  };

  // 1. operator stats
  for (const raw of input.stats) {
    const stat = raw.replace(/\s+/g, " ").trim();
    if (!stat) continue;
    const provenance: Provenance = { source: "operator", detail: "Typed by the operator as a headline stat", confidence: "high" };
    const figs = findClaimsInText(stat);
    if (figs.length === 0) {
      push({ text: stat, kind: "statement", evidence: stat, provenance }, `text:${stat.toLowerCase()}`);
      continue;
    }
    for (const f of figs) push({ text: stat, kind: "number", figure: f.figure, evidence: stat, provenance });
  }

  // 2. numbers printed in uploaded images
  for (const asset of input.assets) {
    for (const s of asset.analysis?.stats ?? []) {
      const value = s.value.trim();
      const label = s.label.trim();
      if (!value) continue;
      const text = `${value} ${label}`.trim();
      push({
        text,
        kind: "number",
        figure: value,
        evidence: `${value} ${label} printed in ${asset.name}`.replace(/\s+/g, " "),
        provenance: { source: "image_reading", detail: `Read from the uploaded image "${asset.name}"`, confidence: "medium" },
        assetId: asset.id,
      });
    }
  }

  // 3. the operator's own words, then the page
  const fromText = (text: string | null | undefined, provenance: Provenance, dropProduction: boolean) => {
    if (!text) return;
    for (const f of findClaimsInText(text)) {
      if (dropProduction && PRODUCTION_RE.test(f.text)) continue;
      push({ text: f.text, kind: "number", figure: f.figure, evidence: f.text, provenance });
    }
  };
  fromText(input.offerDetails, { source: "operator", detail: "The operator's offer details", confidence: "high" }, false);
  fromText(input.instructions, { source: "operator", detail: "The operator's instructions", confidence: "high" }, true);
  fromText(input.pageExcerpt, { source: "page_text", detail: "Landing page text", ...(input.pageUrl ? { url: input.pageUrl } : {}), confidence: "medium" }, false);

  // 4. anything the caller already vetted
  for (const e of input.extra ?? []) {
    const text = e.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const figs = findClaimsInText(text);
    if (figs.length === 0) push({ text, kind: "statement", evidence: text, provenance: e.provenance }, `text:${text.toLowerCase()}`);
    else for (const f of figs) push({ text, kind: "number", figure: f.figure, evidence: text, provenance: e.provenance });
  }
  return claims;
}

// ------------------------------------------------------------------ sourcing

export type ClaimUse = { text: string; where: string };

function registryFigures(claim: ApprovedClaim): NormalisedFigure[] {
  const out: NormalisedFigure[] = [];
  if (claim.figure) out.push(normaliseFigure(claim.figure));
  for (const f of findClaimsInText(claim.text)) out.push(normaliseFigure(f.figure));
  return out;
}

/**
 * Every figure used in the script must trace to the registry. Compared by normalised value; a use with
 * no figure in it has nothing to source and appears in neither list.
 */
export function sourceClaims(
  uses: ClaimUse[],
  registry: ApprovedClaim[],
): {
  sourced: Array<{ use: ClaimUse; figure: string; claim: ApprovedClaim }>;
  unsourced: Array<{ use: ClaimUse; figure: string; reason: string }>;
} {
  const sourced: Array<{ use: ClaimUse; figure: string; claim: ApprovedClaim }> = [];
  const unsourced: Array<{ use: ClaimUse; figure: string; reason: string }> = [];
  const indexed = registry.map((claim) => ({ claim, figures: registryFigures(claim) }));
  for (const use of uses) {
    for (const f of findClaimsInText(use.text)) {
      const wanted = normaliseFigure(f.figure);
      const hit = indexed.find((r) => r.figures.some((g) => figuresEquivalent(wanted, g)));
      if (hit) sourced.push({ use, figure: f.figure, claim: hit.claim });
      else {
        const known = registry.map((c) => c.figure).filter((x): x is string => Boolean(x));
        unsourced.push({
          use,
          figure: f.figure,
          reason: known.length ? `"${f.figure}" is not one of the approved figures (${known.slice(0, 6).join(", ")})` : `"${f.figure}" is used but no approved figures exist`,
        });
      }
    }
  }
  return { sourced, unsourced };
}
