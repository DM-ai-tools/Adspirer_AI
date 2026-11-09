import { describe, expect, it } from "vitest";
import { repairScript, repairText } from "@/lib/video/script-repairs";
import type { VideoScene, VideoScript } from "@/lib/video/script";

const source = "Inspections are free for homeowners with a storm claim. Book at kestrelroofing.example/inspect or call 02 5550 0188. Licensed and insured.";

describe("mechanical repairs", () => {
  it("drops a 'free' the sources only give with a condition, and keeps one they state", () => {
    expect(repairText("Book your free inspection today.", source).text).toBe("Book your inspection today.");
    expect(repairText("Inspections are free for homeowners.", source).changes).toEqual([]);
    expect(repairText("It is carefree and sugar-free.", source).text).toBe("It is carefree and sugar-free.");
  });

  it("drops a best or ranking nobody substantiates, and keeps the word when the sources use it", () => {
    expect(repairText("We have the best tools in town.", source).text).toBe("We have the tools in town.");
    expect(repairText("We are the leading roofers.", source).text).toBe("We are the roofers.");
    expect(repairText("We are the best fit.", "Why we are the best fit for storm claims").changes).toEqual([]);
  });

  it("puts back the web address and the phone number exactly as the page gives them", () => {
    expect(repairText("Book at KestrelRoofing.com.au today.", source).text).toBe("Book at kestrelroofing.example/inspect today.");
    expect(repairText("Call 02 5550 0199 now.", source).text).toBe("Call 02 5550 0188 now.");
    expect(repairText("Book at kestrelroofing.example/inspect or call 02 5550 0188.", source).changes).toEqual([]);
  });

  it("never adds words", () => {
    const before = "Book your free inspection at KestrelRoofing.com.au, the best way.";
    const after = repairText(before, source).text;
    expect(after.split(/\s+/).length).toBeLessThanOrEqual(before.split(/\s+/).length);
  });

  const scene = (number: number, line: string, edited = false): VideoScene => ({ number, start: 0, end: 3, seconds: 3, visual: "v", camera: "c", speaker: "voiceover", line, keywords: [], stat: null, assetId: null, sound: "", edited });
  const script = (lines: string[], edited: number[] = []): VideoScript =>
    ({ id: "s", title: "t", scenes: lines.map((l, i) => scene(i + 1, l, edited.includes(i + 1))), adCopy: { primaryText: "A free inspection.", headline: "Free roof check", description: "d", cta: "Book Now" }, cta: { spoken: "stale closing", label: "Book Now", target: null, benefit: null }, warnings: [] }) as unknown as VideoScript;

  it("repairs the scenes, the ad copy and the closing line, and records what it did", () => {
    const out = repairScript(script(["Hail hides damage.", "Book your free inspection at KestrelRoofing.com.au."]), source);
    expect(out.scenes[1]!.line).toBe("Book your inspection at kestrelroofing.example/inspect.");
    expect(out.adCopy.primaryText).toBe("A inspection.");
    expect(out.cta!.spoken).toBe(out.scenes[1]!.line);
    expect(out.warnings.join(" ")).toMatch(/Corrected automatically: Scene 2/);
  });

  it("leaves a scene the operator edited exactly as they wrote it", () => {
    const out = repairScript(script(["Hail hides damage.", "Book your free inspection."], [2]), source);
    expect(out.scenes[1]!.line).toBe("Book your free inspection.");
  });

  it("returns the same script when nothing needs repairing", () => {
    const clean = { ...script(["Hail hides damage.", "Book at kestrelroofing.example/inspect."]), adCopy: { primaryText: "Hail hides damage.", headline: "Check the roof", description: "d", cta: "Book Now" } } as VideoScript;
    clean.cta = { spoken: "Book at kestrelroofing.example/inspect.", label: "Book Now", target: null, benefit: null };
    expect(repairScript(clean, source)).toBe(clean);
  });
});

describe("urgency and the page's own contact details", () => {
  it("drops a sentence of unsupported urgency, and keeps what is left", () => {
    const r = repairText("Hail hides damage. Don't wait until it's too late; act before the window closes.", source);
    expect(r.text).toBe("Hail hides damage.");
    expect(r.changes.join(" ")).toMatch(/urgency/);
  });
  it("keeps urgency wording the sources themselves use", () => {
    expect(repairText("Act now.", "Act now and book.").changes).toEqual([]);
  });
  it("never empties a line: a line that is only urgency is left for the editor to report", () => {
    expect(repairText("Don't wait.", source).text).toBe("Don't wait.");
  });
  it("lists the web addresses and phone numbers a page gives", async () => {
    const { contactTokens } = await import("@/lib/video/script-repairs");
    expect(contactTokens("Call 1300 555 014 or visit kestrelroofing.example/inspect today.").sort()).toEqual(["1300 555 014", "kestrelroofing.example/inspect"].sort());
  });
});
