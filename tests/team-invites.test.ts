import { describe, expect, it, vi } from "vitest";
import {
  appBaseUrl,
  confirmLink,
  inviteMember,
  listMembers,
  resendInvite,
  safeNextPath,
  sendPasswordReset,
  sendTeamEmail,
  setMemberActive,
  validateNewPassword,
} from "@/lib/team/members";
import { getDemoStore } from "@/lib/demo/store";

const ADMIN = () => getDemoStore().profiles.find((p) => p.role === "admin")!;
async function invited(email: string) {
  const { member } = await inviteMember({ email, fullName: null, role: "operator", clientIds: [], invitedBy: ADMIN(), baseUrl: "https://a.com" });
  return member;
}
const req = (headers: Record<string, string> = {}) => new Request("http://internal:8080/api/admin/team", { headers });

describe("invite links", () => {
  it("builds the confirm link on the app's public address", () => {
    const prev = process.env.APP_URL;
    process.env.APP_URL = "https://app.example.com/";
    expect(appBaseUrl(req())).toBe("https://app.example.com");
    delete process.env.APP_URL;
    expect(appBaseUrl(req({ "x-forwarded-host": "adspirer.up.railway.app", "x-forwarded-proto": "https" }))).toBe(
      "https://adspirer.up.railway.app",
    );
    if (prev) process.env.APP_URL = prev;
    expect(confirmLink("https://a.com", "tok en", "invite")).toBe("https://a.com/auth/confirm?token_hash=tok+en&type=invite&next=%2Fwelcome");
  });

  it("only redirects within the app after confirming", () => {
    expect(safeNextPath("/welcome")).toBe("/welcome");
    expect(safeNextPath("//evil.com")).toBe("/welcome");
    expect(safeNextPath("https://evil.com")).toBe("/welcome");
    expect(safeNextPath("/\\evil.com")).toBe("/welcome");
    expect(safeNextPath(null)).toBe("/welcome");
  });

  it("requires a reasonable password", () => {
    expect(validateNewPassword("short1")).toMatch(/10 characters/);
    expect(validateNewPassword("onlyletterslong")).toMatch(/number/);
    expect(validateNewPassword("Longenough123")).toBeNull();
  });
});

describe("invite email (Resend)", () => {
  it("sends through Resend when configured, and says why not otherwise", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: "em_1" }), { status: 200 }));
    const sent = await sendTeamEmail(
      { to: "new@x.com", kind: "invite", link: "https://a.com/auth/confirm?x=1", inviterName: "Rithin", role: "operator" },
      { apiKey: "re_test", from: "CampaignForge <team@x.com>", fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(sent).toEqual({ sent: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ from: "CampaignForge <team@x.com>", to: ["new@x.com"] });
    expect(body.html).toContain("https://a.com/auth/confirm?x=1");
    expect(await sendTeamEmail({ to: "a@x.com", kind: "reset", link: "l", inviterName: null, role: "admin" }, { apiKey: undefined, from: undefined })).toMatchObject({
      sent: false,
    });
  });
});

describe("team members (demo store)", () => {
  it("invites a member with a role and client access, and hands back the link when email isn't set up", async () => {
    const store = getDemoStore();
    const client = store.clients[0]!;
    const result = await inviteMember({
      email: "New.Operator@Example.com",
      fullName: "New Operator",
      role: "operator",
      clientIds: [client.id],
      invitedBy: ADMIN(),
      baseUrl: "https://app.example.com",
    });
    expect(result.member).toMatchObject({ email: "new.operator@example.com", role: "operator", status: "invited", clientIds: [client.id] });
    expect(result.emailed).toBe(false);
    expect(result.link).toMatch(/^https:\/\/app\.example\.com\/auth\/confirm\?token_hash=.+&type=invite/);
    await expect(
      inviteMember({ email: "new.operator@example.com", fullName: "", role: "operator", clientIds: [], invitedBy: ADMIN(), baseUrl: "https://a" }),
    ).rejects.toThrow(/already/);
  });

  it("resends an invite only to someone who hasn't signed in, and sends resets to anyone", async () => {
    const member = await invited("resend.me@example.com");
    expect((await resendInvite(member.id, ADMIN(), "https://a.com")).link).toMatch(/type=magiclink/);
    const admin = ADMIN();
    await expect(resendInvite(admin.id, admin, "https://a.com")).rejects.toThrow(/already signed in/);
    expect((await sendPasswordReset(admin.id, admin, "https://a.com")).link).toMatch(/type=recovery/);
  });

  it("deactivating blocks the member; an admin can't deactivate themselves", async () => {
    const member = await invited("deactivate.me@example.com");
    const after = await setMemberActive(member.id, false, ADMIN());
    expect(after.status).toBe("deactivated");
    await expect(setMemberActive(ADMIN().id, false, ADMIN())).rejects.toThrow(/your own/);
    expect((await setMemberActive(member.id, true, ADMIN())).status).toBe("invited");
  });

  it("never exposes passwords or tokens in the member list", async () => {
    await invited("listed@example.com");
    const json = JSON.stringify(await listMembers());
    expect(json).not.toMatch(/password|token_hash|encrypted/i);
  });
});
