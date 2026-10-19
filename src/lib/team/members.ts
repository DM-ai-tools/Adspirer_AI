import { randomBytes } from "node:crypto";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { ValidationError, NotFoundError } from "@/lib/errors";
import { logger } from "@/lib/observability/logger";
import { nowIso } from "@/lib/utils";
import type { Profile, UserRole } from "@/types";

/**
 * Team membership: invite-only accounts on Supabase Auth.
 *
 * An admin invites someone by email with a role (and, for operators, the
 * clients they may see). Supabase creates the account and gives us a
 * one-time token; we email a link to /auth/confirm, which signs them in and
 * sends them to /welcome to choose a password. Passwords are never stored or
 * shown by CampaignForge — Supabase keeps only a one-way hash; admins can
 * send a reset link instead.
 */

export type MemberStatus = "invited" | "active" | "deactivated";

export type TeamMember = {
  id: string;
  email: string;
  fullName: string | null;
  role: UserRole;
  status: MemberStatus;
  invitedAt: string | null;
  lastSignInAt: string | null;
  createdAt: string;
  clientIds: string[];
};

export type LinkType = "invite" | "magiclink" | "recovery";

type AuthInfo = { invitedAt: string | null; lastSignInAt: string | null };

/** Where the app is reachable from outside (invite links point here). */
export function appBaseUrl(request: Request): string {
  const configured = (process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL)?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!host) return new URL(request.url).origin;
  const proto = request.headers.get("x-forwarded-proto") ?? (/^(localhost|127\.)/.test(host) ? "http" : "https");
  return `${proto.split(",")[0]!.trim()}://${host}`;
}

export function confirmLink(baseUrl: string, tokenHash: string, type: LinkType): string {
  const params = new URLSearchParams({ token_hash: tokenHash, type, next: "/welcome" });
  return `${baseUrl}/auth/confirm?${params.toString()}`;
}

/** A same-site path to continue to after confirming; anything else → /welcome. */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/welcome";
  return next;
}

/** null when acceptable, otherwise the reason. */
export function validateNewPassword(password: string): string | null {
  if (password.length < 10) return "Use at least 10 characters.";
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return "Use at least one letter and one number.";
  return null;
}

