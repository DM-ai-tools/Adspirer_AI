import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Real ffmpeg runs several passes per clip; allow for a busy machine.
vi.setConfig({ testTimeout: 90_000 });
import { runFfmpeg } from "@/lib/video/ffmpeg";
import {
  correctionLines,
  decideClip,
  frameTimes,
  parseFreezeDetect,
  parseSceneScores,
  parseStreamDurations,
  redesignReasons,
  reviewClip,
  sampleFrames,
  summariseQa,
  temporalChecks,
  visionRubric,
  type ClipDecisionContext,
  type VisionResult,
  type VisionReviewer,
} from "@/lib/video/clip-qa";
import type { QaFinding, SceneBrief, SpeechLine } from "@/lib/video/pipeline-types";

const finding = (over: Partial<QaFinding> = {}): QaFinding => ({
  code: "x",
  severity: "major",
  category: "face",
  message: "m",
  evidence: "e",
  correction: "Show the presenter's face with natural skin.",
  source: "vision",
  ...over,
});

const ctx = (over: Partial<ClipDecisionContext> = {}): ClipDecisionContext => ({ attempt: 1, maxAttempts: 3, spentUsd: 1, budgetUsd: 10, nextAttemptUsd: 1, visionAvailable: true, requireVision: true, ...over });

describe("parsing ffmpeg's reports", () => {
  it("reads frozen stretches and closes one that runs to the end of the file", () => {
    const report = [
      "[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 1.5",
      "[freezedetect @ 0x1] lavfi.freezedetect.freeze_duration: 2.25",
      "[freezedetect @ 0x1] lavfi.freezedetect.freeze_end: 3.75",
      "[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 5",
    ].join("\n");
    expect(parseFreezeDetect(report)).toEqual([{ start: 1.5, end: 3.75, duration: 2.25 }]);
    expect(parseFreezeDetect(report, 8)).toEqual([
      { start: 1.5, end: 3.75, duration: 2.25 },
      { start: 5, end: 8, duration: 3 },
    ]);
    expect(parseFreezeDetect("nothing here")).toEqual([]);
  });

  it("reads scene-change scores with their times", () => {
    const report = [
      "[Parsed_metadata_1 @ 0x1] frame:0    pts:512     pts_time:0.0416667",
      "[Parsed_metadata_1 @ 0x1] lavfi.scene_score=0.027117",
      "[Parsed_metadata_1 @ 0x1] frame:3    pts:2048    pts_time:3.5",
      "[Parsed_metadata_1 @ 0x1] lavfi.scene_score=0.812345",
    ].join("\n");
    expect(parseSceneScores(report)).toEqual([
      { time: 0.04, score: 0.027117 },
      { time: 3.5, score: 0.812345 },
    ]);
  });

  it("reads container, video and audio lengths", () => {
    const report = [
      "  Duration: 00:00:06.00, start: 0.000000, bitrate: 300 kb/s",
      "[stream:video]",
      "frame=  144 fps=0.0 q=-1.0 Lsize=N/A time=00:00:05.96 bitrate=N/A",
      "[stream:audio]",
      "size=N/A time=00:00:02.98 bitrate=N/A speed= 500x",
    ].join("\n");
    expect(parseStreamDurations(report)).toEqual({ video: 5.96, audio: 2.98, container: 6 });
    expect(parseStreamDurations("  Duration: 00:01:02.50, start: 0")).toEqual({ video: null, audio: null, container: 62.5 });
  });
});

describe("frame times", () => {
  it("includes the first and the last frame and is evenly spaced", () => {
    const t = frameTimes(10, 6);
    expect(t).toHaveLength(6);
    expect(t[0]).toBe(0);
    expect(t[5]).toBeGreaterThan(9.5);
    expect(t[5]).toBeLessThan(10);
    const gaps = t.slice(1).map((v, i) => v - t[i]!);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(0.05);
    expect(frameTimes(5, 1)).toEqual([0]);
    expect(frameTimes(0, 4)).toEqual([0]);
  });
});

