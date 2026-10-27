import { z } from "zod";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { resolvePrimaryAccountId } from "@/lib/agent/adspirer-agent";
import { jsonOk, withApiHandler } from "@/lib/api/response";
import { MetaGraphClient } from "@/lib/meta/graph-client";
import { getUserMetaToken } from "@/lib/meta/get-user-token";
import { listFacebookPagesForAccountId } from "@/lib/meta/resolve-page";
import { loadMappedMetaAccounts } from "@/lib/adspirer/resolve-meta-account";
import {
  loadCampaignOptions,
  pickAllowedAccount,
  type CampaignOptionsDeps,
} from "@/lib/meta/campaign-options";
import type { CampaignSettings } from "@/lib/meta/campaign-rules";

const OBJECTIVES = [
  "OUTCOME_SALES",
  "OUTCOME_LEADS",
  "OUTCOME_TRAFFIC",
  "OUTCOME_ENGAGEMENT",
  "OUTCOME_AWARENESS",
] as const;

/**
 * GET /api/meta/campaign-options?clientId=…&objective=…&accountId=…&stated=…
 * Live Meta options (pixels + events, Pages, lead forms, device, OS) merged with
 * Meta's rules and the server-computed suggestion, in one request. A failed
 * Meta lookup becomes a warning; the rules-derived fields always come back.
 */
export async function GET(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const url = new URL(request.url);
    const clientId = url.searchParams.get("clientId");
    if (!clientId) throw new Error("clientId required");
    await assertClientAccess(user.id, clientId);

    const objective = z
      .enum(OBJECTIVES)
      .parse(url.searchParams.get("objective") ?? "OUTCOME_TRAFFIC");

    // Only an account mapped to this client may be read: the options are cached
    // and carry pixel / Page / lead-form data fetched with the user's token.
    const mapped = (await loadMappedMetaAccounts(clientId))
      .filter((a) => a.access_status === "granted")
      .map((a) => a.meta_account_id);
    const accountId = pickAllowedAccount(
      url.searchParams.get("accountId"),
      mapped,
      await resolvePrimaryAccountId(clientId),
    );
    if (!accountId) {
      throw new Error(
        "No Meta ad account is mapped to this client. Connect Facebook in the Workspace header, then map an account under Connections.",
      );
    }

    let stated: Partial<CampaignSettings> | undefined;
    const rawStated = url.searchParams.get("stated");
    if (rawStated) {
      try {
        stated = JSON.parse(rawStated) as Partial<CampaignSettings>;
      } catch {
        stated = undefined;
      }
    }

    let deps: CampaignOptionsDeps;
    try {
      const { accessToken } = await getUserMetaToken();
      const graph = new MetaGraphClient(accessToken);
      deps = {
        graph,
        listPages: listFacebookPagesForAccountId,
        // Meta serves a Page's lead forms only to that Page's own token.
        fetchLeadForms: async (pageId) => {
          const page = await graph.get<{ access_token?: string }>(pageId, { fields: "access_token" });
          const pageGraph = new MetaGraphClient(page.access_token ?? accessToken);
          const res = await pageGraph.get<{
            data?: Array<{ id?: string; name?: string; status?: string }>;
          }>(`${pageId}/leadgen_forms`, { fields: "id,name,status", limit: 25 });
          return res.data ?? [];
        },
      };
    } catch (error) {
      // Expired or missing Meta token: keep the card usable from the rules alone.
      const failure = error instanceof Error ? error : new Error(String(error));
      deps = {
        graph: {
          get: async () => {
            throw failure;
          },
        },
        listPages: async () => {
          throw failure;
        },
      };
    }

    return jsonOk(await loadCampaignOptions({ clientId, accountId, objective, stated, cacheScope: user.id }, deps));
  });
}
