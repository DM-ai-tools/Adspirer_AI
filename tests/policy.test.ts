import { describe, expect, it } from "vitest";
import { classify } from "@/lib/tools/policy";

describe("tool policy gate", () => {
  it("classifies diagnose tools as diagnose", () => {
    expect(classify("list_campaigns")).toBe("diagnose");
    expect(classify("get_campaign_insights")).toBe("diagnose");
    expect(classify("analyze_account")).toBe("diagnose");
  });

  it("classifies execute tools as execute", () => {
    expect(classify("update_adset_budget")).toBe("execute");
    expect(classify("pause_campaign")).toBe("execute");
    expect(classify("create_campaign")).toBe("execute");
  });

  it("blocks unknown tools (fail closed)", () => {
    expect(classify("delete_all_campaigns")).toBe("blocked");
    expect(classify("unknown_tool_xyz")).toBe("blocked");
  });
});
