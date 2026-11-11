import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "@/lib/config";
import { buildEditPrompt, finishEdit } from "@/lib/creatives/edit-image";
import { readLogoMarker, stripAspectMarker, withLogoMarker, withRunMarker, withAspectMarker } from "@/lib/creatives/formats";

const stored = new Map<string, Buffer>();
vi.mock("@/lib/storage/r2", () => ({
  getObjectStorage: () => ({
    put: async (key: string, data: Buffer) => void stored.set(key, Buffer.from(data)),
    get: async (key: string) => stored.get(key) ?? null,
    delete: async (key: string) => void stored.delete(key),
  }),
}));

const solid = (w: number, h: number, c: { r: number; g: number; b: number }) => sharp({ create: { width: w, height: h, channels: 3, background: c } }).png().toBuffer();
const pixel = async (png: Buffer, x: number, y: number) => {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i]!, data[i + 1]!, data[i + 2]!];
};

describe("the edit instruction", () => {
  it("says to change only that one thing and keep everything else, including the logo", () => {
    const p = buildEditPrompt("make the headline say Free Audit", true);
    expect(p).toContain("Make ONLY this change: make the headline say Free Audit");
    expect(p).toContain("Everything else must stay exactly as it is");
    expect(p).toContain("and the logo with its position");
    expect(buildEditPrompt("x y z", false)).not.toContain("the logo");
  });
});

describe("where the logo went is remembered", () => {
  it("round-trips through the art direction and stays hidden from the image prompt", () => {
    const d = withLogoMarker(withRunMarker(withAspectMarker("STYLE: x.", "4:5"), "run_1"), { left: 50, top: 60, width: 240, height: 90 });
    expect(readLogoMarker(d)).toEqual({ left: 50, top: 60, width: 240, height: 90 });
    expect(stripAspectMarker(d)).toBe("STYLE: x.");
    // writing it again replaces the old one
    expect(readLogoMarker(withLogoMarker(d, { left: 1, top: 2, width: 3, height: 4 }))).toEqual({ left: 1, top: 2, width: 3, height: 4 });
    expect(readLogoMarker("STYLE: no logo")).toBeNull();
  });
});

describe("finishing an edit", () => {
  it("puts the exact logo pixels back where they were, whatever the model did to that corner", async () => {
    const original = await sharp(await solid(400, 500, { r: 240, g: 240, b: 240 }))
      .composite([{ input: await solid(100, 40, { r: 10, g: 120, b: 10 }), left: 30, top: 30 }])
      .png()
      .toBuffer();
    // the model "edited": recoloured the background and smeared the logo corner
    const edited = await sharp(await solid(400, 500, { r: 20, g: 40, b: 200 }))
      .composite([{ input: await solid(100, 40, { r: 250, g: 0, b: 0 }), left: 30, top: 30 }])
      .png()
      .toBuffer();
    const out = await finishEdit(original, edited, { left: 26, top: 26, width: 108, height: 48 });
    expect(await pixel(out, 80, 50)).toEqual([10, 120, 10]); // the logo is the original's
    expect(await pixel(out, 300, 300)).toEqual([20, 40, 200]); // the rest is the edit
  });

  it("returns the original size even if the model returned another", async () => {
    const original = await solid(400, 500, { r: 1, g: 1, b: 1 });
    const edited = await solid(800, 1000, { r: 9, g: 9, b: 9 });
    const out = await finishEdit(original, edited, null);
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height]).toEqual([400, 500]);
  });
});

