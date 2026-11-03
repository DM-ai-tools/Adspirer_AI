/** "https://www.Shop.com/Sofas/" → "shop.com/sofas": what makes two links the same landing page. */
function normalise(url: string): string | null {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return `${u.hostname.replace(/^www\./i, "").toLowerCase()}${u.pathname.replace(/\/+$/, "").toLowerCase()}`;
  } catch {
    return null;
  }
}

/** True when both links point at the same page (ignoring www, case, a trailing slash, query and hash). */
export function sameLandingPage(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = normalise(a);
  const y = normalise(b);
  return x != null && x === y;
}
