import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "@/lib/config";
import { buildBrandImagePrompt, generateOpenAIImage } from "@/lib/creatives/openai-image";

async function png(color: { r: number; g: number; b: number }, size = 64): Promise<Buffer> {
  return sharp({ create: { width: size, height: size, channels: 3, background: color } }).png().toBuffer();
}

type Call = { url: string; body: unknown };

function stubFetch(handlers: Array<(url: string) => Response | null>, calls: Call[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body });
      for (const h of handlers) {
        const r = h(url);
        if (r) return r;
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

let logoDataUri: string;
let generated: Buffer;

beforeEach(async () => {
  process.env.OPENAI_API_KEY = "test-key";
  resetConfigCache();
  logoDataUri = `data:image/png;base64,${(await png({ r: 10, g: 200, b: 10 }, 32)).toString("base64")}`;
  generated = await png({ r: 240, g: 240, b: 240 }, 256);
});
afterEach(() => vi.unstubAllGlobals());

describe("buildBrandImagePrompt", () => {
  it("leaves the logo wording to the caller, which knows whether the logo is attached", () => {
    const prompt = buildBrandImagePrompt({
      brandName: "Acme",
      serviceName: "Audits",
      colors: ["#37ca37"],
      logoUrl: "https://example.com/logo.png",
    });
    expect(prompt).not.toMatch(/overlay/i);
    expect(prompt).not.toMatch(/do not invent/i);
  });
});

describe("generateOpenAIImage with a logo", () => {
  it("sends the logo to the model as a reference image and does not paste it on afterwards", async () => {
    const calls: Call[] = [];
    stubFetch(
      [(url) => (url.endsWith("/images/edits") ? json({ data: [{ b64_json: generated.toString("base64") }] }) : null)],
      calls,
    );

    const result = await generateOpenAIImage({ prompt: "Ad for Acme.", logoUrl: logoDataUri, format: "1:1" });

    expect(result.status).toBe("succeeded");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/\/images\/edits$/);
    const form = calls[0]!.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const files = form.getAll("image[]");
    expect(files).toHaveLength(1);
    expect((files[0] as File).type).toBe("image/png");
    const prompt = String(form.get("prompt"));
    expect(prompt).toMatch(/attached/i);
    expect(prompt).toMatch(/official logo/i);
    expect(prompt).not.toMatch(/do not invent/i);
    // The model's own render is returned untouched: no second composite on top.
    expect(result.b64).toBe(generated.toString("base64"));
  });

  it("falls back to a plain generation plus the logo overlay when the edit call is refused", async () => {
    const calls: Call[] = [];
    stubFetch(
      [
        (url) => (url.endsWith("/images/edits") ? json({ error: { message: "edits not allowed" } }, 400) : null),
        (url) => (url.endsWith("/images/generations") ? json({ data: [{ b64_json: generated.toString("base64") }] }) : null),
      ],
      calls,
    );

    const result = await generateOpenAIImage({ prompt: "Ad for Acme.", logoUrl: logoDataUri, format: "1:1" });

    expect(result.status).toBe("succeeded");
    expect(calls.map((c) => c.url.split("/").pop())).toEqual(["edits", "generations"]);
    const sent = JSON.parse(String(calls[1]!.body)) as { prompt: string };
    expect(sent.prompt).not.toMatch(/attached/i);
    expect(sent.prompt).toMatch(/do not invent/i);
    // The overlay changed the pixels.
    expect(result.b64).not.toBe(generated.toString("base64"));
  });

  it("without a logo, uses the plain generation and tells the model not to invent one", async () => {
    const calls: Call[] = [];
    stubFetch(
      [(url) => (url.endsWith("/images/generations") ? json({ data: [{ b64_json: generated.toString("base64") }] }) : null)],
      calls,
    );

    const result = await generateOpenAIImage({ prompt: "Ad for Acme.", format: "1:1" });

    expect(result.status).toBe("succeeded");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/\/images\/generations$/);
    expect((JSON.parse(String(calls[0]!.body)) as { prompt: string }).prompt).toMatch(/do not invent or render a logo/i);
  });

  it("carries on without a logo when the logo itself cannot be read", async () => {
    const calls: Call[] = [];
    stubFetch(
      [(url) => (url.endsWith("/images/generations") ? json({ data: [{ b64_json: generated.toString("base64") }] }) : null)],
      calls,
    );

    const result = await generateOpenAIImage({ prompt: "Ad.", logoUrl: "data:image/png;base64,AAAA", format: "1:1" });

    expect(result.status).toBe("succeeded");
    expect(calls.every((c) => c.url.endsWith("/images/generations"))).toBe(true);
  });
});
