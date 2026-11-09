import { describe, expect, it, vi } from "vitest";
import {
  SEEDANCE_SPEECH_PROVIDER,
  applyLexicon,
  buildLexicon,
  detectTerms,
  lexiconNeedsReview,
  numberToWords,
  ruleDecision,
  type LexiconDecider,
} from "@/lib/video/pronunciation";
import type { PronunciationKind } from "@/lib/video/pipeline-types";

const rule = (term: string, kind: PronunciationKind = "acronym", locale = "en-AU", extra: { brandName?: string | null; currency?: string | null } = {}) =>
  ruleDecision({ term, kind, index: 0 }, { locale, ...extra });

describe("numberToWords", () => {
  it("adds 'and' in Australian, British and New Zealand English only", () => {
    expect(numberToWords(105, { locale: "en-AU" })).toBe("one hundred and five");
    expect(numberToWords(105, { locale: "en-GB" })).toBe("one hundred and five");
    expect(numberToWords(105, { locale: "en-NZ" })).toBe("one hundred and five");
    expect(numberToWords(105, { locale: "en-US" })).toBe("one hundred five");
    expect(numberToWords(105)).toBe("one hundred five");
    expect(numberToWords(1005, { locale: "en-AU" })).toBe("one thousand and five");
    expect(numberToWords(1200, { locale: "en-AU" })).toBe("one thousand two hundred");
    expect(numberToWords(255, { locale: "en-AU" })).toBe("two hundred and fifty-five");
  });
  it("handles zero, small numbers, negatives and decimals", () => {
    expect(numberToWords(0)).toBe("zero");
    expect(numberToWords(13)).toBe("thirteen");
    expect(numberToWords(40)).toBe("forty");
    expect(numberToWords(-7)).toBe("minus seven");
    expect(numberToWords(3.5)).toBe("three point five");
    expect(numberToWords(0.25)).toBe("zero point two five");
    expect(numberToWords(3.55)).toBe("three point five five");
  });
  it("goes up to the trillions", () => {
    expect(numberToWords(12_000_000)).toBe("twelve million");
    expect(numberToWords(1_000_000_000)).toBe("one billion");
    expect(numberToWords(2_500_000_000_000)).toBe("two trillion five hundred billion");
    expect(numberToWords(123_456_789, { locale: "en-US" })).toBe("one hundred twenty-three million four hundred fifty-six thousand seven hundred eighty-nine");
    expect(numberToWords(1_000_001, { locale: "en-AU" })).toBe("one million and one");
  });
});

describe("detectTerms", () => {
  const text = "ROAS within a year, SEO and GA4 gave us $12M+ and 255% at 3.55x on 12 March 2026";
  it("finds every kind of term as the exact substring with its index", () => {
    const found = detectTerms(text);
    expect(found.map((t) => t.term)).toEqual(["ROAS", "SEO", "GA4", "$12M+", "255%", "3.55x", "12 March 2026"]);
    for (const t of found) expect(text.slice(t.index, t.index + t.term.length)).toBe(t.term);
    expect(found.find((t) => t.term === "$12M+")!.kind).toBe("currency");
    expect(found.find((t) => t.term === "255%")!.kind).toBe("percent");
    expect(found.find((t) => t.term === "12 March 2026")!.kind).toBe("date");
    expect(found.find((t) => t.term === "ROAS")!.kind).toBe("acronym");
  });
  it("finds the brand name and its spaced and cased variants, longest match first", () => {
    const found = detectTerms("AdSpirer and Ad Spirer and ADSPIRER, then Adspirer AI", { brandName: "AdSpirer" });
    expect(found.filter((t) => t.kind === "brand").map((t) => t.term)).toEqual(["AdSpirer", "Ad Spirer", "ADSPIRER", "Adspirer"]);
    // "AI" after the brand is its own acronym, not part of the brand match
    expect(found.map((t) => t.term)).toContain("AI");
  });
  it("reads currency with prefixes, magnitudes and trailing signs", () => {
    expect(detectTerms("from A$1,200 or €3.5k or £2 million or US$5 or $12M+.").map((t) => t.term)).toEqual(["A$1,200", "€3.5k", "£2 million", "US$5", "$12M+"]);
  });
  it("finds numbers, ordinals, years, dates, times and abbreviations", () => {
    expect(detectTerms("1,200 clients, 3.5 stars, the 3rd, open 24/7").map((t) => t.term)).toEqual(["1,200", "3.5", "3rd", "24/7"]);
    expect(detectTerms("Since 2026 we grew, see 12/03 or March 3rd, e.g. vs. rivals").map((t) => [t.term, t.kind])).toEqual([
      ["2026", "date"],
      ["12/03", "date"],
      ["March 3rd", "date"],
      ["e.g.", "abbreviation"],
      ["vs.", "abbreviation"],
    ]);
    expect(detectTerms("a 4000 person team").map((t) => t.kind)).toEqual(["number"]);
  });
  it("finds technical mixed-case terms and symbols read aloud", () => {
    expect(detectTerms("eCommerce on iOS & Android + more").map((t) => t.term)).toEqual(["eCommerce", "iOS", "&", "+"]);
  });
  it("does not split a longer match, and ignores ordinary words", () => {
    const found = detectTerms("This is Great and A$5 is $5");
    expect(found.map((t) => t.term)).toEqual(["A$5", "$5"]);
  });
});

