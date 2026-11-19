import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDemoStore } from "@/lib/demo/store";
import { resetConfigCache } from "@/lib/config";

vi.mock("@/lib/security/auth", () => ({ getCurrentUser: vi.fn() }));
import { getCurrentUser } from "@/lib/security/auth";

const actions: string[] = [];
vi.mock("@/lib/api/background", () => ({ runAfterResponse: (name: string) => void actions.push(name) }));
vi.mock("@/lib/creatives/service", () => ({ generateImagesForDrafts: async () => [] }));
vi.mock("@/lib/workflow/events", () => ({ appendWorkflowMessage: async () => undefined }));
vi.mock("@/lib/creatives/cloudinary", () => ({ isCloudinaryConfigured: () => false, uploadCreativeImage: async () => ({ url: "", mime: "image/png" }) }));

import { POST } from "@/app/api/creatives/directed/route";
import { getCreativeDraftAsync, listCreativeDraftsAsync, upsertCreativeDraftAsync } from "@/lib/creatives/drafts";
import { withAspectMarker } from "@/lib/creatives/formats";
import { withDirectedMarker } from "@/lib/creatives/directed/markers";

const post = (body: unknown) => POST(new Request("https://app.example.com/api/creatives/directed", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));

async function directedDraft() {
  const store = getDemoStore();
  return upsertCreativeDraftAsync({
    client_id: store.clients[0]!.id,
    service_id: null,
    conversation_id: null,
    task_id: null,
    brief_id: null,
    concept: "Acme — Your direction 1",
    headline: "Open it",
    primary_text: "",
    description: null,
    cta: null,
    creative_direction: withAspectMarker(withDirectedMarker("", { picture: "A red door", print: [{ role: null, text: "Open it" }] }), "4:5"),
    image_url: "https://x/y.png",
    image_b64: null,
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
  actions.length = 0;
  const p = getDemoStore().profiles.find((x) => x.role === "admin")!;
  vi.mocked(getCurrentUser).mockResolvedValue({ id: p.id, email: p.email, profile: p });
});

describe("POST /api/creatives/directed", () => {
  it("variations: makes four drafts and schedules their rendering", async () => {
    const src = await directedDraft();
    const before = (await listCreativeDraftsAsync(src.client_id)).length;
    const res = await post({ action: "variations", draftId: src.id });
    const json = (await res.json()) as { data?: { drafts: unknown[] }; drafts?: unknown[] };
    expect(res.status).toBe(200);
    expect((json.data?.drafts ?? json.drafts)!).toHaveLength(4);
    expect((await listCreativeDraftsAsync(src.client_id)).length).toBe(before + 4);
    expect(actions).toEqual(["directed-variations"]);
  });

  it("edit: shows the card as working at once and schedules the edit", async () => {
    const src = await directedDraft();
    const res = await post({ action: "edit", draftId: src.id, instruction: "make the door blue" });
    expect(res.status).toBe(200);
    expect((await getCreativeDraftAsync(src.id))!.image_status).toBe("generating");
    expect(actions).toEqual(["directed-image-edit"]);
  });

  it("refuses an unknown draft, a too-short edit and a signed-out caller", async () => {
    expect((await post({ action: "variations", draftId: "nope" })).status).toBeGreaterThanOrEqual(400);
    const src = await directedDraft();
    expect((await post({ action: "edit", draftId: src.id, instruction: "x" })).status).toBeGreaterThanOrEqual(400);
    vi.mocked(getCurrentUser).mockResolvedValue(null as never);
    expect((await post({ action: "undo", draftId: src.id })).status).toBeGreaterThanOrEqual(400);
  });

  it("undo: says so when there is nothing to undo", async () => {
    const src = await directedDraft();
    expect((await post({ action: "undo", draftId: src.id })).status).toBeGreaterThanOrEqual(400);
  });
});
