/**
 * A "directed" creative: the operator wrote the picture instruction and the exact words to print, and
 * the image follows them literally. It is an ordinary creative draft that carries one marker line in
 * its art direction, `DIRECTED: <base64url JSON>`, holding what was asked for. Pure and free of server
 * imports so the chat cards can use it too.
 */

export type PrintLine = { role: string | null; text: string };

export type Direction = { picture: string; print: PrintLine[]; noLogo?: boolean };

export type DirectedMeta = Direction & {
  /** A variation's one layout change. */
  tweak?: string;
  /** Storage keys of earlier images, oldest first, so an edit can be undone. */
  versions?: string[];
  /** The printed lines as they were before each kept version, oldest first (parallel to `versions`). */
  printBefore?: PrintLine[][];
};

const MARKER = /^DIRECTED: (\S+)$/m;

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** The direction with its directed marker set to `meta`; any other marker line stays, an older directed marker is replaced. */
export function withDirectedMarker(direction: string | null | undefined, meta: DirectedMeta): string {
  const kept = (direction ?? "")
    .split("\n")
    .filter((line) => !/^DIRECTED: \S+$/.test(line.trim()))
    .join("\n")
    .trim();
  return [kept, `DIRECTED: ${toBase64Url(JSON.stringify(meta))}`].filter(Boolean).join("\n");
}

export function readDirectedMarker(direction: string | null | undefined): DirectedMeta | null {
  const raw = direction?.match(MARKER)?.[1];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(fromBase64Url(raw)) as Partial<DirectedMeta>;
    if (typeof parsed.picture !== "string" || !Array.isArray(parsed.print)) return null;
    return parsed as DirectedMeta;
  } catch {
    return null;
  }
}

export function isDirectedDirection(direction: string | null | undefined): boolean {
  return readDirectedMarker(direction) !== null;
}

/** The ad's headline and primary text from the printed lines, for publishing. Pasted copy, when given, is the primary text. */
export function copyFromPrint(print: PrintLine[], pastedCopy?: string | null): { headline: string; primary_text: string } {
  const lines = print.filter((l) => l.text.trim());
  const headlineAt = lines.findIndex((l) => /headline/i.test(l.role ?? ""));
  const at = headlineAt >= 0 ? headlineAt : 0;
  const headline = lines[at]?.text.trim() ?? "";
  const rest = lines.filter((_, i) => i !== at).map((l) => l.text.trim());
  const pasted = pastedCopy?.trim();
  return { headline, primary_text: pasted || rest.join("\n") };
}
