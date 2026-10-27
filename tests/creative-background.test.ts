import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { getCreativeDraftAsync } from "@/lib/creatives/drafts";

const analyze = vi.fn();
const writeConcepts = vi.fn();
const renderImage = vi.fn();

vi.mock("@/lib/brand/analyze-url", () => ({ analyzeBrandFromUrl: (...a: unknown[]) => analyze(...a) }));
vi.mock("@/lib/creatives/concept-writer", () => ({ writeCreativeConcepts: (...a: unknown[]) => writeConcepts(...a) }));
vi.mock("@/lib/creatives/generate-draft-image", () => ({ generateImageForDraft: (...a: unknown[]) => renderImage(...a) }));

const analysis = {
  url: "https://example.com",
  title: "Example",
  brand_name: "Example",
  colors: ["#37ca37", "#188bf6"],
  logo_url: "https://example.com/logo.png",
  logo_description: null,
  imagery_notes: null,
  summary: "ok",
  source: "firecrawl_branding" as const,
};

function concepts(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `c${i}`,
    client_id: "x",
    service_id: null,
    concept: `Example — Idea ${i + 1}`,
    hook: "h",
    primary_text: `Primary ${i + 1}`,
    headline: `Headline ${i + 1}`,
    description: "d",
    cta: "Learn More",
    creative_direction: `Direction ${i + 1}`,
    audience: "a",
    competitor_gap_addressed: "g",
    reasoning: "r",
    created_at: new Date().toISOString(),
  }));
}

const base = () => ({
  clientId: getDemoStore().clients[0]!.id,
  conversationId: "conv_bg",
  brandUrl: "https://example.com",
  generateImages: true as const,
});

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test-key";
  resetConfigCache();
  analyze.mockReset();
  writeConcepts.mockReset();
  renderImage.mockReset();
  renderImage.mockImplementation(async (draftId: string) => ({
    draft: await getCreativeDraftAsync(draftId),
    displayUrl: "https://cdn/x.png",
    imageStatus: "succeeded",
    imageError: null,
  }));
});

describe("startCreativeGenerationBackground", () => {
  it("returns four placeholder cards immediately, before any slow work has run", async () => {
    const { startCreativeGenerationBackground } = await import("@/lib/creatives/service");
    analyze.mockResolvedValue(analysis);
    writeConcepts.mockResolvedValue(concepts(4));

    const started = await startCreativeGenerationBackground(base());

    expect(started.draftIds).toHaveLength(4);
    expect(analyze).not.toHaveBeenCalled();
    expect(writeConcepts).not.toHaveBeenCalled();
    const first = await getCreativeDraftAsync(started.draftIds[0]!);
    expect(first?.image_status).toBe("generating");
    expect(first?.headline).toMatch(/Reading your brand/i);
  });

  it("shows each stage on the cards, then fills in the real concepts and renders", async () => {
    const { startCreativeGenerationBackground } = await import("@/lib/creatives/service");
    let releaseWriter!: (v: unknown) => void;
    analyze.mockResolvedValue(analysis);
    writeConcepts.mockImplementation(() => new Promise((resolve) => { releaseWriter = resolve; }));

    const started = await startCreativeGenerationBackground(base());
    const running = started.run();

    await vi.waitFor(async () => {
      const d = await getCreativeDraftAsync(started.draftIds[0]!);
      expect(d?.headline).toMatch(/Writing/i);
    });
    const midway = await getCreativeDraftAsync(started.draftIds[0]!);
    expect(midway?.brand_colors).toEqual(["#37ca37", "#188bf6"]);

    releaseWriter(concepts(4));
    await running;

    const done = await getCreativeDraftAsync(started.draftIds[2]!);
    expect(done?.headline).toBe("Headline 3");
    expect(done?.primary_text).toBe("Primary 3");
    expect(done?.logo_url).toBe("https://example.com/logo.png");
    expect(renderImage).toHaveBeenCalledTimes(4);
  });

  it("marks every card failed with the reason, and tells the chat, when something throws", async () => {
    const { startCreativeGenerationBackground } = await import("@/lib/creatives/service");
    analyze.mockResolvedValue(analysis);
    writeConcepts.mockRejectedValue(new Error("model unavailable"));

    const started = await startCreativeGenerationBackground(base());
    await started.run();

    for (const id of started.draftIds) {
      const d = await getCreativeDraftAsync(id);
      expect(d?.image_status).toBe("failed");
      expect(d?.image_error).toContain("model unavailable");
    }
    const last = getDemoStore().messages.filter((m) => m.conversation_id === "conv_bg").at(-1);
    expect(last?.metadata?.workflowEvent).toBe("creative_failed");
  });

  it("says plainly in the chat when no logo was found on the site", async () => {
    const { startCreativeGenerationBackground } = await import("@/lib/creatives/service");
    analyze.mockResolvedValue({ ...analysis, logo_url: null });
    writeConcepts.mockResolvedValue(concepts(4));

    const started = await startCreativeGenerationBackground(base());
    await started.run();

    const texts = getDemoStore().messages.filter((m) => m.conversation_id === "conv_bg").map((m) => m.content);
    expect(texts.some((t) => /no logo/i.test(t))).toBe(true);
  });
});
