import { describe, expect, it, vi } from "vitest";
import { approve, createPendingApproval } from "@/lib/approvals/service";
import { executeApprovedAction } from "@/lib/approvals/executor";
import { computeBudgetImpactCents } from "@/lib/approvals/validator";
import { BudgetCeilingViolation } from "@/lib/errors";
import { classify } from "@/lib/tools/policy";
import { getProviderForBackend } from "@/lib/adspirer/client";

// Modern Dental demo client: ceiling 250_000 cents, granted act_100200300 (USD).
const CLIENT_ID = "client_modern_dental";
const REVIEWER = "profile_admin_demo";
const ACCOUNT = "act_100200300";

async function run(toolName: string, proposedArgs: Record<string, unknown>) {
  const pending = await createPendingApproval({ clientId: CLIENT_ID, toolName, proposedArgs });
  await approve({ approvalId: pending.id, reviewedBy: REVIEWER });
  const { approval } = await executeApprovedAction({ approvalId: pending.id, executedBy: REVIEWER });
  return { pending, approval };
}

describe("sales and leads need a conversion source", () => {
  const leadsCampaign = (over: Record<string, unknown> = {}) => ({
    account_id: ACCOUNT,
    campaign_name: "Implants — Leads",
    objective: "OUTCOME_LEADS",
    budget_daily: 25,
    primary_text: "Book your consult",
    headline: "Dental implants",
    landing_page_url: "https://moderndental.example/implants",
    image_url: "https://moderndental.example/hero.jpg",
    locations: ["US"],
    facebook_page_id: "123456",
    ...over,
  });

  it("queues a Leads campaign without a pixel or form as needing a fix, and never creates it", async () => {
    const provider = getProviderForBackend(null);
    const spy = vi.spyOn(provider, "createImageCampaign");
    const queued = await createPendingApproval({
      clientId: CLIENT_ID,
      toolName: "create_meta_image_campaign",
      proposedArgs: leadsCampaign(),
    });
    expect(queued.execution_error).toMatch(/pixel or an instant form/);
    await approve({ approvalId: queued.id, reviewedBy: REVIEWER });
    await expect(executeApprovedAction({ approvalId: queued.id, executedBy: REVIEWER })).rejects.toThrow(
      /pixel or an instant form/,
    );
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("accepts a Leads campaign with a pixel or an instant form", async () => {
    for (const extra of [{ pixel_id: "42" }, { lead_form_id: "555" }]) {
      const queued = await createPendingApproval({
        clientId: CLIENT_ID,
        toolName: "create_meta_image_campaign",
        proposedArgs: leadsCampaign({ campaign_name: `Implants ${Object.keys(extra)[0]}`, ...extra }),
      });
      expect(queued.execution_error ?? null).toBeNull();
    }
  });
});

describe("creative requirements", () => {
  const imageCampaign = (over: Record<string, unknown> = {}) => ({
    account_id: ACCOUNT,
    campaign_name: "Implants — Traffic",
    objective: "OUTCOME_TRAFFIC",
    budget_daily: 25,
    primary_text: "Book your consult",
    headline: "Dental implants",
    landing_page_url: "https://moderndental.example/implants",
    image_url: "https://moderndental.example/hero.jpg",
    locations: ["US"],
    facebook_page_id: "123456",
    ...over,
  });
  const ad = (over: Record<string, unknown> = {}) => ({
    account_id: ACCOUNT,
    ad_set_id: "adset_mdc_npl_1",
    primary_text: "Book your consult",
    landing_page_url: "https://moderndental.example/implants",
    image_url: "https://moderndental.example/hero.jpg",
    ...over,
  });

  it("rejects carousel ads, which are not built yet, instead of creating a single image", async () => {
    await expect(
      createPendingApproval({ clientId: CLIENT_ID, toolName: "create_ad", proposedArgs: ad({ ad_type: "carousel" }) }),
    ).rejects.toThrow(/Carousel ads aren't supported yet/);
  });

  it("flags an image campaign or image ad with no image as needing a fix", async () => {
    const campaign = await createPendingApproval({
      clientId: CLIENT_ID,
      toolName: "create_meta_image_campaign",
      proposedArgs: imageCampaign({ image_url: undefined }),
    });
    expect(campaign.execution_error).toMatch(/needs an image/);

    const noImageAd = await createPendingApproval({
      clientId: CLIENT_ID,
      toolName: "create_ad",
      proposedArgs: ad({ image_url: undefined, name: "No image" }),
    });
    expect(noImageAd.execution_error).toMatch(/needs an image/);
  });

  it("accepts an existing image hash, and video ads need no image", async () => {
    const hashed = await createPendingApproval({
      clientId: CLIENT_ID,
      toolName: "create_meta_image_campaign",
      proposedArgs: imageCampaign({ image_url: undefined, existing_image_hash: "abc123", campaign_name: "Hashed" }),
    });
    expect(hashed.execution_error ?? null).toBeNull();
    const video = await createPendingApproval({
      clientId: CLIENT_ID,
      toolName: "create_ad",
      proposedArgs: ad({ image_url: undefined, ad_type: "video", existing_video_id: "v1", name: "Video" }),
    });
    expect(video.execution_error ?? null).toBeNull();
  });
});

describe("new execute actions", () => {
  it("are execute-class tools, not blocked", () => {
    for (const tool of ["update_campaign_budget", "pause_adset", "resume_adset", "resume_ad"]) {
      expect(classify(tool)).toBe("execute");
    }
  });

  it("counts a campaign budget increase as budget impact", () => {
    expect(
      computeBudgetImpactCents("update_campaign_budget", {
        daily_budget_cents: 9600,
        previous_daily_budget_cents: 8000,
      }),
    ).toBe(1600);
    expect(
      computeBudgetImpactCents("update_campaign_budget", {
        daily_budget_cents: 6400,
        previous_daily_budget_cents: 8000,
      }),
    ).toBe(0);
  });

  it("enforces the client budget ceiling on campaign budgets", async () => {
    await expect(
      createPendingApproval({
        clientId: CLIENT_ID,
        toolName: "update_campaign_budget",
        proposedArgs: { account_id: ACCOUNT, campaign_id: "camp_mdc_npl", daily_budget_cents: "500000" },
      }),
    ).rejects.toBeInstanceOf(BudgetCeilingViolation);
  });

  it("executes a campaign budget change with proof", async () => {
    const { pending, approval } = await run("update_campaign_budget", {
      account_id: ACCOUNT,
      campaign_id: "camp_mdc_npl",
      daily_budget_cents: "9600",
      previous_daily_budget_cents: 8000,
    });
    expect(pending.budget_impact_cents).toBe(1600);
    expect(approval.status).toBe("executed");
    expect(approval.execution_result?.proof).toMatchObject({
      campaign_id: "camp_mdc_npl",
      daily_budget_cents: 9600,
    });
    const campaigns = await getProviderForBackend(null).listCampaigns(ACCOUNT);
    expect(campaigns.find((c) => c.id === "camp_mdc_npl")?.daily_budget_cents).toBe(9600);
  });

  it("pauses then resumes an ad set (ad_set_id accepted as an alias)", async () => {
    const paused = await run("pause_adset", { account_id: ACCOUNT, ad_set_id: "adset_mdc_npl_2" });
    expect(paused.approval.status).toBe("executed");
    expect(paused.approval.execution_result?.proof).toMatchObject({ ad_set_id: "adset_mdc_npl_2", status: "PAUSED" });

    const resumed = await run("resume_adset", { account_id: ACCOUNT, adset_id: "adset_mdc_npl_2" });
    expect(resumed.approval.execution_result?.proof).toMatchObject({ ad_set_id: "adset_mdc_npl_2", status: "ACTIVE" });
  });

  it("resumes an ad", async () => {
    await run("pause_ad", { account_id: ACCOUNT, ad_id: "ad_mdc_npl_b" });
    const { approval } = await run("resume_ad", { account_id: ACCOUNT, ad_id: "ad_mdc_npl_b" });
    expect(approval.status).toBe("executed");
    expect(approval.execution_result?.proof).toMatchObject({ ad_id: "ad_mdc_npl_b", status: "ACTIVE" });
  });

  it("queues an ad set pause with no ad set id as needing a fix, and never runs it", async () => {
    const provider = getProviderForBackend(null);
    const spy = vi.spyOn(provider, "pauseAdSet");
    const queued = await createPendingApproval({
      clientId: CLIENT_ID,
      toolName: "pause_adset",
      proposedArgs: { account_id: ACCOUNT },
    });
    expect(queued.execution_error).toMatch(/adset_id/);
    await approve({ approvalId: queued.id, reviewedBy: REVIEWER });
    await expect(executeApprovedAction({ approvalId: queued.id, executedBy: REVIEWER })).rejects.toThrow(/adset_id/);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
