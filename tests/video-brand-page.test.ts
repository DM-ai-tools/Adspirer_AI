import { describe, expect, it } from "vitest";
import { copyrightEntity, parseBrandPage, parseSrcset } from "@/lib/video/brand-page";

const PAGE = "https://www.acme-ads.example/services/video";

const svgMark = `<svg viewBox="0 0 120 40" width="120" height="40"><title>Acme</title><path d="M0 0 L60 40 L120 0 Z" fill="#0057ff"/><rect x="10" y="10" width="20" height="20"/></svg>`;

function company(ev: ReturnType<typeof parseBrandPage>) {
  return ev.logoCandidates.filter((c) => c.role === "company");
}

describe("parseBrandPage: names", () => {
  const html = `<!doctype html><html><head>
    <title>Acme Pty Ltd | Best Ads &amp; Growth – Sydney</title>
    <meta property="og:site_name" content="Acme">
    <meta name="application-name" content="Acme App">
    <meta name="apple-mobile-web-app-title" content="Acme">
    </head><body>
    <header><a href="/" aria-label="Acme home"><img src="/logo.svg" alt="Acme logo"></a></header>
    <main><h1>Hello</h1></main>
    <footer><p>© 2026 Acme Pty Ltd. All rights reserved.</p><p>Website by Someone Else</p></footer>
    </body></html>`;
  const ev = parseBrandPage(html, PAGE);

  it("reads the title, its segments and the meta names", () => {
    expect(ev.title).toBe("Acme Pty Ltd | Best Ads & Growth – Sydney");
    expect(ev.titleSegments).toEqual(["Acme Pty Ltd", "Best Ads & Growth", "Sydney"]);
    expect(ev.ogSiteName).toBe("Acme");
    expect(ev.applicationName).toBe("Acme App");
  });
  it("reads the header home link (alt with 'logo' removed, aria-label with 'home' removed)", () => {
    const texts = ev.headerBrandTexts.map((h) => h.text);
    expect(texts).toContain("Acme");
    expect(ev.headerBrandTexts.some((h) => /home-link img alt/.test(h.where))).toBe(true);
    expect(ev.headerBrandTexts.some((h) => /aria-label/.test(h.where))).toBe(true);
  });
  it("reads the footer copyright entity", () => {
    expect(ev.footerCopyright[0]?.entity).toBe("Acme Pty Ltd");
    expect(ev.footerCopyright.length).toBe(1);
  });
  it("splits copyright lines in the usual shapes", () => {
    expect(copyrightEntity("© 2026 Acme Pty Ltd. All rights reserved.")).toBe("Acme Pty Ltd");
    expect(copyrightEntity("Copyright © 2019-2026 Zeta Labs, Inc. | Privacy | Terms")).toBe("Zeta Labs, Inc");
    expect(copyrightEntity("© Acme Pty. Ltd. ABN 12 345 678 901")).toBe("Acme Pty. Ltd");
    expect(copyrightEntity("&copy; 2026 Foo Bar - Powered by Baz")).toBe("Foo Bar");
    expect(copyrightEntity("© 2026")).toBeNull();
  });
});

