import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "@/lib/config";
import { upsertCreativeDraftAsync } from "@/lib/creatives/drafts";
import { readAspectMarker } from "@/lib/creatives/formats";
import { readDirectedMarker, withDirectedMarker, type PrintLine } from "@/lib/creatives/directed/markers";
import { buildDirectedImagePrompt } from "@/lib/creatives/directed/prompt";
import { createDirectedVariations, VARIATION_TWEAKS } from "@/lib/creatives/directed/variations";
import { withAspectMarker } from "@/lib/creatives/formats";

vi.mock("@/lib/creatives/cloudinary", () => ({ isCloudinaryConfigured: () => false, uploadCreativeImage: async () => ({ url: "", mime: "image/png" }) }));

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test";
  resetConfigCache();
});

const print: PrintLine[] = [
  { role: "headline", text: "The account nobody checked twice." },
  { role: "button", text: "Get your audit" },
];

async function source(direction?: string) {
  return upsertCreativeDraftAsync({
    client_id: "c1",
    service_id: null,
    conversation_id: "conv1",
    task_id: "task1",
    brief_id: null,
    concept: "Acme — Your direction 1",
    headline: "The account nobody checked twice.",
    primary_text: "Get your audit",
    description: null,
    cta: null,
    creative_direction: direction ?? withAspectMarker(withDirectedMarker("", { picture: "A cold aisle at 3am", print, noLogo: true }), "9:16"),
    image_url: "https://x/y.png",
    image_b64: null,
    image_mime: "image/png",
    image_model: null,
    image_prompt: null,
    image_status: "succeeded",
    image_error: null,
    landing_page_url: "https://acme.test",
    brand_colors: ["#111111"],
    logo_url: "https://acme.test/logo.png",
    revision_notes: null,
    status: "ready",
  });
}

describe("four variations of a directed image", () => {
  it("makes exactly four new drafts in the same chat, shape and brand", async () => {
    const src = await source();
    const { drafts } = await createDirectedVariations({ draftId: src.id });
    expect(drafts).toHaveLength(4);
    for (const d of drafts) {
      expect(d).toMatchObject({ conversation_id: "conv1", task_id: "task1", image_status: "generating", logo_url: "https://acme.test/logo.png", landing_page_url: "https://acme.test", brand_colors: ["#111111"] });
      expect(readAspectMarker(d.creative_direction)).toBe("9:16");
    }
    expect(drafts.map((d) => d.concept)).toEqual([1, 2, 3, 4].map((n) => `Acme — Your direction 1 · Variation ${n}`));
  });

  it("keeps the picture instruction, the printed words and the no-logo choice exactly", async () => {
    const src = await source();
    const { drafts } = await createDirectedVariations({ draftId: src.id });
    for (const d of drafts) {
      const meta = readDirectedMarker(d.creative_direction)!;
      expect(meta.picture).toBe("A cold aisle at 3am");
      expect(meta.print).toEqual(print);
      expect(meta.noLogo).toBe(true);
      expect(d.headline).toBe("The account nobody checked twice.");
    }
  });

  it("gives each variation a different layout tweak, and the prompt carries it", async () => {
    expect(new Set(VARIATION_TWEAKS).size).toBe(4);
    const src = await source();
    const { drafts } = await createDirectedVariations({ draftId: src.id });
    const tweaks = drafts.map((d) => readDirectedMarker(d.creative_direction)!.tweak);
    expect(tweaks).toEqual([...VARIATION_TWEAKS]);
    const prompt = buildDirectedImagePrompt({ picture: "x", print, format: "9:16", hasLogo: false, tweak: tweaks[0] });
    expect(prompt).toContain(`VARIATION: keep everything the same except: ${VARIATION_TWEAKS[0]}`);
  });

  it("does not carry the source's edit history into the variations", async () => {
    const src = await source(withDirectedMarker("", { picture: "A", print, versions: ["k1", "k2"], printBefore: [print, print] }));
    const { drafts } = await createDirectedVariations({ draftId: src.id });
    for (const d of drafts) {
      const meta = readDirectedMarker(d.creative_direction)!;
      expect(meta.versions).toBeUndefined();
      expect(meta.printBefore).toBeUndefined();
    }
  });

  it("carries the edits already made to the source, so a variation is of the image as it is now", async () => {
    const src = await source(withDirectedMarker("", { picture: "A", print, edits: ["make the door red", "add morning light"], versions: ["k1"], printBefore: [print] }));
    const { drafts } = await createDirectedVariations({ draftId: src.id });
    for (const d of drafts) expect(readDirectedMarker(d.creative_direction)!.edits).toEqual(["make the door red", "add morning light"]);
  });

  it("refuses a draft that was not made from a direction", async () => {
    const src = await source("STYLE: a poster.");
    await expect(createDirectedVariations({ draftId: src.id })).rejects.toThrow(/direction/i);
  });

  it("refuses a draft that does not exist", async () => {
    await expect(createDirectedVariations({ draftId: "nope" })).rejects.toThrow(/not found/i);
  });
});
