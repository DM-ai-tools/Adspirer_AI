import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { buildBrandManifest, isInternalLabel, stripLegalSuffix, type ManifestInput } from "@/lib/video/brand-manifest";
import { parseBrandPage } from "@/lib/video/brand-page";
import { brandStorageKey, loadManifestLogo, manifestSummary, resolveBrandManifest, type BrandResolveInput } from "@/lib/video/brand-resolve";
import type { FetchedAsset, ResolvedLogo } from "@/lib/video/logo-verify";
import { manifestReady, type LogoCandidate, type LogoVerification } from "@/lib/video/pipeline-types";
import type { ObjectStorage } from "@/lib/storage/r2";

// ------------------------------------------------------------------ helpers

const okVerification: LogoVerification = { ok: true, format: "png", width: 400, height: 120, hasAlpha: true, transparentShare: 0.6, luminance: 90, legibleOnLight: true, legibleOnDark: true, problems: [] };

function candidate(url: string, over: Partial<LogoCandidate> = {}): LogoCandidate {
  return { url, role: "company", score: 85, provenance: { source: "page_header", detail: "<header> <img> in the home link", url: "https://acme.example/", confidence: "high" }, ...over };
}

function chosen(url = "https://acme.example/logo.png", over: Partial<LogoCandidate> = {}, origin: "page" | "upload" | "client" = "page"): NonNullable<ManifestInput["logo"]["chosen"]> {
  const resolved: ResolvedLogo = { candidate: candidate(url, over), bytes: Buffer.from("x"), mime: "image/png", verification: okVerification };
  return { ...resolved, storageKey: "video/p1/brand/logo-abc.png", origin };
}

function base(over: Partial<ManifestInput> = {}): ManifestInput {
  return {
    clientId: "c1",
    projectId: "p1",
    now: "2026-11-09T00:00:00.000Z",
    sourceUrl: "https://acme.example/",
    page: null,
    scrape: null,
    client: {},
    internalLabels: [],
    offer: {},
    operator: {},
    logo: { chosen: null, candidates: [], tried: [] },
    claims: [],
    ...over,
  };
}

const codes = (m: ReturnType<typeof buildBrandManifest>, severity?: "blocking" | "warning") => m.issues.filter((i) => !severity || i.severity === severity).map((i) => i.code);

// ------------------------------------------------------------------ internal labels

describe("isInternalLabel", () => {
  it("flags working titles, versions, file names, slugs and addresses", () => {
    for (const t of [
      "TR Internal Marketing Version 1",
      "Acme Internal Marketing Version 1",
      "Landing page v2 - final",
      "meta-audit-2026-09-02.pdf",
      "Untitled",
      "Draft",
      "Acme (copy)",
      "final_video_export",
      "Q3 Campaign Final",
      "Test 2",
      "https://acme.example/landing",
      "www.acme.example",
      "acme.com.au",
      "3f2b8c1e-9d4a-4e7b-8c11-1a2b3c4d5e6f",
      "IMG_4021",
      "Acme Marketing v3",
    ]) {
      expect(isInternalLabel(t).internal, t).toBe(true);
      expect(isInternalLabel(t).reason, t).toBeTruthy();
    }
  });
  it("does not flag real names that merely contain a working word", () => {
    for (const t of ["Acme Pty Ltd", "Campaign Monitor", "Project Management Institute", "Final Frontier Pizza", "Test Gym", "Zenith Studio", "Brown & Co", "Oracle", "Studio 54"]) {
      expect(isInternalLabel(t).internal, t).toBe(false);
    }
  });
  it("flags anything equal to or containing a known internal label", () => {
    expect(isInternalLabel("Wheeler Q4 push", { known: ["Wheeler Q4 push"] }).internal).toBe(true);
    expect(isInternalLabel("Welcome to Wheeler Q4 push", { known: ["Wheeler Q4 push"] }).internal).toBe(true);
    expect(isInternalLabel("Wheeler", { known: ["Wheeler Q4 push"] }).internal).toBe(false);
    expect(isInternalLabel("Wheeler", { known: ["wheeler"] }).reason).toMatch(/matches an internal label/);
  });
  it("strips legal suffixes for the public name", () => {
    expect(stripLegalSuffix("Acme Pty Ltd")).toBe("Acme");
    expect(stripLegalSuffix("Acme Pty. Ltd.")).toBe("Acme");
    expect(stripLegalSuffix("Zeta Labs, Inc.")).toBe("Zeta Labs");
    expect(stripLegalSuffix("Brown & Co")).toBe("Brown & Co");
    expect(stripLegalSuffix("Foo Bar LLC")).toBe("Foo Bar");
    expect(stripLegalSuffix("Ltd")).toBe("Ltd");
  });
});

