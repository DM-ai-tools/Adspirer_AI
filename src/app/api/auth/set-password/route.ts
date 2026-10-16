import { z } from "zod";
import { getConfig } from "@/lib/config";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated } from "@/lib/authz/assert";
import { ValidationError } from "@/lib/errors";
import { validateNewPassword } from "@/lib/team/members";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";

const bodySchema = z.object({
  password: z.string().max(200),
  fullName: z.string().trim().min(1).max(120).optional(),
});

/** The signed-in user (arriving from an invite or reset link) sets their own password. */
export async function POST(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const body = await parseBody(request, bodySchema);
    const problem = validateNewPassword(body.password);
    if (problem) throw new ValidationError(problem);

    const config = getConfig();
    if (config.isDemoMode || !config.hasSupabase) return jsonOk({ ok: true, demo: true });

    const { createClient } = await import("@/lib/supabase/server");
    const supabase = await createClient();
    const { error } = await supabase.auth.updateUser({ password: body.password });
    if (error) throw new ValidationError(error.message);
    if (body.fullName) {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      await createAdminClient().from("profiles").update({ full_name: body.fullName }).eq("id", user.id);
    }
    return jsonOk({ ok: true });
  });
}
