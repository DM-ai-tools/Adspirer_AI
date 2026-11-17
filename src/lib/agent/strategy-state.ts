import type { AgentHistoryMessage } from "@/lib/agent/history";
import { offerOptionLines, type StrategyOfferRecord } from "@/lib/agent/strategy-offer";

/**
 * Where a strategy stands in this chat, worked out from the messages rather than from the operator's
 * wording, so the classifier and the strategy step can understand a reply in context.
 *
 * A strategy runs in two steps: a target proposal (safe / recommended / bold), then the full plan.
 * The proposal is "open" from when it is shown until a plan is written, however many other turns
 * happen in between: an off-track reply (an action list, a question) does not close it.
 */

/** The proposal's own heading ("# Strategy — <account>"); it survives the history's truncation. */
const PROPOSAL_TITLE = /^#\s*Strategy\s*[—–-]\s*\S/m;
/** The closing line the code appends to every proposal. */
const PROPOSAL_MARKER = "pick a target for the strategy";
/** Every full plan (account and lead) has this section. */
const PLAN_SECTION = /^##\s*1\.\s*Strategy header\b/m;
/** A proposal older than this many messages is no longer what the operator is answering. */
const LOOKBACK_MESSAGES = 12;

export type StrategyState = {
  /** A target proposal is waiting for a pick: shown, and no plan written since. */
  open: boolean;
  /** The options as the proposal showed them ("Recommended — 1.3 purchases/day, $90.08/day, …"); empty when unreadable. */
  options: string[];
  /** How many messages back the proposal is (0 = the assistant's last message). */
  messagesAgo: number | null;
};

const CLOSED: StrategyState = { open: false, options: [], messagesAgo: null };

function isProposal(content: string): boolean {
  return !PLAN_SECTION.test(content) && (content.toLowerCase().includes(PROPOSAL_MARKER) || PROPOSAL_TITLE.test(content));
}

/** The option rows of the proposal's targets table, as short text. */
export function proposalOptions(content: string): string[] {
  const rows = content.split("\n").filter((l) => /^\|\s*\**\s*(safe|recommended|bold)\b/i.test(l.trim()));
  if (!rows.length) return [];
  const header = content
    .split("\n")
    .find((l) => /^\|\s*option\s*\|/i.test(l.trim()))
    ?.split("|")
    .map((c) => c.replace(/\*/g, "").trim())
    .filter(Boolean);
  return rows.map((row) => {
    const cells = row.split("|").map((c) => c.replace(/\*/g, "").trim()).filter(Boolean);
    const [name, ...rest] = cells;
    const labelled = header && header.length === cells.length ? rest.map((v, i) => `${header[i + 1]}: ${v}`) : rest;
    return `${name} — ${labelled.join(", ")}`;
  });
}

/**
 * @param history the chat as the agent sees it (past replies may be cut short)
 * @param fullProposal the latest proposal in full, when loaded separately; used for the options when
 *   the history's copy was cut before its table
 */
export function strategyState(
  history: AgentHistoryMessage[],
  fullProposal?: string | null,
  /** The offer the turns stored on their tasks; when present it decides, and the text reading is only a fallback. */
  stored?: StrategyOfferRecord | null,
): StrategyState {
  if (stored) {
    if (stored.status === "closed") return CLOSED;
    const assistant = history.filter((m) => m.role === "assistant");
    const at = assistant.findLastIndex((m) => isProposal(m.content));
    return { open: true, options: offerOptionLines(stored), messagesAgo: at >= 0 ? assistant.length - 1 - at : null };
  }
  const recent = history.slice(-LOOKBACK_MESSAGES);
  const assistant = recent.map((m, i) => ({ m, i })).filter(({ m }) => m.role === "assistant");
  const proposalAt = assistant.findLast(({ m }) => isProposal(m.content));
  if (!proposalAt) return CLOSED;
  const planAfter = assistant.some(({ m, i }) => i > proposalAt.i && PLAN_SECTION.test(m.content));
  if (planAfter) return CLOSED;
  const options = proposalOptions(proposalAt.m.content);
  return {
    open: true,
    options: options.length ? options : fullProposal ? proposalOptions(fullProposal) : [],
    messagesAgo: assistant.length - 1 - assistant.indexOf(proposalAt),
  };
}

/** The state as plain lines for the classifier's prompt; empty when no strategy is waiting. */
export function strategyStateLines(state: StrategyState): string[] {
  if (!state.open) return [];
  return [
    "Conversation state: a strategy is in progress. The assistant proposed targets for the operator to pick from" +
      (state.messagesAgo ? ` (${state.messagesAgo} assistant message${state.messagesAgo === 1 ? "" : "s"} ago)` : " (its last message)") +
      ", and no full strategy plan has been written since. The operator has not picked yet, unless this message does.",
    ...(state.options.length ? ["Options offered:", ...state.options.map((o) => `- ${o}`)] : []),
    "It is a pick only if the operator chooses an option, gives their own target, or says to go ahead. Thanks or an acknowledgement on its own (\"thanks\", \"great, thanks\", \"got it\") is chat with no pick; a question about the options is chat with no pick.",
  ];
}
