import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "@/lib/config";
import { getCreativeDraftAsync } from "@/lib/creatives/drafts";
import { readAspectMarker, readRunMarker } from "@/lib/creatives/formats";
import { readDirectedMarker, type Direction } from "@/lib/creatives/directed/markers";

const clientColors = vi.hoisted(() => ({ value: ["#37ca37", "#111111"] as string[] | null, site: "https://acme.test" as string | null }));
vi.mock("@/lib/creatives/service", () => ({
  loadScope: async () => ({
    client: { id: "c1", name: "Acme", brand_voice: null, brand_colors: clientColors.value, website_url: clientColors.site, target_audience: null, value_proposition: null },
    service: null,
    brief: null,
  }),
}));
let analysis: { brand_name?: string; colors?: string[]; logo_url?: string | null } | Error = { brand_name: "Acme Co", colors: ["#ff0000"], logo_url: "https://acme.test/logo.png" };
vi.mock("@/lib/brand/analyze-url", () => ({
  analyzeBrandFromUrl: async () => {
    if (analysis instanceof Error) throw analysis;
    return analysis;
  },
}));
vi.mock("@/lib/creatives/uploaded-logo", () => ({ loadUploadedLogoDataUri: async () => null }));
vi.mock("@/lib/creatives/cloudinary", () => ({ isCloudinaryConfigured: () => false, uploadCreativeImage: async () => ({ url: "", mime: "image/png" }) }));

const sent: Array<{ prompt: string; logoUrl?: string | null; size?: string }> = [];
let imageResult: { status: "succeeded" | "failed"; error?: string } = { status: "succeeded" };
vi.mock("@/lib/creatives/openai-image", async (orig) => ({
  ...(await orig<typeof import("@/lib/creatives/openai-image")>()),
  generateOpenAIImage: async (input: { prompt: string; logoUrl?: string | null; size?: string }) => {
    sent.push({ prompt: input.prompt, logoUrl: input.logoUrl, size: input.size });
    if (imageResult.status === "failed") throw new Error(imageResult.error ?? "boom");
    return { imageUrl: null, b64: "aGVsbG8=", mime: "image/png", model: "gpt-image-test", prompt: input.prompt, status: "succeeded" as const, error: null, logoBox: { left: 1, top: 2, width: 3, height: 4 } };
  },
}));

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test";
  resetConfigCache();
  sent.length = 0;
  imageResult = { status: "succeeded" };
  analysis = { brand_name: "Acme Co", colors: ["#ff0000"], logo_url: "https://acme.test/logo.png" };
  clientColors.value = ["#37ca37", "#111111"];
  clientColors.site = "https://acme.test";
});

const directions: Direction[] = [
  { picture: "A red door in a white wall", print: [{ role: "headline", text: "Open the right door" }, { role: "button", text: "Book now" }] },
  { picture: "A lone bicycle on a pier at dawn", print: [{ role: null, text: "Ride further" }] },
  { picture: "A quiet desk, no words", print: [] },
];

async function brand() {
  const { loadDirectedBrand } = await import("@/lib/creatives/directed/create");
  return loadDirectedBrand({ clientId: "c1", landingUrl: "https://acme.test/offer" });
}

describe("loading the brand for directed images", () => {
  it("uses the page's name, colours and logo", async () => {
    expect(await brand()).toEqual({ brandName: "Acme Co", colors: ["#ff0000"], logoUrl: "https://acme.test/logo.png", landingUrl: "https://acme.test/offer" });
  });
  it("falls back to the client's colours when the page cannot be read, and never throws", async () => {
    analysis = new Error("blocked");
    const b = await brand();
    expect(b.brandName).toBe("Acme");
    expect(b.colors).toEqual(["#37ca37", "#111111"]);
    expect(b.logoUrl).toBeNull();
  });
});

describe("finding the brand when the client has no website saved", () => {
  const latest = async (over: Record<string, unknown>) => {
    const { upsertCreativeDraftAsync } = await import("@/lib/creatives/drafts");
    return upsertCreativeDraftAsync({
      client_id: "c1", service_id: null, conversation_id: null, task_id: null, brief_id: null, concept: "Acme — earlier", headline: "h", primary_text: "p", description: null, cta: null,
      creative_direction: "STYLE: x", image_url: "https://x/y.png", image_b64: null, image_mime: "image/png", image_model: null, image_prompt: null, image_status: "succeeded", image_error: null,
      landing_page_url: "https://old.acme.test/", brand_colors: ["#abcdef", "#123456"], logo_url: "https://old.acme.test/logo.png", revision_notes: null, status: "ready", ...over,
    } as never);
  };

  it("reuses the colours, logo and page of the client's most recent earlier image instead of drawing without a brand", async () => {
    analysis = new Error("no network in this test");
    clientColors.value = null;
    clientColors.site = null;
    await latest({});
    const { loadDirectedBrand } = await import("@/lib/creatives/directed/create");
    const b = await loadDirectedBrand({ clientId: "c1", landingUrl: null });
    expect(b.colors).toEqual(["#abcdef", "#123456"]);
    expect(b.logoUrl).toBe("https://old.acme.test/logo.png");
    expect(b.landingUrl).toBe("https://old.acme.test/");
  });

  it("prefers a page the operator names over earlier images", async () => {
    await latest({});
    const { loadDirectedBrand } = await import("@/lib/creatives/directed/create");
    const b = await loadDirectedBrand({ clientId: "c1", landingUrl: "https://acme.test/offer" });
    expect(b.colors).toEqual(["#ff0000"]);
    expect(b.logoUrl).toBe("https://acme.test/logo.png");
  });
});

