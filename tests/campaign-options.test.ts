import { beforeEach, describe, expect, it } from "vitest";
import {
  loadCampaignOptions,
  resetCampaignOptionsCache,
  type CampaignOptionsDeps,
} from "@/lib/meta/campaign-options";

type Call = { path: string; params: Record<string, unknown> };

function fakeGraph(routes: Record<string, unknown | Error>) {
  const calls: Call[] = [];
  const graph = {
    async get<T>(path: string, params: Record<string, unknown> = {}): Promise<T> {
      calls.push({ path, params });
      const key = Object.keys(routes).find((k) => path.endsWith(k) || (k === "search" && path === "search" && params.class === undefined));
      const byClass = path === "search" && typeof params.class === "string" ? routes[`search:${params.class}`] : undefined;
      const hit = byClass !== undefined ? byClass : key ? routes[key] : undefined;
      if (hit instanceof Error) throw hit;
      if (hit === undefined) throw new Error(`no route for ${path}`);
      return hit as T;
    },
  };
  return { graph, calls };
}

const happyRoutes = {
  "act_1/adspixels": { data: [{ id: "p1", name: "Main pixel" }] },
  "p1/stats": { data: [{ data: [{ value: "PageView", count: 9 }, { value: "Lead", count: 3 }] }] },
  "page9/leadgen_forms": { data: [{ id: "f1", name: "Quote form", status: "ACTIVE" }] },
  "search:user_device": { data: [{ name: "iPhone" }, { name: "iPad" }] },
  "search:user_os": { data: [{ name: "iOS" }, { name: "Android" }] },
};

const deps = (graph: CampaignOptionsDeps["graph"], pages: CampaignOptionsDeps["listPages"] = async () => [{ id: "page9", name: "Brand page" }]): CampaignOptionsDeps => ({
  graph,
  listPages: pages,
});

const input = { clientId: "c1", accountId: "act_1", objective: "OUTCOME_LEADS" as const };

beforeEach(() => resetCampaignOptionsCache());

describe("loadCampaignOptions", () => {
  it("returns live pixels with events, pages, lead forms, devices and a suggestion", async () => {
    const { graph } = fakeGraph(happyRoutes);
    const options = await loadCampaignOptions(input, deps(graph));
    expect(options.pixels).toEqual([{ id: "p1", name: "Main pixel", events: ["PageView", "Lead"] }]);
    expect(options.pages).toEqual([{ id: "page9", name: "Brand page" }]);
    expect(options.leadForms).toEqual([{ id: "f1", name: "Quote form", page_id: "page9" }]);
    expect(options.devices.map((d) => d.id)).toEqual(["iPhone", "iPad"]);
    expect(options.osList.map((d) => d.id)).toEqual(["iOS", "Android"]);
    expect(options.warnings).toEqual([]);
    expect(options.suggestion.settings).toMatchObject({
      conversion_location: "website",
      optimization_goal: "OFFSITE_CONVERSIONS",
      pixel_event_name: "LEAD",
    });
    expect(options.conversionLocations.find((l) => l.id === "messaging")?.supported).toBe(false);
    expect(options.performanceGoals.instant_form?.map((g) => g.id)).toEqual(["LEAD_GENERATION"]);
    expect(options.attribution.OFFSITE_CONVERSIONS).toHaveLength(3);
    expect(options.placements.length).toBeGreaterThan(0);
  });

  it("degrades when the pixel lookup fails, keeping everything else", async () => {
    const { graph } = fakeGraph({ ...happyRoutes, "act_1/adspixels": new Error("boom") });
    const options = await loadCampaignOptions(input, deps(graph));
    expect(options.pixels).toEqual([]);
    expect(options.warnings.join(" ")).toMatch(/pixel/i);
    expect(options.leadForms).toHaveLength(1);
    // The pixel lookup failed, so a pixel may exist: don't assume there is none.
    expect(options.pixelsLoaded).toBe(false);
    expect(options.suggestion.settings.conversion_location).toBe("website");
  });

  it("uses the curated device and OS lists when Meta returns none", async () => {
    const { graph } = fakeGraph({
      ...happyRoutes,
      "search:user_device": { data: [] },
      "search:user_os": new Error("down"),
    });
    const options = await loadCampaignOptions(input, deps(graph));
    expect(options.devices.length).toBeGreaterThan(0);
    expect(options.osList.map((o) => o.id)).toEqual(expect.arrayContaining(["iOS", "Android"]));
  });

  it("returns the rules-derived fields with one warning when Meta is unreachable", async () => {
    const down = new Error("Meta connection unavailable");
    const graph = { get: async () => { throw down; } };
    const options = await loadCampaignOptions(input, {
      graph,
      listPages: async () => { throw down; },
    });
    expect(options.pixels).toEqual([]);
    expect(options.pages).toEqual([]);
    expect(options.warnings.length).toBeGreaterThan(0);
    expect(options.conversionLocations.length).toBeGreaterThan(0);
    expect(options.performanceGoals.website?.length).toBeGreaterThan(0);
  });

  it("offers no conversion locations for Awareness", async () => {
    const { graph } = fakeGraph(happyRoutes);
    const options = await loadCampaignOptions({ ...input, objective: "OUTCOME_AWARENESS" }, deps(graph));
    expect(options.conversionLocations).toEqual([]);
    expect(options.suggestion.settings.optimization_goal).toBe("REACH");
  });

  it("caches Meta lookups for the same account", async () => {
    const { graph, calls } = fakeGraph(happyRoutes);
    await loadCampaignOptions(input, deps(graph));
    const first = calls.length;
    await loadCampaignOptions({ ...input, objective: "OUTCOME_TRAFFIC" }, deps(graph));
    expect(calls.length).toBe(first);
  });
});

