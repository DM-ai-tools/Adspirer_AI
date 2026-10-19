import type { GoogleAsset, GoogleAssetKind } from "./types";

/** Pure helpers for showing Google assets; safe to import from client components. */

export function groupGoogleAssets(assets: GoogleAsset[]): Record<GoogleAssetKind, GoogleAsset[]> {
  const grouped: Record<GoogleAssetKind, GoogleAsset[]> = {
    ga4_property: [],
    ads_customer: [],
    gsc_site: [],
  };
  for (const asset of assets) grouped[asset.kind].push(asset);
  for (const list of Object.values(grouped)) list.sort((a, b) => a.name.localeCompare(b.name));
  return grouped;
}

/** Plain copy for each `google_error` code the OAuth callback redirects with. */
export function googleErrorMessage(code: string): string {
  switch (code) {
    case "state_mismatch":
      return "The Google sign-in expired or didn't match this browser session. Please try connecting again.";
    case "denied":
      return "Google sign-in was cancelled, so nothing was connected. Connect again and allow access to continue.";
    case "no_refresh_token":
      return "Google didn't give lasting access. Remove this app at myaccount.google.com/permissions, then connect again.";
    case "exchange_failed":
      return "Google sign-in couldn't be completed. Please try connecting again.";
    case "not_admin":
      return "Only an admin can connect Google.";
    default:
      return "Google connection failed. Please try again.";
  }
}

export function googleAssetsSummary(a: {
  ga4: { name: string } | null;
  ads: { name: string } | null;
  gsc: { name: string } | null;
}): string {
  const parts = [
    a.ga4 ? `GA4: ${a.ga4.name}` : null,
    a.ads ? `Google Ads: ${a.ads.name}` : null,
    a.gsc ? `Search Console: ${a.gsc.name}` : null,
  ].filter((p): p is string => p !== null);
  return parts.length ? parts.join(" · ") : "Not mapped — map under Connections";
}