describe("ruleDecision: numbers and money", () => {
  it("$12M+ becomes 'over twelve million dollars' and the term is untouched", () => {
    const e = rule("$12M+", "currency");
    expect(e.spoken).toBe("over twelve million dollars");
    expect(e.term).toBe("$12M+");
    expect(e.decision).toBe("expand");
    expect(e.source).toBe("rule");
    expect(e.needsReview).toBe(false);
  });
  it("uses the currency symbol and the locale", () => {
    expect(rule("A$1,200", "currency").spoken).toBe("one thousand two hundred Australian dollars");
    expect(rule("US$5", "currency").spoken).toBe("five U S dollars");
    expect(rule("€3.5k", "currency").spoken).toBe("three point five thousand euros");
    expect(rule("£2 million", "currency").spoken).toBe("two million pounds");
    expect(rule("$1", "currency").spoken).toBe("one dollar");
    expect(rule("$3.50", "currency").spoken).toBe("three dollars and fifty cents");
    expect(rule("$1,205", "currency", "en-US").spoken).toBe("one thousand two hundred five dollars");
    expect(rule("$1,205", "currency", "en-AU").spoken).toBe("one thousand two hundred and five dollars");
    // a bare $ in an Australian locale with a US account currency says which dollars
    expect(rule("$50", "currency", "en-AU", { currency: "USD" }).spoken).toBe("fifty U S dollars");
    expect(rule("$50", "currency", "en-AU", { currency: "AUD" }).spoken).toBe("fifty dollars");
  });
  it("percentages and multiples", () => {
    expect(rule("255%", "percent", "en-AU").spoken).toBe("two hundred and fifty-five percent");
    expect(rule("255%", "percent", "en-US").spoken).toBe("two hundred fifty-five percent");
    expect(rule("12%+", "percent").spoken).toBe("over twelve percent");
    expect(rule("3.55x", "number").spoken).toBe("three point five five times");
    expect(rule("10x", "number").spoken).toBe("ten times");
  });
  it("plain numbers, ordinals, times and idioms", () => {
    expect(rule("1,200", "number").spoken).toBe("one thousand two hundred");
    expect(rule("10+", "number").spoken).toBe("over ten");
    expect(rule("12M", "number").spoken).toBe("twelve million");
    expect(rule("3rd", "number").spoken).toBe("third");
    expect(rule("21st", "number").spoken).toBe("twenty-first");
    expect(rule("24/7", "number").spoken).toBe("twenty-four seven");
    expect(rule("5:30pm", "number").spoken).toBe("five thirty P M");
  });
  it("dates follow the locale's order, and ambiguous numeric dates are flagged", () => {
    expect(rule("12 March 2026", "date", "en-AU").spoken).toBe("the twelfth of March twenty twenty-six");
    expect(rule("12 March 2026", "date", "en-US").spoken).toBe("March twelfth twenty twenty-six");
    expect(rule("March 3rd", "date", "en-US").spoken).toBe("March third");
    expect(rule("2026", "date").spoken).toBe("twenty twenty-six");
    expect(rule("2005", "date", "en-AU").spoken).toBe("two thousand and five");
    expect(rule("1905", "date").spoken).toBe("nineteen oh five");
    const ambiguous = rule("12/03", "date", "en-AU");
    expect(ambiguous.spoken).toBe("the twelfth of March");
    expect(ambiguous.needsReview).toBe(true);
    expect(rule("12/03", "date", "en-US").spoken).toBe("December third");
    const clear = rule("25/03", "date", "en-AU");
    expect(clear.needsReview).toBe(false);
    const quantity = rule("2000", "number");
    expect(quantity.spoken).toBe("two thousand");
    expect(quantity.needsReview).toBe(true);
  });
  it("abbreviations and symbols", () => {
    expect(rule("e.g.", "abbreviation").spoken).toBe("for example");
    expect(rule("vs.", "abbreviation").spoken).toBe("versus");
    expect(rule("U.S.", "abbreviation").spoken).toBe("U S");
    expect(rule("R&D", "abbreviation").spoken).toBe("R and D");
    expect(rule("&", "technical").spoken).toBe("and");
    expect(rule("+", "technical").spoken).toBe("plus");
  });
});

