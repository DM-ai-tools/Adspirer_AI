import type { Approval } from "@/types";

/** The approved/edited approval whose args are exactly these tool args. */
export function findMatchingApproval(approvals: Approval[], args: Record<string, unknown>): string | null {
  const wanted = JSON.stringify(args);
  return approvals.find((a) => JSON.stringify(a.edited_args ?? a.proposed_args) === wanted)?.id ?? null;
}
