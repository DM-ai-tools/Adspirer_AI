import { AsyncLocalStorage } from "node:async_hooks";

export type WorkspaceExecutionBackend = "adspirer" | "meta_direct";
export type WorkspaceVersion = "v1" | "v2";

type WorkspaceContext = {
  version: WorkspaceVersion;
  backend: WorkspaceExecutionBackend;
  /** When set, V2 chat uses this act_* instead of auto-picking. */
  metaAccountId?: string;
};

const storage = new AsyncLocalStorage<WorkspaceContext>();

export function runWithWorkspaceContext<T>(
  context: WorkspaceContext,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(context, fn);
}

export function getWorkspaceContext(): WorkspaceContext | null {
  return storage.getStore() ?? null;
}

