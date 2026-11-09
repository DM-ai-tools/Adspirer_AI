/**
 * Builds the verified brand manifest: the one place that decides what the company is called in public,
 * which file is its logo, which colours / offer / call to action are its own, and which issues must be
 * fixed before any script or scene is generated.
 *
 * Pure and deterministic: no network, no clock (pass `now`), no storage. The inputs are everything that
 * was gathered (page evidence, scrape, client record, operator choices, the verified logo).
 */
import type { PageEvidence } from "@/lib/video/brand-page";
import type { ResolvedLogo } from "@/lib/video/logo-verify";
import type {
  ApprovedClaim,
  BrandIssue,
  BrandManifest,
  Confidence,
  LogoAsset,
  LogoCandidate,
  LogoRole,
  Provenance,
  Sourced,
} from "@/lib/video/pipeline-types";

// ------------------------------------------------------------------ internal labels

const FILE_EXT = /\.(?:mp4|mov|m4v|avi|webm|mkv|pdf|png|jpe?g|gif|webp|svg|docx?|xlsx?|pptx?|csv|txt|zip|html?|json|mp3|wav|psd|ai|fig|key|numbers|pages)\b/i;
const STRONG_INTERNAL = /\b(?:internal|draft|untitled|wip|copy of|placeholder|lorem ipsum|staging|dummy|do not use)\b/i;
const VERSION = /\b(?:v|ver|version|rev|revision)\s*\.?\s*\d+(?:\.\d+)*\b/i;
const WORKING_WORDS = ["draft", "final", "test", "testing", "copy", "campaign", "project", "template", "audit", "report", "mockup", "proposal", "brief", "export", "upload", "asset", "assets", "landing", "wip", "internal", "version"];
const URL_LIKE = /^(?:https?:\/\/|www\.)|^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:\/\S*)?$/i;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|^[0-9a-f]{16,}$|^[a-z]+_[0-9a-f]{8,}$/i;
const CAMERA_NAMES = /^(?:img|dsc|screenshot|screen shot|image|photo|video|untitled|document|file)[\s_-]?\d+/i;

