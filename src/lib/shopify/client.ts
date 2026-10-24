import { getConfig } from "@/lib/config";
import { logger } from "@/lib/observability/logger";
import { normalizeShopDomain } from "./domain";

/** Latest stable Admin GraphQL API version on shopify.dev (checked 2026-10-23). */
export const DEFAULT_SHOPIFY_API_VERSION = "2026-10";

const SHOPIFY_TIMEOUT_MS = 25_000;
/** Bulk result download: per-attempt wait for headers. */
const DOWNLOAD_CONNECT_TIMEOUT_MS = 30_000;
/** Bulk result download: longest gap between body chunks before the transfer counts as stalled. */
const DOWNLOAD_IDLE_TIMEOUT_MS = 120_000;
/** Bulk result download: generous cap on the whole transfer (a result can be several GB). */
const DOWNLOAD_MAX_MS = 60 * 60_000;
/** Longest single JSON Lines record accepted (a bulk record is a few KB at most). */
const MAX_JSONL_LINE_CHARS = 16 * 1024 * 1024;
const MAX_ATTEMPTS = 3;

/** The only mutation this tool may ever send. */
export const SHOPIFY_READ_ONLY_MUTATIONS = ["bulkOperationRunQuery"];

export class ShopifyApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    /**
     * For server logs only, never stored or shown: Shopify's own validation text
     * (userErrors / GraphQL error messages with their field paths, bulk errorCode),
     * with the token redacted. It holds no customer data.
     */
    readonly detail: string | null = null,
  ) {
    super(message);
    this.name = "ShopifyApiError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redact(text: string, token: string): string {
  return token ? text.split(token).join("[redacted]") : text;
}

/**
 * Throws READ_ONLY unless the document holds only `query` operations (or
 * shorthand `{ ... }`), fragments, and mutations whose every top-level field
 * is in SHOPIFY_READ_ONLY_MUTATIONS. Subscriptions are refused. Strings and
 * comments are blanked first (by one lexer) so they cannot hide or fake a keyword.
 */
export function assertReadOnlyDocument(document: string): void {
  const refuse = (why: string): never => {
    throw new ShopifyApiError(`Shopify is read-only in this tool: ${why}`, 0, "READ_ONLY");
  };
  // Single left-to-right lexer: comments, block strings and strings are blanked
  // in one pass so a quote inside a comment can never pair with a later quote.
  let src = "";
  for (let i = 0; i < document.length; ) {
    const ch = document[i];
    if (ch === "#") {
      while (i < document.length && document[i] !== "\n" && document[i] !== "\r") i += 1;
      src += " ";
    } else if (document.startsWith('"""', i)) {
      let j = i + 3;
      for (;;) {
        if (j >= document.length) refuse("unterminated block string.");
        if (document.startsWith('\\"""', j)) j += 4;
        else if (document.startsWith('"""', j)) break;
        else j += 1;
      }
      i = j + 3;
      src += '""';
    } else if (ch === '"') {
      let j = i + 1;
      for (;;) {
        const c = document[j];
        if (c === undefined || c === "\n" || c === "\r") refuse("unterminated string.");
        if (c === "\\") {
          const n = document[j + 1];
          if (n === undefined || n === "\n" || n === "\r") refuse("unterminated string.");
          j += 2;
        } else if (c === '"') break;
        else j += 1;
      }
      i = j + 1;
      src += '""';
    } else {
      src += ch;
      i += 1;
    }
  }

  let brace = 0;
  let paren = 0;
  let sawOperation = false;
  let pendingMutation = false;
  let inMutation = false;
  const re = /[A-Za-z_][A-Za-z0-9_]*|\.\.\.|[{}():@]|[^\s]/g;
  let prev = "";
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const tok = m[0];
    if (tok === "(") paren += 1;
    else if (tok === ")") paren -= 1;
    else if (paren > 0) {
      // arguments and variable definitions: nothing to check
    } else if (tok === "{") {
      if (brace === 0) {
        sawOperation = true;
        inMutation = pendingMutation;
        pendingMutation = false;
      }
      brace += 1;
    } else if (tok === "}") {
      brace -= 1;
      if (brace === 0) inMutation = false;
    } else if (brace === 0) {
      if (tok === "mutation") pendingMutation = true;
      else if (tok === "subscription") refuse("subscriptions are never sent.");
    } else if (inMutation && brace === 1) {
      if (tok === "...") refuse("fragments inside a mutation are not allowed.");
      else if (/^[A-Za-z_]/.test(tok) && prev !== "@") {
        const next = src.slice(m.index + tok.length).match(/^\s*(.)/)?.[1];
        // An identifier followed by ":" is an alias; the field name comes after it.
        if (next !== ":" && !SHOPIFY_READ_ONLY_MUTATIONS.includes(tok)) {
          refuse(`mutation "${tok}" is not allowed.`);
        }
      }
    }
    prev = tok;
  }
  if (pendingMutation) refuse("a mutation without a selection set.");
  if (!sawOperation) refuse("no operation found.");
}

