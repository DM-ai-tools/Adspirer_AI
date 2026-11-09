import { describe, expect, it } from "vitest";
import type { AsrWord, TimedWord } from "@/lib/video/captions";
import { applyLexicon, buildLexicon } from "@/lib/video/pronunciation";
import type { PronunciationLexicon, SpeechLine } from "@/lib/video/pipeline-types";
import {
  DEFAULT_CUE_OPTIONS,
  alignSpeechLine,
  buildCues,
  checkCues,
  compareSpokenToExpected,
  safeCaptionY,
  spokenTokens,
  toSrt,
  toVtt,
  type AlignedLine,
  type SubtitleCue,
} from "@/lib/video/subtitles";

const asrWord = (word: string, start: number, end: number): AsrWord => ({ word, start, end });
const tw = (text: string, start: number, end: number): TimedWord => ({ text, start, end, matched: true });
const cue = (start: number, end: number, lines: string[], words: TimedWord[] = []): SubtitleCue => ({ start, end, words, lines, text: lines.join("\n") });

async function speechFor(texts: Array<[number, string]>, overrides: Record<string, string> = {}): Promise<{ lines: SpeechLine[]; lexicon: PronunciationLexicon }> {
  const lexicon = await buildLexicon({ lines: texts.map(([n, text]) => ({ sceneNumber: n, text })), brandName: null, locale: "en-AU", overrides, decide: async () => [] });
  return { lines: texts.map(([n, t]) => applyLexicon(n, t, lexicon)), lexicon };
}

describe("spokenTokens", () => {
  it("normalises numbers, currency, hyphens and punctuation so heard and expected words meet", () => {
    expect(spokenTokens("Roh-ass, 12 million!")).toEqual(["roh", "ass", "twelve", "million"]);
    expect(spokenTokens("$1,200")).toEqual(["one", "thousand", "two", "hundred"]);
    expect(spokenTokens("255%")).toEqual(["two", "hundred", "fifty", "five", "percent"]);
    expect(spokenTokens("—")).toEqual([]);
  });
});

