import { describe, expect, it, vi } from "vitest";
import { MetaGraphProviderV2 } from "@/lib/meta/provider-v2";
import { filterMetaAccounts, groupAccountsByBusiness } from "@/lib/adspirer/business-groups";
import type { ConnectedMetaAccount } from "@/types";

function providerWith(get: (path: string, params: Record<string, unknown>) => unknown) {
  const provider = new MetaGraphProviderV2("test-token");
  (provider as unknown as { graph: unknown }).graph = { get: vi.fn(async (p: string, q: Record<string, unknown> = {}) => get(p, q)) };
  return provider;
}

describe("listAccessibleAccounts", () => {
  it("labels each account with the Business Manager it is reached through", async () => {
    const provider = providerWith((path, params) => {
      if (path === "me/businesses") {
        return params.after
          ? { data: [{ id: "bm_2", name: "Agency Two" }] }
          : { data: [{ id: "bm_1", name: "Agency One" }], paging: { cursors: { after: "c1" }, next: "https://graph/next" } };
      }
      if (path === "bm_1/owned_ad_accounts") return { data: [{ id: "act_1", name: "Own 1", currency: "AUD" }] };
      // act_1 is also a client account of bm_2: ownership by bm_1 wins.
      if (path === "bm_2/client_ad_accounts") return { data: [{ id: "act_1", name: "Own 1" }, { id: "2", name: "Client 2" }] };
      if (path === "me/adaccounts") {
        return {
          data: [
            { id: "act_2", name: "Client 2" },
            { id: "act_3", name: "Personal 3", business: { id: "bm_9", name: "Someone Else" } },
            { id: "act_4", name: "Solo 4" },
          ],
        };
      }
      return { data: [] };
    });

    const accounts = await provider.listAccessibleAccounts();
    const byId = Object.fromEntries(accounts.map((a) => [a.meta_account_id, a]));
    expect(byId.act_1).toMatchObject({ business_id: "bm_1", business_name: "Agency One", business_relation: "owned" });
    expect(byId.act_2).toMatchObject({ business_id: "bm_2", business_name: "Agency Two", business_relation: "client" });
    expect(byId.act_3).toMatchObject({ business_id: "bm_9", business_name: "Someone Else", business_relation: "owned" });
    expect(byId.act_4).toMatchObject({ business_relation: "personal" });
    expect(byId.act_4.business_id).toBeUndefined();
    expect(accounts).toHaveLength(4);
  });
});

const account = (over: Partial<ConnectedMetaAccount>): ConnectedMetaAccount => ({
  id: over.meta_account_id ?? "x",
  client_id: null,
  meta_account_id: "act_0",
  meta_account_name: "Account",
  currency: "AUD",
  timezone: null,
  business_id: null,
  business_name: null,
  access_status: "granted",
  access_method: null,
  last_synced_at: null,
  raw: null,
  created_at: "",
  updated_at: "",
  ...over,
});

describe("groupAccountsByBusiness", () => {
  const accounts = [
    account({ meta_account_id: "act_1", meta_account_name: "Zeta", business_id: "bm_b", business_name: "Beta BM", client_id: "c1", raw: { business_relation: "client" } }),
    account({ meta_account_id: "act_2", meta_account_name: "Alpha", business_id: "bm_b", business_name: "Beta BM", raw: { business_relation: "owned" } }),
    account({ meta_account_id: "act_3", meta_account_name: "Solo" }),
    account({ meta_account_id: "act_4", meta_account_name: "Old", business_id: "bm_a" }),
  ];

  it("groups by business, sorts names, and puts direct access last", () => {
    const groups = groupAccountsByBusiness(accounts);
    expect(groups.map((g) => g.name)).toEqual(["Beta BM", "Business bm_a", "Direct access (no Business Manager)"]);
    expect(groups[0]).toMatchObject({ mappedCount: 1, ownedCount: 1, clientCount: 1, nameMissing: false });
    expect(groups[0].accounts.map((a) => a.meta_account_name)).toEqual(["Alpha", "Zeta"]);
    expect(groups[1].nameMissing).toBe(true);
  });

  it("filters by text across business and client names, and by mapping", () => {
    const clientName = (id: string) => (id === "c1" ? "Acme Dental" : undefined);
    expect(filterMetaAccounts(accounts, { query: "beta", mapping: "all", clientName })).toHaveLength(2);
    expect(filterMetaAccounts(accounts, { query: "acme", mapping: "all", clientName })).toHaveLength(1);
    expect(filterMetaAccounts(accounts, { query: "", mapping: "unmapped", clientName })).toHaveLength(3);
  });
});