type GraphqlResponse<T> = {
  data?: T;
  errors?: Array<{ message?: string; path?: Array<string | number>; extensions?: { code?: string } }>;
};

/** "path: message [CODE]" for each error, for logs. */
function describeErrors(
  errors: Array<{ message?: string; field?: Array<string | number> | null; path?: Array<string | number>; code?: string | null }>,
  token: string,
): string {
  return redact(
    errors
      .map((e) => {
        const where = (e.field ?? e.path ?? []).join(".");
        return `${where ? `${where}: ` : ""}${e.message ?? "(no message)"}${e.code ? ` [${e.code}]` : ""}`;
      })
      .join("; "),
    token,
  );
}

/** Per-call limits for shopifyGraphql. The defaults (3 attempts, 25 s each) suit the sync. */
export type ShopifyGraphqlOptions = {
  /** Total attempts, including the first (default 3, at least 1). */
  attempts?: number;
  /** Per-attempt timeout in ms (default 25 000). */
  timeoutMs?: number;
};

/**
 * Read-only Admin GraphQL call. The store address is validated and the
 * document checked before any request; the token goes in the
 * X-Shopify-Access-Token header only and is scrubbed from anything thrown or
 * logged. Retries 429/5xx, THROTTLED and network errors up to `attempts` (default 3)
 * attempts, each with a `timeoutMs` (default 25 s) timeout.
 */
export async function shopifyGraphql<T>(
  shop: string,
  token: string,
  query: string,
  variables?: object,
  opts: ShopifyGraphqlOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, Math.floor(opts.attempts ?? MAX_ATTEMPTS));
  const timeoutMs = opts.timeoutMs ?? SHOPIFY_TIMEOUT_MS;
  const host = normalizeShopDomain(shop);
  if (!host) {
    throw new ShopifyApiError("That is not a valid Shopify store address (expected name.myshopify.com).", 0, "INVALID_SHOP");
  }
  assertReadOnlyDocument(query);

  const version = getConfig().SHOPIFY_API_VERSION || DEFAULT_SHOPIFY_API_VERSION;
  const url = `https://${host}/admin/api/${version}/graphql.json`;
  const body = JSON.stringify({ query, variables: variables ?? {} });

  for (let attempt = 1; ; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (attempt < maxAttempts) {
        await sleep(500 * 2 ** (attempt - 1));
        continue;
      }
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      // Fixed text: the underlying error is never echoed.
      throw new ShopifyApiError(
        timedOut
          ? "Shopify took too long to respond. Try again."
          : "Could not reach Shopify. Check the store address and try again.",
        0,
        null,
      );
    }

    const text = await res.text();
    let json: GraphqlResponse<T> | null = null;
    try {
      json = text ? (JSON.parse(text) as GraphqlResponse<T>) : null;
    } catch {
      // HTML error page during an outage.
    }

    if (!res.ok) {
      if (attempt < maxAttempts && (res.status === 429 || res.status >= 500)) {
        await sleep(1000 * 2 ** (attempt - 1) + Math.random() * 250);
        continue;
      }
      const unauthorized = res.status === 401 || res.status === 403;
      const code = unauthorized ? "UNAUTHORIZED" : null;
      logger.warn("Shopify API call failed", { status: res.status, code });
      throw new ShopifyApiError(
        unauthorized
          ? "Shopify rejected the access token. Reconnect the store."
          : res.status === 404
            ? "Shopify could not find that store. Check the store address."
            : `Shopify request failed (HTTP ${res.status}).`,
        res.status,
        code,
      );
    }

    if (json?.errors?.length) {
      const throttled = json.errors.some((e) => e.extensions?.code === "THROTTLED");
      if (throttled && attempt < maxAttempts) {
        await sleep(1000 * 2 ** (attempt - 1) + Math.random() * 250);
        continue;
      }
      const first = json.errors[0];
      const code = throttled ? "THROTTLED" : (first.extensions?.code ?? null);
      logger.warn("Shopify GraphQL error", { status: res.status, code });
      throw new ShopifyApiError(
        redact(first.message ?? "Shopify returned an error.", token),
        res.status,
        code,
        describeErrors(
          json.errors.map((e) => ({ message: e.message, path: e.path, code: e.extensions?.code ?? null })),
          token,
        ),
      );
    }

    if (!json || json.data === undefined) {
      logger.warn("Shopify returned an unexpected response", { status: res.status, code: null });
      throw new ShopifyApiError("Shopify returned an unexpected response.", res.status, null);
    }
    return json.data;
  }
}

