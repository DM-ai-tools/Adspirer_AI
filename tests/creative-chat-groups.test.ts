import { describe, expect, it } from "vitest";
import { groupCreativesByMessage } from "@/lib/creatives/chat-groups";
import { buildBrandImagePrompt } from "@/lib/creatives/openai-image";
import { buildConceptPrompt } from "@/lib/creatives/concept-writer";

type D = { id: string; image_status?: string };
const msg = (id: string, role: string, content: string, drafts?: D[]) => ({ id, role, content, drafts });

describe("images stay under the request that made them", () => {
  const first = [{ id: "a1" }, { id: "a2" }, { id: "a3" }, { id: "a4" }];
  const second = [{ id: "b1" }, { id: "b2" }, { id: "b3" }];
  const entries = [
    msg("u1", "user", "make 4 image variations for this page"),
    msg("w1", "assistant", "Generating 4 creative concepts", first),
    msg("r1", "assistant", "Making 4 on-brand image variations for **x**", first),
    msg("u2", "user", "a few more variations"),
    msg("w2", "assistant", "Generating 3 creative concepts", second),
    msg("r2", "assistant", "Making 3 on-brand image variations for **x**", second),
  ];

  it("puts each batch under the reply to its own request", () => {
    const groups = groupCreativesByMessage<D>(entries, []);
    expect(groups.get("r1")?.drafts.map((d) => d.id)).toEqual(["a1", "a2", "a3", "a4"]);
    expect(groups.get("r2")?.drafts.map((d) => d.id)).toEqual(["b1", "b2", "b3"]);
    expect(groups.get("r1")?.request).toBe("make 4 image variations for this page");
    expect(groups.get("r2")?.request).toBe("a few more variations");
    expect(groups.size).toBe(2);
  });

  it("a later snapshot that repeats earlier drafts (a rework) does not move them", () => {
    const withRework = [...entries, msg("u3", "user", "rework the first"), msg("r3", "assistant", "Reworked", [{ id: "a1" }])];
    const groups = groupCreativesByMessage<D>(withRework, []);
    expect(groups.get("r1")?.drafts.map((d) => d.id)).toContain("a1");
    expect(groups.has("r3")).toBe(false);
  });

  it("live status updates the cards without regrouping them", () => {
    const groups = groupCreativesByMessage<D>(entries, [{ id: "b2", image_status: "succeeded" }]);
    expect(groups.get("r2")?.drafts.find((d) => d.id === "b2")?.image_status).toBe("succeeded");
    expect(groups.get("r1")?.drafts).toHaveLength(4);
  });

  it("a batch with no message yet hangs off the newest reply", () => {
    const groups = groupCreativesByMessage<D>(entries, [{ id: "z1" }]);
    expect(groups.get("r2")?.drafts.map((d) => d.id)).toContain("z1");
  });
});

describe("prompts ask for finished, varied, ad-grade work", () => {
  it("the concept brief names a wide range of styles and demands a different one per concept", () => {
    const prompt = buildConceptPrompt({
      clientId: "c",
      serviceId: null,
      count: 4,
      brand: { name: "Acme" },
      business: {},
      offer: { name: "Free audit" },
    });
    expect(prompt).toContain("DIFFERENT visual style");
    expect(prompt).toContain("typographic poster");
    expect(prompt).toContain("3D-rendered");
    expect(prompt).toContain("never five takes on one layout");
  });

  it("the image prompt carries the craft brief and commits to the variant style", () => {
    const prompt = buildBrandImagePrompt({
      brandName: "Acme",
      serviceName: "Free audit",
      variantLabel: "Bold Poster",
      creativeDirection: "STYLE: bold typographic poster. Giant headline over a glowing graph.",
    });
    expect(prompt).toContain("scroll-stopping");
    expect(prompt).toContain("CRAFT");
    expect(prompt).toContain("depth");
    expect(prompt).toContain("Commit fully to the art direction's style");
  });
});
