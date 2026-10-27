import { describe, expect, it } from "vitest";
import { loadCampaignOptions, resetCampaignOptionsCache, type CampaignOptions } from "@/lib/meta/campaign-options";
import type { CampaignObjective } from "@/lib/meta/campaign-rules";
import { applyChange, canConfirm } from "@/lib/meta/campaign-settings-state";

async function optionsFor(objective: CampaignObjective, withPixel = true, withForm = true): Promise<CampaignOptions> {
  resetCampaignOptionsCache();
  const graph = {
    async get<T>(path: string): Promise<T> {
      if (path.endsWith("/adspixels")) return { data: withPixel ? [{ id: "p1", name: "Pixel" }] : [] } as T;
      if (path.endsWith("/stats")) return { data: [{ data: [{ value: "Lead" }, { value: "Purchase" }] }] } as T;
      if (path.endsWith("/leadgen_forms") && withForm) return { data: [{ id: "f1", name: "Form", status: "ACTIVE" }] } as T;
      if (path === "search") return { data: [] } as T;
      throw new Error("unavailable");
    },
  };
  return loadCampaignOptions(
    { clientId: "c1", accountId: "act_1", objective },
    { graph, listPages: async () => [{ id: "page9", name: "Page" }] },
  );
}

describe("applyChange", () => {
  it("resets goal, event and attribution when the conversion location changes", async () => {
    const options = await optionsFor("OUTCOME_LEADS");
    const next = applyChange(
      {
        conversion_location: "website",
        optimization_goal: "OFFSITE_CONVERSIONS",
        pixel_event_name: "LEAD",
        attribution: "7d_click",
      },
      { conversion_location: "instant_form" },
      options,
    );
    expect(next.conversion_location).toBe("instant_form");
    expect(next.optimization_goal).toBe("LEAD_GENERATION");
    expect(next.pixel_event_name).toBeUndefined();
    expect(next.attribution).toBeUndefined();
  });

  it("re-suggests the event and attribution when the goal changes", async () => {
    const options = await optionsFor("OUTCOME_SALES");
    const next = applyChange(
      {
        conversion_location: "website",
        optimization_goal: "OFFSITE_CONVERSIONS",
        pixel_event_name: "PURCHASE",
        attribution: "1d_click",
      },
      { optimization_goal: "VALUE" },
      options,
    );
    expect(next.optimization_goal).toBe("VALUE");
    expect(next.pixel_event_name).toBe("PURCHASE");
    expect(next.attribution).toBe("7d_click_1d_view");
  });

  it("clears event and attribution when the new goal does not use them", async () => {
    const options = await optionsFor("OUTCOME_TRAFFIC");
    const next = applyChange(
      { conversion_location: "website", optimization_goal: "LANDING_PAGE_VIEWS" },
      { optimization_goal: "LINK_CLICKS" },
      options,
    );
    expect(next.optimization_goal).toBe("LINK_CLICKS");
    expect(next.pixel_event_name).toBeUndefined();
    expect(next.attribution).toBeUndefined();
  });

  it("drops positions of a platform that was removed", async () => {
    const options = await optionsFor("OUTCOME_TRAFFIC");
    const next = applyChange(
      {
        publisher_platforms: ["facebook", "instagram"],
        facebook_positions: ["feed"],
        instagram_positions: ["reels"],
      },
      { publisher_platforms: ["facebook"] },
      options,
    );
    expect(next.facebook_positions).toEqual(["feed"]);
    expect(next.instagram_positions).toBeUndefined();
  });

  it("leaves everything else alone for an unrelated change", async () => {
    const options = await optionsFor("OUTCOME_LEADS");
    const current = {
      conversion_location: "website" as const,
      optimization_goal: "OFFSITE_CONVERSIONS" as const,
      pixel_event_name: "LEAD",
      pixel_id: "p1",
      attribution: "7d_click" as const,
    };
    const next = applyChange(current, { age_min: 25 }, options);
    expect(next).toEqual({ ...current, age_min: 25 });
  });
});

describe("canConfirm", () => {
  it("blocks a Sales setup when the account has no pixel", async () => {
    const options = await optionsFor("OUTCOME_SALES", false, false);
    const result = canConfirm(
      { conversion_location: "website", optimization_goal: "OFFSITE_CONVERSIONS", pixel_event_name: "PURCHASE" },
      options,
    );
    expect(result.ok).toBe(false);
  });

  it("accepts the suggested setup", async () => {
    const options = await optionsFor("OUTCOME_LEADS");
    expect(canConfirm(options.suggestion.settings, options)).toEqual({ ok: true });
  });
});

describe("final review fixes: state", () => {
  it("I2: does not block Confirm when the pixel lookup failed", async () => {
    resetCampaignOptionsCache();
    const graph = {
      async get<T>(path: string): Promise<T> {
        if (path.endsWith("/adspixels")) throw new Error("token expired");
        if (path === "search") return { data: [] } as T;
        throw new Error("unavailable");
      },
    };
    const options = await loadCampaignOptions(
      { clientId: "c1", accountId: "act_1", objective: "OUTCOME_SALES" },
      { graph, listPages: async () => [] },
    );
    expect(options.pixelsLoaded).toBe(false);
    expect(
      canConfirm({ conversion_location: "website", optimization_goal: "OFFSITE_CONVERSIONS", pixel_event_name: "PURCHASE" }, options),
    ).toEqual({ ok: true });
  });

  it("I3: instant forms need a chosen lead form, and switching to it picks one", async () => {
    const options = await optionsFor("OUTCOME_LEADS");
    const next = applyChange(
      { conversion_location: "website", optimization_goal: "OFFSITE_CONVERSIONS", pixel_event_name: "LEAD", pixel_id: "p1" },
      { conversion_location: "instant_form" },
      options,
    );
    expect(next.lead_form_id).toBe("f1");
    expect(next.pixel_id).toBeUndefined();
    const missing = canConfirm({ conversion_location: "instant_form", optimization_goal: "LEAD_GENERATION" }, options);
    expect(missing.ok).toBe(false);
    expect(canConfirm(next, options)).toEqual({ ok: true });
  });

  it("I3: a conversion goal needs a chosen pixel when the account has one", async () => {
    const options = await optionsFor("OUTCOME_LEADS");
    const missing = canConfirm({ conversion_location: "website", optimization_goal: "OFFSITE_CONVERSIONS", pixel_event_name: "LEAD" }, options);
    expect(missing.ok).toBe(false);
    const back = applyChange(
      { conversion_location: "instant_form", optimization_goal: "LEAD_GENERATION", lead_form_id: "f1" },
      { conversion_location: "website" },
      options,
    );
    expect(back.pixel_id).toBe("p1");
    expect(back.lead_form_id).toBeUndefined();
  });
});