describe("ruleDecision: acronyms are neither all spelled nor all said as words", () => {
  const tokens = ["CRM", "SEO", "KPI", "SMS", "HTML", "SHOPIFY", "UNICEF", "ROAS", "NASA", "USP"];
  const entries = Object.fromEntries(tokens.map((t) => [t, rule(t)]));
  it("spells clear initialisms and says clearly word-shaped ones as words", () => {
    for (const t of ["CRM", "SEO", "KPI", "SMS", "HTML"]) {
      expect(entries[t]!.decision, t).toBe("spell");
      expect(entries[t]!.needsReview, t).toBe(false);
    }
    expect(entries.SEO!.spoken).toBe("S E O");
    expect(entries.SHOPIFY!.decision).toBe("word");
    expect(entries.SHOPIFY!.spoken).toBe("shopify");
    expect(entries.UNICEF!.decision).toBe("word");
    expect(new Set(tokens.map((t) => entries[t]!.decision)).size).toBeGreaterThan(1);
  });
  it("flags the ambiguous short word-shaped ones, spells them and never invents an expansion", () => {
    for (const t of ["ROAS", "NASA", "USP"]) {
      expect(entries[t]!.needsReview, t).toBe(true);
      expect(entries[t]!.confidence, t).toBe("low");
      expect(entries[t]!.decision, t).toBe("spell");
    }
    expect(entries.ROAS!.spoken).toBe("R O A S");
    expect(entries.ROAS!.reason).toMatch(/word|spell/i);
  });
  it("spells letters and says digits as words for letter+digit mixes, and keeps plurals", () => {
    expect(rule("GA4").spoken).toBe("G A four");
    expect(rule("B2B").spoken).toBe("B two B");
    expect(rule("GA4").needsReview).toBe(false);
    expect(rule("KPIs").spoken).toBe("K P Is");
  });
  it("brand names are said as written, flagged only when the spelling is unusual", () => {
    const plain = rule("Adspirer", "brand", "en-AU", { brandName: "Adspirer" });
    expect(plain.decision).toBe("verbatim");
    expect(plain.needsReview).toBe(false);
    const odd = rule("XQZ9", "brand", "en-AU", { brandName: "xQz9 Labs" });
    expect(odd.needsReview).toBe(true);
    const caps = rule("IBM", "brand", "en-AU", { brandName: "IBM" });
    expect(caps.decision).toBe("spell");
    expect(rule("iOS", "technical").needsReview).toBe(true);
    expect(rule("eCommerce", "technical").needsReview).toBe(false);
  });
});

