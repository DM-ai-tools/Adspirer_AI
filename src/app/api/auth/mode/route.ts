import { getConfig } from "@/lib/config";
import { jsonOk, withApiHandler } from "@/lib/api/response";

/** Public auth mode for the login page — no infra vendor fields. */
export async function GET() {
  return withApiHandler(async () => {
    const config = getConfig();
    return jsonOk({
      demoMode: config.isDemoMode,
    });
  });
}
