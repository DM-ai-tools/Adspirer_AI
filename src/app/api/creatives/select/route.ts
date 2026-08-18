import { z } from "zod";
import { getCurrentUser } from "@/lib/security/auth";
import {
  assertAuthenticated,
  assertClientAccess,
} from "@/lib/authz/assert";
import {
  getCreativeDraftAsync,
  listCreativeDraftsAsync,
  selectCreativeDraftAsync,
  toPublicDraft,
} from "@/lib/creatives/drafts";
import { ensurePublicCreativeUrl } from "@/lib/creatives/cloudinary";
import { appendWorkflowMessage } from "@/lib/workflow/events";
import { bindImageToPendingApprovals } from "@/lib/workflow/bindings";
import { queueCampaignForSelectedCreative } from "@/lib/workflow/queue-campaign";
import { patchTaskAgentState } from "@/lib/workflow/state";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";

const selectSchema = z.object({
  draftId: z.string().min(1),
});

export async function GET(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const clientId = new URL(request.url).searchParams.get("clientId");
    const conversationId = new URL(request.url).searchParams.get("conversationId");
    if (!clientId) throw new Error("clientId required");
    await assertClientAccess(user.id, clientId);
    const drafts = await listCreativeDraftsAsync(clientId, {
      conversationId: conversationId ?? undefined,
    });
    return jsonOk({
      drafts: drafts.map((d) => ({
        ...toPublicDraft(d),
        image_b64: undefined,
      })),
    });
  });
}

export async function POST(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const body = await parseBody(request, selectSchema);
    const existing = await getCreativeDraftAsync(body.draftId);
    if (!existing) throw new Error("Creative draft not found");
    await assertClientAccess(user.id, existing.client_id);

    // Meta must be able to fetch the creative from the public internet. Upload
    // local/data-URI previews before creating or patching any approval.
    const uploaded = await ensurePublicCreativeUrl(existing);
    const draft = await selectCreativeDraftAsync(body.draftId);
    if (!draft) throw new Error("Could not select draft");
    const imageUrl = uploaded.imageUrl;

    if (existing.task_id) {
      await patchTaskAgentState(existing.task_id, {
        creatives: {
          selected_draft_id: draft.id,
          selected_image_url: imageUrl,
          last_event_at: new Date().toISOString(),
        },
      });
    }

    const bound = imageUrl
      ? await bindImageToPendingApprovals({
          clientId: draft.client_id,
          imageUrl,
          taskId: draft.task_id,
          reviewedBy: user.id,
        })
      : [];

    // Nothing was waiting on the image, so the campaign has to be queued now or
    // the operator is left with a selected creative and an empty Approvals queue.
    let queued: Awaited<ReturnType<typeof queueCampaignForSelectedCreative>> | null =
      null;
    if (bound.length === 0 && imageUrl) {
      queued = await queueCampaignForSelectedCreative({
        draft,
        imageUrl,
        clientName: await resolveClientName(draft.client_id),
        requestedBy: user.id,
      });
    }

    const approvalIds = [
      ...bound.map((a) => a.id),
      ...(queued?.queued ? [queued.approval.id] : []),
    ];

    const content = queued?.queued
      ? `Selected creative **${draft.headline}** and queued **create_meta_image_campaign** for approval with this image. Review it below — the campaign, ad set and ad are created PAUSED, and nothing reaches Meta until you approve.`
      : queued && !queued.queued
        ? `Selected creative **${draft.headline}**, but I could not queue the campaign: ${queued.reason}`
        : `Selected creative **${draft.headline}** and attached \`image_url\` to ${bound.length} pending ad approval${bound.length === 1 ? "" : "s"}. Approve below when ready — nothing goes live until you do.`;

    if (existing.conversation_id) {
      await appendWorkflowMessage({
        conversationId: existing.conversation_id,
        taskId: existing.task_id,
        eventType: "creative_selected",
        content,
        metadata: {
          ui: {
            creativePicker: {
              drafts: [toPublicDraft(draft)],
              status: "selected",
            },
          },
          draftId: draft.id,
          imageUrl,
          pendingApprovalIds: approvalIds,
        },
      });
    }

    return jsonOk({
      draft: { ...toPublicDraft(draft), image_b64: undefined },
      image_url: imageUrl,
      approvalIds,
      queued: Boolean(queued?.queued) || bound.length > 0,
      blockedReason: queued && !queued.queued ? queued.reason : null,
      workspaceHint: content,
    });
  });
}

async function resolveClientName(clientId: string): Promise<string | null> {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    return getDemoStore().clients.find((c) => c.id === clientId)?.name ?? null;
  }
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("clients")
    .select("name")
    .eq("id", clientId)
    .maybeSingle();
  return (data?.name as string | null) ?? null;
}
