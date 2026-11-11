import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "@/lib/config";
import { BULK_ANGLES } from "@/lib/creatives/bulk/angles";

vi.mock("@/lib/creatives/service", () => ({
  loadScope: async () => ({
    client: { id: "c1", name: "Acme", brand_voice: null, brand_colors: ["#37ca37"], website_url: null, target_audience: null, value_proposition: "Better ads" },
    service: null,
    brief: null,
  }),
}));
vi.mock("@/lib/brand/analyze-url", () => ({ analyzeBrandFromUrl: async () => ({ brand_name: "Acme", colors: ["#37ca37"], logo_url: null, title: "Acme" }) }));
vi.mock("@/lib/creatives/page-text", () => ({ readPageText: async () => ({ at: 0, text: "", readable: false }), cleanPageText: (s: string) => s, clearPageCache: () => undefined }));
vi.mock("@/lib/creatives/uploaded-logo", () => ({ loadUploadedLogoDataUri: async () => null }));
vi.mock("@/lib/creatives/concept-writer", async (orig) => ({ ...(await orig<typeof import("@/lib/creatives/concept-writer")>()), pickModel: () => ({}) }));
const rendered: string[] = [];
vi.mock("@/lib/creatives/generate-draft-image", async () => {
  const { getCreativeDraftAsync, upsertCreativeDraftAsync } = await import("@/lib/creatives/drafts");
  return {
    generateImageForDraft: async (id: string) => {
      rendered.push(id);
      const d = (await getCreativeDraftAsync(id))!;
      await upsertCreativeDraftAsync({ ...d, id, image_status: "succeeded", image_url: "https://x/y.png" });
      return {};
    },
  };
});

vi.mock("ai", () => ({
  generateObject: async ({ prompt }: { prompt: string }) => {
    if (prompt.includes("Build the message map")) {
      return { object: { pains: ["p"], desires: ["d"], objections: ["o"], proof: ["x"], mechanism: "m", audience: "a" } };
    }
    if (prompt.includes("Write exactly 4 distinct bodies")) {
      return {
        object: {
          bodies: ["A", "B", "C", "D"].map((id) => ({ id, format: "proof", text: `body ${id}` })),
          ctas: [{ label: "Get a quote", cta: "GET_QUOTE" }],
        },
      };
    }
    if (prompt.includes("Write one visual idea")) {
      const ideaKeys = BULK_ANGLES.map((a) => a.key).filter((k) => prompt.includes(`key "${k}"`));
      return { object: { ideas: ideaKeys.map((k) => ({ angle_key: k, idea: `idea for ${k}` })) } };
    }
    // hooks: one per assigned angle named in the prompt
    const keys = BULK_ANGLES.map((a) => a.key).filter((k) => prompt.includes(`key "${k}"`));
    return {
      object: {
        hooks: keys.map((k, i) => ({
          angle_key: k,
          targets: `target ${k}`,
          post_headline: `Headline ${i}`,
          body_id: "ABCD"[i % 4],
          primary_text: `copy ${i} ${k}`,
          cta_index: 0,
          on_image_text: { headline: `qa${BULK_ANGLES.findIndex((a) => a.key === k)}x qa${BULK_ANGLES.findIndex((a) => a.key === k)}y qa${BULK_ANGLES.findIndex((a) => a.key === k)}z`, highlights: [`label ${k}`], cta_label: "Go" },
          style: `style ${i}`,
          creative_direction: `idea ${i}`,
        })),
      },
    };
  },
}));

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test";
  resetConfigCache();
  rendered.length = 0;
});

describe("a bulk run, start to finish", () => {
  it("creates 15 placeholders, writes 15 different-angle hooks, renders them all, and marks the run done", async () => {
    const { startBulkRun, planAndRender } = await import("@/lib/creatives/bulk/run");
    const { getRun } = await import("@/lib/creatives/bulk/runs");
    const { listCreativeDraftsAsync } = await import("@/lib/creatives/drafts");
    const { readRunMarker, readAspectMarker } = await import("@/lib/creatives/formats");

    const run = await startBulkRun({ clientId: "c1", landingPageUrl: "https://acme.test", format: "9:16" });
    expect(run.items).toHaveLength(15);

    await planAndRender(run.id);

    const done = (await getRun(run.id))!;
    expect(done.status).toBe("done");
    expect(done.bodies).toHaveLength(4);
    expect(new Set(done.items.map((i) => i.angle_key)).size).toBe(15);
    expect(rendered).toHaveLength(15);

    const drafts = (await listCreativeDraftsAsync("c1")).filter((d) => readRunMarker(d.creative_direction) === run.id);
    expect(drafts).toHaveLength(15);
    expect(drafts.every((d) => readAspectMarker(d.creative_direction) === "9:16")).toBe(true);
    expect(drafts.every((d) => d.image_status === "succeeded")).toBe(true);
    // Bodies are reused, not 15 fresh ones: the copy comes from the four.
    expect(new Set(done.items.map((i) => i.body_id)).size).toBeLessThanOrEqual(4);
    // Every image is in a different, assigned style.
    const styles = drafts.map((d) => d.creative_direction?.match(/STYLE: ([^.]+)./)?.[1]);
    expect(new Set(styles).size).toBe(15);
  });
});