describe("parseBrandPage: JSON-LD", () => {
  it("reads @graph, arrays, logo as string or ImageObject, legalName and sameAs", () => {
    const ld = JSON.stringify({
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "WebPage", name: "Video services page" },
        { "@type": ["Organization", "Corporation"], name: "Acme", legalName: "Acme Pty Ltd", logo: { "@type": "ImageObject", url: "/img/acme-logo.png" }, sameAs: ["https://twitter.com/acme", "not a url"] },
        { "@type": "WebSite", name: "Acme Ads", publisher: { "@type": "Organization", name: "Acme", logo: "//cdn.acme-ads.example/mark.svg" } },
      ],
    });
    const ev = parseBrandPage(`<html><head><script type="application/ld+json">${ld}</script></head><body></body></html>`, PAGE);
    expect(ev.jsonLd.names).toEqual(
      expect.arrayContaining([
        { value: "Acme", type: "Organization" },
        { value: "Acme Pty Ltd", type: "Organization.legalName" },
        { value: "Acme Ads", type: "WebSite" },
      ]),
    );
    expect(ev.jsonLd.names.some((n) => n.value === "Video services page")).toBe(false);
    expect(ev.jsonLd.logos).toEqual(["https://www.acme-ads.example/img/acme-logo.png", "https://cdn.acme-ads.example/mark.svg"]);
    expect(ev.jsonLd.sameAs).toEqual(["https://twitter.com/acme"]);
    const jsonLogo = ev.logoCandidates.find((c) => c.url.endsWith("acme-logo.png"))!;
    expect(jsonLogo.role).toBe("company");
    expect(jsonLogo.provenance.source).toBe("page_jsonld");
    expect(jsonLogo.provenance.url).toBe(PAGE);
  });

  it("reads a top-level array and a bare Brand", () => {
    const ev = parseBrandPage(`<script type="application/ld+json">[{"@type":"Brand","name":"Zed"},{"@type":"LocalBusiness","name":"Zed Cafe","logo":["https://x.example/a.png"]}]</script>`, PAGE);
    expect(ev.jsonLd.names.map((n) => n.value)).toEqual(["Zed", "Zed Cafe"]);
    expect(ev.jsonLd.logos).toEqual(["https://x.example/a.png"]);
  });

  it("does not throw on malformed JSON-LD and still reads the good block", () => {
    const html = `<script type="application/ld+json">{ "@type": "Organization", "name": "Broken", }</script>
      <script type="application/ld+json">{ not json at all </script>
      <script type="application/ld+json">{"@type":"Organization","name":"Fine"}</script>`;
    expect(() => parseBrandPage(html, PAGE)).not.toThrow();
    const ev = parseBrandPage(html, PAGE);
    expect(ev.jsonLd.names.map((n) => n.value)).toContain("Fine");
  });

  it("survives garbage html", () => {
    expect(() => parseBrandPage("<<<div <a href=><img src='x' <svg", PAGE)).not.toThrow();
    expect(() => parseBrandPage("", PAGE)).not.toThrow();
  });
});

describe("parseBrandPage: which image is the company logo", () => {
  const html = `<html><head><title>Acme | Ads</title>
    <meta property="og:image" content="/share/cover.jpg">
    <meta name="twitter:image" content="https://cdn.example/tw.png">
    <link rel="icon" href="/favicon-32.png" sizes="32x32">
    <link rel="apple-touch-icon" href="/apple-180.png" sizes="180x180">
    </head><body>
    <header class="site-header">
      <a class="navbar-brand" href="/"><img src="/assets/acme-logo.svg" alt="Acme"></a>
      <nav><a href="/services">Services</a></nav>
      <img src="/img/google-partner-badge.png" alt="Google Partner" width="120" height="60">
    </header>
    <section class="hero"><img src="/img/hero-bg.jpg" alt=""></section>
    <section class="clients"><h2>Trusted by</h2>
      <div class="logo-strip">
        <img src="/clients/big-corp-logo.png" alt="Big Corp logo">
        <img src="/clients/other-logo.png" alt="Other Inc logo">
      </div>
    </section>
    <footer>
      <div class="footer-partners"><img src="/partners/meta-business-partner.png" alt="Meta Business Partner"></div>
      <img src="/assets/acme-footer-logo.png" alt="Acme">
      <img src="https://pixel.example/track.gif" width="1" height="1" alt="">
      <img src="javascript:alert(1)" alt="logo">
      <p>© 2026 Acme Pty Ltd. All rights reserved.</p>
    </footer></body></html>`;
  const ev = parseBrandPage(html, PAGE);
  const byUrl = (part: string) => ev.logoCandidates.find((c) => c.url.includes(part));

  it("picks the header home-link logo as the company logo, best score", () => {
    const top = ev.logoCandidates[0]!;
    expect(top.url).toBe("https://www.acme-ads.example/assets/acme-logo.svg");
    expect(top.role).toBe("company");
    expect(top.provenance.source).toBe("page_header");
    expect(top.provenance.detail).toMatch(/home link/);
    expect(top.rejectedReason).toBeUndefined();
  });
  it("never treats a Google Partner badge in the header as the company logo", () => {
    const badge = byUrl("google-partner-badge")!;
    expect(["partner", "badge"]).toContain(badge.role);
    expect(badge.rejectedReason).toMatch(/partner|badge/i);
    expect(company(ev).some((c) => c.url.includes("google-partner"))).toBe(false);
  });
  it("classifies the client strip as clients and the footer partner logo as a partner", () => {
    expect(byUrl("big-corp-logo")!.role).toBe("client");
    expect(byUrl("other-logo")!.role).toBe("client");
    expect(byUrl("meta-business-partner")!.role).toBe("partner");
  });
  it("accepts a footer logo whose alt matches the brand, but ranks it below the header logo", () => {
    const footer = byUrl("acme-footer-logo")!;
    expect(footer.role).toBe("company");
    expect(footer.provenance.source).toBe("page_footer");
    expect(footer.score).toBeLessThan(byUrl("acme-logo.svg")!.score);
  });
  it("does not choose og:image / twitter:image / favicons", () => {
    const og = byUrl("share/cover.jpg")!;
    expect(og.role).toBe("unknown");
    expect(og.score).toBeLessThan(20);
    expect(og.rejectedReason).toMatch(/share image/i);
    expect(byUrl("tw.png")!.role).toBe("unknown");
    const icon = byUrl("apple-180.png")!;
    expect(icon.role).toBe("icon");
    expect(icon.score).toBeLessThan(30);
    expect(company(ev).map((c) => c.url)).not.toContain("https://www.acme-ads.example/share/cover.jpg");
  });
  it("ignores tracking pixels, javascript: urls and the hero background", () => {
    expect(byUrl("track.gif")).toBeUndefined();
    expect(ev.logoCandidates.some((c) => c.url.startsWith("javascript:"))).toBe(false);
    expect(byUrl("hero-bg")).toBeUndefined();
  });
  it("gives every non-company candidate a rejectedReason", () => {
    for (const c of ev.logoCandidates) {
      if (c.role !== "company") expect(c.rejectedReason, c.url).toBeTruthy();
    }
  });
});

