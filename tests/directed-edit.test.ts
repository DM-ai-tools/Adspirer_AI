import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { resetConfigCache } from "@/lib/config";
import { getCreativeDraftAsync, upsertCreativeDraftAsync } from "@/lib/creatives/drafts";
import { withAspectMarker, withLogoMarker } from "@/lib/creatives/formats";
import { readDirectedMarker, withDirectedMarker, type PrintLine } from "@/lib/creatives/directed/markers";
import { editDirectedDraft, MAX_KEPT_VERSIONS, undoDirectedEdit } from "@/lib/creatives/directed/edit";

const stored = new Map<string, Buffer>();
let failPut = false;
vi.mock("@/lib/storage/r2", () => ({
  getObjectStorage: () => ({
    put: async (key: string, data: Buffer) => {
      if (failPut) throw new Error("storage unavailable");
      stored.set(key, Buffer.from(data));
    },
    get: async (key: string) => stored.get(key) ?? null,
    delete: async (key: string) => void stored.delete(key),
  }),
}));
vi.mock("@/lib/creatives/cloudinary", () => ({ isCloudinaryConfigured: () => false, uploadCreativeImage: async () => ({ url: "", mime: "image/png" }) }));

const solid = (c: { r: number; g: number; b: number }) => sharp({ create: { width: 80, height: 100, channels: 3, background: c } }).png().toBuffer();
const red = { r: 200, g: 20, b: 20 };
const blue = { r: 20, g: 20, b: 200 };
const colourOf = async (png: Buffer) => {
  const { data } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return [data[0]!, data[1]!, data[2]!];
};

const print: PrintLine[] = [{ role: "headline", text: "Open the right door" }];

async function makeDraft(extra: Partial<Parameters<typeof withDirectedMarker>[1]> = {}) {
  const png = await solid(red);
  return upsertCreativeDraftAsync({
    client_id: "c1",
    service_id: null,
    conversation_id: "conv1",
    task_id: null,
    brief_id: null,
    concept: "Acme — Your direction 1",
    headline: "Open the right door",
    primary_text: "",
    description: null,
    cta: null,
    creative_direction: withLogoMarker(withAspectMarker(withDirectedMarker("", { picture: "A red door", print, ...extra }), "4:5"), { left: 0, top: 0, width: 10, height: 10 }),
    image_url: `data:image/png;base64,${png.toString("base64")}`,
    image_b64: png.toString("base64"),
    image_mime: "image/png",
    image_model: null,
    image_prompt: null,
    image_status: "succeeded",
    image_error: null,
    landing_page_url: null,
    brand_colors: null,
    logo_url: null,
    revision_notes: null,
    status: "ready",
  });
}

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test";
  resetConfigCache();
  stored.clear();
  failPut = false;
});

describe("an edit that cannot even start never leaves the image stuck as generating", () => {
  it("reports the failure and returns to the image when storage fails before the edit", async () => {
    const draft = await makeDraft();
    await upsertCreativeDraftAsync({ ...draft, id: draft.id, image_status: "generating" }); // the caller marks it working first
    failPut = true;
    const result = await editDirectedDraft({ draftId: draft.id, instruction: "make the door blue" }, { callEdit: (async () => solid(blue)) as never, updatePrint: async (p) => p });
    expect(result).toEqual({ ok: false, error: "storage unavailable" });
    const after = (await getCreativeDraftAsync(draft.id))!;
    expect(after.image_status).toBe("succeeded");
    expect(after.image_error).toBeNull();
  });

  it("marks a draft that has no image yet as failed with the reason, not as generating", async () => {
    const draft = await makeDraft();
    const empty = await upsertCreativeDraftAsync({ ...draft, id: draft.id, image_url: null, image_b64: null, image_status: "generating" });
    const result = await editDirectedDraft({ draftId: empty.id, instruction: "make the door blue" }, { callEdit: (async () => solid(blue)) as never, updatePrint: async (p) => p });
    expect(result.ok).toBe(false);
    const after = (await getCreativeDraftAsync(empty.id))!;
    expect(after.image_status).toBe("failed");
    expect(after.image_error).toMatch(/not available to edit/i);
  });
});

describe("the edits made so far are remembered", () => {
  it("records each instruction, and undo takes the last one back out", async () => {
    const draft = await makeDraft();
    const deps = { callEdit: (async () => solid(blue)) as never, updatePrint: async (p: PrintLine[]) => p };
    await editDirectedDraft({ draftId: draft.id, instruction: "make the door blue" }, deps);
    await editDirectedDraft({ draftId: draft.id, instruction: "add morning light" }, deps);
    expect(readDirectedMarker((await getCreativeDraftAsync(draft.id))!.creative_direction)!.edits).toEqual(["make the door blue", "add morning light"]);
    await undoDirectedEdit(draft.id);
    expect(readDirectedMarker((await getCreativeDraftAsync(draft.id))!.creative_direction)!.edits).toEqual(["make the door blue"]);
  });
});

