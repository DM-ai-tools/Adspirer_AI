/**
 * Resolves the verified brand manifest for a video project: reads the landing page and its
 * stylesheets, gathers every logo candidate (page, scrape, client record, operator upload), verifies
 * the best one from its pixels, saves the ORIGINAL file under a project-scoped key, builds the claim
 * registry and assembles the manifest. Network and storage are injectable; nothing here throws for a
 * failed fetch: a failure becomes a recorded limitation and, where it matters, an issue.
 */
import { createHash } from "node:crypto";
import type { BrandUrlAnalysis } from "@/lib/brand/analyze-url";
import { getObjectStorage, type ObjectStorage } from "@/lib/storage/r2";
import { buildBrandManifest, type ManifestInput } from "@/lib/video/brand-manifest";
import { parseBrandPage, type PageEvidence } from "@/lib/video/brand-page";
import { buildClaimRegistry } from "@/lib/video/claims";
import {
  defaultFetchAsset,
  extensionForFormat,
  mimeForFormat,
  resolveCompanyLogo,
  verifyLogoBuffer,
  type FetchedAsset,
  type ResolvedLogo,
  type TriedLogo,
} from "@/lib/video/logo-verify";
import type { BrandIssue, BrandManifest, LogoCandidate } from "@/lib/video/pipeline-types";
import type { VideoAsset } from "@/lib/video/projects";

export type BrandResolveInput = {
  clientId: string;
  projectId: string;
  sourceUrl: string | null;
  scrape: BrandUrlAnalysis | null;
  client: ManifestInput["client"];
  internalLabels: ManifestInput["internalLabels"];
  offer: ManifestInput["offer"];
  operator: ManifestInput["operator"] & { logoUpload?: { bytes: Buffer; name: string } | null };
  stats: string[];
  assets: VideoAsset[];
  offerDetails?: string | null;
  instructions?: string | null;
  /** The client's saved logo as a data URI. */
  clientLogoDataUri?: string | null;
  adCtaLabel?: string | null;
};

export type FetchedPage = { html: string; css: string; limitations?: string[] };

export type BrandResolveDeps = {
  fetchPage?: (url: string) => Promise<FetchedPage>;
  fetchAsset?: (url: string) => Promise<FetchedAsset>;
  storage?: ObjectStorage;
  now?: () => string;
};

// ------------------------------------------------------------------ fetching the page

const PAGE_TIMEOUT_MS = 8_000;
const MAX_HTML = 1_500_000;
const MAX_CSS = 600_000;
const MAX_SHEETS = 3;
const UA = "Mozilla/5.0 (compatible; AdspirerBrandBot/1.0)";

async function fetchText(url: string, maxChars: number): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(PAGE_TIMEOUT_MS), headers: { "User-Agent": UA, Accept: "text/html,text/css,*/*;q=0.5" }, redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.text()).slice(0, maxChars);
}

/** Make every url(...) in a stylesheet absolute against the stylesheet's own address. */
export function absolutizeCssUrls(css: string, sheetUrl: string): string {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, _q: string, u: string) => {
    const t = u.trim();
    if (/^(?:data:|https?:|#)/i.test(t)) return m;
    try {
      return `url("${new URL(t, sheetUrl).toString()}")`;
    } catch {
      return m;
    }
  });
}