const START_BULK = `mutation StartBulk($query: String!) {
  bulkOperationRunQuery(query: $query) {
    bulkOperation { id status }
    userErrors { field message code }
  }
}`;

/** Starts a bulk read of `innerQuery`; returns the operation gid. */
export async function startBulkQuery(shop: string, token: string, innerQuery: string): Promise<string> {
  const data = await shopifyGraphql<{
    bulkOperationRunQuery: {
      bulkOperation: { id: string; status: string } | null;
      userErrors: Array<{ field?: string[] | null; message: string; code?: string | null }>;
    };
  }>(shop, token, START_BULK, { query: innerQuery });
  const result = data.bulkOperationRunQuery;
  const errors = result?.userErrors ?? [];
  if (errors.length) {
    const detail = describeErrors(errors, token);
    const running = errors.some((e) => /already|in progress|in_progress/i.test(`${e.message} ${e.code ?? ""}`));
    if (running) {
      throw new ShopifyApiError(
        "Another Shopify bulk operation is already running for this store. Wait for it to finish and try again.",
        200,
        "BULK_OPERATION_RUNNING",
        detail,
      );
    }
    // Shopify's validation text goes to `detail` (logged by the caller), not the message.
    throw new ShopifyApiError("Shopify refused the bulk query.", 200, errors[0].code ?? "BULK_QUERY_REFUSED", detail);
  }
  const id = result?.bulkOperation?.id;
  if (!id) throw new ShopifyApiError("Shopify did not start the bulk operation.", 200, null);
  return id;
}

const POLL_BULK = `query PollBulk($id: ID!) {
  node(id: $id) {
    ... on BulkOperation { id status errorCode objectCount url }
  }
}`;

/**
 * Polls until the bulk operation completes. A null url means an empty result.
 * `onPoll` runs before every poll (e.g. a heartbeat for a long wait); if it throws, the
 * wait stops with that error.
 */
export async function waitForBulkQuery(
  shop: string,
  token: string,
  gid: string,
  opts: { intervalMs?: number; timeoutMs?: number; onPoll?: () => Promise<void> | void } = {},
): Promise<{ url: string | null; objectCount: number }> {
  const intervalMs = opts.intervalMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await opts.onPoll?.();
    const data = await shopifyGraphql<{
      node: { status: string; errorCode?: string | null; objectCount?: string | number | null; url?: string | null } | null;
    }>(shop, token, POLL_BULK, { id: gid });
    const op = data.node;
    if (!op) throw new ShopifyApiError("Shopify no longer has that bulk operation.", 200, "BULK_NOT_FOUND");
    if (op.status === "COMPLETED") {
      return { url: op.url ?? null, objectCount: Number(op.objectCount ?? 0) || 0 };
    }
    if (op.status === "FAILED" || op.status === "EXPIRED" || op.status === "CANCELED") {
      const code = op.errorCode ?? op.status;
      throw new ShopifyApiError(
        `Shopify bulk operation ${op.status.toLowerCase()} (${code}).`,
        200,
        code,
        `bulk operation ${op.status}, errorCode ${op.errorCode ?? "none"}`,
      );
    }
    if (Date.now() + intervalMs > deadline) {
      throw new ShopifyApiError("Shopify's bulk operation took too long to finish.", 0, "BULK_TIMEOUT");
    }
    await sleep(intervalMs);
  }
}

/** Running totals of a bulk download, for the sync's info log (counts only). */
export type JsonlStreamStats = { bytes: number; lines: number };

export type StreamJsonlOptions = {
  /** Per attempt: how long to wait for the response headers. */
  connectTimeoutMs?: number;
  /** Fails the download if no bytes arrive for this long (a stalled transfer). */
  idleTimeoutMs?: number;
  /** Hard cap on the whole download, however steadily the bytes arrive. */
  maxMs?: number;
  /** Updated as the stream is read. */
  stats?: JsonlStreamStats;
};

const BAD_JSONL_MESSAGE = "The Shopify bulk result was not valid JSON Lines.";
const DOWNLOAD_FAILED_MESSAGE = "Could not download the Shopify bulk result.";

function badJsonl(): ShopifyApiError {
  return new ShopifyApiError(BAD_JSONL_MESSAGE, 200, "BAD_JSONL");
}