// ------------------------------------------------------------------ names

describe("buildBrandManifest: name", () => {
  it("resolves JSON-LD 'Acme' against a title 'Acme Pty Ltd | Best Ads' and records the difference", () => {
    const page = parseBrandPage(
      `<html><head><title>Acme Pty Ltd | Best Ads</title><script type="application/ld+json">{"@type":"Organization","name":"Acme"}</script></head><body></body></html>`,
      "https://acme.example/",
    );
    const m = buildBrandManifest(base({ page }));
    expect(m.name.value).toBe("Acme");
    expect(m.name.provenance[0]!.source).toBe("page_jsonld");
    expect(m.name.provenance.some((p) => p.source === "page_meta")).toBe(true);
    const c = m.conflicts.find((x) => x.field === "name")!;
    expect(c).toBeTruthy();
    expect(c.chosen).toBe("Acme");
    expect(c.values.map((v) => v.value).sort()).toEqual(["Acme", "Acme Pty Ltd"]);
    expect(c.reason).toMatch(/legal suffix/);
    expect(codes(m)).not.toContain("name_missing");
    expect(m.issues.some((i) => i.code === "name_conflict" && i.severity === "blocking")).toBe(false);
    // Both forms are recorded; the legal form is never the public name.
    expect(m.nameCandidates.some((n) => n.value === "Acme Pty Ltd" && n.rejectedReason)).toBe(true);
  });

  it("a real disagreement is a warning when trust decides it, with the higher-trust source chosen", () => {
    const page = parseBrandPage(`<html><head><script type="application/ld+json">{"@type":"Organization","name":"Acme"}</script></head><body><footer>© 2026 Zenith Holdings Pty Ltd. All rights reserved.</footer></body></html>`, "https://acme.example/");
    const m = buildBrandManifest(base({ page }));
    expect(m.name.value).toBe("Acme");
    const issue = m.issues.find((i) => i.code === "name_conflict")!;
    expect(issue.severity).toBe("warning");
    expect(m.conflicts.find((c) => c.chosen === "Acme" && c.values.length === 2)!.reason).toMatch(/higher-trust source/);
    expect(m.issues.filter((i) => i.field === "name" && i.severity === "blocking")).toEqual([]);
  });

  it("two sources of equal standing that disagree block, with no name chosen", () => {
    const page = parseBrandPage(`<html><body><header><a href="/"><img src="/l.png" alt="Alpha Works"></a><a class="navbar-brand" href="/">Beta Studio</a></header></body></html>`, "https://x.example/");
    const m = buildBrandManifest(base({ page, sourceUrl: null }));
    // Both come from the header: equal standing, so nothing decides between them.
    expect(m.name.value).toBeNull();
    expect(m.issues.find((i) => i.code === "name_conflict")).toMatchObject({ severity: "blocking", field: "name" });
    expect(m.conflicts[0]!.chosen).toBeNull();
    expect(m.conflicts[0]!.values.map((v) => v.value).sort()).toEqual(["Alpha Works", "Beta Studio"]);
  });

  it("operator-confirmed name always wins, even against JSON-LD", () => {
    const page = parseBrandPage(`<script type="application/ld+json">{"@type":"Organization","name":"Acme"}</script>`, "https://acme.example/");
    const m = buildBrandManifest(base({ page, operator: { brandName: "Zenith Digital" } }));
    expect(m.name.value).toBe("Zenith Digital");
    expect(m.name.provenance[0]!.source).toBe("operator");
    expect(m.conflicts.find((c) => c.reason.includes("operator"))!.chosen).toBe("Zenith Digital");
    expect(m.issues.find((i) => i.code === "name_conflict")).toBeUndefined();
    expect(codes(m, "blocking")).not.toContain("name_unverified");
  });

  it("rejects generic labels and taglines with a reason", () => {
    const m = buildBrandManifest(base({ sourceUrl: null, scrape: { brandName: "Home" }, client: { name: "We help ambitious brands grow faster with video ads today" } }));
    expect(m.nameCandidates.find((n) => n.value === "Home")!.rejectedReason).toMatch(/generic/);
    expect(m.nameCandidates.find((n) => n.value.startsWith("We help"))!.rejectedReason).toMatch(/tagline|sentence/);
    expect(codes(m, "blocking")).toContain("name_missing");
  });

  it("name_missing is blocking when nothing is found", () => {
    const m = buildBrandManifest(base({ sourceUrl: null }));
    expect(m.name.value).toBeNull();
    expect(codes(m, "blocking")).toContain("name_missing");
  });

  it("a name that rests only on the domain or one title segment is unverified (blocking) until the operator confirms it", () => {
    const m = buildBrandManifest(base({ sourceUrl: "https://acme-ads.example/" }));
    expect(m.name.value).toBe("Acme Ads");
    expect(m.name.provenance[0]!.source).toBe("derived_domain");
    expect(codes(m, "blocking")).toContain("name_unverified");
    const titleOnly = buildBrandManifest(base({ sourceUrl: null, page: parseBrandPage("<title>Zenith Cafe | Coffee in Perth</title>", "https://z.example/") }));
    expect(codes(titleOnly, "blocking")).toContain("name_unverified");
    const confirmed = buildBrandManifest(base({ sourceUrl: "https://acme-ads.example/", operator: { brandName: "Acme Ads" } }));
    expect(codes(confirmed, "blocking")).not.toContain("name_unverified");
  });

  it("a medium-confidence source (the client record) is enough to verify the name", () => {
    const m = buildBrandManifest(base({ client: { name: "Zenith Cafe" } }));
    expect(m.name.value).toBe("Zenith Cafe");
    expect(codes(m, "blocking")).not.toContain("name_unverified");
  });
});

