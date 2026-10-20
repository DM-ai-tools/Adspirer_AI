import { clientGoogleAssets } from "./assets";
import { GoogleReconnectRequired } from "./oauth";
import { getGoogleDataProvider } from "./provider";
import type { ChannelSnapshot, DateRange } from "./types";

const RECONNECT_WARNING = "Google needs reconnecting — an admin can reconnect under Connections";

/**
 * What Google shows for a client's mapped assets. Each part has its own
 * try/catch so one failure keeps the others; a revoked connection stops
 * everything with a single warning. Warnings carry only the error message.
 */
export async function loadChannelSnapshot(clientId: string, range: DateRange): Promise<ChannelSnapshot> {
  const assets = await clientGoogleAssets(clientId);
  const provider = getGoogleDataProvider();
  const snapshot: ChannelSnapshot = {
    mapped: { ga4: !!assets.ga4, ads: !!assets.ads, gsc: !!assets.gsc },
    ga4: null,
    ads: null,
    gsc: null,
    warnings: [],
  };

  // Sequential, so nothing more is called once a reconnect is needed.
  const run = async <T>(label: string, call: () => Promise<T>): Promise<T | null> => {
    try {
      return await call();
    } catch (error) {
      if (error instanceof GoogleReconnectRequired) throw error;
      snapshot.warnings.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };

  try {
    if (assets.ga4) {
      snapshot.ga4 = await run("GA4", () => provider.ga4CategoryRevenue(assets.ga4!.external_id, range));
      if (snapshot.ga4?.warnings) snapshot.warnings.push(...snapshot.ga4.warnings);
    }
    if (assets.ads) {
      snapshot.ads = await run("Google Ads", () =>
        provider.adsPerformance(assets.ads!.external_id, assets.ads!.login_customer_id, range),
      );
      if (snapshot.ads?.warnings) snapshot.warnings.push(...snapshot.ads.warnings);
    }
    if (assets.gsc) {
      snapshot.gsc = await run("Search Console", () => provider.searchDemand(assets.gsc!.external_id, range));
    }
  } catch (error) {
    if (!(error instanceof GoogleReconnectRequired)) throw error;
    return { ...snapshot, ga4: null, ads: null, gsc: null, warnings: [RECONNECT_WARNING] };
  }
  return snapshot;
}
