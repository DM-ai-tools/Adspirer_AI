import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  // From Trigger.dev dashboard — project Adspirer AI
  project: "proj_nwssymimrggsibgyyhmr",
  runtime: "node",
  logLevel: "info",
  maxDuration: 3600,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
      randomize: true,
    },
  },
  // Job files live at repo root ./trigger (not ./src/trigger)
  dirs: ["./trigger"],
});
