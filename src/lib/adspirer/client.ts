import { getConfig } from "@/lib/config";
import type { MetaAdsProvider } from "./provider";
import { MockMetaAdsProvider } from "./mock-provider";
import { AdspirerMCPProvider } from "./mcp-provider";
import { MetaGraphProviderV2 } from "@/lib/meta/provider-v2";
import { getUserMetaToken } from "@/lib/meta/get-user-token";
import {
  getWorkspaceContext,
  type WorkspaceExecutionBackend,
} from "@/lib/runtime/workspace-context";

let cached: MetaAdsProvider | null = null;
let cachedLive: MetaAdsProvider | null = null;

/**
 * Resolve Meta ads provider from ADS_EXECUTION_MODE.
 * - mock → MockMetaAdsProvider (safe default for mutations)
 * - sandbox / production → AdspirerMCPProvider (requires ADSPIRER_API_KEY)
 * - meta_direct → MetaGraphProviderV2 (requires OAuth token)
 */
function getProviderByBackend(
  backend: WorkspaceExecutionBackend | null,
  metaAccessToken?: string,
): MetaAdsProvider {
  if (backend === "meta_direct") {
    if (!metaAccessToken) {
      throw new Error(
        "Meta access token required for meta_direct backend. Connect your Facebook account.",
      );
    }
    return new MetaGraphProviderV2(metaAccessToken);
  }
  if (cached) return cached;

  const config = getConfig();
  switch (config.adsExecutionMode) {
    case "mock":
      cached = new MockMetaAdsProvider();
      break;
    case "sandbox":
    case "production":
      if (!config.ADSPIRER_API_KEY) {
        cached = new MockMetaAdsProvider();
        break;
      }
      cached = new AdspirerMCPProvider();
      break;
    default:
      cached = new MockMetaAdsProvider();
  }

  return cached;
}

/** Sync helper — only use when token is already known or backend is not meta_direct. */
export function getProvider(metaAccessToken?: string): MetaAdsProvider {
  const backend = getWorkspaceContext()?.backend ?? null;
  return getProviderByBackend(backend, metaAccessToken);
}

export function getProviderForBackend(
  backend: WorkspaceExecutionBackend | null,
  metaAccessToken?: string,
): MetaAdsProvider {
  return getProviderByBackend(backend, metaAccessToken);
}

/**
 * Async resolver that loads the current user's Meta OAuth token when the
 * workspace backend is meta_direct (Workspace V2).
 */
export async function resolveProvider(
  backendOverride?: WorkspaceExecutionBackend | null,
): Promise<MetaAdsProvider> {
  const backend =
    backendOverride ?? getWorkspaceContext()?.backend ?? null;
  if (backend === "meta_direct") {
    const { accessToken } = await getUserMetaToken();
    return getProviderByBackend(backend, accessToken);
  }
  return getProviderByBackend(backend);
}

/**
 * Live Adspirer provider for diagnose/sync when an API key is configured,
 * regardless of ADS_EXECUTION_MODE (mutations still go through getProvider()).
 */
export function getLiveAdspirerProvider(): MetaAdsProvider | null {
  const config = getConfig();
  if (!config.ADSPIRER_API_KEY) return null;
  if (!cachedLive) cachedLive = new AdspirerMCPProvider();
  return cachedLive;
}

export function resetProviderCache(): void {
  cached = null;
  cachedLive = null;
}
