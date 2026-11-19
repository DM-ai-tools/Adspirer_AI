import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "@/lib/config";
import { getCreativeDraftAsync, listCreativeDraftsAsync, upsertCreativeDraftAsync, type CreativeDraft } from "@/lib/creatives/drafts";
import { readAspectMarker, withAspectMarker } from "@/lib/creatives/formats";
import { readDirectedMarker, withDirectedMarker } from "@/lib/creatives/directed/markers";
import type { Detection } from "@/lib/creatives/directed/detect";

const rendered: string[][] = [];
vi.mock("@/lib/creatives/service", () => ({
  generateImagesForDrafts: async (input: { draftIds: string[] }) => void rendered.push(input.draftIds),
}));
const posted: Array<{ eventType: string; content: string }> = [];
vi.mock("@/lib/workflow/events", () => ({ appendWorkflowMessage: async (m: { eventType: string; content: string }) => void posted.push(m) }));
const edits: Array<{ draftId: string; instruction: string }> = [];
vi.mock("@/lib/creatives/directed/edit", () => ({
  editDirectedDraft: async (i: { draftId: string; instruction: string }) => {
    edits.push(i);
    return { ok: true };
  },
}));
vi.mock("@/lib/creatives/cloudinary", () => ({ isCloudinaryConfigured: () => false, uploadCreativeImage: async () => ({ url: "", mime: "image/png" }) }));

import { runDirectedTurn } from "@/lib/creatives/directed/chat";

const brand = { brandName: "Acme", colors: ["#111111"], logoUrl: null, landingUrl: "https://acme.test" };
const none: Detection = { mode: "open", directions: [], website: null, format: null, editInstruction: null, question: null, overflow: false };
const detection = (over: Partial<Detection>): Detection => ({ ...none, ...over });

const base = { clientId: "c1", conversationId: "conv1", taskId: "t1", message: "make an image", recent: [], defaultFormat: "4:5" as const };
const run = (over: Partial<Parameters<typeof runDirectedTurn>[0]>, d: Detection) =>
  runDirectedTurn({ ...base, wantsInlineCreatives: true, drafts: [], ...over }, { detect: (async () => d) as never, loadBrand: (async () => brand) as never });

async function conceptDraft(created: string) {
  const d = await directedDraft(created, "x");
  const plain = await upsertCreativeDraftAsync({ ...d, id: undefined, creative_direction: "STYLE: a poster. ON-IMAGE TEXT: headline" });
  return { ...plain, created_at: created } as CreativeDraft;
}

async function directedDraft(created: string, picture = "A red door", imageStatus: "succeeded" | "generating" = "succeeded") {
  const d = await upsertCreativeDraftAsync({
    client_id: "c1",
    service_id: null,
    conversation_id: "conv1",
    task_id: "t1",
    brief_id: null,
    concept: "Acme — Your direction 1",
    headline: "Open it",
    primary_text: "",
    description: null,
    cta: null,
    creative_direction: withAspectMarker(withDirectedMarker("", { picture, print: [{ role: "headline", text: "Open it" }] }), "9:16"),
    image_url: "https://x/y.png",
    image_b64: null,
    image_mime: "image/png",
    image_model: null,
    image_prompt: null,
    image_status: imageStatus,
    image_error: null,
    landing_page_url: "https://acme.test",
    brand_colors: null,
    logo_url: null,
    revision_notes: null,
    status: "ready",
  });
  return { ...d, created_at: created } as CreativeDraft;
}

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test";
  resetConfigCache();
  rendered.length = 0;
  posted.length = 0;
  edits.length = 0;
});

const count = async () => (await listCreativeDraftsAsync("c1")).length;

describe("a message that is not a direction", () => {
  it("leaves a headline-only request to the existing concept flow: nothing is created", async () => {
    const before = await count();
    expect(await run({ message: "make ads, headline 'Free audit'" }, none)).toBeNull();
    expect(await count()).toBe(before);
  });

  it("does not even ask the detector when it is not an image request and no directed image exists", async () => {
    const detect = vi.fn();
    const out = await runDirectedTurn({ ...base, wantsInlineCreatives: false, drafts: [] }, { detect: detect as never, loadBrand: (async () => brand) as never });
    expect(out).toBeNull();
    expect(detect).not.toHaveBeenCalled();
  });

  it("does not interrupt an ordinary message with a question when it is not an image request", async () => {
    const out = await runDirectedTurn(
      { ...base, wantsInlineCreatives: false, drafts: [await directedDraft("2026-11-19T10:00:00Z")] },
      { detect: (async () => detection({ mode: "unsure", question: "What should it show?" })) as never, loadBrand: (async () => brand) as never },
    );
    expect(out).toBeNull();
  });
});

