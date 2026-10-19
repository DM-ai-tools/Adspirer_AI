/** Discovers the GA4 properties, Google Ads accounts and Search Console sites the connection can see. Task 6 fills this in. */
export async function syncGoogleAssets(): Promise<{
  ga4: number;
  ads: number;
  gsc: number;
  warnings: string[];
}> {
  return { ga4: 0, ads: 0, gsc: 0, warnings: [] };
}
