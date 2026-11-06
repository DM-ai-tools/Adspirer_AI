import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDemoStore } from "@/lib/demo/store";
import { settingsToArgs } from "@/lib/creatives/bulk/publish-settings";

vi.mock("@/lib/security/auth", () => ({ getCurrentUser: vi.fn() }));
import { getCurrentUser } from "@/lib/security/auth";

vi.mock("@/lib/approvals/service", () => ({ createPendingApproval: vi.fn() }));
import { createPendingApproval } from "@/lib/approvals/service";

import { GET, POST } from "@/app/api/creatives/bulk/[runId]/publish/route";
import { upsertCreativeDraftAsync } from "@/lib/creatives/drafts";
import { createRun, updateRun } from "@/lib/creatives/bulk/runs";

const clientId = () => getDemoStore().clients[0]!.id;
const ctx = (runId: string) => ({ params: Promise.resolve({ runId }) });
const post = (runId: string, body: unknown) =>
  POST(new Request(`https://app.example.com/api/creatives/bulk/${runId}/publish`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), ctx(runId));
const get = (runId: string) => GET(new Request(`https://app.example.com/api/creatives/bulk/${runId}/publish`), ctx(runId));

async function makeRun(n: number, over: { hostedUrl?: string; failIndex?: number; rejectIndex?: number } = {}) {
  const run = await createRun({ clientId: clientId(), inputs: {}, format: "4:5", landingPageUrl: "https://www.acme.com/offer" } as never);
  const items = [];
  for (let i = 0; i < n; i++) {
    const draft = await upsertCreativeDraftAsync({
      client_id: clientId(), service_id: null, conversation_id: null, task_id: null, brief_id: null, concept: `Acme — ${i}`, headline: `Hook ${i + 1}`, primary_text: `Body ${i + 1}`, description: null, cta: "Book Now",
      creative_direction: `RUN: ${run.id}`, image_url: `${over.hostedUrl ?? "https://res.cloudinary.com/demo/image"}/${i}.png`, image_b64: null, image_mime: "image/png", image_model: null, image_prompt: null,
      image_status: i === over.failIndex ? "failed" : "succeeded", image_error: null, landing_page_url: "https://www.acme.com/offer", brand_colors: null, logo_url: null, revision_notes: null, status: i === over.rejectIndex ? "rejected" : "ready",
    });
    items.push({ draft_id: draft.id, angle_key: `a${i}`, angle_name: `Angle ${i + 1}`, stage: null, kind: null, targets: null, body_id: null, cta_label: null });
  }
  await updateRun(run.id, { items });
  return run;
}

const plan = {
  destination: { mode: "new", campaignName: "Acme — Static ads", objective: "OUTCOME_TRAFFIC", settings: {} },
  adSet: { name: "Broad", budget_daily: 30, targeting: { locations: ["AU"] } },
  ad: { landing_page_url: "https://www.acme.com/offer", call_to_action: "LEARN_MORE", facebook_page_id: "321" },
};

beforeEach(() => {
  const p = getDemoStore().profiles.find((x) => x.role === "admin")!;
  vi.mocked(getCurrentUser).mockResolvedValue({ id: p.id, email: p.email, profile: p });
  vi.mocked(createPendingApproval).mockReset();
  vi.mocked(createPendingApproval).mockResolvedValue({ id: "appr_1" } as never);
});

describe("the options the publish steps start from", () => {
  it("lists the finished images, the landing page and a name from the landing page", async () => {
    const run = await makeRun(5, { failIndex: 1, rejectIndex: 2 });
    const res = await get(run.id);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect((body.data.images as unknown[]).length).toBe(3);
    expect(body.data.landingPageUrl).toBe("https://www.acme.com/offer");
    expect(body.data.suggestedCampaignName).toBe("acme.com — Static ads");
    expect(body.data.callToAction).toBe("BOOK_NOW");
    expect(body.data.unreachableImages).toBe(0);
  });
});

describe("sending a run to Meta", () => {
  it("creates ONE approval carrying every finished image as an ad", async () => {
    const run = await makeRun(15);
    const res = await post(run.id, plan);
    expect(res.status).toBe(200);
    expect(createPendingApproval).toHaveBeenCalledTimes(1);
    const call = vi.mocked(createPendingApproval).mock.calls[0]![0];
    expect(call.toolName).toBe("create_meta_image_campaign");
    expect(call.clientId).toBe(clientId());
    expect(call.proposedArgs.campaign_name).toBe("Acme — Static ads");
    expect((call.proposedArgs.extra_ads as unknown[]).length).toBe(14);
    expect(call.proposedArgs.headline).toBe("Hook 1");
    expect(call.idempotencyKey).toMatch(/^bulk_publish_/);
  });

  it("leaves out failed and rejected images", async () => {
    const run = await makeRun(15, { failIndex: 3, rejectIndex: 4 });
    await post(run.id, plan);
    const args = vi.mocked(createPendingApproval).mock.calls[0]![0].proposedArgs;
    expect((args.extra_ads as unknown[]).length).toBe(12); // 13 sent: the main ad plus 12
  });

  it("sends only the images picked", async () => {
    const run = await makeRun(6);
    const ids = (await import("@/lib/creatives/bulk/runs")).getRun(run.id).then((r) => r!.items.slice(0, 3).map((i) => i.draft_id));
    await post(run.id, { ...plan, draftIds: await ids });
    expect((vi.mocked(createPendingApproval).mock.calls[0]![0].proposedArgs.extra_ads as unknown[]).length).toBe(2);
  });

  it("refuses, without creating an approval, when Meta could not download the images", async () => {
    const run = await makeRun(3, { hostedUrl: "http://localhost:3000/api/creatives/assets" });
    const res = await post(run.id, plan);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(createPendingApproval).not.toHaveBeenCalled();
  });

  it("refuses an existing-campaign request without a campaign", async () => {
    const run = await makeRun(3);
    const res = await post(run.id, { ...plan, destination: { mode: "existing", campaignId: "", campaignName: "X" } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(createPendingApproval).not.toHaveBeenCalled();
  });

  it("does not let someone without access to the client send its ads", async () => {
    const run = await makeRun(2);
    vi.mocked(getCurrentUser).mockResolvedValue(null as never);
    const res = await post(run.id, plan);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(createPendingApproval).not.toHaveBeenCalled();
  });
});

describe("campaign settings as create arguments", () => {
  it("turns the budget level into the campaign-budget flag and drops empty answers", () => {
    expect(settingsToArgs({ budget_level: "campaign", optimization_goal: "LEAD_GENERATION", pixel_id: "9", publisher_platforms: [], age_min: 25 })).toEqual({
      campaign_budget_optimization: true,
      optimization_goal: "LEAD_GENERATION",
      pixel_id: "9",
      age_min: 25,
    });
    expect(settingsToArgs({ budget_level: "ad_set" }).campaign_budget_optimization).toBe(false);
    expect(settingsToArgs(null)).toEqual({});
  });
});
