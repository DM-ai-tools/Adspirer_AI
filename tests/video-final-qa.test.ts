import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { runFfmpeg } from "@/lib/video/ffmpeg";
import { finalBlocks, finalFindings, finalFrameTimes, MIN_END_CARD_SECONDS, reviewFinal, type FinalQaInput, type FinalVisionResult, type FinalVisionReviewer } from "@/lib/video/final-qa";
import type { QaReport } from "@/lib/video/pipeline-types";

const prov = { source: "operator" as const, detail: "test", confidence: "high" as const };

describe("final export review", () => {
  let dir: string;
  let good: string;
  let noEnd: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "finalqa-"));
    good = path.join(dir, "final.mp4");
    // 6s of moving picture with a tone, then a 2.2s still, silent end card.
    await runFfmpeg([
      "-f", "lavfi", "-t", "6", "-i", "testsrc2=size=320x240:rate=24",
      "-f", "lavfi", "-t", "6", "-i", "sine=frequency=330:sample_rate=44100",
      "-f", "lavfi", "-t", "2.2", "-i", "color=c=navy:size=320x240:rate=24",
      "-f", "lavfi", "-t", "2.2", "-i", "anullsrc=r=44100:cl=mono",
      "-filter_complex", "[0:v]format=yuv420p,setsar=1[v1];[2:v]format=yuv420p,setsar=1[v2];[v1][1:a][v2][3:a]concat=n=2:v=1:a=1[v][a]",
      "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", good,
    ]);
    noEnd = path.join(dir, "noend.mp4");
    await runFfmpeg(["-f", "lavfi", "-t", "6", "-i", "testsrc2=size=320x240:rate=24", "-f", "lavfi", "-t", "6", "-i", "sine=frequency=330:sample_rate=44100", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", noEnd]);
  }, 120_000);

  const input = (over: Partial<FinalQaInput> = {}): FinalQaInput => ({
    file: good,
    workDir: path.join(dir, "work"),
    attempt: 1,
    seconds: 8.2,
    endCardSeconds: 2.2,
    manifest: {
      name: { value: "Wheelr", provenance: [prov] },
      logo: null,
      internalLabels: [{ value: "Q3 Retargeting Audit v2", provenance: { ...prov, source: "internal" } }],
      allowTextOnlyBrand: false,
      claims: [{ id: "c1", text: "255% avg client ROI", kind: "number", figure: "255%", evidence: "page", provenance: prov }],
      cta: { value: { label: "Book a free audit", url: "https://wheelr.example/book" }, provenance: [prov] },
      offer: { value: null, provenance: [] },
    },
    expected: { brandName: "Wheelr", ctaLabel: "Book a free audit", claimTexts: ["255% avg client ROI"], captionTexts: ["Hello there friends"], allowedOverlayText: [] },
    cues: [{ start: 0.5, end: 3, text: "Hello there friends" }],
    expectsLogo: true,
    asr: null,
    logoReference: Buffer.from("logo"),
    ...over,
  });

  const clean: FinalVisionResult = {
    textSeen: [
      { text: "Hello there friends", atSeconds: 1.2, region: "caption", legible: true },
      { text: "255% avg client ROI", atSeconds: 4, region: "overlay", legible: true },
      { text: "WHEELR", atSeconds: 7.4, region: "end_card", legible: true },
      { text: "Book a free audit", atSeconds: 7.6, region: "end_card", legible: true },
    ],
    logoSeen: [{ atSeconds: 7.5, matchesReference: true, region: "end card" }],
    captionIssues: [],
    summary: "A presenter, then a closing card.",
  };
  const rv = (over: Partial<FinalVisionResult> = {}): FinalVisionReviewer => async () => ({ ...clean, ...over });
  const run = (over: Partial<FinalQaInput>, vision: Partial<FinalVisionResult>) => reviewFinal(input(over), { reviewer: rv(vision) });
  const codes = (r: QaReport) => r.findings.map((f) => `${f.code}:${f.severity}`);

  it("passes a clean export, inspecting frames across it and sending the logo reference", async () => {
    let seen: { frames: number; notes: string[]; logo: boolean; rubric: string } | null = null;
    const r = await reviewFinal(input(), { reviewer: async (i) => ((seen = { frames: i.frames.length, notes: i.frames.map((f) => f.note), logo: !!i.logoReference, rubric: i.rubric }), clean) });
    expect(r.findings.filter((f) => f.severity !== "minor")).toEqual([]);
    expect(r.verdict).toBe("pass");
    expect(r.subject).toEqual({ kind: "final" });
    expect(r.framesInspected).toBeGreaterThanOrEqual(10);
    expect(seen!.logo).toBe(true);
    expect(seen!.notes.some((n) => n === "end card")).toBe(true);
    expect(seen!.rubric).toMatch(/VERBATIM/);
    expect(finalBlocks(r)).toBe(false);
  }, 60_000);

  it("blocks a wrong brand name on the end card, comparing exact letters ignoring case and spacing", async () => {
    const r = await run({}, { textSeen: [...clean.textSeen.filter((t) => t.region !== "end_card" || t.text !== "WHEELR"), { text: "Whlubler", atSeconds: 7.4, region: "end_card", legible: true }] });
    const f = r.findings.find((x) => x.code === "brand_name_wrong");
    expect(f?.severity).toBe("critical");
    expect(f?.evidence).toContain("Whlubler");
    expect(f?.correction).toContain("Wheelr");
    expect(r.verdict).toBe("unresolved");
    expect(finalBlocks(r)).toBe(true);
    // spacing and case do not matter
    const ok = await run({}, { textSeen: [...clean.textSeen.filter((t) => t.text !== "WHEELR"), { text: "W h e e l r", atSeconds: 7.4, region: "end_card", legible: true }] });
    expect(codes(ok)).not.toContain("brand_name_wrong:critical");
  }, 60_000);

  it("blocks an internal label shown anywhere", async () => {
    const r = await run({}, { textSeen: [...clean.textSeen, { text: "Q3 Retargeting Audit V2", atSeconds: 7.5, region: "end_card", legible: true }] });
    expect(codes(r)).toContain("internal_label_visible:critical");
    expect(finalBlocks(r)).toBe(true);
  }, 60_000);

  it("blocks an invented logo, and a logo inside the footage", async () => {
    const invented = await run({}, { logoSeen: [{ atSeconds: 7.5, matchesReference: false, region: "end card" }] });
    expect(codes(invented)).toContain("invented_branding:critical");
    expect(codes(invented)).toContain("logo_missing:critical");
    const inFootage = await run({}, { logoSeen: [...clean.logoSeen, { atSeconds: 3, matchesReference: null, region: "footage" }] });
    expect(codes(inFootage)).toContain("invented_branding:critical");
  }, 60_000);

  it("blocks a missing logo, unless a text-only brand is allowed", async () => {
    const missing = await run({}, { logoSeen: [] });
    expect(codes(missing)).toContain("logo_missing:critical");
    const textOnly = await run({ manifest: { ...input().manifest, allowTextOnlyBrand: true } }, { logoSeen: [] });
    expect(codes(textOnly)).not.toContain("logo_missing:critical");
    expect(textOnly.verdict).toBe("pass");
    const noLogoExpected = await run({ expectsLogo: false }, { logoSeen: [] });
    expect(codes(noLogoExpected)).not.toContain("logo_missing:critical");
  }, 60_000);

  it("blocks a figure on screen that is not an approved claim", async () => {
    const r = await run({}, { textSeen: [...clean.textSeen, { text: "300% more leads", atSeconds: 5, region: "overlay", legible: true }] });
    const f = r.findings.find((x) => x.code === "unsupported_claim");
    expect(f?.severity).toBe("critical");
    expect(f?.evidence).toContain("300");
    expect(codes(r)).not.toContain("unsupported_claim:critical:extra");
  }, 60_000);

  it("blocks readable text in the footage that is not approved", async () => {
    const r = await run({}, { textSeen: [...clean.textSeen, { text: "CC NOW", atSeconds: 2, region: "footage", legible: true }] });
    expect(codes(r)).toContain("fabricated_text:critical");
    expect(r.findings.find((f) => f.code === "fabricated_text")?.atSeconds).toBe(2);
    // unreadable footage text is not reported as readable text
    const faint = await run({}, { textSeen: [...clean.textSeen, { text: "??", atSeconds: 2, region: "footage", legible: false }] });
    expect(codes(faint)).not.toContain("fabricated_text:critical");
  }, 60_000);

  it("blocks a call to action that is different or unreadable", async () => {
    const r = await run({}, { textSeen: clean.textSeen.map((t) => (t.text === "Book a free audit" ? { ...t, text: "CC NOW" } : t)) });
    expect(codes(r)).toContain("cta_wrong:critical");
    const unreadable = await run({}, { textSeen: clean.textSeen.map((t) => (t.text === "Book a free audit" ? { ...t, legible: false } : t)) });
    expect(codes(unreadable)).toContain("cta_wrong:critical");
  }, 60_000);

  it("flags captions that cover faces or logos or are unreadable as major, and different caption text as major", async () => {
    const placement = await run({}, { captionIssues: [{ atSeconds: 1.2, problem: "covers_face", detail: "Caption over the chin and mouth" }] });
    expect(codes(placement)).toContain("caption_placement:major");
    expect(placement.verdict).toBe("unresolved");
    const mismatch = await run({}, { textSeen: clean.textSeen.map((t) => (t.region === "caption" ? { ...t, text: "Hello thare friends" } : t)) });
    expect(codes(mismatch)).toContain("caption_mismatch:major");
    const other = await run({}, { captionIssues: [{ atSeconds: 1, problem: "other", detail: "slightly small" }] });
    expect(codes(other)).toEqual(["caption_placement:minor"]);
    expect(other.verdict).toBe("pass");
  }, 60_000);

  it("flags a caption that disagrees with the audio", async () => {
    const asr = [{ word: "completely", start: 0.6, end: 1 }, { word: "different", start: 1, end: 1.5 }, { word: "speech", start: 1.5, end: 2 }];
    const r = await run({ asr }, {});
    expect(r.findings.find((f) => f.code === "caption_audio_mismatch")?.source).toBe("asr");
  }, 60_000);

  it("is unresolved with a limitation when no vision is available, and when it throws", async () => {
    const none = await reviewFinal(input(), { reviewer: null });
    expect(none.verdict).toBe("unresolved");
    expect(none.limitations.join(" ")).toMatch(/visual review not performed/);
    expect(finalBlocks(none)).toBe(true);
    const thrown = await reviewFinal(input(), {
      reviewer: async () => {
        throw new Error("boom");
      },
    });
    expect(thrown.verdict).toBe("unresolved");
    expect(thrown.limitations.join(" ")).toMatch(/boom/);
    const optional = await reviewFinal(input({ requireVision: false }), { reviewer: null });
    expect(optional.verdict).toBe("pass");
    expect(optional.limitations).toHaveLength(1);
  }, 60_000);

  it("checks the export technically and the end card length", async () => {
    const short = await run({ endCardSeconds: 1 }, { textSeen: clean.textSeen });
    expect(codes(short)).toContain("end_card_too_short:major");
    expect(MIN_END_CARD_SECONDS).toBeGreaterThanOrEqual(1.5);
    const wrongLength = await run({ seconds: 20 }, {});
    expect(codes(wrongLength)).toContain("duration_off:major");
    // a deliberately still, silent end card is not reported as frozen or silent
    const r = await run({}, {});
    expect(codes(r).filter((c) => /frozen|silence/.test(c))).toEqual([]);
    // but a still, silent stretch in the body is: here the whole file is treated as body
    const noTail = await run({ endCardSeconds: 0 }, { textSeen: clean.textSeen.map((t) => ({ ...t, region: t.region === "end_card" ? "overlay" : t.region })) });
    expect(codes(noTail).some((c) => /frozen_footage|speech_silence/.test(c))).toBe(true);
  }, 90_000);

  it("finalBlocks is true for anything but a clean pass", () => {
    const base: QaReport = { subject: { kind: "final" }, attempt: 1, checkedAt: "", verdict: "pass", findings: [], checks: [], framesInspected: 1, limitations: [] };
    expect(finalBlocks(base)).toBe(false);
    expect(finalBlocks({ ...base, verdict: "unresolved" })).toBe(true);
    expect(finalBlocks({ ...base, verdict: "retry" })).toBe(true);
    expect(finalBlocks({ ...base, findings: [{ code: "x", severity: "critical", category: "text", message: "", evidence: "", correction: "", source: "rule" }] })).toBe(true);
    expect(finalBlocks({ ...base, findings: [{ code: "x", severity: "minor", category: "text", message: "", evidence: "", correction: "", source: "rule" }] })).toBe(false);
  });

  it("looks harder at the end card and at captions", () => {
    const t = finalFrameTimes({ seconds: 20, endCardSeconds: 2.2, cues: [{ start: 1, end: 2, text: "a b" }, { start: 5, end: 6, text: "c d" }] });
    expect(t[0]!.at).toBe(0);
    expect(t.filter((x) => x.note === "end card").length).toBeGreaterThanOrEqual(3);
    expect(t.some((x) => x.note.startsWith("caption"))).toBe(true);
    expect(t.every((x) => x.at < 20)).toBe(true);
    expect([...t].sort((a, b) => a.at - b.at)).toEqual(t);
  });

  it("does not count text read from the operator's own composited image as text drawn in the footage", () => {
    const seen = { ...clean, textSeen: [{ text: "Conv. value", atSeconds: 4, region: "footage" as const, legible: true }, { text: "Whlubler", atSeconds: 9, region: "footage" as const, legible: true }] };
    const without = finalFindings(input(), seen).filter((x) => x.code === "fabricated_text").map((x) => x.message);
    expect(without).toHaveLength(2);
    const withWindow = finalFindings(input({ verifiedAssetWindows: [{ start: 3, end: 6 }] }), seen).filter((x) => x.code === "fabricated_text").map((x) => x.message);
    // only the text outside the image's time on screen is still an invented wordmark
    expect(withWindow).toHaveLength(1);
    expect(withWindow[0]).toContain("Whlubler");
  });

  it("works on findings directly with no ffmpeg", () => {
    const f = finalFindings(input(), { ...clean, textSeen: [] });
    expect(f.map((x) => x.code).sort()).toEqual(["brand_name_wrong", "cta_wrong"]);
    void noEnd;
  });
});