describe("buildLexicon precedence", () => {
  const lines = [
    { sceneNumber: 1, text: "ROAS within a year." },
    { sceneNumber: 2, text: "We made $12M+ in 2026." },
  ];
  const base = { lines, brandName: null, locale: "en-AU", now: "2026-01-01T00:00:00.000Z" };
  const modelSays = (term: string, spoken: string, confidence: "high" | "medium" | "low" = "high"): LexiconDecider =>
    vi.fn(async () => [{ term, decision: "word" as const, spoken, reason: "campaign context", confidence }]);
  const entryFor = (lex: Awaited<ReturnType<typeof buildLexicon>>, term: string) => lex.entries.find((e) => e.term === term)!;

  it("operator override beats guidance and the model", async () => {
    const decide = modelSays("ROAS", "model-roas");
    const lex = await buildLexicon({ ...base, overrides: { ROAS: "roh-ass" }, brandGuidance: [{ term: "ROAS", spoken: "guided" }], decide });
    const e = entryFor(lex, "ROAS");
    expect(e).toMatchObject({ spoken: "roh-ass", source: "operator", confidence: "high", needsReview: false });
  });
  it("brand guidance beats the model", async () => {
    const lex = await buildLexicon({ ...base, brandGuidance: [{ term: "ROAS", spoken: "roh-ass" }], decide: modelSays("ROAS", "model-roas") });
    expect(entryFor(lex, "ROAS")).toMatchObject({ spoken: "roh-ass", source: "brand_guidance", needsReview: false });
  });
  it("the model beats the rules, and its confidence decides review", async () => {
    const high = await buildLexicon({ ...base, decide: modelSays("ROAS", "roh-ass", "high") });
    expect(entryFor(high, "ROAS")).toMatchObject({ spoken: "roh-ass", source: "model", needsReview: false });
    const low = await buildLexicon({ ...base, decide: modelSays("ROAS", "roh-ass", "low") });
    expect(entryFor(low, "ROAS").needsReview).toBe(true);
    // the other terms fell back to rules
    expect(entryFor(high, "$12M+")).toMatchObject({ spoken: "over twelve million dollars", source: "rule" });
  });
  it("falls back to the rules when the decider throws", async () => {
    const lex = await buildLexicon({ ...base, decide: async () => { throw new Error("no model"); } });
    expect(entryFor(lex, "ROAS").source).toBe("rule");
    expect(entryFor(lex, "$12M+").spoken).toBe("over twelve million dollars");
  });
  it("ignores terms the decider was not asked about, and rules fill what it skipped", async () => {
    const decide: LexiconDecider = async () => [
      { term: "NOT-IN-TEXT", decision: "word", spoken: "nope", reason: "", confidence: "high" },
      { term: "ROAS", decision: "word", spoken: "<phoneme>roh-ass</phoneme>", reason: "tried markup", confidence: "high" },
    ];
    const lex = await buildLexicon({ ...base, decide });
    expect(lex.entries.map((e) => e.term)).not.toContain("NOT-IN-TEXT");
    expect(entryFor(lex, "ROAS").source).toBe("rule"); // markup answer rejected
    expect(entryFor(lex, "2026").source).toBe("rule");
  });
  it("does not call the decider when every term is already decided", async () => {
    const decide = vi.fn(async () => []);
    await buildLexicon({ ...base, overrides: { ROAS: "roh-ass", "$12M+": "over twelve million dollars", "2026": "twenty twenty-six" }, decide });
    expect(decide).not.toHaveBeenCalled();
  });
  it("hands the decider the campaign, locale, brand and examples, deduped by term", async () => {
    const decide = vi.fn(async () => []);
    await buildLexicon({ ...base, lines: [...lines, { sceneNumber: 3, text: "ROAS again." }], brandName: "Acme", campaign: "B2B analytics", decide });
    const input = (decide.mock.calls as unknown as Array<[Parameters<LexiconDecider>[0]]>)[0]![0];
    expect(input.campaign).toBe("B2B analytics");
    expect(input.locale).toBe("en-AU");
    expect(input.brandName).toBe("Acme");
    expect(input.terms.filter((t) => t.term === "ROAS")).toHaveLength(1);
    expect(input.terms.find((t) => t.term === "ROAS")!.examples).toEqual(["ROAS within a year.", "ROAS again."]);
  });
  it("applies overrides to terms the detector would not find on its own", async () => {
    const lex = await buildLexicon({ ...base, lines: [{ sceneNumber: 1, text: "We use kubernetes daily." }], overrides: { kubernetes: "koo-ber-net-eez" }, decide: async () => [] });
    expect(lex.entries).toHaveLength(1);
    expect(lex.entries[0]).toMatchObject({ term: "kubernetes", spoken: "koo-ber-net-eez", source: "operator" });
  });
  it("provider says plainly there is no markup, and review lists the guesses", async () => {
    const lex = await buildLexicon({ ...base, decide: async () => [] });
    expect(lex.provider).toBe(SEEDANCE_SPEECH_PROVIDER);
    expect(lex.provider).toMatchObject({ ssml: false, phonemes: false, dictionary: false });
    expect(lex.provider.note).toMatch(/no SSML/i);
    expect(lex.locale).toBe("en-AU");
    expect(lex.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(lexiconNeedsReview(lex).map((e) => e.term)).toContain("ROAS");
    expect(lexiconNeedsReview(lex).map((e) => e.term)).not.toContain("$12M+");
  });
});

describe("applyLexicon", () => {
  const strings = [
    "ROAS within a year, SEO and GA4 gave us $12M+ and 255% at 3.55x.",
    "  Leading spaces,   and  double   spaces ROAS ",
    "Ask Q&A about R&D and so on, etc.",
    "$12M+.",
    "SEOUL is not SEO; ROASTED is not ROAS",
    "Line one\nLine two with ROAS",
    "Nothing to replace here",
    "",
    "Use <b>bold</b> ROAS [phoneme] today",
  ];
  const lexOf = async () =>
    buildLexicon({
      lines: strings.map((text, i) => ({ sceneNumber: i + 1, text })),
      brandName: null,
      locale: "en-AU",
      overrides: { ROAS: "roh-ass" },
      decide: async () => [],
    });

  it("segments reproduce the display string exactly, for every string", async () => {
    const lex = await lexOf();
    for (const s of strings) {
      const line = applyLexicon(1, s, lex);
      expect(line.segments.map((x) => x.display).join(""), JSON.stringify(s)).toBe(s);
      expect(line.display).toBe(s);
    }
  });
  it("never emits markup in the spoken text", async () => {
    const lex = await lexOf();
    for (const s of strings) {
      const spoken = applyLexicon(1, s, lex).spoken;
      expect(spoken).not.toMatch(/[<>{}[\]]/);
      expect(spoken).not.toContain("[phoneme");
      expect(spoken).not.toContain("<phoneme");
    }
  });
  it("replaces terms in the spoken text and leaves the display alone", async () => {
    const lex = await lexOf();
    const line = applyLexicon(7, strings[0]!, lex);
    expect(line.sceneNumber).toBe(7);
    expect(line.spoken).toBe("roh-ass within a year, S E O and G A four gave us over twelve million dollars and two hundred and fifty-five percent at three point five five times.");
    const money = line.segments.find((s) => s.term === "$12M+")!;
    expect(money).toEqual({ display: "$12M+", spoken: "over twelve million dollars", term: "$12M+" });
  });
  it("keeps punctuation outside terms so prosody is preserved", async () => {
    const lex = await lexOf();
    expect(applyLexicon(1, "$12M+.", lex).spoken).toBe("over twelve million dollars.");
    expect(applyLexicon(1, "ROAS, SEO.", lex).spoken).toBe("roh-ass, S E O.");
  });
  it("matches whole terms only, case-sensitively, longest first", async () => {
    const lex = await buildLexicon({ lines: [{ sceneNumber: 1, text: "SEO and ROAS" }], brandName: null, locale: "en-AU", overrides: { ROAS: "roh-ass" }, decide: async () => [] });
    expect(applyLexicon(1, "SEOUL is not SEO; ROASTED is not ROAS", lex).spoken).toBe("SEOUL is not S E O; ROASTED is not roh-ass");
    const longest = applyLexicon(1, "12 March 2026 and 2026", {
      ...lex,
      entries: [
        { term: "2026", kind: "date", decision: "expand", spoken: "year", reason: "", confidence: "high", needsReview: false, source: "rule" },
        { term: "12 March 2026", kind: "date", decision: "expand", spoken: "the date", reason: "", confidence: "high", needsReview: false, source: "rule" },
      ],
    });
    expect(longest.spoken).toBe("the date and year");
    const lower = applyLexicon(1, "roas stays", lex);
    expect(lower.spoken).toBe("roas stays");
  });
  it("keeps the full stop when an abbreviation ends the line", async () => {
    const lex = await lexOf();
    const line = applyLexicon(1, "Ask Q&A about R&D and so on, etc.", lex);
    expect(line.spoken.endsWith("et cetera.")).toBe(true);
    expect(line.spoken).toContain("Q and A");
  });
  it("lists uncertain terms (needsReview) and not operator-confirmed ones", async () => {
    const lex = await buildLexicon({ lines: [{ sceneNumber: 1, text: "ROAS and USP and SEO" }], brandName: null, locale: "en-AU", overrides: { ROAS: "roh-ass" }, decide: async () => [] });
    const line = applyLexicon(1, "ROAS and USP and SEO", lex);
    expect(line.uncertain).toEqual(["USP"]);
  });
});
