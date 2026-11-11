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
vi.mock("@/lib/creatives/uploaded-logo", () => ({ loadUploadedLogoDataUri: async () => null }));
vi.mock("@/lib/creatives/concept-writer", async (orig) => ({ ...(await orig<typeof import("@/lib/creatives/concept-writer")>()), pickModel: () => ({}) }));
vi.mock("@/lib/creatives/generate-draft-image", async () => {
  const { getCreativeDraftAsync, upsertCreativeDraftAsync } = await import("@/lib/creatives/drafts");
  return {
    generateImageForDraft: async (id: string) => {
      const d = (await getCreativeDraftAsync(id))!;
      await upsertCreativeDraftAsync({ ...d, id, image_status: "succeeded", image_url: "https://x/y.png" });
      return {};
    },
  };
});

const PAGE = "Trusted by 1,500+ Australian Businesses\n$120M+ in Ad Spend Managed\n$26.5M Sales Revenue from $5.33M ad spend in 12 months\nA free 30-minute audit of your Google Ads account that shows where budget leaks.";
const page: { readable: boolean; error: Error | null } = { readable: true, error: null };
vi.mock("@/lib/creatives/page-text", () => ({
  readPageText: async () => {
    if (page.error) throw page.error;
    return { at: 0, text: PAGE, readable: page.readable };
  },
  cleanPageText: (s: string) => s,
  clearPageCache: () => undefined,
}));

let extracted: Array<Record<string, unknown>> = [];
vi.mock("ai", () => ({
  generateObject: async ({ prompt }: { prompt: string }) => {
    if (prompt.includes("List the client results and stats")) return { object: { results: extracted } };
    if (prompt.includes("Build the message map")) return { object: { pains: ["p"], desires: ["d"], objections: ["o"], proof: ["x"], mechanism: "m", audience: "a" } };
    if (prompt.includes("Write exactly 4 distinct bodies")) {
      return { object: { bodies: ["A", "B", "C", "D"].map((id) => ({ id, format: "proof", text: `body ${id}` })), ctas: [{ label: "Get a quote", cta: "GET_QUOTE" }] } };
    }
    const keys = [...prompt.matchAll(/key "([a-z_0-9]+)"/g)].map((m) => m[1]!);
    const n = (k: string) => BULK_ANGLES.findIndex((a) => a.key === k) + 100 + k.length;
    if (prompt.includes("Write one visual idea")) return { object: { ideas: keys.map((k) => ({ angle_key: k, idea: `idea for ${k}` })) } };
    return {
      object: {
        hooks: keys.map((k) => ({
          angle_key: k, targets: `target ${k}`, post_headline: `Headline ${k}`, body_id: "A", primary_text: `copy ${k}`, cta_index: 0,
          on_image_text: { headline: `q${n(k)}x q${n(k)}y q${n(k)}z`, highlights: [`label ${k}`], cta_label: "Go" },
          style: "s", creative_direction: `idea ${k}`,
        })),
      },
    };
  },
}));

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test";
  resetConfigCache();
  page.readable = true;
  page.error = null;
  extracted = [
    { kind: "case_result", industry: "e-commerce", client: null, stat: "$26.5M Sales Revenue", detail: "from $5.33M ad spend in 12 months" },
    { kind: "company_stat", industry: "Australian businesses", client: null, stat: "1,500+ Australian Businesses", detail: "" },
    { kind: "company_stat", industry: "", client: null, stat: "$120M+ Ad Spend Managed", detail: "" },
  ];
});

async function runIt() {
  const { startBulkRun, planAndRender } = await import("@/lib/creatives/bulk/run");
  const { getRun } = await import("@/lib/creatives/bulk/runs");
  const run = await startBulkRun({ clientId: "c1", landingPageUrl: "https://acme.test", format: "4:5" });
  await planAndRender(run.id);
  return (await getRun(run.id))!;
}

describe("a bulk run whose landing page has client results", () => {
  it("makes 15 images, three of them reserved for the results on the page", async () => {
    const done = await runIt();
    expect(done.status).toBe("done");
    expect(done.items).toHaveLength(15);
    const results = done.items.filter((i) => i.angle_key?.startsWith("client_result_"));
    expect(results).toHaveLength(3);
    expect(results.map((i) => i.angle_name)).toContain("Client result: $26.5M Sales Revenue");
    expect(done.items.filter((i) => !i.angle_key?.startsWith("client_result_"))).toHaveLength(12);
    expect(new Set(done.items.map((i) => i.angle_key)).size).toBe(15);
  });

  it("skips the results images when the page has no results", async () => {
    extracted = [];
    const done = await runIt();
    expect(done.status).toBe("done");
    expect(done.items.some((i) => i.angle_key?.startsWith("client_result_"))).toBe(false);
    expect(done.items).toHaveLength(15);
  });

  it("skips them when a figure the model reports is not actually on the page", async () => {
    extracted = [{ kind: "case_result", industry: "retail", client: null, stat: "$99M Sales Revenue", detail: "" }];
    const done = await runIt();
    expect(done.items.some((i) => i.angle_key?.startsWith("client_result_"))).toBe(false);
  });

  it("carries on with the usual 15 when the page cannot be read", async () => {
    page.error = new Error("timed out");
    expect((await runIt()).items.filter((i) => i.angle_key?.startsWith("client_result_"))).toHaveLength(0);
    page.error = null;
    page.readable = false;
    const done = await runIt();
    expect(done.status).toBe("done");
    expect(done.items).toHaveLength(15);
  });
});
