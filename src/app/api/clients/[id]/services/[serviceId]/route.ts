import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { NotFoundError } from "@/lib/errors";
import { nowIso } from "@/lib/utils";
import type { ClientService } from "@/types";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";
import { servicePatchSchema } from "@/lib/clients/service-schema";
import { assertUniqueServiceName } from "@/lib/clients/service-name";

type RouteContext = { params: Promise<{ id: string; serviceId: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  return withApiHandler(async () => {
    const { id, serviceId } = await context.params;
    const user = await getCurrentUser();
    assertAuthenticated(user);
    await assertClientAccess(user.id, id);

    const body = await parseBody(request, servicePatchSchema);
    const { landing_url, ...rest } = body;
    const patch: Partial<ClientService> = { ...rest };
    // landing_url is a deprecated alias for landing_page_url
    if (landing_url !== undefined && rest.landing_page_url === undefined) {
      patch.landing_page_url = landing_url;
    }

    const config = getConfig();
    if (config.isDemoMode || !config.hasSupabase) {
      const row = getDemoStore().clientServices.find(
        (s) => s.id === serviceId && s.client_id === id,
      );
      if (!row) throw new NotFoundError("Service not found");
      if (patch.name) await assertUniqueServiceName(id, patch.name, serviceId);
      Object.assign(row, patch, { updated_at: nowIso() });
      return jsonOk({ service: row });
    }

    const { createAdminClient } = await import("@/lib/supabase/admin");
    const supabase = createAdminClient();
    const { data: existing, error: findError } = await supabase
      .from("client_services")
      .select("id")
      .eq("id", serviceId)
      .eq("client_id", id)
      .maybeSingle();
    if (findError) throw new Error(findError.message);
    if (!existing) throw new NotFoundError("Service not found");
    if (patch.name) await assertUniqueServiceName(id, patch.name, serviceId);

    const { data, error } = await supabase
      .from("client_services")
      .update(patch)
      .eq("id", serviceId)
      .eq("client_id", id)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return jsonOk({ service: data as ClientService });
  });
}

export async function DELETE(_request: Request, context: RouteContext) {
  return withApiHandler(async () => {
    const { id, serviceId } = await context.params;
    const user = await getCurrentUser();
    assertAuthenticated(user);
    await assertClientAccess(user.id, id);

    const config = getConfig();
    if (config.isDemoMode || !config.hasSupabase) {
      const store = getDemoStore();
      const index = store.clientServices.findIndex(
        (s) => s.id === serviceId && s.client_id === id,
      );
      if (index < 0) throw new NotFoundError("Service not found");
      store.clientServices.splice(index, 1);
      return jsonOk({ ok: true });
    }

    const { createAdminClient } = await import("@/lib/supabase/admin");
    const { data, error } = await createAdminClient()
      .from("client_services")
      .delete()
      .eq("id", serviceId)
      .eq("client_id", id)
      .select("id");
    if (error) throw new Error(error.message);
    if (!data?.length) throw new NotFoundError("Service not found");
    return jsonOk({ ok: true });
  });
}
