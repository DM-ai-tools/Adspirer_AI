import type {
  AuditAdSet,
  MetaAuditSnapshot,
  PeriodPerformance,
} from "@/lib/audit/meta-audit-data";

/**
 * Deterministic Meta audit checkpoints. Data extraction and scoring happen
 * here; the AI writes the narrative on top and must not contradict them.
 *
 * Three lenses, each with its own checks:
 *  - Tracking & measurement — "if it's not tracked correctly, it didn't
 *    happen": the optimisation event must fire, server events (CAPI) should
 *    back up the pixel, customer info share ≥ 70%, consistent attribution.
 *  - Auditor — structure, bidding/budget, compliance; every finding carries
 *    severity, evidence, a specific fix and the spend at stake.
 *  - Paid social strategist — full funnel (prospecting → retargeting),
 *    frequency 1.5–2.5 prospecting / 3–5 retargeting per 7 days, 3–5 new
 *    creative concepts a month, exclusions to stop audience overlap.
 */

export type CheckpointCategory =
  | "Tracking & measurement"
  | "Account structure"
  | "Bidding & budget"
  | "Audiences & targeting"
  | "Creative"
  | "Funnel & frequency";

export type CheckpointStatus = "pass" | "warn" | "fail" | "info" | "not_checked";
export type CheckpointSeverity = "critical" | "high" | "medium" | "low";

export type Checkpoint = {
  id: string;
  category: CheckpointCategory;
  title: string;
  status: CheckpointStatus;
  severity: CheckpointSeverity;
  /** What the data shows, with numbers. */
  evidence: string;
  /** Specific fix (required for warn/fail). */
  fix?: string;
  /** Spend at stake or expected effect, in plain words. */
  impact?: string;
  /** Spend affected in the audit period (cents), used for prioritising. */
  spendAtStakeCents?: number;
};

export type AuditScorecard = {
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  checkpoints: Checkpoint[];
  counts: Record<CheckpointStatus, number>;
  byCategory: Array<{
    category: CheckpointCategory;
    pass: number;
    warn: number;
    fail: number;
    score: number;
  }>;
  /** Failures and warnings, most severe and most expensive first. */
  priorities: Checkpoint[];
};

// Benchmarks from the paid-social and tracking playbooks.
export const BENCHMARKS = {
  prospectingFrequency: { low: 1.5, high: 2.5, max: 3.5 },
  retargetingFrequency: { low: 3, high: 5, max: 6 },
  customerInfoShare: 0.7,
  newConceptsPerMonth: 3,
  weeklyConversionsToExitLearning: 50,
  prospectingRoas: 1.5,
  retargetingRoas: 3,
  linkCtrFloor: 0.7,
} as const;

/** Meta promoted_object.custom_event_type → pixel event name. */
const EVENT_NAME: Record<string, string> = {
  PURCHASE: "Purchase",
  LEAD: "Lead",
  COMPLETE_REGISTRATION: "CompleteRegistration",
  ADD_TO_CART: "AddToCart",
  INITIATED_CHECKOUT: "InitiateCheckout",
  CONTENT_VIEW: "ViewContent",
  ADD_PAYMENT_INFO: "AddPaymentInfo",
  ADD_TO_WISHLIST: "AddToWishlist",
  CONTACT: "Contact",
  SCHEDULE: "Schedule",
  SUBMIT_APPLICATION: "SubmitApplication",
  START_TRIAL: "StartTrial",
  SUBSCRIBE: "Subscribe",
  SEARCH: "Search",
  FIND_LOCATION: "FindLocation",
  DONATE: "Donate",
  CUSTOMIZE_PRODUCT: "CustomizeProduct",
};

const SEVERITY_RANK: Record<CheckpointSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const SEVERITY_WEIGHT: Record<CheckpointSeverity, number> = { critical: 10, high: 6, medium: 3, low: 1 };

function spendOf(p: PeriodPerformance | null | undefined) {
  return p?.spendCents ?? 0;
}

function isLive(status: string) {
  return status === "ACTIVE" || status === "WITH_ISSUES";
}

/** Retargeting = targets a custom audience that isn't a lookalike. */
function isRetargeting(adSet: AuditAdSet, lookalikeIds: Set<string>) {
  return adSet.includedAudienceIds.some((id) => !lookalikeIds.has(id));
}

function list(names: string[], max = 3) {
  const shown = names.slice(0, max).map((n) => `"${n}"`).join(", ");
  return names.length > max ? `${shown} and ${names.length - max} more` : shown;
}

function daysSince(iso: string | null, now: number) {
  if (!iso) return Infinity;
  return (now - Date.parse(iso)) / 86_400_000;
}

