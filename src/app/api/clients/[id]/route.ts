import { z } from "zod";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { getCurrentUser } from "@/lib/security/auth";
import {
  assertAuthenticated,
  assertAdmin,
  assertClientAccess,
} from "@/lib/authz/assert";
import { mapClientRow, toClientDbPatch } from "@/lib/clients/map-client";
import { nowIso } from "@/lib/utils";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";

const patchSchema = z.object({
  name: z.string().min(1).optional(),
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

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  return withApiHandler(async () => {
    const { id } = await context.params;
    const user = await getCurrentUser();
    assertAuthenticated(user);
    await assertClientAccess(user.id, id);

    const config = getConfig();
    if (config.isDemoMode || !config.hasSupabase) {
      const client = getDemoStore().clients.find((c) => c.id === id);
      if (!client) throw new Error(`Client not found: ${id}`);
      return jsonOk({ client });
    }

    const { createAdminClient } = await import("@/lib/supabase/admin");
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("clients")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error(`Client not found: ${id}`);
    return jsonOk({
      client: mapClientRow(data as Record<string, unknown>),
    });
  });
}

export async function PATCH(request: Request, context: RouteContext) {
  return withApiHandler(async () => {
    const { id } = await context.params;
    const user = await getCurrentUser();
    assertAuthenticated(user);
    await assertClientAccess(user.id, id);
    assertAdmin(user);

    const body = await parseBody(request, patchSchema);
    const config = getConfig();

    if (config.isDemoMode || !config.hasSupabase) {
      const store = getDemoStore();
      const idx = store.clients.findIndex((c) => c.id === id);
      if (idx < 0) throw new Error(`Client not found: ${id}`);
      store.clients[idx] = {
        ...store.clients[idx],
        ...body,
        updated_at: nowIso(),
      };
      return jsonOk({ client: store.clients[idx] });
    }

    const { createAdminClient } = await import("@/lib/supabase/admin");
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("clients")
      .update({ ...toClientDbPatch(body), updated_at: nowIso() })
      .eq("id", id)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return jsonOk({
      client: mapClientRow(data as Record<string, unknown>),
    });
  });
}
