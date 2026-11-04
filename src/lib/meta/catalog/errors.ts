import { MetaGraphError } from "@/lib/meta/graph-client";

/** What the operator sees when the approver's token cannot change a catalogue. */
export const CATALOG_PERMISSION_MESSAGE =
  "The approver's Facebook connection cannot manage this catalogue: reconnect Facebook, or have someone with access approve.";

export type CatalogAccessReason = "missing_permission" | "not_found";

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
  // 190: the token expired or was revoked; 10: the app lacks the permission.
  if (error.code === 190 || error.code === 10) return "missing_permission";
  if ((error.code === 100 || error.code === 200) && /not been approved|permission/i.test(error.message)) {
    return "missing_permission";
  }
  if (error.code === 803 || /does not exist/i.test(error.message)) return "not_found";
  return null;
}
