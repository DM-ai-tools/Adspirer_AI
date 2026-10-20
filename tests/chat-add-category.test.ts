import { afterEach, describe, expect, it, vi } from "vitest";
import { gatherDiagnoseEvidence, runAdspirerAgent } from "@/lib/agent/adspirer-agent";
import { createTask } from "@/lib/agent/task-runner";
import { detectRequestIntent } from "@/lib/agent/task-plan";
import { getDemoStore, resetDemoStore } from "@/lib/demo/store";
import { scanSiteCandidates } from "@/lib/scraping/site-scan";
import type { CategoryCandidate } from "@/lib/scraping/site-map";
import { categoriesFromServices } from "@/lib/strategy/categories";
import {
  cachedSiteScan,
  pickCandidateForRequest,
  requestedCategoryPhrase,
  resetSiteScanCache,
  resolveRequestedCategory,
} from "@/lib/strategy/requested-category";

// The website scan is slow and external; every test here says what it returns.
vi.mock("@/lib/scraping/site-scan", () => ({ scanSiteCandidates: vi.fn() }));

const CT = "client_clicktrends";
const SITE = "https://clicktrends.example";
const STRATEGY_ASK = "How do we spend $4k and get $40k back on bar stools using Google Ads and Meta together?";
const SPEND_ASK = "How much has gone into bar stools, what did it return, and what was the best category in the last 30 days?";
const candidate = (name: string, slug: string): CategoryCandidate => ({
  name,
  landing_page_url: `${SITE}/collections/${slug}`,
  alreadyAdded: false,
});
const BAR_STOOLS = candidate("Bar Stools", "bar-stools");
const BLACK_BAR_STOOLS = candidate("Black Bar Stools", "black-bar-stools");
const ADJUSTABLE_BAR_STOOLS = candidate("Adjustable Bar Stools", "adjustable-bar-stools");
const SOFAS = candidate("Sofas", "sofas");
const ADDED_LINE =
  `Added **Bar Stools** (${SITE}/collections/bar-stools) as a category for ClickTrends. ` +
  `Set its margin on the Services tab, or tell me ("bar stools margin is 45%"), for sharper targets.`;

afterEach(() => {
  resetDemoStore();
  resetSiteScanCache();
  vi.mocked(scanSiteCandidates).mockReset();
  vi.restoreAllMocks();
});

/**
 * ClickTrends with no categories set up, and a scan that returns `candidates`.
 * Its GA4 and Search Console are unmapped, so these tests take the website
 * scan path (Google comes first: tests/google-category-candidates.test.ts).
 */
function noCategories(candidates: CategoryCandidate[]) {
  const store = getDemoStore();
  store.clientServices = store.clientServices.filter((s) => s.client_id !== CT);
  for (const asset of store.googleAssets) if (asset.mapped_client_id === CT) asset.mapped_client_id = null;
  vi.mocked(scanSiteCandidates).mockResolvedValue({ candidates, source: "firecrawl" });
}

const ctServices = () => getDemoStore().clientServices.filter((s) => s.client_id === CT);