describe("temporal checks (real ffmpeg)", () => {
  let dir: string;
  const f = (n: string) => path.join(dir, n);
  const enc = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"];
  const video = "testsrc2=size=320x240:rate=24";
  const tone = "sine=frequency=330:sample_rate=44100";

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "clipqa-"));
    await Promise.all([
      runFfmpeg(["-f", "lavfi", "-i", video, "-f", "lavfi", "-i", tone, "-t", "6", ...enc, f("clean.mp4")]),
      runFfmpeg(["-f", "lavfi", "-i", `${video},trim=duration=2,tpad=stop_mode=clone:stop_duration=4`, "-f", "lavfi", "-i", tone, "-t", "6", ...enc, f("frozen.mp4")]),
      runFfmpeg(["-f", "lavfi", "-i", `${video},drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='between(t,1,3.5)'`, "-f", "lavfi", "-i", tone, "-t", "6", ...enc, f("black.mp4")]),
      runFfmpeg(["-f", "lavfi", "-i", video, "-f", "lavfi", "-i", tone, "-af", "volume=enable='between(t,1,6)':volume=0", "-t", "6", ...enc, f("silent.mp4")]),
      runFfmpeg(["-t", "6", "-f", "lavfi", "-i", video, "-t", "3", "-f", "lavfi", "-i", tone, ...enc, f("mismatch.mp4")]),
      runFfmpeg(["-f", "lavfi", "-i", "smptebars=size=320x240:rate=24", "-f", "lavfi", "-i", video, "-f", "lavfi", "-i", tone, "-filter_complex", "[0:v]trim=duration=3,setpts=PTS-STARTPTS[a];[1:v]trim=duration=3,setpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-map", "2:a", "-t", "6", ...enc, f("cut.mp4")]),
      runFfmpeg(["-f", "lavfi", "-i", video, "-f", "lavfi", "-i", tone, "-af", "volume=24dB", "-t", "6", ...enc, f("loud.mp4")]),
      runFfmpeg(["-f", "lavfi", "-i", video, "-t", "6", ...enc.slice(0, 4), f("noaudio.mp4")]),
    ]);
  }, 120_000);

  it("passes a clean moving clip", async () => {
    const r = await temporalChecks(f("clean.mp4"), { expectedSeconds: 6, expectsSpeech: true, expectedCuts: 0 });
    expect(r.findings.filter((x) => x.severity !== "minor")).toEqual([]);
    expect(r.seconds).toBeGreaterThan(5.8);
    expect(r.seconds).toBeLessThan(6.3);
    expect(r.hasAudio).toBe(true);
    expect(r.checks.every((c) => c.ok)).toBe(true);
  }, 60_000);

  it("flags frozen footage with its time", async () => {
    const r = await temporalChecks(f("frozen.mp4"), { expectedSeconds: 6, expectsSpeech: false });
    const frozen = r.findings.find((x) => x.code === "frozen_footage");
    expect(frozen).toBeDefined();
    expect(frozen!.atSeconds).toBeGreaterThan(1.5);
    expect(frozen!.atSeconds).toBeLessThan(2.5);
    expect(frozen!.source).toBe("ffmpeg");
    expect(frozen!.category).toBe("temporal");
    expect(frozen!.correction.length).toBeGreaterThan(10);
  }, 60_000);

  it("flags black frames", async () => {
    const r = await temporalChecks(f("black.mp4"), { expectedSeconds: 6, expectsSpeech: false });
    const black = r.findings.find((x) => x.code === "black_frames");
    expect(black).toBeDefined();
    expect(black!.severity).toBe("major");
    expect(black!.atSeconds).toBeGreaterThan(0.8);
    expect(black!.atSeconds).toBeLessThan(1.3);
  }, 60_000);

  it("flags a long silence in a speaking clip, and ignores it when nobody should speak", async () => {
    const speaking = await temporalChecks(f("silent.mp4"), { expectedSeconds: 6, expectsSpeech: true });
    const s = speaking.findings.find((x) => x.code === "speech_silence");
    expect(s).toBeDefined();
    expect(s!.severity).toBe("critical"); // 5 of 6 seconds is almost the whole clip
    expect(s!.category).toBe("speech");
    const quiet = await temporalChecks(f("silent.mp4"), { expectedSeconds: 6, expectsSpeech: false });
    expect(quiet.findings.find((x) => x.code === "speech_silence")).toBeUndefined();
  }, 60_000);

  it("flags picture and sound of different lengths", async () => {
    const r = await temporalChecks(f("mismatch.mp4"), { expectedSeconds: 6, expectsSpeech: false });
    const m = r.findings.find((x) => x.code === "av_duration_mismatch");
    expect(m).toBeDefined();
    expect(m!.severity).toBe("major");
    expect(m!.category).toBe("technical");
  }, 60_000);

  it("flags a hard cut inside a single-shot clip only when cuts are expected to be absent", async () => {
    const strict = await temporalChecks(f("cut.mp4"), { expectedSeconds: 6, expectsSpeech: false, expectedCuts: 0 });
    const cut = strict.findings.find((x) => x.code === "unplanned_cut");
    expect(cut).toBeDefined();
    expect(cut!.atSeconds).toBeGreaterThan(2.7);
    expect(cut!.atSeconds).toBeLessThan(3.3);
    const planned = await temporalChecks(f("cut.mp4"), { expectedSeconds: 6, expectsSpeech: false, expectedCuts: 1 });
    expect(planned.findings.find((x) => x.code === "unplanned_cut")).toBeUndefined();
    const off = await temporalChecks(f("cut.mp4"), { expectedSeconds: 6, expectsSpeech: false });
    expect(off.findings.find((x) => x.code === "unplanned_cut")).toBeUndefined();
  }, 60_000);

  it("flags a clip far from its planned length and clipped audio", async () => {
    const r = await temporalChecks(f("loud.mp4"), { expectedSeconds: 12, expectsSpeech: false });
    expect(r.findings.find((x) => x.code === "duration_off")?.severity).toBe("major");
    expect(r.findings.find((x) => x.code === "audio_clipped")).toBeDefined();
  }, 60_000);

  it("calls a speaking clip with no audio track critical", async () => {
    const r = await temporalChecks(f("noaudio.mp4"), { expectedSeconds: 6, expectsSpeech: true });
    expect(r.hasAudio).toBe(false);
    expect(r.findings.find((x) => x.code === "audio_missing")?.severity).toBe("critical");
  }, 60_000);

  it("samples frames across the clip, first and last included", async () => {
    const frames = await sampleFrames(f("clean.mp4"), 5, path.join(dir, "frames"), { width: 160 });
    expect(frames.length).toBe(5);
    expect(frames[0]!.at).toBe(0);
    expect(frames[4]!.at).toBeGreaterThan(5.5);
    expect(frames.every((x) => x.bytes.length > 100 && x.bytes[0] === 0xff && x.bytes[1] === 0xd8)).toBe(true);
  }, 60_000);

  describe("reviewing a clip", () => {
    const scene = (over: Partial<SceneBrief> = {}): SceneBrief => ({
      number: 1, purpose: "Hook", informationAdded: "pain", narration: "Hi", subject: "A presenter", setting: "A bright office", action: "Talks to camera", framing: "Medium close-up", camera: "static", lighting: "soft", style: "UGC",
      characterId: "c1", environmentId: "e1", requiredAssets: [], overlays: [], screenTreatment: "none", seconds: 6, durationBasis: "narration", entry: { mode: "cut", condition: "" }, exit: { condition: "" }, transition: { kind: "cut", rationale: "" },
      risks: [], acceptance: ["Face is visible"], ...over,
    });
    const speech: SpeechLine[] = [{ sceneNumber: 1, display: "Hello there friends", spoken: "Hello there friends", segments: [{ display: "Hello there friends", spoken: "Hello there friends" }], uncertain: [] }];
    const clean: VisionResult = { observations: [], textSeen: [], faceConsistent: true, summary: "Looks fine." };
    const base = () => ({ file: f("clean.mp4"), clip: 2, attempt: 1, scenes: [scene()], characterDescription: "A woman in her 30s", referenceImage: Buffer.from("ref"), expectedSeconds: 6, expectsSpeech: false, speech: [], asr: null, workDir: path.join(dir, "work"), frameCount: 3 });
    const reviewer = (r: Partial<VisionResult>): VisionReviewer => async () => ({ ...clean, ...r });

    it("passes a clean clip and records the frames it inspected", async () => {
      const seen: { frames: number; reference: boolean; rubric: string }[] = [];
      const r = await reviewClip(base(), { reviewer: async (i) => (seen.push({ frames: i.frames.length, reference: !!i.reference, rubric: i.rubric }), clean) });
      expect(r.verdict).toBe("pass");
      expect(r.framesInspected).toBe(3);
      expect(r.subject).toEqual({ kind: "clip", clip: 2 });
      expect(r.findings).toEqual([]);
      expect(seen[0]).toMatchObject({ frames: 3, reference: true });
      expect(seen[0]!.rubric).toContain("A woman in her 30s");
    });

    it("turns a fabricated wordmark and a 'CC NOW' button into critical fabricated_text / invented_branding", async () => {
      const r = await reviewClip(base(), {
        reviewer: reviewer({
          textSeen: [
            { text: "CC NOW", atSeconds: 3, kind: "ui" },
            { text: "Whlubler", atSeconds: 4.2, kind: "word" },
            { text: "W", atSeconds: 4.2, kind: "logo_like" },
          ],
        }),
      });
      const text = r.findings.filter((x) => x.code === "fabricated_text");
      expect(text.map((x) => x.severity)).toEqual(["critical", "critical"]);
      expect(text.map((x) => x.atSeconds)).toEqual([3, 4.2]);
      expect(r.findings.find((x) => x.code === "invented_branding")?.severity).toBe("critical");
      expect(r.verdict).not.toBe("pass");
      expect(r.findings.every((x) => x.source === "vision")).toBe(true);
    });

    it("lets text that is explicitly allowed through", async () => {
      const r = await reviewClip({ ...base(), allowedText: ["Open"] }, { reviewer: reviewer({ textSeen: [{ text: "OPEN", atSeconds: 1, kind: "word" }] }) });
      expect(r.findings).toEqual([]);
      expect(r.verdict).toBe("pass");
    });

    it("treats a face that is not consistent as critical identity_drift", async () => {
      const r = await reviewClip(base(), { reviewer: reviewer({ faceConsistent: false, summary: "Different person after 3s." }) });
      const drift = r.findings.find((x) => x.code === "identity_drift");
      expect(drift?.severity).toBe("critical");
      expect(drift?.category).toBe("face");
      expect(r.verdict).toBe("retry");
    });

    it("keeps a glowing-marks observation critical, and lifts a prominent facial artifact to critical", async () => {
      const r = await reviewClip(base(), {
        reviewer: reviewer({
          observations: [
            { category: "face", severity: "critical", atSeconds: 2, message: "Bright cyan glowing marks on the cheek", evidence: "Cyan glow on left cheek at 2s", correction: "Show clear, even skin on both cheeks." },
            { category: "face", severity: "major", atSeconds: 4, message: "Mouth morphs into a different shape", evidence: "Lips warp at 4s", correction: "Keep the lips steady." },
            { category: "hands", severity: "minor", atSeconds: 1, message: "Slightly blurry thumb", evidence: "thumb soft", correction: "Show a sharp thumb." },
          ],
        }),
      });
      expect(r.findings.map((x) => [x.code, x.severity])).toEqual([
        ["face_glow_marks", "critical"],
        ["face_morphing", "critical"],
        ["hand_anomaly", "minor"],
      ]);
    });

    it("is unresolved with a limitation when no reviewer is available and vision is required", async () => {
      const r = await reviewClip(base(), { reviewer: null });
      expect(r.verdict).toBe("unresolved");
      expect(r.limitations.join(" ")).toMatch(/visual review not performed/);
      expect(r.framesInspected).toBe(0);
    });

    it("passes without vision only when vision is not required, still noting the limitation", async () => {
      const r = await reviewClip({ ...base(), requireVision: false }, { reviewer: null });
      expect(r.verdict).toBe("pass");
      expect(r.limitations.length).toBe(1);
    });

    it("becomes unresolved with a limitation when the vision call throws", async () => {
      const r = await reviewClip(base(), {
        reviewer: async () => {
          throw new Error("model down");
        },
      });
      expect(r.verdict).toBe("unresolved");
      expect(r.limitations.join(" ")).toMatch(/visual review failed: model down/);
    });

    it("still reports the measured problems when vision is missing", async () => {
      const r = await reviewClip({ ...base(), file: f("frozen.mp4") }, { reviewer: null });
      expect(r.findings.some((x) => x.code === "frozen_footage")).toBe(true);
      expect(r.verdict).toBe("retry");
    });

    it("compares what was said with the script", async () => {
      const wrong = await reviewClip({ ...base(), expectsSpeech: true, speech, asr: [{ word: "totally", start: 0, end: 1 }, { word: "different", start: 1, end: 2 }, { word: "words", start: 2, end: 3 }, { word: "entirely", start: 3, end: 4 }] }, { reviewer: reviewer({}) });
      expect(wrong.findings.find((x) => x.code === "speech_mismatch")?.severity).toBe("major");
      expect(wrong.findings.find((x) => x.code === "speech_mismatch")?.source).toBe("asr");
      const right = await reviewClip({ ...base(), expectsSpeech: true, speech, asr: ["hello", "there", "friends"].map((word, i) => ({ word, start: i, end: i + 1 })) }, { reviewer: reviewer({}) });
      expect(right.findings.find((x) => x.code.startsWith("speech_m"))).toBeUndefined();
      const none = await reviewClip({ ...base(), expectsSpeech: true, speech }, { reviewer: reviewer({}), transcribe: async () => null });
      expect(none.limitations.join(" ")).toMatch(/not transcribed/);
    });
  });
});

