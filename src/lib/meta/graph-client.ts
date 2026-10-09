import { getMetaGraphVersion } from "@/lib/meta/auth";

type GraphValue = string | number | boolean | null | undefined;

type GraphErrorBody = {
  message?: string;
  error_user_msg?: string;
  error_user_title?: string;
  code?: number;
  error_subcode?: number;
  error_data?: string;
  fbtrace_id?: string;
};

function formatGraphError(error: GraphErrorBody | undefined, fallback: string): string {
  if (!error) return fallback;

  const hint =
    metaErrorHint(error.error_subcode) ?? metaErrorHintForCode(error.code);
  if (hint) return hint;

  const parts: string[] = [];
  if (error.error_user_title) parts.push(error.error_user_title);
  if (error.error_user_msg) parts.push(error.error_user_msg);
  else if (error.message) parts.push(error.message);
  if (error.code != null) parts.push(`code ${error.code}`);
  if (error.error_subcode != null) parts.push(`subcode ${error.error_subcode}`);
  return parts.length ? parts.join(" — ") : fallback;
}

/** Actionable hints for Meta errors we've hit in production approvals. */
function metaErrorHint(subcode: number | undefined): string | null {
  switch (subcode) {
    case 1885183:
      return [
        "Your Meta app is in Development mode — switch it to Live in Meta Developer Console",
        "(developers.facebook.com → your app → toggle Live), complete Business Verification",
        "and App Review for ads_management, then reconnect Facebook in Connections.",
        "Development mode cannot create ads on real ad accounts. (subcode 1885183)",
      ].join(" ");
    case 1487061:
      return [
        "Missing daily ad set budget — set budget_daily in the approval args",
        "(major currency units, e.g. 5 for £5/day). (subcode 1487061)",
      ].join(" ");
    case 1487079:
      return [
        "Radius targeting is only allowed on cities, not regions or postcodes.",
        "Remove radius from region locations or switch to a city target. (subcode 1487079)",
      ].join(" ");
    case 2490562:
      return [
        "The video_feeds placement is deprecated — use feed, story, facebook_reels, or marketplace instead.",
        "(subcode 2490562)",
      ].join(" ");
    case 4834011:
      return [
        "Meta requires is_adset_budget_sharing_enabled when budget is set on the ad set.",
        "This is handled automatically — retry approval; if it persists, contact support. (subcode 4834011)",
      ].join(" ");
    case 1815143:
      return [
        "This ad set optimizes for off-site conversions but is missing a Meta Pixel.",
        "Add pixel_id (and optional pixel_event_name, e.g. PURCHASE or LEAD) in the approval args,",
        "or use objective OUTCOME_TRAFFIC for link-click optimization without a pixel. (subcode 1815143)",
      ].join(" ");
    default:
      return null;
  }
}

function metaErrorHintForCode(code: number | undefined): string | null {
  if (code === 190) {
    return "Your Facebook connection has expired or was revoked. Reconnect Facebook (Connect Facebook in the workspace header) and try again. (code 190)";
  }
  if (code === 2) {
    return [
      "Meta API is temporarily unavailable (code 2). Wait 1–2 minutes and approve again.",
      "If it keeps failing, verify ad_set_id is the real ID from Ads Manager (not a placeholder),",
      "and that landing_page_url is set. Video uploads to Meta can also trigger this — retry helps.",
    ].join(" ");
  }
  return null;
}

/**
 * Rate-limit / transient codes worth retrying for reads. 4/17/32/613 are app,
 * user, page and custom throttles; 80000–80014 are Marketing API business-use
 * throttles; 1/2 are temporary platform errors.
 */
function isRetryableGraphError(code: number | undefined, status: number): boolean {
  if (status >= 500) return true;
  if (code == null) return false;
  return (
    code === 1 ||
    code === 2 ||
    code === 4 ||
    code === 17 ||
    code === 32 ||
    code === 613 ||
    (code >= 80000 && code <= 80014)
  );
}

