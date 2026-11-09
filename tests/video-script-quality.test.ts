import { describe, expect, it } from "vitest";
import {
  contentWords,
  ctaFindings,
  experienceFindings,
  jaccard,
  offerFindings,
  openingFindings,
  overlapFindings,
  qualityReport,
  visualFindings,
  voiceFindings,
  type QualityFinding,
  type SpokenLine,
} from "@/lib/video/script-quality";

const L = (...lines: string[]): SpokenLine[] => lines.map((line, i) => ({ scene: i + 1, line }));
const codes = (f: QualityFinding[]) => f.map((x) => x.code);

describe("content words and similarity", () => {
  it("drops stop words, lowercases and stems lightly", () => {
    expect(contentWords("The Owners were Struggling with Invoices!")).toEqual(contentWords("owner struggle invoice"));
    expect(contentWords("the and of it")).toEqual([]);
  });
  it("folds common synonyms together", () => {
    expect(contentWords("struggling")).toEqual(contentWords("tired"));
    expect(contentWords("price")).toEqual(contentWords("costs"));
  });
  it("computes Jaccard", () => {
    expect(jaccard(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3, 5);
    expect(jaccard([], ["a"])).toBe(0);
    expect(jaccard(["a"], ["a"])).toBe(1);
  });
});

describe("openings", () => {
  it("passes a specific, concrete opening", () => {
    expect(openingFindings("Our oven died in the middle of the dinner rush.")).toEqual([]);
    expect(openingFindings("The invoice came in at $4,200 and nobody could say what it paid for.")).toEqual([]);
    expect(openingFindings("My plumber showed up with the wrong part again.")).toEqual([]);
  });
  it("flags announcing an ad or a video as a hard failure", () => {
    const f = openingFindings("This is an ad for our cleaning service.");
    expect(f.find((x) => x.code === "opening_announces_ad")?.severity).toBe("hard");
    expect(codes(openingFindings("In this video I will show you how it works."))).toContain("opening_announces_ad");
  });
  it("flags greetings and group addresses", () => {
    expect(codes(openingFindings("Hey guys, quick one for you."))).toContain("opening_greeting");
    expect(codes(openingFindings("Attention business owners, this is for you."))).toContain("opening_group_address");
  });
  it("flags stock openings", () => {
    for (const line of [
      "In today's fast-paced world, time is everything.",
      "Take your business to the next level.",
      "Unlock the power of better bookkeeping.",
      "This changes everything about how you hire.",
      "Are you tired of chasing late payments?",
      "Did you know that most invoices are wrong?",
    ]) {
      expect(codes(openingFindings(line)), line).toContain("opening_cliche");
    }
  });
  it("flags asking whether the viewer is struggling", () => {
    expect(codes(openingFindings("Are you struggling to get new customers?"))).toContain("opening_asks_struggle");
  });
  it("flags announcing a pitch and leading with the brand", () => {
    expect(codes(openingFindings("Let me tell you about a better way to do payroll."))).toContain("opening_announces_pitch");
    expect(codes(openingFindings("Brightside Cleaning is the city's favourite cleaning company."))).toContain("opening_brand_first");
    expect(codes(openingFindings("Introducing Brightside Cleaning."))).toContain("opening_brand_first");
  });
  it("flags a generic question and a vague abstract opening", () => {
    expect(codes(openingFindings("Want better results?"))).toContain("opening_generic_question");
    expect(codes(openingFindings("Grow your business and reach your goals with better marketing results."))).toContain("opening_vague");
  });
  it("flags an opening that runs too long", () => {
    const long = "Last Tuesday our oven died in the middle of the busiest dinner rush of the whole year and nobody on the line knew what to do next.";
    expect(codes(openingFindings(long))).toContain("opening_too_long");
  });
});

describe("voice", () => {
  const natural = L(
    "Our oven died in the middle of the dinner rush.",
    "I didn't know whether to laugh or cry, so I just kept plating.",
    "A neighbour walked over with her own oven on a trolley. We got through the night.",
    "It turns out most repairs are quick if you call early.",
    "Next time I'll have the number on the fridge.",
  );
  it("passes a script that sounds spoken", () => {
    expect(voiceFindings(natural)).toEqual([]);
  });
  it("flags more than one rhetorical question, and a repeated question opener", () => {
    expect(voiceFindings(L("Ever lost a night's sales?", "What would you do?"))).toHaveLength(1);
    expect(codes(voiceFindings(L("Ever lost a night's sales?", "What would you do?")))).toEqual(["rhetorical_questions"]);
    expect(voiceFindings(L("Why does it cost so much?", "Why does nobody explain it?")).map((f) => f.code)).toEqual(["rhetorical_questions", "repeated_question_opener"]);
    expect(codes(voiceFindings(L("Ever lost a night's sales? It happens."))).filter((c) => c === "rhetorical_questions")).toEqual([]);
  });
  it("flags three or more lists of exactly three", () => {
    const three = L("We fix ovens, fridges, and grills.", "We cover Tuesday, Wednesday, or Thursday.", "Bring a pot, a pan, and a lid.");
    expect(codes(voiceFindings(three))).toContain("lists_of_three");
    expect(codes(voiceFindings(three.slice(0, 2)))).not.toContain("lists_of_three");
  });
  it("flags repeated not-this-but-that constructions", () => {
    const f = voiceFindings(L("It's not a repair, it's a rescue.", "This isn't about price, but about time."));
    expect(codes(f)).toContain("not_x_but_y");
    expect(codes(voiceFindings(L("It's not a repair, it's a rescue.", "We come the same day.")))).not.toContain("not_x_but_y");
  });
  it("flags stacked slogans", () => {
    expect(codes(voiceFindings(L("Fast. Simple. Done.")))).toContain("stacked_slogans");
    expect(codes(voiceFindings(L("Real food. Real fast.")))).toContain("stacked_slogans");
    expect(codes(voiceFindings(L("Fast. We got the oven working before the second order went out.")))).not.toContain("stacked_slogans");
    expect(codes(voiceFindings(L("Yeah. No.")))).not.toContain("stacked_slogans");
  });
  it("flags corporate jargon and inflated adjectives", () => {
    expect(codes(voiceFindings(L("We leverage a seamless, robust platform.")))).toContain("jargon");
    expect(codes(voiceFindings(L("Our world-class team empowers kitchens.")))).toContain("jargon");
    expect(codes(voiceFindings(L("We fix ovens the same day."))).filter((c) => c === "jargon")).toEqual([]);
  });
  it("flags filler used more than sparingly, and forced slang", () => {
    expect(codes(voiceFindings(L("Honestly, it's literally the best oven repair.")))).toContain("filler_authenticity");
    expect(codes(voiceFindings(L("Honestly, it took a day.")))).not.toContain("filler_authenticity");
    expect(codes(voiceFindings(L("Hey guys, we fix ovens.")))).toContain("filler_authenticity");
    expect(codes(voiceFindings(L("That oven repair was lowkey a vibe.")))).toContain("forced_slang");
  });
  it("flags dashes, semicolons and colons, but not a time of day", () => {
    expect(codes(voiceFindings(L("We fix it — fast.")))).toContain("written_punctuation");
    expect(codes(voiceFindings(L("We fix it; you cook.")))).toContain("written_punctuation");
    expect(codes(voiceFindings(L("Here's the deal: we fix it.")))).toContain("written_punctuation");
    expect(codes(voiceFindings(L("We open at 10:30 every day.")))).not.toContain("written_punctuation");
  });
  it("flags over-long sentences", () => {
    const long = "We fixed the oven and then the fridge and then the grill and then the dishwasher and then we cleaned the whole kitchen before the owner came back from lunch.";
    expect(codes(voiceFindings(L(long)))).toContain("long_sentence");
  });
  it("flags a stiff script with no contractions", () => {
    const stiff = L("The oven was not working at all that night.", "We did not know who we should call for help.", "It took them a day to fix the whole problem.", "I will not forget how long that took.");
    expect(codes(voiceFindings(stiff))).toContain("no_contractions");
  });
  it("flags sentences that read like website copy", () => {
    expect(codes(voiceFindings(L("Our platform is designed by experts.")))).toContain("website_copy");
    expect(codes(voiceFindings(L("Fast, reliable and affordable service.")))).toContain("website_copy");
    expect(codes(voiceFindings(L("A customer engagement platform improves everything.")))).toContain("website_copy");
  });
  it("flags monotone rhythm", () => {
    const flat = L("We fix ovens every single day.", "They arrive within the same afternoon.", "The repair takes about one visit.", "Our vans carry most of the parts.", "Customers get a call before arrival.", "Everything is cleaned up before leaving.");
    expect(codes(voiceFindings(flat))).toContain("monotone_rhythm");
    expect(codes(voiceFindings(natural))).not.toContain("monotone_rhythm");
  });
  it("gives the scene and a quote", () => {
    const f = voiceFindings(L("Fine.", "We leverage a robust platform to help."))[0];
    expect(f.scene).toBe(2);
    expect(f.quote).toContain("leverage");
  });
});

describe("invented experience and customers", () => {
  const none = { dramatisation: false, sourceText: "Oven repair across the city." };
  it("treats a first-person result or use as a hard failure", () => {
    for (const line of ["I used it for six months and my sales doubled.", "We tried three agencies before this one.", "I was skeptical until I saw the numbers.", "Since I started, my business has grown.", "I'm a happy customer.", "It changed my life."]) {
      const f = experienceFindings(L(line), none);
      expect(f.length, line).toBeGreaterThan(0);
      expect(f.every((x) => x.severity === "hard"), line).toBe(true);
      expect(codes(f), line).toContain("fabricated_experience");
    }
  });
  it("lets the same words through when the source says them", () => {
    const f = experienceFindings(L("I used it for six months and my sales doubled."), { dramatisation: false, sourceText: "Testimonial: \"I used it for six months and my sales doubled.\" Dana, florist." });
    expect(f).toEqual([]);
  });
  it("does not flag ordinary lines", () => {
    expect(experienceFindings(L("Most owners wait too long to check.", "You can see the whole job before it starts."), none)).toEqual([]);
  });
  it("allows an acted situation but still blocks a first-person result when dramatised", () => {
    const dram = { dramatisation: true, sourceText: "" };
    // A presenter who says they used the product reads as a customer: that is not an acted situation any more.
    expect(codes(experienceFindings(L("I used it last night and the oven worked."), dram))).toEqual(["fabricated_result"]);
    expect(experienceFindings(L("I tried three plumbers before giving up."), dram)).toEqual([]);
    const f = experienceFindings(L("My business grew forty percent after that."), dram);
    expect(codes(f)).toEqual(["fabricated_result"]);
    expect(f[0].severity).toBe("hard");
  });
  it("blocks invented customers and reviews unless the source has them", () => {
    expect(codes(experienceFindings(L("Our customers say it changed everything."), none))).toContain("invented_customers");
    expect(codes(experienceFindings(L("Thousands of happy clients trust us."), none))).toContain("invented_customers");
    expect(codes(experienceFindings(L("Rated five-star reviews all year."), none))).toContain("invented_customers");
    expect(experienceFindings(L("Thousands of happy clients trust us."), { dramatisation: false, sourceText: "Thousands of happy clients trust us." })).toEqual([]);
    expect(codes(experienceFindings(L("Our customers say it is quick."), { dramatisation: true, sourceText: "" }))).toContain("invented_customers");
  });
});

describe("offers, urgency and figures", () => {
  const src = { sourceText: "Book a free audit. Average ROI of 255%. Limited-time pricing for new clients." };
  it("blocks urgency and scarcity the source does not support", () => {
    for (const line of ["Limited time only.", "Last chance to book.", "Spots are filling fast.", "The offer ends soon.", "Grab it before it's gone.", "Act now."]) {
      const f = offerFindings(L(line), { sourceText: "Oven repair across the city." });
      expect(codes(f), line).toContain("unsupported_offer");
      expect(f[0].severity).toBe("hard");
    }
    expect(offerFindings(L("Limited time only."), { sourceText: "A limited-time offer for new clients." })).toEqual([]);
  });
  it("matches free on word boundaries", () => {
    expect(offerFindings(L("Enjoy a carefree weekend."), { sourceText: "" })).toEqual([]);
    expect(offerFindings(L("Our sugar-free recipe is simple."), { sourceText: "" })).toEqual([]);
    expect(codes(offerFindings(L("It's free."), { sourceText: "Oven repair." }))).toEqual(["unsupported_offer"]);
  });
  it("lets a free offer through only when the source names the same one", () => {
    expect(offerFindings(L("Book your free audit."), src)).toEqual([]);
    expect(codes(offerFindings(L("Book your free consultation."), src))).toEqual(["unsupported_offer"]);
  });
  it("blocks discounts, guarantees, superlatives and deadlines", () => {
    const empty = { sourceText: "Oven repair across the city." };
    expect(codes(offerFindings(L("Get 20% off this month."), empty)).length).toBeGreaterThan(0);
    expect(codes(offerFindings(L("Save $50 on the first visit."), empty)).length).toBeGreaterThan(0);
    expect(codes(offerFindings(L("Backed by a money-back guarantee."), empty))).toContain("unsupported_offer");
    expect(codes(offerFindings(L("The best oven repair in town."), empty))).toContain("unsupported_offer");
    expect(codes(offerFindings(L("Book by Friday."), empty))).toContain("unsupported_offer");
    expect(offerFindings(L("A money-back guarantee on every job."), { sourceText: "We offer a money-back guarantee." })).toEqual([]);
  });
  it("checks figures against the source", () => {
    expect(offerFindings(L("Clients see 255% on average."), src)).toEqual([]);
    const f = offerFindings(L("Clients see 300% on average."), src);
    expect(codes(f)).toEqual(["unsupported_offer"]);
    expect(f[0].message).toContain("300%");
    expect(codes(offerFindings(L("It takes ten minutes."), { sourceText: "" }))).toContain("unsupported_offer");
    expect(offerFindings(L("It takes ten minutes."), { sourceText: "Setup takes 10 minutes." })).toEqual([]);
    expect(offerFindings(L("Thousands of shops use it."), { sourceText: "" }).length).toBeGreaterThan(0);
  });
  it("ignores ordinals and years, and does not double report a discount figure", () => {
    expect(offerFindings(L("Open since 2019 on the 5th floor."), { sourceText: "" })).toEqual([]);
    expect(offerFindings(L("Get 20% off."), { sourceText: "" })).toHaveLength(1);
    expect(offerFindings(L("Get 20% off."), { sourceText: "20% discount for new clients" })).toEqual([]);
  });
});

describe("the call to action", () => {
  const action = "Book a free 30 minute audit";
  const source = "Book a free 30 minute audit of your account.";
  it("passes a call to action that matches the page", () => {
    expect(ctaFindings("Book your free audit.", { conversionAction: action, sourceText: source, label: "BOOK_NOW" })).toEqual([]);
  });
  it("flags a spoken step that is not the page's step", () => {
    expect(codes(ctaFindings("Book a call today.", { conversionAction: action, sourceText: source, label: "" }))).toEqual(["cta_mismatch"]);
    expect(codes(ctaFindings("Call us now.", { conversionAction: action, sourceText: source, label: "" }))).toContain("cta_mismatch");
  });
  it("flags a generic learn more when the page has a specific step", () => {
    expect(codes(ctaFindings("Learn more.", { conversionAction: action, sourceText: source, label: "" }))).toEqual(["cta_generic"]);
    const unknown = ctaFindings("Learn more.", { conversionAction: null, sourceText: "", label: "" });
    expect(unknown[0].code).toBe("cta_generic");
    expect(unknown[0].severity).toBe("minor");
  });
  it("flags competing calls to action", () => {
    expect(codes(ctaFindings("Call us or book online.", { conversionAction: null, sourceText: "", label: "" }))).toContain("cta_competing");
    expect(codes(ctaFindings("Click the link to book.", { conversionAction: null, sourceText: "", label: "" }))).not.toContain("cta_competing");
  });
  it("flags a promise the page does not make", () => {
    const f = ctaFindings("Get your free quote today.", { conversionAction: "Request a quote", sourceText: "Request a quote for your kitchen.", label: "" });
    expect(f.find((x) => x.code === "cta_unsupported_promise")?.severity).toBe("hard");
    expect(ctaFindings("Get your free quote.", { conversionAction: "Request a free quote", sourceText: "", label: "" }).filter((x) => x.code === "cta_unsupported_promise")).toEqual([]);
  });
  it("flags a missing call to action", () => {
    expect(codes(ctaFindings("", { conversionAction: action, sourceText: source, label: "" }))).toEqual(["cta_missing"]);
  });
  it("flags a step with no benefit only when the source has one", () => {
    const ctx = { conversionAction: "Book a call", sourceText: "On the call you'll see where your budget leaks.", label: "" };
    const f = ctaFindings("Book a call.", ctx);
    expect(codes(f)).toEqual(["cta_no_benefit"]);
    expect(f[0].severity).toBe("minor");
    expect(ctaFindings("Book a call to see where the budget leaks.", ctx)).toEqual([]);
    expect(ctaFindings("Book a call.", { ...ctx, sourceText: "Oven repair." })).toEqual([]);
  });
  it("flags a button label that points elsewhere", () => {
    expect(codes(ctaFindings("Book a call.", { conversionAction: "Book a call", sourceText: "", label: "SHOP_NOW" }))).toEqual(["cta_label_mismatch"]);
  });
});

describe("visuals", () => {
  it("passes specific, filmable scenes", () => {
    expect(
      visualFindings([
        { scene: 1, visual: "A baker slides a tray of rolls into a wide stone oven at dawn." },
        { scene: 2, visual: "A delivery van pulls up outside a corner shop in the rain." },
        { scene: 3, visual: "Two kids split a pastry on a bus stop bench." },
      ]),
    ).toEqual([]);
  });
  it("flags a trope repeated across scenes", () => {
    const f = visualFindings([
      { scene: 1, visual: "A woman at her laptop looks frustrated." },
      { scene: 2, visual: "A baker kneads dough." },
      { scene: 3, visual: "A man at his desk, stressed, stares at the screen." },
    ]);
    expect(codes(f)).toContain("repeated_visual_trope");
  });
  it("flags the frustrated then relieved arc", () => {
    const f = visualFindings([
      { scene: 1, visual: "A woman at her laptop looks frustrated." },
      { scene: 4, visual: "She leans back, relieved, and smiles." },
    ]);
    expect(codes(f)).toContain("visual_trope_arc");
  });
  it("flags typing close-ups, dashboards and stock celebration", () => {
    expect(codes(visualFindings([{ scene: 1, visual: "Close-up of fingers typing on a keyboard." }, { scene: 2, visual: "Hands typing quickly." }]))).toContain("repeated_visual_trope");
    expect(codes(visualFindings([{ scene: 2, visual: "A floating holographic dashboard glows over the desk." }]))).toContain("cliche_visual");
    expect(codes(visualFindings([{ scene: 3, visual: "Two colleagues shake hands and high-five." }]))).toContain("cliche_visual");
  });
  it("flags the same setting in three or more scenes", () => {
    const f = visualFindings([
      { scene: 1, visual: "A cook stands in the kitchen." },
      { scene: 2, visual: "A phone rings in the kitchen." },
      { scene: 3, visual: "The kitchen goes quiet." },
    ]);
    expect(codes(f)).toEqual(["same_setting"]);
    expect(visualFindings([{ scene: 1, visual: "A cook stands in the kitchen." }, { scene: 2, visual: "A van in the street." }])).toEqual([]);
  });
  it("flags visuals that depend on readable text, screens, logos or anatomy", () => {
    expect(codes(visualFindings([{ scene: 1, visual: "Close-up of the dashboard screen reading 255%." }]))).toContain("visual_needs_text");
    expect(codes(visualFindings([{ scene: 1, visual: "The company logo fills the frame." }]))).toContain("visual_needs_text");
    expect(codes(visualFindings([{ scene: 1, visual: "A man counting on his fingers." }]))).toContain("visual_complex_anatomy");
  });
});

describe("overlap between the three versions", () => {
  const A = { id: "A", premise: "A restaurant oven fails during the dinner rush and the owner has no backup", lines: ["Our oven died in the middle of the dinner rush.", "We had forty covers booked and no way to cook them.", "A neighbour lent us hers and we got through the night."] };
  const B = { id: "B", premise: "A plumber arrives with the wrong part and the customer waits another day", lines: ["The plumber arrived at noon with the wrong valve.", "Another day without hot water for the whole house.", "Next time ask whether the van carries stock first."] };
  const C = { id: "C", premise: "A bakery owner finds out the shop's rent doubled quietly over the winter", lines: ["Nobody told me the rent had doubled by February.", "Flour and butter got cheaper while the landlord got greedier.", "Now the lease sits next to the till and gets read monthly."] };

  it("passes three genuinely different scripts", () => {
    const r = overlapFindings([A, B, C]);
    expect(r.pairs).toHaveLength(3);
    expect(r.findings).toEqual([]);
    for (const p of r.pairs) expect(p.similarity).toBeLessThan(0.3);
  });
  it("catches a synonym-swapped duplicate", () => {
    const X = { id: "X", lines: ["Are you struggling with slow invoices every month?", "Our team fixes billing errors fast and keeps clients paying.", "Book a call today."], premise: "slow invoices hurt every month" };
    const Y = { id: "Y", lines: ["Are you tired with slow bills every month?", "Our crew fixes billing mistakes quick and keeps customers paying.", "Schedule a call today."], premise: "slow bills hurt every month" };
    const r = overlapFindings([X, Y, C]);
    const dup = r.findings.find((f) => f.code === "duplicate_angle");
    expect(dup?.severity).toBe("hard");
    expect(dup?.scripts.sort()).toEqual(["X", "Y"]);
    expect(r.pairs.find((p) => p.a === "X" && p.b === "Y")!.similarity).toBeGreaterThan(0.5);
  });
  it("catches a reworded duplicate premise even when the text differs", () => {
    const P = { id: "P", premise: "late payments quietly drain a small shop's cash every month", lines: ["Mia counts the till at midnight again."] };
    const Q = { id: "Q", premise: "late payments quietly drain a small shop's cash every single month", lines: ["Tomas stares at the overdue pile on the counter."] };
    expect(overlapFindings([P, Q]).findings.map((f) => f.code)).toContain("duplicate_angle");
  });
  it("calls the moderate band a weak difference, not a duplicate", () => {
    const P = { id: "P", lines: ["The oven died during the dinner rush and the kitchen went quiet.", "Neighbours lent a hand and the owner called around for parts."], premise: "oven fails at the worst time" };
    const Q = { id: "Q", lines: ["Halfway through service the fridge gave up and the kitchen went quiet.", "Neighbours lent a hand while the owner phoned about parts."], premise: "fridge fails at lunch" };
    const r = overlapFindings([P, Q]);
    expect(r.pairs[0].similarity).toBeGreaterThanOrEqual(0.3);
    expect(r.findings.map((f) => f.code)).toContain("weak_difference");
    expect(r.findings.find((f) => f.code === "weak_difference")?.severity).toBe("major");
  });
  it("flags the same first three words", () => {
    const r = overlapFindings([
      { id: "A", lines: ["Every month the invoice arrives late."] },
      { id: "B", lines: ["Every month the oven needs a clean."] },
    ]);
    expect(r.findings.map((f) => f.code)).toContain("same_opening_pattern");
  });
  it("flags one statistic reused in every version", () => {
    const withStat = (id: string, line: string) => ({ ...({ id, lines: [line] }), stats: ["255%"] });
    const r = overlapFindings([withStat("A", "Oven repairs reached 255% growth."), withStat("B", "Vans carry stock, 255% better."), withStat("C", "Rent rose, 255% overall.")]);
    expect(r.findings.find((f) => f.code === "reused_stat")?.severity).toBe("minor");
    const mixed = overlapFindings([withStat("A", "Oven repairs reached growth."), { id: "B", lines: ["Vans carry stock."] }]);
    expect(mixed.findings.map((f) => f.code)).not.toContain("reused_stat");
  });
});

describe("the whole report", () => {
  const source = "Oven repair across the city. Same day callouts. Book a free repair assessment.";
  const clean = {
    lines: L(
      "Our oven died in the middle of the dinner rush.",
      "I didn't know whether to laugh or cry, so I just kept plating.",
      "A neighbour walked over with her own oven on a trolley. We got through the night.",
      "It turns out most repairs are quick if you call early.",
      "Next time I'll have the number on the fridge.",
    ),
    visuals: [
      { scene: 1, visual: "A cook pulls a tray of cold dough from a dead oven." },
      { scene: 2, visual: "A waiter hurries past with plates, steam rising." },
      { scene: 3, visual: "An older woman wheels a small oven along the pavement on a trolley." },
    ],
    cta: { spoken: "Book a free repair assessment.", label: "BOOK_NOW" },
    dramatisation: false,
    sourceText: source,
    conversionAction: "Book a free repair assessment",
  };

  it("returns nothing for a clean script", () => {
    expect(qualityReport(clean)).toEqual([]);
  });
  it("sorts hard findings first and covers every area", () => {
    const bad = {
      ...clean,
      lines: L("Hey guys, are you tired of dead ovens?", "I used it and my sales doubled — honestly, it's literally seamless.", "Limited time only."),
      visuals: [
        { scene: 1, visual: "A woman at her laptop looks frustrated." },
        { scene: 2, visual: "A man at his desk, stressed, stares at the screen." },
      ],
      cta: { spoken: "Call us or book a call today.", label: "BOOK_NOW" },
    };
    const f = qualityReport(bad);
    const sev = f.map((x) => x.severity);
    const rank = { hard: 0, major: 1, minor: 2 } as const;
    expect(sev).toEqual([...sev].sort((a, b) => rank[a] - rank[b]));
    expect(sev[0]).toBe("hard");
    const all = codes(f);
    for (const c of ["opening_greeting", "fabricated_experience", "unsupported_offer", "jargon", "filler_authenticity", "repeated_visual_trope", "cta_competing"]) expect(all).toContain(c);
    expect(f.find((x) => x.code === "opening_greeting")?.scene).toBe(1);
  });
  it("does not report the same unsupported offer twice when the closing line is also a spoken line", () => {
    const f = qualityReport({
      ...clean,
      sourceText: "Oven repair across the city.",
      conversionAction: "Request a repair",
      lines: L("Our oven died in the middle of the dinner rush.", "It turns out most repairs are quick if you call early.", "Get your free quote today."),
      cta: { spoken: "Get your free quote today.", label: "GET_QUOTE" },
    });
    expect(codes(f).filter((c) => c === "unsupported_offer" || c === "cta_unsupported_promise")).toHaveLength(1);
  });
});

describe("fixes are instructions, not replacement copy", () => {
  it("never puts quoted wording or a script in a fix", () => {
    const source = "Oven repair across the city.";
    const findings: QualityFinding[] = [
      ...openingFindings("Hey guys, this is an ad. Are you tired of dead ovens in today's fast-paced world? Brightside is the best."),
      ...openingFindings("Want better results?"),
      ...openingFindings("Grow your business and reach your goals with better marketing results."),
      ...voiceFindings(
        L(
          "Ever lost a night's sales?",
          "What would you do?",
          "It's not a repair, it's a rescue.",
          "This isn't about price, but about time.",
          "Fast. Simple. Done.",
          "We leverage a robust platform — honestly, it's literally the best.",
          "Our platform is designed by experts.",
          "We fix ovens, fridges, and grills.",
          "We cover Tuesday, Wednesday, or Thursday.",
          "Bring a pot, a pan, and a lid.",
          "The oven was not working at all that night and nobody at the restaurant knew who to ring for help.",
        ),
      ),
      ...experienceFindings(L("I used it and my sales doubled.", "Our customers say it is quick.", "I tried it."), { dramatisation: false, sourceText: source }),
      ...experienceFindings(L("My business grew a lot."), { dramatisation: true, sourceText: source }),
      ...offerFindings(L("Limited time only.", "It's free.", "Get 20% off.", "The best in town.", "Book by Friday.", "It takes ten minutes.", "A money-back guarantee."), { sourceText: source }),
      ...ctaFindings("", { conversionAction: null, sourceText: "", label: "" }),
      ...ctaFindings("Call us or book a call. Free quote today.", { conversionAction: "Book a free audit", sourceText: "You'll see where it leaks.", label: "SHOP_NOW" }),
      ...ctaFindings("Learn more.", { conversionAction: "Book a free audit", sourceText: "", label: "" }),
      ...visualFindings([
        { scene: 1, visual: "A woman at her laptop looks frustrated." },
        { scene: 2, visual: "A man at his desk, stressed, stares at the screen." },
        { scene: 3, visual: "She leans back, relieved. Floating dashboard. The company logo. Counting on his fingers. Typing on a keyboard." },
        { scene: 4, visual: "In the kitchen." },
        { scene: 5, visual: "The kitchen again." },
        { scene: 6, visual: "A kitchen." },
      ]),
      ...overlapFindings([
        { id: "A", premise: "slow invoices hurt every month", lines: ["Every month the invoice arrives late and costs 255%."], stats: ["255%"] },
        { id: "B", premise: "slow bills hurt every month", lines: ["Every month the invoice arrives late and costs 255%."], stats: ["255%"] },
      ]).findings,
    ];
    expect(findings.length).toBeGreaterThan(30);
    const verbs = /^(Open|Start|Cut|Remove|Rewrite|Say|Name|Change|Keep|Use|Split|Drop|Make|Show|Give|Pick|Vary|Delete|Take|Add|Put|Turn|Join|Talk|Move|Rebuild|Frame|Contract|Replace|Lead|State)\b/;
    for (const f of findings) {
      expect(f.fix, f.code).toMatch(verbs);
      expect(f.fix, f.code).not.toMatch(/["“”]/);
      expect(f.fix.length, f.code).toBeLessThan(220);
      if (f.quote) expect(f.fix, f.code).not.toContain(f.quote);
      expect(["hard", "major", "minor"]).toContain(f.severity);
      expect(f.code).toMatch(/^[a-z_]+$/);
      expect(f.message.length).toBeGreaterThan(10);
    }
  });
});

describe("stock phrases", () => {
  it("flags the lines that could sit in almost any ad, without supplying a replacement", () => {
    const out = voiceFindings([
      { scene: 2, line: "Imagine streamlining your whole month." },
      { scene: 3, line: "With us you get peace of mind." },
      { scene: 4, line: "Granules in the gutter, and a ladder against the wall." },
    ]);
    const stock = out.filter((f) => f.code === "stock_phrase");
    expect(stock.map((f) => f.scene)).toEqual([2, 3]);
    expect(stock[0]!.fix).not.toMatch(/"/);
  });
});

describe("contact details", () => {
  const source = "Book at kestrelroofing.example/inspect or call 02 5550 0188.";
  it("accepts the web address and phone number exactly as the page gives them", async () => {
    const { contactFindings } = await import("@/lib/video/script-quality");
    expect(contactFindings([{ scene: 4, line: "Book at kestrelroofing.example/inspect, or call 02 5550 0188." }], { sourceText: source })).toEqual([]);
    expect(contactFindings([{ scene: 4, line: "Call 0255500188 today." }], { sourceText: source })).toEqual([]);
  });
  it("flags a changed domain or a different number as a hard failure", async () => {
    const { contactFindings } = await import("@/lib/video/script-quality");
    const web = contactFindings([{ scene: 4, line: "Head to kestrelroofing.com/inspect now." }], { sourceText: source });
    expect(web).toHaveLength(1);
    expect(web[0]).toMatchObject({ code: "cta_unsupported_contact", severity: "hard", scene: 4 });
    expect(contactFindings([{ scene: 4, line: "Call 02 5550 0199 today." }], { sourceText: source })[0]!.message).toMatch(/phone number/);
  });
});

describe("a presenter endorsing the product", () => {
  it("flags first-person endorsements and outcomes even in an acted scene", () => {
    const lines = [
      "This coaching really works for me!",
      "Finally reaching my goals feels amazing.",
      "I just booked my inspection online.",
      "Now I know exactly what is going on up there.",
      "Every session fills me with energy.",
    ].map((line, i) => ({ scene: i + 1, line }));
    const out = experienceFindings(lines, { dramatisation: true, sourceText: "Weekly check-ins by video." });
    expect(new Set(out.map((f) => f.scene))).toEqual(new Set([1, 2, 3, 4, 5]));
    expect(out.every((f) => f.severity === "hard")).toBe(true);
  });
  it("leaves a situation the viewer will recognise alone", () => {
    expect(experienceFindings([{ scene: 1, line: "You open the gutter and find granules." }], { dramatisation: true, sourceText: "" })).toEqual([]);
  });
});

describe("customers and users that nothing in the sources shows", () => {
  it("flags happy-customer lines and a presenter speaking as a user", () => {
    const flagged = [
      "Another happy customer enjoying hot water again.",
      "It's great seeing our patients leave so happy.",
      "You're thriving!",
      "With Ledgerly, I can match most bank lines automatically.",
      "I can actually take a breather now.",
    ];
    for (const [i, line] of flagged.entries()) {
      const out = experienceFindings([{ scene: i + 1, line }], { dramatisation: true, sourceText: "" });
      expect(out.length, line).toBeGreaterThan(0);
      expect(out.every((f) => f.severity === "hard")).toBe(true);
    }
  });
  it("leaves the viewer's own situation alone", () => {
    for (const line of ["With a plan around your week, check-ins keep you on track.", "Is your hot water out again?", "With Rheem units the tank warranty is 12 years."]) {
      expect(experienceFindings([{ scene: 1, line }], { dramatisation: true, sourceText: "Rheem units come with a 12 year tank warranty." }), line).toEqual([]);
    }
  });
});
