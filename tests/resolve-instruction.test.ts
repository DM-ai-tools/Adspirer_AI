import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/creatives/concept-writer", async (orig) => ({ ...(await orig<typeof import("@/lib/creatives/concept-writer")>()), pickModel: () => ({}) }));

const scrapes: string[] = [];
let page: { markdown: string; source: "firecrawl" | "heuristic" } | Error = { markdown: "", source: "firecrawl" };
vi.mock("@/lib/scraping/firecrawl", () => ({
  scrapeWebsiteServices: async (url: string) => {
    scrapes.push(url);
    if (page instanceof Error) throw page;
    return { url, markdown: page.markdown, source: page.source, services: [] };
  },
}));

/** Step 1 reads the request (and sees the image) through `messages`; step 2 reads the page through `prompt`. */
const understandCalls: Array<{ text: string; hadImage: boolean }> = [];
const pageCalls: string[] = [];
let understood: Record<string, unknown> | Error = {};
let filled: Record<string, unknown> | Error = {};
vi.mock("ai", () => ({
  generateObject: async (args: { prompt?: string; messages?: Array<{ content: Array<{ type: string; text?: string }> }> }) => {
    if (args.messages) {
      const content = args.messages[0]!.content;
      understandCalls.push({ text: content.find((c) => c.type === "text")!.text!, hadImage: content.some((c) => c.type === "image") });
      if (understood instanceof Error) throw understood;
      return { object: understood };
    }
    pageCalls.push(args.prompt ?? "");
    if (filled instanceof Error) throw filled;
    return { object: filled };
  },
}));

const PAGE_TEXT = [
  "Trusted by 1,500+ Australian Businesses",
  "$120M+ in Ad Spend Managed",
  "![Client logo](https://x.test/1.png)",
  "[Get My Free Audit](https://googleaudit.test/#audit)",
  "Our free 30-minute audit shows exactly where your Google Ads budget is leaking and what to fix first for better leads.",
].join("\n");

async function tinyImage() {
  const sharp = (await import("sharp")).default;
  return sharp({ create: { width: 40, height: 50, channels: 3, background: "#224466" } }).png().toBuffer();
}

beforeEach(async () => {
  scrapes.length = 0;
  understandCalls.length = 0;
  pageCalls.length = 0;
  page = { markdown: PAGE_TEXT, source: "firecrawl" };
  understood = { needs_page: false, instruction: "Change the headline to read 'Stop Paying For Clicks That Never Convert'.", summary: "Rewriting the headline to lead with wasted clicks." };
  filled = {
    found: true,
    instruction: 'Replace the three chips with "1,500+ Australian Businesses", "$120M+ Ad Spend Managed" and "Free 30-Minute Audit".',
    facts: ["Trusted by 1,500+ Australian Businesses", "$120M+ in Ad Spend Managed"],
    problem: "",
  };
  (await import("@/lib/creatives/resolve-instruction")).clearPageCache();
});

const base = { mode: "edit" as const, landingPageUrl: "https://googleaudit.test/", headline: "Every Day Costs You More", brandName: "Traffic Radius" };

describe("understanding an edit request", () => {
  it("has the model decide what to change when the operator did not say, and shows the image to it", async () => {
    const { resolveEditInstruction } = await import("@/lib/creatives/resolve-instruction");
    const out = await resolveEditInstruction({ ...base, image: await tinyImage(), instruction: "make the headline punchier" });
    expect(out.instruction).toContain("Stop Paying For Clicks That Never Convert");
    expect(out.summary).toMatch(/headline/);
    expect(out.usedPage).toBeNull();
    // It saw the current image, the ad and the request; no page was read.
    expect(understandCalls).toHaveLength(1);
    expect(understandCalls[0]!.hadImage).toBe(true);
    expect(understandCalls[0]!.text).toContain("make the headline punchier");
    expect(understandCalls[0]!.text).toContain("Every Day Costs You More");
    expect(scrapes).toHaveLength(0);
    expect(pageCalls).toHaveLength(0);
  });

  it("tells the model the editor changes only what it names (edit) or redraws from the brief (full)", async () => {
    const { resolveEditInstruction } = await import("@/lib/creatives/resolve-instruction");
    await resolveEditInstruction({ ...base, instruction: "cleaner" });
    expect(understandCalls[0]!.text).toContain("change ONLY what you describe");
    expect(understandCalls[0]!.text).toContain("pick one concrete change");
    await resolveEditInstruction({ ...base, mode: "full", instruction: "a different concept" });
    expect(understandCalls[1]!.text).toContain("redrawn from its brief");
    expect(understandCalls[1]!.text).toContain("decide the new visual idea concretely");
  });

  it("works without an image", async () => {
    const { resolveEditInstruction } = await import("@/lib/creatives/resolve-instruction");
    await resolveEditInstruction({ ...base, instruction: "cleaner" });
    expect(understandCalls[0]!.hadImage).toBe(false);
  });

  it("passes on what it understood when the model sees nothing to improve on", async () => {
    understood = { needs_page: false, instruction: "", summary: "" };
    const { resolveEditInstruction } = await import("@/lib/creatives/resolve-instruction");
    const out = await resolveEditInstruction({ ...base, instruction: "make the background dark blue" });
    expect(out.instruction).toBe("make the background dark blue");
    expect(out.summary.length).toBeGreaterThan(0);
  });
});

