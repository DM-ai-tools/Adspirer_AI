import { describe, expect, it } from "vitest";
import { isNavActive } from "@/lib/nav";
import { safeInternalPath } from "@/lib/utils";

describe("workspace nav highlighting", () => {
  it("does not mark Workspace as active on Workspace V2", () => {
    expect(isNavActive("/workspace-v2", "/workspace")).toBe(false);
    expect(isNavActive("/workspace-v2", "/workspace-v2")).toBe(true);
    expect(isNavActive("/workspace", "/workspace")).toBe(true);
    expect(isNavActive("/workspace", "/workspace-v2")).toBe(false);
  });
});

describe("safeInternalPath", () => {
  it("rejects open redirects and keeps in-app paths", () => {
    expect(safeInternalPath("/dashboard")).toBe("/dashboard");
    expect(safeInternalPath("/workspace-v2?clientId=1")).toBe(
      "/workspace-v2?clientId=1",
    );
    expect(safeInternalPath("//evil.example")).toBe("/dashboard");
    expect(safeInternalPath("https://evil.example")).toBe("/dashboard");
    expect(safeInternalPath(null)).toBe("/dashboard");
  });
});
