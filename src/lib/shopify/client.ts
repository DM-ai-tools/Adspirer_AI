import { getConfig } from "@/lib/config";
import { logger } from "@/lib/observability/logger";
import { normalizeShopDomain } from "./domain";

/** Latest stable Admin GraphQL API version on shopify.dev (checked 2026-10-23). */
export const DEFAULT_SHOPIFY_API_VERSION = "2026-10";

const SHOPIFY_TIMEOUT_MS = 25_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 3;

/** The only mutation this tool may ever send. */
export const SHOPIFY_READ_ONLY_MUTATIONS = ["bulkOperationRunQuery"];

export class ShopifyApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
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
  errors?: Array<{ message?: string; extensions?: { code?: string } }>;
};

/**
 * Read-only Admin GraphQL call. The store address is validated and the
 * document checked before any request; the token goes in the
 * X-Shopify-Access-Token header only and is scrubbed from anything thrown or
 * logged. Retries 429/5xx, THROTTLED and network errors up to 3 attempts.
 */
export async function shopifyGraphql<T>(
  shop: string,
  token: string,
  query: string,
  variables?: object,
): Promise<T> {
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
        signal: AbortSignal.timeout(SHOPIFY_TIMEOUT_MS),
      });
    } catch (error) {
      if (attempt < MAX_ATTEMPTS) {
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
      if (attempt < MAX_ATTEMPTS && (res.status === 429 || res.status >= 500)) {
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
      if (throttled && attempt < MAX_ATTEMPTS) {
        await sleep(1000 * 2 ** (attempt - 1) + Math.random() * 250);
        continue;
      }
      const first = json.errors[0];
      const code = throttled ? "THROTTLED" : (first.extensions?.code ?? null);
      logger.warn("Shopify GraphQL error", { status: res.status, code });
      throw new ShopifyApiError(redact(first.message ?? "Shopify returned an error.", token), res.status, code);
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
    const running = errors.some((e) => /already|in progress|in_progress/i.test(`${e.message} ${e.code ?? ""}`));
    if (running) {
      throw new ShopifyApiError(
        "Another Shopify bulk operation is already running for this store. Wait for it to finish and try again.",
        200,
        "BULK_OPERATION_RUNNING",
      );
    }
    throw new ShopifyApiError(
      redact(`Shopify refused the bulk query: ${errors.map((e) => e.message).join("; ")}`, token),
      200,
      errors[0].code ?? "BULK_QUERY_REFUSED",
    );
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

/** Polls until the bulk operation completes. A null url means an empty result. */
export async function waitForBulkQuery(
  shop: string,
  token: string,
  gid: string,
  opts: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<{ url: string | null; objectCount: number }> {
  const intervalMs = opts.intervalMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
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
      throw new ShopifyApiError(`Shopify bulk operation ${op.status.toLowerCase()} (${code}).`, 200, code);
    }
    if (Date.now() + intervalMs > deadline) {
      throw new ShopifyApiError("Shopify's bulk operation took too long to finish.", 0, "BULK_TIMEOUT");
    }
    await sleep(intervalMs);
  }
}

/** Downloads a bulk result file (JSON Lines) from Shopify's signed link. No token is sent. */
export async function downloadJsonl(url: string): Promise<Array<Record<string, unknown>>> {
  if (!/^https:\/\//i.test(url)) {
    throw new ShopifyApiError("Refusing to download a bulk result over a non-https link.", 0, "INVALID_URL");
  }
  for (let attempt = 1; ; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    } catch {
      if (attempt < MAX_ATTEMPTS) {
        await sleep(500 * 2 ** (attempt - 1));
        continue;
      }
      throw new ShopifyApiError("Could not download the Shopify bulk result.", 0, null);
    }
    if (!res.ok) {
      if (attempt < MAX_ATTEMPTS && (res.status === 429 || res.status >= 500)) {
        await sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
      logger.warn("Shopify bulk download failed", { status: res.status, code: null });
      throw new ShopifyApiError(`Could not download the Shopify bulk result (HTTP ${res.status}).`, res.status, null);
    }
    const text = await res.text();
    const rows: Array<Record<string, unknown>> = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        rows.push(JSON.parse(trimmed) as Record<string, unknown>);
      } catch {
        throw new ShopifyApiError("The Shopify bulk result was not valid JSON Lines.", 200, "BAD_JSONL");
      }
    }
    return rows;
  }
}
