/**
 * Reads everything a web page says about WHO the company is: its public name (JSON-LD, meta tags,
 * header brand link, footer copyright line) and every image that could be its logo, each tagged with
 * what it most likely is (the company's own mark, a partner, a client, a badge, an icon, ...).
 *
 * Pure: no network, no DOM library. A small tolerant tokenizer builds a tree so that where an image
 * sits (header, footer, a "trusted by" strip) can be told from its ancestors. The caller fetches the
 * page and stylesheets and passes them in.
 */
import type { LogoCandidate, LogoRole, Provenance } from "@/lib/video/pipeline-types";

export type PageEvidence = {
  pageUrl: string;
  title: string | null;
  titleSegments: string[];
  ogSiteName: string | null;
  applicationName: string | null;
  jsonLd: {
    /** `type` is the schema.org type ("Organization"), or "<type>.legalName" for a legal name. */
    names: Array<{ value: string; type: string }>;
    logos: string[];
    sameAs: string[];
  };
  headerBrandTexts: Array<{ text: string; where: string }>;
  footerCopyright: Array<{ text: string; entity: string | null }>;
  logoCandidates: LogoCandidate[];
};

// ------------------------------------------------------------------ limits

const MAX_HTML_CHARS = 2_500_000;
const MAX_ELEMENTS = 80_000;
/** An inline <svg> bigger than this is not copied into a data URI. */
export const MAX_INLINE_SVG_CHARS = 24_000;
const MAX_DATA_URI_CHARS = 400_000;

// ------------------------------------------------------------------ tiny DOM

type Scope = "header" | "footer" | "body";

type El = {
  tag: string;
  attrs: Record<string, string>;
  /** Child elements and raw text runs (text is not entity-decoded yet). */
  children: Array<El | string>;
  parent: El | null;
  /** Source offsets: used to copy an inline <svg> verbatim. */
  start: number;
  end: number;
  scope: Scope;
  /** Inside article / section / aside / main / blockquote. */
  sect: boolean;
  inSvg: boolean;
  /** Document order. */
  order: number;
};

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "noscript", "template"]);
/** Tags that start a new line (inline ones just join with a space). */
const LINE_BREAKING = new Set(["div", "p", "li", "ul", "ol", "br", "section", "article", "footer", "header", "nav", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "address"]);

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  ndash: "–",
  mdash: "—",
  middot: "·",
  bull: "•",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  raquo: "»",
  laquo: "«",
};

function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return m;
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    return ENTITIES[body.toLowerCase()] ?? m;
  });
}

function parseOpenTag(html: string, lt: number): { tag: string; attrs: Record<string, string>; selfClose: boolean; end: number } | null {
  const nameRe = /<([a-zA-Z][^\s/>]*)/y;
  nameRe.lastIndex = lt;
  const nm = nameRe.exec(html);
  if (!nm) return null;
  const n = html.length;
  let p = nameRe.lastIndex;
  const attrs: Record<string, string> = {};
  const attrRe = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/y;
  while (p < n) {
    const ch = html.charCodeAt(p);
    if (ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === 12) {
      p++;
      continue;
    }
    if (ch === 62 /* > */) return { tag: nm[1]!.toLowerCase(), attrs, selfClose: false, end: p + 1 };
    if (ch === 47 /* / */) {
      if (html.charCodeAt(p + 1) === 62) return { tag: nm[1]!.toLowerCase(), attrs, selfClose: true, end: p + 2 };
      p++;
      continue;
    }
    attrRe.lastIndex = p;
    const am = attrRe.exec(html);
    if (!am || am[0].length === 0) {
      p++;
      continue;
    }
    const name = am[1]!.toLowerCase();
    if (!(name in attrs)) attrs[name] = decodeEntities(am[2] ?? am[3] ?? am[4] ?? "");
    p = attrRe.lastIndex;
  }
  return { tag: nm[1]!.toLowerCase(), attrs, selfClose: false, end: n };
}

function classTokens(el: El): string[] {
  return (el.attrs.class ?? "").toLowerCase().split(/\s+/).filter(Boolean);
}

const HEADER_CLASS = /^(?:(?:site|main|global|page|top|primary|sticky|fixed|masthead)[-_])?(?:header|masthead|navbar|topbar|nav|navigation|nav-bar)(?:[-_](?:wrapper|inner|container|main|top|area|bar))?$/;
const FOOTER_CLASS = /^(?:(?:site|main|global|page|bottom)[-_])?(?:footer|colophon)(?:[-_](?:wrapper|inner|container|main|bottom|area))?$/;

function isFooterNode(el: El): boolean {
  if (el.tag === "footer") return !el.parent || !isInside(el, ["article", "blockquote", "aside"]);
  if ((el.attrs.role ?? "").toLowerCase() === "contentinfo") return true;
  const id = (el.attrs.id ?? "").toLowerCase();
  if (id === "footer" || id === "site-footer" || id === "colophon") return true;
  return classTokens(el).some((t) => FOOTER_CLASS.test(t));
}

function isHeaderNode(el: El): boolean {
  if (el.tag === "header") return !el.sect;
  if (el.tag === "nav") return true;
  const role = (el.attrs.role ?? "").toLowerCase();
  if (role === "banner" || role === "navigation") return true;
  const id = (el.attrs.id ?? "").toLowerCase();
  if (/^(?:site-?)?(?:header|masthead|navbar|topbar|top-?bar)$/.test(id)) return true;
  return classTokens(el).some((t) => HEADER_CLASS.test(t));
}

function isInside(el: El, tags: string[]): boolean {
  for (let p = el.parent; p; p = p.parent) if (tags.includes(p.tag)) return true;
  return false;
}