function alnum(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * True for a working title rather than a public company name: a draft or version label, a file name,
 * an id or slug, a bare web address, or one of the `known` internal strings (project titles, service
 * names, file names). A real name that merely contains a word like "Project" or "Campaign" is NOT flagged
 * unless it is combined with other working-title signals (a version, a second working word, a number).
 */
export function isInternalLabel(text: string, ctx?: { known?: string[] }): { internal: boolean; reason: string | null } {
  const raw = (text ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return { internal: true, reason: "It is empty" };
  const key = alnum(raw);

  for (const k of ctx?.known ?? []) {
    const kk = alnum(k ?? "");
    if (kk.length < 3) continue;
    if (key === kk || key.includes(kk)) return { internal: true, reason: `It matches an internal label ("${k.trim().slice(0, 60)}")` };
  }

  if (FILE_EXT.test(raw)) return { internal: true, reason: "It looks like a file name" };
  if (UUID.test(raw)) return { internal: true, reason: "It looks like an id, not a name" };
  if (CAMERA_NAMES.test(raw)) return { internal: true, reason: "It looks like a default file or document name" };
  if (/\b\d{4}[-_]\d{2}[-_]\d{2}\b/.test(raw)) return { internal: true, reason: "It contains a date stamp, like a file or export name" };
  if (!/\s/.test(raw) && (raw.match(/[-_]/g) ?? []).length >= 2 && /[a-z]/i.test(raw)) return { internal: true, reason: "It looks like a slug or file name (words joined by dashes or underscores)" };
  if (URL_LIKE.test(raw)) return { internal: true, reason: "It is a web address, not a company name" };

  const strong = STRONG_INTERNAL.exec(raw);
  if (strong) return { internal: true, reason: `It contains "${strong[0]}", which marks a working title` };
  const version = VERSION.exec(raw);
  if (version) return { internal: true, reason: `It contains a version label ("${version[0]}")` };

  const words = raw.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const working = new Set(words.filter((w) => WORKING_WORDS.includes(w)));
  if (working.size >= 2) return { internal: true, reason: `It combines working-title words (${[...working].join(", ")})` };
  if (working.size === 1 && words.some((w) => /^\d+$/.test(w))) return { internal: true, reason: `It looks like a numbered working title ("${raw.slice(0, 40)}")` };
  if (/\(\s*(?:\d+|copy)\s*\)\s*$|[-–]\s*copy\s*$/i.test(raw)) return { internal: true, reason: "It ends like a duplicated file name" };
  return { internal: false, reason: null };
}

// ------------------------------------------------------------------ names

const LEGAL_SUFFIX =
  /(?:[\s,]+(?:pty\.?\s*ltd\.?|pte\.?\s*ltd\.?|pvt\.?\s*ltd\.?|sdn\.?\s*bhd\.?|pty|ltd\.?|limited|incorporated|inc\.?|l\.?l\.?c\.?|l\.?l\.?p\.?|plc|corp\.?|corporation|gmbh|s\.?a\.?|s\.?r\.?l\.?|b\.?v\.?|n\.?v\.?|ag|oy|ab|kk))+\s*\.?$/i;
const TRAILING_CO = /(?<!&)\s+(?:co\.?|company)$/i;

/** "Acme Pty Ltd" -> "Acme". Returns the input when stripping would leave nothing. */
export function stripLegalSuffix(name: string): string {
  let s = name.replace(/\s+/g, " ").trim();
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s.replace(LEGAL_SUFFIX, "").replace(TRAILING_CO, "").replace(/[\s,&.\-–]+$/, "").trim();
    if (s === before) break;
  }
  return s.length >= 2 ? s : name.trim();
}

const GENERIC_NAME = /^(?:home|homepage|home page|welcome|welcome to (?:our )?(?:website|site)|untitled|menu|main menu|logo|index|main|site|my site|my website|website|default|just another wordpress site|coming soon|under construction|loading|page not found|404|error|sign in|log in|login|shop|blog|contact|contact us|about|about us|services?|products?)$/i;

function genericReason(value: string): string | null {
  const v = value.trim();
  if (GENERIC_NAME.test(v)) return `"${v}" is a generic page label, not a company name`;
  if (v.length < 2) return "It is too short to be a name";
  const words = v.split(/\s+/).filter(Boolean);
  if (words.length > 6) return "It is a sentence or tagline (more than six words), not a name";
  if (/[.!?]$/.test(v) && words.length > 3) return "It reads like a sentence, not a name";
  if (/^welcome\b/i.test(v)) return "It is a greeting, not a name";
  return null;
}

type NameKind = "operator" | "jsonld" | "header" | "footer" | "meta" | "scrape" | "client" | "title" | "domain";
const TRUST: Record<NameKind, number> = { operator: 100, jsonld: 90, header: 80, footer: 70, meta: 60, scrape: 50, client: 40, title: 30, domain: 10 };
const KIND_LABEL: Record<NameKind, string> = { operator: "the operator", jsonld: "JSON-LD", header: "the page header", footer: "the page footer", meta: "page meta tags", scrape: "the brand scrape", client: "the client record", title: "the page title", domain: "the domain name" };

type NameCand = {
  raw: string;
  display: string;
  key: string;
  kind: NameKind;
  trust: number;
  provenance: Provenance;
  rejectedReason?: string;
  internalLabel?: boolean;
};

const TITLE_SPLIT = /\s*[|–—·•»]\s*|\s+-\s+|:\s+/;

function titleSegmentsOf(title: string | null | undefined): string[] {
  if (!title) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of title.split(TITLE_SPLIT).map((x) => x.trim()).filter(Boolean)) {
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function domainName(url: string | null | undefined): string | null {
  const host = hostOf(url);
  if (!host) return null;
  const parts = host.split(".");
  // acme.com -> acme; acme.com.au -> acme; shop.acme.com -> acme
  let idx = parts.length - 2;
  if (parts.length >= 3 && /^(?:co|com|org|net|gov|edu|ac)$/.test(parts[parts.length - 2]!)) idx = parts.length - 3;
  const label = parts[Math.max(0, idx)] ?? "";
  if (label.length < 3) return null;
  return label
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

function prov(source: Provenance["source"], detail: string, confidence: Confidence, url?: string): Provenance {
  return { source, detail, confidence, ...(url ? { url } : {}) };
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

function distinctProvenance(list: Provenance[]): Provenance[] {
  const seen = new Set<string>();
  const out: Provenance[] = [];
  for (const p of list) {
    const k = `${p.source}|${p.detail}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

// ------------------------------------------------------------------ input

export type ManifestInput = {
  clientId: string;
  projectId: string | null;
  now?: string;
  sourceUrl: string | null;
  page: PageEvidence | null;
  scrape: { title?: string | null; brandName?: string | null; colors?: string[]; summary?: string | null; logoUrl?: string | null } | null;
  client: { name?: string | null; websiteUrl?: string | null; colors?: string[] | null; valueProposition?: string | null; audience?: string | null };
  internalLabels: Array<{ value: string; where: string }>;
  offer: { name?: string | null; description?: string | null };
  operator: { brandName?: string | null; offer?: string | null; cta?: string | null; ctaUrl?: string | null; allowTextOnly?: boolean; colors?: string[] | null };
  logo: {
    chosen: (ResolvedLogo & { storageKey: string; origin: "page" | "upload" | "client" }) | null;
    candidates: LogoCandidate[];
    tried: Array<{ url: string; role: LogoRole; ok: boolean; problems: string[] }>;
  };
  claims: ApprovedClaim[];
  adCtaLabel?: string | null;
};

// ------------------------------------------------------------------ the builder

type Group = { key: string; cands: NameCand[]; kinds: Set<NameKind>; maxTrust: number; order: number };

const clean = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();

const HEX = /^#?(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function normaliseColours(list: string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const raw of list ?? []) {
    const c = clean(raw);
    if (!c) continue;
    const colour = HEX.test(c) ? `#${c.replace(/^#/, "").toUpperCase()}` : /^(?:rgb|hsl)a?\(/i.test(c) ? c : null;
    if (colour && !out.includes(colour)) out.push(colour);
  }
  return out.slice(0, 8);
}

export function buildBrandManifest(input: ManifestInput): BrandManifest {
  const createdAt = input.now ?? new Date(0).toISOString();
  const page = input.page;
  const pageUrl = page?.pageUrl ?? input.sourceUrl ?? undefined;
  const issues: BrandIssue[] = [];

  // ---------------------------------------------------------- internal labels
  const internalLabels: BrandManifest["internalLabels"] = [];
  const addInternal = (value: string, provenance: Provenance) => {
    const v = clean(value);
    if (!v) return;
    if (internalLabels.some((l) => l.value.toLowerCase() === v.toLowerCase())) return;
    internalLabels.push({ value: v, provenance });
  };
  for (const l of input.internalLabels) addInternal(l.value, prov("internal", l.where, "high"));

  // ---------------------------------------------------------- name candidates
  const operatorName = clean(input.operator.brandName);
  const trustedKeys = new Set<string>();
  if (operatorName) trustedKeys.add(alnum(stripLegalSuffix(operatorName)));
  for (const n of page?.jsonLd.names ?? []) trustedKeys.add(alnum(stripLegalSuffix(n.value)));
  // A project title that equals the company's own name (confirmed by the operator or by JSON-LD) is not an internal label.
  const known = input.internalLabels.map((l) => l.value).filter((v) => !trustedKeys.has(alnum(stripLegalSuffix(v))));

  const cands: NameCand[] = [];
  const add = (raw: string | null | undefined, kind: NameKind, provenance: Provenance, opts: { checkInternal?: boolean } = {}) => {
    const value = clean(raw);
    if (!value) return;
    const display = kind === "operator" ? value : stripLegalSuffix(value);
    const cand: NameCand = { raw: value, display, key: alnum(display), kind, trust: TRUST[kind], provenance: display !== value ? { ...provenance, detail: `${provenance.detail} (as written: "${value}"; legal suffix dropped for the public name)` } : provenance };
    if (opts.checkInternal !== false) {
      const internal = isInternalLabel(value, { known });
      if (internal.internal) {
        cand.rejectedReason = `Internal label: ${internal.reason}`;
        cand.internalLabel = true;
      } else {
        const generic = genericReason(display);
        if (generic) cand.rejectedReason = generic;
      }
    }
    if (!cand.key) return;
    cands.push(cand);
  };

  if (operatorName) add(operatorName, "operator", prov("operator", "Company name entered by the operator for this video", "high"), { checkInternal: false });

  if (page) {
    for (const n of page.jsonLd.names) {
      if (/\.alternateName$/.test(n.type)) continue;
      const isLegal = /\.legalName$/.test(n.type);
      add(n.value, "jsonld", prov("page_jsonld", `JSON-LD ${n.type.replace(/\.legalName$/, "")}.${isLegal ? "legalName" : "name"}`, "high", page.pageUrl));
    }
    for (const h of page.headerBrandTexts) {
      const high = /alt|aria-label|svg title/.test(h.where);
      add(h.text, "header", prov("page_header", `Page ${h.where}`, high ? "high" : "medium", page.pageUrl));
    }
    for (const f of page.footerCopyright) {
      if (f.entity) add(f.entity, "footer", prov("page_footer", `Footer copyright line: "${f.text.slice(0, 80)}"`, "medium", page.pageUrl));
    }
    if (page.ogSiteName) add(page.ogSiteName, "meta", prov("page_meta", "<meta property=\"og:site_name\">", "medium", page.pageUrl));
    if (page.applicationName) add(page.applicationName, "meta", prov("page_meta", "<meta name=\"application-name\"> / apple-mobile-web-app-title", "medium", page.pageUrl));
  }
  if (input.scrape?.brandName) add(input.scrape.brandName, "scrape", prov("scrape", "Brand name from the site scrape", "medium", pageUrl));
  if (input.client.name) add(input.client.name, "client", prov("client_record", "The client's name saved in the app", "medium"));

  const titleStrings = [clean(page?.title), clean(input.scrape?.title)].filter(Boolean);
  const segments = dedupeStrings([...(page?.titleSegments ?? []), ...titleStrings.flatMap(titleSegmentsOf)]);
  for (const t of titleStrings) {
    // A whole page title that is an internal label is recorded as one.
    const internal = isInternalLabel(t, { known });
    if (internal.internal && titleSegmentsOf(t).length <= 1) addInternal(t, prov("internal", "Page title", "high", pageUrl));
  }
  for (const s of segments) add(s, "title", prov("page_meta", `Segment of the page title "${(titleStrings[0] ?? s).slice(0, 80)}"`, "low", pageUrl));

  const domain = domainName(input.sourceUrl) ?? domainName(input.client.websiteUrl);
  if (domain) add(domain, "domain", prov("derived_domain", `Derived from the domain name ${hostOf(input.sourceUrl) ?? hostOf(input.client.websiteUrl)}`, "low", pageUrl));

  // Internal candidates are kept apart.
  for (const c of cands) {
    if (c.internalLabel) addInternal(c.raw, prov("internal", `${c.provenance.detail} (not customer-facing)`, "high", c.provenance.url));
  }

  const nameCandidates: BrandManifest["nameCandidates"] = cands.map((c) => ({
    value: c.display,
    provenance: c.provenance,
    ...(c.rejectedReason ? { rejectedReason: c.rejectedReason } : {}),
  }));
  // The legal forms are recorded too (never used as the public name).
  for (const c of cands) {
    if (!c.rejectedReason && c.display !== c.raw && c.kind !== "operator") {
      nameCandidates.push({ value: c.raw, provenance: c.provenance, rejectedReason: "Legal form of the name, recorded for reference; the public name omits the suffix" });
    }
  }

  // ---------------------------------------------------------- choose the name
  const alive = cands.filter((c) => !c.rejectedReason);
  const groups = new Map<string, Group>();
  alive.forEach((c, i) => {
    const g = groups.get(c.key);
    if (g) {
      g.cands.push(c);
      g.kinds.add(c.kind);
      g.maxTrust = Math.max(g.maxTrust, c.trust);
    } else groups.set(c.key, { key: c.key, cands: [c], kinds: new Set([c.kind]), maxTrust: c.trust, order: i });
  });
  const serious = (g: Group) => g.cands.some((c) => c.provenance.confidence !== "low");
  const agreement = (g: Group) => new Set(g.cands.filter((c) => c.provenance.confidence !== "low").map((c) => c.kind)).size;
  const rank = (a: Group, b: Group): number => {
    const ao = a.kinds.has("operator") ? 1 : 0;
    const bo = b.kinds.has("operator") ? 1 : 0;
    if (ao !== bo) return bo - ao;
    const sa = serious(a) ? 1 : 0;
    const sb = serious(b) ? 1 : 0;
    if (sa !== sb) return sb - sa;
    if (agreement(a) !== agreement(b)) return agreement(b) - agreement(a);
    if (a.maxTrust !== b.maxTrust) return b.maxTrust - a.maxTrust;
    return a.order - b.order;
  };
  const ranked = [...groups.values()].sort(rank);
  const best = ranked[0] ?? null;

  const conflicts: BrandManifest["conflicts"] = [];
  let chosenName: string | null = null;
  let nameProvenance: Provenance[] = [];
  let nameUnresolved = false;

  const pickDisplay = (g: Group): string => {
    const byTrust = [...g.cands].sort((a, b) => b.trust - a.trust);
    const top = byTrust[0]!;
    if (top.kind === "operator") return top.display;
    const shouting = (s: string) => s.length > 4 && s === s.toUpperCase() && /[A-Z]/.test(s);
    if (shouting(top.display)) {
      const alt = byTrust.find((c) => !shouting(c.display) && c.display.toLowerCase() === top.display.toLowerCase());
      if (alt) return alt.display;
    }
    return top.display;
  };

  if (best) {
    chosenName = pickDisplay(best);
    nameProvenance = distinctProvenance([...best.cands].sort((a, b) => b.trust - a.trust).map((c) => c.provenance));

    // Material disagreement between other credible groups and the best one.
    const contains = (a: string, b: string) => (a.length >= 4 && b.includes(a)) || (b.length >= 4 && a.includes(b));
    const rivals = ranked.slice(1).filter((g) => serious(g) && !contains(g.key, best.key));
    if (serious(best) && rivals.length > 0) {
      const top = rivals[0]!;
      let reason: string;
      let resolved = true;
      if (best.kinds.has("operator")) reason = "The name the operator entered wins";
      else if (agreement(best) !== agreement(top)) reason = `Agreed by ${agreement(best)} source(s) against ${agreement(top)}`;
      else if (best.maxTrust !== top.maxTrust) reason = `Taken from the higher-trust source (${KIND_LABEL[[...best.cands].sort((a, b) => b.trust - a.trust)[0]!.kind]} over ${KIND_LABEL[[...top.cands].sort((a, b) => b.trust - a.trust)[0]!.kind]})`;
      else {
        reason = "Two sources of equal standing disagree and nothing decides between them";
        resolved = false;
      }
      conflicts.push({
        field: "name",
        values: [best, ...rivals].map((g) => ({ value: pickDisplay(g), provenance: [...g.cands].sort((a, b) => b.trust - a.trust)[0]!.provenance })),
        chosen: resolved ? chosenName : null,
        reason,
      });
      if (!resolved) {
        nameUnresolved = true;
        issues.push({
          code: "name_conflict",
          severity: "blocking",
          field: "name",
          message: `The sources disagree about the company name: ${[best, ...rivals].map((g) => `"${pickDisplay(g)}"`).join(" and ")}.`,
          resolution: "Enter the company's public name for this video so there is one source of truth.",
        });
      } else if (!best.kinds.has("operator")) {
        issues.push({
          code: "name_conflict",
          severity: "warning",
          field: "name",
          message: `Other sources give a different name ("${pickDisplay(top)}"); "${chosenName}" was used. ${reason}.`,
          resolution: "Check the name is right, or enter the correct public name.",
        });
      }
    }

    // The same company written with and without its legal suffix, or in another case: recorded, not an issue.
    const rawForms = dedupeStrings(best.cands.map((c) => c.raw));
    if (rawForms.length > 1) {
      conflicts.push({
        field: "name",
        values: rawForms.map((f) => ({ value: f, provenance: best.cands.find((c) => c.raw === f)!.provenance })),
        chosen: chosenName,
        reason: "The same company is written in different forms; the public name omits any legal suffix (Pty Ltd, Inc, LLC, ...)",
      });
    }
  }

  const nameVerified = Boolean(best) && !nameUnresolved && (best!.kinds.has("operator") || serious(best!));
  if (!best) {
    const onlyInternal = cands.some((c) => c.internalLabel) || internalLabels.length > 0;
    issues.push(
      onlyInternal
        ? {
            code: "name_internal",
            severity: "blocking",
            field: "name",
            message: `The only names found are internal labels (${internalLabels.slice(0, 3).map((l) => `"${l.value}"`).join(", ")}), which must never appear in a video.`,
            resolution: "Enter the company's public name for this video.",
          }
        : { code: "name_missing", severity: "blocking", field: "name", message: "No company name could be found on the page, in the scrape or in the client record.", resolution: "Enter the company's public name for this video." },
    );
  } else if (!nameVerified && !nameUnresolved) {
    issues.push({
      code: "name_unverified",
      severity: "blocking",
      field: "name",
      message: `The only candidate for the company name is "${chosenName}", taken from ${best.cands.map((c) => KIND_LABEL[c.kind]).join(" and ")}, which is not reliable on its own.`,
      resolution: `Confirm "${chosenName}" or type the correct public name.`,
    });
  }

  const name: Sourced<string | null> = nameUnresolved
    ? { value: null, provenance: [prov("scrape", "The sources disagree and none was chosen", "low")] }
    : best
      ? { value: chosenName, provenance: nameProvenance }
      : { value: null, provenance: [prov("scrape", "No public company name was found in the page, scrape or client record", "low")] };

  // ---------------------------------------------------------- logo
  const allowTextOnly = Boolean(input.operator.allowTextOnly);
  const nameOkForTextOnly = name.value !== null && nameVerified && !issues.some((i) => i.field === "name" && i.severity === "blocking");
  const textOnlyApplies = allowTextOnly && nameOkForTextOnly;
  let logo: LogoAsset | null = null;
  const logoIssues: BrandIssue[] = [];

  const chosen = input.logo.chosen;
  const candidates = input.logo.candidates;
  const tried = input.logo.tried;
  if (chosen) {
    const c = chosen.candidate;
    const v = chosen.verification;
    const verificationNote = prov(
      chosen.origin === "upload" ? "upload" : chosen.origin === "client" ? "client_record" : c.provenance.source,
      `Verified from its pixels: ${v.format.toUpperCase()} ${v.width} by ${v.height}${v.format === "svg" ? " (vector)" : ""}, role "${c.role}", ${v.hasAlpha ? `${Math.round(v.transparentShare * 100)}% transparent` : "no transparency"}, legible on ${v.legibleOnLight && v.legibleOnDark ? "light and dark" : v.legibleOnLight ? "light only" : "dark only"}`,
      "high",
      c.provenance.url,
    );
    logo = {
      storageKey: chosen.storageKey,
      mime: chosen.mime,
      sourceUrl: c.url.startsWith("data:") ? c.provenance.url ?? null : c.url,
      origin: chosen.origin,
      verification: v,
      provenance: distinctProvenance([c.provenance, verificationNote]),
    };
    if (c.role === "unknown") {
      logoIssues.push({
        code: "logo_unverified",
        severity: "blocking",
        field: "logo",
        message: "The only image that could be a logo is not marked as the company's logo on the page, so it cannot be trusted.",
        resolution: "Upload the company's logo file, or confirm this image is the logo.",
      });
    }
    const rivals = candidates.filter((o) => o.role === "company" && o.url !== c.url && Math.abs(o.score - c.score) < 1e-9);
    if (rivals.length > 0) {
      logoIssues.push({
        code: "logo_conflict",
        severity: "blocking",
        field: "logo",
        message: `Two different images are equally likely to be the company logo (${[c.provenance.detail, ...rivals.slice(0, 2).map((r) => r.provenance.detail)].map((d) => `"${d.slice(0, 60)}"`).join(" and ")}).`,
        resolution: "Upload the logo file to use, or choose one of the candidates.",
      });
    }
  } else {
    const first = tried[0];
    const hasCandidates = candidates.some((c) => c.role === "company" || c.role === "unknown");
    if (!first) {
      const rejected = candidates.filter((c) => c.role !== "company" && c.role !== "unknown");
      logoIssues.push({
        code: "logo_missing",
        severity: "blocking",
        field: "logo",
        message: hasCandidates || rejected.length
          ? `No image on the page could be identified as the company's own logo${rejected.length ? ` (only ${dedupeStrings(rejected.map((r) => r.role)).join(", ")} images were found)` : ""}.`
          : "No logo was found on the page, in the scrape or on the client record.",
        resolution: "Upload the company's logo file, or allow a text-only treatment with the confirmed name.",
      });
    } else {
      const text = first.problems.join(" | ").toLowerCase();
      const code: BrandIssue["code"] = /too small/.test(text) ? "logo_low_resolution" : /legible/.test(text) ? "logo_illegible" : "logo_unverified";
      const reasonText = first.problems.filter((p) => !/^low trust/i.test(p))[0] ?? "it could not be checked";
      logoIssues.push({
        code,
        severity: "blocking",
        field: "logo",
        message:
          code === "logo_low_resolution"
            ? `A logo was found but it is too small to use sharply (${reasonText}).`
            : code === "logo_illegible"
              ? `A logo was found but it is not legible on a light or dark background (${reasonText}).`
              : `A logo was found but it could not be loaded and verified (${reasonText}).${tried.length > 1 ? ` ${tried.length} candidates were tried.` : ""}`,
        resolution: "Upload a larger or clearer logo file (PNG with a transparent background or SVG), or allow a text-only treatment with the confirmed name.",
      });
    }
  }

  if (logoIssues.length > 0) {
    if (textOnlyApplies) {
      const primary = logoIssues[0]!;
      issues.push({
        code: primary.code,
        severity: "warning",
        field: "logo",
        message: `${primary.message} A text-only treatment with the verified name "${name.value}" will be used instead; no logo or invented mark will appear.`,
        resolution: "Upload a logo file if you want it on the video.",
      });
      logo = null;
    } else {
      issues.push(...logoIssues);
    }
  }

  // ---------------------------------------------------------- colours
  const opColours = normaliseColours(input.operator.colors);
  const scrapeColours = normaliseColours(input.scrape?.colors);
  const clientColours = normaliseColours(input.client.colors);
  let colors: Sourced<string[]>;
  if (opColours.length) colors = { value: opColours, provenance: [prov("operator", "Brand colours chosen by the operator for this video", "high")] };
  else if (scrapeColours.length) colors = { value: scrapeColours, provenance: [prov("scrape", "Brand colours read from the site (its CSS brand variables and the brand scrape)", "medium", pageUrl)] };
  else if (clientColours.length) colors = { value: clientColours, provenance: [prov("client_record", "Brand colours saved on the client in the app", "medium")] };
  else {
    colors = { value: [], provenance: [prov("scrape", "No brand colours were found on the site or the client record", "low")] };
    issues.push({ code: "colors_missing", severity: "warning", field: "colors", message: "No brand colours were found.", resolution: "Pick the brand colours so the video's graphics match." });
  }

  // ---------------------------------------------------------- offer
  const offerDescription = clean(input.offer.description);
  let offer: Sourced<string | null>;
  const offerName = clean(input.offer.name);
  const offerNameInternal = offerName ? isInternalLabel(offerName, { known }) : { internal: false, reason: null };
  if (offerNameInternal.internal) addInternal(offerName, prov("internal", "Saved offer name", "high"));
  if (clean(input.operator.offer)) offer = { value: clean(input.operator.offer), provenance: [prov("operator", "Offer typed by the operator for this video", "high")] };
  else if (offerName && !offerNameInternal.internal) {
    offer = { value: (offerDescription ? `${offerName}: ${offerDescription}` : offerName).slice(0, 300), provenance: [prov("client_record", `The saved offer "${offerName.slice(0, 60)}"`, "medium")] };
  } else if (clean(input.client.valueProposition)) {
    offer = { value: clean(input.client.valueProposition).slice(0, 300), provenance: [prov("client_record", "The value proposition saved on the client", "medium")] };
  } else {
    offer = { value: null, provenance: [prov("client_record", "No offer was typed, saved or found", "low")] };
    issues.push({ code: "offer_missing", severity: "warning", field: "offer", message: "No offer or value proposition is on record.", resolution: "Say what the viewer gets (the offer) so the video can lead with it." });
  }

  // ---------------------------------------------------------- call to action
  let cta: Sourced<{ label: string; url?: string } | null>;
  if (clean(input.operator.cta)) {
    const url = clean(input.operator.ctaUrl);
    cta = { value: { label: clean(input.operator.cta), ...(url ? { url } : {}) }, provenance: [prov("operator", "Call to action typed by the operator for this video", "high")] };
  } else if (clean(input.adCtaLabel)) {
    cta = { value: { label: clean(input.adCtaLabel) }, provenance: [prov("client_record", "The call-to-action label chosen for the ad", "medium")] };
  } else {
    cta = { value: null, provenance: [prov("client_record", "No call to action was set", "low")] };
    issues.push({ code: "cta_missing", severity: "warning", field: "cta", message: "No call to action is set.", resolution: "Add what the viewer should do next (for example \"Book a free audit\")." });
  }

  // ---------------------------------------------------------- audience, source url
  const audienceText = clean(input.client.audience);
  const audience: Sourced<string | null> = audienceText
    ? { value: audienceText, provenance: [prov("client_record", "The audience saved on the client", "medium")] }
    : { value: null, provenance: [prov("client_record", "No audience is saved on the client", "low")] };
  const sourceUrl: Sourced<string | null> = input.sourceUrl
    ? { value: input.sourceUrl, provenance: [prov("operator", "The landing page address entered for this video", "high", input.sourceUrl)] }
    : { value: null, provenance: [prov("operator", "No landing page address was entered", "low")] };

  // Stable order: name, logo, colours, offer, cta.
  const order: Record<BrandIssue["field"], number> = { sourceUrl: 0, name: 1, logo: 2, colors: 3, offer: 4, cta: 5, claims: 6 };
  issues.sort((a, b) => order[a.field] - order[b.field] || (a.severity === b.severity ? 0 : a.severity === "blocking" ? -1 : 1));

  return {
    version: 1,
    createdAt,
    clientId: input.clientId,
    projectId: input.projectId,
    sourceUrl,
    name,
    nameCandidates,
    internalLabels,
    logo,
    logoCandidates: candidates,
    colors,
    offer,
    cta,
    audience,
    claims: input.claims,
    allowTextOnlyBrand: allowTextOnly,
    conflicts,
    issues,
  };
}