describe("a direction", () => {
  const door = { picture: "A red door in a white wall", print: [{ role: "headline", text: "Open the right door" }] };

  it("makes exactly one image, from the direction, and renders it", async () => {
    const before = await count();
    const out = (await run({}, detection({ mode: "directed", directions: [door] })))!;
    expect(await count()).toBe(before + 1);
    expect(out.cards).toHaveLength(1);
    expect(out.rendering).toBe(true);
    expect(out.summary).toMatch(/1 image/);
    const draft = (await getCreativeDraftAsync(out.cards[0]!.id))!;
    expect(readDirectedMarker(draft.creative_direction)).toMatchObject({ picture: door.picture, print: door.print });
    expect(readAspectMarker(draft.creative_direction)).toBe("4:5");
    expect(draft.conversation_id).toBe("conv1");
    await out.run!();
    expect(rendered).toEqual([[draft.id]]);
  });

  it("asks for the website instead of drawing an image with no brand colours, and makes nothing", async () => {
    const bare = { brandName: "Acme", colors: null, logoUrl: null, landingUrl: null };
    const before = await count();
    const out = (await runDirectedTurn({ ...base, wantsInlineCreatives: true, drafts: [] }, { detect: (async () => detection({ mode: "directed", directions: [door] })) as never, loadBrand: (async () => bare) as never }))!;
    expect(out.summary).toMatch(/website address/i);
    expect(out.summary).toMatch(/brand colours and logo/i);
    expect(out.cards).toEqual([]);
    expect(out.run).toBeNull();
    expect(await count()).toBe(before);
  });

  it("names the page it could not read when the operator gave one, and asks for another", async () => {
    const bare = { brandName: "Acme", colors: null, logoUrl: null, landingUrl: "https://acme.test/" };
    const out = (await runDirectedTurn({ ...base, wantsInlineCreatives: true, drafts: [] }, { detect: (async () => detection({ mode: "directed", directions: [door], website: "https://acme.test/" })) as never, loadBrand: (async () => bare) as never }))!;
    expect(out.summary).toContain("https://acme.test/");
    expect(out.summary).toMatch(/couldn.t read/i);
  });

  it("reads the brand from the website the operator gives in the message", async () => {
    const seen: Array<string | null | undefined> = [];
    const loadBrand = (async (i: { landingUrl?: string | null }) => {
      seen.push(i.landingUrl);
      return brand;
    }) as never;
    await runDirectedTurn({ ...base, landingUrl: "https://older.test/", wantsInlineCreatives: true, drafts: [] }, { detect: (async () => detection({ mode: "directed", directions: [door], website: "https://trafficradius.com.au/" })) as never, loadBrand });
    expect(seen).toEqual(["https://trafficradius.com.au/"]);
  });

  it("makes the image with a note when only the logo could not be found", async () => {
    const noLogo = { brandName: "Acme", colors: ["#111111"], logoUrl: null, landingUrl: "https://acme.test" };
    const out = (await runDirectedTurn({ ...base, wantsInlineCreatives: true, drafts: [] }, { detect: (async () => detection({ mode: "directed", directions: [door] })) as never, loadBrand: (async () => noLogo) as never }))!;
    expect(out.cards).toHaveLength(1);
    expect(out.summary).toMatch(/couldn.t find your logo/i);
    const full = { brandName: "Acme", colors: ["#111111"], logoUrl: "https://acme.test/logo.png", landingUrl: "https://acme.test" };
    const withBrand = (await runDirectedTurn({ ...base, wantsInlineCreatives: true, drafts: [] }, { detect: (async () => detection({ mode: "directed", directions: [door] })) as never, loadBrand: (async () => full) as never }))!;
    expect(withBrand.summary).not.toMatch(/couldn.t find/i);
    expect(withBrand.summary).toMatch(/brand colours with your logo/i);
  });

  it("uses the shape the operator stated over the chat's default", async () => {
    const out = (await run({}, detection({ mode: "directed", directions: [door], format: "9:16" })))!;
    expect(readAspectMarker((await getCreativeDraftAsync(out.cards[0]!.id))!.creative_direction)).toBe("9:16");
  });

  it("makes one image per direction when there are several", async () => {
    const out = (await run({}, detection({ mode: "directed", directions: [door, { ...door, picture: "B" }, { ...door, picture: "C" }] })))!;
    expect(out.cards).toHaveLength(3);
    expect(out.summary).toMatch(/3 images/);
  });

  it("points more directions than allowed to the bulk run and makes nothing", async () => {
    const before = await count();
    const out = (await run({}, detection({ mode: "directed", overflow: true })))!;
    expect(out.summary).toMatch(/Bulk run/);
    expect(out.cards).toEqual([]);
    expect(out.run).toBeNull();
    expect(await count()).toBe(before);
  });

  it("asks the one short question when it cannot tell what to draw", async () => {
    const out = (await run({}, detection({ mode: "unsure", question: "What should the picture show?" })))!;
    expect(out.summary).toContain("What should the picture show?");
    expect(out.cards).toEqual([]);
  });
});

