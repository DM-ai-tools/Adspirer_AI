import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import {
  decryptToken,
  encryptToken,
} from "@/lib/security/token-vault";
import {
  AdspirerTokenExpiredError,
  AdspirerConnectionError,
} from "@/lib/errors";
import { nowIso } from "@/lib/utils";
import { logger } from "@/lib/observability/logger";
import type { AdspirerServiceAccount } from "@/types";
import {
  mapServiceAccountRow,
  toServiceAccountDbPayload,
} from "@/lib/adspirer/db-map";

const SERVICE_ACCOUNT_TABLE = "adspirer_service_account";

export type DecryptedTokens = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  account: AdspirerServiceAccount;
};

/**
 * Server-only token service. Never expose decrypted tokens to the browser.
 */
export async function getActiveServiceAccount(): Promise<AdspirerServiceAccount | null> {
  const config = getConfig();

  if (config.isDemoMode || !config.hasSupabase) {
    return (
      getDemoStore().adspirerServiceAccounts.find((a) => a.is_active) ?? null
    );
  }

  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from(SERVICE_ACCOUNT_TABLE)
    .select("*")
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new AdspirerConnectionError("Failed to load Adspirer service account", {
      reason: error.message,
    });
  }

  return data ? mapServiceAccountRow(data as Record<string, unknown>) : null;
}

export async function storeServiceAccountTokens(input: {
  accountId?: string;
  label?: string;
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: string | null;
  scopes?: string[] | null;
}): Promise<AdspirerServiceAccount> {
  const encryptedAccess = encryptToken(input.accessToken);
  const encryptedRefresh = input.refreshToken
    ? encryptToken(input.refreshToken)
    : null;
  const ts = nowIso();
  const config = getConfig();

  if (config.isDemoMode || !config.hasSupabase) {
    const store = getDemoStore();
    const existing = input.accountId
      ? store.adspirerServiceAccounts.find((a) => a.id === input.accountId)
      : store.adspirerServiceAccounts.find((a) => a.is_active);

    if (existing) {
      existing.encrypted_access_token = encryptedAccess;
      existing.encrypted_refresh_token = encryptedRefresh;
      existing.token_expires_at = input.expiresAt ?? null;
      existing.scopes = input.scopes ?? existing.scopes;
      existing.last_refreshed_at = ts;
      existing.updated_at = ts;
      existing.is_active = true;
      logger.info("Updated Adspirer service account tokens (demo)", {
        accountId: existing.id,
      });
      return existing;
    }

    const created: AdspirerServiceAccount = {
      id: `asa_${Date.now()}`,
      label: input.label ?? "Adspirer Shared Service Account",
      encrypted_access_token: encryptedAccess,
      encrypted_refresh_token: encryptedRefresh,
      token_expires_at: input.expiresAt ?? null,
      scopes: input.scopes ?? null,
      is_active: true,
      last_refreshed_at: ts,
      created_at: ts,
      updated_at: ts,
    };
    store.adspirerServiceAccounts.push(created);
    return created;
  }

  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const payload = toServiceAccountDbPayload({
    label: input.label,
    encryptedAccess,
    encryptedRefresh,
    expiresAt: input.expiresAt,
    scopes: input.scopes,
    isActive: true,
    lastRefreshedAt: ts,
    updatedAt: ts,
  });

  if (input.accountId) {
    const { data, error } = await supabase
      .from(SERVICE_ACCOUNT_TABLE)
      .update(payload)
      .eq("id", input.accountId)
      .select("*")
      .single();
    if (error) {
      throw new AdspirerConnectionError("Failed to update service account tokens", {
        reason: error.message,
      });
    }
    return mapServiceAccountRow(data as Record<string, unknown>);
  }

  const { data, error } = await supabase
    .from(SERVICE_ACCOUNT_TABLE)
    .insert(payload)
    .select("*")
    .single();

  if (error) {
    throw new AdspirerConnectionError("Failed to store service account tokens", {
      reason: error.message,
    });
  }
  return mapServiceAccountRow(data as Record<string, unknown>);
}

/**
 * Decrypt and return tokens for server-side provider use only.
 * Throws AdspirerTokenExpiredError if past expiry.
 */
export async function retrieveDecryptedTokens(): Promise<DecryptedTokens> {
  const account = await getActiveServiceAccount();
  if (!account) {
    throw new AdspirerConnectionError("No active Adspirer service account");
  }

  if (
    account.token_expires_at &&
    new Date(account.token_expires_at).getTime() < Date.now()
  ) {
    throw new AdspirerTokenExpiredError("Adspirer access token expired", {
      accountId: account.id,
    });
  }

  const accessToken = decryptToken(account.encrypted_access_token);
  const refreshToken = account.encrypted_refresh_token
    ? decryptToken(account.encrypted_refresh_token)
    : null;

  return {
    accessToken,
    refreshToken,
    expiresAt: account.token_expires_at,
    account,
  };
}
