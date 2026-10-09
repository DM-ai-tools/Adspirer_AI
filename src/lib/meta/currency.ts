/**
 * Meta stores budgets in the account currency's minor units, whose size
 * varies: most currencies use 100 (cents), but these have an offset of 1
 * (a JPY budget of 5000 means ¥5,000). The rest of the app works in
 * "cents" (major units × 100), so convert at the Graph boundary.
 * https://developers.facebook.com/docs/marketing-api/currencies
 */
const OFFSET_ONE_CURRENCIES = new Set([
  "CLP",
  "COP",
  "CRC",
  "HUF",
  "ISK",
  "IDR",
  "JPY",
  "KRW",
  "PYG",
  "TWD",
  "VND",
]);

export function metaCurrencyOffset(currency: string | null | undefined): number {
  return currency && OFFSET_ONE_CURRENCIES.has(currency.toUpperCase()) ? 1 : 100;
}

/** App cents (major × 100) → Meta minor units for `currency`. */
export function centsToMetaMinor(cents: number, currency: string | null | undefined): number {
  return Math.round((cents * metaCurrencyOffset(currency)) / 100);
}

/** Meta minor units for `currency` → app cents (major × 100). */
export function metaMinorToCents(minor: number, currency: string | null | undefined): number {
  return Math.round((minor * 100) / metaCurrencyOffset(currency));
}
