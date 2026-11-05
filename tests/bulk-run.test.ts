import { describe, expect, it } from "vitest";
import { BULK_ANGLES, pickBulkAngles } from "@/lib/creatives/bulk/angles";
import { directionForHook, matchHooksToAngles, type BulkBody } from "@/lib/creatives/bulk/plan";
import { pendingDrafts, runPool } from "@/lib/creatives/bulk/run";
import { claimLease, createRun, getRun, releaseLease } from "@/lib/creatives/bulk/runs";
import { readRunMarker, stripAspectMarker, withAspectMarker, withRunMarker, readAspectMarker } from "@/lib/creatives/formats";

describe("pickBulkAngles", () => {
  it("never repeats an angle and has room for several runs", () => {
    expect(BULK_ANGLES.length).toBeGreaterThanOrEqual(24);
    for (let i = 0; i < 100; i += 1) {
      const picked = pickBulkAngles(15);
      expect(new Set(picked.map((a) => a.key)).size).toBe(15);
    }
  });
  it("spreads a run across all five awareness stages, evenly", () => {
    const picked = pickBulkAngles(15);
    const counts = new Map<string, number>();
    for (const a of picked) counts.set(a.stage, (counts.get(a.stage) ?? 0) + 1);
    expect(counts.size).toBe(5);
    for (const n of counts.values()) expect(n).toBeGreaterThanOrEqual(2);
  });
  it("holds back angles an earlier run used while fresh ones remain", () => {
    const used = pickBulkAngles(15).map((a) => a.key);
    const next = pickBulkAngles(9, { avoid: used });
    expect(next.every((a) => !used.includes(a.key))).toBe(true);
  });
});

const bodies: BulkBody[] = [
  { id: "A", format: "demonstration", text: "a" },
  { id: "B", format: "proof", text: "b" },
];
const raw = (key: string, body = "A") => ({
  angle_key: key,
  targets: "t",
  post_headline: "h",
  body_id: body,
  primary_text: "p",
  cta_index: 5,
  on_image_text: { headline: "H", highlights: [], cta_label: "Go" },
  style: "s",
  creative_direction: "d",
});

describe("matchHooksToAngles", () => {
  const assigned = BULK_ANGLES.slice(0, 3);
  it("keeps one hook per assigned angle in order, drops strangers and repeats, reports the missing", () => {
    const { hooks, missing } = matchHooksToAngles(assigned, [raw(assigned[2]!.key), raw("not_assigned"), raw(assigned[0]!.key), raw(assigned[0]!.key)], bodies, 2);
    expect(hooks.map((h) => h.angle.key)).toEqual([assigned[0]!.key, assigned[2]!.key]);
    expect(missing.map((a) => a.key)).toEqual([assigned[1]!.key]);
  });
  it("falls back to a real body and a real CTA when the model names ones that do not exist", () => {
    const { hooks } = matchHooksToAngles(assigned, [raw(assigned[0]!.key, "Z")], bodies, 2);
    expect(hooks[0]!.bodyId).toBe("A");
    expect(hooks[0]!.ctaIndex).toBe(1);
  });
  it("writes the angle and the printed words into the art direction", () => {
    const { hooks } = matchHooksToAngles(assigned, [raw(assigned[0]!.key)], bodies, 1);
    const direction = directionForHook(hooks[0]!);
    expect(direction).toContain(assigned[0]!.name);
    expect(direction).toMatch(/ON-IMAGE TEXT/);
  });
});

describe("runPool", () => {
  it("never runs more than the limit at once", async () => {
    let active = 0;
    let peak = 0;
    await runPool(Array.from({ length: 15 }, (_, i) => i), 4, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
    });
    expect(peak).toBe(4);
  });
  it("stops starting new work when told to, leaving the rest", async () => {
    const done: number[] = [];
    await runPool([1, 2, 3, 4, 5, 6], 2, async (n) => void done.push(n), () => done.length >= 2);
    expect(done.length).toBe(2);
  });
});

describe("pendingDrafts", () => {
  it("picks up waiting drafts and ones a dead worker left mid-render, not finished or failed ones", () => {
    const old = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const fresh = new Date().toISOString();
    const d = (image_status: string, updated_at: string) => ({ image_status, updated_at }) as never;
    const out = pendingDrafts([d("pending", fresh), d("generating", fresh), d("generating", old), d("succeeded", old), d("failed", old)]);
    expect(out).toHaveLength(2);
  });
});

describe("render lease", () => {
  it("lets one worker hold a run at a time", async () => {
    const run = await createRun({ clientId: "c1", inputs: {}, format: "4:5" });
    expect(await claimLease(run.id)).toBe(true);
    expect(await claimLease(run.id)).toBe(false);
    await releaseLease(run.id);
    expect((await getRun(run.id))?.lease_until).toBeNull();
    expect(await claimLease(run.id)).toBe(true);
  });
});

describe("run markers", () => {
  it("a run marker survives a size change and is hidden from the image model", () => {
    const marked = withRunMarker(withAspectMarker("STYLE: x.", "4:5"), "run_1");
    const resized = withAspectMarker(marked, "9:16");
    expect(readRunMarker(resized)).toBe("run_1");
    expect(readAspectMarker(resized)).toBe("9:16");
    expect(stripAspectMarker(resized)).toBe("STYLE: x.");
  });
});

import { BULK_STYLES, pickBulkStyles } from "@/lib/creatives/bulk/styles";

describe("pickBulkStyles", () => {
  it("gives every hook in a run a different style", () => {
    for (let i = 0; i < 100; i += 1) {
      const angles = pickBulkAngles(15);
      const styles = pickBulkStyles(angles);
      expect(new Set(styles.map((s) => s.key)).size).toBe(15);
    }
  });
  it("mixes families: photography, 3D, graphic, native, proof and comparison all appear", () => {
    const families = new Set(pickBulkStyles(pickBulkAngles(15)).map((s) => s.family));
    expect(families.size).toBe(6);
  });
  it("prefers a style that suits the angle's kind", () => {
    const proof = BULK_ANGLES.filter((a) => a.kind === "proof").slice(0, 1);
    const [style] = pickBulkStyles(proof);
    expect(style!.fits).toContain("proof");
  });
  it("has more styles than one run needs", () => {
    expect(BULK_STYLES.length).toBeGreaterThanOrEqual(20);
  });
});
