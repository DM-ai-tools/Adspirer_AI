import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { defaultFetchAsset, resolveCompanyLogo, sniffFormat, verifyLogoBuffer, verifyLogoDetailed, type FetchedAsset } from "@/lib/video/logo-verify";
import type { LogoCandidate, LogoRole } from "@/lib/video/pipeline-types";

type Rgba = { r: number; g: number; b: number; alpha: number };

async function solid(width: number, height: number, c: Rgba): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: c } }).png().toBuffer();
}

/** A mark (rectangle) of colour `mark` on a canvas of colour `canvas`, as PNG. */
async function logoPng(opts: { width?: number; height?: number; canvas: Rgba; mark: Rgba; markW?: number; markH?: number }): Promise<Buffer> {
  const width = opts.width ?? 300;
  const height = opts.height ?? 100;
  const mw = opts.markW ?? 160;
  const mh = opts.markH ?? 50;
  const markImg = await sharp({ create: { width: mw, height: mh, channels: 4, background: opts.mark } }).png().toBuffer();
  return sharp({ create: { width, height, channels: 4, background: opts.canvas } })
    .composite([{ input: markImg, left: Math.round((width - mw) / 2), top: Math.round((height - mh) / 2) }])
    .png()
    .toBuffer();
}

const clear: Rgba = { r: 0, g: 0, b: 0, alpha: 0 };
const white: Rgba = { r: 255, g: 255, b: 255, alpha: 1 };
const blue: Rgba = { r: 0, g: 140, b: 170, alpha: 1 };

let transparentLogo: Buffer;
let whiteBoxLogo: Buffer;

beforeAll(async () => {
  transparentLogo = await logoPng({ canvas: clear, mark: blue });
  whiteBoxLogo = await logoPng({ canvas: white, mark: blue });
});

