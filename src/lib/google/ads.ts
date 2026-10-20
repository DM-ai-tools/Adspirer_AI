import { getConfig } from "@/lib/config";
import { googleFetch } from "./http";
import { getGoogleAccessToken } from "./oauth";
import type { AdsPerformance, DateRange } from "./types";

/**
 * Read-only Google Ads client: GAQL search and the accessible-account list.
 * Nothing here writes to Google. Version checked against the release notes
 * (v26, 2026-10-14); override with GOOGLE_ADS_API_VERSION.
 */
export const DEFAULT_GOOGLE_ADS_API_VERSION = "v26";

function baseUrl(): string {
  const version = getConfig().GOOGLE_ADS_API_VERSION || DEFAULT_GOOGLE_ADS_API_VERSION;
  return `https://googleads.googleapis.com/${version}`;
}

async function adsHeaders(loginCustomerId: string | null): Promise<{
  accessToken: string;
  headers: Record<string, string>;
}> {
  // No developer-token header: Google retired developer tokens on 9 Sep 2026
  // (access now follows the OAuth client's Cloud project) and will reject them
  // in a later API version.
  const headers: Record<string, string> = {};
  if (loginCustomerId) headers["login-customer-id"] = digits(loginCustomerId);
  return { accessToken: await getGoogleAccessToken(), headers };
}

function digits(id: string): string {
  return id.replace(/\D/g, "");
}

/** Customer ids the signed-in Google user can reach directly, digits only. */
export async function listAccessibleCustomers(): Promise<string[]> {
  const { accessToken, headers } = await adsHeaders(null);
  const res = await googleFetch<{ resourceNames?: string[] }>(
    `${baseUrl()}/customers:listAccessibleCustomers`,
    { method: "GET", accessToken, headers },
  );
  return (res.resourceNames ?? []).map((name) => digits(name.split("/").pop() ?? "")).filter(Boolean);
}

/**
 * Runs a GAQL query and follows nextPageToken. Pages are a fixed 10,000 rows;
 * pageSize is no longer accepted, so it isn't sent.
 */
export async function searchGaql<T = Record<string, unknown>>(
  customerId: string,
  query: string,
  loginCustomerId: string | null,
): Promise<T[]> {
  const { accessToken, headers } = await adsHeaders(loginCustomerId);
  const url = `${baseUrl()}/customers/${digits(customerId)}/googleAds:search`;
  const rows: T[] = [];
  let pageToken: string | undefined;
  do {
    const res = await googleFetch<{ results?: T[]; nextPageToken?: string }>(url, {
      method: "POST",
      accessToken,
      headers,
      body: pageToken ? { query, pageToken } : { query },
    });
    rows.push(...(res.results ?? []));
    pageToken = res.nextPageToken || undefined;
  } while (pageToken);
  return rows;
}

// REST responses use camelCase JSON; int64 values (ids, micros) arrive as strings.
type Num = number | string | undefined;
type Metrics = { costMicros?: Num; conversions?: Num; conversionsValue?: Num };

type CustomerRow = {
  customer?: { id?: Num; descriptiveName?: string; currencyCode?: string; timeZone?: string; manager?: boolean };
};
type CustomerClientRow = {
  customerClient?: { id?: Num; descriptiveName?: string; currencyCode?: string; timeZone?: string; manager?: boolean };
};

const CUSTOMER_QUERY =
  "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager FROM customer";

const CLIENTS_QUERY =
  "SELECT customer_client.id, customer_client.client_customer, customer_client.descriptive_name, " +
  "customer_client.currency_code, customer_client.time_zone, customer_client.manager, customer_client.level " +
  "FROM customer_client WHERE customer_client.level <= 2 AND customer_client.manager = FALSE " +
  "AND customer_client.hidden = FALSE AND customer_client.status = 'ENABLED'";

export type AdsAccount = {
  customerId: string;
  name: string;
  currency: string;
  timezone: string;
  loginCustomerId: string | null;
  manager: boolean;
  parentName: string | null;
};

/**
 * Directly accessible ad accounts plus the non-manager accounts under each
 * accessible manager (up to two levels down), once each. An account reached
 * through GOOGLE_ADS_LOGIN_CUSTOMER_ID records that manager; otherwise direct
 * access wins, then the first manager that reaches it.
 */
