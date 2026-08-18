import { describe, expect, it } from "vitest";
import {
  assertAdmin,
  assertClientAccess,
} from "@/lib/authz/assert";
import { AuthorizationError, ClientAccessError } from "@/lib/errors";
import { getDemoStore, resetDemoStore } from "@/lib/demo/store";
import { nowIso } from "@/lib/utils";

describe("authorization", () => {
  it("operator cannot access an unassigned client", async () => {
    resetDemoStore();
    const store = getDemoStore();
    const operator = store.profiles.find((p) => p.role === "operator")!;
    const orphanId = "client_orphan_unassigned";

    store.clients.push({
      id: orphanId,
      name: "Orphan Client",
      slug: "orphan",
      website_url: null,
      industry: null,
      brand_voice: null,
      brand_colors: null,
      brand_guidelines: null,
      target_audience: null,
      value_proposition: null,
      budget_ceiling_cents: 100_000,
      currency: "USD",
      notes: "DEMO DATA",
      is_demo: true,
      created_by: store.profiles.find((p) => p.role === "admin")!.id,
      created_at: nowIso(),
      updated_at: nowIso(),
    });

    await expect(assertClientAccess(operator.id, orphanId)).rejects.toBeInstanceOf(
      ClientAccessError,
    );
  });

  it("admin can access an unassigned client", async () => {
    resetDemoStore();
    const store = getDemoStore();
    const admin = store.profiles.find((p) => p.role === "admin")!;
    const orphanId = "client_orphan_admin_ok";

    store.clients.push({
      id: orphanId,
      name: "Admin Orphan",
      slug: "admin-orphan",
      website_url: null,
      industry: null,
      brand_voice: null,
      brand_colors: null,
      brand_guidelines: null,
      target_audience: null,
      value_proposition: null,
      budget_ceiling_cents: 100_000,
      currency: "USD",
      notes: "DEMO DATA",
      is_demo: true,
      created_by: admin.id,
      created_at: nowIso(),
      updated_at: nowIso(),
    });

    // Strip any accidental access rows for this client
    store.userClientAccess = store.userClientAccess.filter(
      (a) => a.client_id !== orphanId,
    );

    await expect(assertClientAccess(admin.id, orphanId)).resolves.toBeUndefined();
  });

  it("assertAdmin allows admin and rejects operator", () => {
    resetDemoStore();
    const store = getDemoStore();
    const admin = store.profiles.find((p) => p.role === "admin")!;
    const operator = store.profiles.find((p) => p.role === "operator")!;

    expect(() => assertAdmin(admin)).not.toThrow();
    expect(() => assertAdmin({ profile: admin } as never)).not.toThrow();
    expect(() => assertAdmin(operator)).toThrow(AuthorizationError);
    expect(() => assertAdmin(null)).toThrow(AuthorizationError);
  });
});
