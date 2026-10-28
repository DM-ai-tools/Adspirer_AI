import type {
  MetaAd,
  MetaAdCreative,
  MetaAdSet,
  MetaAdsProvider,
  MetaCampaign,
} from "@/lib/adspirer/provider";
import type { AgentToolCallProposal } from "@/lib/agent/adspirer-agent";
import { matchCampaignsByHints } from "@/lib/agent/audit-brief";
import { type Focus, ownerForCheckpoint, ownerLabel } from "@/lib/agent/optimization-capabilities";
import { holdIncreasesOnSilentTracking, broadAdSetPart, reactivationPart } from "@/lib/agent/optimize-proposals";
import { placementPart } from "@/lib/agent/placement-evidence";
import { mergeExecuteProposals, proposalsFromOptimizeStructured } from "@/lib/agent/optimize-queue";
import { resolvePeriod, type BriefPeriod, type RequestBrief } from "@/lib/agent/request-brief";
import { type Checkpoint, type CheckpointCategory, evaluateCheckpoints } from "@/lib/audit/checkpoints";
import { type MetaAuditSnapshot, scopeAuditSnapshot } from "@/lib/audit/meta-audit-data";
import { renderOptimisationSignals } from "@/lib/audit/render";
import type { ResolvedGoals } from "@/lib/clients/goals";
import { escapeTableCell } from "@/lib/reports/table-row";
import { humanToolLabel } from "@/lib/tools/display-labels";

/**
 * The live evidence for one optimisation turn: built from Meta for the period
 * and scope the operator asked about, and only for the areas they asked about.
 * Everything it offers is numbered (#1, #2…) so a later "queue #2" means one thing.
 */

export type EntityRef = { id: string; name: string; type: "campaign" | "adset" | "ad" };

export type OfferedProposal = {
  ref: number;
  tool: string;
  args: Record<string, unknown>;
  rationale?: string;
  focus: Focus;
  /** Campaign / ad set / ad ids the proposal changes. */
  entityIds: string[];
  /** One line the operator reads: what, where, why. */
  label: string;
  /** Daily budget moved, in cents, when the proposal is a budget change. */
  spendAtStakeCents: number | null;
};

export type OptimizeEvidence = {
  sections: string[];
  offered: OfferedProposal[];
  /** Ids in scope (campaigns, their ad sets and ads); null = the whole account. */
  scopeEntityIds: string[] | null;
  /** Names the operator gave that match nothing in the account. */
  unresolvedMentions: string[];
  /** Code-written "who does what" table for the reply. */
  appendix: string;
  entityIndex: EntityRef[];
  /** The account's campaigns, ad sets and ads (for resolving names to ids later in the turn). */
  inventory: Inventory;
  ads: MetaAd[];
  /** The operator named an ad (so no ad picker is needed). */
  adNamed: boolean;
  /** The reads that actually ran, for the audit trail. */
  toolsRun: AgentToolCallProposal[];
  period: BriefPeriod;
};

export type Inventory = { campaigns: MetaCampaign[]; adsets: MetaAdSet[]; ads: MetaAd[] };

/** What a brief with no named area covers. */
const CORE_FOCUS: Focus[] = ["budget", "creative", "tracking"];

/** Areas whose answer is the account's checkpoint results. */
const SIGNAL_FOCUS: ReadonlySet<Focus> = new Set<Focus>([
  "tracking",
  "bids",
  "audiences",
  "placements",
  "creative",
  "structure",
  "landing_page",
]);

const FOCUS_CATEGORIES: Partial<Record<Focus, CheckpointCategory[]>> = {
  budget: ["Bidding & budget"],
  bids: ["Bidding & budget"],
  tracking: ["Tracking & measurement"],
  audiences: ["Audiences & targeting"],
  placements: ["Audiences & targeting"],
  creative: ["Creative"],
  structure: ["Account structure", "Funnel & frequency"],
  reactivation: ["Account structure"],
  landing_page: ["Funnel & frequency"],
};

// ---------------------------------------------------------------- names → ids

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

type Matched = { campaigns: MetaCampaign[]; adsets: MetaAdSet[]; ads: MetaAd[] };

