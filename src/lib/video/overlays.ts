/**
 * What will be drawn on top of the video and when, read straight from the script, so the operator
 * can see exactly where each highlight, stat and uploaded image lands. Pure: the editor shows it
 * and the later compositing step uses the same list.
 */

export type OverlayScene = {
  number: number;
  start: number;
  end: number;
  line: string;
  keywords: string[];
  stat: string | null;
  assetId: string | null;
};

export type OverlayEvent = {
  kind: "keyword" | "stat" | "image";
  start: number;
  end: number;
  scene: number;
  text: string;
  /** For a stat or image, the uploaded image it comes from. */
  assetId: string | null;
};

/** m:ss for a number of seconds. */
export function mmss(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Scenes with their start and end recomputed from the lengths, for a script being edited. */
export function withTimes<T extends { seconds: number }>(scenes: T[]): Array<T & { start: number; end: number }> {
  let cursor = 0;
  return scenes.map((s) => {
    const seconds = Number(s.seconds) || 0;
    const out = { ...s, start: cursor, end: cursor + seconds };
    cursor += seconds;
    return out;
  });
}

export function overlayEvents(scenes: OverlayScene[]): OverlayEvent[] {
  const events: OverlayEvent[] = [];
  for (const s of scenes) {
    for (const k of s.keywords) events.push({ kind: "keyword", start: s.start, end: s.end, scene: s.number, text: k, assetId: null });
    if (s.stat) events.push({ kind: "stat", start: s.start, end: s.end, scene: s.number, text: s.stat, assetId: s.assetId });
    else if (s.assetId) events.push({ kind: "image", start: s.start, end: s.end, scene: s.number, text: "", assetId: s.assetId });
  }
  return events.sort((a, b) => a.start - b.start || (a.kind === "stat" ? -1 : 1));
}

/** One readable line per event: "0:12-0:20 · Scene 3 · Big stat “$120M+” with your image “Results”". */
export function describeEvent(e: OverlayEvent, assetName: (id: string) => string | undefined): string {
  const when = `${mmss(e.start)}-${mmss(e.end)} · Scene ${e.scene}`;
  const from = e.assetId ? assetName(e.assetId) : undefined;
  if (e.kind === "keyword") return `${when} · Word highlighted: “${e.text}”`;
  if (e.kind === "stat") return `${when} · Big stat on screen: “${e.text}”${from ? `, shown with your image “${from}”` : ""}`;
  return `${when} · Your image “${from ?? e.assetId}” shown on screen`;
}