describe("alignSpeechLine", () => {
  const text = "ROAS within a year, we made $12M+ fast.";
  const window = { start: 0, end: 4 };
  const heardRowAs: AsrWord[] = [
    asrWord("row", 0.2, 0.45),
    asrWord("as", 0.45, 0.7),
    asrWord("within", 0.75, 1.0),
    asrWord("a", 1.0, 1.1),
    asrWord("year", 1.1, 1.4),
    asrWord("we", 1.6, 1.7),
    asrWord("made", 1.7, 1.9),
    asrWord("twelve", 2.0, 2.3),
    asrWord("million", 2.3, 2.7),
    asrWord("dollars", 2.7, 3.1),
    asrWord("fast", 3.2, 3.5),
  ];

  it("maps the spoken 'twelve million dollars' and 'row as' back onto $12M+ and ROAS, display untouched", async () => {
    const { lines } = await speechFor([[1, text]], { ROAS: "roh-ass" });
    const line = lines[0]!;
    expect(line.spoken).toBe("roh-ass within a year, we made over twelve million dollars fast.");
    const out = alignSpeechLine(line, heardRowAs, window);
    expect(out.words.map((w) => w.text)).toEqual(["ROAS", "within", "a", "year,", "we", "made", "$12M+", "fast."]);
    expect(out.words.map((w) => w.text).join(" ")).toBe(text);
    expect(out.fromAudio).toBe(true);
    expect(out.matchedShare).toBeGreaterThan(0.8);
    const roas = out.words[0]!;
    expect(roas.start).toBeCloseTo(0.2, 1);
    expect(roas.end).toBeCloseTo(0.7, 1);
    const money = out.words[6]!;
    expect(money.start).toBeGreaterThanOrEqual(1.85); // the unheard "over" sits between "made" and "twelve"
    expect(money.start).toBeLessThanOrEqual(2.01);
    expect(money.end).toBeCloseTo(3.1, 1);
    expect(out.words[7]!.start).toBeCloseTo(3.2, 1);
  });

  it("matches 'roas' heard as one word to the two spoken words roh-ass", async () => {
    const { lines } = await speechFor([[1, "ROAS rose"]], { ROAS: "roh-ass" });
    const out = alignSpeechLine(lines[0]!, [asrWord("roas", 0.2, 0.8), asrWord("rose", 0.9, 1.3)], { start: 0, end: 2 });
    expect(out.fromAudio).toBe(true);
    expect(out.words[0]!.start).toBeCloseTo(0.2, 1);
    expect(out.words[0]!.end).toBeCloseTo(0.8, 1);
    expect(out.words[1]!.start).toBeCloseTo(0.9, 1);
  });

  it("keeps every timing monotonic and inside the window", async () => {
    const { lines } = await speechFor([[1, text]], { ROAS: "roh-ass" });
    for (const asr of [heardRowAs, heardRowAs.slice(3), [asrWord("fast", 9, 9.5)], []]) {
      const out = alignSpeechLine(lines[0]!, asr, window);
      let last = window.start;
      for (const w of out.words) {
        expect(w.start).toBeGreaterThanOrEqual(window.start);
        expect(w.end).toBeLessThanOrEqual(window.end + 1e-9);
        expect(w.end).toBeGreaterThanOrEqual(w.start);
        expect(w.start).toBeGreaterThanOrEqual(last - 1e-9);
        last = w.start;
      }
    }
  });

  it("spaces words evenly and says it is not from the audio when there is no transcript", async () => {
    const { lines } = await speechFor([[1, "one two three four"]]);
    for (const asr of [null, []]) {
      const out = alignSpeechLine(lines[0]!, asr, { start: 10, end: 14 });
      expect(out.fromAudio).toBe(false);
      expect(out.matchedShare).toBe(0);
      const starts = out.words.map((w) => w.start);
      expect([...starts].sort((a, b) => a - b)).toEqual(starts);
      expect(new Set(starts).size).toBe(4);
      expect(starts[0]!).toBeGreaterThanOrEqual(10);
      expect(out.words[3]!.end).toBeLessThanOrEqual(14);
      const gaps = starts.slice(1).map((s, i) => s - starts[i]!);
      expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(1e-6);
    }
  });

  it("does not trust a transcript that barely matches", async () => {
    const { lines } = await speechFor([[1, "one two three four five six"]]);
    const out = alignSpeechLine(lines[0]!, [asrWord("one", 0.1, 0.4), asrWord("banana", 0.5, 0.9), asrWord("apple", 1, 1.4), asrWord("pear", 1.5, 1.9)], { start: 0, end: 6 });
    expect(out.matchedShare).toBeLessThan(0.6);
    expect(out.fromAudio).toBe(false);
  });

  it("spreads a multi-word term across its display words and binds them", async () => {
    const { lines } = await speechFor([[1, "Launch on 12 March 2026 now"]]);
    const spoken = lines[0]!.spoken;
    expect(spoken).toBe("Launch on the twelfth of March twenty twenty-six now");
    const asr = [
      asrWord("Launch", 0.1, 0.5),
      asrWord("on", 0.5, 0.6),
      asrWord("the", 0.7, 0.8),
      asrWord("twelfth", 0.8, 1.2),
      asrWord("of", 1.2, 1.3),
      asrWord("March", 1.3, 1.7),
      asrWord("twenty", 1.7, 2.0),
      asrWord("twenty-six", 2.0, 2.6),
      asrWord("now", 2.8, 3.1),
    ];
    const out = alignSpeechLine(lines[0]!, asr, { start: 0, end: 4 });
    expect(out.words.map((w) => w.text)).toEqual(["Launch", "on", "12", "March", "2026", "now"]);
    expect(out.bind).toEqual([false, false, false, true, true, false]);
    expect(out.words[2]!.start).toBeCloseTo(0.7, 1);
    expect(out.words[4]!.end).toBeCloseTo(2.6, 1);
    expect(out.words[3]!.start).toBeGreaterThanOrEqual(out.words[2]!.start);
    expect(out.words[5]!.start).toBeCloseTo(2.8, 1);
  });

  it("gives a dash or symbol the time its neighbour ends and never reorders", async () => {
    const { lines } = await speechFor([[1, "grow — fast"]]);
    const out = alignSpeechLine(lines[0]!, [asrWord("grow", 0.2, 0.6), asrWord("fast", 0.9, 1.3)], { start: 0, end: 2 });
    expect(out.words.map((w) => w.text)).toEqual(["grow", "—", "fast"]);
    expect(out.words[1]!.start).toBeCloseTo(0.6, 1);
    expect(out.words[2]!.start).toBeCloseTo(0.9, 1);
  });

  it("handles an empty line", () => {
    const line: SpeechLine = { sceneNumber: 1, display: "", spoken: "", segments: [], uncertain: [] };
    expect(alignSpeechLine(line, null, { start: 0, end: 1 }).words).toEqual([]);
  });
});