const GRAPH_TIMEOUT_MS = 25_000;
const GET_MAX_ATTEMPTS = 3;

export class MetaGraphError extends Error {
  constructor(
    message: string,
    readonly code: number | undefined,
    readonly status: number,
  ) {
    super(message);
    this.name = "MetaGraphError";
  }
}

async function readGraphJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Meta occasionally answers with an HTML error page during outages.
    return {
      error: {
        message: `Meta returned an unexpected response (HTTP ${res.status}).`,
        code: res.status >= 500 ? 2 : undefined,
      },
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MetaGraphClient {
  private readonly version = getMetaGraphVersion();
  private readonly baseUrl = "https://graph.facebook.com";

  constructor(private readonly accessToken: string) {}

  /** Bearer header keeps the token out of URLs (and any logged request lines). */
  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.accessToken}` };
  }

  async get<T>(
    path: string,
    params: Record<string, GraphValue> = {},
  ): Promise<T> {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value == null) continue;
      qs.set(key, String(value));
    }
    const url = `${this.baseUrl}/${this.version}/${path}?${qs.toString()}`;

    for (let attempt = 1; ; attempt += 1) {
      let res: Response;
      try {
        res = await fetch(url, {
          method: "GET",
          headers: this.authHeaders(),
          signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
        });
      } catch (error) {
        if (attempt < GET_MAX_ATTEMPTS) {
          await sleep(500 * 2 ** (attempt - 1));
          continue;
        }
        const timedOut =
          error instanceof Error && error.name === "TimeoutError";
        throw new MetaGraphError(
          timedOut
            ? "Meta took too long to respond. Try again, or narrow the date range."
            : "Could not reach Meta. Check your connection and try again.",
          undefined,
          0,
        );
      }
      const json = await readGraphJson(res);
      if (res.ok && !json.error) return json as T;

      const error = json.error as GraphErrorBody | undefined;
      if (
        attempt < GET_MAX_ATTEMPTS &&
        isRetryableGraphError(error?.code, res.status)
      ) {
        // Exponential backoff with jitter: ~1s, ~2s.
        await sleep(1000 * 2 ** (attempt - 1) + Math.random() * 250);
        continue;
      }
      throw new MetaGraphError(
        formatGraphError(error, `Meta Graph GET failed (${res.status})`),
        error?.code,
        res.status,
      );
    }
  }

  /**
   * Fetch up to 50 objects in one request (`?ids=a,b,c`). Returns a map keyed
   * by id; ids Meta could not return are simply absent.
   */
  async getByIds<T>(
    ids: string[],
    params: Record<string, GraphValue> = {},
  ): Promise<Record<string, T>> {
    const unique = [...new Set(ids.filter(Boolean))];
    const out: Record<string, T> = {};
    for (let i = 0; i < unique.length; i += 50) {
      const chunk = unique.slice(i, i + 50);
      const batch = await this.get<Record<string, T>>("", {
        ...params,
        ids: chunk.join(","),
      });
      Object.assign(out, batch);
    }
    return out;
  }

  async post<T>(
    path: string,
    body: Record<string, GraphValue> = {},
  ): Promise<T> {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      if (value == null) continue;
      form.set(key, String(value));
    }
    // Writes are never retried automatically: a timed-out create may still
    // have succeeded on Meta's side, and repeating it would duplicate it.
    const res = await fetch(`${this.baseUrl}/${this.version}/${path}`, {
      method: "POST",
      headers: {
        ...this.authHeaders(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
      signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS * 2),
    });
    const json = await readGraphJson(res);
    if (!res.ok || json.error) {
      const error = json.error as GraphErrorBody | undefined;
      throw new MetaGraphError(
        formatGraphError(error, `Meta Graph POST failed (${res.status})`),
        error?.code,
        res.status,
      );
    }
    return json as T;
  }
}
