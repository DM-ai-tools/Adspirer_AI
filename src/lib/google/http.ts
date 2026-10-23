import { logger } from "@/lib/observability/logger";

const GOOGLE_TIMEOUT_MS = 25_000;
const MAX_ATTEMPTS = 3;

export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "GoogleApiError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type GoogleErrorBody = {
  error?: string | { message?: string; status?: string; code?: number };
  error_description?: string;
};

function describeError(
  body: GoogleErrorBody | null,
  status: number,
): { message: string; code: string | null } {
  const err = body?.error;
  if (typeof err === "string") {
    return { message: body?.error_description ?? err, code: err };
  }
  if (err && typeof err === "object") {
    return {
      message: err.message ?? `Google request failed (${status})`,
      code: err.status ?? (err.code != null ? String(err.code) : null),
    };
  }
  return { message: `Google returned an unexpected response (HTTP ${status}).`, code: null };
}

/**
 * A Cloud project with only Test access calling a real Google Ads account.
 * Google's own message ("The caller does not have permission") doesn't say
 * what to do, so this one does.
 */
const TEST_ACCESS_ONLY = "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION";
const TEST_ACCESS_MESSAGE =
  "This Google Cloud project only has Test access to the Google Ads API, so it can't read real client accounts. " +
  "In Google Cloud Console, open the Google Ads API page for the project that owns this OAuth client and apply for Explorer or Basic access.";

/** Google's write endpoints: a mutate method after a colon or slash. This tool never calls them. */
const WRITE_ENDPOINT = /[:/]mutate/i;

/**
 * Read-only Google call. The token goes in the Authorization header only,
 * never the URL. Retries 429/5xx and network errors up to 3 attempts. A
 * write endpoint is refused before anything is sent.
 */
export async function googleFetch<T>(
  url: string,
  init: {
    method?: "GET" | "POST";
    accessToken: string;
    body?: unknown;
    headers?: Record<string, string>;
  },
): Promise<T> {
  if (WRITE_ENDPOINT.test(url)) {
    throw new GoogleApiError("Google is read-only in this tool: write endpoints are never called.", 0, "READ_ONLY");
  }
  const method = init.method ?? "GET";
  const headers: Record<string, string> = {
    ...init.headers,
    Authorization: `Bearer ${init.accessToken}`,
  };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";

  for (let attempt = 1; ; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
      });
    } catch (error) {
      if (attempt < MAX_ATTEMPTS) {
        await sleep(500 * 2 ** (attempt - 1));
        continue;
      }
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      throw new GoogleApiError(
        timedOut
          ? "Google took too long to respond. Try again."
          : "Could not reach Google. Check your connection and try again.",
        0,
        null,
      );
    }

    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Google occasionally answers with an HTML error page during outages.
    }
    if (res.ok) return (json ?? {}) as T;

    if (attempt < MAX_ATTEMPTS && (res.status === 429 || res.status >= 500)) {
      await sleep(1000 * 2 ** (attempt - 1) + Math.random() * 250);
      continue;
    }
    const described = describeError(json as GoogleErrorBody | null, res.status);
    const { message, code } = text.includes(TEST_ACCESS_ONLY)
      ? { message: TEST_ACCESS_MESSAGE, code: TEST_ACCESS_ONLY }
      : described;
    // Status and code only: never the URL's query, body or token.
    logger.warn("Google API call failed", { status: res.status, code });
    throw new GoogleApiError(message, res.status, code);
  }
}
