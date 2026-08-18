import { beforeEach } from "vitest";
import { resetConfigCache } from "@/lib/config";
import { resetDemoStore } from "@/lib/demo/store";

process.env.DEMO_MODE = "true";
process.env.ADS_EXECUTION_MODE = "mock";
process.env.TOKEN_ENCRYPTION_KEY =
  process.env.TOKEN_ENCRYPTION_KEY ??
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

beforeEach(() => {
  resetConfigCache();
  resetDemoStore();
});