describe("editing an image of a bulk run", () => {
  const calls: Array<{ url: string; body: FormData }> = [];
  let outcome: "ok" | "fail" | "needs-no-fidelity" = "ok";
  let edited: Buffer;

  beforeEach(async () => {
    process.env.OPENAI_API_KEY = "test";
    resetConfigCache();
    calls.length = 0;
    stored.clear();
    outcome = "ok";
    edited = await solid(1024, 1280, { r: 20, g: 40, b: 200 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/images/edits")) {
          const body = init!.body as FormData;
          calls.push({ url, body });
          if (outcome === "fail") return new Response(JSON.stringify({ error: { message: "Your request was rejected by the safety system." } }), { status: 400 });
          if (outcome === "needs-no-fidelity" && body.get("input_fidelity")) return new Response(JSON.stringify({ error: { message: "Unknown parameter: 'input_fidelity'." } }), { status: 400 });
          return new Response(JSON.stringify({ data: [{ b64_json: edited.toString("base64") }] }), { status: 200 });
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENAI_API_KEY;
    resetConfigCache();
  });

  async function setup() {
    const { upsertCreativeDraftAsync, getCreativeDraftAsync } = await import("@/lib/creatives/drafts");
    const { createRun, updateRun } = await import("@/lib/creatives/bulk/runs");
    const run = await createRun({ clientId: "c1", inputs: {}, format: "4:5" });
    const original = await solid(1024, 1280, { r: 240, g: 240, b: 240 });
    const logoBox = { left: 40, top: 40, width: 200, height: 80 };
    const direction = withLogoMarker(withRunMarker(withAspectMarker("STYLE: x.", "4:5"), run.id), logoBox);
    const draft = await upsertCreativeDraftAsync({
      client_id: "c1", service_id: null, conversation_id: null, task_id: null, brief_id: null, concept: "Acme — Hook", headline: "Stop wasting spend", primary_text: "copy", description: null, cta: null,
      creative_direction: direction, image_url: null, image_b64: original.toString("base64"), image_mime: "image/png", image_model: null, image_prompt: null,
      image_status: "succeeded", image_error: null, landing_page_url: null, brand_colors: null, logo_url: "data:image/png;base64,AAAA", revision_notes: null, status: "ready",
    });
    await updateRun(run.id, { items: [{ draft_id: draft.id, angle_key: null, angle_name: null, stage: null, kind: null, targets: null, body_id: null, cta_label: null }] });
    return { run, draft, original, getCreativeDraftAsync };
  }

  it("changes only what was asked, sends the original image, keeps the original and the logo", async () => {
    const { editImage } = await import("@/lib/creatives/edit-image");
    const { getRun } = await import("@/lib/creatives/bulk/runs");
    const { run, draft, original, getCreativeDraftAsync } = await setup();

    const result = await editImage({ draftId: draft.id, instruction: "make the background blue", mode: "edit" });
    expect(result.ok).toBe(true);
    // the model got the existing image and the "change only this" instruction
    expect(String(calls[0]!.body.get("prompt"))).toContain("Make ONLY this change: make the background blue");
    const sent = calls[0]!.body.get("image[]") as Blob;
    expect(Buffer.from(await sent.arrayBuffer()).equals(original)).toBe(true);
    expect(calls[0]!.body.get("size")).toBe("1024x1280");

    const after = (await getCreativeDraftAsync(draft.id, { withImageData: true }))!;
    expect(after.image_status).toBe("succeeded");
    const png = Buffer.from(after.image_b64!, "base64");
    expect(await pixel(png, 600, 800)).toEqual([20, 40, 200]); // the edit
    expect(await pixel(png, 100, 80)).toEqual([240, 240, 240]); // the logo area is the original's pixels

    // the original is kept, and recorded
    const versions = (await getRun(run.id))!.items[0]!.versions!;
    expect(versions).toHaveLength(1);
    expect(stored.get(versions[0]!.key)!.equals(original)).toBe(true);
  });

  it("goes back to the original on undo", async () => {
    const { editImage, undoLastEdit } = await import("@/lib/creatives/edit-image");
    const { getRun } = await import("@/lib/creatives/bulk/runs");
    const { run, draft, original, getCreativeDraftAsync } = await setup();
    await editImage({ draftId: draft.id, instruction: "make the background blue", mode: "edit" });
    await undoLastEdit(draft.id);
    const back = (await getCreativeDraftAsync(draft.id, { withImageData: true }))!;
    expect(Buffer.from(back.image_b64!, "base64").equals(original)).toBe(true);
    expect((await getRun(run.id))!.items[0]!.versions).toEqual([]);
  });

  it("leaves the image exactly as it was when the edit fails, and says why", async () => {
    outcome = "fail";
    const { editImage } = await import("@/lib/creatives/edit-image");
    const { getRun } = await import("@/lib/creatives/bulk/runs");
    const { run, draft, original, getCreativeDraftAsync } = await setup();
    const result = await editImage({ draftId: draft.id, instruction: "make the background blue", mode: "edit" });
    expect(result.ok).toBe(false);
    const after = (await getCreativeDraftAsync(draft.id, { withImageData: true }))!;
    expect(after.image_status).toBe("succeeded");
    expect(Buffer.from(after.image_b64!, "base64").equals(original)).toBe(true);
    const item = (await getRun(run.id))!.items[0]!;
    expect(item.edit_error).toMatch(/safety/);
    expect(item.versions ?? []).toEqual([]);
    expect(stored.size).toBe(0);
  });

  it("retries without the fidelity option when the model does not take it", async () => {
    outcome = "needs-no-fidelity";
    const { editImage } = await import("@/lib/creatives/edit-image");
    const { draft } = await setup();
    expect((await editImage({ draftId: draft.id, instruction: "make the background blue", mode: "edit" })).ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body.get("input_fidelity")).toBe("high");
    expect(calls[1]!.body.get("input_fidelity")).toBeNull();
  });

  it("asks for a clear instruction", async () => {
    const { editImage } = await import("@/lib/creatives/edit-image");
    const { draft } = await setup();
    await expect(editImage({ draftId: draft.id, instruction: "  ", mode: "edit" })).rejects.toThrow(/what you want changed/);
  });
});

describe("editing with the landing page", () => {
  it("hands the image model the real words from the page, not the pointer to it", async () => {
    vi.resetModules();
    vi.doMock("@/lib/creatives/resolve-instruction", () => ({
      resolveEditInstruction: async (i: { instruction: string; landingPageUrl?: string | null }) => {
        if (/landing page/.test(i.instruction)) {
          expect(i.landingPageUrl).toBe("https://acme.test/");
          return { instruction: 'Replace the chips with "1,500+ Australian Businesses" and "$120M+ Ad Spend Managed".', usedPage: i.landingPageUrl, facts: [] };
        }
        return { instruction: i.instruction, usedPage: null, facts: [] };
      },
    }));
    process.env.OPENAI_API_KEY = "test";
    resetConfigCache();
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/images/edits")) {
          seen.push(String((init!.body as FormData).get("prompt")));
          return new Response(JSON.stringify({ data: [{ b64_json: (await solid(1024, 1280, { r: 1, g: 2, b: 3 })).toString("base64") }] }), { status: 200 });
        }
        throw new Error("unexpected fetch");
      }),
    );
    const { upsertCreativeDraftAsync } = await import("@/lib/creatives/drafts");
    const { createRun, updateRun } = await import("@/lib/creatives/bulk/runs");
    const { editImage } = await import("@/lib/creatives/edit-image");
    const run = await createRun({ clientId: "c1", inputs: {}, format: "4:5" });
    const draft = await upsertCreativeDraftAsync({
      client_id: "c1", service_id: null, conversation_id: null, task_id: null, brief_id: null, concept: "Acme — Hook", headline: "Stop wasting spend", primary_text: "copy", description: null, cta: null,
      creative_direction: withRunMarker(withAspectMarker("STYLE: x.", "4:5"), run.id), image_url: null, image_b64: (await solid(1024, 1280, { r: 240, g: 240, b: 240 })).toString("base64"), image_mime: "image/png",
      image_model: null, image_prompt: null, image_status: "succeeded", image_error: null, landing_page_url: "https://acme.test/", brand_colors: null, logo_url: null, revision_notes: null, status: "ready",
    });
    await updateRun(run.id, { items: [{ draft_id: draft.id, angle_key: null, angle_name: null, stage: null, kind: null, targets: null, body_id: null, cta_label: null }] });

    const result = await editImage({ draftId: draft.id, instruction: "use the client stats from the landing page", mode: "edit" });
    expect(result.ok).toBe(true);
    expect(seen[0]).toContain('"1,500+ Australian Businesses"');
    expect(seen[0]).not.toContain("landing page");
    vi.unstubAllGlobals();
    vi.doUnmock("@/lib/creatives/resolve-instruction");
  });

  it("leaves the image as it was and says why when the page has nothing to give", async () => {
    vi.resetModules();
    vi.doMock("@/lib/creatives/resolve-instruction", () => ({
      resolveEditInstruction: async () => {
        throw new Error("The page has no customer testimonials.");
      },
    }));
    process.env.OPENAI_API_KEY = "test";
    resetConfigCache();
    const fetchSpy = vi.fn(async () => {
      throw new Error("the image model must not be called");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const { upsertCreativeDraftAsync, getCreativeDraftAsync } = await import("@/lib/creatives/drafts");
    const { createRun, updateRun, getRun } = await import("@/lib/creatives/bulk/runs");
    const { editImage } = await import("@/lib/creatives/edit-image");
    const run = await createRun({ clientId: "c1", inputs: {}, format: "4:5" });
    const original = await solid(1024, 1280, { r: 240, g: 240, b: 240 });
    const draft = await upsertCreativeDraftAsync({
      client_id: "c1", service_id: null, conversation_id: null, task_id: null, brief_id: null, concept: "Acme — Hook", headline: "h", primary_text: "copy", description: null, cta: null,
      creative_direction: withRunMarker(withAspectMarker("STYLE: x.", "4:5"), run.id), image_url: null, image_b64: original.toString("base64"), image_mime: "image/png",
      image_model: null, image_prompt: null, image_status: "succeeded", image_error: null, landing_page_url: "https://acme.test/", brand_colors: null, logo_url: null, revision_notes: null, status: "ready",
    });
    await updateRun(run.id, { items: [{ draft_id: draft.id, angle_key: null, angle_name: null, stage: null, kind: null, targets: null, body_id: null, cta_label: null }] });
    const result = await editImage({ draftId: draft.id, instruction: "use the testimonials from the landing page", mode: "edit" });
    expect(result.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    const after = (await getCreativeDraftAsync(draft.id, { withImageData: true }))!;
    expect(after.image_status).toBe("succeeded");
    expect(Buffer.from(after.image_b64!, "base64").equals(original)).toBe(true);
    expect((await getRun(run.id))!.items[0]!.edit_error).toMatch(/no customer testimonials/);
    vi.unstubAllGlobals();
    vi.doUnmock("@/lib/creatives/resolve-instruction");
  });
});
