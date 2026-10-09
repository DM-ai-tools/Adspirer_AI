import { describe, expect, it } from "vitest";
import {
  matchEntityByName,
  resolveAdSetIdForCreateAd,
} from "@/lib/meta/resolve-ad-set";
import type { MetaAdsProvider } from "@/lib/adspirer/provider";

describe("matchEntityByName", () => {
  const items = [
    { id: "1", name: "TR AUDIT FINAL (Echelonn)" },
    { id: "2", name: "TR AUDIT FINAL (Echelonn) - Ad Set" },
  ];

  it("matches exact names (case-insensitive, trimmed)", () => {
    expect(matchEntityByName(items, "TR AUDIT FINAL (Echelonn)")?.id).toBe("1");
    expect(matchEntityByName(items, "  tr audit final (echelonn) - ad set ")?.id).toBe(
      "2",
    );
  });

  it("never matches partial names", () => {
    expect(matchEntityByName(items, "Echelonn")).toBeUndefined();
    expect(matchEntityByName(items, "TR AUDIT")).toBeUndefined();
  });

  it("throws on ambiguous exact matches", () => {
    expect(() =>
      matchEntityByName(
        [
          { id: "a", name: "Prospecting" },
          { id: "b", name: "prospecting " },
        ],
        "Prospecting",
      ),
    ).toThrow(/More than one .* "Prospecting".*a, b/);
  });
});

describe("resolveAdSetIdForCreateAd", () => {
  const provider = {
    listCampaigns: async () => [
      { id: "c1", account_id: "act_1", name: "Spring Sale", status: "PAUSED", objective: "OUTCOME_SALES" },
    ],
    listAdSets: async () => [
      { id: "s1", campaign_id: "c1", account_id: "act_1", name: "Spring Sale", status: "PAUSED", daily_budget_cents: 0 },
      { id: "s2", campaign_id: "c1", account_id: "act_1", name: "Spring Sale - Ad Set", status: "PAUSED", daily_budget_cents: 0 },
    ],
  } as unknown as MetaAdsProvider;

  it("resolves an exact ad set name", async () => {
    await expect(
      resolveAdSetIdForCreateAd(provider, {
        account_id: "act_1",
        campaign_name: "spring sale",
        ad_set_name: "Spring Sale - Ad Set",
      }),
    ).resolves.toBe("s2");
  });

  it("fails with candidate names when the ad set name is not exact", async () => {
    await expect(
      resolveAdSetIdForCreateAd(provider, {
        account_id: "act_1",
        campaign_name: "Spring Sale",
        ad_set_name: "Ad Set",
      }),
    ).rejects.toThrow(/"Spring Sale - Ad Set"/);
  });

  it("refuses to guess between several ad sets when no name is given", async () => {
    await expect(
      resolveAdSetIdForCreateAd(provider, {
        account_id: "act_1",
        campaign_id: "c1",
      }),
    ).rejects.toThrow(/has 2 ad sets/);
  });
});