describe("the decision policy", () => {
  it("passes with only minor findings", () => {
    const d = decideClip([finding({ severity: "minor" })], ctx());
    expect(d.verdict).toBe("pass");
  });

  it("does not pass silently when vision was required and unavailable", () => {
    expect(decideClip([], ctx({ visionAvailable: false })).verdict).toBe("unresolved");
    expect(decideClip([], ctx({ visionAvailable: false, requireVision: false })).verdict).toBe("pass");
  });

  it("retries within attempts and budget", () => {
    expect(decideClip([finding({ code: "a" })], ctx()).verdict).toBe("retry");
    expect(decideClip([finding({ code: "a", severity: "critical" })], ctx({ attempt: 2 })).verdict).toBe("retry");
  });

  it("redesigns when the same code comes back", () => {
    const d = decideClip([finding({ code: "face_glow_marks", severity: "critical" })], ctx({ attempt: 2, previousCodes: ["face_glow_marks"] }));
    expect(d.verdict).toBe("redesign");
    expect(d.reason).toContain("face_glow_marks");
  });

  it("redesigns when retries are used up and budget remains, once", () => {
    expect(decideClip([finding()], ctx({ attempt: 3 })).verdict).toBe("redesign");
    expect(decideClip([finding()], ctx({ attempt: 3, redesignsUsed: 1 })).verdict).toBe("unresolved");
  });

  it("is unresolved when the budget does not allow another attempt", () => {
    expect(decideClip([finding()], ctx({ spentUsd: 9.5, budgetUsd: 10, nextAttemptUsd: 1 })).verdict).toBe("unresolved");
    expect(decideClip([finding()], ctx({ attempt: 3, spentUsd: 10, nextAttemptUsd: 1 })).verdict).toBe("unresolved");
  });

  it("never passes with an open critical finding, whatever the context", () => {
    for (const attempt of [1, 2, 3, 4]) {
      for (const budgetUsd of [0, 1, 100]) {
        for (const previousCodes of [[], ["z"]]) {
          const d = decideClip([finding({ code: "z", severity: "critical" })], ctx({ attempt, budgetUsd, previousCodes, visionAvailable: true, requireVision: false }));
          expect(d.verdict).not.toBe("pass");
        }
      }
    }
  });
});

