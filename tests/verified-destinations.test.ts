import { describe, expect, it } from "vitest";
import {
  buildAllowedUrlsMarker,
  buildVerifiedDestinationsMarker,
  destinationsWereFetched,
  enforceVerifiedDestinations,
  readAllowedUrlsMarker,
  readVerifiedDestinationsMarker,
  stripDestinationMarkers,
} from "@/lib/landing/verified-destinations";

describe("verified destinations markers", () => {
  it("round-trips verified and allowed URLs through evidence text", () => {
    const evidence = [
      buildVerifiedDestinationsMarker([
        "https://googleaudit.trafficradius.com.au/landing",
      ]),
      buildAllowedUrlsMarker(["https://competitor.example/lp"]),
      "### Ad CTA & destination inventory",
    ].join("\n");

    expect(readVerifiedDestinationsMarker(evidence)).toEqual([
      "https://googleaudit.trafficradius.com.au/landing",
    ]);
    expect(readAllowedUrlsMarker(evidence)).toEqual([
      "https://competitor.example/lp",
    ]);
  });

  it("records a fetch with no destinations as `none`", () => {
    const marker = buildVerifiedDestinationsMarker([]);
    expect(marker).toContain("none");
    expect(readVerifiedDestinationsMarker(marker)).toEqual([]);
    expect(destinationsWereFetched(marker)).toBe(true);
    expect(destinationsWereFetched("no markers here")).toBe(false);
  });

  it("strips markers from reply text", () => {
    const text = `${buildVerifiedDestinationsMarker([
      "https://brand.test/lp",
    ])}\nAudit body`;
    expect(stripDestinationMarkers(text)).toBe("Audit body");
  });
});

describe("enforceVerifiedDestinations", () => {
  const verified = ["https://googleaudit.trafficradius.com.au/landing"];

  it("replaces a same-domain URL the reply passes off as the destination", () => {
    const result = enforceVerifiedDestinations(
      "Destination URL (from Meta creative): https://googleconsult.trafficradius.com.au/",
      { verified },
    );
    expect(result.text).toContain(
      "https://googleaudit.trafficradius.com.au/landing",
    );
    expect(result.text).not.toContain("googleconsult");
    expect(result.replaced).toHaveLength(1);
  });

  it("replaces an off-domain URL claimed as the landing page", () => {
    const result = enforceVerifiedDestinations(
      "The landing page for this campaign is https://random-doc-url.example/page and it converts poorly.",
      { verified },
    );
    expect(result.text).toContain(
      "https://googleaudit.trafficradius.com.au/landing",
    );
  });

  it("leaves verified and operator-supplied URLs untouched", () => {
    const text = [
      "Destination: https://googleaudit.trafficradius.com.au/landing",
      "Competitor landing page: https://competitor.example/lp",
    ].join("\n");
    const result = enforceVerifiedDestinations(text, {
      verified,
      allowed: ["https://competitor.example/lp"],
    });
    expect(result.text).toBe(text);
    expect(result.replaced).toHaveLength(0);
  });

  it("ignores unrelated links that are not presented as destinations", () => {
    const text = "Docs: https://developers.facebook.com/docs/marketing-apis";
    const result = enforceVerifiedDestinations(text, { verified });
    expect(result.text).toBe(text);
  });

  it("is a no-op when no destination fetch happened", () => {
    const text = "Destination: https://googleconsult.trafficradius.com.au/";
    expect(enforceVerifiedDestinations(text, { verified: [] }).text).toBe(text);
  });

  it("replaces a claimed destination with an honest note when Meta had none", () => {
    const result = enforceVerifiedDestinations(
      "Destination URL (from Meta creative): https://googleconsult.trafficradius.com.au/",
      { verified: [], fetched: true },
    );
    expect(result.text).not.toContain("googleconsult");
    expect(result.text).toContain("Destination → Website URL in Ads Manager");
  });
});