describe("parseBrandPage: urls and lazy loading", () => {
  it("resolves relative, protocol-relative, srcset (widest), lazy data-src and <picture> sources, honouring <base href>", () => {
    const html = `<html><head><base href="https://static.acme-ads.example/v2/"></head><body><header>
      <a href="https://www.acme-ads.example/"><img src="img/rel-logo.png" alt="Acme"></a>
    </header>
    <div class="site-logo"><img src="//cdn.acme-ads.example/proto-logo.webp?v=3" alt="Acme"></div>
    <div class="brand-logo"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="/lazy/lazy-logo.png" alt="Acme"></div>
    <div class="custom-logo"><img data-lazy-src="/lazy/lazy2-logo.svg" alt="Acme"></div>
    <div class="company-logo"><img data-original="/lazy/orig-logo.jpg" alt="Acme"></div>
    <div class="navbar-brand"><img src="small.png" srcset="small.png 1x, big-logo.png?x=1,2 3x, mid.png 2x" alt="Acme"></div>
    <div class="main-logo"><img data-srcset="a-300.png 300w, a-900.png 900w, a-600.png 600w" alt="Acme"></div>
    <div class="header-logo"><picture><source srcset="dark.png 1x" media="(prefers-color-scheme: dark)"><source srcset="pic-1x.webp 1x, pic-2x.webp 2x" type="image/webp"><img src="pic-fallback.png" alt="Acme"></picture></div>
    </body></html>`;
    const ev = parseBrandPage(html, "https://www.acme-ads.example/");
    const urls = ev.logoCandidates.map((c) => c.url);
    expect(urls).toContain("https://static.acme-ads.example/v2/img/rel-logo.png");
    expect(urls).toContain("https://cdn.acme-ads.example/proto-logo.webp?v=3");
    expect(urls).toContain("https://static.acme-ads.example/lazy/lazy-logo.png");
    expect(urls).toContain("https://static.acme-ads.example/lazy/lazy2-logo.svg");
    expect(urls).toContain("https://static.acme-ads.example/lazy/orig-logo.jpg");
    expect(urls).toContain("https://static.acme-ads.example/v2/big-logo.png?x=1,2");
    expect(urls).toContain("https://static.acme-ads.example/v2/a-900.png");
    expect(urls).toContain("https://static.acme-ads.example/v2/pic-2x.webp");
    expect(urls.some((u) => u.startsWith("data:image/gif"))).toBe(false);
    expect(urls).not.toContain("https://static.acme-ads.example/v2/dark.png");
    for (const u of urls) expect(u).toMatch(/^https:\/\//);
  });

  it("parses srcset with commas inside urls", () => {
    expect(parseSrcset("https://c.example/w_100,h_50/a.png 100w, https://c.example/w_400,h_200/a.png 400w")).toEqual([
      { url: "https://c.example/w_100,h_50/a.png", weight: 100 },
      { url: "https://c.example/w_400,h_200/a.png", weight: 400 },
    ]);
  });

  it("accepts svg, png, webp, jpg and gif urls with query strings and data uris", () => {
    const dataPng = "data:image/png;base64," + Buffer.from("x".repeat(600)).toString("base64");
    const html = `<header><a href="/"><img src="${dataPng}" alt="Acme"></a></header>
      <div class="logo"><img src="https://x.example/a.gif?w=300" alt="Acme"></div>
      <div class="site-logo"><img src="https://x.example/b.jpg?cb=1#frag" alt="Acme"></div>`;
    const ev = parseBrandPage(html, PAGE);
    expect(ev.logoCandidates.map((c) => c.url)).toEqual(expect.arrayContaining([dataPng, "https://x.example/a.gif?w=300", "https://x.example/b.jpg?cb=1"]));
  });
});

describe("parseBrandPage: inline svg and css", () => {
  it("turns an inline svg logo in the header home link into a data uri candidate", () => {
    const ev = parseBrandPage(`<header><a href="/" class="logo">${svgMark}</a></header>`, PAGE);
    const c = ev.logoCandidates.find((x) => x.url.startsWith("data:image/svg+xml;utf8,"))!;
    expect(c.role).toBe("company");
    expect(c.provenance.source).toBe("page_header");
    const decoded = decodeURIComponent(c.url.replace("data:image/svg+xml;utf8,", ""));
    expect(decoded).toContain("xmlns=\"http://www.w3.org/2000/svg\"");
    expect(decoded).toContain("<path");
    expect(ev.headerBrandTexts.map((h) => h.text)).toContain("Acme");
  });

  it("skips an inline svg that is too large, a social icon, or only a <use> reference", () => {
    const big = `<svg viewBox="0 0 10 10">${"<path d='M0 0L1 1'/>".repeat(2000)}</svg>`;
    const ev = parseBrandPage(
      `<header><a href="/">${big}</a><a href="https://twitter.com/x" class="social-icon"><svg viewBox="0 0 24 24" width="24" height="24"><path d="M1 1L9 9L1 9Z"/></svg></a><a class="logo" href="/"><svg viewBox="0 0 10 10"><use href="#sprite-logo"></use></svg></a></header>`,
      PAGE,
    );
    expect(ev.logoCandidates.filter((c) => c.url.startsWith("data:image/svg+xml"))).toHaveLength(0);
  });

  it("finds a css background-image logo in opts.css and in inline style", () => {
    const css = `/* c */ .nav .site-logo { background-image: url("/img/css-logo.svg"); width: 120px }
      @media (max-width: 600px) { .navbar-brand { background: transparent url(mobile-brand.png) no-repeat } }
      .client-logo { background-image: url('/img/client.png') }
      .hero { background-image: url(/img/hero.jpg) }
      .footer .logo { background-image: url(/img/footer-css.png) }`;
    const html = `<body><header><div class="brand" style="background-image:url('/img/inline-brand.png')"></div></header></body>`;
    const ev = parseBrandPage(html, PAGE, { css });
    const find = (p: string) => ev.logoCandidates.find((c) => c.url.includes(p));
    expect(find("css-logo.svg")!.role).toBe("company");
    expect(find("css-logo.svg")!.provenance.source).toBe("page_css");
    expect(find("css-logo.svg")!.provenance.detail).toMatch(/\.nav \.site-logo/);
    expect(find("mobile-brand.png")!.role).toBe("company");
    expect(find("client.png")!.role).toBe("client");
    expect(find("hero.jpg")).toBeUndefined();
    expect(find("footer-css.png")!.score).toBeLessThan(find("css-logo.svg")!.score);
    expect(find("inline-brand.png")!.role).toBe("company");
  });

  it("merges the same url found twice and keeps the best score", () => {
    const ld = `{"@type":"Organization","name":"Acme","logo":"https://www.acme-ads.example/assets/acme-logo.svg"}`;
    const ev = parseBrandPage(`<script type="application/ld+json">${ld}</script><header><a href="/"><img src="/assets/acme-logo.svg" alt="Acme"></a></header>`, PAGE);
    const same = ev.logoCandidates.filter((c) => c.url.endsWith("acme-logo.svg"));
    expect(same).toHaveLength(1);
    expect(same[0]!.provenance.detail).toMatch(/also found as/);
    expect(same[0]!.score).toBeGreaterThan(85);
  });
});
