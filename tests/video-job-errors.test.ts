import { describe, expect, it, vi } from "vitest";

// A background job whose first read of the project fails must not leave the project on "Working on it".
const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
vi.mock("@/lib/video/projects", async (orig) => ({
  ...(await orig<typeof import("@/lib/video/projects")>()),
  getProject: async () => {
    throw new Error("database unavailable");
  },
  updateProject: async (id: string, patch: Record<string, unknown>) => {
    updates.push({ id, patch });
    return { id, ...patch };
  },
  setProgress: async () => undefined,
}));

describe("a job that cannot read its project", () => {
  it.each([
    ["writing a concept's script", async (m: typeof import("@/lib/video/brief")) => m.writeConceptScript("p1", "c1"), "concepts_ready"],
    ["new concepts", async (m: typeof import("@/lib/video/brief")) => m.moreConcepts("p1", null), "concepts_ready"],
    ["changing a script's idea", async (m: typeof import("@/lib/video/brief")) => m.rewriteConceptScript("p1", "s1", "x"), "scripts_ready"],
  ])("%s ends with the reason instead of staying on 'working'", async (_name, run, status) => {
    updates.length = 0;
    const brief = await import("@/lib/video/brief");
    await run(brief);
    expect(updates.at(-1)?.patch.status).toBe(status);
    expect(String(updates.at(-1)?.patch.error)).toMatch(/database unavailable/);
  });
});
