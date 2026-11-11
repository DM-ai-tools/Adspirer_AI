import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "@/lib/config";
import { BULK_ANGLES } from "@/lib/creatives/bulk/angles";
import { chooseResults, findClientResults, groundedIn, isResultAngle, resultAngles, resultFacts, type ClientResult } from "@/lib/creatives/bulk/results";

vi.mock("@/lib/creatives/concept-writer", async (orig) => ({ ...(await orig<typeof import("@/lib/creatives/concept-writer")>()), pickModel: () => ({}) }));

const PAGE = [
  "Trusted by 1,500+ Australian Businesses",
  "$120M+ in Ad Spend Managed",
  "$26.5M Sales Revenue from $5.33M ad spend · in 12 months",
  "$12.2M Conversion Value $797K Google Ads spend · 15.36× ROAS",
  "Our free 30-minute audit shows where your budget leaks. ".repeat(3),
].join("\n");

let extracted: Array<Record<string, unknown>> = [];
const hookPrompts: string[] = [];
const ideaPrompts: string[] = [];
vi.mock("ai", () => ({
  generateObject: async ({ prompt }: { prompt: string }) => {
    if (prompt.includes("List the client results and stats")) return { object: { results: extracted } };
    if (prompt.includes("Build the message map")) return { object: { pains: ["p"], desires: ["d"], objections: ["o"], proof: ["x"], mechanism: "m", audience: "a" } };
    if (prompt.includes("Write exactly 4 distinct bodies")) {
      return { object: { bodies: ["A", "B", "C", "D"].map((id) => ({ id, format: "proof", text: `body ${id}` })), ctas: [{ label: "Get a quote", cta: "GET_QUOTE" }] } };
    }
    const keys = [...prompt.matchAll(/key "([a-z_0-9]+)"/g)].map((m) => m[1]!);
    if (prompt.includes("Write one visual idea")) {
      ideaPrompts.push(prompt);
      return { object: { ideas: keys.map((k) => ({ angle_key: k, idea: `idea for ${k}` })) } };
    }
    hookPrompts.push(prompt);
    return {
      object: {
        hooks: keys.map((k) => ({
          angle_key: k, targets: `target ${k}`, post_headline: `Headline ${k}`, body_id: "A", primary_text: `copy ${k}`, cta_index: 0,
          on_image_text: { headline: `w${k.length}${k.charCodeAt(0)}${k.charCodeAt(k.length - 1)}a w${k.length}b w${k.charCodeAt(1)}c`, highlights: [`label ${k}`], cta_label: "Go" },
          style: "s", creative_direction: `idea ${k}`,
        })),
      },
    };
  },
}));

const result = (over: Partial<ClientResult> = {}): ClientResult => ({ kind: "case_result", industry: "e-commerce", client: null, stat: "$26.5M Sales Revenue", detail: "from $5.33M ad spend in 12 months", ...over });

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test";
  resetConfigCache();
  extracted = [];
  hookPrompts.length = 0;
  ideaPrompts.length = 0;
});

describe("checking a figure against the page", () => {
  it("accepts figures written on the page and refuses ones that are not", () => {
    expect(groundedIn("$26.5M Sales Revenue", PAGE)).toBe(true);
    expect(groundedIn("1,500+ Australian Businesses", PAGE)).toBe(true);
    expect(groundedIn("15.36× ROAS", PAGE)).toBe(true);
    expect(groundedIn("$30M Sales Revenue", PAGE)).toBe(false);
    expect(groundedIn("500% growth", PAGE)).toBe(false);
    expect(groundedIn("Trusted worldwide", PAGE)).toBe(false);
  });
});

describe("finding client results on a page", () => {
  it("keeps only figures that are really on the page, and drops repeats", async () => {
    extracted = [
      { kind: "case_result", industry: "e-commerce", client: null, stat: "$26.5M Sales Revenue", detail: "12 months" },
      { kind: "case_result", industry: "retail", client: null, stat: "$99M Sales Revenue", detail: "" }, // not on the page
      { kind: "company_stat", industry: "Australian businesses", client: null, stat: "1,500+ Australian Businesses", detail: "" },
      { kind: "company_stat", industry: "", client: null, stat: "Trusted by 1,500+ Australian Businesses", detail: "" }, // same figure
      { kind: "company_stat", industry: "", client: null, stat: "Premier Partner", detail: "" }, // no figure
    ];
    const out = await findClientResults(PAGE);
    expect(out.map((r) => r.stat)).toEqual(["$26.5M Sales Revenue", "1,500+ Australian Businesses"]);
  });

  it("finds nothing on an empty page without asking the model", async () => {
    expect(await findClientResults("  ")).toEqual([]);
  });
});