/** One JSON Lines record: a JSON object, or null for a blank line. */
function parseJsonlLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    throw badJsonl();
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw badJsonl();
  return value as Record<string, unknown>;
}

/**
 * Streams a bulk result file (JSON Lines) from Shopify's signed link, one object at a time.
 * The file can be far larger than the biggest string V8 can hold, so it is never read whole:
 * bytes are decoded incrementally and split on newlines across chunk boundaries. No token is
 * sent. Connect errors, 429 and 5xx are retried (3 attempts) before the first body byte is
 * read; after that any failure is final. Timeouts: `connectTimeoutMs` per attempt for the
 * headers, then `idleTimeoutMs` per read while waiting on the network (time the consumer
 * spends between objects does not count), and `maxMs` for the whole download.
 */
export async function* streamJsonl(
  url: string,
  opts: StreamJsonlOptions = {},
): AsyncGenerator<Record<string, unknown>, void, undefined> {
  if (!/^https:\/\//i.test(url)) {
    throw new ShopifyApiError("Refusing to download a bulk result over a non-https link.", 0, "INVALID_URL");
  }
  const connectMs = opts.connectTimeoutMs ?? DOWNLOAD_CONNECT_TIMEOUT_MS;
  const idleMs = opts.idleTimeoutMs ?? DOWNLOAD_IDLE_TIMEOUT_MS;
  const maxMs = opts.maxMs ?? DOWNLOAD_MAX_MS;
  const stats = opts.stats ?? { bytes: 0, lines: 0 };
  const started = Date.now();

  let res: Response;
  let controller: AbortController;
  for (let attempt = 1; ; attempt += 1) {
    controller = new AbortController();
    const connectTimer = setTimeout(() => controller.abort(), connectMs);
    try {
      res = await fetch(url, { signal: controller.signal });
    } catch {
      if (attempt < MAX_ATTEMPTS) {
        await sleep(500 * 2 ** (attempt - 1));
        continue;
      }
      throw new ShopifyApiError(DOWNLOAD_FAILED_MESSAGE, 0, null, "no response from the bulk result link");
    } finally {
      clearTimeout(connectTimer);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      if (attempt < MAX_ATTEMPTS && (res.status === 429 || res.status >= 500)) {
        await sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
      logger.warn("Shopify bulk download failed", { status: res.status, code: null });
      throw new ShopifyApiError(`Could not download the Shopify bulk result (HTTP ${res.status}).`, res.status, null);
    }
    break;
  }

  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  // Fixed text for the log; the underlying error (which may echo the signed link) is dropped.
  const failed = (why: string) =>
    new ShopifyApiError(DOWNLOAD_FAILED_MESSAGE, 0, null, `${why} after ${stats.bytes} bytes, ${stats.lines} lines`);

  let stop!: (reason: string) => void;
  const stopped = new Promise<never>((_, reject) => {
    stop = (reason) => {
      controller.abort();
      reject(failed(reason));
    };
  });
  stopped.catch(() => undefined);
  const capTimer = setTimeout(
    () => stop(`download exceeded ${Math.round(maxMs / 1000)}s`),
    Math.max(0, maxMs - (Date.now() - started)),
  );
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let done = false;

  try {
    let buffer = "";
    for (;;) {
      idleTimer = setTimeout(() => stop(`no data for ${Math.round(idleMs / 1000)}s`), idleMs);
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await Promise.race([reader.read(), stopped]);
      } catch (error) {
        throw error instanceof ShopifyApiError ? error : failed("download stream failed");
      } finally {
        clearTimeout(idleTimer);
      }
      if (chunk.done) {
        done = true;
        break;
      }
      stats.bytes += chunk.value.byteLength;
      buffer += decoder.decode(chunk.value, { stream: true });
      let start = 0;
      for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n", start)) {
        const row = parseJsonlLine(buffer.slice(start, nl));
        start = nl + 1;
        if (row) {
          stats.lines += 1;
          yield row;
        }
      }
      if (start > 0) buffer = buffer.slice(start);
      // One record should never come near this; refuse rather than grow without bound.
      if (buffer.length > MAX_JSONL_LINE_CHARS) throw badJsonl();
    }
    // The last line may have no trailing newline.
    const row = parseJsonlLine(buffer + decoder.decode());
    if (row) {
      stats.lines += 1;
      yield row;
    }
  } finally {
    clearTimeout(capTimer);
    clearTimeout(idleTimer);
    if (!done) await reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      // A read still pending after cancel; the stream is finished either way.
    }
  }
}
