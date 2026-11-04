import { MetaGraphError } from "@/lib/meta/graph-client";

/** What the operator sees when the approver's token cannot change a catalogue. */
export const CATALOG_PERMISSION_MESSAGE =
  "The approver's Facebook connection cannot manage this catalogue: reconnect Facebook, or have someone with access approve.";

/**
 * missing_permission: the login or app lacks catalogue access. not_found: this one object is
 * unreadable. expired: the Facebook token expired or was revoked (Graph code 190).
 */
export type CatalogAccessReason = "missing_permission" | "not_found" | "expired";

/** The connected Facebook login cannot read this catalogue (or it does not exist). */
export class CatalogAccessError extends Error {
  constructor(
    readonly reason: CatalogAccessReason,
    message: string,
  ) {
    super(message);
    this.name = "CatalogAccessError";
  }
}

/** Classifies a Graph failure as a catalogue access problem, or null when it is something else. */
export function catalogAccessReason(error: unknown): CatalogAccessReason | null {
  if (!(error instanceof MetaGraphError)) return null;
  // 190: the token expired or was revoked.
  if (error.code === 190) return "expired";
  // 10: the app or login lacks the permission.
  if (error.code === 10) return "missing_permission";
  // Meta's "Unsupported get request. Object with ID ... does not exist, cannot be loaded due to missing
  // permissions, or does not support this operation" (code 100, subcode 33) mentions "permission" but
  // means this one object is unreadable. It must not be mistaken for a broken Facebook connection.
  if ((error.code === 100 && error.subcode === 33) || /does not exist, cannot be loaded/i.test(error.message)) {
    return "not_found";
  }
  if ((error.code === 100 || error.code === 200) && /not been approved|permission/i.test(error.message)) {
    return "missing_permission";
  }
  if (error.code === 803 || /does not exist/i.test(error.message)) return "not_found";
  return null;
}

/**
 * A code 10 or 200 permission error. On one product set it usually means the set belongs to a
 * business this login cannot see, not that the whole connection lacks catalogue access.
 */
export function isPerObjectPermissionError(error: unknown): boolean {
  return (
    error instanceof MetaGraphError &&
    (error.code === 10 || error.code === 200) &&
    catalogAccessReason(error) === "missing_permission"
  );
}