describe("choosing what to showcase", () => {
  const stat = (n: number) => result({ kind: "company_stat", stat: `${n}0+ things` });
  it("takes at most three, client results before business-wide stats", () => {
    const chosen = chooseResults([stat(1), stat(2), result({ stat: "$1M" }), result({ stat: "$2M" }), stat(3)]);
    expect(chosen).toHaveLength(3);
    expect(chosen.map((r) => r.kind)).toEqual(["case_result", "case_result", "company_stat"]);
  });
  it("makes one angle per result, carrying the exact figure and the industry", () => {
    const angles = resultAngles([result()]);
    expect(angles).toHaveLength(1);
    expect(isResultAngle(angles[0]!)).toBe(true);
    expect(angles[0]!.brief).toContain("$26.5M Sales Revenue");
    expect(angles[0]!.brief).toContain("e-commerce");
    expect(angles[0]!.name).toBe("Client result: $26.5M Sales Revenue");
    expect(BULK_ANGLES.some((a) => a.key === angles[0]!.key)).toBe(false);
  });
  it("has none when the page has none", () => {
    expect(resultAngles([])).toEqual([]);
    expect(resultFacts([])).toBeNull();
  });
});

describe("a run with client results on the page", () => {
  const brief = { brandName: "Acme", offerName: "Audit", notes: null };

  it("reserves an image for each of up to three results and fills the rest with the usual angles, 15 in all", async () => {
    const { writeBulkPlan } = await import("@/lib/creatives/bulk/plan");
    const plan = await writeBulkPlan({ ...brief, results: [result(), result({ stat: "7.61× ROAS", industry: "retail" }), result({ kind: "company_stat", stat: "1,500+ Australian Businesses", industry: "" })] }, 15);
    expect(plan.hooks).toHaveLength(15);
    const results = plan.hooks.filter((h) => isResultAngle(h.angle));
    expect(results).toHaveLength(3);
    expect(plan.hooks.filter((h) => !isResultAngle(h.angle))).toHaveLength(12);
    expect(new Set(plan.hooks.map((h) => h.angle.key)).size).toBe(15);
    // Their prompts carry the exact figure and the rule to show it unchanged.
    const resultPrompt = hookPrompts.find((p) => p.includes('key "client_result_1"'))!;
    expect(resultPrompt).toContain("$26.5M Sales Revenue");
    expect(resultPrompt).toMatch(/RESULT HOOKS/);
    expect(resultPrompt).toMatch(/copied EXACTLY/);
    // A regular hook's prompt does not carry the result rule.
    expect(hookPrompts.find((p) => !p.includes("client_result_"))!).not.toMatch(/RESULT HOOKS/);
    // The writer is also told the real figures as facts.
    expect(hookPrompts[0]).toContain("Real client results and stats on the landing page");
  });

  it("reserves nothing when the page has no results: fifteen usual angles", async () => {
    const { writeBulkPlan } = await import("@/lib/creatives/bulk/plan");
    const plan = await writeBulkPlan({ ...brief, results: [] }, 15);
    expect(plan.hooks).toHaveLength(15);
    expect(plan.hooks.some((h) => isResultAngle(h.angle))).toBe(false);
    expect(hookPrompts.join("\n")).not.toMatch(/RESULT HOOKS/);
    const none = await writeBulkPlan(brief, 15);
    expect(none.hooks.some((h) => isResultAngle(h.angle))).toBe(false);
  });

  it("reserves just one when the page has just one figure", async () => {
    const { writeBulkPlan } = await import("@/lib/creatives/bulk/plan");
    const plan = await writeBulkPlan({ ...brief, results: [result()] }, 15);
    expect(plan.hooks.filter((h) => isResultAngle(h.angle))).toHaveLength(1);
    expect(plan.hooks).toHaveLength(15);
  });

  it("plans a picture idea for the result images too", async () => {
    const { writeBulkPlan } = await import("@/lib/creatives/bulk/plan");
    await writeBulkPlan({ ...brief, results: [result()] }, 15);
    expect(ideaPrompts[0]).toContain('key "client_result_1"');
    expect(ideaPrompts[0]).toMatch(/RESULT HOOKS/);
  });
});

describe("variety in what is showcased", () => {
  it("prefers results from different industries over several from the same one", () => {
    const chosen = chooseResults([
      result({ stat: "$1M", industry: "e-commerce" }),
      result({ stat: "$2M", industry: "e-commerce" }),
      result({ stat: "$3M", industry: "dental clinics" }),
      result({ stat: "$4M", industry: "e-commerce" }),
    ]);
    expect(chosen.map((r) => r.stat)).toEqual(["$1M", "$3M", "$2M"]);
  });
  it("falls back to repeats of an industry when there are not enough different ones", () => {
    const chosen = chooseResults([result({ stat: "$1M" }), result({ stat: "$2M" })]);
    expect(chosen).toHaveLength(2);
  });
});
