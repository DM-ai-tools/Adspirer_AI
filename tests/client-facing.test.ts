import { describe, expect, it } from "vitest";
import { sanitizeClientFacingText } from "@/lib/client-facing";

describe("sanitizeClientFacingText", () => {
  it("strips Supabase and env-var mentions", () => {
    expect(
      sanitizeClientFacingText(
        "Open Supabase → SQL Editor and set DEMO_MODE=false",
      ),
    ).not.toMatch(/supabase|DEMO_MODE/i);
  });

  it("strips image / crawl vendor names", () => {
    const out = sanitizeClientFacingText(
      "Set OPENAI_API_KEY for GPT Image; Firecrawl branding ready",
    );
    expect(out).not.toMatch(/openai|gpt image|firecrawl/i);
  });
});
