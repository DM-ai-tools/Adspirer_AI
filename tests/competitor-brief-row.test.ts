import { describe, expect, it } from "vitest";
import { competitorBriefFromRow, competitorBriefToRow } from "@/lib/competitors/brief-row";
import type { CompetitorBrief } from "@/types";

const SERVICE_ID = "6f1c2b9e-0d4a-4c5e-9b8a-2f3e4d5c6b7a";

const brief: CompetitorBrief = {
  id: "brief_abc123",
  client_id: "c1",
  client_service_id: SERVICE_ID,
  status: "ready",
  summary: "Competitors lead with financing.",
  strengths: ["Fast booking"],
  weaknesses: ["Thin proof"],
  messaging_themes: ["financing"],
  creative_patterns: ["UGC video"],
  opportunities: ["Lead with same-week appointments"],
  raw_research: { provider: "sociavault" },
  generated_at: "2026-10-19T10:00:00.000Z",
  created_at: "2026-10-19T10:00:00.000Z",
  updated_at: "2026-10-19T10:00:00.000Z",
};

describe("competitorBriefToRow", () => {
  it("writes the competitor_briefs column names and lets the database assign the id", () => {
    const row = competitorBriefToRow(brief);
    expect(row).toEqual({
      client_id: "c1",
      service_id: SERVICE_ID,
      status: "ready",
      summary: "Competitors lead with financing.",
      strengths: ["Fast booking"],
      weaknesses: ["Thin proof"],
      messaging_themes: ["financing"],
      creative_patterns: ["UGC video"],
      opportunities: ["Lead with same-week appointments"],
      source_metadata: { provider: "sociavault" },
      researched_at: "2026-10-19T10:00:00.000Z",
      created_at: "2026-10-19T10:00:00.000Z",
      updated_at: "2026-10-19T10:00:00.000Z",
    });
    expect(row).not.toHaveProperty("id");
    expect(row).not.toHaveProperty("client_service_id");
    expect(row).not.toHaveProperty("raw_research");
    expect(row).not.toHaveProperty("generated_at");
  });

  it("stores no service id when the brief has none or it is not a uuid", () => {
    expect(competitorBriefToRow({ ...brief, client_service_id: "" }).service_id).toBeNull();
    expect(competitorBriefToRow({ ...brief, client_service_id: null }).service_id).toBeNull();
    expect(competitorBriefToRow({ ...brief, client_service_id: "svc_demo" }).service_id).toBeNull();
  });
});

describe("competitorBriefFromRow", () => {
  it("reads a competitor_briefs row back into the app's brief shape", () => {
    const row = {
      id: "0b7c1d2e-3f4a-4b5c-8d9e-0a1b2c3d4e5f",
      client_id: "c1",
      service_id: SERVICE_ID,
      status: "ready",
      summary: "Competitors lead with financing.",
      patterns: null,
      differentiators: null,
      market_gaps: null,
      recommendations: null,
      strengths: ["Fast booking"],
      weaknesses: null,
      messaging_themes: ["financing"],
      creative_patterns: null,
      opportunities: ["Lead with same-week appointments"],
      source_metadata: { provider: "sociavault" },
      researched_at: "2026-10-19T10:00:00.000Z",
      created_at: "2026-10-19T10:00:00.000Z",
      updated_at: "2026-10-19T10:00:00.000Z",
    };
    expect(competitorBriefFromRow(row)).toEqual({
      id: "0b7c1d2e-3f4a-4b5c-8d9e-0a1b2c3d4e5f",
      client_id: "c1",
      client_service_id: SERVICE_ID,
      status: "ready",
      summary: "Competitors lead with financing.",
      strengths: ["Fast booking"],
      weaknesses: null,
      messaging_themes: ["financing"],
      creative_patterns: null,
      opportunities: ["Lead with same-week appointments"],
      raw_research: { provider: "sociavault" },
      generated_at: "2026-10-19T10:00:00.000Z",
      created_at: "2026-10-19T10:00:00.000Z",
      updated_at: "2026-10-19T10:00:00.000Z",
    });
  });

  it("round-trips a brief through a row", () => {
    const back = competitorBriefFromRow({ id: "x", ...competitorBriefToRow(brief) });
    expect(back).toEqual({ ...brief, id: "x" });
  });
});
