import { describe, expect, it } from "vitest";
import {
  centsToMetaMinor,
  metaCurrencyOffset,
  metaMinorToCents,
} from "@/lib/meta/provider-v2";

describe("Meta budget currency offsets", () => {
  it("uses cents for two-decimal currencies", () => {
    expect(metaCurrencyOffset("USD")).toBe(100);
    expect(metaCurrencyOffset("inr")).toBe(100);
    // ₹500/day = 50000 app cents = 50000 paise on Meta
    expect(centsToMetaMinor(50_000, "INR")).toBe(50_000);
    expect(metaMinorToCents(50_000, "INR")).toBe(50_000);
  });

  it("sends whole units for zero-offset currencies like JPY", () => {
    expect(metaCurrencyOffset("JPY")).toBe(1);
    // ¥5,000/day is 500000 app cents but 5000 on Meta — not ¥500,000.
    expect(centsToMetaMinor(500_000, "JPY")).toBe(5_000);
    expect(metaMinorToCents(5_000, "JPY")).toBe(500_000);
  });

  it("round-trips without drift", () => {
    for (const currency of ["USD", "KRW", "VND", "EUR"]) {
      expect(metaMinorToCents(centsToMetaMinor(123_400, currency), currency)).toBe(
        123_400,
      );
    }
  });

  it("defaults unknown or missing currency to cents", () => {
    expect(metaCurrencyOffset(undefined)).toBe(100);
    expect(metaCurrencyOffset("")).toBe(100);
  });
});
