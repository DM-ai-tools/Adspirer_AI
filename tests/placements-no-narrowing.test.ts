import { describe, expect, it, vi } from "vitest";
import { mergePlacements, placementsSatisfy, type PlacementState } from "@/lib/meta/adset-edits";
import { MetaGraphProviderV2 } from "@/lib/meta/provider-v2";
import { inverseOf } from "@/lib/changes/rollback";
import type { ChangeLogEntry } from "@/lib/changes/change-log";

/**
 * A placement edit changes the platforms and positions it was asked to change and nothing
 * more: an ad set that ran everywhere on Facebook and Instagram still does after Audience
 * Network is removed, and rolling the change back restores exactly what was there.
 */

const everywhere = () => ({
  geo_locations: { countries: ["AU"] },
  age_min: 25,
  publisher_platforms: ["facebook", "instagram", "audience_network"],
});

describe("a placement edit does not narrow what it was not asked to narrow", () => {
  it("removing one platform from an ad set with no positions set adds none", () => {
    const out = mergePlacements(everywhere(), { publisher_platforms: ["facebook", "instagram"] });
    expect(out.targeting).toEqual({ geo_locations: { countries: ["AU"] }, age_min: 25, publisher_platforms: ["facebook", "instagram"] });
    expect(out.after.facebook_positions).toBeNull();
    expect(out.after.instagram_positions).toBeNull();
  });

  it("a platform added to an automatic ad set gets only the positions the operator named, if any", () => {
    const automatic = { geo_locations: { countries: ["AU"] } };
    expect(mergePlacements(automatic, { publisher_platforms: ["facebook"] }).targeting).toEqual({
      geo_locations: { countries: ["AU"] },
      publisher_platforms: ["facebook"],
    });
    expect(mergePlacements(automatic, { publisher_platforms: ["facebook"], facebook_positions: ["feed"] }).targeting.facebook_positions).toEqual(["feed"]);
  });

  it("positions already set on a platform that stays are kept", () => {
    const out = mergePlacements({ ...everywhere(), facebook_positions: ["feed", "story"] }, { publisher_platforms: ["facebook", "instagram"] });
    expect(out.targeting.facebook_positions).toEqual(["feed", "story"]);
    expect("instagram_positions" in out.targeting).toBe(false);
  });

  it("an empty list says 'all positions': it clears the ones that are set", () => {
    const out = mergePlacements(
      { ...everywhere(), facebook_positions: ["feed"], instagram_positions: ["stream"] },
      { publisher_platforms: ["facebook", "instagram"], facebook_positions: [] },
    );
    expect("facebook_positions" in out.targeting).toBe(false);
    expect(out.targeting.instagram_positions).toEqual(["stream"]);
  });

  it("the deprecated video_feeds position is still dropped from a list that has to be written", () => {
    const out = mergePlacements(everywhere(), { publisher_platforms: ["facebook"], facebook_positions: ["feed", "video_feeds"] });
    expect(out.targeting.facebook_positions).toEqual(["feed"]);
  });
});

describe("placementsSatisfy", () => {
  const state = (over: Partial<PlacementState>): PlacementState => ({
    publisher_platforms: ["facebook", "instagram"],
    facebook_positions: null,
    instagram_positions: null,
    audience_network_positions: null,
    messenger_positions: null,
    device_platforms: null,
    ...over,
  });

  it("Meta filling in positions we left open is not a mismatch", () => {
    expect(placementsSatisfy(state({ facebook_positions: ["feed", "story", "right_hand_column"] }), state({}))).toBe(true);
  });

  it("positions we set must be what comes back", () => {
    expect(placementsSatisfy(state({ facebook_positions: ["feed"] }), state({ facebook_positions: ["feed"] }))).toBe(true);
    expect(placementsSatisfy(state({ facebook_positions: ["feed", "story"] }), state({ facebook_positions: ["feed"] }))).toBe(false);
  });

  it("the platforms must be exactly what was asked, in any order", () => {
    expect(placementsSatisfy(state({ publisher_platforms: ["instagram", "facebook"] }), state({}))).toBe(true);
    expect(placementsSatisfy(state({ publisher_platforms: ["facebook", "instagram", "audience_network"] }), state({}))).toBe(false);
  });

  it("device targeting must match exactly", () => {
    expect(placementsSatisfy(state({ device_platforms: ["mobile"] }), state({ device_platforms: null }))).toBe(false);
  });
});

describe("the provider's read-back", () => {
  it("accepts Meta filling in positions the operator left open", async () => {
    const provider = new MetaGraphProviderV2("test-token");
    let written: Record<string, unknown> = {};
    const get = vi.fn(async (_path: string, params: Record<string, unknown> = {}) => {
      if (String(params.fields).includes("account_id")) {
        return { id: "777", name: "Prospecting", status: "ACTIVE", account_id: "111", campaign_id: "999", targeting: everywhere() };
      }
      const sent = JSON.parse(String(written.targeting));
      return { targeting: { ...sent, facebook_positions: ["feed", "story", "right_hand_column"], instagram_positions: ["stream", "story"] } };
    });
    const post = vi.fn(async (_path: string, body: Record<string, unknown> = {}) => {
      written = body;
      return { success: true };
    });
    (provider as unknown as { graph: unknown }).graph = { get, post };
    const result = await provider.updateAdSetPlacements({ adset_id: "777", publisher_platforms: ["facebook", "instagram"] });
    expect(JSON.parse(String(written.targeting)).facebook_positions).toBeUndefined();
    expect(result.verified).toBe(true);
  });
});

describe("rolling a placement change back restores what was there", () => {
  const change = (before: Record<string, unknown>, after: Record<string, unknown>): ChangeLogEntry => ({
    id: "change_1",
    client_id: "client_modern_dental",
    approval_id: "approval_1",
    tool_name: "update_adset_placements",
    account_id: "act_111",
    entity_type: "adset",
    entity_id: "777",
    before: { placements: before } as never,
    after: { placements: after } as never,
    approved_by: null,
    executed_by: null,
    rationale: null,
    rollback_of: null,
    created_at: "2026-10-28T10:00:00Z",
  });
  const none = { facebook_positions: null, instagram_positions: null, audience_network_positions: null, messenger_positions: null, device_platforms: null };

  it("platforms that had no positions set get 'all positions' back, so the change's positions don't linger", () => {
    const inverse = inverseOf(
      change(
        { ...none, publisher_platforms: ["facebook", "instagram", "audience_network"] },
        { ...none, publisher_platforms: ["facebook", "instagram"], facebook_positions: ["feed"] },
      ),
    );
    expect(inverse.args).toMatchObject({
      publisher_platforms: ["facebook", "instagram", "audience_network"],
      facebook_positions: [],
      instagram_positions: [],
      audience_network_positions: [],
    });
  });

  it("positions that were set are restored as they were", () => {
    const inverse = inverseOf(
      change(
        { ...none, publisher_platforms: ["facebook", "instagram"], facebook_positions: ["feed", "story"] },
        { ...none, publisher_platforms: ["facebook"], facebook_positions: ["feed"] },
      ),
    );
    expect(inverse.args).toMatchObject({
      publisher_platforms: ["facebook", "instagram"],
      facebook_positions: ["feed", "story"],
      instagram_positions: [],
    });
  });

  it("an ad set that was automatic goes back to automatic", () => {
    const inverse = inverseOf(change({ ...none, publisher_platforms: null }, { ...none, publisher_platforms: ["facebook"] }));
    expect(inverse.args).toMatchObject({ advantage_placements: true });
  });
});
