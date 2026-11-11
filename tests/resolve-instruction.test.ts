import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/creatives/concept-writer", async (orig) => ({ ...(await orig<typeof import("@/lib/creatives/concept-writer")>()), pickModel: () => ({}) }));

const scrapes: string[] = [];
let page: { markdown: string; source: "firecrawl" | "heuristic" } | Error = {
  markdown: [
    "FREE 30-MINUTE GOOGLE ADS AUDIT",
    "![Client logo](https://x.test/1.png)",
    "![Client logo](https://x.test/2.png)",
    "Trusted by 1,500+ Australian Businesses",
    "$120M+ in Ad Spend Managed",
    "[Get My Free Audit](https://googleaudit.test/#audit)",
  ].join("\n"),
  source: "firecrawl",
};
vi.mock("@/lib/scraping/firecrawl", () => ({
  scrapeWebsiteServices: async (url: string) => {
    scrapes.push(url);
    if (page instanceof Error) throw page;
    return { url, markdown: page.markdown, source: page.source, services: [] };
  },
}));

const prompts: string[] = [];
let answer: Record<string, unknown> | Error = {};
vi.mock("ai", () => ({
  generateObject: async ({ prompt }: { prompt: string }) => {
    prompts.push(prompt);
    if (answer instanceof Error) throw answer;
    return { object: answer };
  },
}));

beforeEach(async () => {
  scrapes.length = 0;
  prompts.length = 0;
  page = {
    markdown: ["Trusted by 1,500+ Australian Businesses", "$120M+ in Ad Spend Managed", "![Client logo](https://x.test/1.png)", "[Get My Free Audit](https://googleaudit.test/#audit)"].join("\n"),
    source: "firecrawl",
  };
  answer = {
    needs_page: true,
    found: true,
    instruction: 'Replace the three chips with "1,500+ Australian Businesses", "$120M+ Ad Spend Managed" and "Free 30-Minute Audit".',
    facts: ["Trusted by 1,500+ Australian Businesses", "$120M+ in Ad Spend Managed"],
    problem: "",
  };
  (await import("@/lib/creatives/resolve-instruction")).clearPageCache();
});

const base = { mode: "edit" as const, landingPageUrl: "https://googleaudit.test/", headline: "Every Day Costs You More" };

describe("which instructions lean on a page", () => {
  it("flags a page, a section, stats, a pasted link; leaves plain visual edits alone", async () => {
    const { mayNeedPage, urlInInstruction } = await import("@/lib/creatives/resolve-instruction");
    for (const t of ["use the stats from the landing page", "pull the testimonials section", "show our case study numbers", "use https://a.test/x for the results", "take it from the website"]) expect(mayNeedPage(t), t).toBe(true);
    for (const t of ["make the background blue", "make the headline say Free Audit", "remove the badge on the right", "swap the colours", "bigger button"]) expect(mayNeedPage(t), t).toBe(false);
    expect(urlInInstruction("use https://a.test/pricing, please.")).toBe("https://a.test/pricing");
    expect(urlInInstruction("no link here")).toBeNull();
  });
});

