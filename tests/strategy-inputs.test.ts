import { describe, expect, it } from "vitest";
import { evaluateCheckpoints } from "@/lib/audit/checkpoints";
import { demoMetaAuditSnapshot } from "@/lib/audit/meta-audit-data";
import { resolveGoals } from "@/lib/clients/goals";
import {
  appActions,
  ownFindings,
  profileGaps,
  renderStrategyInputsEvidence,
} from "@/lib/strategy/strategy-inputs";
import { PLATFORM_NOTES, PLATFORM_NOTES_VERSION, platformNotes } from "@/lib/strategy/platform-notes";

const goals = resolveGoals({ goals_profile: {} });
const snapshot = demoMetaAuditSnapshot("act_1", "Demo", 30);
const scorecard = evaluateCheckpoints(snapshot, { goals });
const period = { dateStart: "2026-10-01", dateStop: "2026-10-15" };

describe("ownFindings", () => {
  it("lists only failed checkpoints, SF-### ids, most severe first, no checkpoint codes", () => {
    const sc = {
      checkpoints: [
        { id: "B2", title: "Low thing (B2)", status: "fail", severity: "low", evidence: "B2: bad" },
        { id: "T4", title: "Tracking broke", status: "fail", severity: "critical", evidence: "T4 shows 0 events" },
        { id: "A1", title: "Warned", status: "warn", severity: "critical", evidence: "x" },
        { id: "C1", title: "High one", status: "fail", severity: "high", evidence: "e" },
        { id: "C2", title: "High two", status: "fail", severity: "high", evidence: "e2" },
      ],
    } as unknown as Parameters<typeof ownFindings>[0];
    const f = ownFindings(sc);
    expect(f.map((x) => x.id)).toEqual(["SF-001", "SF-002", "SF-003", "SF-004"]);
    expect(f.map((x) => x.title)).toEqual(["Tracking broke", "High one", "High two", "Low thing"]);
    expect(f.every((x) => x.source === "strategy")).toBe(true);
    expect(f[0].evidence).toBe("shows 0 events");
    expect(JSON.stringify(f)).not.toMatch(/\b[A-Z]\d\b/);
  });
});

describe("appActions", () => {
  it("has budget and pause tools, excludes commerce-page entries, carries guardrails", () => {
    const g = resolveGoals({ goals_profile: { daily_account_cap_cents: 50_000, monthly_cap_cents: 1_200_000 } });
    const a = appActions(g);
    const tools = a.map((x) => x.tool);
    expect(tools).toContain("update_adset_budget");
    expect(tools).toContain("pause_adset");
    expect(tools).not.toContain("update_product_set_filter");
    expect(tools).not.toContain("request_feed_refresh");
    const budget = a.find((x) => x.tool === "update_adset_budget")!;
    expect(budget.guardrail).toContain("20%");
    expect(budget.guardrail).toContain("max_budget_change_pct");
    expect(budget.guardrail).toContain("500.00 per day");
    expect(budget.guardrail).toContain("12000.00 per month");
  });

  it("omits caps that are not set", () => {
    const a = appActions(goals).find((x) => x.tool === "update_adset_budget")!;
    expect(a.guardrail).not.toMatch(/per day|per month/);
  });

  it("uses the money formatter", () => {
    const g = resolveGoals({ goals_profile: { daily_account_cap_cents: 10_000 } });
    const a = appActions(g, (c) => `₹${c / 100}`).find((x) => x.tool === "update_adset_budget")!;
    expect(a.guardrail).toContain("₹100 per day");
  });
});

describe("profileGaps", () => {
  const hist = [{ role: "user" as const, content: "hello" }];
  it("lists the standing items, then drops risk appetite when the request covers it", () => {
    const all = profileGaps(goals, "make a strategy", hist);
    expect(all.join("|")).toMatch(/risk appetite/i);
    const some = profileGaps(goals, "we're risk-averse", hist);
    expect(some.join("|")).not.toMatch(/risk appetite/i);
  });

  it("lists goal, timeframe, budget and margin when missing and unstated", () => {
    const all = profileGaps(goals, "plan", []).join("|").toLowerCase();
    for (const k of ["goal", "timeframe", "budget", "margin"]) expect(all).toContain(k);
  });

  it("does not list them when goals or chat cover them", () => {
    const g = resolveGoals({
      goals_profile: { target_cpa_cents: 2000, daily_account_cap_cents: 10_000, gross_margin_pct: 40 },
    });
    const out = profileGaps(g, "in 90 days", []).join("|").toLowerCase();
    for (const k of ["goal", "timeframe", "budget", "margin"]) expect(out).not.toContain(k);
  });

  it("reads user messages in history, not assistant ones", () => {
    const out = profileGaps(goals, "", [
      { role: "assistant", content: "what about your offer and discount?" },
      { role: "user", content: "our offer is 20% discount" },
    ]).join("|").toLowerCase();
    expect(out).not.toContain("offer");
  });
});

describe("renderStrategyInputsEvidence", () => {
  const out = renderStrategyInputsEvidence({ snapshot, goals, scorecard, request: "strategy", history: [], period });

  it("has the heading, version, notes and app capabilities", () => {
    expect(out).toContain("### Strategy inputs (findings, profile, platform notes, app capabilities)");
    expect(out).toContain(PLATFORM_NOTES_VERSION);
    for (const n of platformNotes(goals)) expect(out).toContain(n);
    expect(out).toContain("update_adset_budget");
    expect(out).toContain("Business type");
    expect(out).toContain("Profile missing");
  });

  it("uses SF findings and the notice when no prior report covers the period", () => {
    expect(out).toContain("No audit or comparison in this chat covers this period; findings below come from this strategy's own checks (SF-###)");
    expect(out).toMatch(/SF-001/);
    expect(out).not.toMatch(/\bAUD-\d/);
  });

  it("uses prior findings when a matching audit is in chat", () => {
    const audit = [
      "# Meta Ads Account Audit",
      "**Period:** 2026-10-01 → 2026-10-15 · **Scope:** whole account",
      "### AUD-001 — Tracking gap",
      "**Evidence:** no events",
    ].join("\n");
    const o = renderStrategyInputsEvidence({
      snapshot, goals, scorecard, request: "strategy", period,
      history: [{ role: "assistant", content: audit }],
    });
    expect(o).toContain("AUD-001 — Tracking gap — no events");
    expect(o).not.toContain("SF-001");
    expect(o).not.toContain("No audit or comparison in this chat covers");
  });
});

describe("platformNotes", () => {
  it("adds a frequency line from goals policy to the static notes", () => {
    const n = platformNotes(resolveGoals({ goals_profile: { policy: { prospecting_frequency_max: 2.5 } } }));
    expect(n.slice(0, PLATFORM_NOTES.length)).toEqual(PLATFORM_NOTES);
    expect(n[n.length - 1]).toMatch(/2\.5/);
    expect(n.every((x) => !x.includes("\n"))).toBe(true);
  });
});
