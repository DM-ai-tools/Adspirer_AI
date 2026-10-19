import { describe, expect, it } from "vitest";
import { categoryTargetRoas, referenceMarginPct } from "@/lib/strategy/targets";
import type { StrategyCategory } from "@/lib/strategy/categories";

const cat = (grossMarginPct: number | null): StrategyCategory => ({
  id: "c",
  name: "c",
  landingPageUrl: null,
  urlPatterns: [],
  keywords: [],
  grossMarginPct,
  averageOrderValueCents: null,
  priority: 0,
});

describe("categoryTargetRoas", () => {
  it("scales the target by account margin over category margin", () => {
    expect(
      categoryTargetRoas({ accountTargetRoas: 10, accountMarginPct: 30, categoryMarginPct: 60 }),
    ).toEqual({ targetRoas: 5, breakEvenRoas: 1.67, basis: "margin_adjusted" });
  });

  it("raises the target for a low-margin category", () => {
    expect(
      categoryTargetRoas({ accountTargetRoas: 10, accountMarginPct: 30, categoryMarginPct: 15 }),
    ).toEqual({ targetRoas: 20, breakEvenRoas: 6.67, basis: "margin_adjusted" });
  });

  it("falls back to the account target when the category margin is null", () => {
    expect(
      categoryTargetRoas({ accountTargetRoas: 10, accountMarginPct: 30, categoryMarginPct: null }),
    ).toEqual({ targetRoas: 10, breakEvenRoas: null, basis: "account_target" });
  });

  it("keeps the account target but still gives break-even when only the account margin is missing", () => {
    expect(
      categoryTargetRoas({ accountTargetRoas: 10, accountMarginPct: null, categoryMarginPct: 40 }),
    ).toEqual({ targetRoas: 10, breakEvenRoas: 2.5, basis: "account_target" });
  });

  it("treats a zero margin as missing", () => {
    expect(
      categoryTargetRoas({ accountTargetRoas: 10, accountMarginPct: 0, categoryMarginPct: 40 }),
    ).toEqual({ targetRoas: 10, breakEvenRoas: 2.5, basis: "account_target" });
    expect(
      categoryTargetRoas({ accountTargetRoas: 10, accountMarginPct: 30, categoryMarginPct: 0 }),
    ).toEqual({ targetRoas: 10, breakEvenRoas: null, basis: "account_target" });
  });

  it("treats negative and non-finite margins as missing", () => {
    for (const bad of [-5, NaN, Infinity, -Infinity]) {
      expect(
        categoryTargetRoas({ accountTargetRoas: 10, accountMarginPct: 30, categoryMarginPct: bad }),
      ).toEqual({ targetRoas: 10, breakEvenRoas: null, basis: "account_target" });
      expect(
        categoryTargetRoas({ accountTargetRoas: 10, accountMarginPct: bad, categoryMarginPct: 40 }),
      ).toEqual({ targetRoas: 10, breakEvenRoas: 2.5, basis: "account_target" });
    }
  });

  it("never returns NaN for any combination of nulls, zeros and bad margins", () => {
    const margins: (number | null)[] = [null, 0, -5, NaN, Infinity, 0.5, 15, 30, 60, 100];
    for (const accountMarginPct of margins) {
      for (const categoryMarginPct of margins) {
        for (const accountTargetRoas of [0, 3.333, 10]) {
          const out = categoryTargetRoas({ accountTargetRoas, accountMarginPct, categoryMarginPct });
          expect(Number.isNaN(out.targetRoas)).toBe(false);
          expect(Number.isFinite(out.targetRoas)).toBe(true);
          if (out.breakEvenRoas !== null) {
            expect(Number.isFinite(out.breakEvenRoas)).toBe(true);
          }
        }
      }
    }
  });
});

describe("referenceMarginPct", () => {
  it("returns the goals margin when it is set", () => {
    expect(referenceMarginPct(45, [cat(40), cat(null), cat(20)])).toBe(45);
  });

  it("returns the mean of known category margins when goals margin is unset", () => {
    expect(referenceMarginPct(null, [cat(40), cat(null), cat(20)])).toBe(30);
  });

  it("ignores a goals margin that is zero, negative or non-finite", () => {
    for (const bad of [0, -3, NaN, Infinity]) {
      expect(referenceMarginPct(bad, [cat(40), cat(20)])).toBe(30);
    }
  });

  it("returns null when there is no goals margin and no known category margins", () => {
    expect(referenceMarginPct(undefined, [])).toBeNull();
    expect(referenceMarginPct(null, [cat(null), cat(0), cat(-1)])).toBeNull();
  });

  it("rounds the mean to 2 decimals", () => {
    expect(referenceMarginPct(null, [cat(10), cat(10), cat(11)])).toBe(10.33);
  });

  it("accepts StrategyCategory objects and ignores their missing margins", () => {
    expect(referenceMarginPct(undefined, [cat(40), cat(null), cat(20)])).toBe(30);
  });
});
