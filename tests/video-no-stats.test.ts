import { describe, expect, it } from "vitest";
import { planPrompt, type PlanInput } from "@/lib/video/scene-plan";
import { clipVisual } from "@/lib/video/visual-rules";
import { viewGeneration } from "@/lib/video/generation";
import { providerCapabilities } from "@/lib/video/capabilities";
import type { VideoProject } from "@/lib/video/projects";

const planInput = (): PlanInput =>
  ({
    brandName: "Kestrel",
    product: "roof inspection",
    audience: "homeowners",
    offer: "inspection",
    platform: "Meta",
    objective: "leads",
    targetSeconds: 20,
    locale: "en-AU",
    script: {
      style: "Cinematic heist",
      character: null,
      setting: "a roof",
      scenes: [{ number: 1, line: "Every job needs a plan.", seconds: 4, speaker: "voiceover", keywords: [], stat: null, assetId: null, visual: "Hailstones in balaclavas gather around a map of the suburb", camera: "slow push in", sound: "tense strings" }],
    },
    assets: [],
    claims: [],
    capabilities: providerCapabilities(),
    maxSeconds: 60,
    mode: "clean",
  }) as PlanInput;

describe("the planner works from the approved scenes", () => {
  it("treats each scene's picture as approved, adding shot detail without replacing what happens", () => {
    const p = planPrompt(planInput());
    expect(p).toContain("Hailstones in balaclavas gather around a map of the suburb");
    expect(p).not.toMatch(/you may replace/i);
    expect(p).toMatch(/approved/i);
  });
});

describe("no fixed stand-in shot", () => {
  it("never swaps a screen shot for the same desk-and-laptop picture", () => {
    const swapped = clipVisual("Full-screen capture of a Google Ads dashboard", true, true);
    expect(swapped.text).not.toMatch(/desk/i);
    expect(swapped.text).not.toMatch(/dashboard/i);
    expect(clipVisual("A hand turns a coffee cup", true, false)).toEqual({ text: "A hand turns a coffee cup", changed: false });
  });
});

describe("no stats in the video step", () => {
  it("does not offer a list of stats to insert", () => {
    const project = {
      id: "p1",
      client_id: "c1",
      service_id: null,
      created_by: null,
      inputs: { stats: [], targetSeconds: 30, style: "auto", locale: "en-AU", format: "9:16", priority: "balanced" },
      assets: [],
      brand: null,
      status: "confirmed",
      error: null,
      scripts: null,
      chosen_script: null,
      created_at: "",
      updated_at: "",
    } as unknown as VideoProject;
    expect("statInserts" in viewGeneration(project)).toBe(false);
  });
});
