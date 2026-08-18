import { task } from "@trigger.dev/sdk";

/**
 * Smoke-test task — confirms Trigger.dev CLI + dashboard wiring.
 * Trigger from the dashboard Test tab with: { "name": "Adspirer" }
 */
export const helloWorld = task({
  id: "hello-world",
  run: async (payload: { name?: string }) => {
    const name = payload.name?.trim() || "world";
    return {
      message: `Hello, ${name}! Adspirer Trigger.dev is connected.`,
      at: new Date().toISOString(),
    };
  },
});
