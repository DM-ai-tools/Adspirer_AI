import { describe, expect, it } from "vitest";
import { extractBrandColorsFromHtml, mergeBrandColors, withoutFrameworkDefaults } from "@/lib/brand/html-colors";

const SITE = `
<meta name="theme-color" content="#14181c">
<style>
:root{--primary:#37ca37;--secondary:#188bf6;--white:#ffffff;--gray:#cbd5e0;--black:#000000;--red:#e93d3d;--orange:#f6ad55;--text-color:#000000;--link-color:#188bf6}
:root{--color-primary:#8DC14D;--color-primary-dark:#6FA838;--color-secondary:#0082B5;--color-ink:#14181C;--color-background:#FFFFFF;--color-text:#242A30}
</style>`;

describe("extractBrandColorsFromHtml", () => {
  it("leads with the named primary and secondary brand variables, not generic palette tokens", () => {
    const colors = extractBrandColorsFromHtml(SITE);
    expect(colors.slice(0, 4)).toEqual(["#37ca37", "#8dc14d", "#188bf6", "#0082b5"]);
    expect(colors).not.toContain("#e93d3d");
    expect(colors).not.toContain("#f6ad55");
    expect(colors.length).toBeLessThanOrEqual(5);
  });

  it("expands short hex and ignores pages with no brand variables", () => {
    expect(extractBrandColorsFromHtml("<style>:root{--brand:#0af}</style>")).toEqual(["#00aaff"]);
    expect(extractBrandColorsFromHtml("<p>no styles</p>")).toEqual([]);
  });
});

describe("withoutFrameworkDefaults", () => {
  it("drops a palette that is Bootstrap's defaults (the one a live run took for a client's brand)", () => {
    expect(withoutFrameworkDefaults(["#007BFF", "#28A745", "#FFC107", "#DC3545", "#6C757D"])).toEqual([]);
    expect(withoutFrameworkDefaults(["#0d6efd", "#198754", "#ffc107", "#dc3545", "#6c757d"])).toEqual([]);
  });

  it("keeps a real brand palette untouched", () => {
    expect(withoutFrameworkDefaults(["#a4d36b", "#f00000", "#072032", "#f9fbff"])).toEqual(["#a4d36b", "#f00000", "#072032", "#f9fbff"]);
    expect(withoutFrameworkDefaults([])).toEqual([]);
  });

  it("removes the framework colours from a mixed palette only when they dominate it, keeping the brand's own", () => {
    expect(withoutFrameworkDefaults(["#a4d36b", "#007bff", "#28a745", "#ffc107", "#6c757d"])).toEqual(["#a4d36b"]);
    // one brand colour that happens to equal a framework default is not enough to call the palette generic
    expect(withoutFrameworkDefaults(["#dc3545", "#a4d36b", "#072032"])).toEqual(["#dc3545", "#a4d36b", "#072032"]);
  });
});

describe("mergeBrandColors", () => {
  it("puts the site's own brand variables first, then the other colours, without duplicates", () => {
    expect(mergeBrandColors(["#37ca37", "#188bf6"], ["#188bf6", "#e93d3d", "#ffffff"])).toEqual([
      "#37ca37",
      "#188bf6",
      "#e93d3d",
      "#ffffff",
    ]);
  });

  it("uses the other colours alone when the page has no brand variables", () => {
    expect(mergeBrandColors([], ["#e93d3d"])).toEqual(["#e93d3d"]);
  });
});

describe("variable name matching", () => {
  it("does not mistake --pink or --link-color for the brand's ink colour", () => {
    const colors = extractBrandColorsFromHtml(
      "<style>:root{--pink:#fbb6ce;--link-color:#188bf6;--primary:#37ca37;--color-ink:#14181c}</style>",
    );
    expect(colors).toEqual(["#37ca37", "#14181c"]);
  });
});
