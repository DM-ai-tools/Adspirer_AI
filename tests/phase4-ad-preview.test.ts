import { describe, expect, it, vi } from "vitest";
import { MetaGraphProviderV2 } from "@/lib/meta/provider-v2";
import { previewArgsFor, PREVIEW_FORMATS } from "@/lib/approvals/preview";

function providerWith(get: (path: string, params: Record<string, unknown>) => unknown) {
  const provider = new MetaGraphProviderV2("t");
  const spy = vi.fn(async (path: string, params: Record<string, unknown> = {}) => get(path, params));
  (provider as unknown as { graph: unknown }).graph = { get: spy, post: vi.fn() };
  return { provider, spy };
}

const ad = {
  account_id: "act_1",
  primary_text: "Book your consult",
  headline: "Implants from $99",
  landing_page_url: "https://example.com/lp",
  image_url: "https://example.com/a.jpg",
  facebook_page_id: "321",
};

describe("ad preview (Meta generatepreviews, nothing created)", () => {
  it("asks Meta for each format with the creative the ad would get", async () => {
    const { provider, spy } = providerWith(() => ({
      data: [{ body: '<iframe src="https://www.facebook.com/ads/api/preview_iframe.php?d=abc&amp;t=1" width="540"></iframe>' }],
    }));
    const previews = await provider.previewAd(ad, ["MOBILE_FEED_STANDARD", "INSTAGRAM_REELS"]);
    expect(previews).toEqual([
      { format: "MOBILE_FEED_STANDARD", iframeSrc: "https://www.facebook.com/ads/api/preview_iframe.php?d=abc&t=1" },
      { format: "INSTAGRAM_REELS", iframeSrc: "https://www.facebook.com/ads/api/preview_iframe.php?d=abc&t=1" },
    ]);
    const [path, params] = spy.mock.calls[0]!;
    expect(path).toBe("act_1/generatepreviews");
    const creative = JSON.parse(String(params?.creative));
    expect(creative.object_story_spec).toMatchObject({ page_id: "321", link_data: { picture: "https://example.com/a.jpg", name: "Implants from $99" } });
    expect(spy).not.toHaveBeenCalledWith(expect.stringMatching(/adcreatives|ads$/), expect.anything());
  });

  it("never passes on a frame from anywhere but facebook.com", async () => {
    const { provider } = providerWith(() => ({ data: [{ body: '<iframe src="https://evil.example/x"></iframe>' }] }));
    const [preview] = await provider.previewAd(ad, ["MOBILE_FEED_STANDARD"]);
    expect(preview!.iframeSrc).toBeNull();
  });

  it("explains that a video preview needs the video in Meta first", async () => {
    const { provider } = providerWith(() => ({ data: [] }));
    await expect(provider.previewAd({ ...ad, image_url: undefined, video_url: "https://example.com/v.mp4" }, ["MOBILE_FEED_STANDARD"])).rejects.toThrow(
      /after the video is uploaded/,
    );
  });
});

describe("previewArgsFor", () => {
  it("previews the first ad of a campaign create, and nothing for status or budget changes", () => {
    expect(previewArgsFor("create_meta_image_campaign", { ...ad, campaign_name: "x", call_to_action: "BOOK_NOW" })).toMatchObject({
      primary_text: "Book your consult",
      image_url: "https://example.com/a.jpg",
      call_to_action: "BOOK_NOW",
    });
    expect(previewArgsFor("update_adset_budget", { adset_id: "1" })).toBeNull();
    expect(PREVIEW_FORMATS.map((f) => f.format)).toContain("INSTAGRAM_REELS");
  });
});