describe("buildBrandManifest: internal title leakage", () => {
  const LEAK = "TR Internal Marketing Version 1";

  it("never lets an internal page title, client name or project name become the name", () => {
    const page = parseBrandPage(`<html><head><title>${LEAK}</title></head><body></body></html>`, "https://acme.example/");
    const m = buildBrandManifest(
      base({
        sourceUrl: null,
        page,
        client: { name: LEAK },
        scrape: { title: LEAK, brandName: LEAK },
        internalLabels: [{ value: LEAK, where: "video project title" }, { value: "meta-audit-2026-09-02.pdf", where: "uploaded file name" }],
      }),
    );
    expect(m.name.value).toBeNull();
    expect(m.nameCandidates.every((n) => n.rejectedReason)).toBe(true);
    expect(m.internalLabels.map((l) => l.value)).toEqual(expect.arrayContaining([LEAK, "meta-audit-2026-09-02.pdf"]));
    expect(m.internalLabels.every((l) => l.provenance.source === "internal")).toBe(true);
    expect(codes(m, "blocking")).toContain("name_internal");
    expect(codes(m)).not.toContain("name_missing");
    expect(JSON.stringify(m.name)).not.toMatch(/Internal/);
  });

  it("falls back to a verified public source when one exists, and the label still stays internal", () => {
    const page = parseBrandPage(`<html><head><title>${LEAK}</title><meta property="og:site_name" content="Wheeler Foods"></head></html>`, "https://wheeler.example/");
    const m = buildBrandManifest(base({ page, client: { name: LEAK }, internalLabels: [{ value: LEAK, where: "project title" }] }));
    expect(m.name.value).toBe("Wheeler Foods");
    expect(m.internalLabels.map((l) => l.value)).toContain(LEAK);
    expect(codes(m, "blocking")).not.toContain("name_internal");
  });

  it("treats the project name as internal even when it is not obviously a working title, but not when it IS the confirmed company name", () => {
    const leaky = buildBrandManifest(base({ sourceUrl: null, client: { name: "Wheeler Q4 push" }, internalLabels: [{ value: "Wheeler Q4 push", where: "project title" }] }));
    expect(leaky.name.value).toBeNull();
    expect(codes(leaky, "blocking")).toContain("name_internal");
    const same = buildBrandManifest(base({ sourceUrl: null, client: { name: "Wheeler" }, operator: { brandName: "Wheeler" }, internalLabels: [{ value: "Wheeler", where: "project title" }] }));
    expect(same.name.value).toBe("Wheeler");
  });
});