describe("verifyLogoBuffer: format detection", () => {
  it("detects the real format from the bytes, not from the hint", async () => {
    const v = await verifyLogoBuffer(transparentLogo, { mime: "image/jpeg" });
    expect(v.format).toBe("png");
    expect(v.problems.join(" ")).toMatch(/really image\/png/);
    expect(v.ok).toBe(true);
  });
  it("sniffs the usual formats and non-images", () => {
    expect(sniffFormat(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")).format).toBe("svg");
    expect(sniffFormat(Buffer.from('<?xml version="1.0"?><!-- c --><svg viewBox="0 0 1 1"></svg>')).format).toBe("svg");
    expect(sniffFormat(Buffer.from("<!doctype html><html><body>404</body></html>"))).toEqual({ format: "unknown", looksLike: "a web page" });
    expect(sniffFormat(Buffer.from("%PDF-1.7 ...")).looksLike).toBe("a PDF document");
    expect(sniffFormat(Buffer.from("GIF89a....")).format).toBe("gif");
  });
});

describe("verifyLogoBuffer: transparency", () => {
  it("measures a transparent PNG from its pixels", async () => {
    const v = await verifyLogoBuffer(transparentLogo);
    expect(v.ok).toBe(true);
    expect(v.format).toBe("png");
    expect([v.width, v.height]).toEqual([300, 100]);
    expect(v.hasAlpha).toBe(true);
    expect(v.transparentShare).toBeGreaterThan(0.7);
    expect(v.transparentShare).toBeLessThan(0.76);
    expect(v.legibleOnLight).toBe(true);
    expect(v.legibleOnDark).toBe(true);
  });

  it("does not mistake an opaque white box around the mark for transparency, and says so", async () => {
    const { verification: v, backdrop } = await verifyLogoDetailed(whiteBoxLogo);
    expect(v.hasAlpha).toBe(false);
    expect(v.transparentShare).toBe(0);
    expect(backdrop.kind).toBe("flat");
    expect(backdrop.tone).toBe("white");
    expect(v.problems.join(" ")).toMatch(/solid white box/);
    // The mark itself is blue, so it is still judged legible; the box is the caller's problem to know about.
    expect(v.ok).toBe(true);
    expect(v.luminance).toBeGreaterThan(v.legibleOnLight ? 150 : 0);
  });

  it("reports a black box likewise", async () => {
    const buf = await logoPng({ canvas: { r: 0, g: 0, b: 0, alpha: 1 }, mark: { r: 250, g: 250, b: 250, alpha: 1 } });
    const { verification, backdrop } = await verifyLogoDetailed(buf);
    expect(backdrop).toMatchObject({ kind: "flat", tone: "black" });
    expect(verification.hasAlpha).toBe(false);
    expect(verification.legibleOnDark).toBe(true);
  });
});

describe("verifyLogoBuffer: rejects", () => {
  it("rejects a tiny raster logo", async () => {
    const v = await verifyLogoBuffer(await logoPng({ width: 48, height: 24, canvas: clear, mark: blue, markW: 30, markH: 12 }));
    expect(v.ok).toBe(false);
    expect(v.problems[0]).toMatch(/too small/i);
    expect([v.width, v.height]).toEqual([48, 24]);
  });
  it("rejects a raster that is wide enough but too short, and one that is tall but narrow", async () => {
    expect((await verifyLogoBuffer(await logoPng({ width: 400, height: 40, canvas: clear, mark: blue, markW: 300, markH: 20 }))).ok).toBe(false);
    expect((await verifyLogoBuffer(await logoPng({ width: 100, height: 200, canvas: clear, mark: blue, markW: 60, markH: 100 }))).ok).toBe(false);
  });
  it("is illegible on white but fine on dark for a white mark", async () => {
    const v = await verifyLogoBuffer(await logoPng({ canvas: clear, mark: white }));
    expect(v.legibleOnLight).toBe(false);
    expect(v.legibleOnDark).toBe(true);
    expect(v.ok).toBe(true);
    expect(v.problems.join(" ")).toMatch(/Not legible on a light background/);
  });
  it("is illegible on both plates for a washed-out mark and fails", async () => {
    const v = await verifyLogoBuffer(await logoPng({ canvas: clear, mark: { r: 130, g: 130, b: 130, alpha: 140 / 255 } }));
    expect(v.legibleOnLight).toBe(false);
    expect(v.legibleOnDark).toBe(false);
    expect(v.ok).toBe(false);
    expect(v.problems.join(" ")).toMatch(/Not legible on a light or on a dark/);
  });
  it("rejects a nearly blank image", async () => {
    const v = await verifyLogoBuffer(await solid(300, 100, clear));
    expect(v.ok).toBe(false);
    expect(v.problems.join(" ")).toMatch(/nearly blank/);
    const white = await verifyLogoBuffer(await solid(300, 100, { r: 255, g: 255, b: 255, alpha: 1 }));
    expect(white.ok).toBe(false);
    expect(white.problems.join(" ")).toMatch(/nearly blank/);
  });
  it("reports corrupt and unreadable bytes without throwing", async () => {
    const truncated = transparentLogo.subarray(0, 60);
    const v = await verifyLogoBuffer(truncated);
    expect(v.ok).toBe(false);
    expect(v.format).toBe("png");
    expect(v.problems[0]).toMatch(/unreadable or corrupt/);
    const random = await verifyLogoBuffer(Buffer.from("this is not an image at all"));
    expect(random).toMatchObject({ ok: false, format: "unknown" });
    expect((await verifyLogoBuffer(Buffer.alloc(0))).ok).toBe(false);
    const html = await verifyLogoBuffer(Buffer.from("<!DOCTYPE html><html><head><title>Not found</title></head></html>"));
    expect(html.ok).toBe(false);
    expect(html.problems[0]).toMatch(/web page/);
  });
  it("rejects an animated gif", async () => {
    const frame = await sharp({ create: { width: 200, height: 100, channels: 4, background: blue } }).raw().toBuffer();
    const frame2 = await sharp({ create: { width: 200, height: 100, channels: 4, background: { r: 200, g: 0, b: 0, alpha: 1 } } }).raw().toBuffer();
    const gif = await sharp(Buffer.concat([frame, frame2]), { raw: { width: 200, height: 200, channels: 4, pageHeight: 100 } }).gif({ loop: 0, delay: [100, 100] }).toBuffer();
    const v = await verifyLogoBuffer(gif);
    expect(v.format).toBe("gif");
    expect(v.ok).toBe(false);
    expect(v.problems.join(" ")).toMatch(/animated/i);
  });
});

describe("verifyLogoBuffer: svg and other raster formats", () => {
  const goodSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"><rect x="5" y="5" width="110" height="30" fill="#0057ff"/></svg>`;
  it("rasterises an svg, treating a small viewBox as fine because it is vector", async () => {
    const v = await verifyLogoBuffer(Buffer.from(goodSvg));
    expect(v.ok).toBe(true);
    expect(v.format).toBe("svg");
    expect([v.width, v.height]).toEqual([120, 40]);
    expect(v.hasAlpha).toBe(true);
    expect(v.transparentShare).toBeGreaterThan(0.1);
    expect(v.legibleOnLight).toBe(true);
  });
  it("rejects an svg with no size and one with an absurd shape", async () => {
    expect((await verifyLogoBuffer(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>`))).ok).toBe(false);
    expect((await verifyLogoBuffer(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5000 10"><rect width="5000" height="10"/></svg>`))).ok).toBe(false);
  });
  it("accepts svg with a leading xml prolog and comment", async () => {
    const v = await verifyLogoBuffer(Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n<!-- made by a tool -->\n${goodSvg}`));
    expect(v.ok).toBe(true);
  });
  it("handles jpeg and webp", async () => {
    const jpg = await sharp({ create: { width: 300, height: 100, channels: 3, background: { r: 255, g: 255, b: 255 } } })
      .composite([{ input: await solid(160, 50, blue), left: 70, top: 25 }])
      .jpeg()
      .toBuffer();
    const vj = await verifyLogoBuffer(jpg);
    expect(vj.format).toBe("jpeg");
    expect(vj.hasAlpha).toBe(false);
    expect(vj.ok).toBe(true);
    const webp = await sharp(transparentLogo).webp().toBuffer();
    const vw = await verifyLogoBuffer(webp);
    expect(vw.format).toBe("webp");
    expect(vw.hasAlpha).toBe(true);
    expect(vw.ok).toBe(true);
  });
});

describe("resolveCompanyLogo", () => {
  const cand = (url: string, role: LogoRole, score: number, extra: Partial<LogoCandidate> = {}): LogoCandidate => ({
    url,
    role,
    score,
    provenance: { source: "page_header", detail: "test", confidence: "high" },
    ...extra,
  });
  let files: Record<string, FetchedAsset>;
  const calls: string[] = [];
  const fetchAsset = async (url: string): Promise<FetchedAsset> => {
    calls.push(url);
    const f = files[url];
    if (!f) throw new Error("HTTP 404");
    return f;
  };

  beforeAll(async () => {
    files = {
      "https://x.example/best.png": { bytes: await logoPng({ width: 40, height: 20, canvas: clear, mark: blue, markW: 20, markH: 10 }), mime: "image/png" },
      "https://x.example/second.png": { bytes: transparentLogo, mime: "image/png" },
      "https://x.example/icon.png": { bytes: transparentLogo, mime: "image/png" },
      "https://x.example/partner.png": { bytes: transparentLogo, mime: "image/png" },
      "https://x.example/og.png": { bytes: transparentLogo, mime: "image/png" },
      "https://x.example/unknown.png": { bytes: transparentLogo, mime: "image/png" },
    };
  });

  it("tries the best score first, skips failures and verifies the next, never touching non-company roles", async () => {
    calls.length = 0;
    const out = await resolveCompanyLogo(
      [
        cand("https://x.example/icon.png", "icon", 99),
        cand("https://x.example/partner.png", "partner", 98),
        cand("https://x.example/missing.png", "company", 90),
        cand("https://x.example/best.png", "company", 85),
        cand("https://x.example/second.png", "company", 60),
      ],
      { fetchAsset },
    );
    expect(out.chosen?.candidate.url).toBe("https://x.example/second.png");
    expect(out.chosen?.verification.ok).toBe(true);
    expect(out.chosen?.mime).toBe("image/png");
    expect(calls).toEqual(["https://x.example/missing.png", "https://x.example/best.png", "https://x.example/second.png"]);
    expect(out.tried.map((t) => [t.url, t.ok])).toEqual([
      ["https://x.example/missing.png", false],
      ["https://x.example/best.png", false],
      ["https://x.example/second.png", true],
    ]);
    expect(out.tried[0]!.problems[0]).toMatch(/Could not download/);
    expect(out.tried[1]!.problems[0]).toMatch(/too small/i);
  });

  it("returns null and invents nothing when no company candidate verifies", async () => {
    const out = await resolveCompanyLogo([cand("https://x.example/icon.png", "icon", 50), cand("https://x.example/partner.png", "partner", 50), cand("https://x.example/best.png", "company", 10)], { fetchAsset });
    expect(out.chosen).toBeNull();
    expect(out.tried).toHaveLength(1);
  });

  it("uses an unknown-role image only when there is no company candidate, marked low trust", async () => {
    const out = await resolveCompanyLogo([cand("https://x.example/unknown.png", "unknown", 30), cand("https://x.example/icon.png", "icon", 40)], { fetchAsset });
    expect(out.chosen?.candidate.url).toBe("https://x.example/unknown.png");
    expect(out.tried[0]!.problems[0]).toMatch(/Low trust/);
    const withCompany = await resolveCompanyLogo([cand("https://x.example/unknown.png", "unknown", 30), cand("https://x.example/second.png", "company", 5)], { fetchAsset });
    expect(withCompany.chosen?.candidate.url).toBe("https://x.example/second.png");
  });

  it("never chooses a social share image, even as the last resort", async () => {
    const out = await resolveCompanyLogo([cand("https://x.example/og.png", "unknown", 8, { rejectedReason: "A social share image is not a logo" })], { fetchAsset });
    expect(out.chosen).toBeNull();
    expect(out.tried).toHaveLength(0);
  });

  it("respects maxTries and decodes data uris locally", async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"><rect x="5" y="5" width="110" height="30" fill="#0057ff"/></svg>`;
    const uri = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
    const out = await resolveCompanyLogo([cand(uri, "company", 70)], { fetchAsset: defaultFetchAsset });
    expect(out.chosen?.verification.format).toBe("svg");
    expect(out.chosen?.mime).toBe("image/svg+xml");
    const limited = await resolveCompanyLogo(
      [cand("https://x.example/a1.png", "company", 5), cand("https://x.example/a2.png", "company", 4), cand("https://x.example/a3.png", "company", 3)],
      { fetchAsset, maxTries: 2 },
    );
    expect(limited.tried).toHaveLength(2);
  });
});

describe("defaultFetchAsset", () => {
  it("decodes base64 and percent-encoded data uris", async () => {
    const b64 = await defaultFetchAsset(`data:image/png;base64,${transparentLogo.toString("base64")}`);
    expect(b64.mime).toBe("image/png");
    expect(b64.bytes.equals(transparentLogo)).toBe(true);
    const text = await defaultFetchAsset("data:image/svg+xml;utf8,%3Csvg%20viewBox%3D%220%200%2010%2010%22%3E%3C%2Fsvg%3E");
    expect(text.bytes.toString()).toBe('<svg viewBox="0 0 10 10"></svg>');
  });
  it("refuses private addresses and non-http schemes", async () => {
    await expect(defaultFetchAsset("http://127.0.0.1/logo.png")).rejects.toThrow(/private/);
    await expect(defaultFetchAsset("ftp://example.com/logo.png")).rejects.toThrow();
  });
});
