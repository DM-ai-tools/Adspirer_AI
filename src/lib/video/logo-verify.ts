/**
 * Decides whether a downloaded file really is a usable logo, from its pixels and not from its URL,
 * and picks the company's logo from a ranked candidate list. It never invents or substitutes a mark:
 * when nothing verifies, the answer is "none" and the caller has to say so.
 */
import sharp from "sharp";
import { loadLogoBuffer } from "@/lib/creatives/openai-image";
import type { LogoCandidate, LogoRole, LogoVerification } from "@/lib/video/pipeline-types";

// ------------------------------------------------------------------ thresholds

/** Raster logos: the shortest side must be at least this many pixels. */
export const MIN_SHORT_SIDE_PX = 64;
/** Raster logos: the width must be at least this many pixels. */
export const MIN_WIDTH_PX = 120;
/** Longest side the pixels are analysed at (bigger images are scaled down first). */
export const ANALYSIS_MAX_SIDE_PX = 256;
/** A pixel counts as visible from this alpha (0-255) and as solid from SOLID_ALPHA. */
export const VISIBLE_ALPHA = 16;
export const SOLID_ALPHA = 128;
/** A pixel with alpha below this counts as transparent when measuring the transparent share. */
export const TRANSPARENT_ALPHA = 16;
/** Fewer solid foreground pixels than this share of the image means the file is nearly blank. */
export const BLANK_SOLID_SHARE = 0.002;
/** WCAG contrast ratio a pixel needs against the plate to count as legible (3:1 is the large-graphic level). */
export const LEGIBLE_CONTRAST = 3;
/** The share of foreground pixels that must reach LEGIBLE_CONTRAST for the logo to count as legible on a plate. */
export const LEGIBLE_SHARE = 0.5;
/** Plates the logo is judged against. */
export const LIGHT_PLATE = { r: 255, g: 255, b: 255 };
export const DARK_PLATE = { r: 17, g: 17, b: 17 };
/** Border pixels within this RGB distance of their median colour make a flat, boxed background. */
export const FLAT_BACKDROP_DISTANCE = 28;
export const FLAT_BACKDROP_SHARE = 0.9;
/** A pixel this close to the backdrop colour is background, not mark. */
export const BACKDROP_PIXEL_DISTANCE = 40;
export const MAX_LOGO_BYTES = 8_000_000;
/** An svg wider than this ratio is a banner, not a logo. */
const MAX_SANE_ASPECT = 30;

// ------------------------------------------------------------------ format sniffing

export type LogoFormat = LogoVerification["format"];

const MIME_BY_FORMAT: Record<LogoFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  svg: "image/svg+xml",
  gif: "image/gif",
  unknown: "application/octet-stream",
};

export function mimeForFormat(format: LogoFormat): string {
  return MIME_BY_FORMAT[format];
}

export function extensionForFormat(format: LogoFormat): string {
  return format === "jpeg" ? "jpg" : format === "unknown" ? "bin" : format;
}

/** The real format of the bytes, from magic numbers / content. `looksLike` names other things (a web page). */
export function sniffFormat(bytes: Buffer): { format: LogoFormat; looksLike?: string } {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return { format: "png" };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { format: "jpeg" };
  if (bytes.length >= 6 && bytes.subarray(0, 4).toString("latin1") === "GIF8") return { format: "gif" };
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return { format: "webp" };
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("latin1") === "ftyp") {
    const brand = bytes.subarray(8, 12).toString("latin1");
    return { format: "unknown", looksLike: /avif|avis/.test(brand) ? "an AVIF image" : /hei|mif1/.test(brand) ? "a HEIC image" : "a video file" };
  }
  if (bytes.length >= 4 && ((bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) || bytes.subarray(0, 2).toString("latin1") === "BM")) {
    return { format: "unknown", looksLike: bytes[0] === 0 ? "an ICO icon file" : "a BMP image" };
  }
  if (bytes.subarray(0, 4).toString("latin1") === "%PDF") return { format: "unknown", looksLike: "a PDF document" };
  const head = bytes.subarray(0, 4096).toString("utf8").replace(/^﻿/, "").trimStart().toLowerCase();
  if (/<svg[\s>]/.test(head) && (head.startsWith("<svg") || head.startsWith("<?xml") || head.startsWith("<!--") || head.startsWith("<!doctype svg"))) return { format: "svg" };
  if (head.startsWith("<!doctype html") || head.startsWith("<html") || /<(?:head|body|title)[\s>]/.test(head.slice(0, 600))) return { format: "unknown", looksLike: "a web page" };
  if (/<svg[\s>]/.test(head)) return { format: "svg" };
  return { format: "unknown" };
}

