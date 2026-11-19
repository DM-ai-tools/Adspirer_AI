import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDemoStore } from "@/lib/demo/store";
import { resetConfigCache } from "@/lib/config";

vi.mock("@/lib/security/auth", () => ({ getCurrentUser: vi.fn() }));
import { getCurrentUser } from "@/lib/security/auth";

const scheduled: string[] = [];
vi.mock("@/lib/api/background", () => ({ runAfterResponse: (name: string) => void scheduled.push(name) }));
vi.mock("@/lib/creatives/cloudinary", () => ({ isCloudinaryConfigured: () => false, uploadCreativeImage: async () => ({ url: "", mime: "image/png" }) }));

import { POST } from "@/app/api/creatives/bulk/[runId]/edit/route";
import { getCreativeDraftAsync, upsertCreativeDraftAsync } from "@/lib/creatives/drafts";
import { withAspectMarker, withRunMarker } from "@/lib/creatives/formats";
import { withDirectedMarker } from "@/lib/creatives/directed/markers";
import { createRun, getRun, updateRun } from "@/lib/creatives/bulk/runs";
import { loadRunView } from "@/lib/creatives/bulk/view";

const clientId = () => getDemoStore().clients[0]!.id;
const ctx = (runId: string) => ({ params: Promise.resolve({ runId }) });
const post = (runId: string, body: unknown) => POST(new Request(`https://app.example.com/api/creatives/bulk/${runId}/edit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), ctx(runId));

async function runWith(direction: (runId: string) => string) {
  const run = await createRun({ clientId: clientId(), inputs: {}, format: "4:5" });
  const draft = await upsertCreativeDraftAsync({
    client_id: clientId(), service_id: null, conversation_id: null, task_id: null, brief_id: null, concept: "Acme — Direction 1", headline: "Open it", primary_text: "", description: null, cta: null,
    creative_direction: direction(run.id), image_url: "https://x/y.png", image_b64: null, image_mime: "image/png", image_model: null, image_prompt: null, image_status: "succeeded", image_error: null,
    landing_page_url: null, brand_colors: null, logo_url: null, revision_notes: null, status: "ready",
  });
  await updateRun(run.id, { items: [{ draft_id: draft.id, angle_key: null, angle_name: "Direction 1", stage: null, kind: null, targets: null, body_id: null, cta_label: null }] });
  return { run, draft };
}
const directed = (runId: string, extra: Record<string, unknown> = {}) =>
  withRunMarker(withAspectMarker(withDirectedMarker("", { picture: "A red door", print: [{ role: "headline", text: "Open it" }], ...extra }), "4:5"), runId);

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test";
  resetConfigCache();
  scheduled.length = 0;
  const p = getDemoStore().profiles.find((x) => x.role === "admin")!;
  vi.mocked(getCurrentUser).mockResolvedValue({ id: p.id, email: p.email, profile: p });
});

describe("editing an image of a bulk run that came from a direction", () => {
  it("uses the directed editor (which never invents copy), not the hook-copy editor", async () => {
    const { run, draft } = await runWith((id) => directed(id));
    const res = await post(run.id, { action: "edit", draftId: draft.id, instruction: "make the door blue", mode: "edit" });
    expect(res.status).toBe(200);
    expect(scheduled).toEqual(["directed-image-edit"]);
    expect((await getCreativeDraftAsync(draft.id))!.image_status).toBe("generating");
  });

  it("starts the picture again from the same direction for a full redo", async () => {
    const { run, draft } = await runWith((id) => directed(id));
    const res = await post(run.id, { action: "edit", draftId: draft.id, instruction: "warmer light", mode: "full" });
    expect(res.status).toBe(200);
    expect(scheduled).toEqual(["directed-image-redo"]);
  });

  it("still uses the existing editor for an ordinary bulk image", async () => {
    const { run, draft } = await runWith((id) => withRunMarker(withAspectMarker("STYLE: poster.", "4:5"), id));
    await post(run.id, { action: "edit", draftId: draft.id, instruction: "make it darker", mode: "edit" });
    expect(scheduled).toEqual(["bulk-image-edit"]);
  });

  it("undo says so when there is nothing to undo", async () => {
    const { run, draft } = await runWith((id) => directed(id));
    expect((await post(run.id, { action: "undo", draftId: draft.id })).status).toBeGreaterThanOrEqual(400);
  });
});

describe("how the run shows a directed image's edits", () => {
  it("lists each kept edit with its instruction, so the Undo control appears", async () => {
    const { run } = await runWith((id) => directed(id, { versions: ["creatives/versions/a/1.png", "creatives/versions/a/2.png"], printBefore: [[], []], edits: ["make the door red", "add morning light"] }));
    const view = await loadRunView((await getRun(run.id))!);
    expect(view.cards[0]!.edits.map((e) => e.instruction)).toEqual(["make the door red", "add morning light"]);
  });
});