describe("which image a typed edit or variations request acts on", () => {
  it("does not act on an older directed image when the latest image is a concept from the existing flow", async () => {
    const directed = await directedDraft("2026-11-19T09:00:00Z");
    const concept = await conceptDraft("2026-11-19T12:00:00Z");
    const detect = vi.fn(async () => detection({ mode: "variations" }));
    const before = await count();
    const out = await runDirectedTurn({ ...base, wantsInlineCreatives: false, drafts: [directed, concept] }, { detect: detect as never, loadBrand: (async () => brand) as never });
    expect(out).toBeNull();
    expect(await count()).toBe(before);
    // and when it is an image request, the detector is told there is no directed image to act on
    const detect2 = vi.fn(async () => detection({ mode: "edit", editInstruction: "make it darker" }));
    const out2 = await runDirectedTurn({ ...base, wantsInlineCreatives: true, drafts: [directed, concept] }, { detect: detect2 as never, loadBrand: (async () => brand) as never });
    expect(out2).toBeNull();
    expect(detect2).toHaveBeenCalledWith(expect.objectContaining({ hasDirectedImage: false }));
    expect(edits).toEqual([]);
  });

  it("says the image is still rendering instead of editing or varying it", async () => {
    const rendering = await directedDraft("2026-11-19T11:00:00Z", "new", "generating");
    const before = await count();
    const edit = (await run({ drafts: [rendering], wantsInlineCreatives: false }, detection({ mode: "edit", editInstruction: "make the text bigger" })))!;
    expect(edit.summary).toMatch(/still rendering/i);
    expect(edit.run).toBeNull();
    expect(edit.cards).toEqual([]);
    const vary = (await run({ drafts: [rendering], wantsInlineCreatives: false }, detection({ mode: "variations" })))!;
    expect(vary.summary).toMatch(/still rendering/i);
    expect(vary.run).toBeNull();
    expect(await count()).toBe(before);
    expect(edits).toEqual([]);
  });
});

describe("variations and edits of an existing directed image", () => {
  it("makes four variations of the latest directed image, with its words verbatim", async () => {
    const older = await directedDraft("2026-11-19T09:00:00Z", "old");
    const newer = await directedDraft("2026-11-19T11:00:00Z", "new");
    const out = (await run({ drafts: [older, newer], wantsInlineCreatives: false }, detection({ mode: "variations" })))!;
    expect(out.cards).toHaveLength(4);
    for (const card of out.cards) {
      const meta = readDirectedMarker((await getCreativeDraftAsync(card.id))!.creative_direction)!;
      expect(meta.picture).toBe("new");
      expect(meta.print).toEqual([{ role: "headline", text: "Open it" }]);
    }
    await out.run!();
    expect(rendered[0]).toHaveLength(4);
  });

  it("edits the latest directed image with the operator's instruction and reports the result in the chat", async () => {
    const older = await directedDraft("2026-11-19T09:00:00Z", "old");
    const newer = await directedDraft("2026-11-19T11:00:00Z", "new");
    const out = (await run({ drafts: [older, newer], wantsInlineCreatives: false }, detection({ mode: "edit", editInstruction: "make the background darker" })))!;
    expect(out.cards).toHaveLength(1);
    expect(out.cards[0]!.id).toBe(newer.id);
    expect(out.cards[0]!.image_status).toBe("generating");
    await out.run!();
    expect(edits).toEqual([{ draftId: newer.id, instruction: "make the background darker" }]);
    expect(posted.map((p) => p.eventType)).toEqual(["creative_revised"]);
  });
});
