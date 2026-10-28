import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  FOCUS_AREAS,
  capabilityPromptBlock,
  focusesOfTool,
  ownerForCheckpoint,
  ownerLabel,
} from "@/lib/agent/optimization-capabilities";
import { classify, listClassifiedTools } from "@/lib/tools/policy";

describe("capability map", () => {
  it("every app capability that names a tool names an execute tool in the policy", () => {
    for (const cap of CAPABILITIES) {
      if (cap.owner === "app" && cap.tool) {
        expect(classify(cap.tool), `${cap.id} -> ${cap.tool}`).toBe("execute");
      }
    }
  });

  it("only app capabilities name a tool", () => {
    for (const cap of CAPABILITIES) {
      if (cap.owner !== "app") expect(cap.tool, cap.id).toBeUndefined();
    }
  });

  it("every execute tool in the policy has a capability", () => {
    const covered = new Set(CAPABILITIES.map((c) => c.tool).filter(Boolean));
    for (const { name, safety } of listClassifiedTools()) {
      if (safety === "execute") expect(covered.has(name), `no capability for ${name}`).toBe(true);
    }
  });

  it("every execute tool has a focus mapping", () => {
    for (const { name, safety } of listClassifiedTools()) {
      if (safety === "execute") expect(focusesOfTool(name).length, name).toBeGreaterThan(0);
    }
  });

  it("capability ids are unique and focuses are known", () => {
    const ids = CAPABILITIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const cap of CAPABILITIES) expect(FOCUS_AREAS).toContain(cap.focus);
  });
});

describe("checkpoint owners", () => {
  const source = readFileSync(join(process.cwd(), "src/lib/audit/checkpoints.ts"), "utf8");
  const ids = [...new Set([...source.matchAll(/\bid: "([TSBACF]\d+)"/g)].map((m) => m[1]))];

  it("finds the checkpoint ids in the source", () => {
    expect(ids.length).toBeGreaterThanOrEqual(39);
  });

  it("every checkpoint id maps to an owner and an existing capability", () => {
    const known = new Set(CAPABILITIES.map((c) => c.id));
    for (const id of ids) {
      const found = ownerForCheckpoint(id);
      expect(known.has(found.capabilityId), `${id} -> ${found.capabilityId}`).toBe(true);
      expect(found.owner).toBe(CAPABILITIES.find((c) => c.id === found.capabilityId)!.owner);
    }
  });

  it("tracking failures are for a developer, landing-page clicks for the landing page owner", () => {
    expect(ownerForCheckpoint("T1").owner).toBe("developer");
    expect(ownerForCheckpoint("T4").owner).toBe("developer");
    expect(ownerForCheckpoint("F5").owner).toBe("landing_page");
    expect(ownerForCheckpoint("B1").owner).toBe("app");
  });

  it("throws for an unknown id rather than guessing an owner", () => {
    expect(() => ownerForCheckpoint("Z99")).toThrow(/Z99/);
  });
});

describe("focusesOfTool", () => {
  it("maps tools to the areas they serve", () => {
    expect(focusesOfTool("update_adset_budget")).toEqual(["budget"]);
    expect(focusesOfTool("update_campaign_budget")).toEqual(["budget"]);
    expect(focusesOfTool("pause_adset")).toEqual(["budget"]);
    expect(focusesOfTool("pause_ad")).toEqual(["creative"]);
    expect(focusesOfTool("create_ad")).toEqual(["creative", "structure"]);
    expect(focusesOfTool("create_adset")).toEqual(["structure"]);
    expect(focusesOfTool("resume_campaign")).toEqual(["reactivation"]);
    expect(focusesOfTool("resume_adset")).toEqual(["reactivation"]);
    expect(focusesOfTool("unknown_tool")).toEqual([]);
  });
});

describe("ownerLabel and the prompt block", () => {
  it("has operator wording for every owner", () => {
    expect(ownerLabel("app")).toBe("this app");
    expect(ownerLabel("ads_manager")).toBe("someone in Ads Manager");
    expect(ownerLabel("developer")).toBe("a developer");
    expect(ownerLabel("landing_page")).toBe("the landing page owner");
    expect(ownerLabel("client")).toBe("the client");
  });

  it("states what the app can queue and what needs someone else", () => {
    const block = capabilityPromptBlock();
    expect(block).toContain("update_adset_budget");
    expect(block).toMatch(/developer/i);
    expect(block).toMatch(/landing page/i);
    expect(block).not.toMatch(/adspirer/i);
  });
});
