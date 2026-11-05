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

/** A logo with a white backdrop and a dark bar, like most scraped logos. */
async function whiteBackedLogo(): Promise<string> {
  const bar = await sharp({ create: { width: 40, height: 14, channels: 3, background: { r: 10, g: 10, b: 10 } } }).png().toBuffer();
  const logo = await sharp({ create: { width: 64, height: 32, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .composite([{ input: bar, left: 12, top: 9 }])
    .png()
    .toBuffer();
  return `data:image/png;base64,${logo.toString("base64")}`;
}

describe("generateOpenAIImage with a logo", () => {
  it("never sends the logo to the model: it asks for a clear area and pastes the real logo", async () => {
    const calls: Call[] = [];
    stubFetch(
      [(url) => (url.endsWith("/images/generations") ? json({ data: [{ b64_json: generated.toString("base64") }] }) : null)],
      calls,
    );

    const result = await generateOpenAIImage({ prompt: "Ad for Acme.", logoUrl: await whiteBackedLogo(), format: "1:1" });

    expect(result.status).toBe("succeeded");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/\/images\/generations$/);
    const sent = JSON.parse(String(calls[0]!.body)) as { prompt: string };
    expect(sent.prompt).toMatch(/leave one calm, uncluttered area free/i);
    expect(sent.prompt).toMatch(/do not draw, write, invent, imitate/i);
    expect(result.b64).not.toBe(generated.toString("base64"));
  });

  it("does not use the image edit endpoint at all, whatever the logo", async () => {
    const calls: Call[] = [];
    stubFetch(
      [(url) => (url.endsWith("/images/generations") ? json({ data: [{ b64_json: generated.toString("base64") }] }) : null)],
      calls,
    );
    await generateOpenAIImage({ prompt: "Ad.", logoUrl: await whiteBackedLogo(), format: "1:1" });
    expect(calls.some((c) => c.url.endsWith("/images/edits"))).toBe(false);
  });

  it("pasted logo: straight on a light spot, on a white plate (never black) on a dark one", async () => {
    const logo = await whiteBackedLogo();
    const place = async (bg: { r: number; g: number; b: number }) => {
      const image = await png(bg, 1024);
      stubFetch([(url) => (url.endsWith("/images/generations") ? json({ data: [{ b64_json: image.toString("base64") }] }) : null)], []);
      return (await generateOpenAIImage({ prompt: "Ad.", logoUrl: logo, format: "1:1" })).b64!;
    };
    // The logo is a dark bar pasted 5% in from the corner (about x 51, y 51, 245 wide).
    const onLight = await place({ r: 245, g: 245, b: 245 });
    expect((await pixel(onLight, 150, 90))[0]).toBeLessThan(60); // the logo itself
    expect((await pixel(onLight, 40, 40))[0]).toBeGreaterThan(235); // no plate: still the light background

    const onDark = await place({ r: 25, g: 25, b: 30 });
    expect((await pixel(onDark, 40, 40))[0]).toBeGreaterThan(200); // a white plate behind the dark logo
    expect((await pixel(onDark, 600, 600))[0]).toBeLessThan(60); // and only there
  });

  it("puts the logo in the calmest corner when the usual one is busy", async () => {
    // Top-left is a noisy checkerboard; the other corners are flat light.
    const size = 1024;
    const tile = 16;
    const dark = await sharp({ create: { width: tile, height: tile, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer();
    const layers = [];
    for (let y = 0; y < 300; y += tile) for (let x = 0; x < 400; x += tile) if (((x + y) / tile) % 2 === 0) layers.push({ input: dark, left: x, top: y });
    const busy = await sharp({ create: { width: size, height: size, channels: 3, background: { r: 245, g: 245, b: 245 } } })
      .composite(layers)
      .png()
      .toBuffer();
    stubFetch([(url) => (url.endsWith("/images/generations") ? json({ data: [{ b64_json: busy.toString("base64") }] }) : null)], []);
    const out = (await generateOpenAIImage({ prompt: "Ad.", logoUrl: await whiteBackedLogo(), format: "1:1" })).b64!;
    // The top-right corner now holds the dark logo bar (right-aligned, ~x 728-973, y 51-171).
    expect((await pixel(out, 850, 110))[0]).toBeLessThan(60);
  });

  it("keeps the logo clear of Meta's covered bands on 9:16", async () => {
    const image = await sharp({ create: { width: 1024, height: 1820, channels: 3, background: { r: 245, g: 245, b: 245 } } }).png().toBuffer();
    stubFetch([(url) => (url.endsWith("/images/generations") ? json({ data: [{ b64_json: image.toString("base64") }] }) : null)], []);
    const out = (await generateOpenAIImage({ prompt: "Ad.", logoUrl: await whiteBackedLogo(), format: "9:16", size: "1024x1536" })).b64!;
    const { data, info } = await sharp(Buffer.from(out, "base64")).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const topBand = Math.round(info.height * 0.14);
    for (let y = 0; y < topBand; y += 5) for (let x = 0; x < info.width; x += 5) expect(data[(y * info.width + x) * 3]!).toBeGreaterThan(200);
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
