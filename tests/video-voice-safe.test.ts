import { describe, expect, it } from "vitest";
import { buildPlannedClipPrompt, type PlannedClipPromptInput } from "@/lib/video/clip-prompt";
import { voiceSafe } from "@/lib/video/prompt-guards";
import run from "./fixtures/weather-forecast-run.json";
import type { PlanCharacter, SceneBrief } from "@/lib/video/pipeline-types";

// Live Seedance 2.5 bisect, 19 Nov 2026 (4s clips, same prompt, only the spoken line changed):
//   "The account nobody checked twice."   -> failed OutputAudioSensitiveContentDetected (3 of 3 runs)
//   "The campaign nobody checked twice."  -> failed
//   "The account nobody checked."         -> failed
//   "The account no one checked twice."   -> succeeded
//   "Some things only show up when you look at them properly." -> succeeded
//   "The spend you thought was profitable."                    -> succeeded
// The word "nobody" in the spoken audio is what its audio check rejects, so it is said as "no one".

describe("words said to the video model", () => {
  it("says no one instead of nobody, keeping case and the possessive", () => {
    expect(voiceSafe("The account nobody checked twice.")).toBe("The account no one checked twice.");
    expect(voiceSafe("Nobody checked.")).toBe("No one checked.");
    expect(voiceSafe("NOBODY moves.")).toBe("NO ONE moves.");
    expect(voiceSafe("It is nobody's fault.")).toBe("It is no one's fault.");
    expect(voiceSafe("It is nobody’s fault.")).toBe("It is no one’s fault.");
  });

  it("leaves every other word alone, and is safe to apply twice", () => {
    const line = "Some things only show up when you look at them properly. The spend you thought was profitable.";
    expect(voiceSafe(line)).toBe(line);
    expect(voiceSafe(voiceSafe("nobody"))).toBe("no one");
    expect(voiceSafe("anybody, somebody and everybody")).toBe("anybody, somebody and everybody");
  });
});

describe("the clip prompt carries the safe wording", () => {
  const characters = run.characters as PlanCharacter[];
  const briefs = run.briefs as unknown as SceneBrief[];
  const input = (text: string): PlannedClipPromptInput => ({
    scenes: [briefs.find((b) => b.number === 5)!],
    spoken: { 5: { text, speaker: "voiceover" } },
    characters,
    environments: run.environments as never,
    style: run.style,
    clipNumber: 1,
    clipCount: 1,
    locale: "en-AU",
    refs: { characterIds: [], environmentIds: [], previousFrame: false, previousVideo: false },
    corrections: [],
    nextContinues: false,
    clean: true,
  });

  it("puts no one, not nobody, inside the braces", () => {
    const p = buildPlannedClipPrompt(input("The account nobody checked twice."));
    expect(p).toContain("{The account no one checked twice.}");
    // only the spoken words matter to the audio check; the prompt's own instructions are not spoken
    expect([...p.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]).join(" ")).not.toMatch(/nobody/i);
  });

  it("does the same for each voice of a scene with several voices", () => {
    const p = buildPlannedClipPrompt(
      input("x") && {
        ...input("x"),
        spoken: { 5: { text: "Nobody knows.", speaker: "voiceover", parts: [{ voiceId: "marcus", who: "Marcus", text: "Nobody knows.", onCamera: false }] } },
        voices: [{ id: "marcus", who: "Marcus", description: "Male, mid-40s", videoRef: null }],
      },
    );
    expect(p).toContain("{No one knows.}");
  });
});
