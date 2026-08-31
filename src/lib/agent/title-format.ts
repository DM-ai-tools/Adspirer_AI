export const DEFAULT_CHAT_TITLE = "New chat";
export const DEFAULT_V2_CHAT_TITLE = "New chat (V2)";
export const V2_CHAT_TITLE_PREFIX = "V2 · ";

export function isDefaultConversationTitle(
  title: string | null | undefined,
): boolean {
  if (!title?.trim()) return true;
  const t = title.trim().toLowerCase();
  return (
    t === "new chat" ||
    t === "new chat (v2)" ||
    t === "v2 · new chat" ||
    t === "workspace session"
  );
}

export function isV2ChatTitle(title: string | null | undefined): boolean {
  const t = title?.trim().toLowerCase() ?? "";
  if (!t) return false;
  return (
    t.startsWith("v2 ·") ||
    t.startsWith("v2:") ||
    t.startsWith("[v2]") ||
    t.endsWith("(v2)")
  );
}

export function withV2ChatTitle(title: string | null | undefined): string {
  const trimmed = title?.trim() ?? "";
  if (!trimmed || isDefaultConversationTitle(trimmed)) {
    return DEFAULT_V2_CHAT_TITLE;
  }
  if (isV2ChatTitle(trimmed)) return trimmed;
  return `${V2_CHAT_TITLE_PREFIX}${trimmed}`;
}

/** History label without the V2 prefix/suffix, for use next to a V2 badge. */
export function displayChatTitle(title: string | null | undefined): string {
  const trimmed = title?.trim() ?? "";
  if (!trimmed || isDefaultConversationTitle(trimmed)) {
    return DEFAULT_CHAT_TITLE;
  }
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("v2 · ")) return trimmed.slice(V2_CHAT_TITLE_PREFIX.length);
  if (lower.startsWith("v2:")) return trimmed.slice(3).trim();
  if (lower.startsWith("[v2]")) return trimmed.slice(4).trim();
  if (lower.endsWith("(v2)")) return trimmed.slice(0, -4).trim();
  return trimmed;
}
