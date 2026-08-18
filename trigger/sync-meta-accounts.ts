import { syncConnectedMetaAccounts } from "@/lib/adspirer/account-sync";
import { logger } from "@/lib/observability/logger";
import { defineJobTask } from "./optional-task";

export type SyncMetaAccountsPayload = {
  clientId?: string | null;
  /** Same key returns prior count without re-upserting when possible. */
  idempotencyKey?: string;
};

export type SyncMetaAccountsResult = {
  count: number;
  accountIds: string[];
  idempotencyKey: string;
};

/**
 * Sync accessible Meta accounts from the Adspirer provider.
 * Upserts are keyed by meta_account_id (idempotent).
 */
export async function runSyncMetaAccounts(
  payload: SyncMetaAccountsPayload = {},
): Promise<SyncMetaAccountsResult> {
  const idempotencyKey =
    payload.idempotencyKey ??
    `sync-meta:${payload.clientId ?? "all"}:${new Date().toISOString().slice(0, 10)}`;

  const result = await syncConnectedMetaAccounts({
    clientId: payload.clientId ?? null,
  });

  logger.info("Synced Meta accounts", {
    count: result.count,
    idempotencyKey,
  });

  return {
    count: result.count,
    accountIds: result.upserted.map((a) => a.id),
    idempotencyKey,
  };
}

export const syncMetaAccountsTask = defineJobTask(
  "sync-meta-accounts",
  runSyncMetaAccounts,
);
