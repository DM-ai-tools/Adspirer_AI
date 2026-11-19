import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "@/lib/config";
import { getCreativeDraftAsync } from "@/lib/creatives/drafts";
import { readDirectedMarker, type Direction } from "@/lib/creatives/directed/markers";
import { readRunMarker } from "@/lib/creatives/formats";
import { getRun } from "@/lib/creatives/bulk/runs";

vi.mock("@/lib/creatives/service", () => ({
  loadScope: async () => ({
    client: { id: "c1", name: "Acme", brand_voice: null, brand_colors: ["#37ca37"], website_url: null, target_audience: null, value_proposition: null },
    service: null,
    brief: null,
  }),
}));
vi.mock("@/lib/brand/analyze-url", () => ({ analyzeBrandFromUrl: async () => ({ brand_name: "Acme Co", colors: ["#ff0000"], logo_url: "https://acme.test/logo.png" }) }));
vi.mock("@/lib/creatives/uploaded-logo", () => ({ loadUploadedLogoDataUri: async () => null }));
vi.mock("@/lib/creatives/cloudinary", () => ({ isCloudinaryConfigured: () => false, uploadCreativeImage: async () => ({ url: "", mime: "image/png" }) }));
const sent: Array<{ prompt: string; logoUrl?: string | null }> = [];
vi.mock("@/lib/creatives/openai-image", async (orig) => ({
  ...(await orig<typeof import("@/lib/creatives/openai-image")>()),
  generateOpenAIImage: async (i: { prompt: string; logoUrl?: string | null }) => {
    sent.push({ prompt: i.prompt, logoUrl: i.logoUrl });
    return { imageUrl: null, b64: "aGk=", mime: "image/png", model: "m", prompt: i.prompt, status: "succeeded" as const, error: null };
  },
}));

import { planAndRenderDirected, startDirectedBulkRun } from "@/lib/creatives/bulk/directed-run";

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test";
  resetConfigCache();
  sent.length = 0;
});

const directions: Direction[] = [
  { picture: "A red door", print: [{ role: "headline", text: "Open the right door" }, { role: "button", text: "Book" }] },
  { picture: "A bicycle on a pier", print: [{ role: null, text: "Ride further" }] },
  { picture: "A quiet desk", print: [] },
];

describe("starting a run from directions", () => {
  it("makes exactly one pending draft per direction, in file order, including one with blank primary text", async () => {
    const run = await startDirectedBulkRun({ clientId: "c1", directions, format: "4:5" });
    expect(run.items).toHaveLength(3);
    expect(run.inputs.directed).toBe(true);
    expect(run.status).toBe("planning");
    const drafts = await Promise.all(run.items.map((i) => getCreativeDraftAsync(i.draft_id)));
    expect(drafts.map((d) => readDirectedMarker(d!.creative_direction)?.picture)).toEqual(directions.map((d) => d.picture));
    expect(drafts.every((d) => d!.image_status === "pending" && readRunMarker(d!.creative_direction) === run.id)).toBe(true);
    expect(drafts[1]).toMatchObject({ headline: "Ride further", primary_text: "" });
    expect(run.items.map((i) => i.angle_name)).toEqual(["Direction 1", "Direction 2", "Direction 3"]);
  });

  it("uses pasted copy as the primary text of every ad", async () => {
    const run = await startDirectedBulkRun({ clientId: "c1", directions, format: "4:5", pastedCopy: "Our pasted body" });
    const drafts = await Promise.all(run.items.map((i) => getCreativeDraftAsync(i.draft_id)));
    expect(drafts.every((d) => d!.primary_text === "Our pasted body")).toBe(true);
  });

  it("refuses an empty list and more than thirty", async () => {
    await expect(startDirectedBulkRun({ clientId: "c1", directions: [], format: "4:5" })).rejects.toThrow(/at least one/i);
    const many = Array.from({ length: 31 }, (_, i) => ({ picture: `P${i}`, print: [] }));
    await expect(startDirectedBulkRun({ clientId: "c1", directions: many, format: "4:5" })).rejects.toThrow(/30/);
  });
});

describe("rendering the run", () => {
  it("renders every direction, blank primary text included, with the brand logo, and finishes the run", async () => {
    const run = await startDirectedBulkRun({ clientId: "c1", directions, format: "4:5", landingPageUrl: "https://acme.test/offer" });
    await planAndRenderDirected(run.id);
    expect(sent).toHaveLength(3);
    for (const d of directions) expect(sent.some((s) => s.prompt.includes(d.picture))).toBe(true);
    expect(sent.find((s) => s.prompt.includes("A quiet desk"))!.prompt).toContain("Print no words anywhere on the image");
    expect(sent.every((s) => s.logoUrl === "https://acme.test/logo.png")).toBe(true);
    const after = (await getRun(run.id))!;
    expect(after.status).toBe("done");
    const drafts = await Promise.all(after.items.map((i) => getCreativeDraftAsync(i.draft_id)));
    expect(drafts.every((d) => d!.image_status === "succeeded" && d!.logo_url === "https://acme.test/logo.png")).toBe(true);
  });
});
