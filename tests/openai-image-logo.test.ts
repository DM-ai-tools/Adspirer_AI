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
  it("leaves the logo wording to the caller, which knows how the logo is placed", () => {
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

/** The colour of one pixel of a PNG. */
async function pixel(b64: string, x: number, y: number): Promise<[number, number, number]> {
  const { data, info } = await sharp(Buffer.from(b64, "base64")).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i]!, data[i + 1]!, data[i + 2]!];
}

describe("generateOpenAIImage with a logo", () => {
  it("renders plainly with the top-left kept clear, then places the real logo on the finished image", async () => {
    const calls: Call[] = [];
    stubFetch(
      [(url) => (url.endsWith("/images/generations") ? json({ data: [{ b64_json: generated.toString("base64") }] }) : null)],
      calls,
    );

    const result = await generateOpenAIImage({ prompt: "Ad for Acme.", logoUrl: logoDataUri, format: "1:1" });

    expect(result.status).toBe("succeeded");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/\/images\/generations$/);
    const sent = JSON.parse(String(calls[0]!.body)) as { prompt: string };
    expect(sent.prompt).toMatch(/top-left corner clear/i);
    expect(sent.prompt).toMatch(/do not draw, invent or imitate any logo/i);
    expect(sent.prompt).not.toMatch(/attached/i);
    // The logo plate changed the pixels.
    expect(result.b64).not.toBe(generated.toString("base64"));
  });

  it("puts a dark logo on a light plate and a light logo on a dark plate", async () => {
    const onGrey = await png({ r: 120, g: 120, b: 120 }, 1024);
    const dark = `data:image/png;base64,${(await png({ r: 10, g: 10, b: 10 }, 64)).toString("base64")}`;
    const light = `data:image/png;base64,${(await png({ r: 250, g: 250, b: 250 }, 64)).toString("base64")}`;
    for (const [logo, expectLight] of [
      [dark, true],
      [light, false],
    ] as const) {
      stubFetch([(url) => (url.endsWith("/images/generations") ? json({ data: [{ b64_json: onGrey.toString("base64") }] }) : null)], []);
      const result = await generateOpenAIImage({ prompt: "Ad.", logoUrl: logo, format: "1:1" });
      // A point inside the plate's corner (the plate starts 4% in from the edges).
      const [r] = await pixel(result.b64!, 48, 48);
      expect(expectLight ? r > 200 : r < 60).toBe(true);
    }
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

  it("carries on with the plain image when the logo itself cannot be read", async () => {
    const calls: Call[] = [];
    stubFetch(
      [(url) => (url.endsWith("/images/generations") ? json({ data: [{ b64_json: generated.toString("base64") }] }) : null)],
      calls,
    );

    const result = await generateOpenAIImage({ prompt: "Ad.", logoUrl: "data:image/png;base64,AAAA", format: "1:1" });

    expect(result.status).toBe("succeeded");
    expect(result.b64).toBe(generated.toString("base64"));
  });
});