// ------------------------------------------------------------------ logo

describe("buildBrandManifest: logo", () => {
  const namedBase = () => base({ operator: { brandName: "Acme" } });

  it("builds a LogoAsset with verification and provenance when a logo was chosen", () => {
    const m = buildBrandManifest({ ...namedBase(), logo: { chosen: chosen(), candidates: [candidate("https://acme.example/logo.png")], tried: [] } });
    expect(m.logo).toMatchObject({ storageKey: "video/p1/brand/logo-abc.png", mime: "image/png", sourceUrl: "https://acme.example/logo.png", origin: "page" });
    expect(m.logo!.verification.ok).toBe(true);
    expect(m.logo!.provenance[0]!.source).toBe("page_header");
    expect(m.logo!.provenance.some((p) => /role "company"/.test(p.detail))).toBe(true);
    expect(codes(m)).not.toContain("logo_missing");
  });

  it("NO logo found: logo_missing is blocking, manifest.logo is null, nothing is invented", () => {
    const m = buildBrandManifest({ ...namedBase(), logo: { chosen: null, candidates: [], tried: [] } });
    expect(m.logo).toBeNull();
    expect(m.logoCandidates).toEqual([]);
    const issue = m.issues.find((i) => i.code === "logo_missing")!;
    expect(issue.severity).toBe("blocking");
    expect(issue.field).toBe("logo");
    expect(manifestReady(m)).toBe(false);
  });

  it("only partner, badge and icon images found: still logo_missing and no logo", () => {
    const m = buildBrandManifest({
      ...namedBase(),
      logo: { chosen: null, candidates: [candidate("https://x/p.png", { role: "partner", rejectedReason: "partner" }), candidate("https://x/i.png", { role: "icon", rejectedReason: "icon" })], tried: [] },
    });
    expect(m.logo).toBeNull();
    expect(m.issues.find((i) => i.code === "logo_missing")!.message).toMatch(/partner, icon/);
  });

  it("text-only allowed with a verified name: one warning, not blocking, still no logo", () => {
    const m = buildBrandManifest({ ...base({ operator: { brandName: "Acme", allowTextOnly: true, cta: "Book now", offer: "Free audit", colors: ["#0057ff"] } }), logo: { chosen: null, candidates: [], tried: [] } });
    expect(m.allowTextOnlyBrand).toBe(true);
    expect(m.logo).toBeNull();
    const logoIssues = m.issues.filter((i) => i.field === "logo");
    expect(logoIssues).toHaveLength(1);
    expect(logoIssues[0]!.severity).toBe("warning");
    expect(logoIssues[0]!.message).toMatch(/text-only treatment with the verified name "Acme"/);
    expect(codes(m, "blocking")).toEqual([]);
    expect(manifestReady(m)).toBe(true);
  });

  it("text-only does NOT help when the name itself is not verified", () => {
    const m = buildBrandManifest({ ...base({ sourceUrl: "https://acme-ads.example/", operator: { allowTextOnly: true } }), logo: { chosen: null, candidates: [], tried: [] } });
    expect(m.issues.find((i) => i.code === "logo_missing")!.severity).toBe("blocking");
    expect(codes(m, "blocking")).toContain("name_unverified");
  });

  it("classifies a failed best candidate: low resolution, illegible, unverified", () => {
    const run = (problems: string[]) =>
      buildBrandManifest({ ...namedBase(), logo: { chosen: null, candidates: [candidate("https://x/a.png")], tried: [{ url: "https://x/a.png", role: "company", ok: false, problems }] } });
    const low = run(["Too small: 48 by 24 pixels (a logo needs at least 120 pixels wide and 64 tall)"]);
    expect(low.issues.find((i) => i.field === "logo")!.code).toBe("logo_low_resolution");
    const illegible = run(["Not legible on a light or on a dark background: its colours are too close to both"]);
    expect(illegible.issues.find((i) => i.field === "logo")!.code).toBe("logo_illegible");
    const broken = run(["Could not download: HTTP 404"]);
    expect(broken.issues.find((i) => i.field === "logo")!.code).toBe("logo_unverified");
    for (const m of [low, illegible, broken]) {
      expect(m.logo).toBeNull();
      expect(m.issues.find((i) => i.field === "logo")!.severity).toBe("blocking");
    }
    const textOnly = buildBrandManifest({ ...base({ operator: { brandName: "Acme", allowTextOnly: true } }), logo: { chosen: null, candidates: [candidate("https://x/a.png")], tried: [{ url: "x", role: "company", ok: false, problems: ["Too small: 1 by 1"] }] } });
    expect(textOnly.issues.find((i) => i.field === "logo")).toMatchObject({ code: "logo_low_resolution", severity: "warning" });
  });

  it("logo_conflict when two company candidates of equal score point at different images", () => {
    const a = candidate("https://acme.example/a.png", { score: 85 });
    const b = candidate("https://acme.example/b.png", { score: 85 });
    const m = buildBrandManifest({ ...namedBase(), logo: { chosen: chosen("https://acme.example/a.png", { score: 85 }), candidates: [a, b], tried: [] } });
    expect(m.issues.find((i) => i.code === "logo_conflict")!.severity).toBe("blocking");
    const fine = buildBrandManifest({ ...namedBase(), logo: { chosen: chosen("https://acme.example/a.png", { score: 85 }), candidates: [a, candidate("https://acme.example/b.png", { score: 80 })], tried: [] } });
    expect(codes(fine)).not.toContain("logo_conflict");
    const textOnly = buildBrandManifest({ ...base({ operator: { brandName: "Acme", allowTextOnly: true } }), logo: { chosen: chosen("https://acme.example/a.png", { score: 85 }), candidates: [a, b], tried: [] } });
    expect(textOnly.issues.find((i) => i.code === "logo_conflict")!.severity).toBe("warning");
    expect(textOnly.logo).toBeNull();
  });

  it("a low-trust 'unknown' image that verified is not accepted as the logo without confirmation", () => {
    const m = buildBrandManifest({ ...namedBase(), logo: { chosen: chosen("https://acme.example/x.png", { role: "unknown", score: 30 }), candidates: [], tried: [] } });
    expect(m.issues.find((i) => i.field === "logo")).toMatchObject({ code: "logo_unverified", severity: "blocking" });
  });

  it("an upload keeps the file name as its source", () => {
    const m = buildBrandManifest({ ...namedBase(), logo: { chosen: chosen("acme-logo.png", { provenance: { source: "upload", detail: "Logo file uploaded by the operator: acme-logo.png", confidence: "high" }, score: 1000 }, "upload"), candidates: [], tried: [] } });
    expect(m.logo!.origin).toBe("upload");
    expect(m.logo!.sourceUrl).toBe("acme-logo.png");
    expect(m.logo!.provenance[0]!.source).toBe("upload");
  });
});

