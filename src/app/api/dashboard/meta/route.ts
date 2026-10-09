import { z } from "zod";
import { getConfig } from "@/lib/config";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { jsonOk, withApiHandler } from "@/lib/api/response";
import {
  loadMappedMetaAccounts,
  resolvePrimaryAccountId,
} from "@/lib/adspirer/resolve-meta-account";
import {
  DASHBOARD_RANGES,
  buildAccountDashboard,
  demoAccountDashboard,
  type AccountDashboard,
} from "@/lib/meta/account-dashboard";

const querySchema = z.object({
  clientId: z.string().min(1),
  range: z.enum(DASHBOARD_RANGES).default("7d"),
  /** Optional act_* — must be one of the client's mapped, granted accounts. */
  accountId: z.string().optional(),
});

/** Short cache so flipping ranges / revisiting the page doesn't hit Meta again. */
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; data: AccountDashboard }>();

function normalizeAct(id: string): string {
  return id.startsWith("act_") ? id : `act_${id}`;
}

/**
 * GET /api/dashboard/meta?clientId=…&range=today|7d|30d|month[&accountId=act_…]
 * Ad account summary (billing, allotted budget, performance) for the dashboard.
 */
export async function GET(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);

    const url = new URL(request.url);
    const query = querySchema.parse({
      clientId: url.searchParams.get("clientId") ?? undefined,
      range: url.searchParams.get("range") ?? undefined,
      accountId: url.searchParams.get("accountId") ?? undefined,
    });
    await assertClientAccess(user.id, query.clientId);

    const mapped = (await loadMappedMetaAccounts(query.clientId)).filter(
      (a) => a.access_status === "granted",
    );
    const accounts = mapped.map((a) => ({
      id: normalizeAct(a.meta_account_id),
      name: a.meta_account_name,
    }));

    let accountId: string | null = null;
    if (query.accountId) {
      const wanted = normalizeAct(query.accountId);
      accountId = accounts.find((a) => a.id === wanted)?.id ?? null;
    }
    accountId ??= await resolvePrimaryAccountId(query.clientId).then((id) =>
      id ? normalizeAct(id) : null,
    );

    if (!accountId) {
      return jsonOk({
        state: "no_account" as const,
        accounts,
        message:
          "No Meta ad account is mapped to this client yet. Connect Facebook and map an account under Connections.",
      });
    }

    const config = getConfig();
    if (config.isDemoMode || !config.hasSupabase) {
      const name = accounts.find((a) => a.id === accountId)?.name ?? accountId;
      return jsonOk({
        state: "ok" as const,
        demo: true,
        accounts,
        dashboard: demoAccountDashboard(accountId, name, query.range),
      });
    }

    const key = `${user.id}:${accountId}:${query.range}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return jsonOk({ state: "ok" as const, accounts, dashboard: hit.data });
    }

    let token: string;
    try {
      const { getUserMetaToken } = await import("@/lib/meta/get-user-token");
      token = (await getUserMetaToken()).accessToken;
    } catch (error) {
      return jsonOk({
        state: "not_connected" as const,
        accounts,
        message:
          error instanceof Error
            ? error.message
            : "Connect Facebook to load this ad account.",
      });
    }

    const { MetaGraphClient } = await import("@/lib/meta/graph-client");
    const dashboard = await buildAccountDashboard(
      new MetaGraphClient(token),
      accountId,
      query.range,
    );
    cache.set(key, { at: Date.now(), data: dashboard });
    return jsonOk({ state: "ok" as const, accounts, dashboard });
  });
}
