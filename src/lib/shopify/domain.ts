/**
 * Store address and money helpers. Pure, no I/O.
 */

const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/**
 * Returns the clean `<label>.myshopify.com` host, or null. Trims, lowercases,
 * and drops a leading `https://` plus any path, query or fragment. Anything
 * else (other hosts, suffix tricks, ports, credentials, spaces) is null, so
 * the caller refuses before any request is made.
 */
export function normalizeShopDomain(input: string): string | null {
  if (typeof input !== "string") return null;
  let value = input.trim().toLowerCase();
  if (value.startsWith("https://")) value = value.slice("https://".length);
  const end = value.search(/[/?#]/);
  if (end !== -1) value = value.slice(0, end);
  return SHOP_RE.test(value) ? value : null;
}

/**
 * Decimal money to integer cents using string maths (no float multiplication).
 * Accepts "19.99", "0", "5", "-3.5" or a finite number; anything else is null
 * ("1,234.5" included). More than two decimals round half up on the third.
 */
export function toCents(decimal: string | number | null | undefined): number | null {
  if (decimal === null || decimal === undefined) return null;
  let text: string;
  if (typeof decimal === "number") {
    if (!Number.isFinite(decimal)) return null;
    text = /e/i.test(String(decimal)) ? decimal.toFixed(8) : String(decimal);
  } else {
    text = decimal.trim();
  }
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) return null;
  const sign = m[1];
  const whole = m[2];
  const frac = m[3] ?? "";
  let cents = Number(whole + (frac + "00").slice(0, 2));
  if (frac.length > 2 && frac.charCodeAt(2) >= 53) cents += 1; // third digit 5 or more rounds up
  if (!Number.isSafeInteger(cents)) return null;
  return sign && cents !== 0 ? -cents : cents;
}
