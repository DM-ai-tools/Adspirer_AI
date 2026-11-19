import { describe, expect, it } from "vitest";
import { copyFromPrint, isDirectedDirection, publishCopy, readDirectedMarker, withDirectedMarker, type DirectedMeta } from "@/lib/creatives/directed/markers";
import { buildDirectedImagePrompt } from "@/lib/creatives/directed/prompt";
import { stripAspectMarker, withAspectMarker } from "@/lib/creatives/formats";

const meta: DirectedMeta = {
  picture: 'A cold-storage aisle at 3am,\nbreath misting; "quiet" mood — café light',
  print: [
    { role: "headline", text: "The account nobody checked twice." },
    { role: "button", text: "Get your audit" },
  ],
};

describe("the directed marker", () => {
  it("round-trips picture and printed lines, including quotes, newlines and non-ASCII", () => {
    const direction = withDirectedMarker("", meta);
    expect(readDirectedMarker(direction)).toEqual(meta);
  });

  it("keeps other marker lines, replaces an older directed marker, and is detected", () => {
    const base = withAspectMarker("", "4:5");
    const once = withDirectedMarker(base, meta);
    const twice = withDirectedMarker(once, { ...meta, tweak: "crop closer" });
    expect(twice.match(/^DIRECTED: /gm)).toHaveLength(1);
    expect(twice).toContain("ASPECT: 4:5");
    expect(readDirectedMarker(twice)?.tweak).toBe("crop closer");
    expect(isDirectedDirection(twice)).toBe(true);
    expect(isDirectedDirection("STYLE: poster")).toBe(false);
    expect(isDirectedDirection(null)).toBe(false);
  });

  it("is stripped from the direction the image model reads", () => {
    const direction = withAspectMarker(withDirectedMarker("", meta), "4:5");
    expect(stripAspectMarker(direction)).toBe("");
  });

  it("ignores a broken marker instead of throwing", () => {
    expect(readDirectedMarker("DIRECTED: !!!notbase64!!!")).toBeNull();
  });
});

describe("copy for the ad from the printed lines", () => {
  it("uses the headline-role line as the headline and the rest as primary text", () => {
    expect(copyFromPrint(meta.print)).toEqual({ headline: "The account nobody checked twice.", primary_text: "Get your audit" });
  });
  it("falls back to the first line when no role says headline", () => {
    expect(copyFromPrint([{ role: null, text: "First" }, { role: null, text: "Second" }])).toEqual({ headline: "First", primary_text: "Second" });
  });
  it("leaves primary text blank for a single line, and pasted copy wins", () => {
    expect(copyFromPrint([{ role: null, text: "Only" }])).toEqual({ headline: "Only", primary_text: "" });
    expect(copyFromPrint(meta.print, "Pasted body").primary_text).toBe("Pasted body");
  });
  it("copes with no lines", () => {
    expect(copyFromPrint([])).toEqual({ headline: "", primary_text: "" });
  });
});

describe("the copy sent to Meta for a directed image", () => {
  const directed = withDirectedMarker("", { picture: "x", print: [] });
  it("uses the headline as the primary text when only one line was printed (the operator's own words, nothing invented)", () => {
    expect(publishCopy({ headline: "Ride further", primary_text: "", creative_direction: directed })).toEqual({ headline: "Ride further", primaryText: "Ride further" });
  });
  it("leaves real copy, and every non-directed draft, exactly as it is", () => {
    expect(publishCopy({ headline: "H", primary_text: "Body", creative_direction: directed })).toEqual({ headline: "H", primaryText: "Body" });
    expect(publishCopy({ headline: "H", primary_text: "", creative_direction: "STYLE: x" })).toEqual({ headline: "H", primaryText: "" });
  });
});

describe("the directed image prompt", () => {
  const base = { picture: "A red door in a white wall", print: meta.print, format: "4:5" as const, hasLogo: false };

  it("gives the picture instruction and every printed line verbatim, and forbids other words", () => {
    const p = buildDirectedImagePrompt(base);
    expect(p).toContain("A red door in a white wall");
    expect(p).toContain('"The account nobody checked twice."');
    expect(p).toContain('"Get your audit"');
    expect(p).toContain("Print no other words");
  });

  it("prints no words at all when there are none", () => {
    const p = buildDirectedImagePrompt({ ...base, print: [] });
    expect(p).toContain("Print no words anywhere on the image");
    expect(p).not.toContain("Print no other words");
  });

  it("adds a variation tweak only when given", () => {
    expect(buildDirectedImagePrompt(base)).not.toContain("VARIATION");
    expect(buildDirectedImagePrompt({ ...base, tweak: "crop closer" })).toContain("VARIATION: keep everything the same except: crop closer");
  });

  it("always binds the image to the brand palette, whatever colours the picture instruction mentions", () => {
    const p = buildDirectedImagePrompt({ ...base, colors: ["#111111", "#ff0000", "#37ca37"] });
    expect(p).toMatch(/BRAND PALETTE[^\n]*always/i);
    expect(p).toContain("#111111");
    expect(p).toMatch(/#111111 as the dominant colour/);
    expect(p).toMatch(/#ff0000 for the strongest supporting/);
    expect(p).toMatch(/picture instruction[^\n]*decides what is shown[^\n]*never[^\n]*palette/i);
    expect(p).not.toMatch(/colours[^.\n]*override/i);
    expect(buildDirectedImagePrompt(base)).not.toContain("BRAND PALETTE");
  });

  it("says the logo is added afterwards and must not be drawn, when there is one", () => {
    expect(buildDirectedImagePrompt({ ...base, hasLogo: true })).toMatch(/logo is added afterwards[^.]*do not draw/i);
    expect(buildDirectedImagePrompt(base)).not.toMatch(/logo is added afterwards/i);
  });

  it("applies the edits already made to the image, in order, and none when there are none", () => {
    const p = buildDirectedImagePrompt({ ...base, edits: ["make the door red", "add morning light"] });
    expect(p).toMatch(/apply these changes the operator already asked for[^\n]*\n- make the door red\n- add morning light/i);
    expect(buildDirectedImagePrompt(base)).not.toMatch(/already asked for/i);
    expect(buildDirectedImagePrompt({ ...base, edits: [] })).not.toMatch(/already asked for/i);
  });

  it("includes revision notes and the format rule, and none of the agency craft brief", () => {
    const p = buildDirectedImagePrompt({ ...base, revisionNotes: "make it darker" });
    expect(p).toContain("make it darker");
    expect(p).toContain("4:5");
    expect(p).not.toMatch(/top agency/i);
  });
});
