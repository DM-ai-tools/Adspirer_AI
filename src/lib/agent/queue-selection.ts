import type { AgentToolCallProposal } from "@/lib/agent/adspirer-agent";
import { focusesOfTool, toolKindOf, type ChangeKind } from "@/lib/agent/optimization-capabilities";
import { entityIdsOf, type OfferedProposal } from "@/lib/agent/optimize-evidence";
import type { BriefPeriod, RequestBrief } from "@/lib/agent/request-brief";
import { canonicalJson } from "@/lib/approvals/service";
import { humanToolLabel } from "@/lib/tools/display-labels";

/**
 * Which proposed changes go to Approvals. The rule is the operator's words: a
 * change is queued only when they asked for changes, and only the ones they
 * pointed at (by number, by area, by name, or as "all of these"). Everything
 * here is pure and deterministic, so the same message always queues the same
 * thing, and the reply's "queued / not queued" block can be written from it.
 */

export type QueueDecision = {
  queue: AgentToolCallProposal[];
  /** One line per queued change, in the same order, for the reply. */
  labels: string[];
  /** The numbers the operator saw for what is being queued. */
  queuedRefs: number[];
  skipped: Array<{ label: string; reason: string }>;
};

/** The numbered list a turn showed, kept so a later "queue #2" means what it meant then. */
export type StoredOffer = {
  createdAt: string;
  items: OfferedProposal[];
  period: BriefPeriod | null;
  scopeMentions: string[];
};

const NO_LIST =
  "I have no earlier list of proposals to queue from. Ask me to optimise first, or say exactly what to change.";

/** Args that define a change, without bookkeeping keys or the rationale text. */
function canonicalArgs(args: Record<string, unknown>): string {
  return canonicalJson(Object.fromEntries(Object.entries(args).filter(([k]) => !k.startsWith("_") && k !== "rationale")));
}

const keyOf = (tool: string, ids: string[]) => `${tool}:${[...ids].sort().join(",")}`;

const callLabel = (call: AgentToolCallProposal): string => humanToolLabel(call.name);

/**
 * How a queue request picks what to queue. "reference": numbers or "all of these", against the
 * list the operator saw. "area": "the budget increases", against that same list. "fresh": "optimise
 * and queue the changes", against this turn's new list. "direct": an instruction about something
 * they named ("pause the Retargeting ad set"), which is that change and nothing else.
 */
export type QueueMode = "none" | "reference" | "area" | "fresh" | "direct";

