import { createHash } from "node:crypto";
import { z } from "zod";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { loadMappedMetaAccounts, resolvePrimaryAccountId } from "@/lib/adspirer/resolve-meta-account";
import { pickAllowedAccount } from "@/lib/meta/campaign-options";
import { createPendingApproval } from "@/lib/approvals/service";
import { listCreativeDraftsAsync, resolveImageUrlForAdspirer, type CreativeDraft } from "@/lib/creatives/drafts";
import { getRun } from "@/lib/creatives/bulk/runs";
import { BulkPublishError, buildBulkPublishArgs, isPrivateImageUrl, type BulkPublishAd, type BulkPublishPlan } from "@/lib/creatives/bulk/publish";
import { listFacebookPagesForAccountId } from "@/lib/meta/resolve-page";
import { resolveProvider } from "@/lib/adspirer/client";
import { toMetaCta } from "@/lib/workflow/queue-campaign";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";

type Ctx = { params: Promise<{ runId: string }> };

/** The finished, not rejected images of the run, in slot order. */
async function readyAds(run: NonNullable<Awaited<ReturnType<typeof getRun>>>, only?: string[]): Promise<Array<BulkPublishAd & { draft: CreativeDraft }>> {
  const all = await listCreativeDraftsAsync(run.client_id);
  const byId = new Map(all.map((d) => [d.id, d]));
  const wanted = only?.length ? new Set(only) : null;
  const out: Array<BulkPublishAd & { draft: CreativeDraft }> = [];
  for (const item of run.items) {
    if (wanted && !wanted.has(item.draft_id)) continue;
    const draft = byId.get(item.draft_id);
    if (!draft || draft.image_status !== "succeeded" || draft.status === "rejected") continue;
    const imageUrl = resolveImageUrlForAdspirer(draft);
    if (!imageUrl) continue;
    out.push({
      draftId: draft.id,
      draft,
      headline: draft.headline,
      primaryText: draft.primary_text,
      description: draft.description,
      name: item.angle_name,
      imageUrl,
    });
  }
  return out;
}

async function accountFor(clientId: string, requested: string | null): Promise<string> {
  const mapped = (await loadMappedMetaAccounts(clientId)).filter((a) => a.access_status === "granted").map((a) => a.meta_account_id);
  const accountId = pickAllowedAccount(requested, mapped, await resolvePrimaryAccountId(clientId));
  if (!accountId) {
    throw new Error("No Meta ad account is connected to this client yet. Connect Facebook in the Workspace header, then map an account under Connections.");
  }
  return accountId;
}

/** What the publish steps start from: the images that can go, the landing page, and a suggested name and call to action. */
export async function GET(request: Request, ctx: Ctx) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const { runId } = await ctx.params;
    const run = await getRun(runId);
    if (!run) throw new Error("Run not found");
    await assertClientAccess(user.id, run.client_id);
    const accountId = await accountFor(run.client_id, new URL(request.url).searchParams.get("accountId"));
    const ads = await readyAds(run);

    // The most used call to action across the images becomes the one every ad gets.
    const counts = new Map<string, number>();
    for (const a of ads) {
      const cta = toMetaCta(a.draft.cta);
      if (cta) counts.set(cta, (counts.get(cta) ?? 0) + 1);
    }
    const call_to_action = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "LEARN_MORE";
    const host = (() => {
      try {
        return run.landing_page_url ? new URL(run.landing_page_url).hostname.replace(/^www\./, "") : null;
      } catch {
        return null;
      }
    })();
    return jsonOk({
      accountId,
      landingPageUrl: run.landing_page_url ?? ads[0]?.draft.landing_page_url ?? null,
      suggestedCampaignName: host ? `${host} — Static ads` : "Static ads",
      callToAction: call_to_action,
      images: ads.map((a) => ({ id: a.draftId, headline: a.headline, image_url: a.imageUrl })),
      unreachableImages: ads.filter((a) => isPrivateImageUrl(a.imageUrl)).length,
    });
  });
}

const settingsSchema = z.record(z.string(), z.unknown());