describe("corrections for the next attempt", () => {
  it("dedupes, orders by severity, caps at six and skips minors", () => {
    const fs = [
      finding({ code: "a", severity: "major", correction: "Show steady hands." }),
      finding({ code: "b", severity: "critical", correction: "Show clear skin." }),
      finding({ code: "c", severity: "critical", correction: "Show clear skin." }),
      finding({ code: "m", severity: "minor", correction: "Show a sharp thumb." }),
      ...Array.from({ length: 8 }, (_, i) => finding({ code: `n${i}`, severity: "major", correction: `Fix thing ${i} by showing it.` })),
    ];
    const lines = correctionLines(fs);
    expect(lines[0]).toBe("Show clear skin.");
    expect(lines.filter((l) => l === "Show clear skin.")).toHaveLength(1);
    expect(lines).not.toContain("Show a sharp thumb.");
    expect(lines.length).toBe(6);
  });

  it("says no-text at most once across text and logo problems", () => {
    const lines = correctionLines([
      finding({ code: "fabricated_text", category: "text", severity: "critical", correction: "Keep the wall with no text on it." }),
      finding({ code: "fabricated_text", category: "text", severity: "critical", correction: "Show a shirt without any lettering." }),
      finding({ code: "invented_branding", category: "branding", severity: "critical", correction: "Use clothes with no logos." }),
      finding({ code: "hand_anomaly", category: "hands", severity: "major", correction: "Show five natural fingers." }),
    ]);
    expect(lines.filter((l) => /\b(no|without)\b.*(text|lettering|logos)/i.test(l))).toHaveLength(1);
    expect(lines).toContain("Show five natural fingers.");
  });

  it("gives the planner plain reasons for a redesign, one per code", () => {
    const r = redesignReasons([
      finding({ code: "a", severity: "critical", message: "Glowing marks", evidence: "cyan on cheek", atSeconds: 2 }),
      finding({ code: "a", severity: "critical", message: "Glowing marks again", evidence: "cyan on cheek" }),
      finding({ code: "m", severity: "minor" }),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0]).toContain("Glowing marks");
    expect(r[0]).toContain("2s");
  });

  it("summarises a report for the log", () => {
    const text = summariseQa({ subject: { kind: "clip", clip: 3 }, attempt: 2, checkedAt: "", verdict: "retry", findings: [finding({ severity: "critical", message: "Glow", atSeconds: 1 }), finding({ severity: "minor" })], checks: [], framesInspected: 8, limitations: ["no ASR key"] });
    expect(text).toContain("Clip 3, attempt 2: retry");
    expect(text).toContain("1 critical, 0 major, 1 minor");
    expect(text).toContain("no ASR key");
  });

  it("builds a rubric that names the scene, the reference and the text rule", () => {
    const rubric = visionRubric({ scenes: [], characterDescription: "A tall man", expectsSpeech: true, allowedText: [] });
    expect(rubric).toContain("A tall man");
    expect(rubric).toMatch(/textSeen/);
    expect(rubric).toMatch(/No text at all is allowed/);
    expect(rubric).toMatch(/waxy/);
    expect(rubric).toMatch(/mouth/);
  });
});