function matchOne(name: string, inv: Inventory): Matched {
  const h = norm(name);
  if (!h) return { campaigns: [], adsets: [], ads: [] };
  const exactBy = <T extends { id: string; name: string }>(rows: T[]) =>
    rows.filter((r) => r.id === name.trim() || norm(r.name) === h);
  const exact = { campaigns: exactBy(inv.campaigns), adsets: exactBy(inv.adsets), ads: exactBy(inv.ads) };
  if (exact.campaigns.length || exact.adsets.length || exact.ads.length) return exact;
  const loose = <T extends { id: string; name: string }>(rows: T[]) =>
    rows.filter((r) => {
      const n = norm(r.name);
      return n.length >= 3 && (n.includes(h) || h.includes(n));
    });
  return {
    campaigns: matchCampaignsByHints(inv.campaigns, [name]),
    adsets: loose(inv.adsets),
    ads: loose(inv.ads),
  };
}

function matchAll(names: string[], inv: Inventory): { matched: Matched; unresolved: string[] } {
  const matched: Matched = { campaigns: [], adsets: [], ads: [] };
  const unresolved: string[] = [];
  const add = <T extends { id: string }>(into: T[], rows: T[]) => {
    for (const row of rows) if (!into.some((r) => r.id === row.id)) into.push(row);
  };
  for (const name of names) {
    const found = matchOne(name, inv);
    if (!found.campaigns.length && !found.adsets.length && !found.ads.length) {
      unresolved.push(name);
      continue;
    }
    add(matched.campaigns, found.campaigns);
    add(matched.adsets, found.adsets);
    add(matched.ads, found.ads);
  }
  return { matched, unresolved };
}

/** Every id under the matched entities: the entity itself plus its ad sets and ads. */
function treeIds(matched: Matched, inv: Inventory): Set<string> {
  const ids = new Set<string>();
  for (const c of matched.campaigns) {
    ids.add(c.id);
    for (const a of inv.adsets) if (a.campaign_id === c.id) ids.add(a.id);
    for (const ad of inv.ads) if (ad.campaign_id === c.id) ids.add(ad.id);
  }
  for (const a of matched.adsets) {
    ids.add(a.id);
    for (const ad of inv.ads) if (ad.adset_id === a.id) ids.add(ad.id);
  }
  for (const ad of matched.ads) ids.add(ad.id);
  return ids;
}

/**
 * Resolve names against live entities. `ids` is each named entity and everything under it (for
 * scope, exclusions and matching proposals); `direct` is only the entities the operator named
 * (the only things a direct instruction may change).
 */
export function resolveEntityIds(
  names: string[],
  inv: Inventory,
): { ids: Set<string>; direct: Set<string>; unresolved: string[] } {
  const { matched, unresolved } = matchAll(names, inv);
  const direct = new Set([...matched.campaigns, ...matched.adsets, ...matched.ads].map((e) => e.id));
  return { ids: treeIds(matched, inv), direct, unresolved };
}

// ---------------------------------------------------------------- helpers

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function entityIdsOf(args: Record<string, unknown>): string[] {
  return [str(args.adset_id), str(args.campaign_id), str(args.ad_id)].filter((v): v is string => v !== null);
}

function budgetDelta(call: AgentToolCallProposal): number | null {
  if (call.name !== "update_adset_budget" && call.name !== "update_campaign_budget") return null;
  const next = num(call.args.daily_budget_cents);
  const prev = num(call.args.previous_daily_budget_cents);
  return next != null && prev != null ? Math.abs(next - prev) : null;
}

function isBudgetIncrease(call: AgentToolCallProposal): boolean {
  if (call.name !== "update_adset_budget" && call.name !== "update_campaign_budget") return false;
  const next = num(call.args.daily_budget_cents);
  const prev = num(call.args.previous_daily_budget_cents);
  return next != null && (prev == null || next > prev);
}

const cell = (text: string) => escapeTableCell(text);

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type ScopeOptions = Record<string, string[]>;