describe("buildCues", () => {
  const sentence = "We helped them grow revenue to $12M+ with smarter ads. Then they doubled the budget, and results kept climbing steadily upward.";
  function evenLine(sceneNumber: number, display: string, start: number, perWord = 0.42): AlignedLine {
    const words = display.split(/\s+/).map((text, i) => tw(text, start + i * perWord, start + (i + 1) * perWord - 0.03));
    return { sceneNumber, words, fromAudio: true, matchedShare: 1 };
  }

  it("obeys line length, line count and reading speed, and never splits $12M+", () => {
    const cues = buildCues([evenLine(1, sentence, 0.2)]);
    expect(cues.length).toBeGreaterThan(1);
    for (const c of cues) {
      expect(c.lines.length).toBeLessThanOrEqual(DEFAULT_CUE_OPTIONS.maxLines);
      for (const l of c.lines) expect(l.length).toBeLessThanOrEqual(DEFAULT_CUE_OPTIONS.maxCharsPerLine);
      expect(c.lines.join(" ").length / (c.end - c.start)).toBeLessThanOrEqual(DEFAULT_CUE_OPTIONS.maxCps + 0.01);
      expect(c.end - c.start).toBeGreaterThanOrEqual(DEFAULT_CUE_OPTIONS.minDuration - 1e-9);
      expect(c.end - c.start).toBeLessThanOrEqual(DEFAULT_CUE_OPTIONS.maxDuration);
      expect(c.words.length).toBeLessThanOrEqual(DEFAULT_CUE_OPTIONS.maxWordsPerCue);
      expect(c.text).toBe(c.lines.join("\n"));
    }
    const holders = cues.filter((c) => c.words.some((w) => w.text === "$12M+"));
    expect(holders).toHaveLength(1);
    expect(holders[0]!.lines.join(" ")).toContain("$12M+");
    // every word appears exactly once and in order
    expect(cues.flatMap((c) => c.words.map((w) => w.text)).join(" ")).toBe(sentence);
    // the sentence end starts a new cue
    expect(cues.some((c) => /ads\.$/.test(c.lines[c.lines.length - 1]!))).toBe(true);
    expect(checkCues(cues, { videoSeconds: 20 })).toEqual([]);
  });

  it("never overlaps cues, even across scenes", () => {
    const cues = buildCues([evenLine(1, "First scene says this thing here.", 0), evenLine(2, "Second scene follows right after it.", 2.2)]);
    for (let i = 1; i < cues.length; i += 1) expect(cues[i]!.start).toBeGreaterThanOrEqual(cues[i - 1]!.end - 1e-9);
    expect(cues.map((c) => c.words.map((w) => w.text).join(" ")).join(" ")).toBe("First scene says this thing here. Second scene follows right after it.");
  });

  it("breaks at a natural pause in the audio", () => {
    const words = [tw("hello", 0, 0.3), tw("there", 0.35, 0.7), tw("friend", 2.0, 2.4), tw("again", 2.45, 2.9)];
    const cues = buildCues([{ sceneNumber: 1, words, fromAudio: true, matchedShare: 1 }]);
    expect(cues.map((c) => c.lines.join(" "))).toEqual(["hello there", "friend again"]);
  });

  it("holds a fast cue into the following silence but never past the next cue", () => {
    const words = [tw("This", 0, 0.1), tw("sentence", 0.1, 0.2), tw("is", 0.2, 0.25), tw("spoken", 0.25, 0.3), tw("quickly.", 0.3, 0.4), tw("Next", 1.3, 1.5), tw("one.", 1.5, 1.8)];
    const cues = buildCues([{ sceneNumber: 1, words, fromAudio: true, matchedShare: 1 }]);
    expect(cues).toHaveLength(2);
    expect(cues[0]!.end).toBeGreaterThan(0.4);
    expect(cues[0]!.end).toBeLessThanOrEqual(cues[1]!.start);
    expect(cues[0]!.end - cues[0]!.start).toBeGreaterThanOrEqual(DEFAULT_CUE_OPTIONS.minDuration);
  });

  it("keeps a bound term together and a magnitude word with its number", () => {
    const words = ["Over", "2", "million", "happy", "customers", "trust", "us", "every", "single", "day."].map((t, i) => tw(t, i * 0.3, i * 0.3 + 0.27));
    const cues = buildCues([{ sceneNumber: 1, words, fromAudio: true, matchedShare: 1, bind: words.map(() => false) }], { maxCharsPerLine: 10, maxWordsPerCue: 3 });
    for (const c of cues) {
      const texts = c.words.map((w) => w.text);
      if (texts.includes("million")) expect(texts).toContain("2");
    }
  });

  it("attaches a lone dash to the word before it", () => {
    const words = [tw("grow", 0, 0.4), tw("—", 0.4, 0.4), tw("fast", 0.5, 0.9)];
    const cues = buildCues([{ sceneNumber: 1, words, fromAudio: true, matchedShare: 1 }]);
    expect(cues[0]!.lines.join(" ")).toBe("grow — fast");
  });

  it("returns nothing for no words and respects custom limits", () => {
    expect(buildCues([])).toEqual([]);
    expect(buildCues([{ sceneNumber: 1, words: [], fromAudio: false, matchedShare: 0 }])).toEqual([]);
    const cues = buildCues([evenLine(1, "one two three four five six seven eight", 0)], { maxWordsPerCue: 2 });
    expect(cues.every((c) => c.words.length <= 2)).toBe(true);
  });
});