describe("resolving an instruction against the landing page", () => {
  it("leaves a plain edit exactly as typed and reads nothing", async () => {
    const { resolveEditInstruction } = await import("@/lib/creatives/resolve-instruction");
    const out = await resolveEditInstruction({ ...base, instruction: "make the background dark blue" });
    expect(out.instruction).toBe("make the background dark blue");
    expect(out.usedPage).toBeNull();
    expect(scrapes).toHaveLength(0);
    expect(prompts).toHaveLength(0);
  });

  it("reads the landing page and gives the image editor the real stats, word for word", async () => {
    const { resolveEditInstruction } = await import("@/lib/creatives/resolve-instruction");
    const out = await resolveEditInstruction({ ...base, instruction: "Different concept, use the client stats from the landing page" });
    expect(scrapes).toEqual(["https://googleaudit.test/"]);
    expect(out.instruction).toContain("1,500+ Australian Businesses");
    expect(out.instruction).toContain("$120M+");
    expect(out.usedPage).toBe("https://googleaudit.test/");
    // The model was shown the page text, without the logo image lines, and the ad as it is now.
    expect(prompts[0]).toContain("Trusted by 1,500+ Australian Businesses");
    expect(prompts[0]).not.toContain("x.test/1.png");
    expect(prompts[0]).toContain("Every Day Costs You More");
    expect(prompts[0]).toContain("change ONLY what you describe");
  });

  it("tells a full redraw to keep the concept feedback and add the page words", async () => {
    const { resolveEditInstruction } = await import("@/lib/creatives/resolve-instruction");
    await resolveEditInstruction({ ...base, mode: "full", instruction: "different concept, use the stats from the landing page" });
    expect(prompts[0]).toContain("redrawn from its brief");
  });

  it("uses a link pasted in the instruction instead of the landing page", async () => {
    const { resolveEditInstruction } = await import("@/lib/creatives/resolve-instruction");
    await resolveEditInstruction({ ...base, instruction: "use the pricing section on https://other.test/pricing" });
    expect(scrapes).toEqual(["https://other.test/pricing"]);
  });

  it("reads a page once and reuses it for the next edits", async () => {
    const { resolveEditInstruction } = await import("@/lib/creatives/resolve-instruction");
    await resolveEditInstruction({ ...base, instruction: "use the stats from the landing page" });
    await resolveEditInstruction({ ...base, instruction: "now use the testimonials from the landing page" });
    expect(scrapes).toHaveLength(1);
    expect(prompts).toHaveLength(2);
  });

  it("stops, and says what is missing, when the page does not hold what was asked for", async () => {
    answer = { needs_page: true, found: false, instruction: "", facts: [], problem: "The page has no customer testimonials, only an overall client count." };
    const { resolveEditInstruction } = await import("@/lib/creatives/resolve-instruction");
    await expect(resolveEditInstruction({ ...base, instruction: "use the testimonials from the landing page" })).rejects.toThrow(/no customer testimonials/);
  });

  it("keeps the operator's own words when the model finds nothing was needed from the page", async () => {
    answer = { needs_page: false, found: false, instruction: "", facts: [], problem: "" };
    const { resolveEditInstruction } = await import("@/lib/creatives/resolve-instruction");
    const out = await resolveEditInstruction({ ...base, instruction: "move the page-turn graphic to the left" });
    expect(out.instruction).toBe("move the page-turn graphic to the left");
    expect(out.usedPage).toBeNull();
  });

  it("explains when the page cannot be opened or has no readable text", async () => {
    const { resolveEditInstruction } = await import("@/lib/creatives/resolve-instruction");
    page = new Error("timed out");
    await expect(resolveEditInstruction({ ...base, instruction: "use the stats from the landing page" })).rejects.toThrow(/Could not open .*timed out/);
    page = { markdown: "Unable to fetch https://googleaudit.test/.", source: "heuristic" };
    await expect(resolveEditInstruction({ ...base, instruction: "use the stats from the landing page" })).rejects.toThrow(/Could not read any text/);
  });

  it("explains when the model cannot be reached instead of silently ignoring the page", async () => {
    answer = new Error("credit balance is too low");
    const { resolveEditInstruction } = await import("@/lib/creatives/resolve-instruction");
    await expect(resolveEditInstruction({ ...base, instruction: "use the stats from the landing page" })).rejects.toThrow(/credit balance is too low/);
  });

  it("asks for a link when the image has no landing page and none was pasted", async () => {
    const { resolveEditInstruction } = await import("@/lib/creatives/resolve-instruction");
    await expect(resolveEditInstruction({ ...base, landingPageUrl: null, instruction: "use the stats from the landing page" })).rejects.toThrow(/Paste the page's link/);
    // a vague mention with nothing to read is just a normal edit
    const out = await resolveEditInstruction({ ...base, landingPageUrl: null, instruction: "bigger stats text" });
    expect(out.instruction).toBe("bigger stats text");
  });
});

describe("cleaning the page text", () => {
  it("drops image lines and link targets so the facts fit", async () => {
    const { cleanPageText } = await import("@/lib/creatives/resolve-instruction");
    const out = cleanPageText("![Client logo](https://x/1.png)\n[Get My Free Audit](https://a.test/#audit)\n\nTrusted by 1,500+");
    expect(out).toBe("[Get My Free Audit]\nTrusted by 1,500+");
  });
});