describe("final review fixes: options", () => {
  it("I1: lookups are cached per user, never shared across users", async () => {
    const { graph, calls } = fakeGraph(happyRoutes);
    await loadCampaignOptions({ ...input, cacheScope: "user-a" }, deps(graph));
    const afterA = calls.length;
    await loadCampaignOptions({ ...input, cacheScope: "user-b" }, deps(graph));
    expect(calls.length).toBeGreaterThan(afterA);
    const afterB = calls.length;
    await loadCampaignOptions({ ...input, cacheScope: "user-b" }, deps(graph));
    expect(calls.length).toBe(afterB);
  });

  it("I1: only an account mapped to the client is accepted", async () => {
    const { pickAllowedAccount } = await import("@/lib/meta/campaign-options");
    expect(pickAllowedAccount("1", ["act_1", "act_2"], "act_2")).toBe("act_1");
    expect(pickAllowedAccount(null, ["act_1"], "act_1")).toBe("act_1");
    expect(pickAllowedAccount("", ["act_1"], "act_1")).toBe("act_1");
    expect(() => pickAllowedAccount("act_999", ["act_1"], "act_1")).toThrow(/not mapped/);
  });

  it("I2: a failed pixel lookup is flagged so the card does not claim there is no pixel", async () => {
    const { graph } = fakeGraph({ ...happyRoutes, "act_1/adspixels": new Error("boom") });
    const options = await loadCampaignOptions(input, deps(graph));
    expect(options.pixelsLoaded).toBe(false);
    const ok = fakeGraph(happyRoutes);
    resetCampaignOptionsCache();
    expect((await loadCampaignOptions(input, deps(ok.graph))).pixelsLoaded).toBe(true);
  });

  it("I2: a failed Pages lookup does not cache an empty lead-form list", async () => {
    const { graph, calls } = fakeGraph(happyRoutes);
    const first = await loadCampaignOptions(input, deps(graph, async () => { throw new Error("expired"); }));
    expect(first.leadFormsLoaded).toBe(false);
    expect(calls.some((c) => c.path.endsWith("/leadgen_forms"))).toBe(false);
    const second = await loadCampaignOptions(input, deps(graph));
    expect(second.leadFormsLoaded).toBe(true);
    expect(second.leadForms).toHaveLength(1);
  });

  it("I3: lead forms come from the page-token lookup when one is supplied", async () => {
    const { graph } = fakeGraph({ ...happyRoutes, "page9/leadgen_forms": new Error("needs page token") });
    const options = await loadCampaignOptions(input, {
      graph,
      listPages: async () => [{ id: "page9", name: "Brand page" }],
      fetchLeadForms: async () => [{ id: "f7", name: "Token form", status: "ACTIVE" }],
    });
    expect(options.leadForms).toEqual([{ id: "f7", name: "Token form", page_id: "page9" }]);
  });

  it("I3: the suggestion picks a pixel and a lead form", async () => {
    const { graph } = fakeGraph(happyRoutes);
    const options = await loadCampaignOptions(input, deps(graph));
    expect(options.suggestion.settings.pixel_id).toBe("p1");
    const ig = await loadCampaignOptions({ ...input, stated: { conversion_location: "instant_form" } }, deps(graph));
    expect(ig.suggestion.settings.conversion_location).toBe("instant_form");
    expect(ig.suggestion.settings.lead_form_id).toBe("f1");
    expect(ig.suggestion.settings.pixel_id).toBeUndefined();
  });
});

describe("device and OS lists from Meta", () => {
  it("drops duplicates and rows that are just the class name, so every option id is unique", async () => {
    const { graph } = fakeGraph({
      ...happyRoutes,
      "search:user_os": { data: [{ name: "iOS" }, { name: "iOS" }, { name: "user_os" }, { name: "user_os" }, { name: "Android" }] },
      "search:user_device": { data: [{ name: "iPhone" }, { name: "iPhone" }, { name: "user_device" }] },
    });
    const options = await loadCampaignOptions(input, deps(graph));
    expect(options.osList.map((o) => o.id)).toEqual(["iOS", "Android"]);
    expect(options.devices.map((d) => d.id)).toEqual(["iPhone"]);
  });
});
