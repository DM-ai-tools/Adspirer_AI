import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const warn = vi.fn();
vi.mock("@/lib/observability/logger", () => ({
  logger: { warn: (...a: unknown[]) => warn(...a), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { ShopifyApiError, streamJsonl } from "@/lib/shopify/client";

const URL_OK = "https://storage.example/result.jsonl";
const TOKEN = "shpat_SECRET_TOKEN_123";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  warn.mockClear();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A body that delivers `bytes` cut at the given offsets, one chunk per pull. */
function chunkedStream(bytes: Uint8Array, cuts: number[]): ReadableStream<Uint8Array> {
  const bounds = [0, ...cuts, bytes.length];
  let i = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (i >= bounds.length - 1) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(bounds[i], bounds[i + 1]));
        i += 1;
      },
    },
    { highWaterMark: 0 },
  );
}

/** A Response whose whole-body readers throw, so only streaming can read it. */
function streamingResponse(body: ReadableStream<Uint8Array>, status = 200): Response {
  const res = new Response(body, { status });
  const text = vi.fn(() => {
    throw new Error("res.text() must not be used");
  });
  Object.assign(res, {
    text,
    json: vi.fn(() => {
      throw new Error("res.json() must not be used");
    }),
    arrayBuffer: vi.fn(() => {
      throw new Error("res.arrayBuffer() must not be used");
    }),
  });
  return res;
}

async function collect(url: string, opts?: Parameters<typeof streamJsonl>[1]) {
  const out: Array<Record<string, unknown>> = [];
  for await (const row of streamJsonl(url, opts)) out.push(row);
  return out;
}

const ROWS = [
  { id: "gid://shopify/Product/1", title: "Café crème — tabouret 🪑" },
  { id: "gid://shopify/ProductVariant/1", __parentId: "gid://shopify/Product/1", title: "Ölmühle ✓", price: "10.50" },
  { id: "gid://shopify/Collection/1", __parentId: "gid://shopify/Product/1", title: "日本語のコレクション" },
  { id: "gid://shopify/Product/2", title: "Plain" },
];

