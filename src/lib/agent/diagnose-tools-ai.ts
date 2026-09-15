/**
 * Bridge diagnose-class registry tools into AI SDK tool() defs so the writer
 * LLM can choose which Meta / landing fetches to run (no fixed sequence).
 */
import "@/lib/tools/diagnose";
import { tool } from "ai";
import type { ToolSet } from "ai";
import { classify } from "@/lib/tools/policy";
import { getTool, invokeTool, type ToolContext } from "@/lib/tools/registry";

/** Diagnose tools the audit writer may call. Execute tools stay Approvals-only. */
const AUDIT_DIAGNOSE_ALLOWLIST = [
  "get_account_overview",
  "list_campaigns",
  "list_adsets",
  "list_ads",
  "get_campaign_insights",
  "get_account_insights",
  "get_meta_ad_creatives",
  "analyze_landing_pages",
  "analyze_account",
  "analyze_brand_url",
] as const;

export function buildAuditDiagnoseToolSet(ctx: ToolContext): ToolSet {
  const tools: ToolSet = {};

  for (const name of AUDIT_DIAGNOSE_ALLOWLIST) {
    if (classify(name) !== "diagnose") continue;
    const registered = getTool(name);
    if (!registered) continue;

    tools[name] = tool({
      description: registered.description,
      inputSchema: registered.inputSchema,
      execute: async (args: unknown) => {
        try {
          const result = await invokeTool(name, args, ctx);
          return result ?? { ok: true };
        } catch (error) {
          return {
            error: true,
            tool: name,
            message: error instanceof Error ? error.message : String(error),
          };
        }
      },
    });
  }

  return tools;
}

export function auditDiagnoseToolNames(): string[] {
  return [...AUDIT_DIAGNOSE_ALLOWLIST];
}