export async function discoverAdsAccounts(): Promise<AdsAccount[]> {
  const preferred = getConfig().GOOGLE_ADS_LOGIN_CUSTOMER_ID ?? null;
  const ids = await listAccessibleCustomers();
  // One unreadable account is skipped, but if nothing can be read the reason
  // is raised: a Test-access Cloud project refuses every account, and an
  // empty list with no explanation looks like "no accounts".
  const failures: unknown[] = [];

  const roots = await Promise.all(
    ids.map(async (id) => {
      try {
        const [row] = await searchGaql<CustomerRow>(id, CUSTOMER_QUERY, null);
        return row?.customer ? { ...row.customer, id } : null;
      } catch (error) {
        failures.push(error);
        return null;
      }
    }),
  );
  const reachable = roots.filter((root) => root !== null);

  const managers = await Promise.all(
    reachable
      .filter((root) => root.manager)
      .map(async (root) => {
        try {
          const rows = await searchGaql<CustomerClientRow>(root.id, CLIENTS_QUERY, root.id);
          return { root, rows };
        } catch (error) {
          // One manager failing must not hide the others.
          failures.push(error);
          return null;
        }
      }),
  );

  const accounts = new Map<string, AdsAccount>();
  const add = (account: AdsAccount) => {
    if (account.customerId && !accounts.has(account.customerId)) {
      accounts.set(account.customerId, account);
    }
  };
  const addChildren = (entry: (typeof managers)[number]) => {
    if (!entry) return;
    for (const row of entry.rows) {
      const client = row.customerClient;
      if (!client || client.manager) continue;
      add({
        customerId: digits(String(client.id ?? "")),
        name: client.descriptiveName ?? "",
        currency: client.currencyCode ?? "",
        timezone: client.timeZone ?? "",
        loginCustomerId: entry.root.id,
        manager: false,
        parentName: entry.root.descriptiveName ?? null,
      });
    }
  };

  const isPreferred = (entry: (typeof managers)[number]) => entry?.root.id === preferred;
  managers.filter(isPreferred).forEach(addChildren);
  for (const root of reachable) {
    if (root.manager) continue;
    add({
      customerId: root.id,
      name: root.descriptiveName ?? "",
      currency: root.currencyCode ?? "",
      timezone: root.timeZone ?? "",
      loginCustomerId: null,
      manager: false,
      parentName: null,
    });
  }
  managers.filter((entry) => !isPreferred(entry)).forEach(addChildren);

  if (!accounts.size && failures.length) throw failures[0];
  return [...accounts.values()];
}

/** Google Ads micros to integer cents. */
function microsToCents(micros: Num): number {
  return Math.round(Number(micros ?? 0) / 10_000);
}

/** Currency units (conversion value) to integer cents. */
function unitsToCents(value: Num): number {
  return Math.round(Number(value ?? 0) * 100);
}

/**
 * An optional section: a failed query gives the fallback instead of throwing. With a label,
 * the failure (quota included) becomes a warning; without one it stays silent.
 */
async function optional<T>(run: () => Promise<T>, fallback: T, warnings: string[], label?: string): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (label) warnings.push(`Google Ads: ${label} didn't load (${error instanceof Error ? error.message : String(error)})`);
    return fallback;
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

type CampaignRow = {
  campaign?: { id?: Num; name?: string; advertisingChannelType?: string; status?: string };
  metrics?: Metrics;
};
type LandingPageRow = { landingPageView?: { unexpandedFinalUrl?: string }; metrics?: Metrics };
type AssetGroupRow = { assetGroup?: { name?: string; campaign?: string }; metrics?: Metrics };
type ShoppingRow = { segments?: { productTypeL1?: string; productTypeL2?: string }; metrics?: Metrics };

