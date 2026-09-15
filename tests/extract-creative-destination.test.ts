import { describe, expect, it } from "vitest";
import { extractCreativeDestination } from "@/lib/meta/extract-creative-destination";

describe("extractCreativeDestination", () => {
  it("reads video CTA link from call_to_action.value.link", () => {
    const extracted = extractCreativeDestination({
      object_story_spec: {
        video_data: {
          message: "Book a demo today",
          title: "Scale faster",
          call_to_action: {
            type: "LEARN_MORE",
            value: { link: "https://echelonn.example/demo" },
          },
        },
      },
    });
    expect(extracted.landing_page_url).toBe("https://echelonn.example/demo");
    expect(extracted.call_to_action_type).toBe("LEARN_MORE");
    expect(extracted.creative_type).toBe("video");
    expect(extracted.primary_text).toBe("Book a demo today");
  });

  it("reads link_data.link for image ads", () => {
    const extracted = extractCreativeDestination({
      call_to_action_type: "SIGN_UP",
      object_story_spec: {
        link_data: {
          link: "https://brand.test/offer",
          message: "Try free",
          name: "Offer",
        },
      },
    });
    expect(extracted.landing_page_url).toBe("https://brand.test/offer");
    expect(extracted.call_to_action_type).toBe("SIGN_UP");
    expect(extracted.headline).toBe("Offer");
  });

  it("ignores facebook CDN urls", () => {
    const extracted = extractCreativeDestination({
      image_url: "https://scontent.xx.fbcdn.net/v/t1/foo.jpg",
      object_story_spec: {
        link_data: {
          call_to_action: {
            type: "SHOP_NOW",
            value: { link: "https://shop.example/cart" },
          },
        },
      },
    });
    expect(extracted.landing_page_url).toBe("https://shop.example/cart");
  });

  it("prefers Website URL / CTA link over shallow nested homepage", () => {
    const extracted = extractCreativeDestination({
      body: "Visit https://brand.example for more",
      object_story_spec: {
        video_data: {
          message: "Free Google Ads audit",
          call_to_action: {
            type: "LEARN_MORE",
            value: {
              link: "https://googleaudit.trafficradius.com.au/landing",
            },
          },
        },
      },
    });
    expect(extracted.landing_page_url).toBe(
      "https://googleaudit.trafficradius.com.au/landing",
    );
    expect(extracted.destination_source).toContain("call_to_action");
  });

  it("uses creative.link_url when story spec CTA is missing", () => {
    const extracted = extractCreativeDestination({
      link_url: "https://brand.test/offer-page",
      title: "Offer",
      body: "Try it",
    });
    expect(extracted.landing_page_url).toBe("https://brand.test/offer-page");
  });

  it("keeps the creative Website URL when a linked page post has a stale link", () => {
    const extracted = extractCreativeDestination(
      {
        object_story_spec: {
          video_data: {
            call_to_action: {
              type: "LEARN_MORE",
              value: {
                link: "https://googleaudit.trafficradius.com.au/landing",
              },
            },
          },
        },
      },
      {
        call_to_action: {
          type: "LEARN_MORE",
          value: { link: "https://googleconsult.trafficradius.com.au/" },
        },
      },
    );
    expect(extracted.landing_page_url).toBe(
      "https://googleaudit.trafficradius.com.au/landing",
    );
    expect(extracted.destination_source).toContain("call_to_action");
  });

  it("falls back to the page post CTA link when the creative has no destination", () => {
    const extracted = extractCreativeDestination(
      { object_story_spec: { page_id: "1" } },
      {
        call_to_action: {
          type: "LEARN_MORE",
          value: { link: "https://googleaudit.trafficradius.com.au/landing" },
        },
      },
    );
    expect(extracted.landing_page_url).toBe(
      "https://googleaudit.trafficradius.com.au/landing",
    );
    expect(extracted.destination_source).toContain("page_post");
  });

  it("does not treat body/message URLs as destinations", () => {
    const extracted = extractCreativeDestination({
      body: "Read more at https://googleconsult.trafficradius.com.au/",
      object_story_spec: {
        video_data: {
          message: "Visit https://googleconsult.trafficradius.com.au/ later",
          call_to_action: {
            type: "LEARN_MORE",
            value: { link: "https://googleaudit.trafficradius.com.au/lan" },
          },
        },
      },
    });
    expect(extracted.landing_page_url).toBe(
      "https://googleaudit.trafficradius.com.au/lan",
    );
  });
});
