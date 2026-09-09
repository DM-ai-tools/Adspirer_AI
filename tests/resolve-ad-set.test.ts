import { describe, expect, it } from "vitest";
import { matchEntityByName } from "@/lib/meta/resolve-ad-set";

describe("matchEntityByName", () => {
  const items = [
    { id: "1", name: "TR AUDIT FINAL (Echelonn)" },
    { id: "2", name: "TR AUDIT FINAL (Echelonn) - Ad Set" },
  ];

  it("matches exact names", () => {
    expect(matchEntityByName(items, "TR AUDIT FINAL (Echelonn)")?.id).toBe("1");
  });

  it("matches partial names", () => {
    expect(matchEntityByName(items, "Echelonn")?.id).toBe("1");
  });
});
