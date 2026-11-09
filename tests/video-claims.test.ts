import { describe, expect, it } from "vitest";
import { buildClaimRegistry, figuresEquivalent, findClaimsInText, normaliseFigure, sourceClaims } from "@/lib/video/claims";
import type { ApprovedClaim } from "@/lib/video/pipeline-types";

describe("normaliseFigure", () => {
  it("reads currency amounts whatever the notation", () => {
    expect(normaliseFigure("$12M+")).toMatchObject({ value: 12_000_000, currency: "$", unit: "money" });
    expect(normaliseFigure("12 million dollars")).toMatchObject({ value: 12_000_000, currency: "$", unit: "money" });
    expect(normaliseFigure("over $12 million")).toMatchObject({ value: 12_000_000, unit: "money" });
    expect(normaliseFigure("$1,500")).toMatchObject({ value: 1500, unit: "money" });
    expect(normaliseFigure("A$2.5k")).toMatchObject({ value: 2500, currency: "$" });
    expect(normaliseFigure("£3 billion")).toMatchObject({ value: 3e9, currency: "£" });
  });
  it("reads percentages, multiples and counts", () => {
    expect(normaliseFigure("255%")).toMatchObject({ value: 255, unit: "percent" });
    expect(normaliseFigure("255 percent")).toMatchObject({ value: 255, unit: "percent" });
    expect(normaliseFigure("2x")).toMatchObject({ value: 2, unit: "multiple" });
    expect(normaliseFigure("3.55x ROAS")).toMatchObject({ value: 3.55, unit: "multiple" });
    expect(normaliseFigure("1,500")).toMatchObject({ value: 1500, unit: "count" });
    expect(normaliseFigure("1.5k+")).toMatchObject({ value: 1500, unit: "count" });
    expect(normaliseFigure("more than 300")).toMatchObject({ value: 300, unit: "count" });
  });
  it("reads figure counts and doubling words", () => {
    expect(normaliseFigure("8-figures")).toMatchObject({ value: 10_000_000, unit: "money" });
    expect(normaliseFigure("eight figures").value).toBe(10_000_000);
    expect(normaliseFigure("eight-figure").value).toBe(10_000_000);
    expect(normaliseFigure("doubled")).toMatchObject({ value: 2, unit: "multiple" });
    expect(normaliseFigure("tripled").value).toBe(3);
    expect(normaliseFigure("tenfold")).toMatchObject({ value: 10, unit: "multiple" });
    expect(normaliseFigure("10x").value).toBe(10);
  });
  it("returns none for text without a number", () => {
    expect(normaliseFigure("lots")).toMatchObject({ value: null, unit: "none" });
  });
});

describe("findClaimsInText", () => {
  const figs = (t: string) => findClaimsInText(t).map((f) => f.figure);

  it("finds money, percent, multiples, figure counts and doubling words, each with its clause", () => {
    const text = "We generated $12M+ in sales. ROAS hit 3.55x and conversions rose 255%. Leads doubled in a month, and we run eight-figure accounts.";
    expect(figs(text)).toEqual(["$12M+", "3.55x", "255%", "doubled", "eight-figure"]);
    const first = findClaimsInText(text)[0]!;
    expect(first.text).toBe("We generated $12M+ in sales.");
    expect(findClaimsInText(text)[1]!.text).toBe("ROAS hit 3.55x and conversions rose 255%.");
  });
  it("finds money written in words and bare counts", () => {
    expect(figs("Over 12 million dollars in ad spend managed for 1,500 clients.")).toEqual(["12 million dollars", "1,500"]);
    expect(figs("A 10x return, or tenfold growth")).toEqual(["10x", "tenfold"]);
  });
  it("does not flag plain years, dates or times", () => {
    expect(figs("Founded in 2012 and rebuilt in 2026.")).toEqual([]);
    expect(figs("Book before 9 March 2026 at 10:30 or 9am.")).toEqual([]);
    expect(figs("Since 1999 we have grown")).toEqual([]);
  });
  it("flags a year-looking number when it counts something", () => {
    expect(figs("Over 2000 clients served")).toEqual(["2000"]);
    expect(figs("Over 2000+ clients")).toEqual(["2000+"]);
  });
  it("does not flag the digits 1 to 3 used as list ordinals", () => {
    expect(figs("Step 1: connect. Step 2: launch. Step 3: grow.")).toEqual([]);
    expect(figs("Reason #2 and no. 3")).toEqual([]);
    expect(figs("1. Plan\n2. Build\n3) Launch")).toEqual([]);
  });
  it("still flags small numbers that are plain counts of something", () => {
    expect(figs("Set up in 2 minutes with 5 clients")).toEqual(["2", "5"]);
  });
  it("ignores numbers glued to letters, phone and id style digit groups", () => {
    expect(figs("Works with GA4 and H264, call 1300 123 456, ABN 12 345 678 901")).toEqual([]);
  });
});

