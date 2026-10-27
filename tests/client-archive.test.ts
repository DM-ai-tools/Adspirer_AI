import { describe, expect, it } from "vitest";
import { getDemoStore } from "@/lib/demo/store";
import {
  activeOnly,
  archivedOnly,
  getArchivedClientIds,
  isArchived,
  setClientArchived,
} from "@/lib/clients/archive";

describe("archive filters", () => {
  const rows = [
    { id: "a", archived_at: null },
    { id: "b" },
    { id: "c", archived_at: "2026-10-27T00:00:00Z" },
  ];

  it("treats a missing or null archived_at as active, so it works before the migration", () => {
    expect(isArchived({})).toBe(false);
    expect(isArchived({ archived_at: null })).toBe(false);
    expect(isArchived({ archived_at: "2026-10-27T00:00:00Z" })).toBe(true);
  });

  it("splits a roster into active and archived", () => {
    expect(activeOnly(rows).map((r) => r.id)).toEqual(["a", "b"]);
    expect(archivedOnly(rows).map((r) => r.id)).toEqual(["c"]);
  });
});

describe("setClientArchived (demo store)", () => {
  it("archives a client, hides it from the active set, and restores it", async () => {
    const id = getDemoStore().clients[0]!.id;

    const archived = await setClientArchived(id, true);
    expect(archived.archived_at).toBeTruthy();
    expect((await getArchivedClientIds()).has(id)).toBe(true);

    const restored = await setClientArchived(id, false);
    expect(restored.archived_at).toBeNull();
    expect((await getArchivedClientIds()).has(id)).toBe(false);
  });

  it("keeps the client's data: archiving never removes anything", async () => {
    const store = getDemoStore();
    const id = store.clients[0]!.id;
    const before = { clients: store.clients.length, tasks: store.tasks.length };
    await setClientArchived(id, true);
    expect(store.clients.length).toBe(before.clients);
    expect(store.tasks.length).toBe(before.tasks);
  });

  it("rejects an unknown client", async () => {
    await expect(setClientArchived("does-not-exist", true)).rejects.toThrow(/not found/i);
  });
});