const bodySchema = z.object({
  /** Leave out to send every finished image. */
  draftIds: z.array(z.string()).max(25).optional(),
  accountId: z.string().optional(),
  destination: z.discriminatedUnion("mode", [
    z.object({
      mode: z.literal("new"),
      campaignName: z.string().min(1).max(120),
      objective: z.string().min(1),
      settings: settingsSchema.optional(),
    }),
    z.object({
      mode: z.literal("existing"),
      campaignId: z.string().regex(/^\d+$/, "Choose a campaign"),
      campaignName: z.string().min(1).max(120),
      objective: z.string().optional(),
      adSetId: z.string().regex(/^\d+$/).optional(),
      adSetName: z.string().max(200).optional(),
      settings: settingsSchema.optional(),
    }),
  ]),
  adSet: z.object({
    name: z.string().max(120).optional(),
    budget_daily: z.number().positive().optional(),
    budget_lifetime: z.number().positive().optional(),
    start_time: z.string().optional(),
    end_time: z.string().optional(),
    targeting: settingsSchema.optional(),
  }),
  ad: z.object({
    facebook_page_id: z.string().optional(),
    instagram_account_id: z.string().optional(),
    call_to_action: z.string().optional(),
    landing_page_url: z.string().url(),
    display_link: z.string().optional(),
    url_tags: z.string().optional(),
    lead_form_id: z.string().optional(),
  }),
});

type Destination = z.infer<typeof bodySchema>["destination"];

function rationaleFor(d: Destination, count: number): string {
  const where =
    d.mode === "new"
      ? `a new campaign “${d.campaignName}” with one ad set`
      : d.adSetId
        ? `the existing ad set “${d.adSetName ?? d.adSetId}” in the campaign “${d.campaignName}”. The campaign and the ad set are not changed`
        : `a new ad set in the existing campaign “${d.campaignName}”`;
  return `${count} static ads from a bulk run, sent together into ${where}. Each ad is created PAUSED in Meta, so nothing goes live until you turn it on.`;
}

/**
 * Put the whole run into ONE approval: every finished image becomes an ad in one ad set, in a new or an
 * existing campaign, with the settings chosen once. Approving it creates everything in Meta, PAUSED.
 */
export async function POST(request: Request, ctx: Ctx) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const { runId } = await ctx.params;
    const run = await getRun(runId);
    if (!run) throw new Error("Run not found");
    await assertClientAccess(user.id, run.client_id);
    const body = await parseBody(request, bodySchema);
    const accountId = await accountFor(run.client_id, body.accountId ?? null);

    const ads = await readyAds(run, body.draftIds);

    // Fill in what Meta needs and the person did not choose, so the approval is complete and runs without edits.
    if (!body.ad.facebook_page_id) {
      const pages = await listFacebookPagesForAccountId(accountId).catch(() => []);
      if (pages[0]?.id) body.ad.facebook_page_id = pages[0].id;
    }
    if (body.destination.mode === "existing" && body.destination.adSetId) {
      // The ad set must be in that campaign, and an instant-form ad set needs its form. Checked now rather than at approval.
      const found = await resolveProvider()
        .then((p) => p.listAdSets(accountId, body.destination.mode === "existing" ? body.destination.campaignId : undefined))
        .then((list) => list.find((a) => a.id === (body.destination as { adSetId?: string }).adSetId) ?? null)
        .catch(() => undefined);
      if (found === null) throw new Error("That ad set is not in the campaign you chose. Pick one from the list.");
      if (found?.destination_type === "ON_AD" && !body.ad.lead_form_id) {
        throw new Error("That ad set collects leads on Facebook, so choose the lead form its ads should use.");
      }
      if (found) body.destination.adSetName = body.destination.adSetName ?? found.name;
    }

    let args: Record<string, unknown>;
    try {
      args = buildBulkPublishArgs({ accountId, plan: body as BulkPublishPlan, ads });
    } catch (error) {
      if (error instanceof BulkPublishError) throw new Error(error.message);
      throw error;
    }

    const fingerprint = createHash("sha1").update(JSON.stringify(args)).digest("hex").slice(0, 16);
    const approval = await createPendingApproval({
      clientId: run.client_id,
      taskId: null,
      toolName: "create_meta_image_campaign",
      proposedArgs: args,
      rationale: rationaleFor(body.destination, ads.length),
      requestedBy: user.id,
      idempotencyKey: `bulk_publish_${runId}_${fingerprint}`,
    });
    return jsonOk({ approvalId: approval.id, ads: ads.length });
  });
}
