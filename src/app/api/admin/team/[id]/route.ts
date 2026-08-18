import { z } from "zod";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertAdmin } from "@/lib/authz/assert";
import { USER_ROLES, type Profile } from "@/types";
import { nowIso } from "@/lib/utils";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";

const patchSchema = z.object({
  role: z.enum([USER_ROLES.ADMIN, USER_ROLES.OPERATOR]).optional(),
  fullName: z.string().min(1).nullable().optional(),
  isActive: z.boolean().optional(),
});

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  return withApiHandler(async () => {
    const { id } = await context.params;
    const user = await getCurrentUser();
    assertAuthenticated(user);
    assertAdmin(user);

    const body = await parseBody(request, patchSchema);
    const config = getConfig();

    if (config.isDemoMode || !config.hasSupabase) {
      const store = getDemoStore();
      const idx = store.profiles.findIndex((p) => p.id === id);
      if (idx < 0) throw new Error(`User not found: ${id}`);
      store.profiles[idx] = {
        ...store.profiles[idx],
        role: body.role ?? store.profiles[idx].role,
        full_name:
          body.fullName !== undefined
            ? body.fullName
            : store.profiles[idx].full_name,
        is_active:
          body.isActive !== undefined
            ? body.isActive
            : store.profiles[idx].is_active,
        updated_at: nowIso(),
      };
      return jsonOk({ user: store.profiles[idx] });
    }

    const { createAdminClient } = await import("@/lib/supabase/admin");
    const supabase = createAdminClient();
    const patch: Record<string, unknown> = { updated_at: nowIso() };
    if (body.role) patch.role = body.role;
    if (body.fullName !== undefined) patch.full_name = body.fullName;
    if (body.isActive !== undefined) patch.is_active = body.isActive;

    const { data, error } = await supabase
      .from("profiles")
      .update(patch)
      .eq("id", id)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return jsonOk({ user: data as Profile });
  });
}

export async function DELETE(_request: Request, context: RouteContext) {
  return withApiHandler(async () => {
    const { id } = await context.params;
    const user = await getCurrentUser();
    assertAuthenticated(user);
    assertAdmin(user);

    if (id === user.id) {
      throw new Error("Cannot disable your own account");
    }

    const config = getConfig();
    if (config.isDemoMode || !config.hasSupabase) {
      const store = getDemoStore();
      const idx = store.profiles.findIndex((p) => p.id === id);
      if (idx < 0) throw new Error(`User not found: ${id}`);
      store.profiles[idx] = {
        ...store.profiles[idx],
        is_active: false,
        updated_at: nowIso(),
      };
      return jsonOk({ user: store.profiles[idx], disabled: true });
    }

    const { createAdminClient } = await import("@/lib/supabase/admin");
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("profiles")
      .update({ is_active: false, updated_at: nowIso() })
      .eq("id", id)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return jsonOk({ user: data as Profile, disabled: true });
  });
}
