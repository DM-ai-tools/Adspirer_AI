/**
 * The writer keeps repeating destination URLs from chat history or workspace
 * documents and labelling them "from the Meta creative". Meta destinations are
 * fetched deterministically, so enforce them on the reply instead of trusting
 * the prompt.
 */

const MARKER = "VERIFIED_META_DESTINATIONS";
const ALLOWED_MARKER = "OPERATOR_SUPPLIED_URLS";

function buildMarker(name: string, urls: string[]): string {
  const unique = [...new Set(urls.map((u) => u.trim()).filter(Boolean))];
  if (!unique.length) return "";
  return `<!-- ${name}: ${unique.join(" | ")} -->`;
}

function readMarker(name: string, evidence: string): string[] {
  const match = evidence.match(new RegExp(`<!--\\s*${name}:\\s*([^>]*?)\\s*-->`));
  if (!match) return [];
  return match[1]
    .split("|")
    .map((u) => u.trim())
    .filter((u) => /^https?:\/\//i.test(u));
}

/**
 * Always emitted after a destination fetch — with `none` when Meta returned no
 * Website URL, so the reply can be held to that instead of borrowing a URL.
 */
export function buildVerifiedDestinationsMarker(urls: string[]): string {
  const usable = urls.filter((u) => /^https?:\/\//i.test(u.trim()));
  return buildMarker(MARKER, usable.length ? usable : ["none"]);
}

export function readVerifiedDestinationsMarker(evidence: string): string[] {
  return readMarker(MARKER, evidence);
}

/** True when destinations were fetched from Meta, whether or not any existed. */
export function destinationsWereFetched(evidence: string): boolean {
  return new RegExp(`<!--\\s*${MARKER}:`).test(evidence);
}

/** Competitor / operator-pasted URLs that are legitimate to cite elsewhere. */
export function buildAllowedUrlsMarker(urls: string[]): string {
  return buildMarker(ALLOWED_MARKER, urls);
}

export function readAllowedUrlsMarker(evidence: string): string[] {
  return readMarker(ALLOWED_MARKER, evidence);
}

/** Markers live in evidence only — never in a reply the operator reads. */
export function stripDestinationMarkers(text: string): string {
  return text.replace(
    new RegExp(`<!--\\s*(?:${MARKER}|${ALLOWED_MARKER}):[^>]*?-->\\s*`, "g"),
    "",
  );
}

function normalize(url: string): string {
  return url.trim().replace(/[.,);\]]+$/g, "").replace(/\/+$/, "").toLowerCase();
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** example: googleconsult.trafficradius.com.au → trafficradius.com.au */
function registrableDomain(host: string): string {
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const tail = parts.slice(-3).join(".");
  if (/\.(com|net|org|gov|edu|co)\.[a-z]{2}$/i.test(tail) && parts.length >= 4) {
    return parts.slice(-4).join(".");
  }
  return parts.slice(-3).join(".");
}

const DESTINATION_CONTEXT =
  /(destination|website url|landing page|lp\b|from the meta creative|pulled (?:directly )?from)/i;

export type DestinationEnforcement = {
  text: string;
  replaced: Array<{ from: string; to: string }>;
};

const NO_DESTINATION_TEXT =
  "_no Website URL configured on the Meta creative — set Destination → Website URL in Ads Manager_";

/** Meta returned no destination: say so rather than quoting some other URL. */
function stripUnverifiedDestinationClaims(
  text: string,
  allowed: string[],
): DestinationEnforcement {
  const allowedKeys = new Set(allowed.map(normalize).filter(Boolean));
  const allowedDomains = new Set(
    allowed
      .map((u) => hostOf(u))
      .filter((h): h is string => Boolean(h))
      .map(registrableDomain),
  );
  const replaced: Array<{ from: string; to: string }> = [];

  const out = text.replace(
    /https?:\/\/[^\s)<>\]"'`]+/gi,
    (raw, offset: number) => {
      if (allowedKeys.has(normalize(raw))) return raw;
      const host = hostOf(raw);
      if (host && allowedDomains.has(registrableDomain(host))) return raw;

      const context = text.slice(
        Math.max(0, offset - 160),
        offset + raw.length + 80,
      );
      if (!DESTINATION_CONTEXT.test(context)) return raw;

      replaced.push({ from: raw, to: NO_DESTINATION_TEXT });
      return NO_DESTINATION_TEXT;
    },
  );

  return { text: out, replaced };
}

/**
 * Replace URLs the reply presents as the ad destination when they are not in the
 * verified Meta set. Allowed URLs (verified own destinations + operator-supplied
 * competitor URLs) pass through untouched.
 */
export function enforceVerifiedDestinations(
  text: string,
  options: { verified: string[]; allowed?: string[]; fetched?: boolean },
): DestinationEnforcement {
  const verified = options.verified.filter((u) => /^https?:\/\//i.test(u));
  if (!text.trim()) return { text, replaced: [] };

  if (!verified.length) {
    return options.fetched
      ? stripUnverifiedDestinationClaims(text, options.allowed ?? [])
      : { text, replaced: [] };
  }

  const verifiedKeys = new Set(verified.map(normalize));
  const allowedKeys = new Set(
    (options.allowed ?? []).map(normalize).filter(Boolean),
  );
  const verifiedDomains = new Set(
    verified
      .map((u) => hostOf(u))
      .filter((h): h is string => Boolean(h))
      .map(registrableDomain),
  );
  // Competitor / operator-supplied domains are legitimate elsewhere in the audit.
  const allowedDomains = new Set(
    (options.allowed ?? [])
      .map((u) => hostOf(u))
      .filter((h): h is string => Boolean(h))
      .map(registrableDomain),
  );
  const primary = verified[0];

  const replaced: Array<{ from: string; to: string }> = [];

  const out = text.replace(/https?:\/\/[^\s)<>\]"'`]+/gi, (raw, offset: number) => {
    const key = normalize(raw);
    if (verifiedKeys.has(key) || allowedKeys.has(key)) return raw;

    const host = hostOf(raw);
    if (!host) return raw;
    if (allowedDomains.has(registrableDomain(host))) return raw;

    const sameBrandDomain = verifiedDomains.has(registrableDomain(host));
    const context = text.slice(
      Math.max(0, offset - 160),
      offset + raw.length + 80,
    );
    const claimedAsDestination = DESTINATION_CONTEXT.test(context);

    if (!sameBrandDomain && !claimedAsDestination) return raw;

    replaced.push({ from: raw, to: primary });
    return primary;
  });

  return { text: out, replaced };
}