describe("editing a directed image", () => {
  it("changes only what was asked: sends the current image with the edit instruction and keeps the marker", async () => {
    const draft = await makeDraft();
    const callEdit = vi.fn(async () => solid(blue));
    const result = await editDirectedDraft({ draftId: draft.id, instruction: "make the door blue" }, { callEdit: callEdit as never, updatePrint: async (p) => p });
    expect(result).toEqual({ ok: true });
    expect(callEdit).toHaveBeenCalledTimes(1);
    const prompt = (callEdit.mock.calls[0] as unknown as [Buffer, string, string])[1];
    expect(prompt).toContain("Make ONLY this change: make the door blue");
    const after = (await getCreativeDraftAsync(draft.id, { withImageData: true }))!;
    expect(after.image_status).toBe("succeeded");
    expect(await colourOf(Buffer.from(after.image_b64!, "base64"))).toEqual(expect.arrayContaining([expect.any(Number)]));
    const meta = readDirectedMarker(after.creative_direction)!;
    expect(meta.picture).toBe("A red door");
    expect(meta.print).toEqual(print);
    expect(meta.versions).toHaveLength(1);
    expect(stored.has(meta.versions![0]!)).toBe(true);
  });

  it("records new printed words when the instruction changes them", async () => {
    const draft = await makeDraft();
    const updatePrint = vi.fn(async () => [{ role: "headline", text: "Open the other door" }]);
    await editDirectedDraft({ draftId: draft.id, instruction: "change the headline to Open the other door" }, { callEdit: (async () => solid(blue)) as never, updatePrint });
    const meta = readDirectedMarker((await getCreativeDraftAsync(draft.id))!.creative_direction)!;
    expect(meta.print).toEqual([{ role: "headline", text: "Open the other door" }]);
    expect(meta.printBefore).toEqual([print]);
    expect((await getCreativeDraftAsync(draft.id))!.headline).toBe("Open the other door");
  });

  it("leaves the original image, status and marker alone when the model fails", async () => {
    const draft = await makeDraft();
    const before = (await getCreativeDraftAsync(draft.id, { withImageData: true }))!.image_b64;
    const result = await editDirectedDraft({ draftId: draft.id, instruction: "make the door blue" }, { callEdit: (async () => {
      throw new Error("edit refused");
    }) as never, updatePrint: async (p) => p });
    expect(result).toEqual({ ok: false, error: "edit refused" });
    const after = (await getCreativeDraftAsync(draft.id, { withImageData: true }))!;
    expect(after.image_status).toBe("succeeded");
    expect(after.image_b64).toBe(before);
    expect(readDirectedMarker(after.creative_direction)!.versions ?? []).toHaveLength(0);
    expect(stored.size).toBe(0);
  });

  it("refuses an empty instruction and a draft that is not directed", async () => {
    const draft = await makeDraft();
    await expect(editDirectedDraft({ draftId: draft.id, instruction: " " })).rejects.toThrow(/what you want changed/i);
    const plain = await upsertCreativeDraftAsync({ ...draft, id: undefined, creative_direction: "STYLE: poster" });
    await expect(editDirectedDraft({ draftId: plain.id, instruction: "make it blue" })).rejects.toThrow(/direction/i);
  });

  it(`keeps only the last ${MAX_KEPT_VERSIONS} versions`, async () => {
    const draft = await makeDraft();
    for (let i = 0; i < MAX_KEPT_VERSIONS + 2; i += 1) {
      await editDirectedDraft({ draftId: draft.id, instruction: `change ${i}` }, { callEdit: (async () => solid(i % 2 ? red : blue)) as never, updatePrint: async (p) => p });
    }
    const meta = readDirectedMarker((await getCreativeDraftAsync(draft.id))!.creative_direction)!;
    expect(meta.versions).toHaveLength(MAX_KEPT_VERSIONS);
    expect(stored.size).toBe(MAX_KEPT_VERSIONS);
  });
});

describe("undoing an edit", () => {
  it("puts back the earlier image and the earlier printed words", async () => {
    const draft = await makeDraft();
    const originalPng = Buffer.from((await getCreativeDraftAsync(draft.id, { withImageData: true }))!.image_b64!, "base64");
    await editDirectedDraft({ draftId: draft.id, instruction: "change the headline" }, { callEdit: (async () => solid(blue)) as never, updatePrint: async () => [{ role: "headline", text: "Changed" }] });
    await undoDirectedEdit(draft.id);
    const after = (await getCreativeDraftAsync(draft.id, { withImageData: true }))!;
    expect(await colourOf(Buffer.from(after.image_b64!, "base64"))).toEqual(await colourOf(originalPng));
    const meta = readDirectedMarker(after.creative_direction)!;
    expect(meta.print).toEqual(print);
    expect(meta.versions ?? []).toHaveLength(0);
    expect(after.headline).toBe("Open the right door");
    expect(stored.size).toBe(0);
  });

  it("says so when there is nothing to undo", async () => {
    const draft = await makeDraft();
    await expect(undoDirectedEdit(draft.id)).rejects.toThrow("There is no earlier version to go back to.");
  });
});
