import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDemoStore } from "@/lib/demo/store";
import { resetConfigCache } from "@/lib/config";

vi.mock("@/lib/security/auth", () => ({ getCurrentUser: vi.fn() }));
import { getCurrentUser } from "@/lib/security/auth";
vi.mock("@/lib/creatives/cloudinary", () => ({ isCloudinaryConfigured: () => false, uploadCreativeImage: async () => ({ url: "", mime: "image/png" }) }));
const stored = new Map<string, Buffer>();
vi.mock("@/lib/storage/r2", () => ({
  getObjectStorage: () => ({
    put: async (key: string, data: Buffer) => void stored.set(key, Buffer.from(data)),
    get: async (key: string) => stored.get(key) ?? null,
    delete: async (key: string) => void stored.delete(key),
  }),
}));

const realignCalls: Array<Record<string, unknown>> = [];
let realignResult: { headline: string; primary_text: string; description: string | null; onImage: null; changed: boolean; note: string } | null = null;
vi.mock("@/lib/creatives/realign-copy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/creatives/realign-copy")>()),
  realignCopy: async (i: Record<string, unknown> & { copy: { headline: string; primary_text: string; description: string | null }; lockCopy?: boolean }) => {
    realignCalls.push(i);
    if (i.lockCopy) return { ...i.copy, onImage: null, changed: false, note: "" };
    return realignResult ?? { ...i.copy, onImage: null, changed: false, note: "" };
  },
}));

import { upsertCreativeDraftAsync, getCreativeDraftAsync } from "@/lib/creatives/drafts";
import { createRun, getRun, updateRun } from "@/lib/creatives/bulk/runs";
import { saveAdCopy } from "@/lib/creatives/bulk/copy/edit-copy";
import { matchCopyToImage, undoLastEdit } from "@/lib/creatives/edit-image";
import { buildRealignPrompt } from "@/lib/creatives/realign-copy";
import { withRunMarker } from "@/lib/creatives/formats";
import sharp from "sharp";

const png = () => sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 10, b: 10 } } }).png().toBuffer();

const clientId = () => getDemoStore().clients[0]!.id;

async function makeRun(inputs: Record<string, unknown> = {}, statuses: Array<"succeeded" | "generating"> = ["succeeded", "succeeded"]) {
  const run = await createRun({ clientId: clientId(), inputs, format: "4:5" } as never);
  const items = [];
  for (const [i, status] of statuses.entries()) {
    const d = await upsertCreativeDraftAsync({
      client_id: clientId(), service_id: null, conversation_id: null, task_id: null, brief_id: null, concept: `Acme — Hook ${i + 1}`, headline: `Headline ${i + 1}`, primary_text: `Body ${i + 1}`, description: `Desc ${i + 1}`, cta: null,
      creative_direction: withRunMarker("STYLE: poster.", run.id), image_url: "https://x/y.png", image_b64: null, image_mime: "image/png", image_model: null, image_prompt: null, image_status: status, image_error: null,
      landing_page_url: null, brand_colors: null, logo_url: null, revision_notes: null, status: "ready",
    });
    items.push({ draft_id: d.id, angle_key: `a${i}`, angle_name: `Angle ${i + 1}`, stage: null, kind: null, targets: null, body_id: "A", cta_label: null, copy_note: i === 0 ? "Did not fully follow your instructions: x" : null });
  }
  await updateRun(run.id, { items });
  return { run: (await getRun(run.id))!, drafts: await Promise.all(items.map((it) => getCreativeDraftAsync(it.draft_id))) };
}

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test";
  resetConfigCache();
  realignCalls.length = 0;
  realignResult = null;
  stored.clear();
  const p = getDemoStore().profiles.find((x) => x.role === "admin")!;
  vi.mocked(getCurrentUser).mockResolvedValue({ id: p.id, email: p.email, profile: p });
});

