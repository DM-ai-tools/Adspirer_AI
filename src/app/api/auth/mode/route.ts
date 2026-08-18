import { getConfig } from "@/lib/config";
import { jsonOk, withApiHandler } from "@/lib/api/response";

export async function GET() {
  return withApiHandler(async () => {
    const config = getConfig();
    return jsonOk({
      demoMode: config.isDemoMode,
      hasSupabase: config.hasSupabase,
      hasAdspirer: config.hasAdspirerMcp,
      adsExecutionMode: config.adsExecutionMode,
    });
  });
}