describe("checkCues", () => {
  it("flags a too-fast cue as major with a concrete correction", () => {
    const f = checkCues([cue(0, 0.8, ["Far too long to read in time"])]);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ code: "subtitle_too_fast", severity: "major", category: "subtitles", source: "rule", atSeconds: 0 });
    expect(f[0]!.correction).toMatch(/Split|hold/i);
  });
  it("flags an overlap as major", () => {
    const f = checkCues([cue(0, 2, ["First one here"]), cue(1.5, 3.5, ["Second one here"])]);
    expect(f.map((x) => x.code)).toEqual(["subtitle_overlap"]);
    expect(f[0]!.severity).toBe("major");
    expect(f[0]!.correction).toMatch(/1\.50s|2\.00s/);
  });
  it("flags long lines, too many lines, short cues, empty cues, cues outside the video and backwards words", () => {
    const f = checkCues(
      [
        cue(0, 3, ["x".repeat(40)]),
        cue(3, 6, ["a", "b", "c"]),
        cue(6, 6.3, ["ok"]),
        cue(7, 8, ["   "]),
        cue(9, 12, ["late cue here"], [tw("late", 9.5, 9.6), tw("cue", 9.2, 9.3)]),
      ],
      { videoSeconds: 10 },
    );
    const codes = f.map((x) => x.code);
    expect(codes).toContain("subtitle_line_too_long");
    expect(codes).toContain("subtitle_too_many_lines");
    expect(codes).toContain("subtitle_too_short");
    expect(codes).toContain("subtitle_empty");
    expect(codes).toContain("subtitle_outside_video");
    expect(codes).toContain("subtitle_timing_not_monotonic");
    expect(f.find((x) => x.code === "subtitle_outside_video")!.severity).toBe("major");
    expect(f.find((x) => x.code === "subtitle_timing_not_monotonic")!.severity).toBe("major");
    expect(f.find((x) => x.code === "subtitle_line_too_long")!.severity).toBe("minor");
    expect(f.find((x) => x.code === "subtitle_too_short")!.severity).toBe("minor");
    for (const x of f) expect(x.correction.length).toBeGreaterThan(10);
  });
  it("passes clean cues", () => {
    expect(checkCues([cue(0, 2, ["A short line"]), cue(2.1, 4, ["And another"])], { videoSeconds: 5 })).toEqual([]);
  });
});

