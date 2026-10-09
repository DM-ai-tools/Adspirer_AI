import { AsyncLocalStorage } from "node:async_hooks";
import { getConfig } from "@/lib/config";

export type WorkspaceExecutionBackend = "adspirer" | "meta_direct";
export type WorkspaceVersion = "v1" | "v2";

type WorkspaceContext = {
  version: WorkspaceVersion;
  backend: WorkspaceExecutionBackend;
  /** When set, chat uses this act_* instead of auto-picking. */
  metaAccountId?: string;
  /**
   * Whose Facebook token to use when there is no request session
   * (background jobs). Request handlers leave it unset.
   */
  actingUserId?: string;
};

const storage = new AsyncLocalStorage<WorkspaceContext>();

export function runWithWorkspaceContext<T>(
  context: WorkspaceContext,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(context, fn);
}

/**
 * The workspace runs Meta-direct (operator's Facebook OAuth + Graph API) for
 * every live request. Demo mode has no default, so it keeps the mock provider.
 * An explicit `runWithWorkspaceContext` (e.g. to pin an ad account) wins.
 */
const LIVE_DEFAULT_CONTEXT: WorkspaceContext = {
  version: "v2",
  backend: "meta_direct",
};

export function getWorkspaceContext(): WorkspaceContext | null {
  const explicit = storage.getStore();
  if (explicit) return explicit;
  const config = getConfig();
  return config.isDemoMode || !config.hasSupabase ? null : LIVE_DEFAULT_CONTEXT;
}