// ---------------------------------------------------------------------------
// Email (Resend). Without RESEND_API_KEY + EMAIL_FROM the admin gets the link
// to share themselves.
// ---------------------------------------------------------------------------

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export async function sendTeamEmail(
  input: { to: string; kind: "invite" | "reset"; link: string; inviterName: string | null; role: UserRole },
  options: { apiKey?: string; from?: string; fetchImpl?: typeof fetch } = {
    apiKey: process.env.RESEND_API_KEY,
    from: process.env.EMAIL_FROM,
  },
): Promise<{ sent: boolean; reason?: string }> {
  if (!options.apiKey || !options.from) return { sent: false, reason: "email isn't set up yet (RESEND_API_KEY and EMAIL_FROM)" };
  const invite = input.kind === "invite";
  const subject = invite ? "You've been invited to CampaignForge" : "Reset your CampaignForge password";
  const who = input.inviterName ? escapeHtml(input.inviterName) : "Your administrator";
  const lead = invite
    ? `${who} invited you to CampaignForge as ${input.role === "admin" ? "an admin" : "an operator"}.`
    : `${who} sent you a link to set a new CampaignForge password.`;
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;color:#111;line-height:1.5">
<p>${lead}</p>
<p><a href="${escapeHtml(input.link)}" style="display:inline-block;background:#0f766e;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">${invite ? "Accept invite" : "Set a new password"}</a></p>
<p style="color:#555;font-size:13px">The link works once and expires in 24 hours. If you weren't expecting this, ignore this email.</p>
</div>`;
  try {
    const res = await (options.fetchImpl ?? fetch)("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: options.from, to: [input.to], subject, html }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { sent: false, reason: `the email service refused it (HTTP ${res.status}${detail ? `: ${detail.slice(0, 160)}` : ""})` };
    }
    return { sent: true };
  } catch (error) {
    return { sent: false, reason: error instanceof Error ? error.message : "the email service couldn't be reached" };
  }
}

// ---------------------------------------------------------------------------
// Backends: Supabase (live) and the in-memory demo store
// ---------------------------------------------------------------------------

type Backend = {
  listProfiles(): Promise<Profile[]>;
  getProfile(id: string): Promise<Profile | null>;
  findProfileByEmail(email: string): Promise<Profile | null>;
  authInfo(): Promise<Map<string, AuthInfo>>;
  /** Creates the account for "invite"; returns the one-time token. */
  generateLink(type: LinkType, email: string, fullName: string | null): Promise<{ userId: string; tokenHash: string }>;
  upsertProfile(profile: Pick<Profile, "id" | "email" | "full_name" | "role" | "is_active">): Promise<Profile>;
  setActive(id: string, active: boolean): Promise<void>;
  clientAccess(): Promise<Array<{ user_id: string; client_id: string }>>;
  setClientAccess(userId: string, clientIds: string[], grantedBy: string): Promise<void>;
};

// Demo mode: invite state kept on globalThis so every route bundle shares it.
const demoAuthStore = globalThis as typeof globalThis & { __campaignforgeDemoAuth?: Map<string, AuthInfo> };
const demoAuth = (demoAuthStore.__campaignforgeDemoAuth ??= new Map<string, AuthInfo>());

function demoBackend(): Backend {
  const store = getDemoStore();
  return {
    listProfiles: async () => store.profiles,
    getProfile: async (id) => store.profiles.find((p) => p.id === id) ?? null,
    findProfileByEmail: async (email) => store.profiles.find((p) => p.email.toLowerCase() === email) ?? null,
    authInfo: async () => demoAuth,
    async generateLink(type, email) {
      const profile = store.profiles.find((p) => p.email.toLowerCase() === email);
      if (type === "invite") {
        const id = `profile_${randomBytes(6).toString("hex")}`;
        demoAuth.set(id, { invitedAt: nowIso(), lastSignInAt: null });
        return { userId: id, tokenHash: `demo_${randomBytes(12).toString("hex")}` };
      }
      if (!profile) throw new NotFoundError("Member not found.");
      return { userId: profile.id, tokenHash: `demo_${randomBytes(12).toString("hex")}` };
    },
    async upsertProfile(p) {
      const ts = nowIso();
      const i = store.profiles.findIndex((x) => x.id === p.id);
      const next: Profile = { avatar_url: null, created_at: ts, ...(i >= 0 ? store.profiles[i] : {}), ...p, updated_at: ts } as Profile;
      if (i >= 0) store.profiles[i] = next;
      else store.profiles.push(next);
      return next;
    },
    async setActive(id, active) {
      const p = store.profiles.find((x) => x.id === id);
      if (p) Object.assign(p, { is_active: active, updated_at: nowIso() });
    },
    clientAccess: async () => store.userClientAccess,
    async setClientAccess(userId, clientIds, grantedBy) {
      store.userClientAccess = store.userClientAccess.filter((a) => a.user_id !== userId);
      for (const client_id of clientIds) {
        store.userClientAccess.push({ id: `uca_${randomBytes(5).toString("hex")}`, user_id: userId, client_id, granted_by: grantedBy, created_at: nowIso() });
      }
    },
  };
}

function supabaseBackend(): Backend {
  const admin = async () => (await import("@/lib/supabase/admin")).createAdminClient();
  return {
    async listProfiles() {
      const { data, error } = await (await admin()).from("profiles").select("*").order("created_at", { ascending: true });
      if (error) throw new Error(error.message);
      return (data ?? []) as Profile[];
    },
    async getProfile(id) {
      const { data } = await (await admin()).from("profiles").select("*").eq("id", id).maybeSingle();
      return (data as Profile | null) ?? null;
    },
    async findProfileByEmail(email) {
      const { data } = await (await admin()).from("profiles").select("*").ilike("email", email).maybeSingle();
      return (data as Profile | null) ?? null;
    },
    async authInfo() {
      const out = new Map<string, AuthInfo>();
      const supabase = await admin();
      for (let page = 1; page <= 10; page++) {
        const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
        if (error) throw new Error(error.message);
        for (const u of data.users) {
          out.set(u.id, { invitedAt: u.invited_at ?? null, lastSignInAt: u.last_sign_in_at ?? null });
        }
        if (data.users.length < 1000) break;
      }
      return out;
    },
    async generateLink(type, email, fullName) {
      const supabase = await admin();
      const { data, error } =
        type === "invite"
          ? await supabase.auth.admin.generateLink({ type: "invite", email, options: { data: fullName ? { full_name: fullName } : {} } })
          : await supabase.auth.admin.generateLink({ type, email });
      if (error || !data.user || !data.properties?.hashed_token) {
        throw new ValidationError(error?.message ?? "Supabase couldn't create the sign-in link.");
      }
      return { userId: data.user.id, tokenHash: data.properties.hashed_token };
    },
    async upsertProfile(p) {
      const { data, error } = await (await admin()).from("profiles").upsert({ ...p, updated_at: nowIso() }, { onConflict: "id" }).select("*").single();
      if (error) throw new Error(error.message);
      return data as Profile;
    },
    async setActive(id, active) {
      const supabase = await admin();
      const { error } = await supabase.from("profiles").update({ is_active: active, updated_at: nowIso() }).eq("id", id);
      if (error) throw new Error(error.message);
      // Also stop (or allow) sign-in at Supabase, not only inside the app.
      const { error: banError } = await supabase.auth.admin.updateUserById(id, { ban_duration: active ? "none" : "876000h" });
      if (banError) logger.warn("team.ban_update_failed", { userId: id, message: banError.message });
    },
    async clientAccess() {
      const { data, error } = await (await admin()).from("user_client_access").select("user_id, client_id");
      if (error) throw new Error(error.message);
      return (data ?? []) as Array<{ user_id: string; client_id: string }>;
    },
    async setClientAccess(userId, clientIds, grantedBy) {
      const supabase = await admin();
      const { error } = await supabase.from("user_client_access").delete().eq("user_id", userId);
      if (error) throw new Error(error.message);
      if (clientIds.length) {
        const { error: insertError } = await supabase
          .from("user_client_access")
          .insert(clientIds.map((client_id) => ({ user_id: userId, client_id, granted_by: grantedBy })));
        if (insertError) throw new Error(insertError.message);
      }
    },
  };
}

function backend(): Backend {
  const config = getConfig();
  return config.isDemoMode || !config.hasSupabase ? demoBackend() : supabaseBackend();
}

function toMember(profile: Profile, auth: AuthInfo | undefined, access: Array<{ user_id: string; client_id: string }>): TeamMember {
  // Profiles without an auth record (e.g. demo personas) have signed in before.
  const signedIn = auth ? auth.lastSignInAt != null : true;
  return {
    id: profile.id,
    email: profile.email,
    fullName: profile.full_name,
    role: profile.role,
    status: !profile.is_active ? "deactivated" : signedIn ? "active" : "invited",
    invitedAt: auth?.invitedAt ?? null,
    lastSignInAt: auth?.lastSignInAt ?? null,
    createdAt: profile.created_at,
    clientIds: access.filter((a) => a.user_id === profile.id).map((a) => a.client_id),
  };
}

async function memberById(b: Backend, id: string): Promise<TeamMember> {
  const profile = await b.getProfile(id);
  if (!profile) throw new NotFoundError("Member not found.");
  const [auth, access] = await Promise.all([b.authInfo(), b.clientAccess()]);
  return toMember(profile, auth.get(id), access);
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export async function listMembers(): Promise<TeamMember[]> {
  const b = backend();
  const [profiles, auth, access] = await Promise.all([b.listProfiles(), b.authInfo(), b.clientAccess()]);
  return profiles.map((p) => toMember(p, auth.get(p.id), access));
}

export type LinkResult = { member: TeamMember; emailed: boolean; link: string | null; emailError?: string };

async function deliver(member: TeamMember, kind: "invite" | "reset", link: string, by: Profile): Promise<LinkResult> {
  const email = await sendTeamEmail({ to: member.email, kind, link, inviterName: by.full_name ?? by.email, role: member.role });
  // The link only goes back to the admin when it couldn't be emailed.
  return email.sent ? { member, emailed: true, link: null } : { member, emailed: false, link, emailError: email.reason };
}

export async function inviteMember(input: {
  email: string;
  fullName: string | null;
  role: UserRole;
  clientIds: string[];
  invitedBy: Profile;
  baseUrl: string;
}): Promise<LinkResult> {
  const b = backend();
  const email = input.email.trim().toLowerCase();
  if (await b.findProfileByEmail(email)) {
    throw new ValidationError(`${email} is already on the team — resend their invite or send a password reset instead.`);
  }
  const fullName = input.fullName?.trim() || null;
  const { userId, tokenHash } = await b.generateLink("invite", email, fullName);
  await b.upsertProfile({ id: userId, email, full_name: fullName ?? email.split("@")[0]!, role: input.role, is_active: true });
  // Admins see every client; operators see only the ones granted.
  await b.setClientAccess(userId, input.role === "admin" ? [] : input.clientIds, input.invitedBy.id);
  const member = await memberById(b, userId);
  return deliver(member, "invite", confirmLink(input.baseUrl, tokenHash, "invite"), input.invitedBy);
}

export async function resendInvite(userId: string, by: Profile, baseUrl: string): Promise<LinkResult> {
  const b = backend();
  const member = await memberById(b, userId);
  if (member.status === "active") {
    throw new ValidationError(`${member.email} has already signed in — send a password reset instead.`);
  }
  if (member.status === "deactivated") throw new ValidationError(`${member.email} is deactivated — reactivate them first.`);
  const { tokenHash } = await b.generateLink("magiclink", member.email, member.fullName);
  return deliver(member, "invite", confirmLink(baseUrl, tokenHash, "magiclink"), by);
}

export async function sendPasswordReset(userId: string, by: Profile, baseUrl: string): Promise<LinkResult> {
  const b = backend();
  const member = await memberById(b, userId);
  if (member.status === "deactivated") throw new ValidationError(`${member.email} is deactivated — reactivate them first.`);
  const { tokenHash } = await b.generateLink("recovery", member.email, member.fullName);
  return deliver(member, "reset", confirmLink(baseUrl, tokenHash, "recovery"), by);
}

export async function setMemberActive(userId: string, active: boolean, by: Profile): Promise<TeamMember> {
  if (!active && userId === by.id) throw new ValidationError("You can't deactivate your own account.");
  const b = backend();
  if (!(await b.getProfile(userId))) throw new NotFoundError("Member not found.");
  await b.setActive(userId, active);
  return memberById(b, userId);
}

export async function updateMember(
  userId: string,
  patch: { role?: UserRole; fullName?: string | null; clientIds?: string[] },
  by: Profile,
): Promise<TeamMember> {
  const b = backend();
  const profile = await b.getProfile(userId);
  if (!profile) throw new NotFoundError("Member not found.");
  if (patch.role && patch.role !== "admin" && userId === by.id) {
    throw new ValidationError("You can't remove your own admin role.");
  }
  await b.upsertProfile({
    id: profile.id,
    email: profile.email,
    full_name: patch.fullName !== undefined ? patch.fullName : profile.full_name,
    role: patch.role ?? profile.role,
    is_active: profile.is_active,
  });
  if (patch.clientIds) await b.setClientAccess(userId, patch.clientIds, by.id);
  return memberById(b, userId);
}