function parseDom(html: string): { root: El; all: El[] } {
  const root: El = { tag: "#root", attrs: {}, children: [], parent: null, start: 0, end: html.length, scope: "body", sect: false, inSvg: false, order: -1 };
  const all: El[] = [];
  const lower = html.toLowerCase();
  const stack: El[] = [root];
  const n = html.length;
  const closeRe = /<\/([a-zA-Z][^\s>/]*)[^>]*>/y;
  let i = 0;
  const addText = (s: string) => {
    if (s) stack[stack.length - 1]!.children.push(s);
  };
  const place = (el: El) => {
    const parent = stack[stack.length - 1]!;
    el.parent = parent;
    el.inSvg = parent.tag === "svg" || parent.inSvg;
    el.sect = parent.sect || ["article", "section", "aside", "main", "blockquote"].includes(parent.tag);
    let scope = parent.scope;
    if (!el.inSvg) {
      if (isFooterNode(el)) scope = "footer";
      else if (scope === "body" && isHeaderNode(el)) scope = "header";
    }
    el.scope = scope;
    el.order = all.length;
    parent.children.push(el);
    all.push(el);
  };

  while (i < n && all.length < MAX_ELEMENTS) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      addText(html.slice(i));
      break;
    }
    if (lt > i) addText(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) {
      const e = html.indexOf("-->", lt + 4);
      i = e === -1 ? n : e + 3;
      continue;
    }
    const next = html[lt + 1];
    if (next === "!" || next === "?") {
      const e = html.indexOf(">", lt);
      i = e === -1 ? n : e + 1;
      continue;
    }
    if (next === "/") {
      closeRe.lastIndex = lt;
      const cm = closeRe.exec(html);
      if (!cm) {
        addText("<");
        i = lt + 1;
        continue;
      }
      const tag = cm[1]!.toLowerCase();
      const closeEnd = closeRe.lastIndex;
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k]!.tag === tag) {
          for (let j = stack.length - 1; j > k; j--) stack[j]!.end = lt;
          stack[k]!.end = closeEnd;
          stack.length = k;
          break;
        }
      }
      i = closeEnd;
      continue;
    }
    const open = parseOpenTag(html, lt);
    if (!open) {
      addText("<");
      i = lt + 1;
      continue;
    }
    const el: El = { tag: open.tag, attrs: open.attrs, children: [], parent: null, start: lt, end: open.end, scope: "body", sect: false, inSvg: false, order: 0 };
    place(el);
    i = open.end;
    if (VOID.has(open.tag) || open.selfClose) continue;
    if (RAW_TEXT.has(open.tag)) {
      const closeIdx = lower.indexOf(`</${open.tag}`, open.end);
      const rawEnd = closeIdx === -1 ? n : closeIdx;
      el.children.push(html.slice(open.end, rawEnd));
      if (closeIdx === -1) {
        el.end = n;
        i = n;
      } else {
        const gt = html.indexOf(">", closeIdx);
        el.end = gt === -1 ? n : gt + 1;
        i = el.end;
      }
      continue;
    }
    stack.push(el);
  }
  for (let k = stack.length - 1; k > 0; k--) stack[k]!.end = n;
  return { root, all };
}

const SKIP_TEXT = new Set(["script", "style", "noscript", "template", "svg", "textarea", "title"]);

/** Visible text lines under an element (block elements break lines). Stops collecting at `cap` characters. */
function textLines(el: El, cap = 100_000): string[] {
  const out: string[] = [];
  let size = 0;
  const st: Array<El | string | { br: true }> = [];
  for (let k = el.children.length - 1; k >= 0; k--) st.push(el.children[k]!);
  while (st.length && size < cap) {
    const x = st.pop()!;
    if (typeof x === "string") {
      out.push(x);
      size += x.length;
      continue;
    }
    if ("br" in x) {
      out.push("\n");
      continue;
    }
    if (SKIP_TEXT.has(x.tag)) continue;
    const breaking = LINE_BREAKING.has(x.tag);
    if (breaking) out.push("\n");
    if (breaking) st.push({ br: true });
    for (let k = x.children.length - 1; k >= 0; k--) st.push(x.children[k]!);
  }
  return decodeEntities(out.join(""))
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function textOf(el: El, cap = 400): string {
  return textLines(el, cap).join(" ").trim();
}

function attr(el: El, name: string): string {
  return (el.attrs[name] ?? "").trim();
}

function descendants(el: El): El[] {
  const out: El[] = [];
  const st: El[] = [];
  for (let k = el.children.length - 1; k >= 0; k--) {
    const c = el.children[k]!;
    if (typeof c !== "string") st.push(c);
  }
  while (st.length) {
    const x = st.pop()!;
    out.push(x);
    for (let k = x.children.length - 1; k >= 0; k--) {
      const c = x.children[k]!;
      if (typeof c !== "string") st.push(c);
    }
  }
  return out;
}

// ------------------------------------------------------------------ small text helpers

/** Lower-case words: camelCase and separators become spaces so \b works on file names and classes. */
function hay(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-./+%:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "");
}

const GENERIC_TEXT = /^(?:home|homepage|home page|logo|menu|skip to content|toggle navigation|navigation|main menu|welcome|index|untitled)$/i;

/** "Acme logo" -> "Acme"; "Home" -> null. */
function cleanBrandText(raw: string): string | null {
  let s = raw.replace(/\s+/g, " ").trim();
  if (!s) return null;
  for (let k = 0; k < 4; k++) {
    const before = s;
    s = s
      .replace(/^(?:go to|back to|visit)\s+/i, "")
      .replace(/\s*[-–—|:]?\s*\b(?:logo|logotype|logomark|wordmark|homepage|home page|home)\b\s*$/i, "")
      .replace(/^\s*\b(?:logo of|logo for|logo)\b\s*[-–—|:]?\s*/i, "")
      .replace(/\s+(?:homepage|home page)$/i, "")
      .trim();
    if (s === before) break;
  }
  if (!s || GENERIC_TEXT.test(s) || s.length > 90) return null;
  return s;
}

function dedupeBy<T>(items: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    const k = key(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

// ------------------------------------------------------------------ URLs

type UrlCtx = { pageUrl: string; base: string };

function resolveUrl(raw: string | undefined | null, ctx: UrlCtx): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s || s.startsWith("#")) return null;
  if (/^(?:javascript|mailto|tel|blob|about):/i.test(s)) return null;
  if (/^data:/i.test(s)) {
    if (!/^data:image\//i.test(s)) return null;
    return s.length <= MAX_DATA_URI_CHARS ? s : null;
  }
  try {
    const u = new URL(s, ctx.base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

/** Entries of a srcset attribute (URLs may contain commas, so this follows the HTML rules rather than splitting on ","). */
export function parseSrcset(srcset: string): Array<{ url: string; weight: number }> {
  const out: Array<{ url: string; weight: number }> = [];
  const s = srcset;
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i]!)) i++;
    if (i >= s.length) break;
    let j = i;
    while (j < s.length && !/\s/.test(s[j]!)) j++;
    let url = s.slice(i, j);
    i = j;
    let descriptors = "";
    if (url.endsWith(",")) {
      url = url.replace(/,+$/, "");
    } else {
      let paren = 0;
      let k = i;
      while (k < s.length && !(s[k] === "," && paren === 0)) {
        if (s[k] === "(") paren++;
        if (s[k] === ")") paren = Math.max(0, paren - 1);
        k++;
      }
      descriptors = s.slice(i, k).trim();
      i = k;
    }
    if (!url) continue;
    const w = /(\d+(?:\.\d+)?)w\b/.exec(descriptors);
    const x = /(\d+(?:\.\d+)?)x\b/.exec(descriptors);
    out.push({ url, weight: w ? Number(w[1]) : x ? Number(x[1]) * 1000 : 1000 });
  }
  return out;
}

