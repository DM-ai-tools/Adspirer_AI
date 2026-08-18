import type { Profile, UserRole } from "@/types";
import { AuthorizationError } from "@/lib/errors";

export function isAdmin(profile: Pick<Profile, "role"> | null | undefined): boolean {
  return profile?.role === "admin";
}

export function isOperator(
  profile: Pick<Profile, "role"> | null | undefined,
): boolean {
  return profile?.role === "operator" || profile?.role === "admin";
}

export function requireAdmin(
  profile: Pick<Profile, "role"> | null | undefined,
): asserts profile is Pick<Profile, "role"> {
  if (!isAdmin(profile)) {
    throw new AuthorizationError("Admin role required");
  }
}

export function requireRole(
  profile: Pick<Profile, "role"> | null | undefined,
  roles: UserRole[],
): asserts profile is Pick<Profile, "role"> {
  if (!profile || !roles.includes(profile.role)) {
    throw new AuthorizationError(
      `Required role: ${roles.join(" | ")}`,
      { requiredRoles: roles, actualRole: profile?.role ?? null },
    );
  }
}
