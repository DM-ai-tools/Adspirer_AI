import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertAdmin } from "@/lib/authz/assert";
import { isAdmin } from "@/lib/security/roles";
import { mapClientRow } from "@/lib/clients/map-client";
import { slugify, nowIso } from "@/lib/utils";
import type { Client } from "@/types";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";

const createSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).optional(),
  website_url: z.string().url().nullable().optional(),
  industry: z.string().nullable().optional(),
  brand_voice: z.string().nullable().optional(),
  brand_colors: z.array(z.string()).nullable().optional(),
  brand_guidelines: z.string().nullable().optional(),
  target_audience: z.string().nullable().optional(),
  value_proposition: z.string().nullable().optional(),
  budget_ceiling_cents: z.number().int().nonnegative().nullable().optional(),
  currency: z.string().min(1).optional(),
  notes: z.string().nullable().optional(),
});

export async function GET() {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);

    const config = getConfig();
    if (config.isDemoMode || !config.hasSupabase) {
      const store = getDemoStore();
      if (isAdmin(user.profile)) {
        return jsonOk({ clients: store.clients });
      }
      const allowed = new Set(
        store.userClientAccess
          .filter((a) => a.user_id === user.id)
          .map((a) => a.client_id),
      );
      return jsonOk({
        clients: store.clients.filter((c) => allowed.has(c.id)),
      });
    }

    const { createAdminClient } = await import("@/lib/supabase/admin");
    const supabase = createAdminClient();

    if (isAdmin(user.profile)) {
      const { data, error } = await supabase.from("clients").select("*");
      if (error) throw new Error(error.message);
      return jsonOk({
        clients: (data ?? []).map((row) =>
          mapClientRow(row as Record<string, unknown>),
        ),
      });
    }

    const { data: access, error: accessError } = await supabase
      .from("user_client_access")
      .select("client_id")
      .eq("user_id", user.id);
    if (accessError) throw new Error(accessError.message);

    const ids = (access ?? []).map((a) => a.client_id as string);
    if (ids.length === 0) return jsonOk({ clients: [] as Client[] });

    const { data, error } = await supabase
      .from("clients")
      .select("*")
      .in("id", ids);
    if (error) throw new Error(error.message);
    return jsonOk({
      clients: (data ?? []).map((row) =>
        mapClientRow(row as Record<string, unknown>),
      ),
    });
  });
}

export async function POST(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    assertAdmin(user);

    const body = await parseBody(request, createSchema);
    const ts = nowIso();
    const config = getConfig();
    const budgetCents =
      body.budget_ceiling_cents ?? config.BUDGET_CEILING_DEFAULT_CENTS;

    if (config.isDemoMode || !config.hasSupabase) {
      const store = getDemoStore();
      const client: Client = {
        id: randomUUID(),
        name: body.name,
        slug: body.slug ?? slugify(body.name),
        website_url: body.website_url ?? null,
        industry: body.industry ?? null,
        brand_voice: body.brand_voice ?? null,
        brand_colors: body.brand_colors ?? null,
        brand_guidelines: body.brand_guidelines ?? null,
        target_audience: body.target_audience ?? null,
        value_proposition: body.value_proposition ?? null,
        budget_ceiling_cents: budgetCents,
        currency: body.currency ?? "USD",
        notes: body.notes ?? null,
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
      return jsonOk({ client }, 201);
    }

    const { createAdminClient } = await import("@/lib/supabase/admin");
    const supabase = createAdminClient();

    const insertPayload = {
      name: body.name,
      slug: body.slug ?? slugify(body.name),
      website_url: body.website_url ?? null,
      industry: body.industry ?? null,
      brand_voice: body.brand_voice ?? null,
      brand_colors: body.brand_colors ?? null,
      brand_guidelines: body.brand_guidelines ?? null,
      target_audience: body.target_audience ?? null,
      value_proposition: body.value_proposition ?? null,
      // DB column is dollars (numeric)
      budget_ceiling: budgetCents / 100,
      currency: body.currency ?? "USD",
      notes: body.notes ?? null,
      is_demo: false,
      created_by: user.id,
      access_status: "not_requested",
    };

    const { data, error } = await supabase
      .from("clients")
      .insert(insertPayload)
      .select("*")
      .single();
    if (error) throw new Error(error.message);

    const client = mapClientRow(data as Record<string, unknown>);

    await supabase.from("user_client_access").insert({
      user_id: user.id,
      client_id: client.id,
      granted_by: user.id,
    });

    return jsonOk({ client }, 201);
  });
}