/** One read per kind of thing the operator named, so a campaign and an ad set are both honoured. */
function scopeOptionSets(
  scope: { all: boolean; matched: Matched },
  inv: Inventory,
  kind: "budget" | "fatigue",
): ScopeOptions[] {
  if (scope.all) return [{}];
  const { campaigns, adsets, ads } = scope.matched;
  const campaignIds = new Set(campaigns.map((c) => c.id));
  const sets: ScopeOptions[] = [];
  if (campaigns.length) sets.push({ campaign_ids: campaigns.map((c) => c.id) });
  const looseAdsets = adsets.filter((a) => !campaignIds.has(a.campaign_id));
  if (kind === "budget") {
    // Budget is decided per ad set (or campaign), so an ad means its ad set.
    const fromAds = ads
      .filter((ad) => !campaignIds.has(ad.campaign_id))
      .map((ad) => inv.adsets.find((a) => a.id === ad.adset_id))
      .filter((a): a is MetaAdSet => Boolean(a));
    const ids = [...new Set([...looseAdsets, ...fromAds].map((a) => a.id))];
    if (ids.length) sets.push({ adset_ids: ids });
  } else {
    if (looseAdsets.length) sets.push({ adset_ids: looseAdsets.map((a) => a.id) });
    const adsetIds = new Set(adsets.map((a) => a.id));
    const looseAds = ads.filter((ad) => !campaignIds.has(ad.campaign_id) && !adsetIds.has(ad.adset_id));
    if (looseAds.length) sets.push({ ad_ids: looseAds.map((a) => a.id) });
  }
  return sets;
}

// ---------------------------------------------------------------- main