function widest(srcset: string | undefined, ctx: UrlCtx): string | null {
  if (!srcset) return null;
  const entries = parseSrcset(srcset).sort((a, b) => b.weight - a.weight);
  for (const e of entries) {
    const u = resolveUrl(e.url, ctx);
    if (u) return u;
  }
  return null;
}

function isPlaceholder(url: string): boolean {
  if (url.startsWith("data:")) {
    const decoded = decodeSafe(url);
    if (/^data:image\/svg\+xml/i.test(url)) return !/<(?:path|circle|rect|polygon|polyline|ellipse|line|text|image|g)\b/i.test(decoded);
    // A tiny inline raster is a lazy-loading placeholder, not a logo.
    return url.length < 400;
  }
  return /(?:^|[/_.-])(?:blank|placeholder|spacer|lazy|loading|transparent|1x1|pixel)\.(?:gif|png|svg|jpg)(?:$|\?)/i.test(url);
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function fileOf(url: string): string {
  if (url.startsWith("data:")) return "";
  try {
    const p = new URL(url).pathname;
    return decodeSafe(p.slice(p.lastIndexOf("/") + 1));
  } catch {
    return "";
  }
}

function pathOf(url: string): string {
  if (url.startsWith("data:")) return "";
  try {
    return decodeSafe(new URL(url).pathname);
  } catch {
    return "";
  }
}

const TRACKING_URL = /(?:facebook\.com\/tr[/?]|google-analytics\.|googletagmanager\.|doubleclick\.net|\/pixel[./?]|\bbeacon\b|\/collect\?|\/track\?|\bstats\.wp\.com)/i;

function isTrackingUrl(url: string): boolean {
  return !url.startsWith("data:") && TRACKING_URL.test(url);
}

function numAttr(el: El, name: string): number | null {
  const v = attr(el, name);
  const m = /^(\d+(?:\.\d+)?)(?:px)?$/.exec(v);
  return m ? Number(m[1]) : null;
}

function isTinyElement(el: El): boolean {
  const w = numAttr(el, "width");
  const h = numAttr(el, "height");
  if (w !== null && w <= 8) return true;
  if (h !== null && h <= 8) return true;
  const style = attr(el, "style").toLowerCase();
  if (/(?:^|;)\s*(?:width|height)\s*:\s*[0-8]px/.test(style)) return true;
  return false;
}

// ------------------------------------------------------------------ roles

const PARTNER_RE = /\b(?:google partner|meta (?:business )?partner|facebook (?:marketing )?partner|microsoft partner|tiktok partner|linkedin partner|premier partner|certified partner|agency partner|technology partners?|partners?|partnerships?|partnered|resellers?|integrations?)\b/;
const BADGE_RE = /\b(?:badges?|certified|certifications?|certificates?|accredited|accreditation|awards?|winners?|seals?|trust (?:badge|seal|mark)|verified|iso \d{3,5}|top rated|best of|g2|capterra|trustpilot|clutch|bbb|rated)\b/;
const CLIENT_RE = /\b(?:clients?|customers?|trusted by|as seen|featured (?:in|on)|worked with|brands we|our brands|brands that trust|in the media|media mentions?|media coverage|press|testimonials?|case stud(?:y|ies)|logos? (?:slider|strip|wall|cloud|carousel|grid|bar)|used by|loved by|who we work with|companies)\b/;
const ICON_RE = /\b(?:icons?|sprites?|arrow|chevron|caret|hamburger|burger|menu|search|close|cart|basket|user|login|phone|email|mail|location|pin|whatsapp|facebook|twitter|instagram|linkedin|youtube|tiktok|pinterest|snapchat|social|share|flag|language)\b/;
const DECOR_RE = /\b(?:bg|background|pattern|hero|banner|texture|overlay|gradient|shape|decor|decoration|decorative|divider|spacer|placeholder|shadow|cover)\b/;
const STRONG_MARK_RE = /\b(?:site logo|brand logo|custom logo|main logo|company logo|header logo|navbar brand|site title|site branding|site name|logo link|brand)\b/;
const FOOTER_MARK_RE = /\bfooter logo\b/;
const WEAK_MARK_RE = /\blogo\b/;

function ancestorHay(el: El, depth: number): string {
  const parts: string[] = [];
  let p = el.parent;
  for (let d = 0; p && d < depth; d++, p = p.parent) {
    if (p.tag === "body" || p.tag === "html" || p.tag === "header" || p.tag === "footer" || p.tag === "nav" || p.tag === "#root") continue;
    parts.push(attr(p, "class"), attr(p, "id"), attr(p, "itemprop") === "logo" ? "site logo" : "");
  }
  return hay(parts.join(" "));
}

function ownHay(el: El): string {
  return hay([attr(el, "class"), attr(el, "id"), attr(el, "itemprop") === "logo" ? "site logo" : ""].join(" "));
}

function isHeading(el: El): boolean {
  return /^h[1-6]$/.test(el.tag);
}

/** Short heading-like text that precedes an element inside its section ("Trusted by", "Our partners"). */
function sectionHeadingText(el: El): string {
  const out: string[] = [];
  let child: El = el;
  let p = el.parent;
  for (let levels = 0; p && p.tag !== "body" && p.tag !== "#root" && levels < 5; levels++) {
    const idx = p.children.indexOf(child);
    let seen = 0;
    for (let k = idx - 1; k >= 0 && seen < 3; k--) {
      const s = p.children[k]!;
      if (typeof s === "string") continue;
      seen++;
      if (s.tag === "script" || s.tag === "style") continue;
      let t = "";
      if (isHeading(s)) t = textOf(s, 120);
      else {
        const h = descendants(s).slice(0, 40).find(isHeading);
        if (h) t = textOf(h, 120);
        else {
          const tt = textOf(s, 80);
          if (tt && tt.length <= 60) t = tt;
        }
      }
      if (t) out.push(t);
    }
    if (["section", "footer", "header", "main", "article", "aside"].includes(p.tag)) break;
    child = p;
    p = p.parent;
  }
  return hay(out.join(" . "));
}

type RoleInput = {
  scope: Scope;
  home: boolean;
  alt: string;
  file: string;
  own: string;
  anc: string;
  heading: string;
  nameMatch: boolean;
  /** For an element that is not an image (CSS rule): the selector text goes in `own`. */
};

function classifyRole(inp: RoleInput): { role: LogoRole; reason?: string; mark: "strong" | "weak" | null } {
  const altH = hay(inp.alt);
  const fileH = hay(inp.file);
  const strong = STRONG_MARK_RE.test(inp.own) || STRONG_MARK_RE.test(inp.anc) || (inp.scope === "footer" && (FOOTER_MARK_RE.test(inp.own) || FOOTER_MARK_RE.test(inp.anc)));
  const weak = WEAK_MARK_RE.test(inp.own) || WEAK_MARK_RE.test(inp.anc) || /\blogo\b/.test(fileH);
  const mark = strong ? "strong" : weak ? "weak" : null;

  // The site's own name in the alt text or file name of the home link wins over keyword guesses.
  if (inp.nameMatch && inp.home) return { role: "company", mark };

  const direct = `${altH} | ${fileH} | ${inp.own}`;
  const context = `${direct} | ${inp.anc}`;
  const soft = inp.scope === "header" ? "" : inp.heading;
  const check = (re: RegExp): "direct" | "context" | "soft" | null => (re.test(direct) ? "direct" : re.test(inp.anc) ? "context" : soft && re.test(soft) ? "soft" : null);

  const evidence = (re: RegExp, text: string): string => {
    const m = re.exec(text);
    return m ? `"${m[0]}"` : "keyword";
  };

  const partner = check(PARTNER_RE);
  if (partner && !(inp.nameMatch && partner !== "direct")) {
    const where = partner === "direct" ? "its alt text, file name or class" : partner === "context" ? "its surrounding markup" : "the heading above it";
    return { role: "partner", reason: `Looks like a partner logo: ${evidence(PARTNER_RE, partner === "soft" ? soft : context)} in ${where}`, mark };
  }
  const badge = check(BADGE_RE);
  if (badge && !(inp.nameMatch && badge !== "direct")) {
    return { role: "badge", reason: `Looks like a badge, award or certification: ${evidence(BADGE_RE, badge === "soft" ? soft : context)}`, mark };
  }
  const client = check(CLIENT_RE);
  if (client && !(inp.nameMatch && client !== "direct")) {
    return { role: "client", reason: `Looks like a client or press logo: ${evidence(CLIENT_RE, client === "soft" ? soft : context)}`, mark };
  }
  if (!inp.home && !strong && ICON_RE.test(`${altH} | ${fileH} | ${inp.own}`)) {
    return { role: "icon", reason: "Looks like a user-interface or social icon, not the company logo", mark };
  }
  if (!inp.home && !strong && !weak && DECOR_RE.test(`${fileH} | ${inp.own}`)) {
    return { role: "decorative", reason: "Looks like a decorative image (background, banner or pattern)", mark };
  }

  if (inp.scope === "header") {
    if (inp.home || strong || weak || inp.nameMatch) return { role: "company", mark };
    return { role: "unknown", reason: "In the header but not marked as the site logo", mark };
  }
  if (inp.scope === "footer") {
    if (inp.nameMatch || strong) return { role: "company", mark };
    return { role: "unknown", reason: "A footer image that is not marked as the company logo and does not carry its name", mark };
  }
  if (strong || (inp.home && (weak || inp.nameMatch))) return { role: "company", mark };
  return { role: "unknown", reason: "An image on the page that is not marked as the company logo", mark };
}

// ------------------------------------------------------------------ JSON-LD

const ORG_TYPE_RE = /(?:Organization|Corporation|Business|Brand|WebSite|Store|Company|NGO|Agency|Dentist|Restaurant|Hotel|School|University|Clinic|Hospital|Gym|Salon|Studio|Shop|Service)$/;

type LdBits = { names: Array<{ value: string; type: string }>; logos: string[]; sameAs: string[] };

function typesOf(node: Record<string, unknown>): string[] {
  const t = node["@type"];
  if (typeof t === "string") return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
  return [];
}

function stringsOf(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(stringsOf);
  return [];
}

function logoUrlsOf(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(logoUrlsOf);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return [...stringsOf(o.url), ...stringsOf(o.contentUrl)];
  }
  return [];
}