describe("requestedCategoryPhrase", () => {
  it("reads the words after on/for/into up to using/with/at/over/in the/punctuation", () => {
    expect(requestedCategoryPhrase(STRATEGY_ASK, "strategy")).toBe("bar stools");
    expect(requestedCategoryPhrase("Build a plan for dining chairs with a $300/day budget", "strategy")).toBe("dining chairs");
    expect(requestedCategoryPhrase("Plan 8x ROAS on the outdoor sofas over Q4", "strategy")).toBe("outdoor sofas");
    expect(requestedCategoryPhrase("Scale spend on bar stools in the next month", "strategy")).toBe("bar stools");
    expect(requestedCategoryPhrase("how much has gone into bar stools", "spend")).toBe("bar stools");
    expect(requestedCategoryPhrase("What have we spent on bar stools?", "spend")).toBe("bar stools");
  });

  it("finds nothing when the words name money, a period or a channel", () => {
    expect(requestedCategoryPhrase("Plan to hit 10x ROAS on $500/day", "strategy")).toBeNull();
    expect(requestedCategoryPhrase("Build me a strategy", "strategy")).toBeNull();
    expect(requestedCategoryPhrase("Plan for the next 30 days", "strategy")).toBeNull();
    expect(requestedCategoryPhrase("Plan a strategy for Q4 on bar stools", "strategy")).toBe("bar stools");
    expect(requestedCategoryPhrase("How much have we spent on Meta this month?", "spend")).toBeNull();
    expect(requestedCategoryPhrase("How much have we spent on ads?", "spend")).toBeNull();
  });

  it("ends the phrase at a period word", () => {
    expect(requestedCategoryPhrase("How much have we spent on bar stools last month?", "spend")).toBe("bar stools");
    expect(requestedCategoryPhrase("spent on bar stools this week", "spend")).toBe("bar stools");
    expect(requestedCategoryPhrase("spent on bar stools in March", "spend")).toBe("bar stools");
    expect(requestedCategoryPhrase("spent on bar stools during the sale", "spend")).toBe("bar stools");
    expect(requestedCategoryPhrase("spent on bar stools since June", "spend")).toBe("bar stools");
    expect(requestedCategoryPhrase("spent on bar stools vs sofas", "spend")).toBe("bar stools");
    expect(requestedCategoryPhrase("spent on bar stools versus sofas", "spend")).toBe("bar stools");
    expect(requestedCategoryPhrase("spent on bar stools compared to sofas", "spend")).toBe("bar stools");
  });

  it("skips common terms that aren't categories", () => {
    for (const ask of [
      "How much have we spent on retargeting?",
      "How much have we spent on Black Friday?",
      "spent on new customers",
      "spent on Advantage+ campaigns",
      "spent on reels",
      "spent on stories",
      "spent on brand campaigns",
      "spent on lookalikes",
      "spent on prospecting",
      "spent on leads",
      "spent on sales",
      "spent on growth",
    ]) {
      expect(requestedCategoryPhrase(ask, "spend"), ask).toBeNull();
    }
  });

  it("needs a spend word before on/into for a category-spend ask", () => {
    expect(requestedCategoryPhrase("Which ads are on bar stools?", "spend")).toBeNull();
    expect(requestedCategoryPhrase("What was the best category last month?", "spend")).toBeNull();
  });
});

describe("pickCandidateForRequest", () => {
  const all = [BLACK_BAR_STOOLS, ADJUSTABLE_BAR_STOOLS, candidate("Stools", "stools"), BAR_STOOLS, SOFAS];

  it("picks the longest name the request contains, never a longer one it doesn't", () => {
    expect(pickCandidateForRequest(STRATEGY_ASK, all)).toEqual(BAR_STOOLS);
    expect(pickCandidateForRequest("how much has gone into bar stools", all)).toEqual(BAR_STOOLS);
  });

  it("is whole-word, case-insensitive and plural-tolerant", () => {
    expect(pickCandidateForRequest("plan for a BAR STOOL push", all)).toEqual(BAR_STOOLS);
    expect(pickCandidateForRequest("plan for sofa sales", all)).toEqual(SOFAS);
    expect(pickCandidateForRequest("plan for barstools", all)).toBeNull();
    expect(pickCandidateForRequest("plan for footstools", [candidate("Stools", "stools")])).toBeNull();
  });

  it("matches -ies names with their -ie and -y singulars", () => {
    const hoodies = candidate("Hoodies", "hoodies");
    expect(pickCandidateForRequest("plan for a hoodie push", [hoodies])).toEqual(hoodies);
    const accessories = candidate("Accessories", "accessories");
    expect(pickCandidateForRequest("plan for accessory sales", [accessories])).toEqual(accessories);
    const cookies = candidate("Cookies", "cookies");
    expect(pickCandidateForRequest("plan for cookies", [cookies])).toEqual(cookies);
    expect(pickCandidateForRequest("plan for a cookie box", [cookies])).toEqual(cookies);
  });

  it("doesn't treat 's as a plural, and matches -ies with -y", () => {
    const mens = candidate("Men's Shoes", "mens-shoes");
    expect(pickCandidateForRequest("plan for men's shoes", [mens])).toEqual(mens);
    expect(pickCandidateForRequest("plan for men\u2019s shoe sales", [mens])).toEqual(mens);
    expect(pickCandidateForRequest("plan for men shoes", [mens])).toBeNull();
    const acc = candidate("Accessories", "accessories");
    expect(pickCandidateForRequest("plan for accessory sales", [acc])).toEqual(acc);
    const one = candidate("Accessory", "accessory");
    expect(pickCandidateForRequest("plan for accessories", [one])).toEqual(one);
  });

  it("never picks a generic collection", () => {
    for (const name of ["All", "Sale", "Sales", "New", "New Arrivals", "Frontpage", "Home", "Best Sellers", "Best-Sellers", "All Products", "Shop All"]) {
      expect(pickCandidateForRequest(`plan for ${name.toLowerCase()} today`, [candidate(name, "x")]), name).toBeNull();
    }
  });

  it("gives null when no candidate's name is in the request", () => {
    expect(pickCandidateForRequest("plan for dining chairs", all)).toBeNull();
    expect(pickCandidateForRequest("plan for dining chairs", [])).toBeNull();
  });
});