describe("creating directed drafts", () => {
  it("makes one draft per direction, in order, with marker, shape and ad copy", async () => {
    const { createDirectedDrafts } = await import("@/lib/creatives/directed/create");
    const drafts = await createDirectedDrafts({ clientId: "c1", directions, format: "9:16", brand: await brand() });
    expect(drafts).toHaveLength(3);
    expect(drafts.map((d) => readDirectedMarker(d.creative_direction)?.picture)).toEqual(directions.map((d) => d.picture));
    expect(drafts.map((d) => readAspectMarker(d.creative_direction))).toEqual(["9:16", "9:16", "9:16"]);
    expect(drafts[0]).toMatchObject({ headline: "Open the right door", primary_text: "Book now", image_status: "generating", logo_url: "https://acme.test/logo.png" });
    expect(drafts[1]).toMatchObject({ headline: "Ride further", primary_text: "" });
    expect(drafts[2]).toMatchObject({ headline: "", primary_text: "" });
  });

  it("can make them pending inside a bulk run, with the run marker and pasted copy", async () => {
    const { createDirectedDrafts } = await import("@/lib/creatives/directed/create");
    const drafts = await createDirectedDrafts({ clientId: "c1", directions: directions.slice(0, 2), format: "4:5", brand: await brand(), status: "pending", runId: "run_9", pastedCopy: "Pasted body", conceptPrefix: "Direction" });
    expect(drafts.every((d) => d.image_status === "pending" && readRunMarker(d.creative_direction) === "run_9")).toBe(true);
    expect(drafts.every((d) => d.primary_text === "Pasted body")).toBe(true);
    expect(drafts[0]!.concept).toBe("Acme Co — Direction 1");
  });
});

describe("rendering a directed draft", () => {
  async function make(over: Partial<Direction> = {}) {
    const { createDirectedDrafts } = await import("@/lib/creatives/directed/create");
    return (await createDirectedDrafts({ clientId: "c1", directions: [{ ...directions[0]!, ...over }], format: "4:5", brand: await brand() }))[0]!;
  }

  it("sends the picture and every printed line verbatim, and stores the image with the marker kept", async () => {
    const draft = await make();
    const { renderDirectedDraft } = await import("@/lib/creatives/directed/render");
    const result = await renderDirectedDraft(draft.id);
    expect(result.imageStatus).toBe("succeeded");
    expect(sent[0]!.prompt).toContain("A red door in a white wall");
    expect(sent[0]!.prompt).toContain('"Open the right door"');
    expect(sent[0]!.prompt).toContain('"Book now"');
    expect(sent[0]!.logoUrl).toBe("https://acme.test/logo.png");
    expect(sent[0]!.size).toBe("1024x1280");
    const stored = (await getCreativeDraftAsync(draft.id))!;
    expect(readDirectedMarker(stored.creative_direction)?.picture).toBe("A red door in a white wall");
    expect(stored.creative_direction).toContain("LOGO: 1,2,3,4");
    expect(stored.image_status).toBe("succeeded");
  });

  it("always puts the brand logo on, even when the picture instruction says no logo", async () => {
    const draft = await make({ picture: "A red door, no logo please" });
    const { renderDirectedDraft } = await import("@/lib/creatives/directed/render");
    await renderDirectedDraft(draft.id);
    expect(sent[0]!.logoUrl).toBe("https://acme.test/logo.png");
    expect(sent[0]!.prompt).toMatch(/logo is added afterwards/i);
  });

  it("passes revision notes into the prompt", async () => {
    const draft = await make();
    const { renderDirectedDraft } = await import("@/lib/creatives/directed/render");
    await renderDirectedDraft(draft.id, { revisionNotes: "make it darker" });
    expect(sent[0]!.prompt).toContain("make it darker");
  });

  it("marks the draft failed with the reason when the image model errors", async () => {
    const draft = await make();
    imageResult = { status: "failed", error: "rate limited" };
    const { renderDirectedDraft } = await import("@/lib/creatives/directed/render");
    const result = await renderDirectedDraft(draft.id);
    expect(result).toMatchObject({ imageStatus: "failed", imageError: "rate limited" });
    expect((await getCreativeDraftAsync(draft.id))!.image_status).toBe("failed");
  });

  it("is what generateImageForDraft uses for a directed draft", async () => {
    const draft = await make();
    const { generateImageForDraft } = await import("@/lib/creatives/generate-draft-image");
    await generateImageForDraft(draft.id, "Acme", null, "4:5");
    expect(sent[0]!.prompt).toContain("Create ONE image for a Meta");
    expect(sent[0]!.prompt).not.toMatch(/top agency/i);
  });
});
