import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { resolvePrimaryAccountId } from "@/lib/agent/adspirer-agent";
import { jsonOk, withApiHandler } from "@/lib/api/response";
import { MetaGraphClient } from "@/lib/meta/graph-client";
import { getUserMetaToken } from "@/lib/meta/get-user-token";
import { extractCreativeDestination } from "@/lib/meta/extract-creative-destination";

const CREATIVE_FIELDS =
  "id,name,title,body,call_to_action_type,call_to_action,link_url,object_url,object_story_spec,asset_feed_spec,url_tags,effective_object_story_id,object_story_id";

/**
 * GET /api/v2/meta/debug/destinations?clientId=…&campaignId=…
 *
 * Dev-only: dumps the raw creative payload next to the URL extraction picked, so
 * a wrong Website URL can be traced to the exact Graph field it came from.
 */
export async function GET(request: Request) {
  return withApiHandler(async () => {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Not available in production");
    }

    const user = await getCurrentUser();
    assertAuthenticated(user);
    const url = new URL(request.url);
    const clientId = url.searchParams.get("clientId");
    if (!clientId) throw new Error("clientId required");
    await assertClientAccess(user.id, clientId);

    const accountId =
      url.searchParams.get("accountId") ||
      (await resolvePrimaryAccountId(clientId));
    if (!accountId) throw new Error("No Meta ad account mapped to this client");

    const campaignId = url.searchParams.get("campaignId");
    const { accessToken } = await getUserMetaToken();
    const graph = new MetaGraphClient(accessToken);

    const listPath = campaignId
      ? `${campaignId}/ads`
      : `${accountId.startsWith("act_") ? accountId : `act_${accountId}`}/ads`;

    const list = await graph.get<{
      data?: Array<Record<string, unknown>>;
    }>(listPath, {
      fields: "id,name,status,effective_status,campaign_id,adset_id,creative{id}",
      limit: Number(url.searchParams.get("limit") ?? 10),
    });

    const ads = [];
    for (const row of list.data ?? []) {
      const creativeId =
        typeof row.creative === "string"
          ? row.creative
          : ((row.creative as { id?: string } | undefined)?.id ?? null);

      const creative: Record<string, unknown> | null = creativeId
        ? await graph
            .get<Record<string, unknown>>(creativeId, {
              fields: CREATIVE_FIELDS,
            })
            .catch((e: unknown) => ({
              error: e instanceof Error ? e.message : String(e),
            }))
        : null;

      const storyId =
        (typeof creative?.effective_object_story_id === "string" &&
          creative.effective_object_story_id) ||
        (typeof creative?.object_story_id === "string" &&
          creative.object_story_id) ||
        null;

      const pagePost = storyId
        ? await graph
            .get<Record<string, unknown>>(storyId, {
              fields:
                "id,call_to_action,link,message,attachments{unshimmed_url,url,title,description,target}",
            })
            .catch(() => null)
        : null;

      const fromCreativeOnly = extractCreativeDestination(creative);
      const withPagePost = extractCreativeDestination(creative, pagePost);

      ads.push({
        ad_id: row.id,
        ad_name: row.name,
        status: row.status,
        effective_status: row.effective_status,
        campaign_id: row.campaign_id,
        picked: fromCreativeOnly.landing_page_url
          ? fromCreativeOnly
          : withPagePost,
        creative_only: {
          url: fromCreativeOnly.landing_page_url,
          source: fromCreativeOnly.destination_source,
          candidates: fromCreativeOnly.destination_candidates,
        },
        with_page_post: {
          url: withPagePost.landing_page_url,
          source: withPagePost.destination_source,
          candidates: withPagePost.destination_candidates,
        },
        raw_creative: creative,
        raw_page_post: pagePost,
      });
    }

    return jsonOk({ accountId, campaignId, ads });
  });
}
