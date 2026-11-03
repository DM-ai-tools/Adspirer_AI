import { describe, expect, it } from "vitest";
import { extractLogoFromHtml } from "@/lib/brand/html-logo";
import { sameLandingPage } from "@/lib/creatives/landing";
import { directionWithText } from "@/lib/creatives/concept-writer";
import { buildBrandImagePrompt } from "@/lib/creatives/openai-image";

// Markup copied from the two real landing pages: the header logo and the customer-logo strips.
const SCALE_PAGE = `<html><head><title>Traffic Radius</title></head><body>
<header class="nav" id="nav"><div class="nav-in"><img alt="Traffic Radius" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAggA"/>
<nav class="nav-links"></nav></div></header>
<main id="top"><section class="hero"><img alt="Google Ads dashboard: $220K cost" src="data:image/jpeg;base64,/9j/4AAQ"/></section>
<section><div class="logo-cell"><img alt="MJ Printing - Traffic Radius client" src="data:image/png;base64,AAAA"/></div></section></main></body></html>`;

const AUDIT_PAGE = `<html><body><header class="site-header"><a href="/">
<img class="brand-logo" src="https://assets.cdn.example/media/logo.png" alt="TrafficRadius" width="170" height="35"></a></header>
<section class="trust-bar"><div class="logo-item"><img src="https://x.example/1-1.png" alt="Client logo"></div></section></body></html>`;

describe("finding a site's own logo", () => {
  it("takes the header image whose alt is the brand name", () => {
    expect(extractLogoFromHtml(SCALE_PAGE, "https://scale.example/", "Traffic Radius")).toMatch(/^data:image\/png;base64,iVBOR/);
  });

  it("takes an image marked as the brand logo and resolves it against the page", () => {
    expect(extractLogoFromHtml(AUDIT_PAGE, "https://audit.example/", "TrafficRadius")).toBe("https://assets.cdn.example/media/logo.png");
    const relative = `<header><img class="site-logo" src="/img/logo.svg" alt=""></header>`;
    expect(extractLogoFromHtml(relative, "https://shop.example/page", null)).toBe("https://shop.example/img/logo.svg");
  });

  it("never takes a customer-logo strip or a content image", () => {
    const strips = `<body><section><div class="logo-cell"><img alt="Acme - client" src="/a.png"></div></section><main><img alt="Hero" src="/hero.jpg"></main></body>`;
    expect(extractLogoFromHtml(strips, "https://x.example/", "Acme")).toBeNull();
  });

  it("uses the logo a site declares in structured data", () => {
    const ld = `<script type="application/ld+json">{"@type":"Organization","logo":{"url":"https://x.example/brand.png"}}</script>`;
    expect(extractLogoFromHtml(ld, "https://x.example/", null)).toBe("https://x.example/brand.png");
  });
});

describe("same landing page", () => {
  it("ignores www, case, trailing slash, query and hash", () => {
    expect(sameLandingPage("https://www.Shop.com/Sofas/?utm=1#top", "shop.com/sofas")).toBe(true);
  });
  it("tells different pages and subdomains apart", () => {
    expect(sameLandingPage("https://googlescale.trafficradius.com.au/", "https://googleaudit.trafficradius.com.au/")).toBe(false);
    expect(sameLandingPage("https://a.com/x", "https://a.com/y")).toBe(false);
    expect(sameLandingPage(null, "https://a.com")).toBe(false);
  });
});

describe("words on the image", () => {
  const text = { headline: "Free Google Ads Audit", highlights: ["$120M+ tracked", "15+ years"], cta_label: "Get My Free Audit" };

  it("appends the on-image text to the art direction", () => {
    const direction = directionWithText("Dark desk, glowing dashboard.", text);
    expect(direction).toContain('headline "Free Google Ads Audit"');
    expect(direction).toContain('highlighted keywords "$120M+ tracked", "15+ years"');
    expect(direction).toContain('call-to-action button "Get My Free Audit"');
    expect(directionWithText("Plain.", undefined)).toBe("Plain.");
  });

  it("tells the image model to typeset exactly that text, with a button, and nothing else", () => {
    const prompt = buildBrandImagePrompt({
      brandName: "Traffic Radius",
      serviceName: "Google Ads audit",
      creativeDirection: directionWithText("Dark desk.", text),
      headline: "Free audit",
      colors: ["#37ca37", "#188bf6"],
    });
    expect(prompt).toContain("ON-IMAGE TEXT");
    expect(prompt).toContain("call-to-action as a solid rounded button");
    expect(prompt).toContain("Put no other words on the image");
    expect(prompt).not.toContain("small illegible text");
  });

  it("adds no text rules when the direction carries no on-image text", () => {
    const prompt = buildBrandImagePrompt({ brandName: "X", serviceName: "Y", creativeDirection: "Plain." });
    expect(prompt).not.toContain("TEXT ON THE IMAGE");
  });
});
