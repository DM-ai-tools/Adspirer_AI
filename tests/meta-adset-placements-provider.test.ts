import { describe, expect, it, vi } from "vitest";
import { MetaGraphProviderV2 } from "@/lib/meta/provider-v2";
import { ExecutionVerificationError } from "@/lib/errors";

type Handler = (path: string, params: Record<string, unknown>) => unknown;

function providerWith(handlers: { get: Handler; post?: Handler }) {
  const provider = new MetaGraphProviderV2("test-token");
  const get = vi.fn(async (path: string, params: Record<string, unknown> = {}) => handlers.get(path, params));
  const post = vi.fn(async (path: string, body: Record<string, unknown> = {}) =>
    handlers.post ? handlers.post(path, body) : { success: true },
  );
  (provider as unknown as { graph: unknown }).graph = { get, post };
  return { provider, get, post };
}

const currentTargeting = () => ({
  geo_locations: { countries: ["AU"] },
  age_min: 25,
  age_max: 55,
  targeting_automation: { advantage_audience: 1 },
  excluded_custom_audiences: [{ id: "2" }],
  publisher_platforms: ["facebook", "instagram", "audience_network"],
  facebook_positions: ["feed", "story"],
  instagram_positions: ["stream"],
  audience_network_positions: ["classic"],
});

describe("updateAdSetPlacements", () => {
  function setup(opts: { targeting?: unknown; afterTargeting?: (written: Record<string, unknown>) => unknown; readFails?: boolean; postFails?: string } = {}) {
    let written: Record<string, unknown> = {};
    return providerWith({
      get: (path, params) => {
        if (path !== "777") throw new Error(`unexpected GET ${path}`);
        const row = { id: "777", name: "Prospecting", status: "ACTIVE", account_id: "111", campaign_id: "999" };
        if (String(params.fields).includes("account_id")) return { ...row, targeting: opts.targeting === undefined ? currentTargeting() : opts.targeting };
        if (opts.readFails) throw new Error("read-back unavailable");
        const sent = typeof written.targeting === "string" ? JSON.parse(written.targeting) : null;
        return { targeting: opts.afterTargeting ? opts.afterTargeting(written) : sent };
      },
      post: (_p, body) => {
        if (opts.postFails) throw new Error(opts.postFails);
        written = body;
        return { success: true };
      },
    });
  }

  const dropAudienceNetwork = { publisher_platforms: ["facebook", "instagram"], facebook_positions: ["feed", "story"], instagram_positions: ["stream"] };

  it("posts the WHOLE targeting object with only the placement keys changed, and verifies it", async () => {
    const { provider, post } = setup();
    const result = await provider.updateAdSetPlacements({ adset_id: "777", ...dropAudienceNetwork });
    expect(post).toHaveBeenCalledTimes(1);
    const [path, body] = post.mock.calls[0]!;
    expect(path).toBe("777");
    const sent = JSON.parse(String((body as Record<string, unknown>).targeting));
    const expected = currentTargeting() as Record<string, unknown>;
    delete expected.audience_network_positions;
    expected.publisher_platforms = ["facebook", "instagram"];
    expect(sent).toEqual(expected);
    expect(result).toMatchObject({ account_id: "act_111", verified: true });
    expect(result.placements.publisher_platforms).toEqual(["facebook", "instagram"]);
    expect(result.previous_placements.publisher_platforms).toEqual(["facebook", "instagram", "audience_network"]);
  });

  it("fails when Meta accepted it but reads back different placements", async () => {
    const { provider } = setup({ afterTargeting: () => currentTargeting() });
    await expect(provider.updateAdSetPlacements({ adset_id: "777", ...dropAudienceNetwork })).rejects.toBeInstanceOf(ExecutionVerificationError);
  });

  it("reports unverified, without failing, when the read-back fails", async () => {
    const { provider } = setup({ readFails: true });
    const result = await provider.updateAdSetPlacements({ adset_id: "777", ...dropAudienceNetwork });
    expect(result.verified).toBe(false);
    expect(result.verification_error).toMatch(/read-back unavailable/);
  });

  it("lets Meta's own refusal through", async () => {
    const { provider } = setup({ postFails: "(#100) targeting spec invalid" });
    await expect(provider.updateAdSetPlacements({ adset_id: "777", ...dropAudienceNetwork })).rejects.toThrow(/targeting spec invalid/);
  });

  it("refuses a no-op and posts nothing", async () => {
    const { provider, post } = setup();
    await expect(
      provider.updateAdSetPlacements({
        adset_id: "777",
        publisher_platforms: ["facebook", "instagram", "audience_network"],
        facebook_positions: ["feed", "story"],
        instagram_positions: ["stream"],
        audience_network_positions: ["classic"],
      }),
    ).rejects.toThrow(/already uses those placements.*Nothing was changed/);
    expect(post).not.toHaveBeenCalled();
  });

  it("refuses another account's ad set and posts nothing", async () => {
    const { provider, post } = setup();
    await expect(provider.updateAdSetPlacements({ account_id: "act_222", adset_id: "777", ...dropAudienceNetwork })).rejects.toThrow(
      /belongs to ad account act_111, not act_222. Nothing was changed/,
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("refuses an ad set whose targeting could not be read and posts nothing", async () => {
    const { provider, post } = setup({ targeting: null });
    await expect(provider.updateAdSetPlacements({ adset_id: "777", ...dropAudienceNetwork })).rejects.toThrow(/targeting.*Nothing was changed/);
    expect(post).not.toHaveBeenCalled();
  });

  it("switches to automatic placements by removing the keys and verifies they are gone", async () => {
    const { provider, post } = setup();
    const result = await provider.updateAdSetPlacements({ adset_id: "777", advantage_placements: true });
    const sent = JSON.parse(String((post.mock.calls[0]![1] as Record<string, unknown>).targeting));
    expect("publisher_platforms" in sent).toBe(false);
    expect(sent.geo_locations).toEqual({ countries: ["AU"] });
    expect(result.placements.publisher_platforms).toBeNull();
    expect(result.verified).toBe(true);
  });
});