describe("saving one ad's copy", () => {
  it("changes only the named fields of that ad, leaves every other ad untouched, marks it hand-edited and clears its note", async () => {
    const { run, drafts } = await makeRun();
    const saved = await saveAdCopy({ runId: run.id, draftId: drafts[0]!.id, headline: "My headline", primary_text: "My body" });
    expect(saved).toMatchObject({ headline: "My headline", primary_text: "My body", description: "Desc 1" });
    const other = (await getCreativeDraftAsync(drafts[1]!.id))!;
    expect(other).toMatchObject({ headline: "Headline 2", primary_text: "Body 2", description: "Desc 2" });
    const after = (await getRun(run.id))!;
    expect(after.items[0]).toMatchObject({ copy_edited: true, copy_note: null });
    expect(after.items[1]!.copy_edited).toBeUndefined();
  });

  it("can clear the description, and only the description", async () => {
    const { run, drafts } = await makeRun();
    const saved = await saveAdCopy({ runId: run.id, draftId: drafts[0]!.id, description: "  " });
    expect(saved).toMatchObject({ description: null, headline: "Headline 1", primary_text: "Body 1" });
  });

  it("refuses text over the publish limits, naming the field", async () => {
    const { run, drafts } = await makeRun();
    await expect(saveAdCopy({ runId: run.id, draftId: drafts[0]!.id, headline: "h".repeat(256) })).rejects.toThrow(/Headline.*255/);
    await expect(saveAdCopy({ runId: run.id, draftId: drafts[0]!.id, primary_text: "p".repeat(2201) })).rejects.toThrow(/Primary text.*2200/);
    await expect(saveAdCopy({ runId: run.id, draftId: drafts[0]!.id, description: "d".repeat(256) })).rejects.toThrow(/Description.*255/);
    expect((await getCreativeDraftAsync(drafts[0]!.id))!.headline).toBe("Headline 1");
  });

  it("accepts text exactly at the limits", async () => {
    const { run, drafts } = await makeRun();
    const saved = await saveAdCopy({ runId: run.id, draftId: drafts[0]!.id, headline: "h".repeat(255), primary_text: "p".repeat(2200), description: "d".repeat(255) });
    expect(saved.headline).toHaveLength(255);
  });

  it("is refused while that ad's image is still being made, for an ad outside the run, and with nothing to save", async () => {
    const { run, drafts } = await makeRun({}, ["succeeded", "generating"]);
    await expect(saveAdCopy({ runId: run.id, draftId: drafts[1]!.id, headline: "x" })).rejects.toThrow(/still being made/i);
    await expect(saveAdCopy({ runId: run.id, draftId: "nope", headline: "x" })).rejects.toThrow(/not part of this run/i);
    await expect(saveAdCopy({ runId: run.id, draftId: drafts[0]!.id })).rejects.toThrow(/nothing to save/i);
  });
});

describe("undoing an image edit", () => {
  const withVersion = async (copyEdited: boolean) => {
    const { run, drafts } = await makeRun();
    stored.set("versions/earlier.png", await png());
    const items = run.items.map((it, i) =>
      i === 0 ? { ...it, copy_edited: copyEdited, versions: [{ id: "v1", key: "versions/earlier.png", at: new Date().toISOString(), instruction: "make it blue", mode: "edit" as const, copy: { headline: "Old headline", primary_text: "Old body", description: null } }] } : it,
    );
    await updateRun(run.id, { items });
    return { run, drafts };
  };

  it("does not put the old copy back over copy the operator edited by hand", async () => {
    const { run, drafts } = await withVersion(true);
    await saveAdCopy({ runId: run.id, draftId: drafts[0]!.id, headline: "Hand written" }).catch(() => undefined);
    await undoLastEdit(drafts[0]!.id);
    const after = (await getCreativeDraftAsync(drafts[0]!.id))!;
    expect(after.headline).not.toBe("Old headline");
    expect(after.primary_text).not.toBe("Old body");
  });

  it("still puts the old copy back when the copy was never edited by hand (today's behaviour)", async () => {
    const { drafts } = await withVersion(false);
    await undoLastEdit(drafts[0]!.id);
    const after = (await getCreativeDraftAsync(drafts[0]!.id))!;
    expect(after).toMatchObject({ headline: "Old headline", primary_text: "Old body" });
  });
});

describe("editing copy while a directions run is still writing it", () => {
  it("is refused while the job is running, and allowed once it is ready or has stalled", async () => {
    const writing = await makeRun({ copyStatus: "writing", copyStartedAt: new Date().toISOString() });
    await expect(saveAdCopy({ runId: writing.run.id, draftId: writing.drafts[0]!.id, headline: "x" })).rejects.toThrow(/still being written/i);
    const stalled = await makeRun({ copyStatus: "writing", copyStartedAt: new Date(Date.now() - 11 * 60_000).toISOString() });
    await expect(saveAdCopy({ runId: stalled.run.id, draftId: stalled.drafts[0]!.id, headline: "x" })).resolves.toBeTruthy();
    const ready = await makeRun({ copyStatus: "ready" });
    await expect(saveAdCopy({ runId: ready.run.id, draftId: ready.drafts[0]!.id, headline: "x" })).resolves.toBeTruthy();
  });
});

