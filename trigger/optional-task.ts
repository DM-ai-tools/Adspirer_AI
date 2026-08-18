import { task } from "@trigger.dev/sdk";

/**
 * Register a Trigger.dev task. Keeps the plain `run*` function callable
 * outside Trigger (tests, scripts) while exporting a real `task()` for the CLI.
 */
export function defineJobTask<TPayload, TResult>(
  id: string,
  run: (payload: TPayload) => Promise<TResult>,
) {
  return task({
    id,
    retry: { maxAttempts: 3 },
    run: async (payload: TPayload) => run(payload),
  });
}