describe("streamJsonl", () => {
  it("parses lines split at arbitrary byte positions, including inside a multi-byte character", async () => {
    // No trailing newline on the last line; one blank line in the middle; CRLF on one line.
    const text = `${JSON.stringify(ROWS[0])}\n${JSON.stringify(ROWS[1])}\r\n\n${JSON.stringify(ROWS[2])}\n${JSON.stringify(ROWS[3])}`;
    const bytes = new TextEncoder().encode(text);
    // Cut inside the 4-byte emoji, inside the 3-byte "—", inside a JSON line and at every 7th byte after.
    const emoji = bytes.indexOf(0xf0);
    const dash = bytes.indexOf(0xe2);
    const cuts = [dash + 1, emoji + 2, emoji + 3, ...Array.from({ length: 40 }, (_, k) => 120 + k * 7)]
      .filter((c) => c > 0 && c < bytes.length)
      .sort((a, b) => a - b)
      .filter((c, k, all) => k === 0 || all[k - 1] !== c);
    for (const cutSet of [cuts, Array.from({ length: bytes.length - 1 }, (_, k) => k + 1)]) {
      const res = streamingResponse(chunkedStream(bytes, cutSet));
      fetchMock.mockResolvedValueOnce(res);
      const stats = { bytes: 0, lines: 0 };
      await expect(collect(URL_OK, { stats })).resolves.toEqual(ROWS);
      expect(stats).toEqual({ bytes: bytes.length, lines: 4 });
      expect(res.text).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
      expect(res.arrayBuffer).not.toHaveBeenCalled();
    }
  });

  it("sends no headers (no token) and refuses non-https links before any request", async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"id":"a"}\n'));
    await collect(URL_OK);
    expect(fetchMock.mock.calls[0][1].headers).toBeUndefined();
    fetchMock.mockClear();
    await expect(collect("http://storage.example/x.jsonl")).rejects.toMatchObject({ code: "INVALID_URL" });
    await expect(collect("file:///etc/passwd")).rejects.toMatchObject({ code: "INVALID_URL" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a bad JSON line fails with BAD_JSONL", async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"id":"a"}\n{"id": nope}\n{"id":"c"}\n'));
    const seen: unknown[] = [];
    const err = await (async () => {
      for await (const row of streamJsonl(URL_OK)) seen.push(row);
    })().catch((e) => e);
    expect(err).toBeInstanceOf(ShopifyApiError);
    expect(err).toMatchObject({ message: "The Shopify bulk result was not valid JSON Lines.", code: "BAD_JSONL" });
    expect(seen).toEqual([{ id: "a" }]);
  });

  it("a line that is JSON but not an object fails with BAD_JSONL", async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"id":"a"}\nnull\n'));
    await expect(collect(URL_OK)).rejects.toMatchObject({ code: "BAD_JSONL" });
    fetchMock.mockResolvedValueOnce(new Response("[1,2]\n"));
    await expect(collect(URL_OK)).rejects.toMatchObject({ code: "BAD_JSONL" });
  });

  it("a stream that errors mid-way gives the fixed download error, with no token or raw text", async () => {
    let n = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          n += 1;
          if (n === 1) controller.enqueue(new TextEncoder().encode('{"id":"a"}\n{"id":"b"'));
          else controller.error(new Error(`socket hang up ${TOKEN} https://signed.example/?sig=abc`));
        },
      },
      { highWaterMark: 0 },
    );
    fetchMock.mockResolvedValueOnce(streamingResponse(body));
    const seen: unknown[] = [];
    const err = (await (async () => {
      for await (const row of streamJsonl(URL_OK)) seen.push(row);
    })().catch((e) => e)) as ShopifyApiError;
    expect(seen).toEqual([{ id: "a" }]);
    expect(err).toBeInstanceOf(ShopifyApiError);
    expect(err.message).toBe("Could not download the Shopify bulk result.");
    expect(err.status).toBe(0);
    const everything = `${err.message} ${err.detail} ${err.stack} ${JSON.stringify(warn.mock.calls)}`;
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain("sig=abc");
    // Mid-stream failures are not retried (the first byte was already consumed).
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 503 and a network error before the first byte, then streams", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(new Response('{"id":"a"}\n'));
    const p = collect(URL_OK);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toEqual([{ id: "a" }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("gives up after 3 failed attempts with the fixed message", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => new Response("busy", { status: 500 }));
    const p = collect(URL_OK).catch((e) => e);
    await vi.runAllTimersAsync();
    const err = (await p) as ShopifyApiError;
    expect(err.message).toBe("Could not download the Shopify bulk result (HTTP 500).");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("a download slower than the old whole-request timeout is not aborted while data keeps arriving", async () => {
    vi.useFakeTimers();
    // 30 chunks, 10 seconds apart: 5 minutes in all, longer than the old 120 s cap.
    let n = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          await new Promise((r) => setTimeout(r, 10_000));
          n += 1;
          if (n > 30) controller.close();
          else controller.enqueue(new TextEncoder().encode(`{"n":${n}}\n`));
        },
      },
      { highWaterMark: 0 },
    );
    fetchMock.mockResolvedValueOnce(new Response(body));
    const p = collect(URL_OK, { idleTimeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(31 * 10_000 + 1000);
    const rows = await p;
    expect(rows).toHaveLength(30);
  });

  it("a stalled download fails after the idle timeout", async () => {
    vi.useFakeTimers();
    let n = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          n += 1;
          if (n === 1) controller.enqueue(new TextEncoder().encode('{"id":"a"}\n'));
          // Then never deliver again.
          return new Promise(() => {});
        },
      },
      { highWaterMark: 0 },
    );
    fetchMock.mockResolvedValueOnce(new Response(body));
    const p = collect(URL_OK, { idleTimeoutMs: 60_000 }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(61_000);
    const err = (await p) as ShopifyApiError;
    expect(err).toBeInstanceOf(ShopifyApiError);
    expect(err.message).toBe("Could not download the Shopify bulk result.");
    expect(err.status).toBe(0);
    expect(err.detail).toMatch(/no data/i);
  });

  it("stopping early cancels the body", async () => {
    const cancel = vi.fn();
    let n = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          n += 1;
          controller.enqueue(new TextEncoder().encode(`{"n":${n}}\n`));
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    fetchMock.mockResolvedValueOnce(new Response(body));
    for await (const row of streamJsonl(URL_OK)) {
      if (row.n === 3) break;
    }
    expect(cancel).toHaveBeenCalled();
  });

  it("collects a small result with blank lines skipped", async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"id":"a"}\n{"id":"b","__parentId":"a"}\n\n'));
    const rows: Array<Record<string, unknown>> = [];
    for await (const row of streamJsonl(URL_OK)) rows.push(row);
    expect(rows).toEqual([{ id: "a" }, { id: "b", __parentId: "a" }]);
  });
});
