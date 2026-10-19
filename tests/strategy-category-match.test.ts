import { describe, expect, it } from "vitest";
import type { StrategyCategory } from "@/lib/strategy/categories";
import {
  matchCategoryByLabel,
  matchCategoryByName,
  matchCategoryByUrl,
  normalizeUrl,
} from "@/lib/strategy/category-match";

function cat(over: Partial<StrategyCategory> & { id: string; name: string }): StrategyCategory {
  return {
    landingPageUrl: null,
    urlPatterns: [],
    keywords: [],
    grossMarginPct: null,
    averageOrderValueCents: null,
    priority: 0,
    ...over,
  };
}

const stools = cat({ id: "stools", name: "Bar stools", landingPageUrl: "https://shop.com/bar-stools", keywords: ["stool"] });
const sofas = cat({ id: "sofas", name: "Sofas", landingPageUrl: "https://shop.com/sofas", urlPatterns: ["/couches"] });
const all = [stools, sofas];

describe("normalizeUrl", () => {
  it("drops www, port, query, hash and trailing slash", () => {
    expect(normalizeUrl("https://WWW.Shop.com:8080/Bar-Stools/?a=1#x")).toBe("shop.com/bar-stools");
    expect(normalizeUrl("shop.com/")).toBe("shop.com");
  });
});

describe("matchCategoryByUrl", () => {
  it("ignores www, port and query, and the longest path wins", () => {
    const broad = cat({ id: "broad", name: "All", urlPatterns: ["shop.com/bar"] });
    expect(matchCategoryByUrl("https://www.shop.com:443/bar-stools/oak?x=1", [broad, stools])?.id).toBe("stools");
    expect(matchCategoryByUrl("shop.com/couches/blue", all)?.id).toBe("sofas");
  });
  it("never matches a bare-host category url", () => {
    const bare = cat({ id: "bare", name: "Site", landingPageUrl: "https://shop.com" });
    expect(matchCategoryByUrl("https://shop.com/anything", [bare])).toBeNull();
  });
  it("ties go to the first category in list order", () => {
    const a = cat({ id: "a", name: "A", urlPatterns: ["/x"] });
    const b = cat({ id: "b", name: "B", urlPatterns: ["/x"] });
    expect(matchCategoryByUrl("shop.com/x", [a, b])?.id).toBe("a");
  });
});

describe("matchCategoryByName", () => {
  it("the first text with a hit decides, and the longest term wins", () => {
    expect(matchCategoryByName([null, "Sofas sale", "Bar stools"], all)?.id).toBe("sofas");
    expect(matchCategoryByName(["Summer", "Oak bar stools and sofas"], all)?.id).toBe("stools");
    expect(matchCategoryByName(["Nothing", undefined], all)).toBeNull();
  });
});

describe("matchCategoryByLabel", () => {
  it("matches exact names and keywords case-insensitively", () => {
    expect(matchCategoryByLabel("Bar Stools", all)?.id).toBe("stools");
    expect(matchCategoryByLabel("bar stools", all)?.id).toBe("stools");
    expect(matchCategoryByLabel("  STOOL ", all)?.id).toBe("stools");
  });
  it("matches hierarchical labels by segment and by whole word", () => {
    expect(matchCategoryByLabel("Home > Furniture > Bar Stools", all)?.id).toBe("stools");
    expect(matchCategoryByLabel("Home/Sofas/Sectionals", all)?.id).toBe("sofas");
    expect(matchCategoryByLabel("Home > Bar Stools", all)?.id).toBe("stools");
    expect(matchCategoryByLabel("Oak bar stools, set of 2", all)?.id).toBe("stools");
  });
  it("does not match inside a longer word", () => {
    expect(matchCategoryByLabel("Stoolery", all)).toBeNull();
    expect(matchCategoryByLabel("Stoolery", [cat({ id: "s", name: "Stool" })])).toBeNull();
  });
});
