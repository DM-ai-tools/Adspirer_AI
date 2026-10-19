import { describe, expect, it, vi } from "vitest";
import { getDemoStore } from "@/lib/demo/store";

vi.mock("@/lib/security/auth", () => ({ getCurrentUser: vi.fn() }));
import { getCurrentUser } from "@/lib/security/auth";

const as = (role: "admin" | "operator") => {
  const p = getDemoStore().profiles.find((x) => x.role === role)!;
  vi.mocked(getCurrentUser).mockResolvedValue({ id: p.id, email: p.email, profile: p });
  return p;
};
const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json", host: "app.test" }, body: JSON.stringify(body) });

describe("team routes", () => {
  it("lets an admin invite with a role and returns the link when email isn't configured", async () => {
    as("admin");
    const { POST, GET } = await import("@/app/api/admin/team/route");
    const res = await POST(new Request("http://app.test/api/admin/team", json({ email: "hire@example.com", role: "admin" })));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { member: { role: string; status: string }; link: string } };
    expect(body.data.member).toMatchObject({ role: "admin", status: "invited" });
    expect(body.data.link).toMatch(/\/auth\/confirm\?token_hash=/);
    const list = (await (await GET()).json()) as { data: { members: Array<{ email: string }> } };
    expect(list.data.members.some((m) => m.email === "hire@example.com")).toBe(true);
  });

  it("refuses non-admins", async () => {
    as("operator");
    const { POST } = await import("@/app/api/admin/team/route");
    const res = await POST(new Request("http://app.test/api/admin/team", json({ email: "x@example.com" })));
    expect(res.status).toBe(403);
  });

  it("sends a password reset link, never a password", async () => {
    const admin = as("admin");
    const { POST } = await import("@/app/api/admin/team/[id]/password-reset/route");
    const res = await POST(new Request("http://app.test/x", { method: "POST", headers: { host: "app.test" } }), { params: Promise.resolve({ id: admin.id }) });
    const body = (await res.json()) as { data: { link: string } };
    expect(body.data.link).toMatch(/type=recovery/);
    expect(JSON.stringify(body)).not.toMatch(/"password"/);
  });

  it("rejects a weak new password", async () => {
    as("operator");
    const { POST } = await import("@/app/api/auth/set-password/route");
    const res = await POST(new Request("http://app.test/x", json({ password: "abc" })));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: { message?: string } }).error?.message ?? "").toMatch(/10 characters/);
  });

  it("the confirm link never redirects off-site", async () => {
    const { GET } = await import("@/app/auth/confirm/route");
    const res = await GET(new Request("http://app.test/auth/confirm?token_hash=t&type=invite&next=//evil.com", { headers: { host: "app.test" } }));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toMatch(/^https:\/\/app\.test\/login\?error=/);
  });
});
