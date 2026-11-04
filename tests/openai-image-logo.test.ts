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
  it("hands the model the logo to place naturally, and uses its image as it is", async () => {
    const calls: Call[] = [];
    stubFetch(
      [(url) => (url.endsWith("/images/edits") ? json({ data: [{ b64_json: generated.toString("base64") }] }) : null)],
      calls,
    );

    const result = await generateOpenAIImage({ prompt: "Ad for Acme.", logoUrl: await whiteBackedLogo(), format: "1:1" });

    expect(result.status).toBe("succeeded");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/\/images\/edits$/);
    const form = calls[0]!.body as FormData;
    const prompt = String(form.get("prompt"));
    expect(prompt).toMatch(/attached image is this brand's official logo on a transparent background/i);
    expect(prompt).toMatch(/wherever it sits most naturally/i);
    expect(prompt).toMatch(/never put it inside a black or dark box/i);
    expect(prompt).not.toMatch(/top-left corner clear/i);
    // The logo sent to the model has had its white backdrop removed.
    const sent = form.get("image[]") as Blob;
    const meta = await sharp(Buffer.from(await sent.arrayBuffer())).metadata();
    expect(meta.hasAlpha).toBe(true);
    expect([meta.width, meta.height]).toEqual([40, 14]);
    // Nothing is pasted over the model's own placement.
    expect(result.b64).toBe(generated.toString("base64"));
  });

  it("falls back to a plain render with the real logo pasted on when the edit is refused", async () => {
    const calls: Call[] = [];
    stubFetch(
      [
        (url) => (url.endsWith("/images/edits") ? json({ error: { message: "nope" } }, 400) : null),
        (url) => (url.endsWith("/images/generations") ? json({ data: [{ b64_json: generated.toString("base64") }] }) : null),
      ],
      calls,
    );

    const result = await generateOpenAIImage({ prompt: "Ad for Acme.", logoUrl: await whiteBackedLogo(), format: "1:1" });

    expect(result.status).toBe("succeeded");
    expect(calls.map((c) => c.url.split("/").pop())).toEqual(["edits", "generations"]);
    const sent = JSON.parse(String(calls[1]!.body)) as { prompt: string };
    expect(sent.prompt).toMatch(/top-left corner clear/i);
    expect(sent.prompt).toMatch(/do not draw, invent or imitate any logo/i);
    expect(result.b64).not.toBe(generated.toString("base64"));
  });

  it("pastes the exact logo when the logo mode is paste, without asking the model to draw it", async () => {
    process.env.OPENAI_LOGO_MODE = "paste";
    resetConfigCache();
    try {
      const calls: Call[] = [];
      stubFetch(
        [(url) => (url.endsWith("/images/generations") ? json({ data: [{ b64_json: generated.toString("base64") }] }) : null)],
        calls,
      );
      const result = await generateOpenAIImage({ prompt: "Ad.", logoUrl: await whiteBackedLogo(), format: "1:1" });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toMatch(/\/images\/generations$/);
      expect(result.b64).not.toBe(generated.toString("base64"));
    } finally {
      delete process.env.OPENAI_LOGO_MODE;
      resetConfigCache();
    }
  });

  it("pasted logo: straight on a light spot, on a white plate (never black) on a dark one", async () => {
    process.env.OPENAI_LOGO_MODE = "paste";
    resetConfigCache();
    try {
      const logo = await whiteBackedLogo();
      const place = async (bg: { r: number; g: number; b: number }) => {
        const image = await png(bg, 1024);
        stubFetch([(url) => (url.endsWith("/images/generations") ? json({ data: [{ b64_json: image.toString("base64") }] }) : null)], []);
        return (await generateOpenAIImage({ prompt: "Ad.", logoUrl: logo, format: "1:1" })).b64!;
      };
      // The logo is a dark bar pasted 5% in from the corner (about x 51, y 51, 245 wide).
      const onLight = await place({ r: 245, g: 245, b: 245 });
      expect((await pixel(onLight, 150, 90))[0]).toBeLessThan(60); // the logo itself
      expect((await pixel(onLight, 40, 40))[0]).toBeLessThan(250); // no white plate around it: still the light background
      expect((await pixel(onLight, 40, 40))[0]).toBeGreaterThan(235);

      const onDark = await place({ r: 25, g: 25, b: 30 });
      expect((await pixel(onDark, 40, 40))[0]).toBeGreaterThan(200); // a white plate behind the dark logo
      expect((await pixel(onDark, 600, 600))[0]).toBeLessThan(60); // and only there
    } finally {
      delete process.env.OPENAI_LOGO_MODE;
      resetConfigCache();
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
