import { z } from "zod";
import { ownerForCheckpoint, ownerLabel } from "@/lib/agent/optimization-capabilities";
import { evaluateCheckpoints } from "@/lib/audit/checkpoints";
import { scopeAuditSnapshot } from "@/lib/audit/meta-audit-data";
import { resolveGoals } from "@/lib/clients/goals";
import { registerTool } from "@/lib/tools/registry";

/**
 * The account's tracking, structure, bidding, audience, creative and funnel checks
 * for a period, each failing or warning check tagged with who has to fix it.
 * Read-only; the account comes from the client's mapping, never from the model.
 */

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Failing and warning checks returned, most severe and most expensive first. */
const MAX_PRIORITIES = 15;

export const metaAccountHealthTool = registerTool({
  name: "meta_account_health",
  description: [
    "The client's Meta account health checks for a period: tracking (pixel, Conversions API, event de-duplication), structure, bidding and learning, audiences, creative and funnel.",
    "Returns the failing and warning checks with the evidence, the fix, and who has to do it (this app, someone in Ads Manager, a developer, the landing page owner, the client).",
    "Use it when the operator asks about tracking, learning, audiences or what is wrong with the account. Pass since + until (YYYY-MM-DD) for the period asked about (or days), and campaign_ids to stay on named campaigns.",
  ].join(" "),
  inputSchema: z.object({
    since: z.string().regex(ISO_DAY, "Use YYYY-MM-DD").optional(),
    until: z.string().regex(ISO_DAY, "Use YYYY-MM-DD").optional(),
    days: z.number().int().min(1).max(90).optional(),
    campaign_ids: z.array(z.string().min(1)).max(50).optional(),
  }),
  async execute(args, ctx) {
    try {
      const { resolvePrimaryAccountId } = await import("@/lib/adspirer/resolve-meta-account");
      const accountId = await resolvePrimaryAccountId(ctx.clientId);
      if (!accountId) {
        return {
          error: true,
          source: "Meta",
          not_mapped: true,
          message: "No Meta ad account is mapped to this client. Map one under Admin → Connections, then ask again.",
        };
      }
      const { resolveProvider } = await import("@/lib/adspirer/client");
      const provider = await resolveProvider();
      if (!provider.getAuditSnapshot) {
        return { error: true, source: "Meta", message: "This Meta connection can't read the account health checks." };
      }
      const range =
        args.since && args.until
          ? { since: args.since, until: args.until }
          : { days: args.days ?? 14 };
      const full = await provider.getAuditSnapshot(accountId, { ...range, compare: false });
      const snapshot = args.campaign_ids?.length ? scopeAuditSnapshot(full, args.campaign_ids) : full;

      const { getClient } = await import("@/lib/approvals/service");
      const client = await getClient(ctx.clientId).catch(() => null);
      const scorecard = evaluateCheckpoints(snapshot, { goals: resolveGoals({ goals_profile: client?.goals_profile ?? {} }) });

      return {
        source: "Meta",
        account_id: accountId,
        period: snapshot.period,
        scope: snapshot.scope ? snapshot.scope.campaigns : null,
        score: scorecard.score,
        grade: scorecard.grade,
        grade_status: scorecard.gradeStatus,
        coverage: scorecard.coverage,
        counts: scorecard.counts,
        priorities: scorecard.priorities.slice(0, MAX_PRIORITIES).map((c) => {
          const { owner } = ownerForCheckpoint(c.id);
          return {
            id: c.id,
            category: c.category,
            title: c.title,
            status: c.status,
            severity: c.severity,
            evidence: c.evidence,
            fix: c.fix ?? null,
            impact: c.impact ?? null,
            owner,
            owner_label: ownerLabel(owner),
          };
        }),
        ...(snapshot.warnings.length ? { warnings: snapshot.warnings } : {}),
      };
    } catch (error) {
      return { error: true, source: "Meta", message: error instanceof Error ? error.message : String(error) };
    }
  },
});
