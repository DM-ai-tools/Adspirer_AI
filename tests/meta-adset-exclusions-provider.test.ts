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
  targeting_automation: { advantage_audience: 1 },
  custom_audiences: [{ id: "10", name: "Website visitors" }],
  excluded_custom_audiences: [{ id: "2", name: "Customers" }],
});

describe("updateAdSetAudienceExclusions", () => {
  function setup(
    opts: {
      audiences?: Record<string, unknown>;
      afterTargeting?: (written: Record<string, unknown>) => unknown;
      readFails?: boolean;
    } = {},
  ) {
    let written: Record<string, unknown> = {};
    const audiences = opts.audiences ?? { "4": { id: "4", name: "Recent leads", account_id: "111" } };
    return providerWith({
      get: (path, params) => {
        if (path in audiences) {
          const row = audiences[path];
          if (row instanceof Error) throw row;
          return row;
        }
        if (path !== "777") throw new Error(`unexpected GET ${path}`);
        const row = { id: "777", name: "Prospecting", status: "ACTIVE", account_id: "111", campaign_id: "999" };
        if (String(params.fields).includes("account_id")) return { ...row, targeting: currentTargeting() };
        if (opts.readFails) throw new Error("read-back unavailable");
        const sent = typeof written.targeting === "string" ? JSON.parse(written.targeting) : null;
        return { targeting: opts.afterTargeting ? opts.afterTargeting(written) : sent };
      },
      post: (_p, body) => {
        written = body;
        return { success: true };
      },
    });
  }

  it("posts the WHOLE targeting object with only the exclusions changed, and verifies it", async () => {
    const { provider, post } = setup();
    const result = await provider.updateAdSetAudienceExclusions({ adset_id: "777", add_excluded_custom_audiences: ["4"] });
    expect(post).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(String((post.mock.calls[0]![1] as Record<string, unknown>).targeting));
    const expected = currentTargeting() as Record<string, unknown>;
    expected.excluded_custom_audiences = [{ id: "2", name: "Customers" }, { id: "4" }];
    expect(sent).toEqual(expected);
    expect(result).toMatchObject({
      account_id: "act_111",
      excluded_custom_audiences: ["2", "4"],
      previous_excluded_custom_audiences: ["2"],
      verified: true,
    });
  });

  it("refuses an audience that does not exist, or belongs to another account, and posts nothing", async () => {
    const missing = setup({ audiences: { "4": new Error("Unsupported get request. Object with ID '4' does not exist") } });
    await expect(missing.provider.updateAdSetAudienceExclusions({ adset_id: "777", add_excluded_custom_audiences: ["4"] })).rejects.toThrow(
      /Audience 4.*Nothing was changed/,
    );
    expect(missing.post).not.toHaveBeenCalled();
    const other = setup({ audiences: { "4": { id: "4", name: "Theirs", account_id: "999" } } });
    await expect(other.provider.updateAdSetAudienceExclusions({ adset_id: "777", add_excluded_custom_audiences: ["4"] })).rejects.toThrow(
      /Audience 4 belongs to another ad account.*Nothing was changed/,
    );
    expect(other.post).not.toHaveBeenCalled();
  });

  it("removing an exclusion needs no audience lookup", async () => {
    const { provider, get, post } = setup({ audiences: {} });
    const result = await provider.updateAdSetAudienceExclusions({ adset_id: "777", remove_excluded_custom_audiences: ["2"] });
    expect(result.excluded_custom_audiences).toEqual([]);
    expect(get).not.toHaveBeenCalledWith("2", expect.anything());
    const sent = JSON.parse(String((post.mock.calls[0]![1] as Record<string, unknown>).targeting));
    expect("excluded_custom_audiences" in sent).toBe(false);
  });

  it("fails when Meta accepted it but reads back different exclusions", async () => {
    const { provider } = setup({ afterTargeting: () => currentTargeting() });
    await expect(provider.updateAdSetAudienceExclusions({ adset_id: "777", add_excluded_custom_audiences: ["4"] })).rejects.toBeInstanceOf(
      ExecutionVerificationError,
    );
  });

  it("reports unverified, without failing, when the read-back fails", async () => {
    const { provider } = setup({ readFails: true });
    const result = await provider.updateAdSetAudienceExclusions({ adset_id: "777", add_excluded_custom_audiences: ["4"] });
    expect(result.verified).toBe(false);
  });

  it("refuses a no-op and posts nothing", async () => {
    const { provider, post } = setup();
    await expect(provider.updateAdSetAudienceExclusions({ adset_id: "777", remove_excluded_custom_audiences: ["99"] })).rejects.toThrow(
      /already.*Nothing was changed/,
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("refuses to exclude an audience the ad set targets, and another account's ad set", async () => {
    const { provider, post } = setup({ audiences: { "10": { id: "10", name: "Website visitors", account_id: "111" } } });
    await expect(provider.updateAdSetAudienceExclusions({ adset_id: "777", add_excluded_custom_audiences: ["10"] })).rejects.toThrow(/already targeted/);
    await expect(
      provider.updateAdSetAudienceExclusions({ account_id: "act_222", adset_id: "777", remove_excluded_custom_audiences: ["2"] }),
    ).rejects.toThrow(/belongs to ad account act_111, not act_222. Nothing was changed/);
    expect(post).not.toHaveBeenCalled();
  });
});