describe("resolveRequestedCategory", () => {
  it("uses a loaded category without scanning", async () => {
    const loaded = categoriesFromServices(getDemoStore().clientServices.filter((s) => s.client_id === CT));
    const scan = vi.fn();
    const out = await resolveRequestedCategory({ request: STRATEGY_ASK, loaded, kind: "strategy", scan });
    expect(out).toEqual({ kind: "loaded" });
    expect(scan).not.toHaveBeenCalled();
  });

  it("doesn't scan when the request names no category", async () => {
    const scan = vi.fn();
    const out = await resolveRequestedCategory({ request: "Plan to hit 10x ROAS on $500/day", loaded: [], kind: "strategy", scan });
    expect(out).toEqual({ kind: "none" });
    expect(scan).not.toHaveBeenCalled();
  });

  it("matches a scanned candidate, or says what it couldn't find", async () => {
    const scan = vi.fn().mockResolvedValue({ candidates: [BLACK_BAR_STOOLS, BAR_STOOLS], source: "firecrawl" });
    expect(await resolveRequestedCategory({ request: STRATEGY_ASK, loaded: [], kind: "strategy", scan })).toEqual({
      kind: "matched",
      phrase: "bar stools",
      candidate: BAR_STOOLS,
    });
    scan.mockResolvedValue({ candidates: [BLACK_BAR_STOOLS], source: "firecrawl" });
    expect(await resolveRequestedCategory({ request: STRATEGY_ASK, loaded: [], kind: "strategy", scan })).toEqual({
      kind: "not_found",
      phrase: "bar stools",
    });
  });
});

describe("resolveRequestedCategory picks only the category the phrase names", () => {
  const resolve = (request: string, candidates: CategoryCandidate[]) =>
    resolveRequestedCategory({
      request,
      loaded: [],
      kind: "strategy",
      scan: vi.fn().mockResolvedValue({ candidates, source: "firecrawl" }),
    });
  const ALL = candidate("All", "all");

  it("doesn't add All for 'using all our channels'", async () => {
    const ask = "How do we spend $4k on dining chairs using all our channels?";
    expect(await resolve(ask, [ALL, SOFAS])).toEqual({ kind: "not_found", phrase: "dining chairs" });
    const chairs = candidate("Dining Chairs", "dining-chairs");
    expect(await resolve(ask, [ALL, chairs, SOFAS])).toEqual({ kind: "matched", phrase: "dining chairs", candidate: chairs });
  });

  it("picks Stools, not Outdoor Kitchen, for 'on stools for the outdoor kitchen'", async () => {
    const stools = candidate("Stools", "stools");
    const kitchen = candidate("Outdoor Kitchen", "outdoor-kitchen");
    expect(await resolve("Plan 5x ROAS on stools for the outdoor kitchen", [kitchen, stools])).toEqual({
      kind: "matched",
      phrase: "stools",
      candidate: stools,
    });
  });

  it("doesn't add Sale for 'grow sales for patio sets'", async () => {
    expect(await resolve("Plan to grow sales for patio sets", [candidate("Sale", "sale"), SOFAS])).toEqual({
      kind: "not_found",
      phrase: "patio sets",
    });
  });

  it("still finds a name the phrase was cut short of ('tables and chairs')", async () => {
    const both = candidate("Tables and Chairs", "tables-and-chairs");
    expect(await resolve("Plan 6x ROAS for tables and chairs", [candidate("Tables", "tables"), both])).toEqual({
      kind: "matched",
      phrase: "tables",
      candidate: both,
    });
  });

  it("doesn't scan for the client's own name", async () => {
    const scan = vi.fn();
    for (const request of ["Build a 10x plan for During Days", "Build a 10x plan for during days furniture"]) {
      expect(await resolveRequestedCategory({ request, loaded: [], kind: "strategy", scan, clientName: "During Days" })).toEqual({ kind: "none" });
    }
    expect(scan).not.toHaveBeenCalled();
  });

  it("says a switched-off category is off, without scanning", async () => {
    const scan = vi.fn();
    const off = { ...getDemoStore().clientServices.find((s) => s.id === "svc_ct_bar_stools")!, is_active: false };
    expect(await resolveRequestedCategory({ request: STRATEGY_ASK, loaded: [], kind: "strategy", scan, switchedOff: [off] })).toEqual({
      kind: "switched_off",
      service: off,
    });
    expect(scan).not.toHaveBeenCalled();
  });
});

