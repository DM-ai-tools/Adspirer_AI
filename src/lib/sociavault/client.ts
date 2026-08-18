import { getConfig } from "@/lib/config";
import { logger } from "@/lib/observability/logger";

const BASE_URL = "https://api.sociavault.com";

export type SociaVaultResponse<T = unknown> = {
  success: boolean;
  data: T;
  credits_used?: number;
  error?: string;
  message?: string;
};

export class SociaVaultError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly payload?: unknown,
  ) {
    super(message);
    this.name = "SociaVaultError";
  }
}

export async function sociavaultGet<T = unknown>(
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
): Promise<SociaVaultResponse<T>> {
  const config = getConfig();
  const apiKey = config.SOCIAVAULT_API_KEY?.trim();
  if (!apiKey) {
    throw new SociaVaultError(
      "SOCIAVAULT_API_KEY is not configured",
      401,
    );
  }

  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "X-API-Key": apiKey,
      Accept: "application/json",
    },
    cache: "no-store",
  });

  const payload = (await res.json().catch(() => null)) as
    | SociaVaultResponse<T>
    | { error?: string; message?: string }
    | null;

  if (!res.ok) {
    const message =
      (payload && "message" in payload && payload.message) ||
      (payload && "error" in payload && payload.error) ||
      `SociaVault request failed (${res.status})`;
    logger.warn("SociaVault API error", { path, status: res.status, message });
    throw new SociaVaultError(String(message), res.status, payload);
  }

  return payload as SociaVaultResponse<T>;
}