function collectJsonLd(node: unknown, bits: LdBits, depth = 0): void {
  if (depth > 12 || node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectJsonLd(item, bits, depth + 1);
    return;
  }
  const obj = node as Record<string, unknown>;
  const types = typesOf(obj);
  const orgType = types.find((t) => ORG_TYPE_RE.test(t));
  if (orgType) {
    for (const v of stringsOf(obj.name)) {
      const t = decodeEntities(v).replace(/\s+/g, " ").trim();
      if (t) bits.names.push({ value: t, type: orgType });
    }
    for (const v of stringsOf(obj.legalName)) {
      const t = decodeEntities(v).replace(/\s+/g, " ").trim();
      if (t) bits.names.push({ value: t, type: `${orgType}.legalName` });
    }
    for (const v of stringsOf(obj.alternateName)) {
      const t = decodeEntities(v).replace(/\s+/g, " ").trim();
      if (t) bits.names.push({ value: t, type: `${orgType}.alternateName` });
    }
    bits.logos.push(...logoUrlsOf(obj.logo));
    bits.sameAs.push(...stringsOf(obj.sameAs));
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k === "@context") continue;
    if (v && typeof v === "object") collectJsonLd(v, bits, depth + 1);
  }
}

function parseJsonLdText(raw: string): unknown {
  const cleaned = raw
    .replace(/^﻿/, "")
    .replace(/^\s*<!--/, "")
    .replace(/-->\s*$/, "")
    .replace(/^\s*\/\*<!\[CDATA\[\*\//, "")
    .replace(/\/\*\]\]>\*\/\s*$/, "")
    .trim();
  if (!cleaned) return null;
  try {
    return JSON.parse(cleaned);
  } catch {
    // Common slip: trailing commas.
    try {
      return JSON.parse(cleaned.replace(/,\s*([}\]])/g, "$1"));
    } catch {
      return null;
    }
  }
}

// ------------------------------------------------------------------ home link

function isHomeHref(href: string | undefined, ctx: UrlCtx): boolean {
  if (href === undefined) return false;
  const h = href.trim();
  if (h === "/" || h === "./" || h === "../" || h === "") return true;
  if (/^(?:javascript|mailto|tel):/i.test(h) || h.startsWith("#")) return false;
  try {
    const u = new URL(h, ctx.base);
    const page = new URL(ctx.pageUrl);
    const sameHost = u.hostname.replace(/^www\./, "") === page.hostname.replace(/^www\./, "");
    if (!sameHost) return false;
    const p = u.pathname.replace(/\/(?:index|default|home)\.(?:html?|php|aspx?)$/i, "/").replace(/\/+$/, "");
    if (p === "" && !u.search) return true;
    if (/^\/[a-z]{2}(?:[-_][a-z]{2})?$/i.test(p) && !u.search) return true;
    return false;
  } catch {
    return false;
  }
}

