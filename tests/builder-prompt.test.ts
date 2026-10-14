import { describe, expect, it } from "vitest";
import { buildStaticSystemPromptV2 } from "@/lib/agent/prompts-v2";

const prompt = buildStaticSystemPromptV2();

describe("campaign builder prompt matches what the code does", () => {
  it("never tells the model Meta defaults to the US or that budgets are in USD", () => {
    expect(prompt).not.toMatch(/defaults to the \*\*United States\*\*/);
    expect(prompt).not.toMatch(/Daily budget \(USD\)/);
  });

  it("says a location is required", () => {
    expect(prompt).toMatch(/Locations are required/);
  });

  it("states the Advantage+ audience default and what turns it off", () => {
    expect(prompt).toMatch(/Advantage\+ audience is on by default/);
  });

  it("requires a pixel for Sales and a pixel or instant form for Leads", () => {
    expect(prompt).toMatch(/OUTCOME_LEADS needs a pixel .*or an instant form/);
  });

  it("lists every objective and says carousel isn't supported", () => {
    expect(prompt).toMatch(/OUTCOME_TRAFFIC \| OUTCOME_LEADS \| OUTCOME_SALES \| OUTCOME_ENGAGEMENT \| OUTCOME_AWARENESS/);
    expect(prompt).toMatch(/Carousel ads aren't supported yet/);
  });
});