describe("cachedSiteScan", () => {
  it("scans a client's site once per 24 hours", async () => {
    vi.mocked(scanSiteCandidates).mockResolvedValue({ candidates: [BAR_STOOLS], source: "firecrawl" });
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    await cachedSiteScan(CT, SITE, []);
    now.mockReturnValue(1_000_000 + 23 * 3_600_000);
    expect((await cachedSiteScan(CT, SITE, [])).candidates).toEqual([BAR_STOOLS]);
    expect(scanSiteCandidates).toHaveBeenCalledTimes(1);
    // Another site for the same client is its own entry.
    await cachedSiteScan(CT, "https://other.example", []);
    expect(scanSiteCandidates).toHaveBeenCalledTimes(2);
    now.mockReturnValue(1_000_000 + 25 * 3_600_000);
    await cachedSiteScan(CT, SITE, []);
    expect(scanSiteCandidates).toHaveBeenCalledTimes(3);
  });

  it("doesn't remember a failed scan", async () => {
    vi.mocked(scanSiteCandidates).mockResolvedValue({ candidates: [], source: "unavailable", reason: "scan_failed" });
    await cachedSiteScan(CT, SITE, []);
    await cachedSiteScan(CT, SITE, []);
    expect(scanSiteCandidates).toHaveBeenCalledTimes(2);
  });
});

describe("strategy ask for a category that isn't set up (DEMO_MODE)", () => {
  it("adds Bar Stools from the site scan, says so, and plans on it", async () => {
    noCategories([BAR_STOOLS, BLACK_BAR_STOOLS]);
    const gathered = await gatherDiagnoseEvidence({ clientId: CT, request: STRATEGY_ASK, intent: "strategy" });

    const added = ctServices();
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      name: "Bar Stools",
      landing_page_url: `${SITE}/collections/bar-stools`,
      source: "site_scan",
      is_active: true,
    });
    expect(gathered.evidence).toContain(ADDED_LINE);
    expect(gathered.evidence).toContain("- Planned only for: Bar Stools");
    expect(gathered.strategyPlanBuilt).toBe(true);
    expect(scanSiteCandidates).toHaveBeenCalledWith(expect.objectContaining({ siteUrl: SITE }));
  });

  it("doesn't scan again on the next question", async () => {
    noCategories([SOFAS]);
    await gatherDiagnoseEvidence({ clientId: CT, request: STRATEGY_ASK, intent: "strategy" });
    await gatherDiagnoseEvidence({ clientId: CT, request: STRATEGY_ASK, intent: "strategy" });
    expect(scanSiteCandidates).toHaveBeenCalledTimes(1);
  });

  it("adds nothing and says what it couldn't find when the site has no such category", async () => {
    noCategories([BLACK_BAR_STOOLS, SOFAS]);
    const gathered = await gatherDiagnoseEvidence({ clientId: CT, request: STRATEGY_ASK, intent: "strategy" });
    expect(ctServices()).toEqual([]);
    expect(gathered.evidence).toContain(`Couldn't find "bar stools" on ${SITE}; add it on the Services tab.`);
    expect(gathered.evidence).not.toContain("Added **");
  });

  it("never scans when a loaded category already matches", async () => {
    const before = ctServices().length;
    const gathered = await gatherDiagnoseEvidence({ clientId: CT, request: STRATEGY_ASK, intent: "strategy" });
    expect(scanSiteCandidates).not.toHaveBeenCalled();
    expect(ctServices()).toHaveLength(before);
    expect(gathered.evidence).not.toMatch(/Added \*\*|Couldn't find/);
  });

  it("never scans a strategy ask that names no category", async () => {
    noCategories([BAR_STOOLS]);
    await gatherDiagnoseEvidence({ clientId: CT, request: "Plan to hit 10x ROAS on $500/day", intent: "strategy" });
    expect(scanSiteCandidates).not.toHaveBeenCalled();
    expect(ctServices()).toEqual([]);
  });

  it("doesn't add a second row when the category is set up but switched off", async () => {
    const store = getDemoStore();
    for (const s of ctServices()) s.is_active = false;
    vi.mocked(scanSiteCandidates).mockResolvedValue({ candidates: [{ ...BAR_STOOLS, alreadyAdded: true }], source: "firecrawl" });
    const before = store.clientServices.length;
    const gathered = await gatherDiagnoseEvidence({ clientId: CT, request: STRATEGY_ASK, intent: "strategy" });
    expect(store.clientServices).toHaveLength(before);
    expect(gathered.evidence).toContain("**Bar stools** is switched off on the Services tab");
    expect(scanSiteCandidates).not.toHaveBeenCalled();
  });

  it("never scans for the client's own name or a non-category term", async () => {
    noCategories([BAR_STOOLS]);
    getDemoStore().clients.find((c) => c.id === CT)!.name = "During Days";
    await gatherDiagnoseEvidence({ clientId: CT, request: "Build a 10x plan for During Days", intent: "strategy" });
    await gatherDiagnoseEvidence({ clientId: CT, request: "How much have we spent on retargeting?", intent: "general" });
    expect(scanSiteCandidates).not.toHaveBeenCalled();
    expect(ctServices()).toEqual([]);
  });

  it("starts the reply with the Added line", async () => {
    noCategories([BAR_STOOLS, BLACK_BAR_STOOLS]);
    const task = await createTask({ clientId: CT, createdBy: "profile_operator_demo", title: STRATEGY_ASK, goal: STRATEGY_ASK });
    const gathered = await gatherDiagnoseEvidence({ clientId: CT, request: STRATEGY_ASK, intent: "strategy" });
    const result = await runAdspirerAgent({ task, clientContext: "", toolEvidence: gathered.evidence, intent: "strategy" });
    expect(result.summary.startsWith(ADDED_LINE)).toBe(true);
    expect(result.summary.split(ADDED_LINE)).toHaveLength(2);
  });
});

