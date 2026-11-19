import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDemoStore } from "@/lib/demo/store";
import { resetConfigCache } from "@/lib/config";
import { getCreativeDraftAsync } from "@/lib/creatives/drafts";
import { readDirectedMarker, type Direction } from "@/lib/creatives/directed/markers";
import { createRun, getRun, updateRun } from "@/lib/creatives/bulk/runs";

vi.mock("@/lib/creatives/service", () => ({
  loadScope: async () => ({
    client: { id: "c1", name: "Acme", brand_voice: null, brand_colors: ["#37ca37"], website_url: null, target_audience: null, value_proposition: "Better ads" },
    service: null,
    brief: null,
  }),
}));
vi.mock("@/lib/brand/analyze-url", () => ({ analyzeBrandFromUrl: async () => ({ brand_name: "Acme Co", colors: ["#ff0000"], logo_url: "https://acme.test/logo.png", page_excerpt: "Acme runs free 30-minute ad audits." }) }));
vi.mock("@/lib/creatives/page-text", () => ({ readPageText: async () => ({ at: 0, text: "", readable: false }), cleanPageText: (s: string) => s, clearPageCache: () => undefined }));
vi.mock("@/lib/creatives/uploaded-logo", () => ({ loadUploadedLogoDataUri: async () => null }));
vi.mock("@/lib/creatives/cloudinary", () => ({ isCloudinaryConfigured: () => false, uploadCreativeImage: async () => ({ url: "", mime: "image/png" }) }));
vi.mock("@/lib/creatives/concept-writer", async (orig) => ({ ...(await orig<typeof import("@/lib/creatives/concept-writer")>()), pickModel: () => ({}) }));
const imagesMade: string[] = [];
vi.mock("@/lib/creatives/openai-image", async (orig) => ({
  ...(await orig<typeof import("@/lib/creatives/openai-image")>()),
  generateOpenAIImage: async (i: { prompt: string }) => {
    imagesMade.push(i.prompt);
    return { imageUrl: null, b64: "aGk=", mime: "image/png", model: "m", prompt: i.prompt, status: "succeeded" as const, error: null };
  },
}));
vi.mock("@/lib/security/auth", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@/lib/approvals/service", () => ({ createPendingApproval: vi.fn() }));
vi.mock("@/lib/adspirer/client", () => ({ resolveProvider: async () => ({ listAdSets: async () => [] }) }));
vi.mock("@/lib/meta/resolve-page", () => ({ listFacebookPagesForAccountId: async () => [] }));

const writerPrompts: string[] = [];
let writer: "ok" | "throw" = "ok";
vi.mock("ai", () => ({
  generateObject: async ({ prompt, system }: { prompt: string; system?: string }) => {
    if (system?.includes("turn an operator's instructions")) return { object: { headline: null, primary_text: { unit: "words", max: 8 }, description: null, checklist: [] } };
    if (prompt.includes("JUDGE THESE ADS")) return { object: { results: [] } };
    if (prompt.includes("WRITE THE AD COPY")) {
      writerPrompts.push(prompt);
      if (writer === "throw") throw new Error("model overloaded");
      const indexes = [...prompt.matchAll(/^Image (\d+):/gm)].map((m) => Number(m[1]));
      return { object: { ads: indexes.map((index) => ({ index, headline: `Written ${index}`, primary_text: "Short written copy.", description: null })) } };
    }
    throw new Error("unexpected model call: " + prompt.slice(0, 80));
  },
}));

import { writeDirectedCopy } from "@/lib/creatives/bulk/copy/write-directed";
import { planAndRenderDirected, startDirectedBulkRun } from "@/lib/creatives/bulk/directed-run";
import { copySummary } from "@/lib/creatives/bulk/view";

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test";
  resetConfigCache();
  imagesMade.length = 0;
  writerPrompts.length = 0;
  writer = "ok";
});

const dirs = (n: number): Direction[] => Array.from({ length: n }, (_, i) => ({ picture: `Picture ${i + 1}`, print: [{ role: "headline", text: `Printed ${i + 1}` }, { role: "button", text: "Book now" }] }));
const INSTRUCTIONS = "Primary text under 8 words. Mention the free audit. End with a question.";

