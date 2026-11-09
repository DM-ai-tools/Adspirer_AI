import { describe, expect, it } from "vitest";
import { reopenCheck, reopenPatch } from "@/lib/video/script-actions";
import type { ClipState } from "@/lib/video/generation-types";
import type { VideoProject } from "@/lib/video/projects";
import type { VideoScript } from "@/lib/video/script";

const script = (id: string, line: string, edited = false): VideoScript => ({ id, title: id, scenes: [{ number: 1, line, edited }], adCopy: { primaryText: "x", headline: "h", description: "d", cta: "Learn More" } }) as unknown as VideoScript;
const clip = (over: Partial<ClipState> = {}): ClipState => ({ number: 1, seconds: 8, sceneNumbers: [1], status: "waiting", taskId: null, attempts: 0, error: null, videoKey: null, lastFrameUrl: null, sourceVideoUrl: null, finishedAt: null, tokens: null, usd: null, prompt: null, ...over });
const project = (over: Partial<VideoProject> = {}): VideoProject => ({ id: "p", status: "confirmed", chosen_script: script("b", "Edited by me.", true), scripts: [script("a", "A"), script("b", "Original B"), script("c", "C")], clips: null, final: null, plan: null, error: null, ...over }) as unknown as VideoProject;

describe("reopening a confirmed script for last-minute changes", () => {
  it("is allowed after confirming and before anything has been made", () => {
    expect(reopenCheck(project())).toEqual({ ok: true });
  });

  it("is allowed when generation was prepared but no clip was started (and when it failed before any clip)", () => {
    expect(reopenCheck(project({ clips: [clip(), clip({ number: 2 })] }))).toEqual({ ok: true });
    expect(reopenCheck(project({ status: "failed", clips: [clip()], error: "The creative plan did not pass its checks." }))).toEqual({ ok: true });
  });

  it("is refused once a clip has been started or made, or the video is finished, and says why", () => {
    for (const started of [clip({ status: "running", taskId: "t" }), clip({ attempts: 1 }), clip({ status: "succeeded", videoKey: "k" })]) {
      const r = reopenCheck(project({ clips: [started] }));
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.reason).toMatch(/Clips have already been made/);
    }
    expect(reopenCheck(project({ final: { state: "done" } as never })).ok).toBe(false);
    const generating = reopenCheck(project({ status: "generating" }));
    expect(generating.ok === false && generating.reason).toMatch(/already being made/);
  });

  it("is refused when there is nothing confirmed, and when it is already open", () => {
    expect(reopenCheck(project({ chosen_script: null })).ok).toBe(false);
    const open = reopenCheck(project({ status: "scripts_ready" }));
    expect(open.ok === false && open.reason).toMatch(/already open/);
  });

  it("puts the confirmed version (with the operator's edits) back in the list in place of its original, leaves the others, and clears the half-prepared generation", () => {
    const p = project({ plan: { model: "x" } as never, clips: [clip()] });
    const patch = reopenPatch(p);
    expect(patch.status).toBe("scripts_ready");
    expect(patch.scripts!.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(patch.scripts![1]!.scenes[0]!.line).toBe("Edited by me.");
    expect(patch.scripts![1]!.scenes[0]!.edited).toBe(true);
    expect(patch.scripts![0]!.scenes[0]!.line).toBe("A");
    expect(patch).toMatchObject({ plan: null, clips: null, final: null, error: null });
  });

  it("adds the confirmed script back if it is not in the list (an uploaded script)", () => {
    const patch = reopenPatch(project({ scripts: [] }));
    expect(patch.scripts!.map((s) => s.id)).toEqual(["b"]);
  });
});
