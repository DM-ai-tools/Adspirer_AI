import { describe, expect, it } from "vitest";
import type { ToolSet } from "ai";
import { withoutNamedTools } from "@/lib/agent/diagnose-tools-ai";

const tools = { generate_ad_images: {}, list_campaigns: {}, get_account_overview: {} } as unknown as ToolSet;

describe("switching off agent tools for a turn", () => {
  it("removes only the named tools, so a directed request cannot also start the agent's own 4-image batch", () => {
    expect(Object.keys(withoutNamedTools(tools, ["generate_ad_images"]))).toEqual(["list_campaigns", "get_account_overview"]);
  });
  it("returns the tools untouched when nothing is named, and copes with unknown names", () => {
    expect(withoutNamedTools(tools, undefined)).toBe(tools);
    expect(withoutNamedTools(tools, [])).toBe(tools);
    expect(Object.keys(withoutNamedTools(tools, ["nope"]))).toHaveLength(3);
  });
});
