import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertAdmin } from "@/lib/authz/assert";
import { mapClientRow } from "@/lib/clients/map-client";
import { mapConnectedMetaAccountRow } from "@/lib/adspirer/db-map";
import { nowIso, slugify } from "@/lib/utils";
import type { Client, ConnectedMetaAccount } from "@/types";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";

const bodySchema = z
  .object({
    metaAccountId: z.string().min(1),
    /** Existing client to map onto. */
    clientId: z.string().min(1).optional(),
    /** Create a new client from the Meta account name, then map. */
    createClient: z.boolean().optional(),
  })
  .refine((v) => Boolean(v.clientId) || v.createClient === true, {
    message: "Provide clientId or set createClient=true",
  });

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export async function POST(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    assertAdmin(user);

    const body = await parseBody(request, bodySchema);
    const ts = nowIso();
    const config = getConfig();

    if (config.isDemoMode || !config.hasSupabase) {
      const store = getDemoStore();
      const account = store.connectedMetaAccounts.find(
        (a) =>
          a.id === body.metaAccountId ||
          a.meta_account_id === body.metaAccountId,
      );
      if (!account) {
        throw new Error(`Meta account not found: ${body.metaAccountId}`);
      }

      let client: Client | undefined;
      let clientId = body.clientId;

      if (body.createClient || !clientId) {
        client = {
          id: randomUUID(),
          name: account.meta_account_name || account.meta_account_id,
          slug: slugify(
            `${account.meta_account_name || "meta"}-${account.meta_account_id}`,
          ),
          website_url: null,
          industry: null,
          brand_voice: null,
          brand_colors: null,
          brand_guidelines: null,
          target_audience: null,
          value_proposition: null,
          budget_ceiling_cents: config.BUDGET_CEILING_DEFAULT_CENTS,
          currency: account.currency ?? "USD",
          notes: `Created from Meta account ${account.meta_account_id}`,
          is_demo: true,
          created_by: user.id,
          created_at: ts,
          updated_at: ts,
        };
        store.clients.push(client);
        store.userClientAccess.push({
          id: randomUUID(),
          user_id: user.id,
          client_id: client.id,
          granted_by: user.id,
          created_at: ts,
        });
        clientId = client.id;
      } else {
        client = store.clients.find((c) => c.id === clientId);
      }

      account.client_id = clientId!;
      account.updated_at = ts;
      return jsonOk({ account, client: client ?? null });
    }

    const { createAdminClient } = await import("@/lib/supabase/admin");
    const supabase = createAdminClient();

    // Row id is UUID; Meta act_* ids live in external_account_id. Never cast act_ into uuid.
    let accountQuery = supabase.from("connected_meta_accounts").select("*");
    if (isUuid(body.metaAccountId)) {
      accountQuery = accountQuery.eq("id", body.metaAccountId);
    } else {
      accountQuery = accountQuery.eq("external_account_id", body.metaAccountId);
    }
    const { data: accountRow, error: accountError } =
      await accountQuery.maybeSingle();
    if (accountError) throw new Error(accountError.message);
    if (!accountRow) {
      throw new Error(`Meta account not found: ${body.metaAccountId}`);
    }

    const account = mapConnectedMetaAccountRow(
      accountRow as Record<string, unknown>,
    );

    let client: Client | null = null;
    let clientId = body.clientId ?? null;

    if (body.createClient || !clientId) {
      const name = account.meta_account_name || account.meta_account_id;
      const baseSlug = slugify(name) || "meta-account";
      const slug = `${baseSlug}-${account.meta_account_id.replace(/\W+/g, "").slice(-8)}`;

      const { data: created, error: createError } = await supabase
        .from("clients")
        .insert({
          name,
          slug,
          currency: account.currency ?? "USD",
          notes: `Created from Meta account ${account.meta_account_id}`,
          budget_ceiling: config.BUDGET_CEILING_DEFAULT_CENTS / 100,
          is_demo: false,
          created_by: user.id,
          access_status: "granted",
          meta_account_id: account.meta_account_id,
          meta_account_name: account.meta_account_name,
        })
        .select("*")
        .single();
      if (createError) throw new Error(createError.message);

      client = mapClientRow(created as Record<string, unknown>);
      clientId = client.id;

      await supabase.from("user_client_access").insert({
        user_id: user.id,
        client_id: clientId,
        granted_by: user.id,
      });
    }

    const { data: mapped, error: mapError } = await supabase
      .from("connected_meta_accounts")
      .update({
        mapped_client_id: clientId,
        access_status: "granted",
        updated_at: ts,
      })
      .eq("id", account.id)
      .select("*")
      .single();
    if (mapError) throw new Error(mapError.message);

    return jsonOk({
      account: mapConnectedMetaAccountRow(
        mapped as Record<string, unknown>,
      ) as ConnectedMetaAccount,
      client,
    });
  });
}