describe("figuresEquivalent", () => {
  it("matches the same figure written differently and nothing else", () => {
    expect(figuresEquivalent(normaliseFigure("$12M+"), normaliseFigure("12 million dollars"))).toBe(true);
    expect(figuresEquivalent(normaliseFigure("$12M"), normaliseFigure("$15M"))).toBe(false);
    expect(figuresEquivalent(normaliseFigure("$12M"), normaliseFigure("€12M"))).toBe(false);
    expect(figuresEquivalent(normaliseFigure("doubled"), normaliseFigure("2x"))).toBe(true);
    expect(figuresEquivalent(normaliseFigure("doubled"), normaliseFigure("100% increase"))).toBe(true);
    expect(figuresEquivalent(normaliseFigure("tripled"), normaliseFigure("200% increase"))).toBe(true);
    expect(figuresEquivalent(normaliseFigure("3.55x"), normaliseFigure("3.5x"))).toBe(false);
    expect(figuresEquivalent(normaliseFigure("255%"), normaliseFigure("2.55x"))).toBe(false);
    expect(figuresEquivalent(normaliseFigure("12"), normaliseFigure("2012"))).toBe(false);
  });
});

describe("buildClaimRegistry", () => {
  const registry = buildClaimRegistry({
    stats: ["255% ROAS", "$12M+ e-commerce sales generated", "Google Partner"],
    assets: [
      { id: "a1", name: "results.png", analysis: { stats: [{ value: "255%", label: "ROAS" }, { value: "4.3", label: "star rating" }] } },
      { id: "a2", name: "plain.jpg", analysis: null },
    ],
    offerDetails: "Free audit worth $500. Limited to 20 spots.",
    instructions: "Make it 30 seconds long. Mention we have worked with 300 brands.",
    pageExcerpt: "Since 2012 we have managed over 12 million dollars of ad spend. Call us.",
    pageUrl: "https://acme.example",
    extra: [{ text: "Rated 4.9 by 800 customers", provenance: { source: "client_record", detail: "Saved on client", confidence: "medium" } }],
  });

  it("gives stable sequential ids", () => {
    expect(registry.map((c) => c.id)).toEqual(registry.map((_, i) => `claim_${i + 1}`));
    expect(new Set(registry.map((c) => c.id)).size).toBe(registry.length);
  });
  it("registers operator stats with operator provenance, and deduplicates the same figure and label from an image", () => {
    const roas = registry.filter((c) => c.figure === "255%");
    expect(roas).toHaveLength(1);
    expect(roas[0]!.provenance.source).toBe("operator");
    expect(registry.find((c) => c.figure === "$12M+")!.kind).toBe("number");
    const partner = registry.find((c) => c.text === "Google Partner")!;
    expect(partner.kind).toBe("statement");
  });
  it("registers image stats with the asset id and what the image printed", () => {
    const stars = registry.find((c) => c.figure === "4.3")!;
    expect(stars.provenance.source).toBe("image_reading");
    expect(stars.assetId).toBe("a1");
    expect(stars.evidence).toBe("4.3 star rating printed in results.png");
  });
  it("takes numeric sentences from the operator's text (page_text for the page) with verbatim evidence", () => {
    const offer = registry.find((c) => c.figure === "$500")!;
    expect(offer.provenance.source).toBe("operator");
    expect(offer.evidence).toBe("Free audit worth $500.");
    const spots = registry.find((c) => c.figure === "20")!;
    expect(spots.evidence).toBe("Limited to 20 spots.");
    const page = registry.find((c) => c.provenance.source === "page_text")!;
    expect(page.figure).toBe("12 million dollars");
    expect(page.provenance.confidence).toBe("medium");
    expect(page.provenance.url).toBe("https://acme.example");
    expect(page.evidence).toBe("Since 2012 we have managed over 12 million dollars of ad spend.");
  });
  it("does not turn video directions in the instructions into claims, but keeps real figures", () => {
    expect(registry.some((c) => c.figure === "30")).toBe(false);
    expect(registry.some((c) => c.figure === "300")).toBe(true);
  });
  it("passes through vetted extras", () => {
    expect(registry.filter((c) => c.provenance.source === "client_record").map((c) => c.figure)).toEqual(["4.9", "800"]);
  });
});