/** The page HTML and up to three stylesheets, each fetched separately so one failure costs only itself. */
export async function defaultFetchPage(url: string): Promise<FetchedPage> {
  const html = await fetchText(url, MAX_HTML); // a failure here propagates; the caller records it
  const limitations: string[] = [];
  const hrefs = [...html.matchAll(/<link\b[^>]*>/gi)]
    .map((m) => m[0])
    .filter((tag) => /rel\s*=\s*["']?stylesheet/i.test(tag))
    .map((tag) => /href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(tag))
    .map((m) => m?.[1] ?? m?.[2] ?? m?.[3])
    .filter((h): h is string => Boolean(h))
    .slice(0, MAX_SHEETS);
  const sheets = await Promise.all(
    hrefs.map(async (href) => {
      try {
        const abs = new URL(href.replace(/&amp;/g, "&"), url).toString();
        return absolutizeCssUrls(await fetchText(abs, MAX_CSS), abs);
      } catch (error) {
        limitations.push(`Stylesheet ${href.slice(0, 80)} could not be read (${error instanceof Error ? error.message : String(error)})`);
        return "";
      }
    }),
  );
  return { html, css: sheets.filter(Boolean).join("\n"), limitations };
}

// ------------------------------------------------------------------ resolving

const sha1 = (bytes: Buffer) => createHash("sha1").update(bytes).digest("hex");

export function brandStorageKey(projectId: string, bytes: Buffer, format: Parameters<typeof extensionForFormat>[0]): string {
  const safe = projectId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `video/${safe}/brand/logo-${sha1(bytes).slice(0, 12)}.${extensionForFormat(format)}`;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 160);

export async function resolveBrandManifest(input: BrandResolveInput, deps: BrandResolveDeps = {}): Promise<BrandManifest> {
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const fetchPage = deps.fetchPage ?? defaultFetchPage;
  const rawFetchAsset = deps.fetchAsset ?? defaultFetchAsset;
  // Inline images need no network, so they are always decoded locally.
  const fetchAsset = (url: string) => (url.startsWith("data:") ? defaultFetchAsset(url) : rawFetchAsset(url));
  const limitations: string[] = [];

  // ---- the page
  let page: PageEvidence | null = null;
  if (input.sourceUrl) {
    try {
      const fetched = await fetchPage(input.sourceUrl);
      limitations.push(...(fetched.limitations ?? []));
      page = parseBrandPage(fetched.html, input.sourceUrl, { css: fetched.css });
    } catch (error) {
      limitations.push(`The page ${input.sourceUrl} could not be read (${errText(error)}); the name and logo come from the other sources only`);
    }
  }

  // ---- logo candidates
  const candidates: LogoCandidate[] = [];
  const origin = new Map<string, "page" | "upload" | "client">();
  const seen = new Set<string>();
  const addCandidate = (c: LogoCandidate, o: "page" | "upload" | "client") => {
    if (seen.has(c.url)) return;
    seen.add(c.url);
    candidates.push(c);
    origin.set(c.url, o);
  };
  for (const c of page?.logoCandidates ?? []) addCandidate(c, "page");
  const shareImages = new Set((page?.logoCandidates ?? []).filter((c) => /share image/i.test(c.rejectedReason ?? "")).map((c) => c.url));
  if (input.scrape?.logo_url && !shareImages.has(input.scrape.logo_url)) {
    addCandidate({ url: input.scrape.logo_url, role: "company", score: 40, provenance: { source: "scrape", detail: "Logo URL returned by the brand scrape (low trust: verified from its pixels before use)", ...(input.sourceUrl ? { url: input.sourceUrl } : {}), confidence: "low" } }, "page");
  }
  if (input.clientLogoDataUri) {
    addCandidate({ url: input.clientLogoDataUri, role: "company", score: 70, provenance: { source: "client_record", detail: "The logo saved on the client in the app", confidence: "medium" } }, "client");
  }

  // ---- the operator's upload wins when it verifies
  const tried: TriedLogo[] = [];
  let chosen: (ResolvedLogo & { origin: "page" | "upload" | "client" }) | null = null;
  const upload = input.operator.logoUpload;
  if (upload && upload.bytes.length > 0) {
    const candidate: LogoCandidate = { url: upload.name, role: "company", score: 1000, provenance: { source: "upload", detail: `Logo file uploaded by the operator: ${upload.name}`, confidence: "high" } };
    try {
      const verification = await verifyLogoBuffer(upload.bytes);
      tried.push({ url: upload.name, role: "company", ok: verification.ok, problems: verification.problems });
      candidates.unshift(candidate);
      if (verification.ok) chosen = { candidate, bytes: upload.bytes, mime: mimeForFormat(verification.format), verification, origin: "upload" };
    } catch (error) {
      tried.push({ url: upload.name, role: "company", ok: false, problems: [`The uploaded file could not be checked: ${errText(error)}`] });
    }
  }

  // ---- the best page / scrape / client candidate
  if (!chosen) {
    try {
      const result = await resolveCompanyLogo(candidates.filter((c) => c.url !== upload?.name), { fetchAsset });
      tried.push(...result.tried);
      if (result.chosen) chosen = { ...result.chosen, origin: origin.get(result.chosen.candidate.url) ?? "page" };
    } catch (error) {
      limitations.push(`Logo checking failed unexpectedly (${errText(error)})`);
    }
  }

  // ---- save the original bytes, untouched, under this project's own prefix
  let saved: (ResolvedLogo & { storageKey: string; origin: "page" | "upload" | "client" }) | null = null;
  if (chosen) {
    try {
      const storage = deps.storage ?? getObjectStorage();
      const key = brandStorageKey(input.projectId, chosen.bytes, chosen.verification.format);
      await storage.put(key, chosen.bytes, chosen.mime);
      saved = { ...chosen, storageKey: key };
    } catch (error) {
      tried.push({ url: chosen.candidate.url.startsWith("data:") ? "inline image" : chosen.candidate.url, role: chosen.candidate.role, ok: false, problems: [`The verified logo could not be saved: ${errText(error)}`] });
    }
  }

  // ---- claims and the manifest
  const claims = buildClaimRegistry({
    stats: input.stats,
    assets: input.assets.map((a) => ({ id: a.id, name: a.name, analysis: a.analysis ?? null })),
    offerDetails: input.offerDetails,
    instructions: input.instructions,
    pageExcerpt: input.scrape?.page_excerpt ?? null,
    pageUrl: input.sourceUrl,
  });

  const manifest = buildBrandManifest({
    clientId: input.clientId,
    projectId: input.projectId,
    now,
    sourceUrl: input.sourceUrl,
    page,
    scrape: input.scrape
      ? { title: input.scrape.title ?? null, brandName: input.scrape.brand_name ?? null, colors: input.scrape.colors, summary: input.scrape.summary, logoUrl: input.scrape.logo_url }
      : null,
    client: input.client,
    internalLabels: input.internalLabels,
    offer: input.offer,
    operator: input.operator,
    logo: { chosen: saved, candidates, tried },
    claims,
    adCtaLabel: input.adCtaLabel,
  });

  // Limitations are recorded on the source URL's provenance (the manifest type has no separate field).
  for (const text of limitations) {
    manifest.sourceUrl.provenance.push({ source: "page_text", detail: `Limitation: ${text}`, ...(input.sourceUrl ? { url: input.sourceUrl } : {}), confidence: "low" });
  }
  return manifest;
}

/** The saved logo's original bytes, or null. Refuses a file that is not under this manifest's own project prefix. */
export async function loadManifestLogo(manifest: BrandManifest, storage?: ObjectStorage): Promise<Buffer | null> {
  const logo = manifest.logo;
  if (!logo) return null;
  if (manifest.projectId) {
    const safe = manifest.projectId.replace(/[^a-zA-Z0-9_-]/g, "_");
    if (!logo.storageKey.startsWith(`video/${safe}/brand/`)) return null;
  }
  try {
    return await (storage ?? getObjectStorage()).get(logo.storageKey);
  } catch {
    return null;
  }
}

/** What the editor needs: the name, whether a logo is in place, and what is blocking. */
export function manifestSummary(m: BrandManifest): { name: string | null; logo: boolean; blocking: BrandIssue[]; warnings: BrandIssue[] } {
  return {
    name: m.name.value,
    logo: m.logo !== null,
    blocking: m.issues.filter((i) => i.severity === "blocking"),
    warnings: m.issues.filter((i) => i.severity === "warning"),
  };
}

/**
 * Where a logo stands, as five separate facts. A logo that was found and saved but whose file can no
 * longer be read is NOT shown as verified: `accessible` is checked against storage every time.
 */
export type LogoState = {
  /** The public company name is verified. */
  nameVerified: boolean;
  /** A candidate for the company's own logo was found (on the page, on the client record, or uploaded). */
  found: boolean;
  /** One was verified and its original bytes were saved for this project. */
  saved: boolean;
  /** The saved file can be read from storage right now. */
  accessible: boolean;
  /** The operator has looked at this exact file and approved it. */
  approved: boolean;
};

export async function logoState(manifest: BrandManifest | null | undefined, approvedKey: string | null | undefined, storage?: ObjectStorage): Promise<LogoState> {
  const saved = Boolean(manifest?.logo);
  const accessible = saved ? Boolean(await loadManifestLogo(manifest!, storage)) : false;
  return {
    nameVerified: Boolean(manifest?.name.value) && !manifest!.issues.some((i) => i.field === "name" && i.severity === "blocking"),
    found: saved || Boolean(manifest?.logoCandidates.some((c) => c.role === "company" && !c.rejectedReason)),
    saved,
    accessible,
    approved: accessible && Boolean(approvedKey) && approvedKey === manifest!.logo!.storageKey,
  };
}

/**
 * Put a saved logo's file back when storage has lost it: from the operator's own upload, or from
 * the address it was first read from. Only the SAME file is restored (the storage key carries a hash
 * of its bytes): if what comes back now is different, nothing is saved and the brand has to be
 * checked again, because a different picture must never quietly take the verified one's place.
 */
export async function restoreManifestLogo(manifest: BrandManifest, sources: { uploadKey?: string | null }, deps: { storage?: ObjectStorage; fetchAsset?: (url: string) => Promise<FetchedAsset> } = {}): Promise<boolean> {
  const logo = manifest.logo;
  if (!logo || !manifest.projectId) return false;
  const storage = deps.storage ?? getObjectStorage();
  if (await loadManifestLogo(manifest, storage)) return true;
  const candidates: Array<() => Promise<Buffer | null>> = [];
  if (sources.uploadKey) candidates.push(() => storage.get(sources.uploadKey!));
  if (logo.sourceUrl && /^https?:/i.test(logo.sourceUrl)) candidates.push(async () => (await (deps.fetchAsset ?? defaultFetchAsset)(logo.sourceUrl!)).bytes);
  for (const load of candidates) {
    try {
      const bytes = await load();
      if (!bytes?.length) continue;
      if (brandStorageKey(manifest.projectId, bytes, logo.verification.format) !== logo.storageKey) continue;
      await storage.put(logo.storageKey, bytes, logo.mime);
      return true;
    } catch {
      // try the next source
    }
  }
  return false;
}
