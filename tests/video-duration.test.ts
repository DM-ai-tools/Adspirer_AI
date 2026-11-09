import { afterEach, describe, expect, it, vi } from "vitest";
import { buildScriptSpeech, DEFAULT_WORDS_PER_SECOND, estimateSpeech, resolveWordsPerSecond, speechBudget, speechFit } from "@/lib/video/duration";

afterEach(() => vi.unstubAllEnvs());

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${"abcdefghij"[i % 10]}`).join(" ");

describe("words per second", () => {
  it("defaults to a relaxed ad read", () => {
    vi.stubEnv("VIDEO_WORDS_PER_SECOND", "");
    expect(resolveWordsPerSecond()).toBe(DEFAULT_WORDS_PER_SECOND);
    expect(resolveWordsPerSecond(null)).toBe(2.5);
  });
  it("clamps to a believable spoken range", () => {
    expect(resolveWordsPerSecond(0)).toBe(2.5); // not a usable value: falls back to the default
    expect(resolveWordsPerSecond(Number.NaN)).toBe(2.5);
    expect(resolveWordsPerSecond(1)).toBe(1.8);
    expect(resolveWordsPerSecond(9)).toBe(3.2);
    expect(resolveWordsPerSecond(2.2)).toBe(2.2);
  });
  it("reads the env override only when no value is given", () => {
    vi.stubEnv("VIDEO_WORDS_PER_SECOND", "2.9");
    expect(resolveWordsPerSecond()).toBe(2.9);
    expect(resolveWordsPerSecond(2.1)).toBe(2.1);
    vi.stubEnv("VIDEO_WORDS_PER_SECOND", "40");
    expect(resolveWordsPerSecond()).toBe(3.2);
    vi.stubEnv("VIDEO_WORDS_PER_SECOND", "nonsense");
    expect(resolveWordsPerSecond()).toBe(2.5);
  });
});

describe("the speech budget", () => {
  it("allows more words for a longer ad and always reserves time", () => {
    const targets = [15, 30, 45, 60].map((s) => speechBudget({ seconds: s, wordsPerSecond: 2.5 }));
    for (let i = 1; i < targets.length; i++) expect(targets[i].target).toBeGreaterThan(targets[i - 1].target);
    for (const b of targets) {
      expect(b.reservedSeconds).toBeGreaterThan(0);
      expect(b.speechSeconds).toBeLessThan(b.totalSeconds);
      expect(b.min).toBeLessThan(b.target);
      expect(b.max).toBeGreaterThan(b.target);
      expect(b.target).toBeLessThan(b.totalSeconds * 2.5); // never the flat words-per-second
    }
  });
  it("is plainly explained, and short ads aim for one idea", () => {
    const short = speechBudget({ seconds: 15 });
    expect(short.notes.join(" ")).toMatch(/one idea/i);
    const thirty = speechBudget({ seconds: 30 });
    expect(thirty.notes[0]).toMatch(/^A 30s ad: about \d+s reserved for pauses and the CTA, so about \d+ words/);
    expect(thirty.notes.join(" ")).not.toMatch(/one idea/i);
    expect(thirty.notes.join(" ")).toMatch(/pauses/);
  });
  it("lets a longer ad reserve a larger share for pauses than a short one", () => {
    const a = speechBudget({ seconds: 20, ctaWords: 0 });
    const b = speechBudget({ seconds: 40, ctaWords: 0 });
    expect(b.reservedSeconds / b.totalSeconds).toBeGreaterThan(a.reservedSeconds / a.totalSeconds);
  });
  it("takes the closing line out of the budget", () => {
    const none = speechBudget({ seconds: 30, ctaWords: 0 });
    const twelve = speechBudget({ seconds: 30, ctaWords: 12 });
    expect(twelve.target).toBeLessThan(none.target);
    expect(twelve.reservedSeconds).toBeGreaterThan(none.reservedSeconds);
    expect(twelve.notes.join(" ")).toMatch(/end card is not part/i);
  });
  it("holds back silent beats and demonstrations", () => {
    const base = speechBudget({ seconds: 45 });
    expect(speechBudget({ seconds: 45, visualBeats: 2 }).target).toBeLessThan(base.target);
    expect(speechBudget({ seconds: 45, demonstration: true }).target).toBeLessThan(base.target);
  });
  it("never reserves more than most of the ad and keeps a floor", () => {
    const b = speechBudget({ seconds: 10, visualBeats: 8, demonstration: true, ctaWords: 30 });
    expect(b.reservedSeconds).toBeLessThanOrEqual(6.1);
    expect(b.target).toBeGreaterThanOrEqual(8);
    expect(b.min).toBeGreaterThanOrEqual(6);
  });
  it("follows the clamped pace", () => {
    expect(speechBudget({ seconds: 30, wordsPerSecond: 9 }).wordsPerSecond).toBe(3.2);
    expect(speechBudget({ seconds: 30, wordsPerSecond: 3.2 }).target).toBeGreaterThan(speechBudget({ seconds: 30, wordsPerSecond: 2 }).target);
  });
});

describe("estimating speech", () => {
  it("is zero for nothing and deterministic otherwise", () => {
    expect(estimateSpeech("  ")).toEqual({ words: 0, seconds: 0, pauseSeconds: 0 });
    const t = "We fixed it. It took a week, though.";
    expect(estimateSpeech(t)).toEqual(estimateSpeech(t));
  });
  it("adds time for sentence ends, soft pauses and line breaks", () => {
    const plain = estimateSpeech("we fixed it and it took a week");
    const commas = estimateSpeech("we fixed it, and it took a week");
    const sentences = estimateSpeech("we fixed it. And it took a week");
    const broken = estimateSpeech("we fixed it\nand it took a week");
    expect(plain.pauseSeconds).toBe(0);
    expect(commas.pauseSeconds).toBeCloseTo(0.15, 2);
    expect(sentences.pauseSeconds).toBeCloseTo(0.35, 2);
    expect(broken.pauseSeconds).toBeGreaterThan(0);
    expect(sentences.seconds).toBeGreaterThan(commas.seconds);
    expect(commas.seconds).toBeGreaterThan(plain.seconds);
    expect(plain.words).toBe(8);
  });
  it("does not count the pause after the last sentence, a decimal point or a comma in a number", () => {
    expect(estimateSpeech("It took a week.").pauseSeconds).toBe(0);
    expect(estimateSpeech("It cost 3.5 times more").pauseSeconds).toBe(0);
    expect(estimateSpeech("It cost 1,500 dollars").pauseSeconds).toBe(0);
  });
  it("slows down for numerals, currencies and acronyms", () => {
    const said = estimateSpeech("we saved a lot of money last year");
    const figures = estimateSpeech("we saved $12M+ last year");
    expect(figures.words).toBeLessThan(said.words);
    expect(figures.seconds).toBeGreaterThan(estimateSpeech("we saved money last year").seconds);
    expect(estimateSpeech("our CRM and ROI tools").seconds).toBeGreaterThan(estimateSpeech("our big and fast tools").seconds);
    expect(estimateSpeech("up 255%").seconds).toBeGreaterThan(estimateSpeech("up so far").seconds);
    expect(estimateSpeech("1,500 brands").seconds).toBeGreaterThan(estimateSpeech("15 brands").seconds);
  });
  it("takes a little longer for long words", () => {
    expect(estimateSpeech("organization responsibilities", { wordsPerSecond: 2.5 }).seconds).toBeGreaterThan(estimateSpeech("cats and dogs", { wordsPerSecond: 2.5 }).seconds - 0.2);
    expect(estimateSpeech("internationalization characteristically").seconds).toBeGreaterThan(estimateSpeech("small tidy words").seconds - 0.01);
  });
  it("uses the pace it is given", () => {
    const text = words(25);
    expect(estimateSpeech(text, { wordsPerSecond: 3 }).seconds).toBeLessThan(estimateSpeech(text, { wordsPerSecond: 2 }).seconds);
  });
});

describe("does it fit", () => {
  it("fits between about 12% under and 5% over", () => {
    expect(speechFit(30, 30).fit).toBe("fits");
    expect(speechFit(31.5, 30).fit).toBe("fits");
    expect(speechFit(31.6, 30).fit).toBe("long");
    expect(speechFit(26.4, 30).fit).toBe("fits");
    expect(speechFit(26.3, 30).fit).toBe("short");
  });
  it("says the difference in plain words", () => {
    const long = speechFit(34, 30);
    expect(long.deltaSeconds).toBe(4);
    expect(long.message).toBe("About 4s over: edit the script, do not speed up the narrator.");
    const short = speechFit(22, 30);
    expect(short.deltaSeconds).toBe(-8);
    expect(short.message).toMatch(/^About 8s short/);
    expect(speechFit(30, 30).message).toMatch(/Fits the requested 30s/);
  });
});

describe("building the script's speech", () => {
  const lines = [
    "Our oven died in the middle of the dinner rush.",
    "We had forty covers booked and no way to cook them.",
    "A neighbour lent us hers, and we got through the night.",
    "Next day we called the repair team.",
    "Book a repair today.",
  ];

  it("returns the full shape", () => {
    const s = buildScriptSpeech(lines, 30, 2.5, { ctaWords: 4 });
    expect(s.words).toBe(lines.join(" ").split(/\s+/).length);
    expect(s.wordsPerSecond).toBe(2.5);
    expect(s.requestedSeconds).toBe(30);
    expect(s.measuredSeconds).toBeNull();
    expect(s.budgetWords.min).toBeLessThan(s.budgetWords.target);
    expect(s.budgetWords.target).toBeLessThan(s.budgetWords.max);
    expect(["fits", "long", "short"]).toContain(s.fit);
    expect(s.estimatedSeconds).toBeGreaterThan(0);
  });
  it("flags a script far too short for the length", () => {
    expect(buildScriptSpeech(lines, 60, 2.5, { ctaWords: 4 }).fit).toBe("short");
  });
  it("calls a 140 word script for 30 seconds long, and speeding up the narrator does not fix it", () => {
    const sentence = "Customers keep asking us why the invoice changed every single month and we never had an answer ready. ";
    const long = (sentence.repeat(8).trim().split(/\s+/).slice(0, 140).join(" ") + ".").split(/(?<=\.)\s+/);
    expect(long.join(" ").split(/\s+/).length).toBeGreaterThanOrEqual(139);
    for (const wps of [2.5, 3, 3.2, 9]) {
      const s = buildScriptSpeech(long, 30, wps, { ctaWords: 6 });
      expect(s.fit).toBe("long");
      expect(s.wordsPerSecond).toBeLessThanOrEqual(3.2);
    }
  });
  it("counts silent beats toward the estimate", () => {
    const base = buildScriptSpeech(lines, 30, 2.5);
    const withBeats = buildScriptSpeech(lines, 30, 2.5, { visualBeats: 2 });
    expect(withBeats.estimatedSeconds).toBeGreaterThan(base.estimatedSeconds);
  });
  it("calls a script written to the budget a fit", () => {
    const b = speechBudget({ seconds: 30, wordsPerSecond: 2.5, ctaWords: 5 });
    const body = Array.from({ length: 6 }, () => words(Math.round(b.target / 6)).replace(/word/g, "tool") + ".");
    const s = buildScriptSpeech([...body, "Book a repair today now."], 30, 2.5, { ctaWords: 5 });
    expect(s.fit).toBe("fits");
  });
});