describe("category-spend ask for a category that isn't set up (DEMO_MODE)", () => {
  it("adds Bar Stools and answers the spend question on it", async () => {
    noCategories([BAR_STOOLS, BLACK_BAR_STOOLS]);
    const gathered = await gatherDiagnoseEvidence({ clientId: CT, request: SPEND_ASK, intent: detectRequestIntent(SPEND_ASK) });
    expect(ctServices().map((s) => s.name)).toEqual(["Bar Stools"]);
    expect(gathered.evidence).toContain(ADDED_LINE);
    expect(gathered.evidence).toContain("### Spend & return by category");
    const task = await createTask({ clientId: CT, createdBy: "profile_operator_demo", title: SPEND_ASK, goal: SPEND_ASK });
    const result = await runAdspirerAgent({ task, clientContext: "", toolEvidence: gathered.evidence, intent: detectRequestIntent(SPEND_ASK) });
    expect(result.summary.startsWith(ADDED_LINE)).toBe(true);
    expect(result.summary.split(ADDED_LINE)).toHaveLength(2);
  });

  it("says it's matching spend before the slow website scan", async () => {
    noCategories([BAR_STOOLS]);
    const order: string[] = [];
    vi.mocked(scanSiteCandidates).mockImplementation(async () => {
      order.push("scan");
      return { candidates: [BAR_STOOLS], source: "firecrawl" };
    });
    await gatherDiagnoseEvidence({
      clientId: CT,
      request: "How much have we spent on bar stools?",
      intent: "general",
      onProgress: (e) => void order.push(e.label ?? ""),
    });
    const progress = order.indexOf("Matching spend & return to each category…");
    expect(progress).toBeGreaterThanOrEqual(0);
    expect(progress).toBeLessThan(order.indexOf("scan"));
    expect(order.filter((l) => l.startsWith("Matching spend"))).toHaveLength(1);
  });

  it("starts the reply with the Couldn't find line", async () => {
    noCategories([SOFAS]);
    const ask = "How much have we spent on bar stools?";
    const gathered = await gatherDiagnoseEvidence({ clientId: CT, request: ask, intent: "general" });
    const task = await createTask({ clientId: CT, createdBy: "profile_operator_demo", title: ask, goal: ask });
    const result = await runAdspirerAgent({ task, clientContext: "", toolEvidence: gathered.evidence, intent: "general" });
    expect(result.summary.startsWith(`Couldn't find "bar stools" on ${SITE}; add it on the Services tab.`)).toBe(true);
  });

  it("adds nothing and says what it couldn't find", async () => {
    noCategories([SOFAS]);
    const gathered = await gatherDiagnoseEvidence({
      clientId: CT,
      request: "How much have we spent on bar stools?",
      intent: "general",
    });
    expect(ctServices()).toEqual([]);
    expect(gathered.evidence).toContain(`Couldn't find "bar stools" on ${SITE}; add it on the Services tab.`);
  });
});