export function evaluateCheckpoints(
  snap: MetaAuditSnapshot,
  options: { now?: Date } = {},
): AuditScorecard {
  const now = (options.now ?? new Date()).getTime();
  const cp: Checkpoint[] = [];
  const money = (cents: number) => {
    try {
      return new Intl.NumberFormat("en", {
        style: "currency",
        currency: snap.account.currency,
        currencyDisplay: "narrowSymbol",
        maximumFractionDigits: cents >= 100_000 ? 0 : 2,
      }).format(cents / 100);
    } catch {
      return `${(cents / 100).toFixed(2)} ${snap.account.currency}`;
    }
  };
  const days = snap.period.days;
  const totalSpend = spendOf(snap.totals);
  const campaignName = new Map(snap.campaigns.map((c) => [c.id, c.name]));
  const pixelById = new Map(snap.pixels.map((p) => [p.id, p]));
  const lookalikeIds = new Set(snap.audiences.filter((a) => a.subtype === "LOOKALIKE").map((a) => a.id));
  const audienceById = new Map(snap.audiences.map((a) => [a.id, a]));

  // Ad sets that matter: live now, or spent money in the period.
  const relevantAdSets = snap.adSets.filter((a) => isLive(a.status) || spendOf(a.performance) > 0);
  const liveAdSets = snap.adSets.filter((a) => isLive(a.status));
  const liveAds = snap.ads.filter((a) => isLive(a.status));
  const notChecked = (id: string, category: CheckpointCategory, title: string, why: string): Checkpoint => ({
    id,
    category,
    title,
    status: "not_checked",
    severity: "low",
    evidence: why,
  });

  // ---------------------------------------------------------------- Tracking
  const conversionAdSets = relevantAdSets.filter((a) => a.pixelId && a.customEventType);
  if (!snap.pixels.length && !conversionAdSets.length) {
    cp.push({
      id: "T1",
      category: "Tracking & measurement",
      title: "Meta pixel installed",
      status: totalSpend > 0 ? "fail" : "warn",
      severity: "critical",
      evidence: "No Meta pixel (dataset) is connected to this ad account.",
      fix: "Create a pixel in Events Manager, install it (or a partner integration) on every page, and add the Conversions API.",
      impact: "Without a pixel Meta can't optimise for or report conversions — every ad decision is blind.",
      spendAtStakeCents: totalSpend,
    });
  }

  // T2 — the event each ad set optimises for must actually be firing.
  if (conversionAdSets.length) {
    const silent: AuditAdSet[] = [];
    const quiet: AuditAdSet[] = [];
    let checked = 0;
    for (const a of conversionAdSets) {
      const pixel = pixelById.get(a.pixelId!);
      const eventName =
        a.customEventType === "OTHER"
          ? null
          : (EVENT_NAME[a.customEventType!] ?? null);
      if (!pixel?.stats7d || !eventName) continue;
      checked += 1;
      const last7 = pixel.stats7d.events[eventName] ?? 0;
      const last28 = pixel.stats28d?.events[eventName] ?? 0;
      if (last28 === 0) silent.push(a);
      else if (last7 === 0) quiet.push(a);
    }
    const affected = [...silent, ...quiet];
    const atStake = affected.reduce((s, a) => s + spendOf(a.performance), 0);
    const eventOf = (a: AuditAdSet) => EVENT_NAME[a.customEventType!] ?? a.customEventType;
    if (!checked) {
      cp.push(notChecked("T2", "Tracking & measurement", "Optimisation events are firing", "Pixel event volume could not be read."));
    } else {
      cp.push({
        id: "T2",
        category: "Tracking & measurement",
        title: "Optimisation events are firing",
        status: silent.length ? "fail" : quiet.length ? "warn" : "pass",
        severity: silent.length ? "critical" : "high",
        evidence: affected.length
          ? [
              silent.length
                ? `No ${[...new Set(silent.map(eventOf))].join("/")} events in 28 days on the pixel used by ${list(silent.map((a) => a.name))}.`
                : "",
              quiet.length
                ? `No ${[...new Set(quiet.map(eventOf))].join("/")} events in the last 7 days (some earlier) for ${list(quiet.map((a) => a.name))}.`
                : "",
            ]
              .filter(Boolean)
              .join(" ")
          : `All ${checked} conversion-optimised ad set${checked === 1 ? "" : "s"} have their event firing in the last 7 days.`,
        fix: affected.length
          ? "Open Events Manager → Test events, complete the conversion on the site, and confirm the event (and its Conversions API copy) arrives. Fix the tag or thank-you page before spending more; until then optimise for an event that does fire."
          : undefined,
        impact: affected.length
          ? `${money(atStake)} in ${days} days was optimised toward an event Meta isn't receiving, so the algorithm is bidding blind.`
          : undefined,
        spendAtStakeCents: atStake,
      });
    }
  }

  // T3 — events fire on the site but ads get no credit.
  {
    const unattributed = conversionAdSets.filter((a) => {
      const pixel = pixelById.get(a.pixelId!);
      const eventName = EVENT_NAME[a.customEventType ?? ""];
      if (!pixel?.stats28d || !eventName) return false;
      return (
        (pixel.stats28d.events[eventName] ?? 0) >= 5 &&
        spendOf(a.performance) > 0 &&
        (a.performance?.results ?? 0) === 0
      );
    });
    if (unattributed.length) {
      const atStake = unattributed.reduce((s, a) => s + spendOf(a.performance), 0);
      const a = unattributed[0]!;
      const eventName = EVENT_NAME[a.customEventType!]!;
      const fired = pixelById.get(a.pixelId!)?.stats28d?.events[eventName] ?? 0;
      cp.push({
        id: "T3",
        category: "Tracking & measurement",
        title: "Conversions are attributed to ads",
        status: "fail",
        severity: "high",
        evidence: `The pixel recorded ${fired} ${eventName} events in 28 days, but ${list(unattributed.map((x) => x.name))} got 0 results on ${money(atStake)} spend.`,
        fix: "Check that the ad's landing page leads to the page where the event fires (same domain, pixel on the thank-you page), that the event isn't only coming from other channels, and that the Conversions API sends fbc/fbp so Meta can match clicks.",
        impact: `${money(atStake)} with no measurable return — budget decisions on these ad sets are guesswork until fixed.`,
        spendAtStakeCents: atStake,
      });
    } else if (conversionAdSets.length) {
      cp.push({
        id: "T3",
        category: "Tracking & measurement",
        title: "Conversions are attributed to ads",
        status: "pass",
        severity: "high",
        evidence: "Every conversion ad set with spend either reports results or its event isn't firing (see T2).",
      });
    }
  }

  // T4 — Conversions API (server events) alongside the browser pixel.
  {
    const used = [...new Set(conversionAdSets.map((a) => a.pixelId!))]
      .map((id) => pixelById.get(id))
      .filter((p): p is NonNullable<typeof p> => Boolean(p?.stats7d));
    if (!used.length) {
      cp.push(notChecked("T4", "Tracking & measurement", "Conversions API (server events) active", "No pixel event data to check."));
    } else {
      const browserOnly = used.filter((p) => (p.stats7d!.serverShare ?? 0) === 0);
      cp.push({
        id: "T4",
        category: "Tracking & measurement",
        title: "Conversions API (server events) active",
        status: browserOnly.length ? "fail" : "pass",
        severity: "high",
        evidence: browserOnly.length
          ? `${list(browserOnly.map((p) => p.name))} only receives browser events — no server events in 7 days.`
          : used
              .map((p) => `${p.name}: ${Math.round((p.stats7d!.serverShare ?? 0) * 100)}% of events server-side`)
              .join("; "),
        fix: browserOnly.length
          ? "Set up the Conversions API (partner integration, CAPI Gateway or server GTM) and send each event with the same event_id as the pixel so Meta de-duplicates them."
          : undefined,
        impact: browserOnly.length
          ? "Browser-only tracking typically misses a meaningful share of conversions (ad blockers, iOS, cookie limits), which under-reports results and weakens optimisation."
          : undefined,
      });
      if (!browserOnly.length) {
        cp.push({
          id: "T5",
          category: "Tracking & measurement",
          title: "Pixel and server events de-duplicated",
          status: "info",
          severity: "medium",
          evidence: "Browser and server events both arrive. Meta's API doesn't expose de-duplication results.",
          fix: "In Events Manager → Overview, check each conversion event shows \"Deduplicated\" and that browser and server copies share the same event_id; otherwise conversions are double-counted.",
        });
      }
    }
  }

  // T6 — customer information on conversion events (match-quality proxy).
  {
    const shares: Array<{ pixel: string; event: string; share: number }> = [];
    for (const a of conversionAdSets) {
      const pixel = pixelById.get(a.pixelId!);
      const eventName = EVENT_NAME[a.customEventType ?? ""];
      const share = eventName ? pixel?.stats28d?.piiShare[eventName] : undefined;
      if (pixel && eventName && share != null && !shares.some((s) => s.pixel === pixel.name && s.event === eventName)) {
        shares.push({ pixel: pixel.name, event: eventName, share });
      }
    }
    if (shares.length) {
      const worst = shares.reduce((a, b) => (a.share <= b.share ? a : b));
      const target = BENCHMARKS.customerInfoShare;
      cp.push({
        id: "T6",
        category: "Tracking & measurement",
        title: "Conversion events carry customer information",
        status: worst.share >= target ? "pass" : worst.share >= 0.4 ? "warn" : "fail",
        severity: "medium",
        evidence: shares
          .map((s) => `${s.event} on ${s.pixel}: ${Math.round(s.share * 100)}% with customer info`)
          .join("; ") + ` (target ≥ ${Math.round(target * 100)}%).`,
        fix:
          worst.share >= target
            ? undefined
            : "Turn on automatic advanced matching and send hashed email/phone (and fbc/fbp) with each conversion via the Conversions API.",
        impact:
          worst.share >= target
            ? undefined
            : "Better-matched events are attributed to more of the people who clicked, so reported results and optimisation improve.",
      });
    }
  }

  // T7 — automatic advanced matching on pixels in use.
  {
    const used = [...new Set(conversionAdSets.map((a) => a.pixelId!))]
      .map((id) => pixelById.get(id))
      .filter((p): p is NonNullable<typeof p> => Boolean(p) && Boolean(p!.lastFiredTime));
    const off = used.filter((p) => !p.automaticMatching);
    if (used.length) {
      cp.push({
        id: "T7",
        category: "Tracking & measurement",
        title: "Automatic advanced matching enabled",
        status: off.length ? "warn" : "pass",
        severity: "low",
        evidence: off.length
          ? `Off on ${list(off.map((p) => p.name))}.`
          : `On for ${list(used.map((p) => p.name))}.`,
        fix: off.length ? "Events Manager → pixel → Settings → turn on Automatic advanced matching." : undefined,
      });
    }
  }

  // T8 — attribution settings consistent across live ad sets.
  {
    const windows = new Map<string, string[]>();
    for (const a of relevantAdSets) {
      if (!a.attributionWindows.length) continue;
      const key = [...a.attributionWindows].sort().join(" + ");
      windows.set(key, [...(windows.get(key) ?? []), a.name]);
    }
    if (windows.size > 1) {
      cp.push({
        id: "T8",
        category: "Tracking & measurement",
        title: "Consistent attribution settings",
        status: "warn",
        severity: "medium",
        evidence: [...windows.entries()].map(([k, v]) => `${k}: ${v.length} ad set${v.length === 1 ? "" : "s"}`).join("; "),
        fix: "Use one attribution setting (usually 7-day click + 1-day view) for ad sets you compare, or compare them only within the same setting.",
        impact: "Mixed windows make cost per result look better or worse for reasons unrelated to performance.",
      });
    } else if (windows.size === 1) {
      cp.push({
        id: "T8",
        category: "Tracking & measurement",
        title: "Consistent attribution settings",
        status: "pass",
        severity: "medium",
        evidence: `All ad sets use ${[...windows.keys()][0]}.`,
      });
    }
  }

  // T9 — stale pixels and custom conversions (housekeeping).
  {
    const stalePixels = snap.pixels.filter((p) => daysSince(p.lastFiredTime, now) > 90);
    const usedConversions = new Set(conversionAdSets.map((a) => a.customConversionId).filter(Boolean));
    const deadConversions = snap.customConversions.filter(
      (c) => !c.archived && usedConversions.has(c.id) && daysSince(c.lastFiredTime, now) > 7,
    );
    if (deadConversions.length) {
      cp.push({
        id: "T9",
        category: "Tracking & measurement",
        title: "Custom conversions in use are firing",
        status: "fail",
        severity: "critical",
        evidence: `${list(deadConversions.map((c) => c.name))} hasn't fired in over 7 days but ad sets optimise for it.`,
        fix: "Check the custom conversion's URL/event rule still matches the live site, or switch the ad sets to a standard event that fires.",
      });
    }
    if (stalePixels.length) {
      cp.push({
        id: "T10",
        category: "Tracking & measurement",
        title: "No unused pixels cluttering the account",
        status: "info",
        severity: "low",
        evidence: `${stalePixels.length} pixel${stalePixels.length === 1 ? " has" : "s have"} not fired in 90+ days: ${list(stalePixels.map((p) => p.name))}.`,
        fix: "Disconnect unused pixels from the ad account so new ad sets can't be pointed at a dead pixel by mistake.",
      });
    }
  }

  // ----------------------------------------------------------- Structure
  {
    const delivering = snap.campaigns.filter((c) => isLive(c.status));
    const stuck = delivering.filter((c) => !liveAdSets.some((a) => a.campaignId === c.id));
    cp.push({
      id: "S1",
      category: "Account structure",
      title: "Live campaigns have live ad sets",
      status: stuck.length ? "fail" : delivering.length ? "pass" : "info",
      severity: "critical",
      evidence: stuck.length
        ? `${list(stuck.map((c) => c.name))} ${stuck.length === 1 ? "is" : "are"} switched on but every ad set is off — nothing can deliver.`
        : delivering.length
          ? `All ${delivering.length} live campaign${delivering.length === 1 ? " has" : "s have"} at least one live ad set.`
          : "No campaigns are switched on.",
      fix: stuck.length ? "Turn on the intended ad set (with at least one approved ad), or pause the campaign so it's clear nothing is running." : undefined,
    });
  }
  {
    const thin = liveAdSets.filter((a) => liveAds.filter((ad) => ad.adSetId === a.id).length === 1);
    const empty = liveAdSets.filter((a) => !liveAds.some((ad) => ad.adSetId === a.id));
    const crowded = liveAdSets.filter((a) => liveAds.filter((ad) => ad.adSetId === a.id).length > 6);
    if (liveAdSets.length) {
      cp.push({
        id: "S2",
        category: "Account structure",
        title: "2–6 live ads per ad set",
        status: empty.length ? "fail" : thin.length || crowded.length ? "warn" : "pass",
        severity: empty.length ? "high" : "medium",
        evidence: [
          empty.length ? `No live ads in ${list(empty.map((a) => a.name))}.` : "",
          thin.length ? `Only one live ad in ${list(thin.map((a) => a.name))}.` : "",
          crowded.length ? `More than 6 live ads in ${list(crowded.map((a) => a.name))}.` : "",
        ].filter(Boolean).join(" ") || "Every live ad set runs 2–6 ads.",
        fix: empty.length || thin.length || crowded.length
          ? "Give each ad set 3–5 distinct concepts so Meta can find a winner; split very large ad sets so each ad gets enough delivery to learn."
          : undefined,
      });
    }
  }
  {
    const named = snap.campaigns.filter((c) => /\s[|_\-–]\s|_/.test(c.name));
    if (snap.campaigns.length >= 3) {
      const share = named.length / snap.campaigns.length;
      cp.push({
        id: "S3",
        category: "Account structure",
        title: "Consistent naming convention",
        status: share >= 0.8 ? "pass" : "warn",
        severity: "low",
        evidence: `${Math.round(share * 100)}% of ${snap.campaigns.length} campaigns follow a delimited naming pattern.`,
        fix: share >= 0.8 ? undefined : "Adopt one pattern, e.g. Client | Objective | Audience | Month, so reports group cleanly.",
      });
    }
    const pausedCount = snap.campaigns.filter((c) => !isLive(c.status)).length;
    if (pausedCount > 30) {
      cp.push({
        id: "S4",
        category: "Account structure",
        title: "Old campaigns archived",
        status: "info",
        severity: "low",
        evidence: `${pausedCount} paused campaigns are still in the account.`,
        fix: "Archive campaigns you won't restart; it reduces the chance of editing the wrong one and keeps reports readable.",
      });
    }
  }

  // ---------------------------------------------------- Bidding & budget
  {
    const limited = liveAdSets.filter((a) => a.learningStatus === "FAIL");
    const learning = liveAdSets.filter((a) => a.learningStatus === "LEARNING");
    if (liveAdSets.length) {
      const atStake = limited.reduce((s, a) => s + spendOf(a.performance), 0);
      cp.push({
        id: "B1",
        category: "Bidding & budget",
        title: "Ad sets out of learning",
        status: limited.length ? "warn" : "pass",
        severity: "high",
        evidence: [
          limited.length ? `Learning limited: ${list(limited.map((a) => a.name))}.` : "",
          learning.length ? `Still learning: ${list(learning.map((a) => a.name))}.` : "",
        ].filter(Boolean).join(" ") || "No live ad set is learning limited.",
        fix: limited.length
          ? `Each ad set needs about ${BENCHMARKS.weeklyConversionsToExitLearning} optimisation events a week. Consolidate similar ad sets, raise budget on the best one, or optimise for a higher-volume event.`
          : undefined,
        impact: limited.length ? `${money(atStake)} spent in ${days} days with unstable delivery and higher costs.` : undefined,
        spendAtStakeCents: atStake,
      });
    }
    const recentEdits = liveAdSets.filter((a) => daysSince(a.lastSignificantEdit, now) < 3);
    if (recentEdits.length) {
      cp.push({
        id: "B2",
        category: "Bidding & budget",
        title: "No recent learning resets",
        status: "info",
        severity: "medium",
        evidence: `Significant edits in the last 3 days reset learning on ${list(recentEdits.map((a) => a.name))}.`,
        fix: "Let these run 3–7 days before judging or editing them again; batch future changes.",
      });
    }
  }
  {
    const lowVolume = liveAdSets.filter((a) => {
      const results = a.performance?.results;
      return results != null && spendOf(a.performance) > 0 && (results / days) * 7 < 10;
    });
    if (lowVolume.length) {
      cp.push({
        id: "B3",
        category: "Bidding & budget",
        title: "Enough conversion volume per ad set",
        status: "warn",
        severity: "medium",
        evidence: `${list(lowVolume.map((a) => `${a.name} (${(((a.performance!.results ?? 0) / days) * 7).toFixed(1)}/week)`))} get fewer than 10 results a week.`,
        fix: "Fewer, larger ad sets learn faster. Merge overlapping audiences or move to campaign budget (CBO) so spend concentrates where results are.",
      });
    }
    // Under CBO the budget (and often the bid strategy) live on the campaign.
    const campaignById = new Map(snap.campaigns.map((c) => [c.id, c]));
    const capped = liveAdSets.filter((a) => {
      const campaign = campaignById.get(a.campaignId);
      const strategy = a.bidStrategy ?? campaign?.bidStrategy ?? null;
      const daily = a.dailyBudgetCents ?? campaign?.dailyBudgetCents ?? null;
      return Boolean(
        strategy && /COST_CAP|BID_CAP|TARGET_COST/.test(strategy) && daily && spendOf(a.performance) < daily * days * 0.5,
      );
    });
    if (capped.length) {
      cp.push({
        id: "B4",
        category: "Bidding & budget",
        title: "Bid caps not choking delivery",
        status: "warn",
        severity: "medium",
        evidence: `${list(capped.map((a) => a.name))} use a cost/bid cap and spent under half their budget.`,
        fix: "Raise the cap 15–25% or test highest-volume bidding; a cap below the market rate stops delivery.",
      });
    }
  }
  if (snap.account.spendCapCents) {
    const used = snap.account.amountSpentCents / snap.account.spendCapCents;
    cp.push({
      id: "B5",
      category: "Bidding & budget",
      title: "Account spending limit has headroom",
      status: used >= 0.95 ? "fail" : used >= 0.8 ? "warn" : "pass",
      severity: used >= 0.95 ? "critical" : "medium",
      evidence: `${Math.round(used * 100)}% of the ${money(snap.account.spendCapCents)} limit used.`,
      fix: used >= 0.8 ? "Raise the account spending limit before it stops every campaign." : undefined,
    });
  }

  // ---------------------------------------------- Audiences & targeting
  {
    const brokenInUse = snap.audiences.filter(
      (a) => !a.ready && liveAdSets.some((s) => s.includedAudienceIds.includes(a.id)),
    );
    const brokenIdle = snap.audiences.filter((a) => !a.ready).length - brokenInUse.length;
    if (snap.audiences.length) {
      cp.push({
        id: "A1",
        category: "Audiences & targeting",
        title: "Audiences in use are healthy",
        status: brokenInUse.length ? "fail" : brokenIdle > 0 ? "info" : "pass",
        severity: brokenInUse.length ? "high" : "low",
        evidence: brokenInUse.length
          ? `Live ad sets target unusable audiences: ${list(brokenInUse.map((a) => `${a.name} (${a.problem ?? "not ready"})`))}.`
          : brokenIdle > 0
            ? `${brokenIdle} unused audience${brokenIdle === 1 ? " is" : "s are"} broken or too small (not used by live ad sets).`
            : "All custom audiences are ready.",
        fix: brokenInUse.length
          ? "Rebuild or replace these audiences; a too-small source list (under ~1,000 matched people) can't seed a lookalike."
          : brokenIdle > 0
            ? "Delete or rebuild broken audiences so nobody launches with them."
            : undefined,
      });
    }
    const prospecting = liveAdSets.filter((a) => !isRetargeting(a, lookalikeIds));
    const customerLists = snap.audiences.filter((a) => a.ready && a.subtype === "CUSTOM");
    const noExclusions = prospecting.filter((a) => a.excludedAudienceIds.length === 0);
    if (prospecting.length && customerLists.length) {
      cp.push({
        id: "A2",
        category: "Audiences & targeting",
        title: "Prospecting excludes existing customers",
        status: noExclusions.length ? "warn" : "pass",
        severity: "medium",
        evidence: noExclusions.length
          ? `${list(noExclusions.map((a) => a.name))} ${noExclusions.length === 1 ? "doesn't" : "don't"} exclude any audience, while ${customerLists.length} customer/website list${customerLists.length === 1 ? " exists" : "s exist"}.`
          : "Prospecting ad sets exclude existing audiences.",
        fix: noExclusions.length
          ? "Exclude customers, recent converters and (if you run retargeting) website visitors from prospecting, so new-customer budget isn't spent on people you already have."
          : undefined,
      });
    }
    const tooSmall = liveAdSets.flatMap((a) =>
      a.includedAudienceIds
        .map((id) => audienceById.get(id))
        .filter((aud): aud is NonNullable<typeof aud> => Boolean(aud?.sizeLower && aud.sizeLower < 1000))
        .map((aud) => `${aud.name} in ${a.name}`),
    );
    if (tooSmall.length) {
      cp.push({
        id: "A3",
        category: "Audiences & targeting",
        title: "Targeted audiences large enough",
        status: "warn",
        severity: "medium",
        evidence: `Under 1,000 people: ${list(tooSmall)}.`,
        fix: "Widen the audience (longer retention window, add sources) or merge it with a similar ad set.",
      });
    }
    const singlePlatform = liveAdSets.filter((a) => a.publisherPlatforms.length === 1);
    if (singlePlatform.length) {
      cp.push({
        id: "A4",
        category: "Audiences & targeting",
        title: "Placements not over-restricted",
        status: "info",
        severity: "low",
        evidence: `${list(singlePlatform.map((a) => `${a.name} (${a.publisherPlatforms[0]})`))} run on one platform only.`,
        fix: "Test Advantage+ placements unless the creative only suits one platform; restricted placements usually raise CPM.",
      });
    }
  }

  // ------------------------------------------------------------- Creative
  {
    const liveCampaignIds = new Set(snap.campaigns.filter((c) => isLive(c.status)).map((c) => c.id));
    const rejected = snap.ads.filter(
      (a) =>
        (a.status === "DISAPPROVED" || a.status === "WITH_ISSUES") &&
        (liveCampaignIds.has(a.campaignId) || liveAdSets.some((s) => s.id === a.adSetId)),
    );
    cp.push({
      id: "C1",
      category: "Creative",
      title: "No rejected ads in live campaigns",
      status: rejected.length ? "fail" : "pass",
      severity: "high",
      evidence: rejected.length
        ? `${list(rejected.map((a) => `${a.name}${a.issue ? ` — ${a.issue}` : ""}`))}.`
        : "No switched-on campaign contains a rejected or limited ad.",
      fix: rejected.length
        ? "Read the reason in Account Quality, fix the copy/visual and request review, or replace the ad. Repeated rejections can restrict the account."
        : undefined,
    });
  }
  {
    const recent = snap.ads.filter((a) => daysSince(a.createdTime, now) <= 30);
    if (totalSpend > 0) {
      const target = BENCHMARKS.newConceptsPerMonth;
      cp.push({
        id: "C2",
        category: "Creative",
        title: `${target}+ new creative concepts tested in 30 days`,
        status: recent.length >= target ? "pass" : recent.length ? "warn" : "fail",
        severity: "medium",
        evidence: `${recent.length} new ad${recent.length === 1 ? "" : "s"} created in the last 30 days.`,
        fix: recent.length >= target ? undefined : "Launch 3–5 genuinely different concepts a month (new hook, angle or format), not small copy tweaks.",
        impact: recent.length >= target ? undefined : "Without new concepts, frequency climbs and cost per result drifts up as audiences tire of the same ads.",
      });
    }
    const formats = new Set(liveAds.map((a) => a.format).filter(Boolean));
    if (liveAds.length >= 3) {
      cp.push({
        id: "C3",
        category: "Creative",
        title: "Mix of creative formats",
        status: formats.size >= 2 ? "pass" : "warn",
        severity: "low",
        evidence: `Live ads use ${formats.size ? [...formats].join(", ").toLowerCase() : "an unknown format"}.`,
        fix: formats.size >= 2 ? undefined : "Add a different format (short vertical video, carousel or static) — formats reach different people at different costs.",
      });
    }
    const tired = liveAds.filter((a) => (a.performance?.frequency ?? 0) >= 4 && spendOf(a.performance) > 0);
    if (tired.length) {
      cp.push({
        id: "C4",
        category: "Creative",
        title: "No fatigued ads",
        status: "warn",
        severity: "medium",
        evidence: `Frequency 4+ on ${list(tired.map((a) => `${a.name} (${a.performance!.frequency.toFixed(1)})`))}.`,
        fix: "Rotate in fresh creative for these audiences or widen them.",
      });
    }
  }

  // ---------------------------------------------------- Funnel & frequency
  {
    const spending = relevantAdSets.filter((a) => spendOf(a.performance) > 0);
    const retargeting = spending.filter((a) => isRetargeting(a, lookalikeIds));
    const prospecting = spending.filter((a) => !isRetargeting(a, lookalikeIds));
    const rtSpend = retargeting.reduce((s, a) => s + spendOf(a.performance), 0);
    const spendTotal = spending.reduce((s, a) => s + spendOf(a.performance), 0);
    if (spendTotal > 0) {
      const share = rtSpend / spendTotal;
      cp.push({
        id: "F1",
        category: "Funnel & frequency",
        title: "Full funnel: prospecting and retargeting",
        status: retargeting.length === 0 ? "warn" : share > 0.5 ? "warn" : "pass",
        severity: "medium",
        evidence: `${Math.round((1 - share) * 100)}% of spend on prospecting (${prospecting.length} ad set${prospecting.length === 1 ? "" : "s"}), ${Math.round(share * 100)}% on retargeting (${retargeting.length}).`,
        fix:
          retargeting.length === 0
            ? "Add a small retargeting ad set (website visitors, video viewers, page/lead-form engagers in the last 30 days) to convert people who already showed interest."
            : share > 0.5
              ? "Retargeting can only harvest demand that prospecting creates — shift budget back toward prospecting so the pool doesn't shrink."
              : undefined,
      });
    }
    // Benchmarks are per 7 days: use the measured 7-day frequency (a longer
    // period's frequency can't be pro-rated — reach de-duplicates over time).
    const weekly = (a: AuditAdSet) =>
      a.frequency7d ?? (days <= 7 ? (a.performance?.frequency ?? null) : null);
    const measured = spending.filter((a) => weekly(a) != null);
    const highFreq = measured.filter((a) => {
      const limit = isRetargeting(a, lookalikeIds)
        ? BENCHMARKS.retargetingFrequency.max
        : BENCHMARKS.prospectingFrequency.max;
      return (weekly(a) ?? 0) > limit;
    });
    if (measured.length) {
      cp.push({
        id: "F2",
        category: "Funnel & frequency",
        title: "Frequency within healthy range",
        status: highFreq.length ? "warn" : "pass",
        severity: "medium",
        evidence: highFreq.length
          ? `${list(highFreq.map((a) => `${a.name} (${(weekly(a) ?? 0).toFixed(1)} in 7 days, ${isRetargeting(a, lookalikeIds) ? "retargeting" : "prospecting"})`))} — above the ${BENCHMARKS.prospectingFrequency.low}–${BENCHMARKS.prospectingFrequency.high} prospecting or ${BENCHMARKS.retargetingFrequency.low}–${BENCHMARKS.retargetingFrequency.high} retargeting 7-day range.`
          : `7-day frequency is within range for all ${measured.length} measured ad set${measured.length === 1 ? "" : "s"} (${BENCHMARKS.prospectingFrequency.low}–${BENCHMARKS.prospectingFrequency.high} prospecting, ${BENCHMARKS.retargetingFrequency.low}–${BENCHMARKS.retargetingFrequency.high} retargeting).`,
        fix: highFreq.length ? "Widen these audiences, add new creative, or lower budget so the same people aren't shown the ad repeatedly." : undefined,
      });
    }
    const roasSets = spending.filter((a) => a.performance?.roas != null);
    const weak = roasSets.filter((a) => {
      const target = isRetargeting(a, lookalikeIds) ? BENCHMARKS.retargetingRoas : BENCHMARKS.prospectingRoas;
      return (a.performance!.roas ?? 0) < target;
    });
    if (roasSets.length) {
      cp.push({
        id: "F3",
        category: "Funnel & frequency",
        title: "ROAS meets funnel-stage targets",
        status: weak.length ? "warn" : "pass",
        severity: "high",
        evidence: weak.length
          ? `${list(weak.map((a) => `${a.name} (${a.performance!.roas!.toFixed(2)}×)`))} below ${BENCHMARKS.prospectingRoas}× prospecting / ${BENCHMARKS.retargetingRoas}× retargeting.`
          : `All purchase ad sets meet ${BENCHMARKS.prospectingRoas}× (prospecting) / ${BENCHMARKS.retargetingRoas}× (retargeting).`,
        fix: weak.length ? "Cut spend on the weakest ad sets and test new offers/creative; check margins before scaling anything under target." : undefined,
        spendAtStakeCents: weak.reduce((s, a) => s + spendOf(a.performance), 0),
      });
    }
    const trafficSets = spending.filter((a) => (a.performance?.impressions ?? 0) >= 1000);
    const lowCtr = trafficSets.filter((a) => (a.performance?.linkCtr ?? 0) < BENCHMARKS.linkCtrFloor);
    if (trafficSets.length) {
      cp.push({
        id: "F4",
        category: "Funnel & frequency",
        title: `Link CTR at or above ${BENCHMARKS.linkCtrFloor}%`,
        status: lowCtr.length ? "warn" : "pass",
        severity: "low",
        evidence: lowCtr.length
          ? `${list(lowCtr.map((a) => `${a.name} (${a.performance!.linkCtr.toFixed(2)}%)`))}.`
          : "All ad sets with 1,000+ impressions clear the floor.",
        fix: lowCtr.length ? "Test stronger hooks in the first 3 seconds/line and a clearer offer; low CTR also raises CPM." : undefined,
      });
    }
  }

  // ------------------------------------------------------------ Scoring
  const counts: Record<CheckpointStatus, number> = { pass: 0, warn: 0, fail: 0, info: 0, not_checked: 0 };
  for (const c of cp) counts[c.status] += 1;

  const scoreOf = (items: Checkpoint[]) => {
    let max = 0;
    let got = 0;
    for (const c of items) {
      if (c.status === "info" || c.status === "not_checked") continue;
      const w = SEVERITY_WEIGHT[c.severity];
      max += w;
      got += c.status === "pass" ? w : c.status === "warn" ? w * 0.5 : 0;
    }
    return max ? Math.round((got / max) * 100) : 100;
  };
  const score = scoreOf(cp);
  const categories = [...new Set(cp.map((c) => c.category))];

  return {
    score,
    grade: score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : score >= 40 ? "D" : "F",
    checkpoints: cp,
    counts,
    byCategory: categories.map((category) => {
      const items = cp.filter((c) => c.category === category);
      return {
        category,
        pass: items.filter((c) => c.status === "pass").length,
        warn: items.filter((c) => c.status === "warn").length,
        fail: items.filter((c) => c.status === "fail").length,
        score: scoreOf(items),
      };
    }),
    priorities: cp
      .filter((c) => c.status === "fail" || c.status === "warn")
      .sort(
        (a, b) =>
          (a.status === "fail" ? 0 : 1) - (b.status === "fail" ? 0 : 1) ||
          SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
          (b.spendAtStakeCents ?? 0) - (a.spendAtStakeCents ?? 0),
      ),
  };
}

/** Campaign name helper for renderers. */
export function campaignNames(snap: MetaAuditSnapshot) {
  return new Map(snap.campaigns.map((c) => [c.id, c.name]));
}

/**
 * Ad sets whose optimisation event hasn't been recorded in the last 7 days.
 * Scaling their budget only buys more unmeasured traffic, so the optimise
 * flow holds budget increases for them.
 */
export function adSetsWithSilentTracking(snap: MetaAuditSnapshot): Map<string, string> {
  const pixelById = new Map(snap.pixels.map((p) => [p.id, p]));
  const out = new Map<string, string>();
  for (const a of snap.adSets) {
    if (!a.pixelId || !a.customEventType) continue;
    const eventName = EVENT_NAME[a.customEventType];
    const stats = pixelById.get(a.pixelId)?.stats7d;
    if (!eventName || !stats) continue;
    if ((stats.events[eventName] ?? 0) === 0) out.set(a.id, eventName);
  }
  return out;
}
