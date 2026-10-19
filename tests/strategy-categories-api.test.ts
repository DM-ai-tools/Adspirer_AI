import { describe, expect, it, vi } from "vitest";
import { getDemoStore } from "@/lib/demo/store";

vi.mock("@/lib/security/auth", () => ({ getCurrentUser: vi.fn() }));
import { getCurrentUser } from "@/lib/security/auth";

const CLIENT = "client_modern_dental";

const as = (role: "admin" | "operator") => {
  const p = getDemoStore().profiles.find((x) => x.role === role)!;
  vi.mocked(getCurrentUser).mockResolvedValue({ id: p.id, email: p.email, profile: p });
  return p;
};
const req = (method: string, body?: unknown) =>
  new Request("http://app.test/x", {
    method,
    headers: { "content-type": "application/json", host: "app.test" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const listCtx = (id = CLIENT) => ({ params: Promise.resolve({ id }) });
const itemCtx = (serviceId: string, id = CLIENT) => ({ params: Promise.resolve({ id, serviceId }) });

type Svc = { id: string; name: string; gross_margin_pct?: number | null; average_order_value_cents?: number | null; url_patterns?: string[] | null };
const create = async (body: unknown) => {
  const { POST } = await import("@/app/api/clients/[id]/services/route");
  return POST(req("POST", body), listCtx());
};

describe("strategy categories API", () => {
  it("stores margin, AOV and URL patterns on create", async () => {
    as("operator");
    const res = await create({ name: "Bar stools", gross_margin_pct: 40, average_order_value_cents: 18900, url_patterns: ["/collections/bar-stools"] });
    expect(res.status).toBe(201);
    const { service } = ((await res.json()) as { data: { service: Svc } }).data;
    expect(service).toMatchObject({ gross_margin_pct: 40, average_order_value_cents: 18900, url_patterns: ["/collections/bar-stools"] });
    expect(getDemoStore().clientServices.find((s) => s.id === service.id)?.gross_margin_pct).toBe(40);
  });

  it("PATCH updates only the given field", async () => {
    as("operator");
    const { service } = ((await (await create({ name: "Patch me", gross_margin_pct: 40, average_order_value_cents: 5000 })).json()) as { data: { service: Svc } }).data;
    const { PATCH } = await import("@/app/api/clients/[id]/services/[serviceId]/route");
    const res = await PATCH(req("PATCH", { gross_margin_pct: 55 }), itemCtx(service.id));
    expect(res.status).toBe(200);
    const updated = ((await res.json()) as { data: { service: Svc } }).data.service;
    expect(updated).toMatchObject({ name: "Patch me", gross_margin_pct: 55, average_order_value_cents: 5000 });
  });

  it("PATCH rejects a margin over 100", async () => {
    as("operator");
    const { service } = ((await (await create({ name: "Bad margin" })).json()) as { data: { service: Svc } }).data;
    const { PATCH } = await import("@/app/api/clients/[id]/services/[serviceId]/route");
    const res = await PATCH(req("PATCH", { gross_margin_pct: 140 }), itemCtx(service.id));
    expect(res.status).toBe(400);
  });

  it("DELETE removes the row", async () => {
    as("operator");
    const { service } = ((await (await create({ name: "Delete me" })).json()) as { data: { service: Svc } }).data;
    const { DELETE } = await import("@/app/api/clients/[id]/services/[serviceId]/route");
    const res = await DELETE(req("DELETE"), itemCtx(service.id));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { ok: boolean } }).data.ok).toBe(true);
    expect(getDemoStore().clientServices.some((s) => s.id === service.id)).toBe(false);
  });

  it("404s when the service belongs to another client", async () => {
    as("admin");
    const { service } = ((await (await create({ name: "Other client row" })).json()) as { data: { service: Svc } }).data;
    const { PATCH, DELETE } = await import("@/app/api/clients/[id]/services/[serviceId]/route");
    const other = "client_clicktrends";
    expect((await PATCH(req("PATCH", { priority: 1 }), itemCtx(service.id, other))).status).toBe(404);
    expect((await DELETE(req("DELETE"), itemCtx(service.id, other))).status).toBe(404);
    expect(getDemoStore().clientServices.some((s) => s.id === service.id)).toBe(true);
  });

  it("409s on a duplicate name (ignoring case) on POST and on a rename via PATCH", async () => {
    as("operator");
    expect((await create({ name: "Sofas" })).status).toBe(201);
    expect((await create({ name: "  sofas " })).status).toBe(409);
    const { service } = ((await (await create({ name: "Rugs" })).json()) as { data: { service: Svc } }).data;
    const { PATCH } = await import("@/app/api/clients/[id]/services/[serviceId]/route");
    expect((await PATCH(req("PATCH", { name: "SOFAS" }), itemCtx(service.id))).status).toBe(409);
    // renaming to its own name (different case) is fine
    expect((await PATCH(req("PATCH", { name: "RUGS" }), itemCtx(service.id))).status).toBe(200);
  });

  it("GET with seed=0 lists active and inactive rows and never seeds a default", async () => {
    as("operator");
    const { GET } = await import("@/app/api/clients/[id]/services/route");
    const get = (id: string) =>
      GET(new Request(`http://app.test/api/clients/${id}/services?seed=0`, { headers: { host: "app.test" } }), listCtx(id));
    const empty = await get("client_trafficradius");
    expect(empty.status).toBe(200);
    expect(((await empty.json()) as { data: { services: Svc[] } }).data.services).toEqual([]);
    expect(getDemoStore().clientServices.filter((s) => s.client_id === "client_trafficradius")).toEqual([]);

    getDemoStore().clientServices.find((s) => s.id === "svc_mdc_veneers")!.is_active = false;
    const listed = ((await (await get(CLIENT)).json()) as { data: { services: Svc[] } }).data.services;
    expect(listed.map((s) => s.id).sort()).toEqual(["svc_mdc_implants", "svc_mdc_veneers"]);
  });

  it("403s a user without client access", async () => {
    const store = getDemoStore();
    const op = as("operator");
    const { service } = ((await (await create({ name: "Guarded" })).json()) as { data: { service: Svc } }).data;
    store.userClientAccess = store.userClientAccess.filter((a) => !(a.user_id === op.id && a.client_id === CLIENT));
    const { PATCH, DELETE } = await import("@/app/api/clients/[id]/services/[serviceId]/route");
    expect((await PATCH(req("PATCH", { priority: 2 }), itemCtx(service.id))).status).toBe(403);
    expect((await DELETE(req("DELETE"), itemCtx(service.id))).status).toBe(403);
    expect((await create({ name: "Nope" })).status).toBe(403);
  });
});
