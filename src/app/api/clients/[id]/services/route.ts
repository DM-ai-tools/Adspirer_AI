import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { nowIso } from "@/lib/utils";
import type { ClientService } from "@/types";
import { serviceCreateSchema } from "@/lib/clients/service-schema";
import { assertUniqueServiceName } from "@/lib/clients/service-name";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  return withApiHandler(async () => {
    const { id } = await context.params;
    const user = await getCurrentUser();
    assertAuthenticated(user);
    await assertClientAccess(user.id, id);

    const { ensureClientServices } = await import(
      "@/lib/clients/ensure-services"
    );
    const services = await ensureClientServices(id);
    return jsonOk({ services });
  });
}

export async function POST(request: Request, context: RouteContext) {
  return withApiHandler(async () => {
    const { id } = await context.params;
    const user = await getCurrentUser();
    assertAuthenticated(user);
    await assertClientAccess(user.id, id);

    const body = await parseBody(request, serviceCreateSchema);
    await assertUniqueServiceName(id, body.name);
    const ts = nowIso();
    const landing =
      body.landing_page_url ?? body.landing_url ?? null;
    const service: ClientService = {
      id: crypto.randomUUID(),
      client_id: id,
      name: body.name,
      description: body.description ?? null,
      keywords: body.keywords ?? null,
      landing_page_url: landing,
      priority: body.priority ?? 0,
      is_active: body.is_active ?? true,
      gross_margin_pct: body.gross_margin_pct ?? null,
      average_order_value_cents: body.average_order_value_cents ?? null,
      url_patterns: body.url_patterns ?? null,
      source: body.source ?? "manual",
      created_at: ts,
      updated_at: ts,
    };

    const config = getConfig();
    if (config.isDemoMode || !config.hasSupabase) {
      getDemoStore().clientServices.push(service);
      return jsonOk({ service }, 201);
    }

    const { id: _id, ...insertRow } = service;
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("client_services")
      .insert(insertRow)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return jsonOk({ service: data as ClientService }, 201);
  });
}