/** A logo link whose href is "#" or empty: still the brand link when it is marked as one and sits in the header. */
function isBrandPlaceholderLink(a: El): boolean {
  if (a.scope !== "header") return false;
  const href = (a.attrs.href ?? "").trim();
  if (href !== "" && href !== "#") return false;
  return /\b(?:logo|brand|navbar brand|site logo|custom logo)\b/.test(ownHay(a));
}

function closestAnchor(el: El, depth = 5): El | null {
  let p: El | null = el.parent;
  for (let d = 0; p && d < depth; d++, p = p.parent) if (p.tag === "a") return p;
  return null;
}

// ------------------------------------------------------------------ CSS

function cssRules(css: string): Array<{ selector: string; body: string }> {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Array<{ selector: string; body: string }> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = re.exec(stripped)) && guard++ < 40_000) {
    const selector = m[1]!.trim();
    if (selector.startsWith("@")) continue;
    out.push({ selector, body: m[2]! });
  }
  return out;
}

const CSS_LOGO_SELECTOR = /logo|brand|site-title/i;

function cssUrls(body: string): string[] {
  const out: string[] = [];
  const re = /background(?:-image)?\s*:[^;}]*?url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) out.push(m[2]!.trim());
  return out;
}

// ------------------------------------------------------------------ copyright

const LEGAL_ABBREV_CONTINUE = new Set(["pty", "sdn", "pvt", "co", "l", "s", "a", "u", "b", "p"]);
const COPYRIGHT_CUT =
  /\s*(?:[.,;|•·–—-]\s*)?(?:all\s+rights?|rights?\s+reserved|powered\s+by|designed\s+by|built\s+by|developed\s+by|website\s+by|site\s+by|made\s+(?:with|by)|privacy|terms|cookie|sitemap|site\s*map|registered\s+(?:in|office)|abn\b|acn\b|company\s+(?:no|number)|reg(?:istration)?\.?\s*(?:no|number)|vat\b|licen[sc]e)/i;

export function copyrightEntity(line: string): string | null {
  const m = /(?:©|&copy;|\(c\)|copyright)([\s\S]*)$/i.exec(line);
  if (!m) return null;
  let rest = m[1]!.trim();
  for (let k = 0; k < 4; k++) {
    const before = rest;
    rest = rest
      .replace(/^(?:copyright|©|\(c\)|&copy;)\s*/i, "")
      .replace(/^(?:(?:19|20)\d{2}(?:\s*[-–—,/]\s*(?:19|20)?\d{2,4})*)\s*[,.:\-–—]?\s*/, "")
      .replace(/^by\s+/i, "")
      .trim();
    if (rest === before) break;
  }
  const cut = COPYRIGHT_CUT.exec(rest);
  if (cut && cut.index >= 0) rest = rest.slice(0, cut.index);
  rest = rest.split(/\s+[|•·–—-]\s+|\s*[|•·]\s*/)[0] ?? rest;
  // Cut at a sentence end, but keep "Pty. Ltd." together.
  const pieces = rest.split(/\.\s+(?=[A-Z])/);
  let kept = pieces[0] ?? "";
  for (let k = 1; k < pieces.length; k++) {
    const lastWord = (kept.split(/\s+/).pop() ?? "").toLowerCase().replace(/[^a-z]/g, "");
    if (LEGAL_ABBREV_CONTINUE.has(lastWord)) kept += `. ${pieces[k]}`;
    else break;
  }
  const entity = kept.replace(/^[\s.,;:\-–—]+|[\s,;:\-–—.]+$/g, "");
  if (!entity || entity.length < 2 || entity.length > 80) return null;
  if (entity.split(/\s+/).length > 8) return null;
  if (/^\d+$/.test(entity)) return null;
  return entity;
}

// ------------------------------------------------------------------ the parser

type RawCandidate = LogoCandidate & { order: number };

function prov(source: Provenance["source"], detail: string, pageUrl: string, confidence: Provenance["confidence"]): Provenance {
  return { source, detail, url: pageUrl, confidence };
}

const GENERIC_SEGMENT = /^(?:home|homepage|welcome|index|main|menu|contact|about|blog|services?|products?|login|shop|untitled)$/i;

function hostLabel(pageUrl: string): string | null {
  try {
    const host = new URL(pageUrl).hostname.replace(/^www\./, "");
    const label = host.split(".")[0] ?? "";
    return label.length >= 3 ? label : null;
  } catch {
    return null;
  }
}

