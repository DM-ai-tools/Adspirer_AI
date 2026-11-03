/**
 * Which chat message each creative still belongs under.
 *
 * Every request ("4 variations", then "a few more") starts its own batch, and each
 * batch must sit under the reply to the request that made it, so the operator can
 * tell which images answered which message. A draft belongs to the turn in which it
 * first appeared in a message snapshot; later snapshots (reworks, picks) never move it.
 */

export type GroupableDraft = { id: string };

export type GroupableMessage<D extends GroupableDraft> = {
  id: string;
  role: string;
  content: string;
  drafts?: D[];
};

export type CreativeGroup<D extends GroupableDraft> = {
  messageId: string;
  /** What the operator asked for in the turn that made these images. */
  request: string | null;
  drafts: D[];
};

const REQUEST_LABEL_MAX = 110;

function requestBefore<D extends GroupableDraft>(
  entries: GroupableMessage<D>[],
  index: number,
): string | null {
  for (let i = index; i >= 0; i -= 1) {
    const e = entries[i]!;
    if (e.role !== "user") continue;
    const text = e.content.replace(/\s+/g, " ").trim();
    if (!text) return null;
    return text.length > REQUEST_LABEL_MAX ? `${text.slice(0, REQUEST_LABEL_MAX - 1)}…` : text;
  }
  return null;
}

/** The reply that closes the turn starting at `from`: the last assistant message before the next user message. */
function replyIndex<D extends GroupableDraft>(entries: GroupableMessage<D>[], from: number): number {
  let reply = from;
  for (let i = from; i < entries.length; i += 1) {
    const e = entries[i]!;
    if (i > from && e.role === "user") break;
    if (e.role === "assistant") reply = i;
  }
  return reply;
}

export function groupCreativesByMessage<D extends GroupableDraft>(
  entries: GroupableMessage<D>[],
  live: D[],
): Map<string, CreativeGroup<D>> {
  const merged = new Map<string, D>();
  const firstSeen = new Map<string, number>();
  entries.forEach((entry, index) => {
    if (entry.role !== "assistant") return;
    for (const draft of entry.drafts ?? []) {
      if (!firstSeen.has(draft.id)) firstSeen.set(draft.id, index);
      merged.set(draft.id, { ...merged.get(draft.id), ...draft });
    }
  });
  // Snapshots freeze when their message is written; the live poll reflects images finishing.
  for (const draft of live) merged.set(draft.id, { ...merged.get(draft.id), ...draft });

  let lastAssistant = -1;
  entries.forEach((e, i) => {
    if (e.role === "assistant") lastAssistant = i;
  });

  const groups = new Map<string, CreativeGroup<D>>();
  for (const [id, draft] of merged) {
    const seen = firstSeen.get(id);
    // A batch started from a button has no message of its own yet: the newest reply carries it.
    const target = seen === undefined ? lastAssistant : replyIndex(entries, seen);
    if (target < 0) continue;
    const entry = entries[target]!;
    const group =
      groups.get(entry.id) ??
      ({ messageId: entry.id, request: requestBefore(entries, target), drafts: [] } as CreativeGroup<D>);
    group.drafts.push(draft);
    groups.set(entry.id, group);
  }
  return groups;
}