// ------------------------------------------------------------------ colour maths

function channelToLinear(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function relativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * channelToLinear(r) + 0.7152 * channelToLinear(g) + 0.0722 * channelToLinear(b);
}

function contrastRatio(l1: number, l2: number): number {
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

// ------------------------------------------------------------------ verification

export type LogoBackdrop = {
  /** "transparent": real transparency. "flat": the mark sits in an opaque single-colour box. "none": a picture (photo, gradient). */
  kind: "transparent" | "flat" | "none";
  /** For a flat box: its colour. */
  colour?: { r: number; g: number; b: number };
  /** For a flat box: "white", "black" or "colour". */
  tone?: "white" | "black" | "colour";
};

export type DetailedLogoVerification = { verification: LogoVerification; backdrop: LogoBackdrop };

function svgInfo(bytes: Buffer): { sane: boolean; reason?: string } {
  const text = bytes.toString("utf8", 0, Math.min(bytes.length, 20_000));
  const tag = /<svg\b[^>]*>/i.exec(text)?.[0] ?? "";
  const viewBox = /viewBox\s*=\s*["']\s*([-\d.eE+]+)[\s,]+([-\d.eE+]+)[\s,]+([-\d.eE+]+)[\s,]+([-\d.eE+]+)\s*["']/i.exec(tag);
  const w = /\swidth\s*=\s*["']?\s*([\d.]+)/i.exec(tag);
  const h = /\sheight\s*=\s*["']?\s*([\d.]+)/i.exec(tag);
  let width = 0;
  let height = 0;
  if (viewBox) {
    width = Number(viewBox[3]);
    height = Number(viewBox[4]);
  } else if (w && h) {
    width = Number(w[1]);
    height = Number(h[1]);
  }
  if (!(width > 0) || !(height > 0)) return { sane: false, reason: "The SVG declares no usable size (no viewBox or width and height)" };
  const aspect = Math.max(width / height, height / width);
  if (aspect > MAX_SANE_ASPECT) return { sane: false, reason: `The SVG has an implausible shape (${Math.round(width)} by ${Math.round(height)})` };
  return { sane: true };
}

export async function verifyLogoDetailed(bytes: Buffer, hint?: { mime?: string }): Promise<DetailedLogoVerification> {
  const blocking: string[] = [];
  const notes: string[] = [];
  const fail = (format: LogoFormat, problem: string, width = 0, height = 0): DetailedLogoVerification => ({
    verification: { ok: false, format, width, height, hasAlpha: false, transparentShare: 0, luminance: 0, legibleOnLight: false, legibleOnDark: false, problems: [problem, ...blocking.filter((p) => p !== problem), ...notes] },
    backdrop: { kind: "none" },
  });

  if (!bytes || bytes.length === 0) return fail("unknown", "The file is empty");
  if (bytes.length > MAX_LOGO_BYTES) return fail(sniffFormat(bytes).format, `The file is too large (${(bytes.length / 1_000_000).toFixed(1)} MB)`);

  const sniff = sniffFormat(bytes);
  const format = sniff.format;
  if (format === "unknown") {
    return fail("unknown", sniff.looksLike ? `Not a usable logo: the file is ${sniff.looksLike}, not a PNG, JPEG, WebP, GIF or SVG image` : "Not a recognised image format (expected PNG, JPEG, WebP, GIF or SVG)");
  }
  if (hint?.mime) {
    const claimed = hint.mime.toLowerCase().split(";")[0]!.trim();
    const real = MIME_BY_FORMAT[format];
    const equivalent = claimed === real || (format === "jpeg" && claimed === "image/jpg") || claimed === "application/octet-stream" || claimed === "binary/octet-stream";
    if (!equivalent && claimed.startsWith("image/")) notes.push(`Served as ${claimed} but the file is really ${real}; the real format is used`);
  }

  // ---- decode
  const isSvg = format === "svg";
  let vector = false;
  let width = 0;
  let height = 0;
  let pages = 1;
  let rgba: Buffer;
  let aw = 0;
  let ah = 0;
  try {
    let density = 72;
    if (isSvg) {
      const info = svgInfo(bytes);
      if (!info.sane) return fail("svg", info.reason ?? "The SVG cannot be sized");
      vector = true;
      const meta0 = await sharp(bytes).metadata();
      width = meta0.width ?? 0;
      height = meta0.height ?? 0;
      if (!width || !height) return fail("svg", "The SVG could not be measured");
      density = Math.min(1200, Math.max(72, Math.round((72 * ANALYSIS_MAX_SIDE_PX) / Math.max(width, height))));
    } else {
      const meta = await sharp(bytes, { limitInputPixels: 80_000_000 }).metadata();
      width = meta.width ?? 0;
      height = meta.height ?? 0;
      pages = meta.pages ?? 1;
      if (!width || !height) return fail(format, "The image has no readable size");
    }
    const pipeline = sharp(bytes, isSvg ? { density } : { limitInputPixels: 80_000_000 }).ensureAlpha().resize({ width: ANALYSIS_MAX_SIDE_PX, height: ANALYSIS_MAX_SIDE_PX, fit: "inside", withoutEnlargement: !isSvg });
    const out = await pipeline.raw().toBuffer({ resolveWithObject: true });
    rgba = out.data;
    aw = out.info.width;
    ah = out.info.height;
    if (out.info.channels !== 4) return fail(format, "The image could not be read as colour pixels", width, height);
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] ?? "" : "";
    return fail(format, `The image is unreadable or corrupt${reason ? ` (${reason.slice(0, 120)})` : ""}`, width, height);
  }

  if (pages > 1) blocking.push(`It is an animated ${format.toUpperCase()} (${pages} frames); a logo must be a still image`);

  // ---- size
  if (!vector) {
    if (Math.min(width, height) < MIN_SHORT_SIDE_PX || width < MIN_WIDTH_PX) {
      blocking.push(`Too small: ${width} by ${height} pixels (a logo needs at least ${MIN_WIDTH_PX} pixels wide and ${MIN_SHORT_SIDE_PX} tall)`);
    }
  }

  // ---- pixels
  const total = aw * ah;
  let transparent = 0;
  let notOpaque = 0;
  let visible = 0;
  let lumSum = 0;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    const a = rgba[o + 3]!;
    if (a < TRANSPARENT_ALPHA) transparent++;
    if (a < 250) notOpaque++;
    if (a >= VISIBLE_ALPHA) {
      visible++;
      lumSum += 0.2126 * rgba[o]! + 0.7152 * rgba[o + 1]! + 0.0722 * rgba[o + 2]!;
    }
  }
  const transparentShare = total ? transparent / total : 0;
  const hasAlpha = notOpaque / Math.max(1, total) > 0.001;
  const luminance = visible ? Math.round((lumSum / visible) * 10) / 10 : 0;

  // ---- flat backdrop (an opaque box around the mark)
  let backdrop: LogoBackdrop = { kind: transparentShare >= 0.02 ? "transparent" : "none" };
  let bg: { r: number; g: number; b: number } | null = null;
  if (transparentShare < 0.02) {
    const border: Array<[number, number, number]> = [];
    const pushPx = (x: number, y: number) => {
      const o = (y * aw + x) * 4;
      if (rgba[o + 3]! >= SOLID_ALPHA) border.push([rgba[o]!, rgba[o + 1]!, rgba[o + 2]!]);
    };
    for (let x = 0; x < aw; x++) {
      pushPx(x, 0);
      pushPx(x, ah - 1);
    }
    for (let y = 1; y < ah - 1; y++) {
      pushPx(0, y);
      pushPx(aw - 1, y);
    }
    if (border.length > 0) {
      const median = (idx: 0 | 1 | 2) => {
        const v = border.map((p) => p[idx]).sort((a, b) => a - b);
        return v[Math.floor(v.length / 2)]!;
      };
      const m = { r: median(0), g: median(1), b: median(2) };
      const near = border.filter((p) => Math.abs(p[0] - m.r) + Math.abs(p[1] - m.g) + Math.abs(p[2] - m.b) <= FLAT_BACKDROP_DISTANCE).length;
      if (near / border.length >= FLAT_BACKDROP_SHARE) {
        bg = m;
        const lum = 0.2126 * m.r + 0.7152 * m.g + 0.0722 * m.b;
        const tone = lum > 225 ? "white" : lum < 40 ? "black" : "colour";
        backdrop = { kind: "flat", colour: m, tone };
      }
    }
  }

  // ---- foreground = solid pixels that are not the flat backdrop
  const lightL = relativeLuminance(LIGHT_PLATE.r, LIGHT_PLATE.g, LIGHT_PLATE.b);
  const darkL = relativeLuminance(DARK_PLATE.r, DARK_PLATE.g, DARK_PLATE.b);
  let fg = 0;
  let passLight = 0;
  let passDark = 0;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    const a = rgba[o + 3]!;
    if (a < SOLID_ALPHA) continue;
    const r = rgba[o]!;
    const g = rgba[o + 1]!;
    const b = rgba[o + 2]!;
    if (bg && Math.abs(r - bg.r) + Math.abs(g - bg.g) + Math.abs(b - bg.b) <= BACKDROP_PIXEL_DISTANCE) continue;
    fg++;
    const alpha = a / 255;
    const onLight = [r, g, b].map((c) => c * alpha + LIGHT_PLATE.r * (1 - alpha)) as [number, number, number];
    const onDark = [r, g, b].map((c) => c * alpha + DARK_PLATE.r * (1 - alpha)) as [number, number, number];
    if (contrastRatio(relativeLuminance(...onLight), lightL) >= LEGIBLE_CONTRAST) passLight++;
    if (contrastRatio(relativeLuminance(...onDark), darkL) >= LEGIBLE_CONTRAST) passDark++;
  }

  const blank = fg / Math.max(1, total) < BLANK_SOLID_SHARE;
  if (blank) blocking.push("The image is nearly blank: there is almost nothing visible in it");

  const legibleOnLight = !blank && fg > 0 && passLight / fg >= LEGIBLE_SHARE;
  const legibleOnDark = !blank && fg > 0 && passDark / fg >= LEGIBLE_SHARE;
  if (!blank && !legibleOnLight && !legibleOnDark) blocking.push("Not legible on a light or on a dark background: its colours are too close to both");
  else if (!blank && !legibleOnLight) notes.push("Not legible on a light background (it needs a dark plate)");
  else if (!blank && !legibleOnDark) notes.push("Not legible on a dark background (it needs a light plate)");

  if (backdrop.kind === "flat") {
    notes.push(`The mark sits in a solid ${backdrop.tone} box instead of a transparent background; the box will show unless it is removed or placed on a matching plate`);
  } else if (!hasAlpha && format !== "jpeg" && format !== "gif" && !vector) {
    notes.push("Opaque image without transparency");
  }
  if (format === "jpeg") notes.push("JPEG has no transparency; any box around the mark will show");

  const ok = blocking.length === 0 && (legibleOnLight || legibleOnDark);
  return {
    verification: {
      ok,
      format,
      width,
      height,
      hasAlpha,
      transparentShare: Math.round(transparentShare * 1000) / 1000,
      luminance,
      legibleOnLight,
      legibleOnDark,
      problems: [...blocking, ...notes],
    },
    backdrop,
  };
}

/** Verify the bytes of a candidate logo. `ok` means no blocking problem and legible on at least one plate. */
export async function verifyLogoBuffer(bytes: Buffer, hint?: { mime?: string }): Promise<LogoVerification> {
  return (await verifyLogoDetailed(bytes, hint)).verification;
}

// ------------------------------------------------------------------ fetching

export type FetchedAsset = { bytes: Buffer; mime: string };
export type ResolvedLogo = { candidate: LogoCandidate; bytes: Buffer; mime: string; verification: LogoVerification };

const FETCH_TIMEOUT_MS = 15_000;
const FETCH_MAX_BYTES = 5_000_000;
const PRIVATE_HOST = /^(?:localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|\[?::1\]?|\[?f[cd][0-9a-f]{2}:.*)$/i;

export async function defaultFetchAsset(url: string): Promise<FetchedAsset> {
  if (url.startsWith("data:")) {
    const bytes = await loadLogoBuffer(url);
    const mime = /^data:([^;,]*)/i.exec(url)?.[1]?.trim() || "application/octet-stream";
    return { bytes, mime };
  }
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Only http(s) logo URLs can be downloaded");
  if (PRIVATE_HOST.test(parsed.hostname)) throw new Error("Refusing to download from a private address");
  const res = await fetch(parsed, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: "follow",
    headers: { "User-Agent": "Mozilla/5.0 (compatible; AdspirerBrandBot/1.0)", Accept: "image/svg+xml,image/png,image/webp,image/jpeg,image/*;q=0.8,*/*;q=0.5" },
  });
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > FETCH_MAX_BYTES) throw new Error("The file is larger than 5 MB");
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > FETCH_MAX_BYTES) throw new Error("The file is larger than 5 MB");
  const mime = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase() || "application/octet-stream";
  return { bytes, mime };
}