describe("toSrt and toVtt", () => {
  const cues = [cue(0.5, 2.25, ["Hello & welcome,", "to <the> show"]), cue(3661.0004, 3662.9996, ["It --> works"]), cue(59.9996, 61, ["Round"])];
  it("writes SubRip exactly", () => {
    expect(toSrt(cues)).toBe(
      ["1", "00:00:00,500 --> 00:00:02,250", "Hello & welcome,", "to the show", "", "2", "01:01:01,000 --> 01:01:03,000", "It -> works", "", "3", "00:01:00,000 --> 00:01:01,000", "Round", ""].join("\n"),
    );
    expect(toSrt([])).toBe("");
  });
  it("writes WebVTT exactly, escaping markup characters and the timing arrow", () => {
    expect(toVtt(cues)).toBe(
      [
        "WEBVTT",
        "",
        "1",
        "00:00:00.500 --> 00:00:02.250",
        "Hello &amp; welcome,",
        "to &lt;the&gt; show",
        "",
        "2",
        "01:01:01.000 --> 01:01:03.000",
        "It --&gt; works",
        "",
        "3",
        "00:01:00.000 --> 00:01:01.000",
        "Round",
        "",
      ].join("\n"),
    );
    expect(toVtt([])).toBe("WEBVTT\n\n");
  });
});