describe("POST /api/creatives/bulk/[runId]/copy", () => {
  const post = async (runId: string, body: unknown) => {
    const { POST } = await import("@/app/api/creatives/bulk/[runId]/copy/route");
    return POST(new Request(`https://app.example.com/api/creatives/bulk/${runId}/copy`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ runId }) });
  };

  it("saves the copy for a signed-in operator with access, and refuses a bad request or a signed-out caller", async () => {
    const { run, drafts } = await makeRun();
    expect((await post(run.id, { draftId: drafts[0]!.id, headline: "Via the route" })).status).toBe(200);
    expect((await getCreativeDraftAsync(drafts[0]!.id))!.headline).toBe("Via the route");
    expect((await post(run.id, { draftId: drafts[0]!.id, headline: "h".repeat(300) })).status).toBeGreaterThanOrEqual(400);
    expect((await post("run_missing", { draftId: drafts[0]!.id, headline: "x" })).status).toBeGreaterThanOrEqual(400);
    vi.mocked(getCurrentUser).mockResolvedValue(null as never);
    expect((await post(run.id, { draftId: drafts[0]!.id, headline: "x" })).status).toBeGreaterThanOrEqual(400);
  });
});

describe("keeping the instructions through an image edit", () => {
  it("puts the operator's instructions into the prompt that rewrites the copy", () => {
    const base = { instruction: "make it blue", understood: "background to blue", copy: { headline: "H", primary_text: "P", description: null } };
    expect(buildRealignPrompt({ ...base, instructions: "Primary text under 20 words. End with a question." })).toMatch(/AD COPY RULES[\s\S]*Primary text under 20 words/);
    expect(buildRealignPrompt(base)).not.toContain("AD COPY RULES");
  });

  it("passes the run's instructions to the rewrite and notes an ad whose rewritten copy breaks a stored limit", async () => {
    const { run, drafts } = await makeRun({ copyInstructions: "Primary text under 3 words.", copyRules: { primary_text: { unit: "words", max: 3 }, checklist: [] } });
    realignResult = { headline: "New headline", primary_text: "one two three four five", description: "Desc 2", onImage: null, changed: true, note: "Updated" };
    await matchCopyToImage(drafts[1]!, await png(), "make it blue", { summary: "blue", facts: [] }).catch(() => undefined);
    expect(realignCalls[0]).toMatchObject({ instructions: "Primary text under 3 words." });
    const after = (await getRun(run.id))!;
    expect(after.items[1]!.copy_note).toBe("Did not fully follow your instructions: Primary text is 5 words; your limit is 3.");
  });

  it("clears the note when the rewritten copy now follows the limits", async () => {
    const { run, drafts } = await makeRun({ copyInstructions: "Primary text under 8 words.", copyRules: { primary_text: { unit: "words", max: 8 }, checklist: [] } });
    realignResult = { headline: "New", primary_text: "Short and fine.", description: "Desc 1", onImage: null, changed: true, note: "Updated" };
    await matchCopyToImage(drafts[0]!, await png(), "make it blue", { summary: "blue", facts: [] }).catch(() => undefined);
    expect((await getRun(run.id))!.items[0]!.copy_note ?? null).toBeNull();
  });

  it("leaves copy the operator edited by hand exactly as it is", async () => {
    const { run, drafts } = await makeRun({ copyInstructions: "x" });
    await saveAdCopy({ runId: run.id, draftId: drafts[1]!.id, headline: "Hand written" });
    realignResult = { headline: "Rewritten", primary_text: "Rewritten body", description: null, onImage: null, changed: true, note: "Updated" };
    await matchCopyToImage((await getCreativeDraftAsync(drafts[1]!.id))!, await png(), "make it blue", { summary: "blue", facts: [] }).catch(() => undefined);
    expect(realignCalls[0]).toMatchObject({ lockCopy: true });
    const after = (await getCreativeDraftAsync(drafts[1]!.id))!;
    expect(after.headline).toBe("Hand written");
    expect(after.primary_text).toBe("Body 2");
  });

  it("without instructions behaves as before: nothing extra is passed and no note is added", async () => {
    const { run, drafts } = await makeRun();
    realignResult = { headline: "Rewritten", primary_text: "Rewritten body", description: "Desc 2", onImage: null, changed: true, note: "Updated" };
    await matchCopyToImage(drafts[1]!, await png(), "make it blue", { summary: "blue", facts: [] }).catch(() => undefined);
    expect(realignCalls[0]!.instructions).toBeUndefined();
    expect(realignCalls[0]!.lockCopy).toBeFalsy();
    expect((await getRun(run.id))!.items[1]!.copy_note ?? null).toBeNull();
  });
});