describe("writing the copy for each direction", () => {
  const answer = (indexes: number[]) => ({ ads: indexes.map((index) => ({ index, headline: `Written ${index}`, primary_text: `Body ${index}`, description: null })) });

  it("works in batches of ten, in file order, one result per direction", async () => {
    const seen: number[][] = [];
    const generate = (async ({ prompt }: { prompt: string }) => {
      const indexes = [...prompt.matchAll(/^Image (\d+):/gm)].map((m) => Number(m[1]));
      seen.push(indexes);
      return { object: answer(indexes) };
    }) as never;
    const out = await writeDirectedCopy({ directions: dirs(25), instructions: INSTRUCTIONS, facts: "" }, { generate });
    expect(seen.map((s) => s.length)).toEqual([10, 10, 5]);
    expect(out).toHaveLength(25);
    expect(out.map((o) => o.headline)).toEqual(Array.from({ length: 25 }, (_, i) => `Written ${i + 1}`));
  });

  it("falls back to the printed words for a direction the model left out or returned blank", async () => {
    const generate = (async () => ({ object: { ads: [{ index: 1, headline: "Written 1", primary_text: "Body 1", description: null }, { index: 3, headline: "  ", primary_text: "", description: null }] } })) as never;
    const out = await writeDirectedCopy({ directions: dirs(3), instructions: INSTRUCTIONS, facts: "" }, { generate });
    expect(out[0]).toEqual({ headline: "Written 1", primary_text: "Body 1", description: null });
    expect(out[1]).toEqual({ headline: "Printed 2", primary_text: "Book now", description: null });
    expect(out[2]).toEqual({ headline: "Printed 3", primary_text: "Book now", description: null });
  });

  it("shows the model each image's picture and printed words, the instructions, the facts and a seed, and forbids rewording", async () => {
    let prompt = "";
    const generate = (async (i: { prompt: string }) => {
      prompt = i.prompt;
      return { object: answer([1, 2]) };
    }) as never;
    await writeDirectedCopy({ directions: dirs(2), instructions: INSTRUCTIONS, facts: "Acme runs free audits.", pastedCopy: "Our ads that work: stop wasting spend." }, { generate });
    expect(prompt).toContain("WRITE THE AD COPY");
    expect(prompt).toContain(INSTRUCTIONS);
    expect(prompt).toContain("Picture 2");
    expect(prompt).toContain('"Printed 2"');
    expect(prompt).toContain("Acme runs free audits.");
    expect(prompt).toContain("Our ads that work: stop wasting spend.");
    expect(prompt).toMatch(/never reword[^\n]*printed/i);
    expect(prompt).toMatch(/never invent a fact/i);
  });
});

describe("a directions run with ad copy instructions", () => {
  const start = (n: number, extra: Record<string, unknown> = {}) =>
    startDirectedBulkRun({ clientId: "c1", directions: dirs(n), format: "4:5", landingPageUrl: "https://acme.test/offer", copyInstructions: INSTRUCTIONS, ...extra });

  it("starts with the printed words as the copy and the copy marked as being written", async () => {
    const run = await start(3);
    expect(run.inputs.copyStatus).toBe("writing");
    expect(typeof run.inputs.copyStartedAt).toBe("string");
    expect(run.inputs.copyInstructions).toBe(INSTRUCTIONS);
    const drafts = await Promise.all(run.items.map((i) => getCreativeDraftAsync(i.draft_id)));
    expect(drafts.map((d) => d!.headline)).toEqual(["Printed 1", "Printed 2", "Printed 3"]);
  });

  it("writes the copy while the images render: every ad gets its written copy, the printed words stay on the images, status ends ready", async () => {
    const run = await start(3);
    await planAndRenderDirected(run.id);
    const done = (await getRun(run.id))!;
    expect(done.status).toBe("done");
    expect(done.inputs.copyStatus).toBe("ready");
    expect(done.inputs.copyRules?.primary_text).toEqual({ unit: "words", max: 8 });
    expect(imagesMade).toHaveLength(3);
    const drafts = await Promise.all(done.items.map((i) => getCreativeDraftAsync(i.draft_id)));
    expect(drafts.map((d) => d!.headline)).toEqual(["Written 1", "Written 2", "Written 3"]);
    expect(drafts.every((d) => d!.primary_text === "Short written copy.")).toBe(true);
    // the words printed on the image are exactly what was asked for
    expect(readDirectedMarker(drafts[1]!.creative_direction)!.print).toEqual(dirs(3)[1]!.print);
    expect(imagesMade.some((p) => p.includes('"Printed 2"'))).toBe(true);
  });

  it("uses pasted copy as a seed for the writer, not as the primary text of every ad", async () => {
    const run = await start(2, { pastedCopy: "Seed copy from the operator" });
    await planAndRenderDirected(run.id);
    expect(writerPrompts[0]).toContain("Seed copy from the operator");
    const drafts = await Promise.all((await getRun(run.id))!.items.map((i) => getCreativeDraftAsync(i.draft_id)));
    expect(drafts.every((d) => d!.primary_text === "Short written copy.")).toBe(true);
  });

  it("keeps the printed-words copy and says so when the writer fails, and the images still finish", async () => {
    writer = "throw";
    const run = await start(2);
    await planAndRenderDirected(run.id);
    const done = (await getRun(run.id))!;
    expect(done.status).toBe("done");
    expect(done.inputs.copyStatus).toBe("failed");
    expect(done.inputs.copyMessage).toMatch(/could not be written/i);
    const drafts = await Promise.all(done.items.map((i) => getCreativeDraftAsync(i.draft_id)));
    expect(drafts.map((d) => d!.headline)).toEqual(["Printed 1", "Printed 2"]);
    expect(imagesMade).toHaveLength(2);
  });

  it("leaves copy the operator already edited by hand alone", async () => {
    const run = await start(2);
    const items = run.items.map((it, i) => (i === 0 ? { ...it, copy_edited: true } : it));
    await updateRun(run.id, { items });
    const edited = (await getCreativeDraftAsync(run.items[0]!.draft_id))!;
    const { upsertCreativeDraftAsync } = await import("@/lib/creatives/drafts");
    await upsertCreativeDraftAsync({ ...edited, id: edited.id, headline: "My own headline" });
    await planAndRenderDirected(run.id);
    const drafts = await Promise.all((await getRun(run.id))!.items.map((i) => getCreativeDraftAsync(i.draft_id)));
    expect(drafts[0]!.headline).toBe("My own headline");
    expect(drafts[1]!.headline).toBe("Written 2");
  });
});

