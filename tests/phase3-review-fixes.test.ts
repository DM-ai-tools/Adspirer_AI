import { describe, expect, it } from "vitest";
import { fetchPageChecks } from "@/lib/landing/inspect";
import { analyzeLandingPage } from "@/lib/landing/analyze-page";
import { assertPublicUrl } from "@/lib/security/public-url";
import { evaluateCheckpoints } from "@/lib/audit/checkpoints";
import { demoMetaAuditSnapshot } from "@/lib/audit/meta-audit-data";
import { renderAdSetEvidence } from "@/lib/audit/render";

const noGuard = async () => {};
const respond = (status: number, body = "") => (async () => new Response(body, { status })) as unknown as typeof fetch;
const page = "# Implants\nRated 4.9 by 300 patients. Book your consult today with our team of specialists in Sydney.";

describe("landing checks: blocked is not broken", () => {
  const deps = (status: number) => ({
    scrape: async () => ({ url: "https://x.com", title: "X", markdown: page, services: [], source: "fetch" as const }),
    checks: async () => ({ status, redirects: 0, https: true, keepsTracking: false, finalUrl: "https://x.com", html: "" }),
    pageSpeed: async () => null,
    judgeMatch: async () => "partial" as const,
  });

  it("reports a 403 or 429 as our check being blocked, not a broken page", async () => {
    for (const status of [403, 429]) {
      const r = await analyzeLandingPage({ url: "https://x.com", role: "own", adContext: "Book implants" }, deps(status));
      expect(r.score100).not.toBe(0);
      expect(r.messageMatch).toBe("partial");
      expect(r.findings.join("\n")).toMatch(new RegExp(`blocked our check \\(HTTP ${status}\\)`));
    }
  });

  it("calls a 404 broken only when the page text couldn't be read either", async () => {
    const readable = await analyzeLandingPage({ url: "https://x.com", role: "own" }, deps(404));
    expect(readable.score100).not.toBe(0);
    const dead = await analyzeLandingPage(
      { url: "https://x.com", role: "own" },
      { ...deps(404), scrape: async () => ({ url: "https://x.com", title: undefined, markdown: "Not found", services: [], source: "fetch" as const }) },
    );
    expect(dead.score100).toBe(0);
  });

  it("normalises a URL without a scheme", async () => {
    const r = await fetchPageChecks("example.com/lp", respond(200, "<html></html>"), noGuard);
    expect(r.status).toBe(200);
    expect(r.finalUrl).toMatch(/^https:\/\/example\.com\/lp\?/);
  });
});

describe("assertPublicUrl (no requests to internal addresses)", () => {
  const lookup = (address: string) => async () => [{ address, family: address.includes(":") ? 6 : 4 }];
  it("refuses private, loopback, link-local and non-http targets", async () => {
    await expect(assertPublicUrl("http://169.254.169.254/latest", lookup("169.254.169.254"))).rejects.toThrow(/not a public address/);
    await expect(assertPublicUrl("http://intranet.local", lookup("10.0.0.5"))).rejects.toThrow(/not a public address/);
    await expect(assertPublicUrl("http://localhost:3000", lookup("127.0.0.1"))).rejects.toThrow(/not a public address/);
    await expect(assertPublicUrl("http://v6.example", lookup("::1"))).rejects.toThrow(/not a public address/);
    await expect(assertPublicUrl("file:///etc/passwd", lookup("1.1.1.1"))).rejects.toThrow(/http/);
    await expect(assertPublicUrl("https://example.com", lookup("93.184.216.34"))).resolves.toBeUndefined();
  });

  it("is applied on every redirect hop", async () => {
    let hop = 0;
    const redirecting = (async () => {
      hop += 1;
      return new Response("", { status: 302, headers: { location: "http://169.254.169.254/" } });
    }) as unknown as typeof fetch;
    const guard = async (url: string) => {
      if (url.includes("169.254")) throw new Error("169.254.169.254 is not a public address");
    };
    const r = await fetchPageChecks("https://example.com", redirecting, guard);
    expect(hop).toBe(1);
    expect(r.status).toBe(0);
  });
});

describe("audit: video rates only on ad rows; C5 and C4 judged on the right data", () => {
  it("doesn't print hold rate on campaign or total rows that have no ThruPlay data", () => {
    const snap = demoMetaAuditSnapshot("act_1", "Demo", 7);
    snap.totals = { ...snap.totals!, videoViews3s: 5000, thruplays: null };
    snap.campaigns[0]!.performance = { ...snap.campaigns[0]!.performance!, videoViews3s: 5000, thruplays: null };
    const text = renderAdSetEvidence({ ...snap, previousPeriod: undefined });
    expect(text).not.toMatch(/hold rate 0%/);
    expect(text.split("\n").filter((l) => /^Campaign period:|^Totals:/.test(l)).join("\n")).not.toMatch(/hook rate/);
  });

  it("C5 only checks ads that send people to a website, and accepts UTMs in the link", () => {
    const snap = demoMetaAuditSnapshot("act_1", "Demo", 7);
    snap.adSets = snap.adSets.map((a) => (a.id === "as_4" ? { ...a, optimizationGoal: "LEAD_GENERATION", pixelId: null } : a));
    snap.ads = snap.ads.map((a) => ({
      ...a,
      urlTags: null,
      linkUrl: a.id === "ad_6" ? null : `https://example.com/lp?utm_source=facebook&ad=${a.id}`,
    }));
    const c5 = evaluateCheckpoints(snap).checkpoints.find((c) => c.id === "C5")!;
    expect(c5.status).toBe("pass"); // ad_6 is a lead-form ad: not judged
  });

  it("C4 uses each ad's 7-day frequency, never the whole period's", () => {
    const snap = demoMetaAuditSnapshot("act_1", "Demo", 30);
    snap.ads = snap.ads.map((a) =>
      a.performance ? { ...a, performance: { ...a.performance, frequency: 5, linkCtr: 0.5 }, frequency7d: a.id === "ad_2" ? 3.4 : 1.8 } : a,
    );
    const c4 = evaluateCheckpoints(snap).checkpoints.find((c) => c.id === "C4")!;
    expect(c4.evidence).toMatch(/Implants – Doctor intro/);
    expect(c4.evidence).not.toMatch(/Before\/After/);
    const unknown = demoMetaAuditSnapshot("act_1", "Demo", 30);
    unknown.ads = unknown.ads.map((a) => (a.performance ? { ...a, performance: { ...a.performance, frequency: 5, linkCtr: 0.5 } } : a));
    expect(evaluateCheckpoints(unknown).checkpoints.find((c) => c.id === "C4")).toBeUndefined();
  });
});

describe("landing time budget", () => {
  it("gives up on slow checks after the per-page deadline instead of stalling the audit", async () => {
    const slow = () => new Promise<never>(() => {});
    const started = Date.now();
    const r = await analyzeLandingPage(
      { url: "https://x.com", role: "own" },
      {
        scrape: async () => ({ url: "https://x.com", title: "X", markdown: page, services: [], source: "fetch" }),
        checks: slow,
        pageSpeed: slow,
        judgeMatch: async () => "unknown",
        deadlineMs: 200,
      },
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r.findings.join("\n")).toMatch(/not measured/);
  });
});
