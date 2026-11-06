import { describe, expect, it } from "vitest";
import { retime, sceneSeconds, wordsFor, WORDS_PER_SECOND } from "@/lib/video/timing";

const scene = (line: string, over: Record<string, unknown> = {}) => ({ line, speaker: "on_camera" as const, stat: null, assetId: null, ...over });

describe("a scene's length follows its words", () => {
  it("is longer for more words, in whole seconds", () => {
    const short = sceneSeconds(scene("Honestly? I had no idea."));
    const long = sceneSeconds(scene("Turns out we'd been paying for clicks that never turned into customers, and nobody had told us for years."));
    expect(long).toBeGreaterThan(short);
    expect(Number.isInteger(short) && Number.isInteger(long)).toBe(true);
  });
  it("gives a line enough time to be said at a natural pace", () => {
    const line = "We tracked every single dollar back to the revenue it made.";
    const words = line.split(" ").length;
    expect(sceneSeconds(scene(line)) * WORDS_PER_SECOND).toBeGreaterThanOrEqual(words);
    expect(words).toBeLessThanOrEqual(wordsFor(sceneSeconds(scene(line))));
  });
  it("never goes under 2 seconds, and gives a stat or an image time to be read", () => {
    expect(sceneSeconds(scene("Yep."))).toBe(2);
    expect(sceneSeconds(scene("Yep.", { stat: "255%" }))).toBe(3);
    expect(sceneSeconds(scene("Yep.", { assetId: "img_1" }))).toBe(3);
  });
  it("lets a silent scene hold for the beat it was given, within 2 to 6 seconds", () => {
    expect(sceneSeconds({ line: "", speaker: "none", stat: null, assetId: null, seconds: 4 })).toBe(4);
    expect(sceneSeconds({ line: "", speaker: "none", stat: null, assetId: null, seconds: 20 })).toBe(6);
    expect(sceneSeconds({ line: "", speaker: "none", stat: null, assetId: null })).toBe(3);
  });
  it("ignores a stale length on a scene that has speech", () => {
    expect(sceneSeconds(scene("Yep.", { seconds: 12 }))).toBe(2);
  });
});

describe("retime", () => {
  it("lays scenes end to end with no padding to reach a total", () => {
    const out = retime([scene("Hello there, friend."), scene("This one has quite a few more words in it than the first one did."), { line: "", speaker: "none" as const, stat: null, assetId: null, seconds: 3 }]);
    expect(out[0]!.start).toBe(0);
    expect(out[1]!.start).toBe(out[0]!.end);
    expect(out[2]!.start).toBe(out[1]!.end);
    expect(out.map((s) => s.seconds)).toEqual(out.map((s) => s.end - s.start));
  });
});