describe("a directions run without ad copy instructions", () => {
  it("behaves as before: no copy is written and there is no copy status", async () => {
    const run = await startDirectedBulkRun({ clientId: "c1", directions: dirs(2), format: "4:5", landingPageUrl: "https://acme.test/offer", pastedCopy: "Pasted body" });
    expect(run.inputs.copyStatus).toBeUndefined();
    await planAndRenderDirected(run.id);
    expect(writerPrompts).toEqual([]);
    const drafts = await Promise.all((await getRun(run.id))!.items.map((i) => getCreativeDraftAsync(i.draft_id)));
    expect(drafts.every((d) => d!.primary_text === "Pasted body")).toBe(true);
    expect(copySummary((await getRun(run.id))!)).toBeNull();
  });
});

describe("a copy job that never finishes", () => {
  const runWriting = async (startedMsAgo: number) => {
    const run = await createRun({ clientId: "c1", inputs: { copyStatus: "writing", copyStartedAt: new Date(Date.now() - startedMsAgo).toISOString() }, format: "4:5" });
    return run;
  };

  it("is shown as writing while recent, and as failed with the printed words kept once it is over ten minutes old", async () => {
    expect(copySummary(await runWriting(60_000))).toMatchObject({ status: "writing" });
    const stalled = copySummary(await runWriting(11 * 60_000))!;
    expect(stalled.status).toBe("failed");
    expect(stalled.message).toMatch(/printed on its image/i);
  });
});

describe("Meta publishing while the copy is being written", () => {
  it("is refused for the whole run, then allowed again once the copy is ready or has stalled", async () => {
    const { getCurrentUser } = await import("@/lib/security/auth");
    const p = getDemoStore().profiles.find((x) => x.role === "admin")!;
    vi.mocked(getCurrentUser).mockResolvedValue({ id: p.id, email: p.email, profile: p } as never);
    const { GET } = await import("@/app/api/creatives/bulk/[runId]/publish/route");
    const clientId = getDemoStore().clients[0]!.id;
    const get = async (run: { id: string }) => GET(new Request("https://app.example.com/x"), { params: Promise.resolve({ runId: run.id }) });
    const fresh = await createRun({ clientId, inputs: { copyStatus: "writing", copyStartedAt: new Date().toISOString() }, format: "4:5" });
    const refused = await get(fresh);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(await refused.json())).toMatch(/ad copy is still being written/i);
    for (const inputs of [{ copyStatus: "writing" as const, copyStartedAt: new Date(Date.now() - 11 * 60_000).toISOString() }, { copyStatus: "ready" as const }]) {
      const ok = await createRun({ clientId, inputs, format: "4:5" });
      const res = await get(ok);
      expect(JSON.stringify(await res.clone().json())).not.toMatch(/ad copy is still being written/i);
    }
  });
});
