import type { AccessMethod, AccessStatus, AdspirerServiceAccount, ConnectedMetaAccount } from "@/types";

/** DB row → app AdspirerServiceAccount (column names differ in migration). */
export function mapServiceAccountRow(
  row: Record<string, unknown>,
): AdspirerServiceAccount {
  return {
    id: String(row.id),
    label: String(row.label ?? "Adspirer Shared Service Account"),
    encrypted_access_token: String(
      row.access_token_encrypted ?? row.encrypted_access_token ?? "",
    ),
    encrypted_refresh_token:
      (row.refresh_token_encrypted as string | null | undefined) ??
      (row.encrypted_refresh_token as string | null | undefined) ??
      null,
    token_expires_at:
      (row.expires_at as string | null | undefined) ??
      (row.token_expires_at as string | null | undefined) ??
      null,
    scopes: (row.scopes as string[] | null) ?? null,
    is_active: Boolean(row.is_active),
    last_refreshed_at: (row.last_refreshed_at as string | null) ?? null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

/** App token fields → DB insert/update payload. */
export function toServiceAccountDbPayload(input: {
  label?: string;
  encryptedAccess: string;
  encryptedRefresh: string | null;
  expiresAt?: string | null;
  scopes?: string[] | null;
  isActive?: boolean;
  lastRefreshedAt?: string | null;
  updatedAt?: string;
}): Record<string, unknown> {
  return {
    label: input.label ?? "Adspirer Shared Service Account",
    access_token_encrypted: input.encryptedAccess,
    refresh_token_encrypted: input.encryptedRefresh,
    expires_at: input.expiresAt ?? null,
    scopes: input.scopes ?? null,
    is_active: input.isActive ?? true,
    last_refreshed_at: input.lastRefreshedAt ?? null,
    connection_status: "connected",
    ...(input.updatedAt ? { updated_at: input.updatedAt } : {}),
  };
}

/** DB connected_meta_accounts → app ConnectedMetaAccount. */
export function mapConnectedMetaAccountRow(
  row: Record<string, unknown>,
): ConnectedMetaAccount {
  return {
    id: String(row.id),
    client_id:
      (row.mapped_client_id as string | null | undefined) ??
      (row.client_id as string | null | undefined) ??
      null,
    meta_account_id: String(
      row.external_account_id ?? row.meta_account_id ?? "",
    ),
    meta_account_name: String(row.account_name ?? row.meta_account_name ?? ""),
    currency: (row.currency as string | null) ?? null,
    timezone: (row.timezone as string | null) ?? null,
    business_id: (row.business_id as string | null) ?? null,
    access_status: (row.access_status as AccessStatus) ?? "not_requested",
    access_method: (row.access_method as AccessMethod | null) ?? null,
    last_synced_at: (row.last_synced_at as string | null) ?? null,
    raw:
      (row.raw_metadata as Record<string, unknown> | null | undefined) ??
      (row.raw as Record<string, unknown> | null | undefined) ??
      null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}