describe("compareSpokenToExpected", () => {
  const windows = [
    { number: 1, start: 0, end: 4 },
    { number: 2, start: 4, end: 8 },
    { number: 3, start: 8, end: 12 },
  ];
  const texts: Array<[number, string]> = [
    [1, "We grew sales across the whole region this year."],
    [2, "Booking a free audit takes about five minutes."],
    [3, "Call us today to get started."],
  ];

  function words(sentence: string, start: number, end: number): AsrWord[] {
    const parts = sentence.split(" ");
    const step = (end - start) / parts.length;
    return parts.map((w, i) => asrWord(w, start + i * step, start + (i + 1) * step - 0.05));
  }

  it("passes when everything is said, and gives the full transcript", async () => {
    const { lines } = await speechFor(texts);
    const asr = [...words("We grew sales across the whole region this year", 0.3, 3.6), ...words("Booking a free audit takes about five minutes", 4.3, 7.6), ...words("Call us today to get started", 8.3, 11.5)];
    const out = compareSpokenToExpected(lines, asr, windows);
    expect(out.findings).toEqual([]);
    expect(out.checks.every((c) => c.ok)).toBe(true);
    expect(out.transcript).toBe(asr.map((w) => w.word).join(" "));
  });

  it("flags a different sentence as critical and a dropped line as critical, with targeted corrections", async () => {
    const { lines } = await speechFor(texts);
    const asr = [...words("We grew sales across the whole region this year", 0.3, 3.6), ...words("Order now and receive your complimentary gift", 4.3, 7.6)];
    const out = compareSpokenToExpected(lines, asr, windows);
    const wrong = out.findings.find((f) => f.code === "speech_wrong_sentence")!;
    expect(wrong).toMatchObject({ severity: "critical", category: "speech", source: "asr", atSeconds: 4 });
    expect(wrong.message).toMatch(/Scene 2/);
    expect(wrong.correction).toContain("Booking a free audit takes about five minutes");
    const dropped = out.findings.find((f) => f.code === "speech_line_missing")!;
    expect(dropped).toMatchObject({ severity: "critical", category: "speech" });
    expect(dropped.message).toMatch(/Scene 3/);
    expect(out.checks.find((c) => c.name === "speech_scene_1")!.ok).toBe(true);
    expect(out.checks.find((c) => c.name === "speech_scene_3")!.ok).toBe(false);
  });

  it("flags partly missing words as major and added words", async () => {
    const { lines } = await speechFor([[1, "We grew sales across the whole region this year."]]);
    const partial = compareSpokenToExpected(lines, words("We grew sales across the whole", 0.3, 2.4), windows);
    const f = partial.findings.find((x) => x.code === "speech_words_missing")!;
    expect(f.severity).toBe("major");
    expect(f.evidence).toMatch(/Missing/);
    const extra = compareSpokenToExpected(lines, [...words("We grew sales across the whole region this year", 0.3, 2.6), ...words("and so much more besides that honestly", 2.7, 3.9)], windows);
    expect(extra.findings.map((x) => x.code)).toContain("speech_extra_words");
  });

  it("notices a clipped first word", async () => {
    const { lines } = await speechFor([[1, "Great results every single month."]]);
    const out = compareSpokenToExpected(lines, words("results every single month", 0.02, 2.5), windows);
    expect(out.findings.map((f) => f.code)).toContain("speech_clipped_start");
  });

  it("says speech could not be verified when there is no transcript, and does not pass", async () => {
    const { lines } = await speechFor(texts);
    const out = compareSpokenToExpected(lines, null, windows);
    expect(out.transcript).toBe("");
    expect(out.checks).toHaveLength(1);
    expect(out.checks[0]!.ok).toBe(false);
    expect(out.checks[0]!.detail).toMatch(/unavailable/i);
    expect(out.checks[0]!.detail).toMatch(/not verified/i);
  });

  it("always raises a minor pronunciation_unverified for guessed terms, even when the transcript matches", async () => {
    const { lines } = await speechFor([[1, "Our ROAS climbed fast."]]);
    expect(lines[0]!.uncertain).toEqual(["ROAS"]);
    const asr = words("Our R O A S climbed fast", 0.3, 3);
    const out = compareSpokenToExpected(lines, asr, windows);
    const f = out.findings.find((x) => x.code === "pronunciation_unverified")!;
    expect(f).toMatchObject({ severity: "minor", category: "speech" });
    expect(f.evidence).toMatch(/not proof/i);
    expect(f.message).toContain("ROAS");
    // and also when there is no transcript at all
    expect(compareSpokenToExpected(lines, null, windows).findings.map((x) => x.code)).toEqual(["pronunciation_unverified"]);
  });

  it("raises nothing for an operator-confirmed pronunciation", async () => {
    const { lines } = await speechFor([[1, "Our ROAS climbed fast."]], { ROAS: "roh-ass" });
    expect(lines[0]!.uncertain).toEqual([]);
    const out = compareSpokenToExpected(lines, [asrWord("Our", 0.3, 0.6), asrWord("roh", 0.7, 0.9), asrWord("ass", 0.9, 1.2), asrWord("climbed", 1.3, 1.7), asrWord("fast", 1.8, 2.1)], windows);
    expect(out.findings).toEqual([]);
  });

  it("notes a scene with no window instead of silently skipping it", async () => {
    const { lines } = await speechFor([[9, "Nobody times this line."]]);
    const out = compareSpokenToExpected(lines, [asrWord("x", 0, 1)], windows);
    expect(out.checks.find((c) => c.name === "speech_scene_9")).toMatchObject({ ok: false });
  });
});

describe("safeCaptionY", () => {
  it("returns the first candidate whose box clears every band", () => {
    const avoid = [{ top: 0.7, bottom: 0.9 }];
    expect(safeCaptionY([0.8, 0.6, 0.5], avoid, 0.1)).toBe(0.6);
    expect(safeCaptionY([0.8, 0.6], [], 0.1)).toBe(0.8);
  });
  it("treats touching edges as clear and overlaps as blocked", () => {
    expect(safeCaptionY([0.65], [{ top: 0.7, bottom: 0.9 }], 0.1)).toBe(0.65);
    expect(safeCaptionY([0.66], [{ top: 0.7, bottom: 0.9 }], 0.1)).toBeNull();
  });
  it("returns null when every candidate is blocked or leaves the frame", () => {
    expect(safeCaptionY([0.8, 0.6], [{ top: 0.5, bottom: 0.95 }], 0.1)).toBeNull();
    expect(safeCaptionY([0.02, 0.99], [], 0.1)).toBeNull();
    expect(safeCaptionY([], [], 0.1)).toBeNull();
  });
  it("avoids several bands at once", () => {
    expect(safeCaptionY([0.2, 0.5, 0.8], [{ top: 0.1, bottom: 0.3 }, { top: 0.4, bottom: 0.6 }], 0.1)).toBe(0.8);
  });
});
