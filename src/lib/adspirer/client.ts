import { getConfig } from "@/lib/config";
import type { MetaAdsProvider } from "./provider";
import { MockMetaAdsProvider } from "./mock-provider";
import { AdspirerMCPProvider } from "./mcp-provider";

let cached: MetaAdsProvider | null = null;
let cachedLive: MetaAdsProvider | null = null;

/**
 * Resolve Meta ads provider from ADS_EXECUTION_MODE.
 * - mock → MockMetaAdsProvider (safe default for mutations)
 * - sandbox / production → AdspirerMCPProvider (requires ADSPIRER_API_KEY)
 */
export function getProvider(): MetaAdsProvider {
  if (cached) return cached;

  const config = getConfig();
  switch (config.adsExecutionMode) {
    case "mock":
      cached = new MockMetaAdsProvider();
      break;
    case "sandbox":
    case "production":
      if (!config.ADSPIRER_API_KEY) {
        cached = new MockMetaAdsProvider();
        break;
      }
      cached = new AdspirerMCPProvider();
      break;
    default:
      cached = new MockMetaAdsProvider();
  }

  return cached;
}

/**
 * Live Adspirer provider for diagnose/sync when an API key is configured,
 * regardless of ADS_EXECUTION_MODE (mutations still go through getProvider()).
 */
export function getLiveAdspirerProvider(): MetaAdsProvider | null {
  const config = getConfig();
  if (!config.ADSPIRER_API_KEY) return null;
  if (!cachedLive) cachedLive = new AdspirerMCPProvider();
  return cachedLive;
}

export function resetProviderCache(): void {
  cached = null;
  cachedLive = null;
}