describe("requests that lean on a web page", () => {
  beforeEach(() => {
    understood = { needs_page: true, instruction: "Show three client stats from the page on the chips.", summary: "Putting real client stats from your landing page on the image." };
  });

  it("reads the landing page and gives the image editor the real words, word for word", async () => {
    const { resolveEditInstruction } = await import("@/lib/creatives/resolve-instruction");
    const out = await resolveEditInstruction({ ...base, instruction: "Different concept, use the client stats from the landing page" });
    expect(scrapes).toEqual(["https://googleaudit.test/"]);
    expect(out.instruction).toContain("1,500+ Australian Businesses");
    expect(out.instruction).toContain("$120M+");
    expect(out.usedPage).toBe("https://googleaudit.test/");
    expect(out.summary).toMatch(/client stats/);
    // The page text reached the second call without the logo image lines.
    expect(pageCalls[0]).toContain("Trusted by 1,500+ Australian Businesses");
    expect(pageCalls[0]).not.toContain("x.test/1.png");
    expect(pageCalls[0]).toContain("Show three client stats from the page on the chips.");
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
    expect(pageCalls).toHaveLength(2);
  });

  it("stops, and says what is missing, when the page does not hold what was asked for", async () => {
    filled = { found: false, instruction: "", facts: [], problem: "The page has no customer testimonials, only an overall client count." };
    const { resolveEditInstruction } = await import("@/lib/creatives/resolve-instruction");
    await expect(resolveEditInstruction({ ...base, instruction: "use the testimonials from the landing page" })).rejects.toThrow(/no customer testimonials/);
  });

  it("explains when the page cannot be opened or has no readable text", async () => {
    const { resolveEditInstruction } = await import("@/lib/creatives/resolve-instruction");
    page = new Error("timed out");
    await expect(resolveEditInstruction({ ...base, instruction: "use the stats from the landing page" })).rejects.toThrow(/Could not open .*timed out/);
    page = { markdown: "Unable to fetch https://googleaudit.test/.", source: "heuristic" };
    await expect(resolveEditInstruction({ ...base, instruction: "use the stats from the landing page" })).rejects.toThrow(/Could not read any text/);
  });

  it("asks for a link when the image has no landing page and none was pasted", async () => {
    const { resolveEditInstruction } = await import("@/lib/creatives/resolve-instruction");
    await expect(resolveEditInstruction({ ...base, landingPageUrl: null, instruction: "use the stats from the landing page" })).rejects.toThrow(/Paste the page's link/);
  });

  it("does not read the page when the model says the request does not need it", async () => {
    understood = { needs_page: false, instruction: "Move the page-turn graphic to the left.", summary: "Moving the graphic." };
    const { resolveEditInstruction } = await import("@/lib/creatives/resolve-instruction");
    const out = await resolveEditInstruction({ ...base, instruction: "move the page-turn graphic to the left" });
    expect(out.usedPage).toBeNull();
    expect(scrapes).toHaveLength(0);
  });
});

describe("when the interpreter cannot be reached", () => {
  it("still passes a plain edit on exactly as written, and says so", async () => {
    understood = new Error("credit balance is too low");
    const { resolveEditInstruction } = await import("@/lib/creatives/resolve-instruction");
    const out = await resolveEditInstruction({ ...base, instruction: "make the background dark blue" });
    expect(out.instruction).toBe("make the background dark blue");
    expect(out.summary).toMatch(/exactly as you wrote it/);
  });

  it("stops, with the reason, for a request that needs the page, instead of silently ignoring it", async () => {
    understood = new Error("credit balance is too low");
    const { resolveEditInstruction } = await import("@/lib/creatives/resolve-instruction");
    await expect(resolveEditInstruction({ ...base, instruction: "use the stats from the landing page" })).rejects.toThrow(/credit balance is too low/);
  });
});

describe("helpers", () => {
  it("spots a page reference or a pasted link", async () => {
    const { mayNeedPage, urlInInstruction } = await import("@/lib/creatives/resolve-instruction");
    for (const t of ["use the stats from the landing page", "pull the testimonials section", "use https://a.test/x for the results"]) expect(mayNeedPage(t), t).toBe(true);
    for (const t of ["make the background blue", "make the headline say Free Audit", "bigger button"]) expect(mayNeedPage(t), t).toBe(false);
    expect(urlInInstruction("use https://a.test/pricing, please.")).toBe("https://a.test/pricing");
  });

  it("cleans page text: drops image lines and link targets so the facts fit", async () => {
    const { cleanPageText } = await import("@/lib/creatives/resolve-instruction");
    expect(cleanPageText("![Client logo](https://x/1.png)\n[Get My Free Audit](https://a.test/#audit)\n\nTrusted by 1,500+")).toBe("[Get My Free Audit]\nTrusted by 1,500+");
  });
});