/** Campaign, landing page, asset group and Shopping product type results over the range. */
export async function fetchAdsPerformance(
  customerId: string,
  loginCustomerId: string | null,
  range: DateRange,
): Promise<AdsPerformance> {
  const id = digits(customerId);
  if (!DATE.test(range.since) || !DATE.test(range.until)) {
    throw new Error("Google Ads date range must be YYYY-MM-DD.");
  }
  const during = `segments.date BETWEEN '${range.since}' AND '${range.until}'`;
  const search = <T>(query: string) => searchGaql<T>(id, query, loginCustomerId);
  // Filled in the order the sections are listed, whatever order their queries fail in.
  const sectionWarnings: Array<string[]> = [[], [], []];

  const [customerRows, campaignRows, landingRows, assetGroupRows, shoppingRows, merchantCenterLinked] =
    await Promise.all([
      search<CustomerRow>("SELECT customer.currency_code FROM customer"),
      search<CampaignRow>(
        "SELECT campaign.id, campaign.name, campaign.advertising_channel_type, campaign.status, " +
          "metrics.cost_micros, metrics.conversions, metrics.conversions_value " +
          `FROM campaign WHERE ${during}`,
      ),
      optional(
        () =>
          search<LandingPageRow>(
            "SELECT landing_page_view.unexpanded_final_url, metrics.cost_micros, metrics.conversions_value " +
              `FROM landing_page_view WHERE ${during}`,
          ),
        [],
        sectionWarnings[0],
        "landing pages",
      ),
      optional(
        () =>
          search<AssetGroupRow>(
            "SELECT asset_group.name, asset_group.campaign, metrics.cost_micros, metrics.conversions_value " +
              `FROM asset_group WHERE ${during}`,
          ),
        [],
        sectionWarnings[1],
        "asset groups",
      ),
      optional(
        () =>
          search<ShoppingRow>(
            "SELECT segments.product_type_l1, segments.product_type_l2, metrics.cost_micros, metrics.conversions_value " +
              `FROM shopping_performance_view WHERE ${during}`,
          ),
        [],
        sectionWarnings[2],
        "Shopping product types",
      ),
      optional(async () => {
        const links = await search<Record<string, unknown>>(
          "SELECT product_link.product_link_id FROM product_link WHERE product_link.type = 'MERCHANT_CENTER'",
        );
        return links.length > 0;
        // Merchant Center is only a flag for recommendations: its failure stays silent.
      }, false, []),
    ]);

  const shopping = new Map<string, { productType: string; costCents: number; conversionValueCents: number }>();
  for (const row of shoppingRows) {
    const l1 = row.segments?.productTypeL1?.trim();
    if (!l1) continue;
    const l2 = row.segments?.productTypeL2?.trim();
    const productType = l2 ? `${l1} > ${l2}` : l1;
    const entry = shopping.get(productType) ?? { productType, costCents: 0, conversionValueCents: 0 };
    entry.costCents += microsToCents(row.metrics?.costMicros);
    entry.conversionValueCents += unitsToCents(row.metrics?.conversionsValue);
    shopping.set(productType, entry);
  }

  const warnings = sectionWarnings.flat();
  return {
    customerId: id,
    currency: customerRows[0]?.customer?.currencyCode ?? "",
    merchantCenterLinked,
    campaigns: campaignRows.map((row) => ({
      id: String(row.campaign?.id ?? ""),
      name: row.campaign?.name ?? "",
      type: row.campaign?.advertisingChannelType ?? "UNKNOWN",
      status: row.campaign?.status ?? "UNKNOWN",
      costCents: microsToCents(row.metrics?.costMicros),
      conversions: Number(row.metrics?.conversions ?? 0),
      conversionValueCents: unitsToCents(row.metrics?.conversionsValue),
    })),
    landingPages: landingRows
      .filter((row) => row.landingPageView?.unexpandedFinalUrl)
      .map((row) => ({
        url: row.landingPageView?.unexpandedFinalUrl ?? "",
        costCents: microsToCents(row.metrics?.costMicros),
        conversionValueCents: unitsToCents(row.metrics?.conversionsValue),
      })),
    assetGroups: assetGroupRows.map((row) => ({
      name: row.assetGroup?.name ?? "",
      // asset_group.campaign is a resource name: customers/{id}/campaigns/{campaignId}.
      campaignId: row.assetGroup?.campaign?.split("/").pop() ?? "",
      costCents: microsToCents(row.metrics?.costMicros),
      conversionValueCents: unitsToCents(row.metrics?.conversionsValue),
    })),
    shoppingCategories: [...shopping.values()],
    ...(warnings.length ? { warnings } : {}),
  };
}