// ------------------------------------------------------------------ choosing

export type TriedLogo = { url: string; role: LogoRole; ok: boolean; problems: string[] };

const SHARE_IMAGE_REASON = /share image/i;

function shortUrl(url: string): string {
  return url.startsWith("data:") ? `${url.slice(0, 48)}… (inline image)` : url;
}

/**
 * Try the company-role candidates best score first and keep the first one that verifies. An
 * "unknown"-role candidate is considered only when there is no company candidate at all (and is
 * marked low trust); icons, partner, client, badge and decorative images are never chosen, and a
 * social share image (og:image) is never chosen even as a last resort.
 */
export async function resolveCompanyLogo(
  candidates: LogoCandidate[],
  deps: { fetchAsset: (url: string) => Promise<FetchedAsset>; maxTries?: number },
): Promise<{ chosen: ResolvedLogo | null; tried: TriedLogo[] }> {
  const maxTries = deps.maxTries ?? 6;
  const byScore = (a: LogoCandidate, b: LogoCandidate) => b.score - a.score;
  const company = candidates.filter((c) => c.role === "company").sort(byScore);
  let pool = company;
  let lowTrust = false;
  if (company.length === 0) {
    pool = candidates.filter((c) => c.role === "unknown" && !SHARE_IMAGE_REASON.test(c.rejectedReason ?? "")).sort(byScore);
    lowTrust = pool.length > 0;
  }
  const tried: TriedLogo[] = [];
  const seen = new Set<string>();
  for (const candidate of pool) {
    if (tried.length >= maxTries) break;
    if (seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    const problems: string[] = [];
    if (lowTrust) problems.push("Low trust: this image is not marked as the company logo");
    let asset: FetchedAsset;
    try {
      asset = await deps.fetchAsset(candidate.url);
    } catch (error) {
      problems.push(`Could not download: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200));
      tried.push({ url: shortUrl(candidate.url), role: candidate.role, ok: false, problems });
      continue;
    }
    let verification: LogoVerification;
    try {
      verification = await verifyLogoBuffer(asset.bytes, { mime: asset.mime });
    } catch (error) {
      problems.push(`Could not be checked: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200));
      tried.push({ url: shortUrl(candidate.url), role: candidate.role, ok: false, problems });
      continue;
    }
    problems.push(...verification.problems);
    tried.push({ url: shortUrl(candidate.url), role: candidate.role, ok: verification.ok, problems });
    if (verification.ok) {
      return { chosen: { candidate, bytes: asset.bytes, mime: mimeForFormat(verification.format), verification }, tried };
    }
  }
  return { chosen: null, tried };
}
