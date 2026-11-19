import { MAX_DIRECTIONS, type Direction, type PrintLine } from "@/lib/creatives/directed/markers";

/**
 * The list the operator checks and edits after a directions file is read, before anything renders.
 * Pure and client-safe: the bulk page uses these to edit rows and decide whether it can confirm.
 */
export type ConfirmItem = Direction & { unsure: boolean; note: string | null };

/** Role labels the words box understands when typed at the start of a line ("Headline: Open it"). */
const ROLE_WORDS = "headline|sub-?headline|sub-?line|button|cta|tagline|body|footer|label";
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The words box text for the printed lines: "Role: words" when a line has a role, else the words alone. */
export function printToText(print: PrintLine[]): string {
  return print.map((l) => (l.role ? `${l.role}: ${l.text}` : l.text)).join("\n");
}

/**
 * The printed lines from the words box text. Blank lines are ignored; the words themselves are never changed.
 * `knownRoles` are the labels the item already uses (the parser may have chosen any: "Title", "Main headline"), so
 * a line that starts with one of them keeps its role and the label is never turned into printed words.
 */
export function textToPrint(text: string, knownRoles: string[] = []): PrintLine[] {
  const labels = [ROLE_WORDS, ...knownRoles.filter((r) => r.trim()).map((r) => escapeRegExp(r.trim()))].join("|");
  const roleLine = new RegExp(`^(${labels})\\s*:\\s*(\\S.*)$`, "i");
  const out: PrintLine[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(roleLine);
    out.push(m ? { role: m[1]!, text: m[2]!.trim() } : { role: null, text: line });
  }
  return out;
}

const squash = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean).join("\n");

/** True only when the words box text differs from the printed lines (blank lines and trailing spaces do not count). */
export function printChanged(print: PrintLine[], text: string): boolean {
  return squash(text) !== squash(printToText(print));
}

/** One item changed; an edit by the operator settles the parser's doubt about it. */
export function updateItem(items: ConfirmItem[], index: number, patch: Partial<Pick<ConfirmItem, "picture" | "print" | "noLogo">>): ConfirmItem[] {
  return items.map((item, i) => (i === index ? { ...item, ...patch, unsure: false, note: null } : item));
}

export function removeItem(items: ConfirmItem[], index: number): ConfirmItem[] {
  return items.filter((_, i) => i !== index);
}

export function addItem(items: ConfirmItem[]): ConfirmItem[] {
  return [...items, { picture: "", print: [], unsure: false, note: null }];
}

/** Items the parser was unsure about do not block; an image with no picture instruction cannot be drawn, so it does. */
export function readyToConfirm(items: ConfirmItem[]): { ok: boolean; reason: string | null } {
  if (!items.length) return { ok: false, reason: "Add at least one direction." };
  if (items.length > MAX_DIRECTIONS) {
    const over = items.length - MAX_DIRECTIONS;
    return { ok: false, reason: `A run takes at most ${MAX_DIRECTIONS} directions. Remove ${over} or split the file.` };
  }
  const missing = items.findIndex((i) => !i.picture.trim());
  if (missing >= 0) return { ok: false, reason: `Image ${missing + 1} has no picture instruction yet.` };
  return { ok: true, reason: null };
}

/** The directions as the start-run request wants them: in order, nothing else. */
export function toRequestDirections(items: ConfirmItem[]): Direction[] {
  return items.map((i) => ({ picture: i.picture.trim(), print: i.print, ...(i.noLogo ? { noLogo: true } : {}) }));
}
