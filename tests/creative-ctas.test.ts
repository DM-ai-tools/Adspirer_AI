import { describe, expect, it } from "vitest";
import { generateCreativeConcepts } from "@/lib/creatives/generator";
import { normalizeCallToAction } from "@/lib/meta/targeting-builder";
import { toMetaCta } from "@/lib/workflow/queue-campaign";
import type { Client, ClientService } from "@/types";

const client = { id: "c1", name: "Modern Dental" } as Client;
const service = { id: "s1", name: "Implants" } as ClientService;

describe("creative CTAs", () => {
  it("gives every generated concept a button Meta accepts", () => {
    const concepts = generateCreativeConcepts({ client, service, brief: null, count: 5 });
    expect(concepts).toHaveLength(5);
    for (const c of concepts) {
      expect(() => normalizeCallToAction(c.cta)).not.toThrow();
    }
    // Quote and booking concepts keep a matching button, not a generic one.
    expect(concepts.map((c) => normalizeCallToAction(c.cta))).toEqual(
      expect.arrayContaining(["GET_QUOTE", "BOOK_NOW"]),
    );
  });

  it("maps a draft's CTA label to Meta's button, falling back to Learn more", () => {
    expect(toMetaCta("Book Now")).toBe("BOOK_NOW");
    expect(toMetaCta("Get Quote")).toBe("GET_QUOTE");
    expect(toMetaCta("get offer")).toBe("GET_OFFER");
    expect(toMetaCta("Something custom")).toBe("LEARN_MORE");
    expect(toMetaCta(null)).toBeUndefined();
  });
});
