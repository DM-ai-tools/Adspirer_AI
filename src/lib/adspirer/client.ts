import { getConfig } from "@/lib/config";
import type { MetaAdsProvider } from "./provider";
import { MockMetaAdsProvider } from "./mock-provider";
import { MetaGraphProviderV2 } from "@/lib/meta/provider-v2";
import { getUserMetaToken } from "@/lib/meta/get-user-token";
import { ProviderUnavailableError } from "@/lib/errors";
import {
  getWorkspaceContext,
  type WorkspaceExecutionBackend,
} from "@/lib/runtime/workspace-context";

let cachedMock: MetaAdsProvider | null = null;

/**
 * Resolve the Meta ads provider.
 * - meta_direct → MetaGraphProviderV2 with the operator's Facebook OAuth token
 *   (every live request — see workspace-context's live default)
 * - demo mode → MockMetaAdsProvider
 *
 * Live mode never falls back to mock data: a missing backend is an error, so
 * an approval can't "succeed" without touching Meta.
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

  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    cachedMock ??= new MockMetaAdsProvider();
    return cachedMock;
  }
  throw new ProviderUnavailableError(
    "No Meta connection for this request. Connect Facebook in the Workspace header and try again.",
    { backend },
  );
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
 * workspace backend is meta_direct.
 */
export async function resolveProvider(
  backendOverride?: WorkspaceExecutionBackend | null,
): Promise<MetaAdsProvider> {
  const backend = backendOverride ?? getWorkspaceContext()?.backend ?? null;
  if (backend === "meta_direct") {
    const { accessToken } = await getUserMetaToken();
    return getProviderByBackend(backend, accessToken);
  }
  return getProviderByBackend(backend);
}

export function resetProviderCache(): void {
  cachedMock = null;
}