// ------------------------------------------------------------------ the rest of the manifest

describe("buildBrandManifest: colours, offer, cta, provenance", () => {
  it("prefers operator over scrape over client, normalises hex, and records provenance", () => {
    const op = buildBrandManifest(base({ operator: { brandName: "A", colors: ["0057ff", "#FFF"] }, scrape: { colors: ["#111111"] }, client: { colors: ["#222222"] } }));
    expect(op.colors.value).toEqual(["#0057FF", "#FFF"]);
    expect(op.colors.provenance[0]!.source).toBe("operator");
    const sc = buildBrandManifest(base({ scrape: { colors: ["#111111", "not a colour"] }, client: { colors: ["#222222"] } }));
    expect(sc.colors.value).toEqual(["#111111"]);
    expect(sc.colors.provenance[0]!.source).toBe("scrape");
    const cl = buildBrandManifest(base({ client: { colors: ["#222222"] } }));
    expect(cl.colors.provenance[0]!.source).toBe("client_record");
    const none = buildBrandManifest(base());
    expect(none.colors.value).toEqual([]);
    expect(none.issues.find((i) => i.code === "colors_missing")!.severity).toBe("warning");
  });

  it("offer and cta follow their precedence and missing ones are warnings", () => {
    const m = buildBrandManifest(base({ operator: { offer: "Free audit", cta: "Book a free audit", ctaUrl: "https://acme.example/book" }, offer: { name: "Saved offer" }, client: { valueProposition: "We grow brands" }, adCtaLabel: "Learn more" }));
    expect(m.offer.value).toBe("Free audit");
    expect(m.cta.value).toEqual({ label: "Book a free audit", url: "https://acme.example/book" });
    const m2 = buildBrandManifest(base({ offer: { name: "Spring audit", description: "Full account review" }, adCtaLabel: "Learn more" }));
    expect(m2.offer.value).toBe("Spring audit: Full account review");
    expect(m2.offer.provenance[0]!.source).toBe("client_record");
    expect(m2.cta.value).toEqual({ label: "Learn more" });
    const m3 = buildBrandManifest(base({ client: { valueProposition: "We grow brands" } }));
    expect(m3.offer.value).toBe("We grow brands");
    const none = buildBrandManifest(base());
    expect(none.offer.value).toBeNull();
    expect(none.cta.value).toBeNull();
    expect(none.issues.filter((i) => ["offer_missing", "cta_missing"].includes(i.code)).every((i) => i.severity === "warning")).toBe(true);
  });

  it("an internal saved offer name is not used as the offer", () => {
    const m = buildBrandManifest(base({ offer: { name: "Offer v2 - final" }, client: { valueProposition: "Real proposition" } }));
    expect(m.offer.value).toBe("Real proposition");
    expect(m.internalLabels.map((l) => l.value)).toContain("Offer v2 - final");
  });

  it("every field carries provenance with a readable detail, even when empty", () => {
    for (const m of [buildBrandManifest(base()), buildBrandManifest(base({ operator: { brandName: "Acme", cta: "Go", offer: "x", colors: ["#fff"] }, client: { audience: "Founders" } }))]) {
      for (const field of [m.sourceUrl, m.name, m.colors, m.offer, m.cta, m.audience]) {
        expect(field.provenance.length).toBeGreaterThanOrEqual(1);
        for (const p of field.provenance) expect(p.detail.length).toBeGreaterThan(8);
      }
    }
  });

  it("is deterministic and pure", () => {
    const input = base({ page: parseBrandPage(`<title>Acme | Ads</title><script type="application/ld+json">{"@type":"Organization","name":"Acme"}</script>`, "https://acme.example/"), operator: { brandName: "Acme" } });
    const snapshot = JSON.stringify(input);
    const a = buildBrandManifest(input);
    const b = buildBrandManifest(input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(a.createdAt).toBe("2026-11-09T00:00:00.000Z");
    expect(a.version).toBe(1);
    expect([a.clientId, a.projectId]).toEqual(["c1", "p1"]);
  });
});

// ------------------------------------------------------------------ the orchestrator

function memoryStorage(): ObjectStorage & { keys: () => string[] } {
  const files = new Map<string, Buffer>();
  return {
    name: "memory",
    put: async (key, data, contentType = "application/octet-stream") => {
      const buf = Buffer.from(data as Buffer);
      files.set(key, buf);
      return { key, contentType, size: buf.length, url: `/mem/${key}` };
    },
    get: async (key) => files.get(key) ?? null,
    delete: async (key) => void files.delete(key),
    getPublicUrl: (key) => `/mem/${key}`,
    keys: () => [...files.keys()],
  };
}

async function logoPng(): Promise<Buffer> {
  const mark = await sharp({ create: { width: 160, height: 50, channels: 4, background: { r: 0, g: 140, b: 170, alpha: 1 } } }).png().toBuffer();
  return sharp({ create: { width: 300, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: mark, left: 70, top: 25 }]).png().toBuffer();
}

const PAGE_HTML = `<html><head><title>Acme | Video ads</title>
  <meta property="og:site_name" content="Acme"><meta property="og:image" content="/share.jpg"></head>
  <body><header><a href="/"><img src="/img/acme-logo.png" alt="Acme"></a></header>
  <section class="clients"><h2>Trusted by</h2><img src="/clients/big-logo.png" alt="Big"></section>
  <footer>© 2026 Acme Pty Ltd. All rights reserved.</footer></body></html>`;

describe("resolveBrandManifest", () => {
  let logo: Buffer;
  beforeAll(async () => {
    logo = await logoPng();
  });

  const input = (over: Partial<BrandResolveInput> = {}): BrandResolveInput => ({
    clientId: "c1",
    projectId: "proj-A",
    sourceUrl: "https://acme.example/",
    scrape: null,
    client: {},
    internalLabels: [],
    offer: {},
    operator: {},
    stats: ["255% ROAS"],
    assets: [],
    ...over,
  });

  const deps = (storage: ObjectStorage, extra: { assets?: Record<string, FetchedAsset>; html?: string; fail?: boolean } = {}) => ({
    storage,
    now: () => "2026-11-09T01:00:00.000Z",
    fetchPage: async (url: string) => {
      if (extra.fail) throw new Error("connect ECONNREFUSED");
      return { html: extra.html ?? PAGE_HTML, css: "", limitations: [`example limit for ${url}`] };
    },
    fetchAsset: async (url: string) => {
      const a = (extra.assets ?? { "https://acme.example/img/acme-logo.png": { bytes: logo, mime: "image/png" } })[url];
      if (!a) throw new Error("HTTP 404");
      return a;
    },
  });

  it("finds the name and the header logo, saves the original bytes under the project's own prefix, and builds claims", async () => {
    const storage = memoryStorage();
    const m = await resolveBrandManifest(input(), deps(storage));
    expect(m.name.value).toBe("Acme");
    expect(m.logo).not.toBeNull();
    expect(m.logo!.storageKey).toMatch(/^video\/proj-A\/brand\/logo-[0-9a-f]{12}\.png$/);
    expect(m.logo!.origin).toBe("page");
    expect(m.logo!.sourceUrl).toBe("https://acme.example/img/acme-logo.png");
    expect(storage.keys()).toEqual([m.logo!.storageKey]);
    expect((await storage.get(m.logo!.storageKey))!.equals(logo)).toBe(true);
    expect(m.claims.map((c) => c.figure)).toContain("255%");
    expect(m.createdAt).toBe("2026-11-09T01:00:00.000Z");
    expect(m.sourceUrl.provenance.some((p) => /example limit/.test(p.detail))).toBe(true);
    // client strip and share image never became the logo
    expect(m.logoCandidates.find((c) => c.url.includes("big-logo"))!.role).toBe("client");
    expect(m.logoCandidates.find((c) => c.url.includes("share.jpg"))!.role).toBe("unknown");
    expect(manifestSummary(m)).toMatchObject({ name: "Acme", logo: true });
  });

  it("isolates projects: two projects with the same logo get separate keys, and a manifest cannot read another project's file", async () => {
    const storage = memoryStorage();
    const a = await resolveBrandManifest(input({ projectId: "proj-A" }), deps(storage));
    const b = await resolveBrandManifest(input({ projectId: "proj-B" }), deps(storage));
    expect(a.logo!.storageKey).toContain("proj-A");
    expect(b.logo!.storageKey).toContain("proj-B");
    expect(a.logo!.storageKey).not.toBe(b.logo!.storageKey);
    expect(storage.keys().sort()).toEqual([a.logo!.storageKey, b.logo!.storageKey].sort());
    expect(await loadManifestLogo(a, storage)).not.toBeNull();
    // A tampered manifest pointing at B's file is refused.
    const tampered = { ...a, logo: { ...a.logo!, storageKey: b.logo!.storageKey } };
    expect(await loadManifestLogo(tampered, storage)).toBeNull();
    expect(await loadManifestLogo({ ...a, logo: null }, storage)).toBeNull();
    expect(brandStorageKey("proj-A", logo, "png")).toBe(a.logo!.storageKey);
    expect(brandStorageKey("../etc/x", logo, "png")).not.toContain("..");
  });

  it("never throws when the page cannot be fetched: it records it and uses the other sources", async () => {
    const storage = memoryStorage();
    const m = await resolveBrandManifest(input({ client: { name: "Zenith Cafe" } }), deps(storage, { fail: true }));
    expect(m.name.value).toBe("Zenith Cafe");
    expect(m.logo).toBeNull();
    expect(m.sourceUrl.provenance.some((p) => /could not be read \(connect ECONNREFUSED\)/.test(p.detail))).toBe(true);
    expect(codes(m, "blocking")).toContain("logo_missing");
    expect(storage.keys()).toEqual([]);
  });

  it("never throws when the logo cannot be downloaded: logo_unverified, nothing saved", async () => {
    const storage = memoryStorage();
    const m = await resolveBrandManifest(input(), deps(storage, { assets: {} }));
    expect(m.logo).toBeNull();
    const issue = m.issues.find((i) => i.field === "logo")!;
    expect(issue.code).toBe("logo_unverified");
    expect(issue.severity).toBe("blocking");
    expect(storage.keys()).toEqual([]);
  });

  it("no logo anywhere + text-only allowed: warning only, and no mark is invented", async () => {
    const storage = memoryStorage();
    const m = await resolveBrandManifest(
      input({ operator: { allowTextOnly: true, brandName: "Acme" } }),
      deps(storage, { html: "<html><head><title>Acme</title></head><body><h1>Hi</h1></body></html>" }),
    );
    expect(m.logo).toBeNull();
    expect(m.issues.filter((i) => i.field === "logo")).toHaveLength(1);
    expect(m.issues.find((i) => i.field === "logo")!.severity).toBe("warning");
    expect(storage.keys()).toEqual([]);
  });

  it("an operator-uploaded logo wins when it verifies, and is saved as uploaded", async () => {
    const storage = memoryStorage();
    const m = await resolveBrandManifest(input({ operator: { logoUpload: { bytes: logo, name: "acme-brand.png" } } }), deps(storage));
    expect(m.logo!.origin).toBe("upload");
    expect(m.logo!.sourceUrl).toBe("acme-brand.png");
    expect(m.logo!.provenance[0]!.source).toBe("upload");
    expect(m.logoCandidates[0]!.url).toBe("acme-brand.png");
  });

  it("an unusable upload falls through to the page logo and the failure is recorded", async () => {
    const storage = memoryStorage();
    const tiny = await sharp({ create: { width: 30, height: 20, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
    const m = await resolveBrandManifest(input({ operator: { logoUpload: { bytes: tiny, name: "tiny.png" } } }), deps(storage));
    expect(m.logo!.origin).toBe("page");
    expect(m.logo!.sourceUrl).toBe("https://acme.example/img/acme-logo.png");
  });

  it("uses the client's saved logo (inline data uri) when the page has none", async () => {
    const storage = memoryStorage();
    const m = await resolveBrandManifest(
      input({ clientLogoDataUri: `data:image/png;base64,${logo.toString("base64")}`, client: { name: "Zenith Cafe" } }),
      deps(storage, { html: "<html><body><p>No logo here</p></body></html>" }),
    );
    expect(m.logo!.origin).toBe("client");
    expect(m.logo!.provenance[0]!.source).toBe("client_record");
    expect((await storage.get(m.logo!.storageKey))!.equals(logo)).toBe(true);
  });

  it("does not use a scrape logo that is really the page's share image, but does use a plain scrape logo as low trust", async () => {
    const storage = memoryStorage();
    const html = "<html><head><title>Acme</title><meta property=\"og:image\" content=\"/share.jpg\"></head><body></body></html>";
    const share = await resolveBrandManifest(
      input({ operator: { brandName: "Acme" }, scrape: { url: "https://acme.example/", colors: [], logo_url: "https://acme.example/share.jpg", logo_description: null, imagery_notes: null, summary: "", source: "scrape_only" } }),
      deps(storage, { html, assets: { "https://acme.example/share.jpg": { bytes: logo, mime: "image/jpeg" } } }),
    );
    expect(share.logo).toBeNull();
    const plain = await resolveBrandManifest(
      input({ operator: { brandName: "Acme" }, scrape: { url: "https://acme.example/", colors: ["#123456"], logo_url: "https://cdn.example/brand.png", logo_description: null, imagery_notes: null, summary: "", source: "firecrawl_branding", page_excerpt: "Trusted with $12M in ad spend." } }),
      deps(storage, { html, assets: { "https://cdn.example/brand.png": { bytes: logo, mime: "image/png" } } }),
    );
    expect(plain.logo!.provenance[0]!.source).toBe("scrape");
    expect(plain.logo!.provenance[0]!.confidence).toBe("low");
    expect(plain.colors.value).toEqual(["#123456"]);
    expect(plain.claims.some((c) => c.provenance.source === "page_text" && c.figure === "$12M")).toBe(true);
  });

  it("works with no source url at all", async () => {
    const m = await resolveBrandManifest(input({ sourceUrl: null, client: { name: "Zenith Cafe" } }), deps(memoryStorage()));
    expect(m.name.value).toBe("Zenith Cafe");
    expect(m.sourceUrl.value).toBeNull();
    expect(m.logo).toBeNull();
  });
});
