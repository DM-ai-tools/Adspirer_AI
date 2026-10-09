import { createTask, getTask, runTask } from "@/lib/agent/task-runner";
import type { Task } from "@/types";
import {
  runWithWorkspaceContext,
  type WorkspaceExecutionBackend,
} from "@/lib/runtime/workspace-context";

const V2_BACKEND: WorkspaceExecutionBackend = "meta_direct";

export async function createTaskV2(input: {
  clientId: string;
  createdBy: string;
  title: string;
  goal?: string | null;
  conversationId?: string | null;
}): Promise<Task> {
  return createTask({
    ...input,
    agentState: {
      workspace_version: "v2",
      execution_backend: V2_BACKEND,
    },
  });
}

export async function runTaskV2(
  taskId: string,
  options?: Parameters<typeof runTask>[1] & {
    metaAccountId?: string;
    /** Set by background jobs, which have no session cookie. */
    actingUserId?: string;
  },
): Promise<Task> {
  return runWithWorkspaceContext(
    {
      version: "v2",
      backend: V2_BACKEND,
      metaAccountId: options?.metaAccountId,
      actingUserId: options?.actingUserId,
    },
    () => runTask(taskId, options),
  );
}

export async function getTaskV2(taskId: string): Promise<Task> {
  return getTask(taskId);
}

