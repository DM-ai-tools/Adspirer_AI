import { task } from "@trigger.dev/sdk";
import { runAgentTurn } from "@/lib/agent/run-turn";
import { drainBackgroundWork } from "@/lib/api/background";
import type { Message } from "@/types";

export type RunAgentTurnPayload = {
  taskId: string;
  /** The placeholder assistant row the route already saved. */
  assistantMessage: Message;
  useMetaDirect: boolean;
  metaAccountId?: string;
  /** Operator whose Facebook token the agent acts with. */
  userId: string;
};

/**
 * Runs one chat turn outside the web request, so long audits are not bound
 * by the serverless request timeout and survive the operator closing the tab.
 * The chat route tails the task + message rows this job keeps updated.
 */
export const runAgentTurnTask = task({
  id: "run-agent-turn",
  // Never retry automatically: a turn can queue approvals or start image
  // renders, and running it twice would duplicate them.
  retry: { maxAttempts: 1 },
  maxDuration: 900,
  run: async (payload: RunAgentTurnPayload) => {
    try {
      const { task: finished } = await runAgentTurn({
        taskId: payload.taskId,
        assistantMessage: payload.assistantMessage,
        useMetaDirect: payload.useMetaDirect,
        metaAccountId: payload.metaAccountId,
        actingUserId: payload.userId,
        // Tailing clients poll about once a second; no need to write faster.
        persistEveryMs: 900,
      });
      return { taskId: finished.id, status: finished.status };
    } finally {
      // Learnings and chat-started image renders run detached; let them finish.
      await drainBackgroundWork();
    }
  },
});