describe("sourceClaims", () => {
  const registry: ApprovedClaim[] = buildClaimRegistry({
    stats: ["$12M+ e-commerce sales generated", "Leads 2x in 90 days"],
    assets: [{ id: "a1", name: "x.png", analysis: { stats: [{ value: "3.55x", label: "ROAS" }] } }],
    pageExcerpt: "Founded in 2012.",
  });

  it("sources '$12M+' from a registry claim written as '12 million dollars', but not '$15M+'", () => {
    const reg = buildClaimRegistry({ stats: [], assets: [], offerDetails: "We have generated 12 million dollars in sales." });
    const out = sourceClaims(
      [
        { text: "Over $12M+ in sales generated", where: "scene 2 narration" },
        { text: "$15M+ in sales", where: "scene 3 stat" },
      ],
      reg,
    );
    expect(out.sourced).toHaveLength(1);
    expect(out.sourced[0]!.figure).toBe("$12M+");
    expect(out.sourced[0]!.claim.figure).toBe("12 million dollars");
    expect(out.unsourced).toHaveLength(1);
    expect(out.unsourced[0]!.use.where).toBe("scene 3 stat");
    expect(out.unsourced[0]!.figure).toBe("$15M+");
    expect(out.unsourced[0]!.reason).toMatch(/not one of the approved figures/);
  });

  it("matches 'doubled' against 2x, double and a 100% increase", () => {
    expect(sourceClaims([{ text: "Our leads doubled", where: "s1" }], registry).sourced).toHaveLength(1);
    const pct = buildClaimRegistry({ stats: ["100% increase in leads"], assets: [] });
    expect(sourceClaims([{ text: "leads doubled", where: "s1" }], pct).sourced[0]!.claim.figure).toBe("100%");
    const none = buildClaimRegistry({ stats: ["3x leads"], assets: [] });
    expect(sourceClaims([{ text: "leads doubled", where: "s1" }], none).unsourced).toHaveLength(1);
  });

  it("compares by value, so a number inside another number is not a match (the old digit-substring bug)", () => {
    const reg = buildClaimRegistry({ stats: [], assets: [], pageExcerpt: "Trusted since 2012 by 1,200 brands." });
    // The old check, corpus.includes("12"), wrongly accepted this because "2012" and "1,200" contain "12" / "2".
    const out = sourceClaims([{ text: "Over 12 clients", where: "s1" }, { text: "Over 12% growth", where: "s2" }, { text: "1,200 brands", where: "s3" }], reg);
    expect(out.unsourced.map((u) => u.figure)).toEqual(["12", "12%"]);
    expect(out.sourced.map((s) => s.figure)).toEqual(["1,200"]);
  });

  it("matches a figure found inside a longer registry claim text, and ignores uses with no figure", () => {
    const out = sourceClaims([{ text: "ROAS of 3.55x", where: "s1" }, { text: "We love ads", where: "s2" }], registry);
    expect(out.sourced).toHaveLength(1);
    expect(out.unsourced).toHaveLength(0);
    expect(out.sourced[0]!.claim.assetId).toBe("a1");
  });

  it("reports every figure in a use separately", () => {
    const out = sourceClaims([{ text: "$12M+ sales and 3.55x ROAS and a 900% jump", where: "scene 4" }], registry);
    expect(out.sourced.map((s) => s.figure)).toEqual(["$12M+", "3.55x"]);
    expect(out.unsourced.map((s) => s.figure)).toEqual(["900%"]);
  });
});
