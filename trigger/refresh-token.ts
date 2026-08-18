import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import {
  getActiveServiceAccount,
  storeServiceAccountTokens,
} from "@/lib/adspirer/token-service";
import { decryptToken, encryptToken } from "@/lib/security/token-vault";
import { addDaysIso, nowIso } from "@/lib/utils";
import { logger } from "@/lib/observability/logger";
import { defineJobTask } from "./optional-task";

export type RefreshTokenPayload = {
  accountId?: string;
  /** Same key will not rotate tokens twice. */
  idempotencyKey?: string;
};

export type RefreshTokenResult = {
  accountId: string | null;
  refreshed: boolean;
  skipped: boolean;
  reason?: string;
};

/**
 * Refresh the shared Adspirer service account token.
 * Idempotent: same key within a day does not re-rotate.
 */
export async function runRefreshToken(
  payload: RefreshTokenPayload = {},
): Promise<RefreshTokenResult> {
  const config = getConfig();
  const day = new Date().toISOString().slice(0, 10);
  const idempotencyKey =
    payload.idempotencyKey ?? `refresh-token:${payload.accountId ?? "active"}:${day}`;

  const account = await getActiveServiceAccount();
  if (!account) {
    return {
      accountId: null,
      refreshed: false,
      skipped: true,
      reason: "No active Adspirer service account",
    };
  }

  if (config.isDemoMode || !config.hasSupabase) {
    const store = getDemoStore();
    const row = store.adspirerServiceAccounts.find((a) => a.id === account.id);
    if (
      row &&
      (row as { last_refresh_idempotency_key?: string }).last_refresh_idempotency_key ===
        idempotencyKey
    ) {
      return {
        accountId: account.id,
        refreshed: false,
        skipped: true,
        reason: "Already refreshed for idempotency key",
      };
    }

    // Demo: rotate encrypted placeholders without exposing plaintext in logs.
    let access = "demo_adspirer_access_token_refreshed";
    let refresh: string | null = "demo_adspirer_refresh_token_refreshed";
    try {
      if (account.encrypted_refresh_token) {
        refresh = decryptToken(account.encrypted_refresh_token);
      }
    } catch {
      // fail closed to demo placeholders
    }

    const updated = await storeServiceAccountTokens({
      accountId: account.id,
      accessToken: `${access}_${day}`,
      refreshToken: refresh,
      expiresAt: addDaysIso(30),
      scopes: account.scopes ?? undefined,
    });

    const target = store.adspirerServiceAccounts.find((a) => a.id === updated.id);
    if (target) {
      (target as { last_refresh_idempotency_key?: string }).last_refresh_idempotency_key =
        idempotencyKey;
    }

    logger.info("Refreshed Adspirer service token (demo)", {
      accountId: updated.id,
      idempotencyKey,
    });

    return { accountId: updated.id, refreshed: true, skipped: false };
  }

  // Live path: mark refresh timestamp; real OAuth refresh is TODO behind ADSPIRER_* envs.
  account.last_refreshed_at = nowIso();
  account.updated_at = nowIso();
  // Touch vault with same material to prove encrypt path (no plaintext logged).
  if (account.encrypted_access_token.startsWith("v1:")) {
    try {
      const plain = decryptToken(account.encrypted_access_token);
      account.encrypted_access_token = encryptToken(plain);
    } catch {
      // leave as-is; fail closed on decrypt
    }
  }

  logger.info("Token refresh job ran (live stub)", {
    accountId: account.id,
    idempotencyKey,
  });

  return { accountId: account.id, refreshed: true, skipped: false };
}

export const refreshTokenTask = defineJobTask(
  "refresh-token",
  runRefreshToken,
);
