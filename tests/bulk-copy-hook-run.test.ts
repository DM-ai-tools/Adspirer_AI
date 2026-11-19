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
vi.mock("@/lib/security/auth", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@/lib/api/background", () => ({ runAfterResponse: () => undefined }));

// What each kind of model call is asked, and how the stand-in answers the copy-check calls.
const prompts = { bodies: [] as string[], hooks: [] as string[] };
const calls: string[] = [];
let checker: "repair" | "unrepairable" | "throw" = "repair";
const WORDS_LIMIT = 2; // every mocked hook has a 3-word primary text, so every one breaks this

vi.mock("ai", () => ({
  generateObject: async ({ prompt, system }: { prompt: string; system?: string }) => {
    if (system?.includes("turn an operator's instructions")) {
      calls.push("extract");
      if (checker === "throw") throw new Error("model down");
      return { object: { headline: null, primary_text: { unit: "words", max: WORDS_LIMIT }, description: null, checklist: [] } };
    }
    if (prompt.includes("REPAIR THESE ADS")) {
      calls.push("repair");
      if (checker === "throw") throw new Error("model down");
      const ids = [...prompt.matchAll(/^\[([a-z_0-9]+)\]$/gm)].map((m) => m[1]!);
      return {
        object: {
          ads: ids.map((id) =>
            checker === "unrepairable" && id === ids[0]
              ? { id, headline: "keep", primary_text: "two words", description: null, could_not: [{ rule: "include a price", reason: "no price in the facts" }] }
              : { id, headline: `Fixed ${id}`, primary_text: "Repaired copy.", description: null, could_not: [] },
          ),
        },
      };
    }
    if (prompt.includes("JUDGE THESE ADS")) {
      calls.push("judge");
      return { object: { results: [] } };
    }
    if (prompt.includes("Build the message map")) return { object: { pains: ["p"], desires: ["d"], objections: ["o"], proof: ["x"], mechanism: "m", audience: "a" } };
    if (prompt.includes("Write exactly 4 distinct bodies")) {
      prompts.bodies.push(prompt);
      return { object: { bodies: ["A", "B", "C", "D"].map((id) => ({ id, format: "proof", text: `body ${id}` })), ctas: [{ label: "Get a quote", cta: "GET_QUOTE" }] } };
    }
    if (prompt.includes("Write one visual idea")) {
      const ideaKeys = BULK_ANGLES.map((a) => a.key).filter((k) => prompt.includes(`key "${k}"`));
      return { object: { ideas: ideaKeys.map((k) => ({ angle_key: k, idea: `idea for ${k}` })) } };
    }
    prompts.hooks.push(prompt);
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
  prompts.bodies.length = 0;
  prompts.hooks.length = 0;
  calls.length = 0;
  checker = "repair";
});

const INSTRUCTIONS = "Primary text under 2 words. Mention the free audit. End with a question.";

async function runIt(instructions?: string) {
  const { startBulkRun, planAndRender } = await import("@/lib/creatives/bulk/run");
  const { getRun } = await import("@/lib/creatives/bulk/runs");
  const { listCreativeDraftsAsync } = await import("@/lib/creatives/drafts");
  const { readRunMarker } = await import("@/lib/creatives/formats");
  const run = await startBulkRun({ clientId: "c1", landingPageUrl: "https://acme.test", format: "4:5", copyInstructions: instructions });
  await planAndRender(run.id);
  const done = (await getRun(run.id))!;
  const drafts = (await listCreativeDraftsAsync("c1")).filter((d) => readRunMarker(d.creative_direction) === run.id);
  return { run: done, drafts };
}

describe("a hook run with ad copy instructions", () => {
  it("puts the instructions into the bodies prompt and every hook prompt as rules that override the built-in lengths", async () => {
    await runIt(INSTRUCTIONS);
    expect(prompts.bodies).toHaveLength(1);
    expect(prompts.hooks.length).toBeGreaterThan(0);
    for (const p of [...prompts.bodies, ...prompts.hooks]) {
      expect(p).toContain("AD COPY RULES");
      expect(p).toContain(INSTRUCTIONS);
      expect(p).toMatch(/override/i);
    }
  });

  it("checks every ad and stores the repaired copy on the drafts", async () => {
    const { drafts, run } = await runIt(INSTRUCTIONS);
    expect(drafts).toHaveLength(15);
    expect(drafts.every((d) => d.primary_text === "Repaired copy.")).toBe(true);
    expect(drafts.every((d) => d.headline.startsWith("Fixed "))).toBe(true);
    expect(run.items.every((i) => !i.copy_note)).toBe(true);
    expect(calls.filter((c) => c === "repair")).toHaveLength(1);
    expect(run.inputs.copyRules?.primary_text).toEqual({ unit: "words", max: WORDS_LIMIT });
    expect(run.inputs.copyStatus).toBe("ready");
    expect(run.inputs.copyRepaired).toBe(15);
  });

  it("notes, on that ad only, a rule it could not follow without inventing a fact", async () => {
    checker = "unrepairable";
    const { run } = await runIt(INSTRUCTIONS);
    const noted = run.items.filter((i) => i.copy_note);
    expect(noted).toHaveLength(1);
    expect(noted[0]!.copy_note).toBe("Could not follow: include a price, because no price in the facts.");
    expect(run.inputs.copyFlagged).toBe(1);
  });

  it("still completes with the copy as written when the checker's model is down", async () => {
    checker = "throw";
    const { run, drafts } = await runIt(INSTRUCTIONS);
    expect(run.status).toBe("done");
    expect(drafts.every((d) => /^copy \d+ /.test(d.primary_text))).toBe(true);
  });

  it("shows each ad's note on its card and the run's copy summary", async () => {
    checker = "unrepairable";
    const { run } = await runIt(INSTRUCTIONS);
    const { loadRunView } = await import("@/lib/creatives/bulk/view");
    const view = await loadRunView(run);
    expect(view.cards.filter((c) => c.copyNote)).toHaveLength(1);
    expect(view.copy).toMatchObject({ status: "ready", repaired: 15, flagged: 1, message: null });
  });
});

describe("a hook run without ad copy instructions", () => {
  it("behaves exactly as before: no rules in the prompts and no copy-check calls", async () => {
    const { drafts, run } = await runIt();
    expect([...prompts.bodies, ...prompts.hooks].some((p) => p.includes("AD COPY RULES"))).toBe(false);
    expect(calls).toEqual([]);
    expect(drafts.every((d) => /^copy \d+ /.test(d.primary_text))).toBe(true);
    expect(run.inputs.copyStatus).toBeUndefined();
    const { loadRunView } = await import("@/lib/creatives/bulk/view");
    expect((await loadRunView(run)).copy).toBeNull();
  });
});

describe("POST /api/creatives/bulk", () => {
  it("rejects instructions over 2,000 characters and accepts 2,000", async () => {
    const { getDemoStore } = await import("@/lib/demo/store");
    const { getCurrentUser } = await import("@/lib/security/auth");
    const p = getDemoStore().profiles.find((x) => x.role === "admin")!;
    vi.mocked(getCurrentUser).mockResolvedValue({ id: p.id, email: p.email, profile: p } as never);
    const { POST } = await import("@/app/api/creatives/bulk/route");
    const post = (body: unknown) => POST(new Request("https://app.example.com/api/creatives/bulk", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
    const clientId = getDemoStore().clients[0]!.id;
    expect((await post({ clientId, landingPageUrl: "https://acme.test", copyInstructions: "x".repeat(2001) })).status).toBeGreaterThanOrEqual(400);
    expect((await post({ clientId, landingPageUrl: "https://acme.test", copyInstructions: "x".repeat(2000) })).status).toBe(200);
  });
});
