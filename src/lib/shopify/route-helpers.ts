import { z } from "zod";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAdmin, assertAuthenticated } from "@/lib/authz/assert";

/** Authenticated admin or throws (401 / 403). */
export async function requireAdmin() {
  const user = await getCurrentUser();
  assertAuthenticated(user);
  assertAdmin(user);
  return user;
}

/**
 * Parses a JSON body. A failure reports only the offending field names, never zod's
 * messages or received values, so a submitted access token cannot be echoed back.
 */
export async function parseSafeBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new ValidationError("Invalid JSON body");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.map(String).join(".") || "body"))];
    throw new ValidationError("Request validation failed", { fields });
  }
  return parsed.data;
}

/** 404 unless the client exists (admins may act on any existing client). */
export async function assertClientExists(clientId: string): Promise<void> {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    if (!getDemoStore().clients.some((c) => c.id === clientId)) throw new NotFoundError("Client not found");
    return;
  }
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { data, error } = await createAdminClient().from("clients").select("id").eq("id", clientId).maybeSingle();
  if (error) throw new Error("Could not look up the client");
  if (!data) throw new NotFoundError("Client not found");
}