export function queueModeOf(brief: RequestBrief): QueueMode {
  const q = brief.queue;
  if (brief.mode !== "act" || !q.requested) return "none";
  // Old briefs have no flag: a queue request used queue words.
  const phrased = q.phrased !== false;
  if (q.refs.length > 0) return "reference";
  if (q.all && !brief.optimizationAsk) return "reference";
  // A kind word alone ("pause") is an area request only when queue words were used; without the
  // flag it is a direct instruction, which can never queue from an earlier list.
  const byKind = q.phrased === true && (q.kinds?.length ?? 0) > 0;
  if (phrased && !brief.optimizationAsk && (q.focus.length > 0 || byKind)) return "area";
  if (phrased && brief.optimizationAsk) return "fresh";
  return "direct";
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Which way a budget change moves, when both numbers are known. */
function budgetDirection(args: Record<string, unknown>): "increase" | "decrease" | null {
  const next = num(args.daily_budget_cents);
  const prev = num(args.previous_daily_budget_cents);
  if (next == null || prev == null || next === prev) return null;
  return next > prev ? "increase" : "decrease";
}

/**
 * Is this change the kind the operator named? "The pauses" never takes a budget change,
 * "raise the budget" never takes a pause. No kind named means no restriction here.
 */
function kindAllows(kinds: ChangeKind[] | undefined, tool: string, args: Record<string, unknown>): boolean {
  if (!kinds?.length) return true;
  const wants = new Set(kinds);
  switch (toolKindOf(tool)) {
    case "pause":
      return wants.has("pause");
    case "resume":
      return wants.has("resume");
    case "budget": {
      const direction = budgetDirection(args);
      return direction ? wants.has(direction) : wants.has("increase") || wants.has("decrease");
    }
    case "schedule":
    case "bid":
    case "placements":
    case "audiences":
      // "Raise the bid cap" is a direction word for a bid; a pause or resume word is not.
      return !wants.has("pause") && !wants.has("resume");
    default:
      return false;
  }
}

export function selectForQueue(input: {
  brief: RequestBrief;
  /** This turn's numbered proposals, built from live data. */
  offered: OfferedProposal[];
  /** The numbered list shown on an earlier turn (null when there was none). */
  previousOffer: OfferedProposal[] | null;
  /** Changes the writer model proposed in its reply. */
  writerCalls: AgentToolCallProposal[];
  /** Ids in scope for the names the operator gave: each named entity and everything under it. */
  namedEntityIds: string[];
  /** Ids of the entities the operator named themselves, not what sits under them. Only these can be changed by a direct instruction. */
  directEntityIds: string[];
  /** Ids the operator said to leave alone. */
  excludedEntityIds?: string[];
}): QueueDecision {
  const { brief } = input;
  const skipped: QueueDecision["skipped"] = [];
  const mode = queueModeOf(brief);

  if (mode === "none") {
    return {
      queue: [],
      labels: [],
      queuedRefs: [],
      skipped: input.writerCalls.map((c) => ({
        label: callLabel(c),
        reason: "changes are only queued when you ask for them",
      })),
    };
  }

  const q = brief.queue;
  const named = new Set(input.namedEntityIds);
  const direct = new Set(input.directEntityIds);
  const excluded = new Set(input.excludedEntityIds ?? []);
  const exceptRefs = new Set(q.exceptRefs ?? []);
  const exceptFocus = new Set(q.exceptFocus ?? []);
  const queue: AgentToolCallProposal[] = [];
  const labels: string[] = [];
  const queuedRefs: number[] = [];
  /** key → the number the operator saw (null for a change that came from their own instruction). */
  const queuedKeys = new Map<string, number | null>();
  /** Proposals taken for a direct instruction: the writer repeating one is not news. */
  const directTaken = new Set<string>();

  const fresh = new Map(input.offered.map((o) => [keyOf(o.tool, o.entityIds), o]));
  const labelOf = (o: OfferedProposal, shown = o.ref) => `#${shown} ${o.label}`;
  const isExcluded = (o: { entityIds: string[] }) => o.entityIds.some((id) => excluded.has(id));
  /** Numbers win over a kind word: "queue #3" is #3 whatever it does. */
  const useKinds = q.refs.length === 0;
  const matches = (o: OfferedProposal) =>
    (!q.focus.length || q.focus.includes(o.focus)) &&
    (!q.entities.length || o.entityIds.some((id) => named.has(id))) &&
    (!useKinds || kindAllows(q.kinds, o.tool, o.args));
  const leftOut = (o: OfferedProposal) => exceptRefs.has(o.ref) || exceptFocus.has(o.focus);

  const take = (o: OfferedProposal, shown: number) => {
    const key = keyOf(o.tool, o.entityIds);
    if (queuedKeys.has(key)) return;
    queuedKeys.set(key, shown);
    queuedRefs.push(shown);
    labels.push(labelOf(o, shown));
    queue.push({ name: o.tool, args: o.args, ...(o.rationale ? { rationale: o.rationale } : {}) });
  };

  /** A proposal from the earlier list: queued only if it is unchanged in today's live build. */
  const reconcile = (previous: OfferedProposal) => {
    if (isExcluded(previous)) {
      skipped.push({ label: labelOf(previous), reason: "you asked me to leave that alone" });
      return;
    }
    const now = fresh.get(keyOf(previous.tool, previous.entityIds));
    if (!now) {
      skipped.push({ label: labelOf(previous), reason: "it no longer applies to the live account" });
    } else if (canonicalArgs(now.args) !== canonicalArgs(previous.args)) {
      skipped.push({
        label: labelOf(previous),
        reason: "it changed since it was shown (the live numbers moved); ask me to optimise again for a fresh proposal",
      });
    } else {
      take(now, previous.ref);
    }
  };

  if (mode === "reference" || mode === "area") {
    const previous = input.previousOffer;
    if (!previous?.length) {
      skipped.push({ label: "Nothing to queue", reason: NO_LIST });
    } else {
      let base: OfferedProposal[];
      if (q.refs.length) {
        base = [];
        for (const ref of q.refs) {
          const found = previous.find((p) => p.ref === ref);
          if (found) base.push(found);
          else skipped.push({ label: `#${ref}`, reason: `there is no proposal #${ref} in the list I showed` });
        }
      } else {
        base = previous;
      }
      for (const p of base) {
        if (leftOut(p) && matches(p)) {
          skipped.push({ label: labelOf(p), reason: "you asked me to leave that out" });
          continue;
        }
        if (matches(p)) reconcile(p);
      }
      if (mode === "area") {
        const shown = new Set(previous.map((p) => keyOf(p.tool, p.entityIds)));
        for (const o of input.offered) {
          if (matches(o) && !shown.has(keyOf(o.tool, o.entityIds)) && !isExcluded(o) && !leftOut(o)) {
            skipped.push({ label: labelOf(o), reason: "it wasn't in the list I showed you; ask for it by number" });
          }
        }
      }
    }
  } else if (mode === "fresh") {
    if (exceptRefs.size) {
      skipped.push({
        label: "Nothing to queue",
        reason: "numbers refer to a list you have already seen; ask me to optimise first, then say which numbers to leave out",
      });
    } else {
      for (const o of input.offered) {
        if (brief.focus.length && !brief.focus.includes(o.focus)) continue;
        if (!matches(o)) continue;
        if (isExcluded(o)) {
          skipped.push({ label: labelOf(o), reason: "you asked me to leave that alone" });
          continue;
        }
        if (exceptFocus.has(o.focus)) {
          skipped.push({ label: labelOf(o), reason: "you asked me to leave that out" });
          continue;
        }
        take(o, o.ref);
      }
    }
  } else if (!q.entities.length) {
    skipped.push({
      label: "Nothing to queue",
      reason: "say which changes to queue, by number (#1, #2…), by area (\"the budget changes\") or \"all of these\"",
    });
  } else {
    // A direct instruction. A pause or resume carries no value of its own, so the code-built
    // proposal for exactly that entity is what is queued. Anything with a value (a budget, a bid,
    // an end date) is the operator's number, which only the writer's own call carries.
    for (const o of input.offered) {
      const kind = toolKindOf(o.tool);
      if (kind !== "pause" && kind !== "resume") continue;
      if (!q.kinds?.length || !kindAllows(q.kinds, o.tool, o.args)) continue;
      if (!o.entityIds.length || !o.entityIds.every((id) => direct.has(id))) continue;
      if (isExcluded(o)) continue;
      directTaken.add(keyOf(o.tool, o.entityIds));
      take(o, o.ref);
    }
  }

  // The writer's own proposals count only as the operator's direct instruction: the very
  // campaign, ad set or ad they named (not what sits under it), the kind of change they asked
  // for, never a create, and not already covered above.
  const kindsNamed = (q.kinds?.length ?? 0) > 0;
  // With no kind of change and no area named there is nothing to hold a second change to: one is
  // queued, and the rest wait for a request of their own.
  const unspecified = !kindsNamed && brief.focus.length === 0;
  let unspecifiedTaken = 0;
  for (const call of input.writerCalls) {
    const ids = entityIdsOf(call.args);
    const key = keyOf(call.name, ids);
    if (queuedKeys.has(key)) {
      const ref = queuedKeys.get(key);
      if (ref != null && !directTaken.has(key)) skipped.push({ label: callLabel(call), reason: `it is already queued as #${ref}` });
      continue;
    }
    const kind = toolKindOf(call.name);
    const focusOk = !brief.focus.length || focusesOfTool(call.name).some((f) => brief.focus.includes(f));
    // A named kind ("pause", "raise") decides pause, resume and budget changes; an area decides the rest.
    const askedFor =
      kind !== null &&
      kind !== "create" &&
      kindAllows(q.kinds, call.name, call.args) &&
      // A pause or resume is only ever the operator's own word for it, never inferred from an area.
      ((kind !== "pause" && kind !== "resume") || kindsNamed) &&
      (focusOk || (kindsNamed && (kind === "pause" || kind === "resume" || kind === "budget")));
    const targetOk = direct.size > 0 && ids.length > 0 && ids.every((id) => direct.has(id));
    if (!askedFor || !targetOk || ids.some((id) => excluded.has(id))) {
      skipped.push({ label: callLabel(call), reason: "that is not something you asked me to change" });
      continue;
    }
    if (unspecified && unspecifiedTaken >= 1) {
      skipped.push({
        label: callLabel(call),
        reason: "you didn't say what kind of change you wanted, so I queued one change; ask for this one on its own",
      });
      continue;
    }
    if (unspecified) unspecifiedTaken += 1;
    queuedKeys.set(key, null);
    labels.push(`${callLabel(call)}${ids.length ? ` (${ids.join(", ")})` : ""}`);
    queue.push(call);
  }

  if (!queue.length && !skipped.length) {
    skipped.push({ label: "Nothing to queue", reason: "no proposal matched what you asked to queue" });
  }
  return { queue, labels, queuedRefs, skipped };
}

/** The reply's honest account of what went to Approvals and what did not. */
/** Where a change an earlier message already put in Approvals really stands. */
export type AlreadyQueued = { label: string; status: string };

const ALREADY_STATUS: Record<string, string> = {
  pending: "queued earlier, still waiting for review",
  edited: "queued earlier and edited, still waiting for approval",
  approved: "already approved, waiting to be applied",
  executing: "already approved and being applied now",
};

export function renderQueueBlock(input: {
  queued: string[];
  /** Changes an earlier message already put in Approvals; they are not queued a second time. */
  alreadyQueued?: Array<string | AlreadyQueued>;
  notQueued: Array<{ label: string; reason: string }>;
}): string {
  const already = (input.alreadyQueued ?? []).map((a) => (typeof a === "string" ? { label: a, status: "pending" } : a));
  if (!input.queued.length && !already.length && !input.notQueued.length) return "";
  return [
    ...(input.queued.length || !already.length
      ? [
          `### Queued in Approvals (${input.queued.length})`,
          ...(input.queued.length ? input.queued.map((l) => `- ${l}`) : ["- Nothing was queued."]),
        ]
      : []),
    ...(already.length
      ? [
          ...(input.queued.length ? [""] : []),
          `### Already in Approvals (${already.length})`,
          ...already.map((a) => `- ${a.label} (${ALREADY_STATUS[a.status] ?? ALREADY_STATUS.pending})`),
        ]
      : []),
    ...(input.notQueued.length
      ? ["", `### Not queued (${input.notQueued.length})`, ...input.notQueued.map((n) => `- ${n.label}: ${n.reason}`)]
      : []),
  ].join("\n");
}

/** Does this turn queue from a list shown earlier (by number, by "all", or by an area it named)? */
export function isReferencingQueue(brief: RequestBrief): boolean {
  const mode = queueModeOf(brief);
  return mode === "reference" || mode === "area";
}

/**
 * A turn that queues from an earlier list keeps that list's period, scope and
 * areas, so the live build it is compared against covers the same ground.
 */
export function adoptOfferContext(brief: RequestBrief, stored: StoredOffer): RequestBrief {
  if (!isReferencingQueue(brief)) return brief;
  let next = brief;
  if (!brief.period?.explicit && stored.period) next = { ...next, period: { ...stored.period, explicit: false } };
  if (!brief.scope.mentions.length && stored.scopeMentions.length) next = { ...next, scope: { mentions: [...stored.scopeMentions] } };
  next = { ...next, focus: [...new Set([...brief.focus, ...stored.items.map((i) => i.focus)])] };
  return next;
}

/** What the writer is told about queueing this turn, so its prose can neither promise more nor less. */
export function renderQueueDecisionEvidence(brief: RequestBrief, decision: QueueDecision): string {
  if (brief.mode !== "act" || !brief.queue.requested) {
    return [
      "### Queue decision",
      "- No changes are being queued this turn: the operator has not asked for any. Do not say anything was queued or sent to Approvals; you may say which numbered proposals they can ask to queue.",
    ].join("\n");
  }
  if (queueModeOf(brief) === "direct" && brief.queue.entities.length) {
    const names = brief.queue.entities.join(", ");
    return [
      "### Queue decision",
      `- The operator asked for this change directly, on: ${names}. Only that change can go to Approvals, and only on exactly what they named (not its ad sets or ads, not another entity).`,
      ...(decision.labels.length
        ? [
            "- The system has already matched it from the live list and will queue it (do not write tool JSON for these):",
            ...decision.labels.map((l) => `  - ${l}`),
          ]
        : [
            "- It is not on the numbered list. Write the single tool JSON for exactly the change they asked for, on exactly what they named, with the values they gave. Do not add other changes.",
          ]),
      "- Do not say it is queued. The system lists what was queued, and what was not, under your reply.",
    ].join("\n");
  }
  return [
    "### Queue decision (final)",
    "This decision is final. The system lists it under your reply; do not add, drop or renumber anything, and do not claim more was queued.",
    decision.labels.length ? "Queued in Approvals:" : "Queued in Approvals: nothing.",
    ...decision.labels.map((l) => `- ${l}`),
    ...(decision.skipped.length ? ["Not queued:", ...decision.skipped.map((n) => `- ${n.label}: ${n.reason}`)] : []),
  ].join("\n");
}

const QUEUED_CLAIM = /\b(?:queued|sent to approvals|waiting in approvals|added to approvals)\b/i;
const NOT_A_CLAIM =
  /\b(?:not|nothing|no|never|until|unless|once|when|if|can be|could be|will be|would be|to be|ready to be|yet|yesterday|earlier|previously|ago|last (?:week|month|time|night)|approved|rejected|declined|executed|applied|meta)\b|n't\b/i;

/**
 * Drop sentences that say something WAS queued, for a turn that queued nothing.
 * Honest statements ("nothing is queued yet", "these can be queued") are kept.
 */
export function stripQueuedClaims(text: string): string {
  const kept = text.split("\n").flatMap((line) => {
    if (/^\s*(?:\||#)/.test(line) || !QUEUED_CLAIM.test(line)) return [line];
    const sentences = line.split(/(?<=[.!?])\s+/);
    const remaining = sentences.filter((s) => !(QUEUED_CLAIM.test(s) && !NOT_A_CLAIM.test(s)));
    return remaining.length === sentences.length ? [line] : remaining.length ? [remaining.join(" ")] : [];
  });
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
