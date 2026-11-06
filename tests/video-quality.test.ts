import { describe, expect, it } from "vitest";
import { qualityWarnings } from "@/lib/video/script";
import { nameFromUrl, projectName } from "@/lib/video/naming";
import { createProject, deleteProject, getProject, listProjects } from "@/lib/video/projects";

const scene = (line: string, number = 1) => ({ number, line }) as never;
const copy = (primaryText: string) => ({ primaryText, headline: "h", description: "d", cta: "Learn More" });

const GOOD_COPY = [
  "I thought my Google Ads were fine. They weren't.",
  "",
  "Every month the budget went out and the leads came in, so I never looked closer. Then I got a free audit and found where nearly a third of it was leaking into clicks that never turn into customers.",
  "",
  "Traffic Radius tracks every dollar back to revenue, not just clicks, so you can see what's actually working. Over 1,500 Australian businesses use them to stop guessing and start growing.",
  "",
  "Grab a free audit and see where yours is going.",
].join("\n");

describe("spoken lines should sound like a person", () => {
  it("passes natural, contracted, short lines", () => {
    expect(qualityWarnings({ scenes: [scene("Honestly? I had no idea where half my budget was going."), scene("Turns out we'd been paying for clicks that never turned into customers.", 2)], adCopy: copy(GOOD_COPY) })).toEqual([]);
  });
  it("flags stock marketing words, dashes, long sentences and stiff lines without contractions", () => {
    const w = qualityWarnings({
      scenes: [
        scene("Discover the game-changing solution that will unlock your ad potential."),
        scene("We tracked every dollar — and found the leaks.", 2),
        scene("Our team reviewed the account and identified several areas where the budget was being wasted across campaigns that were not performing as well as expected.", 3),
        scene("We reviewed the account and identified the wasted spend for you.", 4),
      ],
      adCopy: copy(GOOD_COPY),
    }).join(" | ");
    expect(w).toMatch(/Scene 1 sounds like an ad/);
    expect(w).toMatch(/Scene 2 sounds scripted: it uses a dash/);
    expect(w).toMatch(/Scene 3 has a \d+-word sentence/);
    expect(w).toMatch(/Most spoken lines have no contractions/);
  });
});

describe("ad copy length and hook", () => {
  it("flags thin copy and a hook line Meta would cut", () => {
    const thin = qualityWarnings({ scenes: [], adCopy: copy("Stop wasting spend.\nBook a free call.") }).join(" | ");
    expect(thin).toMatch(/short \(\d+ words\)/);
    const longHook = qualityWarnings({ scenes: [], adCopy: copy(`${"word ".repeat(40).trim()}\n\n${GOOD_COPY}`) }).join(" | ");
    expect(longHook).toMatch(/first line of the ad copy is \d+ characters/);
  });
  it("accepts a proper 70 to 130 word post with a short hook", () => {
    expect(qualityWarnings({ scenes: [], adCopy: copy(GOOD_COPY) })).toEqual([]);
  });
});

describe("naming a run by its landing page", () => {
  it("uses the host and path, without www, protocol, query or trailing slash", () => {
    expect(nameFromUrl("https://googleaudit.trafficradius.com.au/")).toBe("googleaudit.trafficradius.com.au");
    expect(nameFromUrl("https://www.example.com/audit/?utm=1")).toBe("example.com/audit");
    expect(nameFromUrl("example.com.au/offer")).toBe("example.com.au/offer");
    expect(nameFromUrl("")).toBeNull();
  });
  it("falls back to the brand, then a plain default", () => {
    expect(projectName({ inputs: {}, brand: { name: "Acme" } })).toBe("Acme");
    expect(projectName({ inputs: {}, brand: null })).toBe("Untitled video");
    expect(projectName({ inputs: { landingPageUrl: "https://a.test/x" } })).toBe("a.test/x");
  });
});

describe("deleting a run", () => {
  it("removes it from the list and from storage of projects", async () => {
    const inputs = { landingPageUrl: "https://a.test", stats: [], targetSeconds: 35, style: "auto", locale: "en-AU", format: "9:16" as const, priority: "balanced" as const };
    const a = await createProject({ clientId: "client_del", inputs });
    const b = await createProject({ clientId: "client_del", inputs });
    expect((await listProjects("client_del")).map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
    await deleteProject(a.id);
    expect(await getProject(a.id)).toBeNull();
    expect((await listProjects("client_del")).map((p) => p.id)).toEqual([b.id]);
  });
});
