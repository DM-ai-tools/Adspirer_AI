import { describe, expect, it } from "vitest";
import { normalizeCallToAction } from "@/lib/meta/targeting-builder";
import { toMetaCta } from "@/lib/workflow/queue-campaign";
import { ADSPIRER_META_CTAS } from "@/lib/adspirer/skills/ad-copywriting";

describe("creative CTAs", () => {
  it("offers the concept writer only buttons Meta accepts", () => {
    for (const cta of ADSPIRER_META_CTAS) {
      expect(() => normalizeCallToAction(cta)).not.toThrow();
    }
  });

  it("maps a draft's CTA label to Meta's button, falling back to Learn more", () => {
    expect(toMetaCta("Book Now")).toBe("BOOK_NOW");
    expect(toMetaCta("Get Quote")).toBe("GET_QUOTE");
    expect(toMetaCta("get offer")).toBe("GET_OFFER");
    expect(toMetaCta("Something custom")).toBe("LEARN_MORE");
    expect(toMetaCta(null)).toBeUndefined();
  });
});