export function parseBrandPage(html: string, pageUrl: string, opts: { css?: string } = {}): PageEvidence {
  const src = (html ?? "").slice(0, MAX_HTML_CHARS);
  const { all } = parseDom(src);

  // <base href>
  let base = pageUrl;
  const baseEl = all.find((e) => e.tag === "base" && attr(e, "href"));
  if (baseEl) {
    try {
      base = new URL(attr(baseEl, "href"), pageUrl).toString();
    } catch {
      /* keep the page url */
    }
  }
  const ctx: UrlCtx = { pageUrl, base };

  // ---- meta + title
  const metaContent = (names: string[]): string | null => {
    for (const e of all) {
      if (e.tag !== "meta") continue;
      const key = (attr(e, "property") || attr(e, "name") || attr(e, "itemprop")).toLowerCase();
      if (names.includes(key)) {
        const c = attr(e, "content").replace(/\s+/g, " ").trim();
        if (c) return c;
      }
    }
    return null;
  };
  const ogSiteName = metaContent(["og:site_name"]);
  const applicationName = metaContent(["application-name", "apple-mobile-web-app-title"]);
  const titleEl = all.find((e) => e.tag === "title" && !e.inSvg);
  const title = titleEl ? decodeEntities((typeof titleEl.children[0] === "string" ? titleEl.children[0] : "") ?? "").replace(/\s+/g, " ").trim() || null : null;
  const titleSegments = title
    ? dedupeBy(
        title
          .split(/\s*[|–—·•»]\s*|\s+-\s+|:\s+/)
          .map((s) => s.trim())
          .filter(Boolean),
        (s) => s.toLowerCase(),
      )
    : [];

  // ---- JSON-LD
  const ld: LdBits = { names: [], logos: [], sameAs: [] };
  for (const e of all) {
    if (e.tag !== "script") continue;
    if (!/ld\+json/i.test(attr(e, "type"))) continue;
    const raw = typeof e.children[0] === "string" ? e.children[0] : "";
    const parsed = parseJsonLdText(raw);
    if (parsed) collectJsonLd(parsed, ld);
  }
  const jsonLd = {
    names: dedupeBy(ld.names, (n) => `${n.type}|${n.value.toLowerCase()}`),
    logos: dedupeBy(
      ld.logos.map((l) => resolveUrl(l, ctx)).filter((u): u is string => Boolean(u)),
      (u) => u,
    ),
    sameAs: dedupeBy(
      ld.sameAs.map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s)),
      (s) => s,
    ),
  };

  // Names a logo's alt text or file name can be matched against.
  const knownNames: string[] = [
    ogSiteName,
    applicationName,
    ...jsonLd.names.map((n) => n.value),
    ...titleSegments.filter((s) => s.length <= 40 && !GENERIC_SEGMENT.test(s)),
    hostLabel(pageUrl),
  ]
    .filter((s): s is string => Boolean(s))
    .map((s) => norm(s))
    .filter((s) => s.length >= 3);
  const matchesName = (text: string): boolean => {
    const cleaned = cleanBrandText(text);
    if (!cleaned) return false;
    const n = norm(cleaned);
    if (n.length < 3) return false;
    return knownNames.some((k) => n.includes(k) || (n.length >= 4 && k.includes(n) && n.length >= k.length * 0.6));
  };

  // ---- candidates
  const raw: RawCandidate[] = [];
  let seq = 0;
  const push = (url: string, role: LogoRole, score: number, provenance: Provenance, rejectedReason?: string) => {
    raw.push({ url, role, score, provenance, ...(rejectedReason ? { rejectedReason } : {}), order: seq++ });
  };

  const headerBrandTexts: Array<{ text: string; where: string }> = [];
  const addBrandText = (text: string | null | undefined, where: string) => {
    const c = text ? cleanBrandText(text) : null;
    if (c) headerBrandTexts.push({ text: c, where });
  };

  // JSON-LD logo
  jsonLd.logos.forEach((u, idx) => push(u, "company", 80 - idx * 0.5, prov("page_jsonld", "JSON-LD Organization.logo", pageUrl, "high")));

  // microdata itemprop="logo" on <meta>/<link>
  for (const e of all) {
    if ((e.tag === "meta" || e.tag === "link") && attr(e, "itemprop").toLowerCase() === "logo") {
      const u = resolveUrl(attr(e, "content") || attr(e, "href"), ctx);
      if (u) push(u, "company", 78, prov("page_jsonld", `microdata itemprop="logo" on <${e.tag}>`, pageUrl, "high"));
    }
  }

  // <link rel=icon...>
  for (const e of all) {
    if (e.tag !== "link") continue;
    const rel = attr(e, "rel").toLowerCase();
    if (!/(?:^|\s)(?:icon|shortcut icon|apple-touch-icon(?:-precomposed)?|mask-icon)(?:\s|$)/.test(rel) && !/icon/.test(rel)) continue;
    if (/stylesheet|preload|prefetch/.test(rel)) continue;
    const u = resolveUrl(attr(e, "href"), ctx);
    if (!u) continue;
    const sizes = /(\d+)x\d+/.exec(attr(e, "sizes"));
    const bonus = sizes ? Math.min(6, Number(sizes[1]) / 64) : 0;
    push(u, "icon", 15 + bonus, prov("page_meta", `<link rel="${rel}">`, pageUrl, "low"), "A browser or home-screen icon, not the company logo");
  }

  // og:image / twitter:image
  for (const e of all) {
    if (e.tag !== "meta") continue;
    const key = (attr(e, "property") || attr(e, "name")).toLowerCase();
    if (!["og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src"].includes(key)) continue;
    const u = resolveUrl(attr(e, "content"), ctx);
    if (u) push(u, "unknown", 8, prov("page_meta", `<meta ${attr(e, "property") ? "property" : "name"}="${key}">`, pageUrl, "low"), "A social share image is not a logo");
  }

  // Header decay so two logos in one header do not tie.
  const imgSources = (el: El): { primary: string | null; alternates: string[] } => {
    const urls: string[] = [];
    const add = (u: string | null) => {
      if (u && !urls.includes(u)) urls.push(u);
    };
    const parent = el.parent;
    // <picture><source srcset> (skip dark-scheme and avif variants)
    if (parent && parent.tag === "picture") {
      for (const c of parent.children) {
        if (typeof c === "string" || c.tag !== "source") continue;
        const type = attr(c, "type").toLowerCase();
        const media = attr(c, "media").toLowerCase();
        if (/avif/.test(type) || /prefers-color-scheme/.test(media)) continue;
        add(widest(attr(c, "srcset") || attr(c, "data-srcset"), ctx));
      }
    }
    add(widest(attr(el, "srcset"), ctx));
    add(widest(attr(el, "data-srcset") || attr(el, "data-lazy-srcset"), ctx));
    for (const name of ["data-src", "data-lazy-src", "data-original", "data-lazy", "data-img", "src"]) add(resolveUrl(attr(el, name), ctx));
    const real = urls.filter((u) => !isPlaceholder(u) && !isTrackingUrl(u));
    return { primary: real[0] ?? null, alternates: real.slice(1) };
  };

  let headerIndex = 0;
  let footerIndex = 0;

  const addImageCandidates = (el: El, kind: "img" | "svg", urls: { primary: string; alternates: string[] }, alt: string, label: string) => {
    const scope = el.scope;
    const anchor = closestAnchor(el);
    const home = Boolean(anchor && (isHomeHref(anchor.attrs.href, ctx) || isBrandPlaceholderLink(anchor)));
    const file = fileOf(urls.primary);
    const own = ownHay(el) + " " + (anchor ? ownHay(anchor) : "");
    const anc = ancestorHay(el, 5);
    const nameMatch = matchesName(alt) || matchesName(attr(el, "title")) || (file ? matchesName(file.replace(/\.[a-z0-9]+$/i, "")) : false) || (anchor ? matchesName(attr(anchor, "aria-label")) || matchesName(attr(anchor, "title")) : false);
    const heading = scope === "header" ? "" : sectionHeadingText(el);
    const verdict = classifyRole({ scope, home, alt, file: file + " " + pathOf(urls.primary).split("/").slice(-3, -1).join(" "), own, anc, heading, nameMatch, });

    const logoWord = /logo/i.test(`${alt} ${file} ${attr(el, "class")} ${attr(el, "id")}`) || verdict.mark !== null;
    const relevant = home || nameMatch || logoWord || verdict.role === "partner" || verdict.role === "badge" || verdict.role === "client";
    if (!relevant) return;
    if (scope === "body" && verdict.role !== "company" && !logoWord) return;

    // Ignore UI icons and decoration unless they were clearly pointed at as a logo.
    let score: number;
    const role = verdict.role;
    if (role === "company") {
      if (scope === "header") {
        score = home ? 85 : verdict.mark === "strong" ? 78 : verdict.mark === "weak" ? 72 : 62;
        score -= Math.min(3, headerIndex++ * 0.3);
      } else if (scope === "footer") {
        score = verdict.mark === "strong" ? 48 : 46;
        score -= Math.min(3, footerIndex++ * 0.3);
      } else score = home ? 60 : 50;
      if (/logo/i.test(file)) score += 4;
      if (nameMatch && !home) score += 4;
      if (kind === "svg" || /\.svg(?:$|\?)|image\/svg/i.test(urls.primary.slice(0, 60)) || /\.svg(?:$|\?)/i.test(urls.primary)) score += 2;
    } else {
      score = role === "icon" ? 12 : role === "decorative" ? 3 : role === "unknown" ? (scope === "header" ? 30 : 15) : 5;
    }

    const where = scope === "header" ? "<header>" : scope === "footer" ? "<footer>" : "page body";
    const source: Provenance["source"] = scope === "footer" ? "page_footer" : "page_header";
    const conf: Provenance["confidence"] = role === "company" ? (scope === "header" ? "high" : "medium") : "low";
    const homeNote = home ? " in the home link" : "";
    const detail = `${where} ${label}${homeNote}${alt ? ` (alt "${alt.slice(0, 60)}")` : ""}`;
    const provenance = prov(scope === "body" ? "page_header" : source, scope === "body" ? `${label} marked as a logo in the page body${alt ? ` (alt "${alt.slice(0, 60)}")` : ""}` : detail, pageUrl, conf);
    const reason = role === "company" ? undefined : verdict.reason ?? "Not the company logo";
    push(urls.primary, role, Math.round(score * 10) / 10, provenance, reason);
    for (const alt2 of urls.alternates.slice(0, 3)) {
      push(alt2, role, Math.round((score - 3) * 10) / 10, { ...provenance, detail: `${detail} (alternate source of the same image)` }, reason);
    }
    if (role === "company" && scope === "header") {
      if (alt) addBrandText(alt, `header ${home ? "home-link " : ""}${kind === "svg" ? "svg title" : "img alt"}`);
    }
  };

  for (const el of all) {
    if (el.inSvg) continue;
    if (el.tag === "img") {
      if (isTinyElement(el)) continue;
      const { primary, alternates } = imgSources(el);
      if (!primary) continue;
      addImageCandidates(el, "img", { primary, alternates }, attr(el, "alt"), "<img>");
    } else if (el.tag === "svg") {
      if (isTinyElement(el)) continue;
      const w = numAttr(el, "width");
      const h = numAttr(el, "height");
      const anchor = closestAnchor(el);
      const own = ownHay(el) + " " + (anchor ? ownHay(anchor) : "");
      const anc = ancestorHay(el, 4);
      const looksLikeIcon = ICON_RE.test(own) && !STRONG_MARK_RE.test(own) && !STRONG_MARK_RE.test(anc);
      const pointedAt = Boolean(anchor && isHomeHref(anchor.attrs.href, ctx)) || STRONG_MARK_RE.test(own) || STRONG_MARK_RE.test(anc) || WEAK_MARK_RE.test(own) || WEAK_MARK_RE.test(anc);
      if (!pointedAt) continue;
      if (looksLikeIcon) continue;
      if (isInside(el, ["button"])) continue;
      if ((w !== null && w <= 32 && h !== null && h <= 32) && !(anchor && isHomeHref(anchor.attrs.href, ctx))) continue;
      const rawSvg = src.slice(el.start, el.end);
      if (rawSvg.length > MAX_INLINE_SVG_CHARS || rawSvg.length < 40) continue;
      if (!/<(?:path|circle|rect|polygon|polyline|ellipse|line|text|image)\b/i.test(rawSvg)) continue;
      const svgTitleEl = el.children.find((c): c is El => typeof c !== "string" && c.tag === "title");
      const rawTitle = svgTitleEl && typeof svgTitleEl.children[0] === "string" ? decodeEntities(svgTitleEl.children[0]).trim() : "";
      const alt = rawTitle || attr(el, "aria-label") || (anchor ? attr(anchor, "aria-label") : "");
      let svgText = rawSvg;
      const openEnd = svgText.indexOf(">");
      let openTag = svgText.slice(0, openEnd + 1);
      if (!/\sxmlns\s*=/.test(openTag)) openTag = openTag.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
      if (/xlink:/.test(svgText) && !/xmlns:xlink/.test(openTag)) openTag = openTag.replace(/<svg/i, '<svg xmlns:xlink="http://www.w3.org/1999/xlink"');
      svgText = openTag + svgText.slice(openEnd + 1);
      const uri = `data:image/svg+xml;utf8,${encodeURIComponent(svgText.replace(/\s+/g, " "))}`;
      addImageCandidates(el, "svg", { primary: uri, alternates: [] }, alt, "inline <svg>");
    }
    // CSS background logo set inline on any element.
    const style = attr(el, "style");
    if (style && /url\(/i.test(style) && el.tag !== "img") {
      const own = ownHay(el);
      const anc = ancestorHay(el, 4);
      const anchor = closestAnchor(el) ?? (el.tag === "a" ? el : null);
      const home = Boolean(anchor && anchor.scope === "header" && isHomeHref(anchor.attrs.href, ctx));
      const pointed = STRONG_MARK_RE.test(own) || WEAK_MARK_RE.test(own) || STRONG_MARK_RE.test(anc) || WEAK_MARK_RE.test(anc);
      if (home || pointed) {
        for (const u0 of cssUrls(style)) {
          const u = resolveUrl(u0, ctx);
          if (!u || isPlaceholder(u)) continue;
          const verdict = classifyRole({ scope: el.scope, home, alt: "", file: fileOf(u), own, anc, heading: el.scope === "header" ? "" : sectionHeadingText(el), nameMatch: matchesName(fileOf(u).replace(/\.[a-z0-9]+$/i, "")) });
          const role = verdict.role;
          const score = role === "company" ? (el.scope === "header" ? (home ? 80 : 70) : el.scope === "footer" ? 44 : 50) : 5;
          const source: Provenance["source"] = el.scope === "footer" ? "page_footer" : "page_header";
          push(u, role, score, prov(source, `inline style background-image on <${el.tag}${attr(el, "class") ? ` class="${attr(el, "class").slice(0, 40)}"` : ""}>`, pageUrl, role === "company" ? "medium" : "low"), role === "company" ? undefined : verdict.reason ?? "Not the company logo");
        }
      }
    }
  }

  // ---- header brand texts (links)
  for (const el of all) {
    if (el.inSvg) continue;
    if (el.tag === "a" && el.scope === "header") {
      const home = isHomeHref(el.attrs.href, ctx);
      const own = ownHay(el);
      const marked = STRONG_MARK_RE.test(own) || WEAK_MARK_RE.test(own) || /\bbrand\b/.test(own);
      if (!home && !marked) continue;
      if (CLIENT_RE.test(own) || PARTNER_RE.test(own)) continue;
      const kind = home ? "home link" : `brand link (${(attr(el, "class") || "a").slice(0, 30)})`;
      const imgs = descendants(el).filter((d) => d.tag === "img");
      for (const img of imgs) addBrandText(attr(img, "alt"), `header ${kind} img alt`);
      addBrandText(attr(el, "aria-label"), `header ${kind} aria-label`);
      addBrandText(attr(el, "title"), `header ${kind} title`);
      const svgTitle = descendants(el).find((d) => d.tag === "title" && d.inSvg);
      if (svgTitle && typeof svgTitle.children[0] === "string") addBrandText(decodeEntities(svgTitle.children[0]), `header ${kind} svg title`);
      const text = textOf(el, 200);
      if (text && text.length <= 60) addBrandText(text, `header ${kind} text`);
    } else if (el.scope !== "footer" && el.tag !== "a") {
      const own = ownHay(el);
      if (/\b(?:site title|site name|navbar brand|brand name|logo text|site branding)\b/.test(own) && !isInside(el, ["a"])) {
        const text = textOf(el, 200);
        if (text && text.length <= 60) addBrandText(text, `brand element text (${(attr(el, "class") || el.tag).slice(0, 30)})`);
      }
    }
  }

  // ---- footer copyright
  const footerLines: string[] = [];
  for (const el of all) {
    if (el.scope === "footer" && el.parent && el.parent.scope !== "footer" && !el.inSvg) footerLines.push(...textLines(el, 20_000));
  }
  let copyrightLines = footerLines.filter((l) => /©|&copy;|\(c\)|copyright/i.test(l));
  if (copyrightLines.length === 0) {
    for (const el of all) {
      if (el.inSvg) continue;
      if (/copyright/i.test(`${attr(el, "class")} ${attr(el, "id")}`)) copyrightLines.push(...textLines(el, 2_000));
    }
    copyrightLines = copyrightLines.filter((l) => /©|copyright|\(c\)/i.test(l));
  }
  if (copyrightLines.length === 0) {
    const body = all.find((e) => e.tag === "body");
    if (body) copyrightLines = textLines(body, 200_000).filter((l) => /©/.test(l)).slice(-3);
  }
  const footerCopyright = dedupeBy(
    copyrightLines.slice(0, 6).map((l) => ({ text: l.slice(0, 200), entity: copyrightEntity(l) })),
    (c) => c.text.toLowerCase(),
  );

  // ---- CSS rules (opts.css) for logo/brand selectors
  const css = opts.css ?? "";
  if (css) {
    for (const rule of cssRules(css)) {
      const urls = cssUrls(rule.body);
      if (urls.length === 0) continue;
      for (const selector of rule.selector.split(",").map((s) => s.trim())) {
        if (!CSS_LOGO_SELECTOR.test(selector)) continue;
        const selHay = hay(selector);
        if (/:hover|:focus|:active/.test(selector)) continue;
        const inFooter = /footer/.test(selHay);
        for (const u0 of urls) {
          const u = resolveUrl(u0, ctx);
          if (!u || isPlaceholder(u)) continue;
          const verdict = classifyRole({ scope: inFooter ? "footer" : "header", home: false, alt: "", file: fileOf(u), own: selHay, anc: "", heading: "", nameMatch: matchesName(fileOf(u).replace(/\.[a-z0-9]+$/i, "")) });
          let role = verdict.role;
          let reason = verdict.reason;
          if (role === "unknown" && !inFooter) {
            // A stylesheet rule for a logo/brand selector is an explicit statement that this is the site logo.
            role = "company";
            reason = undefined;
          }
          const score = role === "company" ? (inFooter ? 44 : 58) + (/logo/i.test(selector) ? 4 : 0) + (/\.svg(?:$|\?)/i.test(u) ? 2 : 0) : 5;
          push(u, role, score, prov("page_css", `CSS rule "${selector.slice(0, 80)}" sets background-image`, pageUrl, role === "company" ? "medium" : "low"), role === "company" ? undefined : reason ?? "Not the company logo");
        }
      }
    }
  }

  // ---- dedupe by URL, keep the best score, merge provenance
  const groups = new Map<string, RawCandidate[]>();
  for (const c of raw) {
    const key = c.url.startsWith("data:") ? c.url : c.url.replace(/#.*$/, "");
    const g = groups.get(key);
    if (g) g.push(c);
    else groups.set(key, [c]);
  }
  const merged: RawCandidate[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => b.score - a.score || a.order - b.order);
    const best = { ...sorted[0]! };
    const others = sorted.slice(1);
    if (others.length) {
      const distinctSources = new Set(sorted.map((c) => c.provenance.source));
      if (best.role === "company") best.score = Math.min(99, Math.round((best.score + 6 * (distinctSources.size - 1)) * 10) / 10);
      const extra = dedupeBy(others, (c) => `${c.provenance.source}|${c.provenance.detail}`)
        .slice(0, 4)
        .map((c) => c.provenance.detail);
      best.provenance = { ...best.provenance, detail: `${best.provenance.detail}; also found as: ${extra.join("; ")}` };
    }
    merged.push(best);
  }
  merged.sort((a, b) => b.score - a.score || a.order - b.order);
  const logoCandidates: LogoCandidate[] = merged.map(({ order: _order, ...c }) => {
    void _order;
    return c;
  });

  return {
    pageUrl,
    title,
    titleSegments,
    ogSiteName,
    applicationName,
    jsonLd,
    headerBrandTexts: dedupeBy(headerBrandTexts, (h) => h.text.toLowerCase() + "|" + h.where),
    footerCopyright,
    logoCandidates,
  };
}
