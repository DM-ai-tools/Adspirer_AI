export type CategoryFormField =
  | "name"
  | "landing_page_url"
  | "gross_margin_pct"
  | "average_order_value"
  | "priority";

type EditResult = { ok: true; patch: Record<string, unknown> } | { ok: false; error: string };

const fail = (error: string): EditResult => ({ ok: false, error });

/**
 * A typed or imported margin as a percent, rounded to 2 decimals: a value of 1
 * or less is a fraction (0.35 -> 35) unless it was written with a % sign.
 * Shared by the inline edit and the sheet import so both read "0.35" the same.
 */
export function marginPctFromNumber(value: number, percentSign: boolean): number {
  const pct = !percentSign && value <= 1 ? value * 100 : value;
  return Math.round(pct * 100) / 100;
}

/**
 * Turns one inline-edited cell into the PATCH body for a client service.
 * Blank margin, AOV and landing page clear the value; AOV is entered in major
 * units and stored as integer cents.
 */
export function categoryPatchFromEdit(field: CategoryFormField, raw: string): EditResult {
  const text = raw.trim();
  switch (field) {
    case "name":
      return text ? { ok: true, patch: { name: text } } : fail("Name is required");
    case "landing_page_url": {
      if (!text) return { ok: true, patch: { landing_page_url: null } };
      try {
        const url = new URL(text);
        if (url.protocol === "http:" || url.protocol === "https:") {
          return { ok: true, patch: { landing_page_url: text } };
        }
      } catch {
        // falls through to the error below
      }
      return fail("Enter a full http(s) URL");
    }
    case "gross_margin_pct": {
      if (!text) return { ok: true, patch: { gross_margin_pct: null } };
      const num = Number(text.replace(/%$/, "").trim());
      if (!Number.isFinite(num) || num < 0) return fail("Margin must be a number from 0–100");
      const pct = marginPctFromNumber(num, text.endsWith("%"));
      if (pct > 100) return fail("Margin must be a number from 0–100");
      return { ok: true, patch: { gross_margin_pct: pct } };
    }
    case "average_order_value": {
      if (!text) return { ok: true, patch: { average_order_value_cents: null } };
      const num = Number(text.replace(/[$,\s]/g, ""));
      if (!Number.isFinite(num) || num < 0) return fail("Order value must be a positive amount, e.g. 189.50");
      return { ok: true, patch: { average_order_value_cents: Math.round(num * 100) } };
    }
    case "priority": {
      const num = Number(text);
      if (!text || !Number.isInteger(num) || num < 0) return fail("Priority must be a whole number, 0 or more");
      return { ok: true, patch: { priority: num } };
    }
  }
}

export type ImportOutcome =
  | { ok: true; created: number; updated: number; errors: number }
  | { ok: false; error: string };

/** Reads the import route's reply; a non-JSON or non-ok body becomes an error message, never a throw. */
export function importOutcome(httpOk: boolean, payload: unknown): ImportOutcome {
  const body = payload as {
    ok?: boolean;
    data?: { created?: number; updated?: number; errors?: unknown[] };
    error?: { message?: string };
  } | null;
  if (!httpOk || !body || body.ok !== true || !body.data) {
    return { ok: false, error: body?.error?.message ?? "Import failed" };
  }
  return {
    ok: true,
    created: body.data.created ?? 0,
    updated: body.data.updated ?? 0,
    errors: body.data.errors?.length ?? 0,
  };
}

/** Why the website scan came back empty-handed, in plain words for the panel. */
export function scanUnavailableMessage(reason: string | undefined, words: "categories" | "services"): string {
  switch (reason) {
    case "no_website":
      return `Add the client's website in Settings, then scan again. Or add ${words} by hand or import a sheet.`;
    case "not_configured":
      return `Website scan isn't set up (FIRECRAWL_API_KEY is missing). Add ${words} by hand or import a sheet.`;
    case "scan_failed":
      return `The website scan didn't work this time. Try again in a minute, or add ${words} by hand or import a sheet.`;
    default:
      return `Website scan is unavailable. Add ${words} by hand or import a sheet.`;
  }
}

export type ScanCandidate = { name: string; landing_page_url: string | null; alreadyAdded: boolean };

/**
 * Search for the scan list: every typed word must appear in the name, any
 * order, any case. Large stores return thousands of candidates, so only the
 * first `limit` are rendered while `matched` says how many there are.
 * `selectable` is what "Select all shown" adds (not the ones already added).
 */
export function filterScanCandidates<T extends ScanCandidate>(
  candidates: T[],
  query: string,
  limit = 300,
): { shown: T[]; matched: number; selectable: string[] } {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matching = words.length
    ? candidates.filter((c) => {
        const name = c.name.toLowerCase();
        return words.every((w) => name.includes(w));
      })
    : candidates;
  const shown = matching.slice(0, limit);
  return { shown, matched: matching.length, selectable: shown.filter((c) => !c.alreadyAdded).map((c) => c.name) };
}