export async function buildOptimizeEvidence(input: {
  provider: MetaAdsProvider;
  accountId: string;
  brief: RequestBrief;
  currency: string | null;
  goals: ResolvedGoals;
  fallbackLandingUrl?: string | null;
}): Promise<OptimizeEvidence> {
  const { provider, accountId, brief } = input;
  const period = brief.period ?? resolvePeriod("", []);
  const focus: Focus[] = brief.focus.length ? brief.focus : CORE_FOCUS;
  const toolsRun: AgentToolCallProposal[] = [];
  const sections: string[] = [];
  const failures: string[] = [];

  const quiet = <T>(label: string, p: Promise<T>, fallback: T): Promise<T> =>
    p.catch((error) => {
      failures.push(`Could not read ${label}: ${errorText(error)}`);
      return fallback;
    });
  const [campaigns, adsets, ads] = await Promise.all([
    quiet("campaigns", provider.listCampaigns(accountId), [] as MetaCampaign[]),
    quiet("ad sets", provider.listAdSets(accountId), [] as MetaAdSet[]),
    quiet("ads", provider.listAds(accountId), [] as MetaAd[]),
  ]);
  const inv: Inventory = { campaigns, adsets, ads };
  toolsRun.push({ name: "list_ads", args: { account_id: accountId }, rationale: "Inventory for optimize" });
  const entityIndex: EntityRef[] = [
    ...campaigns.map((c) => ({ id: c.id, name: c.name, type: "campaign" as const })),
    ...adsets.map((a) => ({ id: a.id, name: a.name, type: "adset" as const })),
    ...ads.map((a) => ({ id: a.id, name: a.name, type: "ad" as const })),
  ];
  const nameOf = new Map(entityIndex.map((e) => [e.id, e.name]));

  // ---- scope
  const mentions = brief.scope.mentions;
  const named = matchAll(mentions, inv);
  const scopeAll = mentions.length === 0;
  const hasMatch = named.matched.campaigns.length + named.matched.adsets.length + named.matched.ads.length > 0;
  const excluded = resolveEntityIds(brief.exclude, inv).ids;
  const scopeIds = scopeAll ? null : treeIds(named.matched, inv);
  const scopeNames = [
    ...named.matched.campaigns.map((c) => c.name),
    ...named.matched.adsets.map((a) => a.name),
    ...named.matched.ads.map((a) => a.name),
  ];
  const header = [
    "### Scope and period",
    `- Period: ${period.since} → ${period.until} (${period.label}${period.explicit ? ", as asked" : "; no period stated this turn"})`,
    `- Scope: ${scopeAll ? "whole account" : hasMatch ? scopeNames.join(", ") : "none of the names you gave matched"}`,
    ...(brief.exclude.length ? [`- Left alone: ${brief.exclude.join(", ")}`] : []),
  ].join("\n");
  sections.push(header);

  const finish = (offered: OfferedProposal[], appendix: string): OptimizeEvidence => ({
    sections,
    offered,
    scopeEntityIds: scopeIds ? [...scopeIds] : null,
    unresolvedMentions: named.unresolved,
    appendix,
    entityIndex,
    inventory: inv,
    ads,
    adNamed: named.matched.ads.length > 0,
    toolsRun,
    period,
  });

  if (failures.length && !campaigns.length && !adsets.length) {
    sections.push(["### Account data", ...failures.map((f) => `- ${f}`)].join("\n"));
    return finish([], "");
  }

  if (named.unresolved.length) {
    const tokens = named.unresolved.flatMap((n) => norm(n).split(" ").filter((w) => w.length >= 3));
    const close = campaigns.filter((c) => tokens.some((t) => norm(c.name).includes(t)));
    const shown = (close.length ? close : campaigns).slice(0, 5).map((c) => `"${c.name}"`);
    sections.push(
      [
        "### Not found",
        ...named.unresolved.map((n) => `- "${n}" wasn't found in this ad account.`),
        shown.length
          ? `- ${close.length ? "Closest" : "Some"} campaign names: ${shown.join(", ")}.`
          : "- This ad account has no campaigns.",
        hasMatch
          ? "- Everything below covers only what was found; nothing was widened to the rest of the account."
          : "- Nothing was fetched or proposed: say which campaign, ad set or ad you meant.",
      ].join("\n"),
    );
    if (!hasMatch) return finish([], "");
  }

  if (!campaigns.length && !adsets.length && !ads.length) {
    sections.push("### Nothing to optimise\n- This ad account has no campaigns, ad sets or ads in Meta yet, so there is nothing to optimise.");
    return finish([], "");
  }

  // The inventory narrowed to scope, minus anything the operator said to leave alone.
  const inScope = (id: string) => (scopeIds ? scopeIds.has(id) : true) && !excluded.has(id);
  const scopedCampaigns = campaigns.filter((c) => inScope(c.id));
  const scopedAdsets = adsets.filter((a) => inScope(a.id) && !excluded.has(a.campaign_id));
  const campaignIdsForSnapshot = scopeAll
    ? null
    : [
        ...new Set([
          ...named.matched.campaigns.map((c) => c.id),
          ...named.matched.adsets.map((a) => a.campaign_id),
          ...named.matched.ads.map((a) => a.campaign_id),
        ]),
      ];
  const scope = { all: scopeAll, matched: named.matched };

  // ---- reads (concurrent)
  const raw: Array<{ call: AgentToolCallProposal; focus: Focus }> = [];
  const blocked: string[] = [];
  const wantsBudget = focus.includes("budget");
  const wantsSignals = brief.focus.length === 0 || focus.some((f) => SIGNAL_FOCUS.has(f));

  const loadSnapshot = async (): Promise<MetaAuditSnapshot | null> => {
    if (!provider.getAuditSnapshot) return null;
    try {
      const snap = await provider.getAuditSnapshot(accountId, { since: period.since, until: period.until, compare: false });
      toolsRun.push({
        name: "audit_checkpoints",
        args: { account_id: accountId, since: period.since, until: period.until },
        rationale: "Optimisation signals",
      });
      return campaignIdsForSnapshot ? scopeAuditSnapshot(snap, campaignIdsForSnapshot) : snap;
    } catch (error) {
      failures.push(`Could not read tracking and structure checks: ${errorText(error)}`);
      return null;
    }
  };
  let snapshotP: Promise<MetaAuditSnapshot | null> | null = wantsSignals ? loadSnapshot() : null;

  const budgetP = wantsBudget
    ? (async () => {
        if (!provider.optimizeBudget) return;
        const texts: string[] = [];
        try {
          for (const set of scopeOptionSets(scope, inv, "budget")) {
            const out = await provider.optimizeBudget(accountId, { since: period.since, until: period.until, ...set });
            texts.push(out.text);
            for (const call of proposalsFromOptimizeStructured(out.structured as Record<string, unknown> | null)) {
              raw.push({ call, focus: "budget" });
            }
            toolsRun.push({ name: "optimize_meta_budget", args: { account_id: accountId, ...set }, rationale: "Budget optimize" });
          }
          if (texts.length) sections.push(texts.join("\n\n"));
        } catch (error) {
          failures.push(`Could not read budgets: ${errorText(error)}`);
        }
      })()
    : null;

  const fatigueP = focus.includes("creative")
    ? (async () => {
        if (!provider.detectCreativeFatigue) return;
        const texts: string[] = [];
        try {
          for (const set of scopeOptionSets(scope, inv, "fatigue")) {
            const out = await provider.detectCreativeFatigue(accountId, { until: period.until, ...set });
            texts.push(out.text);
            for (const call of proposalsFromOptimizeStructured(out.structured as Record<string, unknown> | null)) {
              raw.push({ call, focus: "creative" });
            }
            toolsRun.push({ name: "detect_meta_creative_fatigue", args: { account_id: accountId, ...set }, rationale: "Creative fatigue" });
          }
          if (texts.length) sections.push(texts.join("\n\n"));
        } catch (error) {
          failures.push(`Could not read creative fatigue: ${errorText(error)}`);
        }
      })()
    : null;

  const placementsP = focus.includes("placements")
    ? (async () => {
        if (!provider.getInsightsReport) {
          failures.push("Could not read placement performance: this connection can't read breakdowns.");
          return;
        }
        const rows: Array<Record<string, unknown>> = [];
        let partial = false;
        try {
          for (const set of scopeOptionSets(scope, inv, "budget")) {
            const report = await provider.getInsightsReport(accountId, {
              level: "adset",
              fields: ["adset_id", "adset_name", "spend", "impressions", "actions"],
              breakdowns: ["publisher_platform", "platform_position"],
              time_range: { since: period.since, until: period.until },
              campaign_ids: set.campaign_ids,
              adset_ids: set.adset_ids,
              limit: 500,
            });
            rows.push(...report.rows);
            partial = partial || report.has_more;
          }
        } catch (error) {
          failures.push(`Could not read placement performance: ${errorText(error)}`);
          return;
        }
        const part = placementPart({ rows, adsets: scopedAdsets, period, currency: input.currency, partial });
        sections.push(part.section);
        for (const call of part.proposals) raw.push({ call, focus: "placements" });
      })()
    : null;

  const reactivationP = focus.includes("reactivation")
    ? reactivationPart({ provider, accountId, campaigns: scopedCampaigns, adsets: scopedAdsets, currency: input.currency })
        .then((part) => {
          for (const call of part.proposals) raw.push({ call, focus: "reactivation" });
          blocked.push(...part.blockedLines);
        })
        .catch((error) => failures.push(`Could not check paused campaigns: ${errorText(error)}`))
    : null;

  const structureP = focus.includes("structure")
    ? (async () => {
        const creatives: MetaAdCreative[] = provider.getAdCreatives
          ? await provider.getAdCreatives(accountId, { limit: 30 }).catch(() => [])
          : [];
        const part = broadAdSetPart({
          accountId,
          campaigns: scopedCampaigns,
          adsets: scopedAdsets,
          creatives,
          fallbackLandingUrl: input.fallbackLandingUrl,
        });
        for (const call of part.proposals) raw.push({ call, focus: "structure" });
        blocked.push(...part.blockedLines);
      })().catch((error) => failures.push(`Could not plan a new ad set: ${errorText(error)}`))
    : null;

  await Promise.all([budgetP, fatigueP, placementsP, reactivationP, structureP]);

  // A budget increase is only offered once tracking is known to be recording.
  const increases = raw.some(({ call }) => isBudgetIncrease(call));
  if (!snapshotP && increases) snapshotP = loadSnapshot();
  const snapshot = snapshotP ? await snapshotP : null;

  const merged = mergeExecuteProposals([], raw.map((r) => r.call));
  const focusOf = new Map(raw.map((r) => [`${r.call.name}:${JSON.stringify(r.call.args)}`, r.focus]));
  const hold = holdIncreasesOnSilentTracking(merged, snapshot);
  if (hold.heldLines.length) sections.push(["### Held back", ...hold.heldLines].join("\n"));

  const kept = hold.kept.filter((call) => {
    const ids = entityIdsOf(call.args);
    if (ids.some((id) => excluded.has(id))) return false;
    return scopeIds ? ids.every((id) => scopeIds.has(id)) : true;
  });

  // ---- numbered proposals
  const focusIndex = (f: Focus) => focus.indexOf(f);
  const offered: OfferedProposal[] = kept
    .map((call) => {
      const callFocus = focusOf.get(`${call.name}:${JSON.stringify(call.args)}`) ?? "budget";
      const ids = entityIdsOf(call.args);
      const where = ids.map((id) => nameOf.get(id)).find(Boolean);
      return {
        ref: 0,
        tool: call.name,
        args: call.args,
        rationale: call.rationale,
        focus: callFocus,
        entityIds: ids,
        label: call.rationale ?? `${humanToolLabel(call.name)}${where ? ` — ${where}` : ""}`,
        spendAtStakeCents: budgetDelta(call),
      } satisfies OfferedProposal;
    })
    .sort(
      (a, b) =>
        focusIndex(a.focus) - focusIndex(b.focus) ||
        (b.spendAtStakeCents ?? -1) - (a.spendAtStakeCents ?? -1) ||
        a.label.localeCompare(b.label),
    )
    .map((o, i) => ({ ...o, ref: i + 1 }));

  if (offered.length) {
    sections.push(
      [
        "### Numbered proposals (the operator can ask to queue any of these by number)",
        ...offered.map((o) => `- #${o.ref} [${o.focus}] ${o.label} → \`${o.tool}\``),
        "These are proposals only. Nothing is queued until the operator asks for specific ones.",
      ].join("\n"),
    );
  } else if (brief.focus.length === 0 || wantsBudget || focus.includes("creative") || focus.includes("placements")) {
    sections.push("### Numbered proposals\n- None: live data did not yield a concrete change for this scope and period.");
  }

  // ---- checkpoint signals (and their owners)
  let priorityRows: Checkpoint[] = [];
  if (wantsSignals && snapshot) {
    const scorecard = evaluateCheckpoints(snapshot, { goals: input.goals });
    const categories = brief.focus.length === 0 ? null : new Set(focus.flatMap((f) => FOCUS_CATEGORIES[f] ?? []));
    const filtered = categories
      ? { ...scorecard, priorities: scorecard.priorities.filter((c) => categories.has(c.category)) }
      : scorecard;
    priorityRows = filtered.priorities.slice(0, 10);
    sections.push(renderOptimisationSignals(filtered));
  } else if (wantsSignals && !snapshot && !failures.some((f) => /checks/.test(f))) {
    sections.push("### Optimisation signals\n- Tracking and structure checks aren't available for this connection.");
  }

  if (blocked.length) sections.push(["### Needs operator input (not queueable yet)", ...blocked].join("\n"));
  if (focus.includes("bids")) {
    sections.push(
      "### Bids\n- A bid strategy or cap changes only on a target the operator states (a cost cap, a bid cap or a minimum ROAS) and the ad set it is for; say which and it can be queued.",
    );
  }
  if (focus.includes("schedule")) {
    sections.push("### Schedule\n- A schedule changes only on an end date the operator states and the ad set it is for; say which and it can be queued.");
  }
  if (failures.length) sections.push(["### Could not read", ...failures.map((f) => `- ${f}`)].join("\n"));

  return finish(offered, renderAppendix(offered, priorityRows));
}

/** The "who does what" table, written by code so owners and refs are never model-written. */
export function renderAppendix(offered: OfferedProposal[], priorities: Checkpoint[]): string {
  if (!offered.length && !priorities.length) return "";
  const rows: string[] = [];
  for (const o of offered) {
    rows.push(
      `| #${o.ref} | ${cell(humanToolLabel(o.tool))} | ${cell(o.label)} | ${ownerLabel("app")} | Yes: ask me to queue #${o.ref} |`,
    );
  }
  for (const c of priorities) {
    const { owner } = ownerForCheckpoint(c.id);
    rows.push(
      `| ${c.id} | ${cell(c.fix ?? c.title)} | ${cell(c.evidence)} | ${ownerLabel(owner)} | ${owner === "app" ? "Yes: ask me" : "No"} |`,
    );
  }
  return [
    "### Who does what",
    "| # | Step | Why (live evidence) | Who does it | In this app |",
    "|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}
